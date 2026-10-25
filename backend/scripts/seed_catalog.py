"""Validate/dry-run the launch catalog, or explicitly seed an existing table.

Default: offline validation only. --local uses isolated Moto with literal fake
credentials. Live --apply requires explicit table/account/profile confirmation.
Never deploys, creates live resources, deletes rows or changes IAM/user data.
"""

import argparse
import json
import os
from contextlib import nullcontext
from unittest.mock import patch

from form_backend.catalog import BUNDLE, import_catalog, load_bundle, validate_bundle


def verify_local_api(ddb, tables):
    from form_backend.aws.dynamo import (
        DynamoAccounts,
        DynamoCatalog,
        DynamoNutrition,
        DynamoTraining,
        DynamoUnitOfWork,
        Store,
    )
    from form_backend.aws.pagination import DynamoAPI
    from form_backend.core import Principal
    from form_backend.service import Service

    store = Store(ddb, tables)
    counts = {}
    for kind, path in (("exercise", "/v1/workouts/exercises"), ("food", "/v1/nutrition/foods")):
        cursor, seen, total = None, set(), 0
        while True:
            uow = DynamoUnitOfWork(store)
            api = DynamoAPI(
                Service(
                    uow,
                    DynamoTraining(uow),
                    DynamoNutrition(uow),
                    DynamoAccounts(uow),
                    DynamoCatalog(store),
                ),
                b"local-catalog-validation",
            )
            query = {"limit": "100", **({"cursor": cursor} if cursor else {})}
            result = api.handle("GET", path, principal=Principal("catalog-test-user"), query=query)
            if result.status != 200:
                raise ValueError(f"Application API validation failed: {result.status}")
            for item in result.body["items"]:
                if (
                    item["ownerSub"] is not None
                    or item["source"] != "system"
                    or not item["externalId"]
                ):
                    raise ValueError("API lost shared ownership or provenance")
                if item["id"] in seen:
                    raise ValueError("API returned duplicate IDs")
                seen.add(item["id"])
                total += 1
            cursor = result.body["nextCursor"]
            if not cursor:
                break
        counts[kind] = total
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", default=str(BUNDLE))
    parser.add_argument("--local", action="store_true", help="Isolated Moto; no real AWS calls")
    parser.add_argument("--table", help="Existing catalog table; never inferred from environment")
    parser.add_argument("--profile")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--expected-account")
    parser.add_argument("--confirm-table")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    bundle = load_bundle(args.bundle)
    records = validate_bundle(bundle)
    if not args.local and not args.table:
        if args.apply:
            parser.error("--apply requires an explicit target")
        print(
            json.dumps(
                {
                    "mode": "offline-validation",
                    "exercise": sum(k == "exercise" for k, _ in records),
                    "food": sum(k == "food" for k, _ in records),
                    "awsCalls": 0,
                }
            )
        )
        return
    if args.local and any((args.table, args.profile, args.expected_account, args.confirm_table)):
        parser.error("--local cannot be combined with live target/identity options")
    if (
        not args.local
        and args.apply
        and (not args.profile or not args.expected_account or args.confirm_table != args.table)
    ):
        parser.error(
            "Live --apply requires --profile, --expected-account and matching --confirm-table"
        )
    import boto3

    if args.local:
        from moto import mock_aws

        scope = mock_aws()
    else:
        scope = nullcontext()
    with scope, patch.dict(os.environ) if args.local else nullcontext():
        if args.local:
            os.environ.pop("AWS_PROFILE", None)
            os.environ.pop("AWS_DEFAULT_PROFILE", None)
            from form_backend.aws.dynamo import Tables

            session = boto3.Session(
                region_name=args.region,
                aws_access_key_id="testing",
                aws_secret_access_key="testing",
            )
            tables = Tables("local-accounts", "local-training", "local-nutrition", "local-catalog")
            ddb = session.client("dynamodb")
            for table in vars(tables).values():
                ddb.create_table(
                    TableName=table,
                    BillingMode="PAY_PER_REQUEST",
                    AttributeDefinitions=[
                        {"AttributeName": k, "AttributeType": "S"} for k in ("PK", "SK")
                    ],
                    KeySchema=[
                        {"AttributeName": "PK", "KeyType": "HASH"},
                        {"AttributeName": "SK", "KeyType": "RANGE"},
                    ],
                )
            table = tables.catalog
        else:
            session = boto3.Session(profile_name=args.profile, region_name=args.region)
            if (
                args.apply
                and session.client("sts").get_caller_identity()["Account"] != args.expected_account
            ):
                parser.error("AWS account mismatch; no writes performed")
            ddb = session.client("dynamodb")
            table = args.table
        result = import_catalog(ddb, table, bundle, apply=args.apply)
        if args.local and args.apply:
            result["repeatImport"] = import_catalog(ddb, table, bundle, apply=True)
            result["applicationApiCounts"] = verify_local_api(ddb, tables)
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
