"""Moto-simulated DynamoDB contract tests. No AWS credentials/accounts are used."""

import os
import unittest
from uuid import uuid4

import boto3
import test_foundations as foundations
from botocore.config import Config
from moto import mock_aws
from test_foundations import Clock

from form_backend.aws.dynamo import (
    DynamoAccounts,
    DynamoCatalog,
    DynamoNutrition,
    DynamoTraining,
    DynamoUnitOfWork,
    Store,
    Tables,
    attributes,
    component,
    stamp,
)
from form_backend.aws.pagination import DynamoAPI as API
from form_backend.core import Problem, json_text
from form_backend.models import Exercise, Food, Nutrients
from form_backend.service import Service


class DynamoContract(unittest.TestCase):
    # Run the SAME public API workflows against the AWS adapter as the memory implementation.
    call = foundations.FoundationCase.call
    data = foundations.FoundationCase.data
    exercise = foundations.FoundationCase.exercise
    food = foundations.FoundationCase.food
    session = foundations.FoundationCase.session
    recipe = foundations.FoundationCase.recipe
    portion = foundations.FoundationCase.portion
    finish = foundations.FoundationCase.finish
    edit = foundations.FoundationCase.edit

    def setUp(self):
        endpoint = os.environ.get("FORM_DYNAMODB_LOCAL_URL")
        if endpoint:
            if endpoint != "http://127.0.0.1:8000":
                raise ValueError("Only the explicit loopback DynamoDB Local endpoint is allowed")
        else:
            self.mock = mock_aws()
            self.mock.start()
            self.addCleanup(self.mock.stop)
        self.clock = Clock()
        ddb = boto3.client(
            "dynamodb",
            region_name="us-east-1",
            aws_access_key_id="testing",
            aws_secret_access_key="testing",
            endpoint_url=endpoint,
            config=Config(retries={"max_attempts": 0}),
        )
        self.tables = Tables("accounts", "training", "nutrition", "catalog")
        for name in ("accounts", "training", "nutrition", "catalog"):
            args = dict(
                TableName=name,
                BillingMode="PAY_PER_REQUEST",
                AttributeDefinitions=[
                    {"AttributeName": k, "AttributeType": "S"} for k in ("PK", "SK")
                ],
                KeySchema=[
                    {"AttributeName": "PK", "KeyType": "HASH"},
                    {"AttributeName": "SK", "KeyType": "RANGE"},
                ],
            )
            if name == "training":
                args["AttributeDefinitions"] += [
                    {"AttributeName": k, "AttributeType": "S"} for k in ("GSI1PK", "GSI1SK")
                ]
                args["GlobalSecondaryIndexes"] = [
                    {
                        "IndexName": "GSI1",
                        "KeySchema": [
                            {"AttributeName": "GSI1PK", "KeyType": "HASH"},
                            {"AttributeName": "GSI1SK", "KeyType": "RANGE"},
                        ],
                        "Projection": {"ProjectionType": "ALL"},
                    }
                ]
            ddb.create_table(**args)
            if endpoint:
                self.addCleanup(lambda n=name: ddb.delete_table(TableName=n))
        self.store = Store(ddb, self.tables)
        self.uow = DynamoUnitOfWork(self.store, self.clock)
        self.training, self.nutrition, self.accounts, self.catalog = (
            DynamoTraining(self.uow),
            DynamoNutrition(self.uow),
            DynamoAccounts(self.uow),
            DynamoCatalog(self.store),
        )
        for kind, value in (
            ("exercise", Exercise(id="system-press", name="Mock press", primary_muscle="Chest")),
            (
                "food",
                Food(
                    id="rice-dry",
                    name="Mock rice",
                    preparation="dry",
                    per100g=Nutrients(calories=360, protein=7, carbs=79, fat=0),
                ),
            ),
        ):
            ddb.put_item(
                TableName="catalog",
                Item=attributes(
                    {
                        "PK": "TYPE#" + kind.upper(),
                        "SK": "ID#" + component(value.id),
                        "payload": json_text(value.model_dump()),
                        "revision": 1,
                        "created": stamp(self.clock()),
                        "updated": stamp(self.clock()),
                    }
                ),
            )
        self.service = Service(self.uow, self.training, self.nutrition, self.accounts, self.catalog)
        self.api = API(self.service, b"stable-test-cursor-key")

    def test_query_follows_more_than_one_mebibyte_without_scans(self):
        for start in range(0, 1100, 25):
            self.store.ddb.batch_write_item(
                RequestItems={
                    "catalog": [
                        {
                            "PutRequest": {
                                "Item": attributes(
                                    {
                                        "PK": "TYPE#PAGEFIXTURE",
                                        "SK": str(i).zfill(6),
                                        "payload": "x" * 1024,
                                    }
                                )
                            }
                        }
                        for i in range(start, min(start + 25, 1100))
                    ]
                }
            )
        first = self.store.ddb.query(
            TableName="catalog",
            KeyConditionExpression="PK = :pk",
            ExpressionAttributeValues=attributes({":pk": "TYPE#PAGEFIXTURE"}),
        )
        self.assertIn("LastEvaluatedKey", first)
        rows = tuple(self.store.query("catalog", "TYPE#PAGEFIXTURE", page_size=1000))
        self.assertEqual(len(rows), 1100)
        self.assertNotIn("scan", self.store.calls)

    def test_catalog_outage_cannot_bypass_system_record_write_protection(self):
        original = self.catalog.get
        self.catalog.get = lambda *args: (_ for _ in ()).throw(Problem(503, "CATALOG_UNAVAILABLE"))
        id = str(uuid4())
        response = self.call("POST", "/v1/workouts/exercises", {"id": id, "name": "Blocked"})
        self.assertEqual(response.status, 503)
        self.catalog.get = original
        self.assertEqual(self.call("GET", "/v1/workouts/exercises/" + id).status, 404)

    def test_separate_side_records_and_no_scan(self):
        session = self.session(self.exercise(unilateral=True))
        self.edit(session, "L", kg=23, reps=10, done=True)
        saved = self.data(self.call("GET", "/v1/workouts/sessions/" + session["id"]))
        self.assertEqual([r["done"] for r in saved["exercises"][0]["sets"]], [True, False])
        self.assertNotIn("scan", self.store.calls)
        self.assertIn("transact_write_items", self.store.calls)

    def test_fresh_adapter_recovers_records_and_receipt(self):
        key = str(uuid4())
        body = {"id": str(uuid4()), "name": "Persistent exercise"}
        self.data(self.call("POST", "/v1/workouts/exercises", body, key=key), 201)
        self.uow = DynamoUnitOfWork(self.store, self.clock)
        self.api = API(
            Service(
                self.uow,
                DynamoTraining(self.uow),
                DynamoNutrition(self.uow),
                DynamoAccounts(self.uow),
                DynamoCatalog(self.store),
            ),
            b"stable-test-cursor-key",
        )
        result = self.call("POST", "/v1/workouts/exercises", body, key=key)
        self.assertEqual(result.headers["Idempotency-Replayed"], "true")
        self.data(result, 201)

    def test_failed_publication_does_not_expose_staged_rows(self):
        original = self.store.call

        def fail(operation, **kwargs):
            if operation == "transact_write_items" and any(
                "ConditionCheck" in op for op in kwargs.get("TransactItems", ())
            ):
                raise Problem(503, "SIMULATED_OUTAGE")
            return original(operation, **kwargs)

        ex = self.exercise()
        self.store.call = fail
        body = {
            "id": str(uuid4()),
            "name": "Staged",
            "startedAt": self.clock(),
            "exercises": [{"id": str(uuid4()), "exerciseId": ex["id"]}],
        }
        self.assertEqual(self.call("POST", "/v1/workouts/sessions", body).status, 503)
        self.store.call = original
        self.assertEqual(self.call("GET", "/v1/workouts/sessions/" + body["id"]).status, 404)

    def test_throttle_maps_to_sanitized_retryable_error(self):
        from botocore.stub import Stubber

        with (
            Stubber(self.store.ddb) as stub,
            self.assertLogs("form_backend.aws.dynamo", level="ERROR") as captured,
        ):
            stub.add_client_error(
                "get_item", "ProvisionedThroughputExceededException", "private-table-info"
            )
            with self.assertRaises(Problem) as caught:
                self.store.get("training", "USER#x", "x")
        self.assertEqual(caught.exception.status, 503)
        self.assertNotIn("private-table", str(caught.exception))
        logs = "\n".join(captured.output)
        self.assertIn("operation=get_item", logs)
        self.assertIn("aws_error_code=ProvisionedThroughputExceededException", logs)
        self.assertNotIn("private-table-info", logs)
        self.assertNotIn("USER#x", logs)


