import json
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from uuid import uuid4
from zoneinfo import ZoneInfo

from pydantic import ValidationError

from form_backend.api import API
from form_backend.calculations import scale, workout_summary
from form_backend.contracts import openapi
from form_backend.core import Principal, Problem, json_text, load_json
from form_backend.local_sessions import FakeIdentityProvider, MemorySessions, Sessions
from form_backend.migration import plan_export
from form_backend.models import Exercise, Food, Nutrients
from form_backend.repositories import (
    MemoryAccounts,
    MemoryCatalog,
    MemoryNutrition,
    MemoryTraining,
    MemoryUnitOfWork,
)
from form_backend.service import Service
from form_backend.sessions import SessionConfig

D = Decimal
A, B = Principal("user-A"), Principal("user-B")
FIXTURES = Path(__file__).parent / "fixtures"


class Clock:
    def __init__(self):
        self.now = datetime(2026, 10, 18, 12, tzinfo=timezone.utc)

    def __call__(self):
        return self.now

    def advance(self, **kwargs):
        self.now += timedelta(**kwargs)


class FoundationCase(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.uow = MemoryUnitOfWork(self.clock)
        self.training, self.nutrition, self.accounts = (
            MemoryTraining(self.uow),
            MemoryNutrition(self.uow),
            MemoryAccounts(self.uow),
        )
        self.catalog = MemoryCatalog(
            exercises=(Exercise(id="system-press", name="Mock press", primary_muscle="Chest"),),
            foods=(
                Food(
                    id="rice-dry",
                    name="Mock rice",
                    preparation="dry",
                    per100g=Nutrients(calories=360, protein=7, carbs=79, fat=D("0.7")),
                ),
            ),
            clock=self.clock,
        )
        self.service = Service(self.uow, self.training, self.nutrition, self.accounts, self.catalog)
        self.api = API(self.service, b"local-cursor-test-key-32-bytes-long")

    def call(self, method, path, body=None, *, p=A, rev=None, key=None, query=None):
        headers = {"Idempotency-Key": key or str(uuid4())}
        if rev is not None:
            headers["If-Match"] = f'"{rev}"'
        return self.api.handle(
            method, path, principal=p, body=json_text(body or {}), headers=headers, query=query
        )

    def data(self, response, expected=200):
        self.assertEqual(response.status, expected, response.to_json())
        return response.body["data"]

    def exercise(self, p=A, unilateral=False, name="Cable press"):
        body = {
            "id": str(uuid4()),
            "name": name,
            "unilateral": unilateral,
            "primaryMuscle": "Chest",
        }
        return self.data(self.call("POST", "/v1/workouts/exercises", body, p=p), 201)

    def food(self, p=A):
        body = {
            "id": str(uuid4()),
            "name": "Mock tofu",
            "preparation": "cooked",
            "per100g": {"calories": 200, "protein": 20, "carbs": 10, "fat": 8},
        }
        return self.data(self.call("POST", "/v1/nutrition/foods", body, p=p), 201)

    def session(self, exercise=None, p=A, started=None):
        ex = exercise or self.exercise(p=p)
        body = {
            "id": str(uuid4()),
            "name": "Upper A",
            "startedAt": started or self.clock(),
            "exercises": [
                {
                    "id": str(uuid4()),
                    "exerciseId": ex["id"],
                    "prescription": {"plannedSets": 1, "target": "8–12", "note": "Plan"},
                }
            ],
        }
        return self.data(self.call("POST", "/v1/workouts/sessions", body, p=p), 201)

    def recipe(self, food=None, p=A):
        food = food or self.food(p=p)
        body = {
            "id": str(uuid4()),
            "name": "Tofu bowl",
            "finishedGrams": 400,
            "ingredients": [
                {
                    "id": str(uuid4()),
                    "foodId": food["id"],
                    "foodRevision": food["revision"],
                    "grams": 200,
                }
            ],
        }
        return self.data(self.call("POST", "/v1/nutrition/recipes", body, p=p), 201)

    def portion(self, food=None, p=A, **extra):
        food = food or self.food(p=p)
        body = {
            "id": str(uuid4()),
            "date": "2026-10-18",
            "meal": "Lunch",
            "grams": D("125.5"),
            "sourceType": "food",
            "sourceId": food["id"],
            "sourceRevision": food["revision"],
            **extra,
        }
        return self.data(self.call("POST", "/v1/nutrition/diary/entries", body, p=p), 201)

    def edit(self, session, side=None, **fields):
        entry = session["exercises"][0]
        row = next(r for r in entry["sets"] if side is None or r["side"] == side)
        body = {
            "edits": [
                {
                    "entryId": entry["id"],
                    "groupId": row["groupId"],
                    "setId": row["id"],
                    "side": row["side"],
                    **fields,
                }
            ]
        }
        return self.data(
            self.call(
                "PATCH",
                f"/v1/workouts/sessions/{session['id']}/sets",
                body,
                rev=session["revision"],
            )
        )

    def finish(self, session):
        return self.data(
            self.call(
                "POST", f"/v1/workouts/sessions/{session['id']}/complete", rev=session["revision"]
            )
        )


class DomainTests(FoundationCase):
    def test_exercise_metadata_archive_stable_id(self):
        ex = self.exercise()
        r = self.data(
            self.call(
                "PATCH",
                f"/v1/workouts/exercises/{ex['id']}",
                {"name": "Renamed", "tags": ["slow", "cable"], "equipment": "Cable"},
                rev=1,
            )
        )
        self.assertEqual(r["id"], ex["id"])
        self.assertEqual(r["tags"], ("slow", "cable"))
        archived = self.data(self.call("POST", f"/v1/workouts/exercises/{ex['id']}/archive", rev=2))
        self.assertTrue(archived["archived"])
        restored = self.data(self.call("POST", f"/v1/workouts/exercises/{ex['id']}/restore", rev=3))
        self.assertFalse(restored["archived"])

    def test_system_catalog_is_readable_but_not_writable_or_shadowable(self):
        self.data(self.call("GET", "/v1/workouts/exercises/system-press", p=B))
        for method, path, body in [
            ("PATCH", "/v1/workouts/exercises/system-press", {"name": "Overwrite"}),
            ("POST", "/v1/nutrition/foods/rice-dry/archive", {}),
        ]:
            self.assertEqual(self.call(method, path, body, p=B, rev=1).status, 403)
        self.assertFalse(hasattr(self.catalog, "put"))

    def test_template_reorder_does_not_change_session_snapshots(self):
        one, two = self.exercise(), self.exercise(name="Row")
        entries = [{"id": str(uuid4()), "exerciseId": ex["id"]} for ex in (one, two)]
        template = self.data(
            self.call(
                "POST",
                "/v1/workouts/templates",
                {"id": str(uuid4()), "name": "Plan", "exercises": entries},
            ),
            201,
        )
        session = self.data(
            self.call(
                "POST",
                "/v1/workouts/sessions",
                {
                    "id": str(uuid4()),
                    "name": "Today",
                    "templateId": template["id"],
                    "templateRevision": 1,
                    "startedAt": self.clock(),
                },
            ),
            201,
        )
        self.data(
            self.call(
                "PATCH",
                f"/v1/workouts/templates/{template['id']}",
                {"exercises": list(reversed(entries))},
                rev=1,
            )
        )
        after = self.data(self.call("GET", f"/v1/workouts/sessions/{session['id']}"))
        self.assertEqual(after, session)
        self.assertEqual(
            self.call(
                "POST",
                "/v1/workouts/sessions",
                {
                    "id": str(uuid4()),
                    "name": "Stale",
                    "templateId": template["id"],
                    "templateRevision": 1,
                    "startedAt": self.clock(),
                },
            ).status,
            409,
        )

    def test_partial_unilateral_is_preserved_and_counts_completed_side_volume(self):
        session = self.session(self.exercise(unilateral=True))
        session = self.edit(session, "L", reps=11, kg=D("22.5"), rpe=8, done=True)
        finished = self.finish(session)
        self.assertEqual(finished["summary"]["volumeKgReps"], D("247.5"))
        self.assertEqual(finished["summary"]["completedGroups"], 0)
        self.assertEqual(finished["summary"]["prescribedGroups"], 1)
        self.assertFalse(finished["summary"]["matchedPairs"])
        version = self.data(self.call("GET", f"/v1/workouts/sessions/{session['id']}/versions/1"))
        self.assertTrue(version["exercises"][0]["sets"][0]["done"])
        self.assertFalse(version["exercises"][0]["sets"][1]["done"])

    def test_same_weight_shortcut_copies_only_paired_load(self):
        session = self.session(self.exercise(unilateral=True))
        session = self.edit(
            session, "L", reps=11, kg=D("22.5"), rpe=8, done=True, applyWeightToPair=True
        )
        left, right = session["exercises"][0]["sets"]
        self.assertEqual(right["kg"], left["kg"])
        self.assertEqual(right["reps"], 8)
        self.assertIsNone(right["rpe"])
        self.assertFalse(right["done"])

    def test_toggling_same_weight_does_not_equalize_existing_sides(self):
        session = self.session(self.exercise(unilateral=True))
        session = self.edit(session, "L", kg=25)
        base = f"/v1/workouts/sessions/{session['id']}/exercises/{session['exercises'][0]['id']}"
        session = self.data(
            self.call("PATCH", base, {"sameWeight": False}, rev=session["revision"])
        )
        session = self.edit(session, "R", kg=20)
        session = self.data(self.call("PATCH", base, {"sameWeight": True}, rev=session["revision"]))
        self.assertEqual([r["kg"] for r in session["exercises"][0]["sets"]], [D(25), D(20)])

    def test_prefill_uses_corresponding_side_and_never_completes_new_sets(self):
        ex = self.exercise(unilateral=True)
        session = self.session(ex)
        session = self.edit(session, "L", reps=11, kg=D("22.5"), rpe=8, done=True)
        session = self.edit(session, "R", reps=9, kg=20, rpe=9, done=True)
        self.finish(session)
        new = self.session(ex)
        left, right = new["exercises"][0]["sets"]
        self.assertEqual((left["reps"], left["kg"], left["rpe"]), (11, D("22.5"), 8))
        self.assertEqual((right["reps"], right["kg"], right["rpe"]), (9, D(20), 9))
        self.assertFalse(left["done"] or right["done"])
        self.assertNotEqual(left["id"], session["exercises"][0]["sets"][0]["id"])

    def test_missing_completed_side_is_not_copied_from_partner(self):
        ex = self.exercise(unilateral=True)
        old = self.session(ex)
        self.finish(self.edit(old, "L", reps=12, kg=25, rpe=8, done=True))
        new = self.session(ex)
        right = new["exercises"][0]["sets"][1]
        self.assertEqual((right["reps"], right["kg"], right["rpe"]), (8, D(0), None))

    def test_whole_pair_add_remove_and_planned_target_is_independent(self):
        session = self.session(self.exercise(unilateral=True))
        entry = session["exercises"][0]
        base = f"/v1/workouts/sessions/{session['id']}/exercises/{entry['id']}/groups"
        group = str(uuid4())
        session = self.data(self.call("POST", base, {"id": group}, rev=1))
        self.assertEqual(len(session["exercises"][0]["sets"]), 4)
        session = self.data(self.call("DELETE", base + "/" + group, rev=2))
        self.assertEqual(len(session["exercises"][0]["sets"]), 2)
        self.assertEqual(session["exercises"][0]["prescription"]["target"], "8–12")
        self.assertEqual(session["exercises"][0]["prescription"]["plannedSets"], 1)

    def test_corrections_retain_old_version_and_latest_history_is_not_duplicated(self):
        ex = self.exercise()
        session = self.finish(self.edit(self.session(ex), reps=8, kg=60, done=True))
        path = f"/v1/workouts/sessions/{session['id']}"
        before = self.data(self.call("GET", path + "/versions/1"))
        self.assertEqual(
            self.call("PATCH", path + "/sets", {"edits": []}, rev=session["revision"]).status, 422
        )
        session = self.data(self.call("POST", path + "/reopen", rev=session["revision"]))
        session = self.finish(self.edit(session, reps=10))
        self.assertEqual(session["completedVersion"], 2)
        self.assertEqual(self.data(self.call("GET", path + "/versions/1")), before)
        history = self.call("GET", f"/v1/workouts/exercises/{ex['id']}/history")
        self.assertEqual(len(history.body["items"]), 1)
        self.assertEqual(history.body["items"][0]["id"], session["id"])
        self.assertEqual(history.body["items"][0]["completedVersion"], 2)

    def test_library_rename_and_mode_change_do_not_rewrite_completed_snapshot(self):
        ex = self.exercise(unilateral=True)
        old = self.finish(self.session(ex))
        self.data(
            self.call(
                "PATCH",
                f"/v1/workouts/exercises/{ex['id']}",
                {"name": "New bilateral", "unilateral": False},
                rev=1,
            )
        )
        history = self.data(self.call("GET", f"/v1/workouts/sessions/{old['id']}/versions/1"))
        self.assertTrue(history["exercises"][0]["snapshot"]["unilateral"])
        self.assertEqual(history["exercises"][0]["snapshot"]["name"], "Cable press")
        new = self.session({**ex, "revision": 2})
        self.assertEqual(new["exercises"][0]["sets"][0]["side"], "both")

    def test_food_edits_cannot_change_existing_diary_nutrients(self):
        food = self.food()
        entry = self.portion(food)
        self.data(
            self.call(
                "PATCH",
                f"/v1/nutrition/foods/{food['id']}",
                {
                    "name": "Renamed",
                    "per100g": {"calories": 999, "protein": 1, "carbs": 1, "fat": 1},
                },
                rev=1,
            )
        )
        read = self.data(self.call("GET", f"/v1/nutrition/diary/entries/{entry['id']}"))
        self.assertEqual(read, entry)
        changed = self.data(
            self.call("PATCH", f"/v1/nutrition/diary/entries/{entry['id']}", {"grams": 50}, rev=1)
        )
        self.assertEqual(changed["snapshot"]["per100g"]["calories"], D(200))
        self.assertEqual(changed["id"], entry["id"])

    def test_recipe_yield_and_food_edits_preserve_ingredient_and_diary_versions(self):
        food = self.food()
        recipe = self.recipe(food)
        entry = self.portion(
            food, sourceType="recipe", sourceId=recipe["id"], sourceRevision=1, grams=150
        )
        self.assertEqual(entry["snapshot"]["per100g"]["calories"], D(100))
        self.data(
            self.call(
                "PATCH",
                f"/v1/nutrition/foods/{food['id']}",
                {"per100g": {"calories": 1000, "protein": 1, "carbs": 1, "fat": 1}},
                rev=1,
            )
        )
        revised = self.data(
            self.call(
                "PATCH", f"/v1/nutrition/recipes/{recipe['id']}", {"finishedGrams": 200}, rev=1
            )
        )
        self.assertEqual(revised["ingredients"][0]["snapshot"]["per100g"]["calories"], D(200))
        self.assertEqual(revised["version"], 2)
        historical = self.data(self.call("GET", f"/v1/nutrition/recipes/{recipe['id']}/versions/1"))
        self.assertEqual(historical["finishedGrams"], D(400))
        self.assertEqual(
            self.data(self.call("GET", f"/v1/nutrition/diary/entries/{entry['id']}")), entry
        )

    def test_diary_move_delete_totals_and_id_reservation(self):
        food = self.food()
        entry = self.portion(food)
        path = f"/v1/nutrition/diary/entries/{entry['id']}"
        moved = self.data(
            self.call("PATCH", path, {"date": "2026-10-19", "meal": "Dinner", "grams": 50}, rev=1)
        )
        self.assertEqual(moved["id"], entry["id"])
        old = self.data(self.call("GET", "/v1/nutrition/diary", query={"date": "2026-10-18"}))
        new = self.data(self.call("GET", "/v1/nutrition/diary", query={"date": "2026-10-19"}))
        self.assertEqual(old["totals"]["calories"], 0)
        self.assertEqual(new["totals"]["calories"], 100)
        key = str(uuid4())
        deleted = self.call("DELETE", path, rev=2, key=key)
        self.assertEqual(deleted.status, 204)
        self.assertIsNone(deleted.body)
        self.assertEqual(self.call("DELETE", path, rev=2, key=key).status, 204)
        duplicate = {
            "id": entry["id"],
            "date": "2026-10-19",
            "meal": "Lunch",
            "sourceType": "food",
            "sourceId": food["id"],
            "sourceRevision": 1,
            "grams": 50,
        }
        self.assertEqual(self.call("POST", "/v1/nutrition/diary/entries", duplicate).status, 409)

    def test_effective_goal_versions_and_same_day_latest(self):
        body = {
            "calories": 2400,
            "protein": 160,
            "carbs": 290,
            "fat": 67,
            "effectiveFrom": "2026-10-18",
        }
        self.data(self.call("PUT", "/v1/nutrition/goals", body, rev=0))
        self.data(self.call("PUT", "/v1/nutrition/goals", {**body, "calories": 2500}, rev=1))
        goal = self.data(self.call("GET", "/v1/nutrition/goals", query={"date": "2026-10-18"}))
        self.assertEqual((goal["calories"], goal["revision"], goal["version"]), (D(2500), 2, 2))
        self.assertEqual(
            self.call("GET", "/v1/nutrition/goals", query={"date": "2026-10-17"}).status, 404
        )
        self.assertEqual(len(self.nutrition.list(A, "goalVersion")), 2)
        diary = self.data(self.call("GET", "/v1/nutrition/diary", query={"date": "2026-10-18"}))
        self.assertEqual(diary["goals"]["calories"], D(2500))

    def test_profile_preferences_roundtrip(self):
        profile = self.data(
            self.call(
                "POST", "/v1/me", {"name": "A", "unit": "lb", "timeZone": "America/Los_Angeles"}
            ),
            201,
        )
        self.assertEqual(self.data(self.call("GET", "/v1/me")), profile)
        self.assertEqual(
            self.call("PATCH", "/v1/me", {"timeZone": "invalid-zone"}, rev=1).status, 422
        )

    def test_fractional_decimal_calculations_and_raw_cooked_independence(self):
        n = Nutrients(calories=360, protein=7, carbs=79, fat=D("0.7"))
        self.assertEqual(scale(n, D("75.5")).calories, D("271.8"))
        a = self.portion(sourceId="rice-dry", sourceRevision=1, grams=D("75.5"))
        self.assertEqual(a["snapshot"]["preparation"], "dry")
        self.assertIn("75.5", json_text(a))
        self.assertNotIn('"75.5"', json_text(a))


class IsolationAndMutationTests(FoundationCase):
    def test_all_private_resource_reads_and_updates_are_isolated_in_both_directions(self):
        for owner, other in ((A, B), (B, A)):
            with self.subTest(owner=owner.subject):
                ex = self.exercise(p=owner)
                food = self.food(p=owner)
                recipe = self.recipe(food, p=owner)
                session = self.session(ex, p=owner)
                entry = self.portion(food, p=owner)
                template = self.data(
                    self.call(
                        "POST",
                        "/v1/workouts/templates",
                        {"id": str(uuid4()), "name": "Private", "exercises": []},
                        p=owner,
                    ),
                    201,
                )
                routes = [
                    ("/v1/workouts/exercises/", ex),
                    ("/v1/workouts/templates/", template),
                    ("/v1/workouts/sessions/", session),
                    ("/v1/nutrition/foods/", food),
                    ("/v1/nutrition/recipes/", recipe),
                    ("/v1/nutrition/diary/entries/", entry),
                ]
                for prefix, obj in routes:
                    before = self.data(self.call("GET", prefix + obj["id"], p=owner))
                    self.assertEqual(self.call("GET", prefix + obj["id"], p=other).status, 404)
                    patch = {"grams": 20} if prefix.endswith("entries/") else {"name": "Attack"}
                    self.assertEqual(
                        self.call("PATCH", prefix + obj["id"], patch, p=other, rev=1).status, 404
                    )
                    self.assertEqual(
                        self.data(self.call("GET", prefix + obj["id"], p=owner)), before
                    )
                self.assertEqual(
                    self.call(
                        "GET", f"/v1/nutrition/recipes/{recipe['id']}/versions/1", p=other
                    ).status,
                    404,
                )
                self.assertEqual(
                    self.call(
                        "DELETE", f"/v1/nutrition/diary/entries/{entry['id']}", p=other, rev=1
                    ).status,
                    404,
                )

    def test_foreign_completed_version_cannot_be_read_or_reopened(self):
        completed = self.finish(self.session())
        path = f"/v1/workouts/sessions/{completed['id']}"
        self.data(self.call("GET", path + "/versions/1"))
        self.assertEqual(self.call("GET", path + "/versions/1", p=B).status, 404)
        self.assertEqual(
            self.call("POST", path + "/reopen", p=B, rev=completed["revision"]).status, 404
        )
        self.assertEqual(self.data(self.call("GET", path))["completedVersion"], 1)

    def test_foreign_nested_references_are_rejected_without_partial_creates(self):
        ex = self.exercise()
        food = self.food()
        recipe = self.recipe(food)
        attempts = [
            (
                "/v1/workouts/templates",
                {
                    "id": str(uuid4()),
                    "name": "B",
                    "exercises": [{"id": str(uuid4()), "exerciseId": ex["id"]}],
                },
            ),
            (
                "/v1/nutrition/recipes",
                {
                    "id": str(uuid4()),
                    "name": "B",
                    "finishedGrams": 100,
                    "ingredients": [
                        {"id": str(uuid4()), "foodId": food["id"], "foodRevision": 1, "grams": 100}
                    ],
                },
            ),
            (
                "/v1/nutrition/diary/entries",
                {
                    "id": str(uuid4()),
                    "date": "2026-10-18",
                    "meal": "Lunch",
                    "sourceType": "recipe",
                    "sourceId": recipe["id"],
                    "sourceRevision": 1,
                    "grams": 100,
                },
            ),
        ]
        for path, body in attempts:
            self.assertEqual(self.call("POST", path, body, p=B).status, 404)
        self.assertEqual(self.nutrition.list(B, "recipe"), ())
        self.assertEqual(self.nutrition.list(B, "diary"), ())
        self.assertEqual(self.training.list(B, "template"), ())

    def test_owner_and_snapshot_mass_assignment_are_rejected(self):
        for field in ("ownerId", "ownerSub", "userId", "PK", "snapshot", "createdAt"):
            with self.subTest(field=field):
                response = self.call(
                    "POST",
                    "/v1/workouts/exercises",
                    {"id": str(uuid4()), "name": "Attack", field: A.subject},
                    p=B,
                )
                self.assertEqual(response.status, 422)
        self.assertEqual(self.training.list(B, "exercise"), ())

    def test_foreign_side_id_through_owned_session_is_rejected(self):
        a = self.session(self.exercise(unilateral=True))
        b = self.session(self.exercise(p=B, unilateral=True), p=B)
        row = a["exercises"][0]["sets"][0]
        response = self.call(
            "PATCH",
            f"/v1/workouts/sessions/{b['id']}/sets",
            {
                "edits": [
                    {
                        "entryId": b["exercises"][0]["id"],
                        "groupId": row["groupId"],
                        "setId": row["id"],
                        "side": "L",
                        "done": True,
                    }
                ]
            },
            p=B,
            rev=1,
        )
        self.assertEqual(response.status, 404)
        self.assertEqual(self.data(self.call("GET", f"/v1/workouts/sessions/{a['id']}")), a)

    def test_no_trusted_identity_scopes_invitation_and_disabled_account(self):
        self.assertEqual(self.api.handle("GET", "/v1/workouts/exercises").status, 401)
        self.assertEqual(
            self.call(
                "GET", "/v1/workouts/exercises", p=Principal("unknown", invited=False)
            ).status,
            403,
        )
        read_only = Principal(A.subject, frozenset({"form/read"}))
        self.assertEqual(
            self.call(
                "POST", "/v1/workouts/exercises", {"id": str(uuid4()), "name": "No"}, p=read_only
            ).status,
            403,
        )
        self.uow.disabled.add(A.subject)
        self.assertEqual(self.call("GET", "/v1/workouts/exercises").status, 403)

    def test_retry_after_response_loss_replays_one_commit(self):
        body = {"id": str(uuid4()), "name": "Only once"}
        key = str(uuid4())
        first = self.call("POST", "/v1/workouts/exercises", body, key=key)
        second = self.call("POST", "/v1/workouts/exercises", body, key=key)
        self.assertEqual(first.body["data"], second.body["data"])
        self.assertEqual(second.headers["Idempotency-Replayed"], "true")
        self.assertEqual(len(self.training.list(A, "exercise")), 1)
        self.assertEqual(
            self.call(
                "POST", "/v1/workouts/exercises", {**body, "name": "Changed"}, key=key
            ).status,
            409,
        )

    def test_identical_ids_and_idempotency_keys_are_scoped_by_user(self):
        body = {"id": str(uuid4()), "name": "Private"}
        key = str(uuid4())
        for p in (A, B):
            self.data(self.call("POST", "/v1/workouts/exercises", body, p=p, key=key), 201)
        self.assertEqual(self.training.get(A, "exercise", body["id"]).owner_sub, A.subject)
        self.assertEqual(self.training.get(B, "exercise", body["id"]).owner_sub, B.subject)

    def test_conflicting_devices_only_one_write_succeeds_and_retry_precedes_revision_check(self):
        ex = self.exercise()
        path = f"/v1/workouts/exercises/{ex['id']}"
        key = str(uuid4())
        r = self.call("PATCH", path, {"name": "First"}, rev=1, key=key)
        self.assertEqual(r.status, 200)
        self.assertEqual(self.call("PATCH", path, {"name": "First"}, rev=1, key=key).status, 200)
        self.assertEqual(self.call("PATCH", path, {"name": "Stale"}, rev=1).status, 412)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(
                pool.map(
                    lambda name: self.call("PATCH", path, {"name": name}, rev=2), ("One", "Two")
                )
            )
        self.assertEqual(sorted(r.status for r in results), [200, 412])

    def test_atomic_batch_rejects_one_bad_side_without_applying_other_edit(self):
        s = self.session(self.exercise(unilateral=True))
        entry = s["exercises"][0]
        left = entry["sets"][0]
        edits = [
            {
                "entryId": entry["id"],
                "groupId": left["groupId"],
                "setId": left["id"],
                "side": "L",
                "kg": 25,
            },
            {
                "entryId": entry["id"],
                "groupId": left["groupId"],
                "setId": "not-a-set",
                "side": "R",
                "kg": 30,
            },
        ]
        self.assertEqual(
            self.call(
                "PATCH", f"/v1/workouts/sessions/{s['id']}/sets", {"edits": edits}, rev=1
            ).status,
            404,
        )
        self.assertEqual(self.data(self.call("GET", f"/v1/workouts/sessions/{s['id']}")), s)

    def test_mid_commit_failure_rolls_back_head_and_receipt_then_retry_succeeds(self):
        f = self.food()
        body = {
            "id": str(uuid4()),
            "name": "Atomic",
            "finishedGrams": 200,
            "ingredients": [
                {"id": str(uuid4()), "foodId": f["id"], "foodRevision": 1, "grams": 100}
            ],
        }
        key = str(uuid4())
        original = self.nutrition.put

        def fail(p, kind, *args, **kwargs):
            if kind == "recipeVersion":
                raise RuntimeError("simulated storage failure")
            return original(p, kind, *args, **kwargs)

        self.nutrition.put = fail
        response = self.call("POST", "/v1/nutrition/recipes", body, key=key)
        self.assertEqual(response.status, 500)
        self.assertEqual(self.nutrition.list(A, "recipe"), ())
        self.nutrition.put = original
        self.data(self.call("POST", "/v1/nutrition/recipes", body, key=key), 201)

    def test_cursor_is_bound_to_user_query_expiry_and_revision_snapshot(self):
        self.exercise()
        self.exercise()
        path = "/v1/workouts/exercises"
        page = self.call("GET", path, query={"limit": "1"})
        cursor = page.body["nextCursor"]
        self.assertIsNotNone(cursor)
        self.assertEqual(
            self.call("GET", path, p=B, query={"limit": "1", "cursor": cursor}).status, 400
        )
        self.assertEqual(self.call("GET", path, query={"limit": "2", "cursor": cursor}).status, 400)
        self.assertEqual(
            self.call("GET", path, query={"limit": "1", "cursor": cursor[:-1] + "x"}).status, 400
        )
        self.exercise()
        self.assertEqual(self.call("GET", path, query={"limit": "1", "cursor": cursor}).status, 409)
        cursor = self.call("GET", path, query={"limit": "1"}).body["nextCursor"]
        self.clock.advance(seconds=901)
        self.assertEqual(self.call("GET", path, query={"limit": "1", "cursor": cursor}).status, 400)

    def test_strict_validation_dates_numbers_yield_unknown_fields_and_preconditions(self):
        food = self.food()
        recipe = self.recipe(food)
        for value in (0, -1, True, "100"):
            self.assertEqual(
                self.call(
                    "PATCH",
                    f"/v1/nutrition/recipes/{recipe['id']}",
                    {"finishedGrams": value},
                    rev=1,
                ).status,
                422,
            )
        for day in ("2026-02-30", "2026-2-01", "yesterday"):
            self.assertEqual(
                self.call("GET", "/v1/nutrition/diary", query={"date": day}).status, 422
            )
        self.assertEqual(
            self.api.handle("POST", "/v1/nutrition/foods", principal=A, body='{"a":NaN}').status,
            400,
        )
        self.assertEqual(
            self.call(
                "PATCH", f"/v1/nutrition/foods/{food['id']}", {"name": "No precondition"}
            ).status,
            428,
        )
        self.assertEqual(
            self.api.handle(
                "POST", "/v1/workouts/exercises", principal=A, body="x" * 262145
            ).status,
            413,
        )


class QueryAndContractTests(FoundationCase):
    def test_dedicated_last_five_does_not_read_unrelated_histories(self):
        target = self.exercise()
        other = self.exercise(name="Other")
        for i in range(7):
            self.finish(self.session(target, started=self.clock() + timedelta(minutes=i)))
        before = self.training.performances(A, target["id"], 5)
        self.assertEqual(len(before), 5)
        self.assertEqual(self.training.last_query_reads, 5)
        for i in range(15):
            self.finish(self.session(other, started=self.clock() + timedelta(minutes=i)))
        self.assertEqual(self.training.performances(A, target["id"], 5), before)
        self.assertEqual(self.training.last_query_reads, 5)
        self.assertEqual(self.training.performances(B, target["id"], 5), ())

    def test_date_range_and_weekly_volume_use_only_dated_summaries(self):
        ex = self.exercise()
        self.finish(self.edit(self.session(ex), reps=10, kg=50, done=True))
        self.finish(self.session(ex, started=self.clock() - timedelta(days=40)))
        records = self.training.workouts_between(
            A, self.clock() - timedelta(days=6), self.clock() + timedelta(days=1)
        )
        self.assertEqual(len(records), 1)
        self.assertEqual(self.training.last_query_reads, 1)
        self.assertEqual(
            sum(
                workout_summary(r.value)["primaryMuscleVolumeKgReps"].get("Chest", 0)
                for r in records
            ),
            500,
        )
        self.assertEqual(
            self.training.workouts_between(
                B, self.clock() - timedelta(days=6), self.clock() + timedelta(days=1)
            ),
            (),
        )
        zone = ZoneInfo("America/Los_Angeles")
        start, end = datetime(2026, 10, 26, tzinfo=zone), datetime(2026, 11, 2, tzinfo=zone)
        self.assertEqual(
            (end.astimezone(timezone.utc) - start.astimezone(timezone.utc)).total_seconds(),
            169 * 3600,
        )

    def test_frozen_dto_and_detached_repository_reads_cannot_mutate_history(self):
        session = self.finish(self.session())
        record = self.training.get(A, "workoutVersion", f"{session['id']}:1")
        with self.assertRaises(ValidationError):
            record.value.name = "Changed"
        dump = record.value.model_dump()
        dump["name"] = "Changed"
        self.assertNotEqual(
            self.training.get(A, "workoutVersion", f"{session['id']}:1").value.name, "Changed"
        )
        with self.assertRaises(Problem):
            self.training.put(A, "workoutVersion", record.value, 1, storage_id=f"{session['id']}:1")

    def test_openapi_is_generated_from_executed_registry_and_all_refs_resolve(self):
        document = openapi()
        stored = json.loads((Path(__file__).parents[1] / "contracts/openapi-v1.json").read_text())
        self.assertEqual(document, stored)

        def walk(v):
            if isinstance(v, dict):
                if "$ref" in v:
                    target = v["$ref"].removeprefix("#/components/schemas/")
                    self.assertIn(target, document["components"]["schemas"])
                for child in v.values():
                    walk(child)
            elif isinstance(v, list):
                for child in v:
                    walk(child)

        walk(document)
        for path in (
            "/v1/workouts/exercises",
            "/v1/workouts/templates",
            "/v1/workouts/sessions",
            "/v1/nutrition/foods",
            "/v1/nutrition/recipes",
            "/v1/nutrition/goals",
            "/v1/nutrition/diary/entries",
        ):
            self.assertIn(path, document["paths"])


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.provider = FakeIdentityProvider({"user-A", "user-B"}, self.clock)
        self.repo = MemorySessions()
        self.sessions = Sessions(self.provider, self.repo, clock=self.clock)

    def login(self, subject="user-A"):
        start = self.sessions.begin()
        code = self.provider.issue_code(subject, start["codeChallenge"], start["nonce"])
        result = self.sessions.callback(start["state"], code, start["bindingCookie"])
        return result

    def test_cookie_persistence_refresh_restore_and_no_tokens_in_session_response(self):
        login = self.login()
        cookie = login["cookie"]
        for flag in ("Secure", "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=604800"):
            self.assertIn(flag, login["setCookie"])
        self.assertEqual(self.sessions.authenticate(cookie), A)
        # Another BFF instance with shared storage simulates refresh/restart, not a real browser.
        refreshed = Sessions(self.provider, self.repo, clock=self.clock)
        info = refreshed.session_info(cookie)
        self.assertEqual(info["subject"], A.subject)
        self.assertEqual(set(info), {"subject", "csrfToken", "expiresAt"})
        self.assertNotIn(cookie, self.repo._rows)

    def test_invitation_only_fake_rejects_unknown_identity(self):
        with self.assertRaises(Problem) as err:
            self.login("not-invited")
        self.assertEqual(err.exception.status, 403)

    def test_login_state_cookie_nonce_pkce_and_single_use(self):
        start = self.sessions.begin()
        code = self.provider.issue_code("user-A", start["codeChallenge"], start["nonce"])
        with self.assertRaises(Problem):
            self.sessions.callback(start["state"], code, "wrong-binding")
        self.sessions.callback(start["state"], code, start["bindingCookie"])
        with self.assertRaises(Problem):
            self.sessions.callback(start["state"], code, start["bindingCookie"])
        start = self.sessions.begin()
        code = self.provider.issue_code("user-A", "wrong-challenge", start["nonce"])
        with self.assertRaises(Problem):
            self.sessions.callback(start["state"], code, start["bindingCookie"])

    def test_csrf_and_logout_are_account_session_bound_and_revoke(self):
        login = self.login()
        other = self.login("user-B")
        info = self.sessions.session_info(login["cookie"])
        with self.assertRaises(Problem):
            self.sessions.authorize_mutation(
                login["cookie"], "https://evil.test", info["csrfToken"]
            )
        with self.assertRaises(Problem):
            self.sessions.authorize_mutation(
                other["cookie"], "https://form.test", info["csrfToken"]
            )
        self.assertIn(
            "Max-Age=0",
            self.sessions.logout(login["cookie"], "https://form.test", info["csrfToken"]),
        )
        with self.assertRaises(Problem):
            self.sessions.authenticate(login["cookie"])
        self.assertEqual(self.sessions.authenticate(other["cookie"]), B)

    def test_parallel_refresh_uses_one_rotation_and_keeps_subject(self):
        login = self.login()
        self.clock.advance(minutes=11)
        with ThreadPoolExecutor(max_workers=8) as pool:
            identities = list(
                pool.map(lambda _: self.sessions.authenticate(login["cookie"]), range(8))
            )
        self.assertEqual(identities, [A] * 8)
        self.assertEqual(self.provider.renewals, 1)

    def test_renewal_failure_is_retryable_without_destroying_session(self):
        login = self.login()
        self.clock.advance(minutes=11)
        self.provider.unavailable = True
        with self.assertRaises(Problem) as err:
            self.sessions.authenticate(login["cookie"])
        self.assertEqual(err.exception.status, 503)
        self.provider.unavailable = False
        self.assertEqual(self.sessions.authenticate(login["cookie"]), A)

    def test_seven_day_absolute_max_is_not_extended_by_activity(self):
        login = self.login()
        self.clock.advance(days=6)
        self.sessions.authenticate(login["cookie"])
        self.clock.advance(days=1)
        with self.assertRaises(Problem):
            self.sessions.authenticate(login["cookie"])

    def test_custom_shorter_expiry_and_invalid_origin_configuration(self):
        with self.assertRaises(ValueError):
            SessionConfig(origin="http://form.test")
        with self.assertRaises(ValueError):
            SessionConfig(max_lifetime=timedelta(0))
        sessions = Sessions(
            self.provider, self.repo, SessionConfig(max_lifetime=timedelta(hours=1)), self.clock
        )
        start = sessions.begin()
        code = self.provider.issue_code("user-A", start["codeChallenge"], start["nonce"])
        login = sessions.callback(start["state"], code, start["bindingCookie"])
        self.assertIn("Max-Age=3600", login["setCookie"])
        self.clock.advance(hours=1)
        with self.assertRaises(Problem):
            sessions.authenticate(login["cookie"])


class AdditionalBoundaryTests(FoundationCase):
    def test_fake_bff_session_restores_saved_workout_and_meal_and_denies_other_user(self):
        provider = FakeIdentityProvider({A.subject, B.subject}, self.clock)
        sessions_repo = MemorySessions()
        manager = Sessions(provider, sessions_repo, clock=self.clock)

        def login(subject):
            start = manager.begin()
            code = provider.issue_code(subject, start["codeChallenge"], start["nonce"])
            return manager.callback(start["state"], code, start["bindingCookie"])["cookie"]

        cookie_a, cookie_b = login(A.subject), login(B.subject)
        principal = manager.authenticate(cookie_a)
        workout = self.session(p=principal)
        meal = self.portion(p=principal)
        recreated = Sessions(provider, sessions_repo, clock=self.clock)
        restored = recreated.authenticate(cookie_a)
        self.data(self.call("GET", f"/v1/workouts/sessions/{workout['id']}", p=restored))
        self.data(self.call("GET", f"/v1/nutrition/diary/entries/{meal['id']}", p=restored))
        stranger = recreated.authenticate(cookie_b)
        self.assertEqual(
            self.call("GET", f"/v1/workouts/sessions/{workout['id']}", p=stranger).status, 404
        )
        self.assertEqual(
            self.call("GET", f"/v1/nutrition/diary/entries/{meal['id']}", p=stranger).status, 404
        )

    def test_profile_and_goal_singletons_are_private_and_no_cross_user_override(self):
        for principal, name, calories in ((A, "A", 2400), (B, "B", 1900)):
            self.data(self.call("POST", "/v1/me", {"name": name}, p=principal), 201)
            self.data(
                self.call(
                    "PUT",
                    "/v1/nutrition/goals",
                    {
                        "calories": calories,
                        "protein": 100,
                        "carbs": 200,
                        "fat": 60,
                        "effectiveFrom": "2026-10-18",
                    },
                    p=principal,
                    rev=0,
                )
            )
        self.assertEqual(self.data(self.call("GET", "/v1/me", p=A))["name"], "A")
        self.assertEqual(self.data(self.call("GET", "/v1/me", p=B))["name"], "B")
        self.assertEqual(
            self.data(self.call("GET", "/v1/nutrition/goals", p=A))["calories"], D(2400)
        )
        self.assertEqual(
            self.data(self.call("GET", "/v1/nutrition/goals", p=B))["calories"], D(1900)
        )

    def test_default_diary_date_uses_profile_zone_across_utc_midnight(self):
        self.clock.now = datetime(2026, 10, 18, 0, 15, tzinfo=timezone.utc)
        self.data(
            self.call("POST", "/v1/me", {"name": "A", "timeZone": "America/Los_Angeles"}), 201
        )
        entry = self.portion(date="2026-10-17")
        diary = self.data(self.call("GET", "/v1/nutrition/diary"))
        self.assertEqual(diary["date"].isoformat(), "2026-10-17")
        self.assertEqual(diary["entries"][0]["id"], entry["id"])

    def test_duplicate_json_keys_and_unrepresentable_decimal_precision_are_rejected(self):
        response = self.api.handle(
            "POST",
            "/v1/workouts/exercises",
            principal=A,
            body='{"id":"one","id":"two","name":"Ambiguous"}',
        )
        self.assertEqual(response.status, 400)
        food = self.food()
        path = f"/v1/nutrition/foods/{food['id']}"
        amount = D("0." + "1" * 40)
        self.assertEqual(
            self.call(
                "PATCH",
                path,
                {"per100g": {"calories": amount, "protein": 1, "carbs": 1, "fat": 1}},
                rev=1,
            ).status,
            422,
        )
        self.assertEqual(
            self.call("GET", "/v1/nutrition/foods", query={"date": "2026-10-18"}).status, 400
        )

    def test_header_owner_and_unverified_bearer_do_not_supply_identity(self):
        self.assertEqual(
            self.api.handle(
                "GET",
                "/v1/workouts/exercises",
                headers={"Authorization": "Bearer user-A", "ownerSub": "user-A"},
            ).status,
            401,
        )
        body = {"id": str(uuid4()), "name": "B only"}
        response = self.api.handle(
            "POST",
            "/v1/workouts/exercises",
            principal=B,
            body=json_text(body),
            headers={
                "Idempotency-Key": str(uuid4()),
                "ownerSub": "user-A",
                "Authorization": "Bearer user-A",
            },
        )
        self.assertEqual(response.status, 201)
        self.assertEqual(response.body["data"]["ownerSub"], B.subject)
        self.assertEqual(self.call("GET", "/v1/workouts/exercises/" + body["id"], p=A).status, 404)

    def test_active_session_edits_cannot_change_template_and_invalid_reorder_is_atomic(self):
        session = self.session()
        before = session
        response = self.call(
            "PATCH", f"/v1/workouts/sessions/{session['id']}", {"entryOrder": ["foreign"]}, rev=1
        )
        self.assertEqual(response.status, 422)
        self.assertEqual(
            self.data(self.call("GET", f"/v1/workouts/sessions/{session['id']}")), before
        )
        self.assertEqual(
            self.call(
                "PATCH", f"/v1/workouts/sessions/{session['id']}", {"templateId": "foreign"}, rev=1
            ).status,
            422,
        )

    def test_repeating_decimal_recipe_uses_explicit_precision_without_display_rounding(self):
        food = self.food()
        recipe = self.recipe(food)
        revised = self.data(
            self.call(
                "PATCH", f"/v1/nutrition/recipes/{recipe['id']}", {"finishedGrams": 300}, rev=1
            )
        )
        entry = self.portion(
            food,
            sourceType="recipe",
            sourceId=recipe["id"],
            sourceRevision=revised["version"],
            grams=1,
        )
        calories = entry["snapshot"]["per100g"]["calories"]
        self.assertEqual(len(calories.as_tuple().digits), 38)
        self.assertNotEqual(calories, calories.quantize(D("0.01")))

    def test_large_recipe_listing_paginates_without_missing_or_cross_user_entries(self):
        food = self.food()
        for _ in range(5):
            self.recipe(food)
        self.recipe(p=B)
        ids = []
        cursor = None
        while True:
            query = {"limit": "2"}
            if cursor:
                query["cursor"] = cursor
            page = self.call("GET", "/v1/nutrition/recipes", query=query)
            self.assertEqual(page.status, 200)
            ids.extend(x["id"] for x in page.body["items"])
            cursor = page.body["nextCursor"]
            if not cursor:
                break
        self.assertEqual(len(ids), 5)
        self.assertEqual(len(set(ids)), 5)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.raw = (FIXTURES / "browser-export.json").read_bytes()

    def test_valid_export_preflight_preserves_source_bytes_and_ids(self):
        report = plan_export(self.raw, A, claim=True)
        self.assertTrue(report.valid, report.blockers)
        self.assertEqual(self.raw, (FIXTURES / "browser-export.json").read_bytes())
        self.assertEqual({m.destination_owner for m in report.mappings}, {A.subject})
        self.assertIn("initial-session", {m.destination_id for m in report.mappings})
        self.assertTrue(any("no reliable mock flag" in w for w in report.warnings))

    def test_repeat_preflight_is_deterministic_and_other_user_has_separate_destination(self):
        a = plan_export(self.raw, A, claim=True)
        again = plan_export(self.raw, A, claim=True)
        b = plan_export(self.raw, B, claim=True)
        self.assertEqual(a, again)
        self.assertEqual(a.source_digest, b.source_digest)
        self.assertEqual({m.destination_owner for m in b.mappings}, {B.subject})
        with self.assertRaises(Problem):
            plan_export(self.raw, A)

    def test_python_daily_totals_match_existing_typescript_calculation_fixtures(self):
        report = plan_export(self.raw, A, claim=True)
        parity = load_json((FIXTURES / "calculation-parity.json").read_bytes())
        for day in parity["days"]:
            actual = report.daily_totals[day["date"]]
            for field, value in day["totals"].items():
                self.assertLessEqual(abs(actual[field] - D(str(value))), D("0.000000001"))

    def test_snapshot_changes_and_unequal_sides_are_not_recalculated(self):
        source = load_json(self.raw)
        source["nutrition"]["foods"][0]["per100g"]["calories"] = 999
        rows = source["workouts"]["history"][0]["logs"]["pulldown"]
        rows[0]["kg"] = D("22.5")
        rows[1]["kg"] = 20
        rows[1]["done"] = False
        rows[0]["rpe"] = "8"
        raw = json_text(source).encode()
        report = plan_export(raw, A, claim=True)
        self.assertTrue(report.valid, report.blockers)
        original = plan_export(self.raw, A, claim=True)
        self.assertEqual(report.daily_totals, original.daily_totals)
        self.assertEqual(raw, json_text(source).encode())

    def test_invalid_owner_pairing_duplicate_date_and_unsupported_versions_block_losslessly(self):
        edits = [
            lambda x: x["workouts"]["session"].__setitem__("ownerId", "foreign"),
            lambda x: x["workouts"]["session"]["logs"]["pulldown"][0].__setitem__("side", "R"),
            lambda x: x["nutrition"]["diary"][0].__setitem__("date", "2026-02-30"),
            lambda x: x["workouts"].__setitem__("version", 2),
        ]
        for edit in edits:
            source = load_json(self.raw)
            edit(source)
            raw = json_text(source).encode()
            report = plan_export(raw, A, claim=True)
            self.assertFalse(report.valid)
            self.assertTrue(report.blockers)
            self.assertEqual(raw, json_text(source).encode())

    def test_current_and_history_shared_identity_is_retained_as_distinct_roles(self):
        raw = load_json(self.raw)
        raw["workouts"]["session"] = raw["workouts"]["history"][0]
        report = plan_export(json_text(raw).encode(), A, claim=True)
        self.assertTrue(report.valid, report.blockers)
        self.assertTrue(any("shared ID" in w for w in report.warnings))
        roles = {
            load_json(m.identity)[1]
            for m in report.mappings
            if load_json(m.identity)[0] == "session"
        }
        self.assertEqual(roles, {"history", "current"})

    def test_python_workout_calculations_match_typescript_fixture(self):
        from form_backend.migration import BrowserExport, normalized_workout

        source = BrowserExport.model_validate(load_json(self.raw), by_alias=True, by_name=False)
        parity = load_json((FIXTURES / "calculation-parity.json").read_bytes())
        expected = {row["id"]: row for row in parity["workouts"]}
        for session in source.workouts.history:
            summary = workout_summary(normalized_workout(session))
            self.assertEqual(summary["volumeKgReps"], expected[session.id]["volume"])
            self.assertEqual(
                summary["completedGroups"], expected[session.id]["counts"]["completed"]
            )

    def test_colliding_existing_destination_is_reported_never_overwritten(self):
        report = plan_export(self.raw, A, claim=True)
        existing = {report.mappings[0].identity: "different-fingerprint"}
        before = existing.copy()
        conflict = plan_export(self.raw, A, claim=True, existing=existing)
        self.assertFalse(conflict.valid)
        self.assertEqual(existing, before)


if __name__ == "__main__":
    unittest.main()
