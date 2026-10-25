import unittest
from pathlib import Path

import test_dynamo

from form_backend.aws.import_staging import ImportStaging, prepare
from form_backend.core import Principal, Problem


class ImportStagingTests(unittest.TestCase):
    def setUp(self):
        test_dynamo.DynamoContract.setUp(self)
        self.raw = (Path(__file__).parent / "fixtures/browser-export.json").read_bytes()
        self.a, self.b = Principal("user-A"), Principal("user-B")
        self.bundle = prepare(self.raw, self.a, claim=True, goal_effective_from="2026-10-18")
        self.staging = ImportStaging(self.store)

    def test_roundtrip_original_bytes_ids_sides_snapshots_and_deterministic_retry(self):
        first = self.staging.stage(self.a, self.bundle)
        self.assertEqual(self.staging.stage(self.a, self.bundle), first)
        raw, rows = self.staging.verify(self.a, self.bundle.source_digest)
        self.assertEqual(raw, self.raw)
        sessions = [r["payload"] for r in rows if r["identity"][0] == "session"]
        self.assertTrue(any(s["status"] == "completed" for s in sessions))
        self.assertTrue(
            any(r["side"] == "L" for s in sessions for e in s["exercises"] for r in e["sets"])
        )
        self.assertTrue(
            all(e["snapshot"]["source_revision"] is None for s in sessions for e in s["exercises"])
        )
        # Staged records cannot appear in normal APIs.
        self.assertEqual(self.service.training.list(self.a, "session"), ())

    def test_cross_user_staging_isolation_and_explicit_claim(self):
        self.staging.stage(self.a, self.bundle)
        with self.assertRaises(Problem):
            self.staging.verify(self.b, self.bundle.source_digest)
        with self.assertRaises(Problem):
            prepare(self.raw, self.a, claim=False, goal_effective_from="2026-10-18")
        second = prepare(self.raw, self.b, claim=True, goal_effective_from="2026-10-18")
        self.staging.stage(self.b, second)
        self.assertEqual(self.staging.verify(self.b, second.source_digest)[0], self.raw)

    def test_changed_chunk_or_manifest_is_rejected_and_source_unchanged(self):
        from dataclasses import replace

        self.staging.stage(self.a, self.bundle)
        with self.assertRaises(Problem):
            self.staging.stage(self.a, replace(self.bundle, daily_totals='{"tampered":1}'))
        self.assertEqual(
            self.raw, (Path(__file__).parent / "fixtures/browser-export.json").read_bytes()
        )

    def test_recipe_version_and_old_diary_snapshot_survive_current_food_edits(self):
        import json

        source = json.loads(self.raw)
        nutrition = source["nutrition"]
        food = nutrition["foods"][0]
        snapshot = json.loads(json.dumps(food))
        nutrition["recipes"].append(
            {
                "id": "saved-bowl",
                "ownerId": nutrition["user"]["id"],
                "name": "Original bowl",
                "finishedGrams": 350,
                "ingredients": [
                    {"id": "ingredient-1", "foodId": food["id"], "grams": 60, "snapshot": snapshot}
                ],
                "updatedAt": "2026-10-18T12:00:00Z",
            }
        )
        food["per100g"]["calories"] = 999
        raw = json.dumps(source).encode()
        bundle = prepare(raw, self.a, claim=True, goal_effective_from="2026-10-18")
        self.staging.stage(self.a, bundle)
        _, rows = self.staging.verify(self.a, bundle.source_digest)
        recipe = next(r["payload"] for r in rows if r["identity"][0] == "recipeVersion")
        self.assertEqual(recipe["version"], 1)
        self.assertEqual(recipe["finished_grams"], 350)
        self.assertEqual(recipe["ingredients"][0]["snapshot"]["per100g"]["calories"], 379)
        diary = next(
            r["payload"]
            for r in rows
            if r["identity"][0] == "diary" and r["payload"]["source_id"] == food["id"]
        )
        self.assertEqual(diary["snapshot"]["per100g"]["calories"], 379)
