"""Catalog provenance, quality and safe writes against isolated Moto DynamoDB."""

import copy
import hashlib
import io
import unittest
from contextlib import redirect_stderr, redirect_stdout
from decimal import Decimal
from unittest.mock import patch

import test_dynamo
import test_foundations as foundations
from backend.scripts.build_catalog import food_group, preparation
from backend.scripts.seed_catalog import main as seed_main
from botocore.exceptions import ClientError

from form_backend.aws.dynamo import attributes, component, native
from form_backend.catalog import (
    BUNDLE,
    exercise_from_source,
    food_from_source,
    import_catalog,
    load_bundle,
    validate_bundle,
)
from form_backend.core import json_text, load_json


class SourceTests(unittest.TestCase):
    def test_default_dry_run_constructs_no_aws_session(self):
        output = io.StringIO()
        with (
            patch("sys.argv", ["seed_catalog", "--dry-run"]),
            patch("boto3.Session", side_effect=AssertionError("Unexpected AWS access")),
            redirect_stdout(output),
        ):
            seed_main()
        report = load_json(output.getvalue())
        self.assertEqual(report["awsCalls"], 0)
        self.assertEqual((report["exercise"], report["food"]), (400, 400))

    def test_live_apply_wrong_account_stops_before_any_dynamodb_client(self):
        args = [
            "seed_catalog",
            "--apply",
            "--table",
            "catalog",
            "--confirm-table",
            "catalog",
            "--profile",
            "operator",
            "--expected-account",
            "111111111111",
        ]
        with (
            patch("sys.argv", args),
            patch("boto3.Session") as session,
            redirect_stderr(io.StringIO()),
        ):
            session.return_value.client.return_value.get_caller_identity.return_value = {
                "Account": "222222222222"
            }
            with self.assertRaises(SystemExit):
                seed_main()
        self.assertEqual([c.args[0] for c in session.return_value.client.call_args_list], ["sts"])

    def test_launch_counts_provenance_and_source_reproduction(self):
        bundle = load_bundle()
        records = validate_bundle(bundle)
        self.assertEqual(sum(k == "exercise" for k, _ in records), 400)
        self.assertEqual(sum(k == "food" for k, _ in records), 400)
        root = BUNDLE.parent
        manifest = load_json((root / "manifest.json").read_bytes())
        self.assertEqual(hashlib.sha256(BUNDLE.read_bytes()).hexdigest(), manifest["bundleSha256"])
        values = {(k, v.external_id): v for k, v in records}
        for raw in load_json((root / "sources/exercises.json").read_bytes()):
            self.assertNotIn("images", raw)
            value = exercise_from_source(raw)
            self.assertEqual(value, values["exercise", value.external_id])
            self.assertEqual(value.demo_url, "")
        for raw in load_json((root / "sources/foods.json").read_bytes()):
            value = values["food", raw["fdcId"]]
            rebuilt = food_from_source(raw, value.preparation, value.aliases)
            self.assertEqual(rebuilt, value)
        rice = [v for k, v in records if k == "food" and v.external_id in ("168877", "168878")]
        self.assertEqual({v.preparation for v in rice}, {"dry", "cooked"})
        self.assertNotEqual(rice[0].per100g, rice[1].per100g)

    def test_missing_wrong_units_nonfinite_negative_and_impossible_values_rejected(self):
        raw = load_json((BUNDLE.parent / "sources/foods.json").read_bytes())[0]
        self.assertIsNotNone(food_from_source(raw, "raw"))
        broken = copy.deepcopy(raw)
        broken["nutrients"].pop()
        with self.assertRaisesRegex(ValueError, "Missing"):
            food_from_source(broken, "raw")
        for amount in ("NaN", "Infinity", "-1", "1000"):
            broken = copy.deepcopy(raw)
            broken["nutrients"][0]["amount"] = amount
            with self.assertRaises(ValueError):
                food_from_source(broken, "raw")
        broken = copy.deepcopy(raw)
        broken["nutrients"][0]["unit"] = "MG"
        with self.assertRaisesRegex(ValueError, "unit"):
            food_from_source(broken, "raw")
        broken = copy.deepcopy(raw)
        broken["nutrients"].append({**broken["nutrients"][0], "amount": "99"})
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            food_from_source(broken, "raw")

    def test_duplicate_ids_names_and_unapproved_media_rejected_before_writes(self):
        bundle = load_bundle()
        for mutation in ("id", "name", "media"):
            broken = {"version": 1, "items": copy.deepcopy(bundle["items"][:2])}
            if mutation == "id":
                broken["items"][1] = copy.deepcopy(broken["items"][0])
            elif mutation == "name":
                broken["items"][1]["value"]["name"] = broken["items"][0]["value"]["name"].upper()
            else:
                broken["items"][0]["value"]["demo_url"] = "https://example.com/unreviewed.jpg"
            with self.assertRaises(ValueError):
                validate_bundle(broken)

    def test_preparation_uses_whole_words_and_common_food_groups(self):
        self.assertEqual(preparation("Yogurt, Greek, strawberry, lowfat")[0], "packaged")
        self.assertEqual(preparation("Pasta, uncooked")[0], "dry")
        self.assertEqual(preparation("Lentils, raw")[0], "dry")
        self.assertEqual(preparation("Rice, white, long-grain, raw, enriched")[0], "dry")
        self.assertEqual(preparation("Rice, white, long-grain, cooked")[0], "cooked")
        self.assertEqual(food_group("Game meat, goat, cooked, roasted"), "meat-fish")
        self.assertEqual(food_group("Soup, chicken with rice, canned"), "meat-fish")
        self.assertIsNone(preparation("Unspecified food")[0])


