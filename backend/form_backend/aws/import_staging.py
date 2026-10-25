"""Unexposed import preparation/staging. No browser integration or cloud publication.

Only a separately authorized import worker may use this class. Ordinary domain
requests cannot submit trusted historical snapshots. Originals are never removed.
"""

import base64
from dataclasses import dataclass
from hashlib import sha256

from ..calculations import workout_summary
from ..core import Problem, digest, json_text, load_json
from ..migration import BrowserExport, normalized_workout, plan_export
from ..models import (
    DiaryEntry,
    Exercise,
    Food,
    FoodSnapshot,
    Goals,
    Ingredient,
    Profile,
    Recipe,
    Template,
    WorkoutSummary,
    changed,
)
from .dynamo import attributes, user


@dataclass(frozen=True)
class ImportRecord:
    identity: tuple[str, ...]
    payload: str


@dataclass(frozen=True)
class PreparedImport:
    source_digest: str
    manifest_digest: str
    records: tuple[ImportRecord, ...]
    raw_chunks: tuple[str, ...]
    daily_totals: str


def prepare(raw, principal, *, claim, goal_effective_from):
    plan = plan_export(raw, principal, claim=claim)
    if not plan.valid:
        raise Problem(422, "IMPORT_BLOCKED")
    source = BrowserExport.model_validate(load_json(raw), by_alias=True, by_name=False)
    records = []

    def add(identity, value):
        payload = value.model_dump() if hasattr(value, "model_dump") else value
        records.append(ImportRecord(tuple(identity), json_text(payload)))

    if source.workouts:
        workouts = source.workouts
        for exercise in workouts.library:
            # System IDs remain stable; staged copy is provenance, not a catalog mutation.
            add(
                ("exercise", exercise.source, exercise.id),
                Exercise.model_validate(
                    exercise.model_dump(exclude={"owner_id", "source", "created_at", "updated_at"})
                ),
            )
        for template in workouts.templates:
            add(
                ("template", template.id),
                Template.model_validate(
                    template.model_dump(
                        exclude={"owner_id", "visibility", "created_at", "updated_at"}
                    )
                ),
            )
        for role, sessions in (("history", workouts.history), ("current", (workouts.session,))):
            for legacy in sessions:
                workout = normalized_workout(legacy)
                if workout.status == "completed":
                    workout = changed(
                        workout, summary=WorkoutSummary.model_validate(workout_summary(workout))
                    )
                add(("session", role, workout.id), workout)
    if source.nutrition:
        nutrition = source.nutrition
        add(("profile", "profile"), Profile(**nutrition.user.model_dump(exclude={"id"})))
        add(
            ("goals", "current"),
            Goals(
                **nutrition.goals.model_dump(exclude={"id", "owner_id"}),
                effective_from=goal_effective_from,
            ),
        )
        for food in nutrition.foods:
            add(
                ("food", food.source, food.id),
                Food.model_validate(food.model_dump(exclude={"owner_id", "source"})),
            )
        for recipe in nutrition.recipes:
            # Existing prototype has only the saved recipe version. Do not invent older versions.
            ingredients = tuple(
                Ingredient(
                    id=i.id,
                    food_id=i.food_id,
                    grams=i.grams,
                    snapshot=FoodSnapshot(
                        **i.snapshot.model_dump(exclude={"owner_id", "source"}),
                        source=i.snapshot.source,
                        source_revision=None,
                    ),
                )
                for i in recipe.ingredients
            )
            add(
                ("recipeVersion", recipe.id, "1"),
                Recipe(
                    id=recipe.id,
                    name=recipe.name,
                    finished_grams=recipe.finished_grams,
                    ingredients=ingredients,
                    version=1,
                ),
            )
        for entry in nutrition.diary:
            add(
                ("diary", entry.id),
                DiaryEntry(
                    **entry.model_dump(exclude={"owner_id", "created_at"}), source_revision=None
                ),
            )
        for id in nutrition.favorites:
            add(("favorite", id), {"foodId": id})
    manifest = digest([[r.identity, digest(load_json(r.payload))] for r in records])
    return PreparedImport(
        plan.source_digest,
        manifest,
        tuple(records),
        tuple(base64.b64encode(raw[i : i + 64000]).decode() for i in range(0, len(raw), 64000)),
        json_text(plan.daily_totals),
    )


class ImportStaging:
    def __init__(self, store):
        self.store = store

    def stage(self, principal, bundle):
        principal.require("form/write")
        pk = user(principal) + "#IMPORT#" + bundle.source_digest
        table = self.store.tables.accounts
        entries = [("RAW#" + str(i).zfill(6), chunk) for i, chunk in enumerate(bundle.raw_chunks)]
        entries += [
            (
                "RECORD#" + str(i).zfill(6),
                json_text({"identity": r.identity, "payload": load_json(r.payload)}),
            )
            for i, r in enumerate(bundle.records)
        ]
        manifest = {
            "PK": pk,
            "SK": "MANIFEST",
            "revision": 1,
            "sourceDigest": bundle.source_digest,
            "manifestDigest": bundle.manifest_digest,
            "records": len(bundle.records),
            "chunks": len(bundle.raw_chunks),
            "dailyTotals": bundle.daily_totals,
            "status": "STAGED_ONLY",
            "owner": principal.subject,
        }
        entries.append(("MANIFEST", json_text(manifest)))
        # Each row is content checked on retry. No existing destination entity is overwritten.
        for sk, payload in entries:
            if len(payload.encode()) > 350000:
                raise Problem(413, "IMPORT_CHUNK_TOO_LARGE")
            checksum = sha256(payload.encode()).hexdigest()
            old = self.store.get(table, pk, sk)
            if old:
                if old["checksum"] != checksum:
                    raise Problem(409, "IMPORT_CHUNK_CONFLICT")
                continue
            self.store.call(
                "put_item",
                TableName=table,
                Item=attributes(
                    {"PK": pk, "SK": sk, "revision": 1, "checksum": checksum, "payload": payload}
                ),
                ConditionExpression="attribute_not_exists(PK)",
            )
        return {
            "status": "STAGED_ONLY",
            "sourceDigest": bundle.source_digest,
            "manifestDigest": bundle.manifest_digest,
            "records": len(bundle.records),
        }

    def verify(self, principal, source_digest):
        pk = user(principal) + "#IMPORT#" + source_digest
        rows = tuple(self.store.query(self.store.tables.accounts, pk))
        parts = {r["SK"]: r for r in rows}
        if "MANIFEST" not in parts:
            raise Problem(409, "IMPORT_INCOMPLETE")
        for row in rows:
            if sha256(row["payload"].encode()).hexdigest() != row["checksum"]:
                raise Problem(409, "IMPORT_CHECKSUM_MISMATCH")
        manifest = load_json(parts["MANIFEST"]["payload"])
        raw = b"".join(
            base64.b64decode(parts["RAW#" + str(i).zfill(6)]["payload"], validate=True)
            for i in range(manifest["chunks"])
        )
        records = [
            load_json(parts["RECORD#" + str(i).zfill(6)]["payload"])
            for i in range(manifest["records"])
        ]
        if (
            sha256(raw).hexdigest() != source_digest
            or digest([[r["identity"], digest(r["payload"])] for r in records])
            != manifest["manifestDigest"]
        ):
            raise Problem(409, "IMPORT_CHECKSUM_MISMATCH")
        return raw, tuple(records)
