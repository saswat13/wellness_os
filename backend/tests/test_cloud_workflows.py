"""New cloud-workspace contracts run on memory AND Moto, never real AWS."""

import unittest
from copy import deepcopy
from uuid import uuid4

import test_dynamo as dynamo_tests
from test_foundations import A, B, FoundationCase


class Workflows:
    def active(self, principal=A, query=None):
        result = self.call("GET", "/v1/workouts/sessions/active", p=principal, query=query)
        self.assertEqual(result.status, 200, result.to_json())
        return result.body

    def test_active_discovery_completion_reopen_and_two_users(self):
        left = self.session(self.exercise(unilateral=True))
        right = self.session(p=B)
        self.assertEqual([r["id"] for r in self.active()["items"]], [left["id"]])
        self.assertEqual([r["id"] for r in self.active(B)["items"]], [right["id"]])
        done = self.finish(left)
        self.assertEqual(self.active()["items"], ())
        reopened = self.data(
            self.call("POST", f"/v1/workouts/sessions/{left['id']}/reopen", rev=done["revision"])
        )
        self.assertEqual(self.active()["items"][0]["id"], left["id"])
        self.assertEqual(reopened["status"], "active")

    def body(self, session):
        return {
            "name": session["name"],
            "notes": session["notes"],
            "unit": session["unit"],
            "exercises": [
                {k: v for k, v in entry.items() if k != "snapshot"}
                for entry in session["exercises"]
            ],
        }

    def test_atomic_draft_sides_ids_and_history_immutability(self):
        session = self.session(self.exercise(unilateral=True))
        body = self.body(session)
        rows = body["exercises"][0]["sets"]
        rows[0].update(kg=25, reps=10, rpe=8, done=True)
        rows[1].update(kg=20, reps=9, rpe=7, done=False)
        path = f"/v1/workouts/sessions/{session['id']}/draft"
        key = str(uuid4())
        saved = self.data(self.call("PUT", path, body, rev=session["revision"], key=key))
        self.assertEqual(saved["exercises"][0]["sets"][0]["id"], rows[0]["id"])
        self.assertTrue(
            self.call("PUT", path, body, rev=session["revision"], key=key).headers[
                "Idempotency-Replayed"
            ]
        )
        self.assertEqual(self.call("PUT", path, body, rev=session["revision"]).status, 412)
        completed = self.finish(saved)
        self.assertEqual(completed["summary"]["volumeKgReps"], 250)
        self.assertEqual(completed["summary"]["completedGroups"], 0)
        self.assertEqual(self.call("PUT", path, body, rev=completed["revision"]).status, 409)
        immutable = self.data(self.call("GET", f"/v1/workouts/sessions/{session['id']}/versions/1"))
        self.assertEqual(immutable["exercises"][0]["sets"][1]["kg"], 20)
        self.assertFalse(immutable["exercises"][0]["sets"][1]["done"])

    def test_draft_does_not_accept_owner_snapshot_or_reassign_set_identity(self):
        session = self.session(self.exercise(unilateral=True))
        body = self.body(session)
        path = f"/v1/workouts/sessions/{session['id']}/draft"
        self.assertEqual(self.call("PUT", path, body, p=B, rev=session["revision"]).status, 404)
        bad = deepcopy(body)
        bad["ownerSub"] = B.subject
        self.assertEqual(self.call("PUT", path, bad, rev=session["revision"]).status, 422)
        bad = deepcopy(body)
        bad["exercises"][0]["snapshot"] = session["exercises"][0]["snapshot"]
        self.assertEqual(self.call("PUT", path, bad, rev=session["revision"]).status, 422)
        bad = deepcopy(body)
        bad["exercises"][0]["sets"][0]["side"] = "R"
        self.assertEqual(self.call("PUT", path, bad, rev=session["revision"]).status, 422)
        original = self.data(self.call("GET", f"/v1/workouts/sessions/{session['id']}"))
        self.assertEqual(original["revision"], session["revision"])

    def test_draft_add_remove_reorder_and_frozen_exercise_snapshot(self):
        session = self.session()
        first = session["exercises"][0]
        extra = self.exercise(unilateral=True)
        body = self.body(session)
        body["exercises"].append(
            {
                "id": str(uuid4()),
                "exerciseId": extra["id"],
                "prescription": {"plannedSets": 1, "target": "8–12", "note": ""},
                "sameWeight": False,
                "sets": [
                    {
                        "id": str(uuid4()),
                        "groupId": "new-pair",
                        "side": s,
                        "reps": 8,
                        "kg": 20 if s == "L" else 17,
                        "done": s == "L",
                    }
                    for s in ["L", "R"]
                ],
            }
        )
        body["exercises"].reverse()
        path = f"/v1/workouts/sessions/{session['id']}/draft"
        saved = self.data(self.call("PUT", path, body, rev=session["revision"]))
        self.assertEqual(saved["exercises"][0]["exerciseId"], extra["id"])
        self.data(
            self.call(
                "PATCH",
                f"/v1/workouts/exercises/{first['exerciseId']}",
                {"name": "Renamed definition"},
                rev=1,
            )
        )
        body["exercises"] = body["exercises"][1:]
        final = self.data(self.call("PUT", path, body, rev=saved["revision"]))
        self.assertEqual(final["exercises"][0]["snapshot"]["name"], first["snapshot"]["name"])
        self.assertEqual(len(final["exercises"]), 1)

    def test_active_pagination_is_bound_to_identity_and_collection(self):
        self.session()
        self.session()
        first = self.active(query={"limit": "1"})
        self.assertEqual(len(first["items"]), 1)
        cursor = first["nextCursor"]
        self.assertIsNotNone(cursor)
        next_page = self.active(query={"limit": "1", "cursor": cursor})
        self.assertNotEqual(first["items"][0]["id"], next_page["items"][0]["id"])
        self.assertEqual(
            self.call(
                "GET", "/v1/workouts/sessions/active", p=B, query={"limit": "1", "cursor": cursor}
            ).status,
            400,
        )


class MemoryCloudWorkflows(Workflows, FoundationCase):
    pass


class DynamoCloudWorkflows(Workflows, unittest.TestCase):
    setUp = dynamo_tests.DynamoContract.setUp
    call = FoundationCase.call
    data = FoundationCase.data
    exercise = FoundationCase.exercise
    session = FoundationCase.session
    finish = FoundationCase.finish