class ImportTests(unittest.TestCase):
    setUp = test_dynamo.DynamoContract.setUp
    call = foundations.FoundationCase.call
    data = foundations.FoundationCase.data
    exercise = foundations.FoundationCase.exercise
    food = foundations.FoundationCase.food
    session = foundations.FoundationCase.session
    portion = foundations.FoundationCase.portion

    def bundle(self):
        all_items = load_bundle()["items"]
        ex = next(i for i in all_items if i["kind"] == "exercise" and i["value"]["unilateral"])
        food = next(i for i in all_items if i["kind"] == "food")
        return {"version": 1, "items": copy.deepcopy([ex, food])}

    def item(self, kind, id):
        key = attributes({"PK": "TYPE#" + kind.upper(), "SK": "ID#" + component(id)})
        response = self.store.ddb.get_item(TableName=self.tables.catalog, Key=key)
        return native(response["Item"]) if "Item" in response else None

    def test_dry_run_idempotency_and_managed_upsert_preserve_created_time(self):
        bundle = self.bundle()
        id = bundle["items"][0]["value"]["id"]
        plan = import_catalog(self.store.ddb, self.tables.catalog, bundle)
        self.assertEqual(plan["counts"]["create"], 2)
        self.assertIsNone(self.item("exercise", id))
        import_catalog(self.store.ddb, self.tables.catalog, bundle, apply=True, clock=self.clock)
        first = self.item("exercise", id)
        again = import_catalog(self.store.ddb, self.tables.catalog, bundle, apply=True)
        self.assertEqual(again["counts"]["unchanged"], 2)
        self.assertEqual(self.item("exercise", id), first)
        bundle["items"][0]["value"]["name"] += " (reviewed)"
        self.clock.advance(days=1)
        update = import_catalog(
            self.store.ddb, self.tables.catalog, bundle, apply=True, clock=self.clock
        )
        self.assertEqual(update["counts"]["update"], 1)
        updated = self.item("exercise", id)
        self.assertEqual(updated["created"], first["created"])
        self.assertNotEqual(updated["updated"], first["updated"])
        self.assertEqual(updated["revision"], 2)

    def test_unmanaged_collision_blocks_entire_plan_before_writes(self):
        bundle = self.bundle()
        value = bundle["items"][1]["value"]
        key = {"PK": "TYPE#FOOD", "SK": "ID#" + component(value["id"])}
        original = {**key, "payload": json_text(value), "revision": 1, "created": "original"}
        self.store.ddb.put_item(TableName=self.tables.catalog, Item=attributes(original))
        with self.assertRaisesRegex(ValueError, "before writes"):
            import_catalog(self.store.ddb, self.tables.catalog, bundle, apply=True)
        self.assertEqual(self.item("food", value["id"]), original)
        self.assertIsNone(self.item("exercise", bundle["items"][0]["value"]["id"]))

    def test_manual_payload_change_is_not_overwritten(self):
        bundle = self.bundle()
        import_catalog(self.store.ddb, self.tables.catalog, bundle, apply=True)
        id = bundle["items"][0]["value"]["id"]
        changed = self.item("exercise", id)
        changed["payload"] = changed["payload"].replace('"archived":false', '"archived":true')
        self.store.ddb.put_item(TableName=self.tables.catalog, Item=attributes(changed))
        with self.assertRaisesRegex(ValueError, "modified"):
            import_catalog(self.store.ddb, self.tables.catalog, bundle, apply=True)
        self.assertEqual(self.item("exercise", id), changed)

    def test_duplicate_existing_shared_food_under_another_id_is_not_merged_or_replaced(self):
        bundle = self.bundle()
        value = {**bundle["items"][1]["value"], "id": "existing-shared-food"}
        row = {
            "PK": "TYPE#FOOD",
            "SK": "ID#" + component(value["id"]),
            "payload": json_text(value),
            "revision": 1,
            "created": "original",
        }
        self.store.ddb.put_item(TableName=self.tables.catalog, Item=attributes(row))
        with self.assertRaisesRegex(ValueError, "Duplicate existing"):
            import_catalog(self.store.ddb, self.tables.catalog, bundle, apply=True)
        self.assertEqual(self.item("food", value["id"]), row)
        self.assertIsNone(self.item("exercise", bundle["items"][0]["value"]["id"]))

    def test_revision_race_fails_closed(self):
        bundle = self.bundle()
        import_catalog(self.store.ddb, self.tables.catalog, bundle, apply=True)
        id = bundle["items"][0]["value"]["id"]
        before = self.item("exercise", id)
        bundle["items"][0]["value"]["name"] += " revised"
        put = self.store.ddb.put_item

        def race(**kwargs):
            raced = {**before, "revision": 2}
            put(TableName=self.tables.catalog, Item=attributes(raced))
            self.assertIn("#r = :r", kwargs["ConditionExpression"])
            self.assertIn("#p = :p", kwargs["ConditionExpression"])
            return put(**kwargs)

        with (
            patch.object(self.store.ddb, "put_item", side_effect=race),
            self.assertRaises(ClientError),
        ):
            import_catalog(self.store.ddb, self.tables.catalog, bundle, apply=True)
        self.assertEqual(self.item("exercise", id)["payload"], before["payload"])

    def test_updating_shared_rows_preserves_private_records_and_historical_snapshots(self):
        bundle = self.bundle()
        import_catalog(self.store.ddb, self.tables.catalog, bundle, apply=True)
        ex_id, food_id = [i["value"]["id"] for i in bundle["items"]]
        ex = self.data(self.call("GET", "/v1/workouts/exercises/" + ex_id))
        food = self.data(self.call("GET", "/v1/nutrition/foods/" + food_id))
        workout, diary = self.session(exercise=ex), self.portion(food=food)
        self.assertEqual({s["side"] for s in workout["exercises"][0]["sets"]}, {"L", "R"})
        custom = self.exercise(name=ex["name"])
        before = {
            table: self.store.ddb.scan(TableName=table)["Items"]
            for table in (self.tables.accounts, self.tables.training, self.tables.nutrition)
        }
        bundle["items"][0]["value"].update(name="Reviewed source exercise", unilateral=False)
        bundle["items"][1]["value"]["per100g"]["calories"] = Decimal("200")
        import_catalog(self.store.ddb, self.tables.catalog, bundle, apply=True)
        after = {table: self.store.ddb.scan(TableName=table)["Items"] for table in before}
        self.assertEqual(before, after)
        self.assertEqual(
            self.data(self.call("GET", "/v1/workouts/sessions/" + workout["id"])), workout
        )
        self.assertEqual(
            self.data(self.call("GET", "/v1/nutrition/diary", query={"date": diary["date"]}))[
                "entries"
            ][0],
            diary,
        )
        self.assertEqual(
            self.data(self.call("GET", "/v1/workouts/exercises/" + custom["id"])), custom
        )
        self.assertEqual(
            self.call(
                "PATCH", "/v1/workouts/exercises/" + ex_id, {"name": "Overwrite"}, rev=2
            ).status,
            403,
        )
        self.assertEqual(
            self.call("GET", "/v1/workouts/sessions/" + workout["id"], p=foundations.B).status, 404
        )