# Reuse domain assertions, not implementations; memory-internal assertions intentionally excluded.
WORKFLOWS = [
    "exercise_metadata_archive_stable_id",
    "system_catalog_is_readable_but_not_writable_or_shadowable",
    "template_reorder_does_not_change_session_snapshots",
    "partial_unilateral_is_preserved_and_counts_completed_side_volume",
    "same_weight_shortcut_copies_only_paired_load",
    "toggling_same_weight_does_not_equalize_existing_sides",
    "prefill_uses_corresponding_side_and_never_completes_new_sets",
    "missing_completed_side_is_not_copied_from_partner",
    "whole_pair_add_remove_and_planned_target_is_independent",
    "corrections_retain_old_version_and_latest_history_is_not_duplicated",
    "library_rename_and_mode_change_do_not_rewrite_completed_snapshot",
    "food_edits_cannot_change_existing_diary_nutrients",
    "recipe_yield_and_food_edits_preserve_ingredient_and_diary_versions",
    "diary_move_delete_totals_and_id_reservation",
    "effective_goal_versions_and_same_day_latest",
    "profile_preferences_roundtrip",
    "all_private_resource_reads_and_updates_are_isolated_in_both_directions",
    "foreign_completed_version_cannot_be_read_or_reopened",
    "foreign_nested_references_are_rejected_without_partial_creates",
    "owner_and_snapshot_mass_assignment_are_rejected",
    "foreign_side_id_through_owned_session_is_rejected",
    "retry_after_response_loss_replays_one_commit",
    "identical_ids_and_idempotency_keys_are_scoped_by_user",
    "atomic_batch_rejects_one_bad_side_without_applying_other_edit",
    "cursor_is_bound_to_user_query_expiry_and_revision_snapshot",
    "profile_and_goal_singletons_are_private_and_no_cross_user_override",
    "active_session_edits_cannot_change_template_and_invalid_reorder_is_atomic",
    "large_recipe_listing_paginates_without_missing_or_cross_user_entries",
]
for name in WORKFLOWS:
    setattr(
        DynamoContract,
        "test_" + name,
        next(
            getattr(c, "test_" + name)
            for c in (
                foundations.DomainTests,
                foundations.IsolationAndMutationTests,
                foundations.QueryAndContractTests,
                foundations.AdditionalBoundaryTests,
            )
            if hasattr(c, "test_" + name)
        ),
    )


class DistributedMutationTests(unittest.TestCase):
    def setUp(self):
        DynamoContract.setUp(self)

    def test_two_request_workers_compete_on_revision_without_lost_update(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier, Lock

        from form_backend.core import Principal, json_text

        principal = Principal("user-A")

        def api():
            uow = DynamoUnitOfWork(self.store, self.clock)
            return API(
                Service(
                    uow,
                    DynamoTraining(uow),
                    DynamoNutrition(uow),
                    DynamoAccounts(uow),
                    DynamoCatalog(self.store),
                ),
                b"stable-cursor-key",
            )

        id = str(uuid4())
        result = api().handle(
            "POST",
            "/v1/workouts/exercises",
            principal=principal,
            body=json_text({"id": id, "name": "Original"}),
            headers={"Idempotency-Key": str(uuid4())},
        )
        self.assertEqual(result.status, 201)
        barrier = Barrier(2)
        simulated_commit = Lock()
        call = self.store.call

        def synchronized(operation, **kwargs):
            if operation == "transact_write_items":
                barrier.wait(timeout=10)
                # Moto snapshots/restores whole tables during rollback and is not an
                # atomic concurrent transaction engine. Serialize only its commit step;
                # both independent requests still read revision 1 before this barrier.
                # DynamoDB Local uses its own transaction implementation without this lock.
                if hasattr(self, "mock"):
                    with simulated_commit:
                        return call(operation, **kwargs)
            return call(operation, **kwargs)

        self.store.call = synchronized

        def edit(name):
            return api().handle(
                "PATCH",
                "/v1/workouts/exercises/" + id,
                principal=principal,
                body=json_text({"name": name}),
                headers={"If-Match": '"1"', "Idempotency-Key": str(uuid4())},
            )

        with ThreadPoolExecutor(2) as executor:
            results = list(executor.map(edit, ("Device A", "Device B")))
        self.assertEqual(sorted(r.status for r in results), [200, 412])
        self.store.call = call
        restored = api().handle("GET", "/v1/workouts/exercises/" + id, principal=principal)
        self.assertEqual(restored.body["data"]["revision"], 2)

    def test_set_edit_reuses_draft_but_completed_history_stays_frozen(self):
        # Exercise the delta-write optimization through independent HTTP requests.
        helper = DynamoContract()
        helper.store, helper.clock, helper.api = self.store, self.clock, self.api
        helper.uow, helper.service = self.uow, self.service
        session = helper.session(helper.exercise(unilateral=True))
        from form_backend.core import Principal

        principal = Principal("user-A")
        pk, sk = self.training.key(principal, "session", session["id"])
        before = self.store.get("training", pk, sk)
        edited = helper.edit(session, "L", done=True, reps=9, kg=25)
        after = self.store.get("training", pk, sk)
        self.assertEqual(before["generation"], after["generation"])
        completed = helper.finish(edited)
        frozen = self.store.get("training", pk, sk)
        self.assertNotEqual(frozen["generation"], before["generation"])
        reopened = helper.data(
            helper.call(
                "POST",
                "/v1/workouts/sessions/" + session["id"] + "/reopen",
                rev=completed["revision"],
            )
        )
        helper.edit(reopened, "L", reps=1, kg=1)
        history = self.training.get(principal, "workoutVersion", session["id"] + ":1")
        self.assertEqual(history.value.exercises[0].sets[0].reps, 9)
        self.assertEqual(history.value.exercises[0].sets[0].kg, 25)

    def test_weekly_primary_muscle_volume_reads_headers_only_and_keeps_partial_sides(self):
        from datetime import timedelta

        from form_backend.core import Principal

        helper = DynamoContract()
        helper.store, helper.clock, helper.api = self.store, self.clock, self.api
        helper.uow, helper.service = self.uow, self.service
        workout = helper.session(helper.exercise(unilateral=True))
        finished = helper.finish(helper.edit(workout, "L", kg=25, reps=10, done=True))
        original = self.store.query

        def headers_only(table, pk, *args, **kwargs):
            self.assertNotIn("#GEN#", pk)
            return original(table, pk, *args, **kwargs)

        self.store.query = headers_only
        volume = self.training.weekly_volume(
            Principal("user-A"), self.clock() - timedelta(days=7), self.clock() + timedelta(days=1)
        )
        self.assertEqual(volume["Chest"], 250)
        self.assertEqual(
            self.training.weekly_volume(
                Principal("user-B"),
                self.clock() - timedelta(days=7),
                self.clock() + timedelta(days=1),
            ),
            {},
        )
        self.assertEqual(finished["summary"]["completedGroups"], 0)
