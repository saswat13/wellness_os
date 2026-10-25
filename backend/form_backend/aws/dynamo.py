"""Tenant-scoped DynamoDB adapters; buffered CAS transactions and immutable generations.

A unit of work belongs to ONE request. No process lock is a distributed correctness
mechanism. All private keys derive from Principal; public query cursors are signed by API.
"""

import base64
import logging
import re
import secrets
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from threading import RLock

import boto3
from boto3.dynamodb.types import TypeDeserializer, TypeSerializer
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from ..calculations import decimal_math
from ..core import Principal, Problem, digest, json_text, load_json, utcnow
from ..models import (
    DiaryEntry,
    Exercise,
    Food,
    GoalChange,
    Goals,
    Model,
    Profile,
    Recipe,
    Template,
    Workout,
)
from ..repositories import Record, Result

SER, DES = TypeSerializer(), TypeDeserializer()
logger = logging.getLogger(__name__)
_SAFE_LOG_VALUE = re.compile(r"[A-Za-z0-9_.:-]{1,128}\Z")


def log_storage_failure(operation, exc):
    details = getattr(exc, "response", {})
    error = details.get("Error", {}) if isinstance(details, dict) else {}
    metadata = details.get("ResponseMetadata", {}) if isinstance(details, dict) else {}
    logger.error(
        "dynamodb_failure operation=%s error_type=%s aws_error_code=%s aws_request_id=%s",
        _safe_log_value(operation),
        _safe_log_value(type(exc).__name__),
        _safe_log_value(error.get("Code")),
        _safe_log_value(metadata.get("RequestId")),
    )


def _safe_log_value(value):
    return value if isinstance(value, str) and _SAFE_LOG_VALUE.fullmatch(value) else "unknown"


MODELS: dict[str, type[Model]] = {
    "exercise": Exercise,
    "template": Template,
    "session": Workout,
    "workoutVersion": Workout,
    "food": Food,
    "recipe": Recipe,
    "recipeVersion": Recipe,
    "diary": DiaryEntry,
    "goals": Goals,
    "goalVersion": GoalChange,
    "profile": Profile,
}
DOMAINS = {
    "exercise": "training",
    "template": "training",
    "session": "training",
    "workoutVersion": "training",
    "food": "nutrition",
    "recipe": "nutrition",
    "recipeVersion": "nutrition",
    "diary": "nutrition",
    "goals": "nutrition",
    "goalVersion": "nutrition",
    "profile": "accounts",
}


def component(value):
    return base64.urlsafe_b64encode(value.encode()).decode().rstrip("=")


def user(p):
    if not isinstance(p, Principal) or not p.subject or not p.invited:
        raise Problem(401, "AUTHENTICATION_REQUIRED")
    p.require("form/read")
    return "USER#" + component(p.subject)


def stamp(value):
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def attributes(item):
    return {k: SER.serialize(v) for k, v in item.items()}


def native(item):
    return {k: DES.deserialize(v) for k, v in item.items()}


def client():
    # No custom endpoint or credentials accepted from a request. The Lambda role is used.
    return boto3.client(
        "dynamodb",
        region_name="us-east-1",
        config=Config(
            retries={"mode": "standard", "total_max_attempts": 5},
            connect_timeout=2,
            read_timeout=5,
            max_pool_connections=20,
        ),
    )


@dataclass(frozen=True)
class Tables:
    accounts: str
    training: str
    nutrition: str
    catalog: str


class Store:
    def __init__(self, ddb, tables: Tables):
        self.ddb, self.tables = ddb, tables
        self.calls: deque[str] = deque(
            maxlen=256
        )  # Operation names only; never payloads or credentials.

    def call(self, operation, **kwargs):
        self.calls.append(operation)
        try:
            return getattr(self.ddb, operation)(**kwargs)
        except self.ddb.exceptions.ConditionalCheckFailedException:
            raise Problem(412, "REVISION_CONFLICT") from None
        except self.ddb.exceptions.TransactionCanceledException as exc:
            reasons = exc.response.get("CancellationReasons", ())
            if any(r.get("Code") == "ConditionalCheckFailed" for r in reasons):
                raise Problem(412, "REVISION_CONFLICT") from None
            log_storage_failure(operation, exc)
            raise Problem(503, "STORAGE_RETRY_REQUIRED") from None
        except (ClientError, BotoCoreError) as exc:
            # SDK retries bounded throttling/transport faults. Never expose AWS messages/keys.
            log_storage_failure(operation, exc)
            raise Problem(503, "STORAGE_UNAVAILABLE") from None

    def get(self, table, pk, sk):
        result = self.call(
            "get_item", TableName=table, Key=attributes({"PK": pk, "SK": sk}), ConsistentRead=True
        )
        return native(result["Item"]) if "Item" in result else None

    def query(
        self,
        table,
        pk,
        prefix="",
        *,
        start=None,
        end=None,
        reverse=False,
        index=None,
        page_size=100,
    ):
        values = {":pk": pk}
        names = {"#pk": "GSI1PK" if index else "PK", "#sk": "GSI1SK" if index else "SK"}
        expression = "#pk = :pk"
        if start is not None:
            expression += " AND #sk BETWEEN :start AND :end"
            values.update({":start": start, ":end": end})
        elif prefix:
            expression += " AND begins_with(#sk, :prefix)"
            values[":prefix"] = prefix
        else:
            names.pop("#sk")
        args = dict(
            TableName=table,
            KeyConditionExpression=expression,
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=attributes(values),
            ScanIndexForward=not reverse,
            Limit=page_size,
        )
        if index:
            args["IndexName"] = index
        else:
            args["ConsistentRead"] = True
        # Paginator follows every LastEvaluatedKey, including >1 MiB collections.
        self.calls.append("query")
        try:
            for page in self.ddb.get_paginator("query").paginate(**args):
                yield from (native(row) for row in page.get("Items", ()))
        except (ClientError, BotoCoreError) as exc:
            log_storage_failure("query", exc)
            raise Problem(503, "STORAGE_UNAVAILABLE") from None

    def stage(self, rows):
        # Immutable, unreachable generation rows. A failed commit may leave orphans;
        # they have no TTL (TTL must never delete published historical sets).
        for offset in range(0, len(rows), 40):
            ops = [
                {
                    "Put": {
                        "TableName": table,
                        "Item": attributes(item),
                        "ConditionExpression": "attribute_not_exists(PK)",
                    }
                }
                for table, item in rows[offset : offset + 40]
            ]
            self.call(
                "transact_write_items", TransactItems=ops, ClientRequestToken=secrets.token_hex(16)
            )


class DayRevisions:
    def __init__(self, uow):
        self.uow = uow

    def get(self, key, default=0):
        subject, day = key
        return self.uow.counter("nutrition", user(Principal(subject)), "DAYREV#" + str(day))


class DynamoUnitOfWork:
    def __init__(self, store, clock=utcnow):
        self.store, self.clock, self.lock = store, clock, RLock()
        self.day_revisions = DayRevisions(self)
        self.pending, self.reads = {}, {}
        self.in_mutation = False
        self.generation_cache = {}

    def subject(self, p):
        user(p)
        status = self.read("accounts", user(p), "STATUS")
        if status and status.get("disabled"):
            raise Problem(403, "ACCOUNT_DISABLED")
        return p.subject

    def read(self, domain, pk, sk):
        key = (domain, pk, sk)
        if key in self.pending:
            return self.pending[key]
        row = self.store.get(getattr(self.store.tables, domain), pk, sk)
        if self.in_mutation:
            # Retain the first observed revision, detect non-repeatable reads.
            if key in self.reads and self.reads[key] != row:
                raise Problem(412, "REVISION_CONFLICT")
            self.reads[key] = row
        return row

    def counter(self, domain, pk, sk):
        row = self.read(domain, pk, sk)
        return int(row["revision"]) if row else 0

    def bump(self, domain, pk, sk):
        old = self.counter(domain, pk, sk)
        self.pending[(domain, pk, sk)] = {"PK": pk, "SK": sk, "revision": old + 1}

    def write(self, domain, row):
        if not self.in_mutation:
            raise RuntimeError("Writes require a durable mutation transaction")
        key = (domain, row["PK"], row["SK"])
        if key not in self.reads:
            self.read(domain, row["PK"], row["SK"])
        self.pending[key] = row

    def mutate(self, p, domain, method, path, key, body, expected, action):
        p.require("form/write")
        self.subject(p)
        domain = "training" if domain == "workouts" else domain
        pk = user(p)
        receipt_sk = "IDEM#" + digest([method, path, key])
        fingerprint = digest({"body": body, "expected": expected})

        def replay():
            old = self.store.get(getattr(self.store.tables, domain), pk, receipt_sk)
            if not old:
                return None
            if old["fingerprint"] != fingerprint:
                raise Problem(409, "IDEMPOTENCY_KEY_REUSED")
            saved = load_json(old["response"])
            return Result(int(saved["status"]), saved["data"], saved["revision"], True)

        cached = replay()
        if cached:
            return cached
        self.pending, self.reads, self.generation_cache = {}, {}, {}
        self.in_mutation = True
        try:
            self.subject(p)  # Account enabled condition participates in the commit.
            result = action()
            response = json_text(
                {"status": result.status, "data": result.data, "revision": result.revision}
            )
            if len(response.encode()) > 350_000:
                raise Problem(413, "MUTATION_RESULT_TOO_LARGE")
            receipt = {
                "PK": pk,
                "SK": receipt_sk,
                "revision": 1,
                "fingerprint": fingerprint,
                "response": response,
            }
            # Retain receipts without TTL: arbitrary late retries cannot duplicate entries.
            self.reads[(domain, pk, receipt_sk)] = None
            self.pending[(domain, pk, receipt_sk)] = receipt
            ops = []
            for (d, rpk, rsk), old in self.reads.items():
                condition = "attribute_not_exists(PK)" if old is None else "#r = :r"
                args = {
                    "TableName": getattr(self.store.tables, d),
                    "ConditionExpression": condition,
                }
                if old:
                    args.update(
                        ExpressionAttributeNames={"#r": "revision"},
                        ExpressionAttributeValues=attributes({":r": old["revision"]}),
                    )
                pending = self.pending.get((d, rpk, rsk))
                if pending:
                    if len(json_text(pending).encode()) > 350_000:
                        raise Problem(413, "ITEM_TOO_LARGE")
                    args["Item"] = attributes(pending)
                    ops.append({"Put": args})
                else:
                    args["Key"] = attributes({"PK": rpk, "SK": rsk})
                    ops.append({"ConditionCheck": args})
            if len(ops) > 100 or len(json_text(ops).encode()) > 3_500_000:
                raise Problem(413, "TRANSACTION_TOO_LARGE")
            try:
                self.store.call(
                    "transact_write_items",
                    TransactItems=ops,
                    ClientRequestToken=secrets.token_hex(16),
                )
            except Problem:
                cached = replay()  # Includes response-loss/competing identical request.
                if cached:
                    return cached
                raise
            return result
        finally:
            self.in_mutation = False
            self.pending, self.reads, self.generation_cache = {}, {}, {}


def entity_key(p, kind, id):
    pk = user(p)
    if kind in ("recipeVersion", "workoutVersion"):
        parent, version = id.rsplit(":", 1)
        root = "RECIPE" if kind == "recipeVersion" else "SESSION"
        return pk + "#" + root + "#" + component(parent), "VERSION#" + version.zfill(12)
    return pk, kind.upper() + "#" + component(id)


class DynamoRepository:
    def __init__(self, uow, domain, kinds):
        self.uow, self.domain, self.kinds = uow, domain, frozenset(kinds)

    def key(self, p, kind, id):
        self.uow.subject(p)
        if kind not in self.kinds:
            raise Problem(404, "NOT_FOUND")
        return entity_key(p, kind, id)

    def decode(self, p, row):
        if not row or row.get("deleted"):
            raise Problem(404, "NOT_FOUND")
        if row.get("owner") != p.subject or row["kind"] not in self.kinds:
            raise Problem(500, "CORRUPT_RECORD")
        payload = load_json(row["payload"])
        if row.get("generation"):
            payload = self._workout(p, row)
        value = MODELS[row["kind"]].model_validate(payload)
        return Record(
            value,
            int(row["revision"]),
            datetime.fromisoformat(row["created"]),
            datetime.fromisoformat(row["updated"]),
            p.subject,
        )

    def get(self, p, kind, id):
        pk, sk = self.key(p, kind, id)
        return self.decode(p, self.uow.read(self.domain, pk, sk))

    def list(self, p, kind):
        self.key(p, kind, "")
        # Guard list membership in source-resolution transactions.
        self.uow.counter(self.domain, user(p), "COLLECTION#" + kind)
        rows = self.uow.store.query(
            getattr(self.uow.store.tables, self.domain), user(p), kind.upper() + "#"
        )
        records = []
        for row in rows:
            if not row.get("deleted"):
                records.append(self.get(p, kind, load_json(row["payload"])["id"]))
        return tuple(records)

    def put(self, p, kind, value, expected, *, storage_id=None):
        p.require("form/write")
        value = MODELS[kind].model_validate(value.model_dump())
        pk, sk = self.key(p, kind, storage_id or value.id)
        old = self.uow.read(self.domain, pk, sk)
        if old and old.get("deleted"):
            raise Problem(409, "ID_EXISTS")
        if old and kind.endswith("Version"):
            raise Problem(409, "IMMUTABLE_HISTORY")
        if old is None and expected:
            raise Problem(404, "NOT_FOUND")
        if old and int(old["revision"]) != expected:
            raise Problem(
                409 if expected == 0 else 412, "ID_EXISTS" if expected == 0 else "REVISION_CONFLICT"
            )
        now = stamp(self.uow.clock())
        row = {
            "PK": pk,
            "SK": sk,
            "owner": p.subject,
            "kind": kind,
            "revision": expected + 1,
            "created": old["created"] if old else now,
            "updated": now,
            "payload": json_text(value.model_dump()),
        }
        if isinstance(value, Workout):
            if value.status == "completed" and value.summary is None:
                raise Problem(422, "WORKOUT_SUMMARY_REQUIRED")
            generation = self._stage_workout(p, value, old)
            row["generation"] = generation
            row["payload"] = json_text(value.model_dump(exclude={"exercises"}))
            if kind == "session":
                pointer = {
                    "PK": user(p),
                    "SK": "ACTIVE#" + component(value.id),
                    "owner": p.subject,
                    "revision": expected + 1,
                    "payload": json_text({"id": value.id}),
                }
                if value.status == "active":
                    pointer.update(
                        GSI1PK=user(p) + "#ACTIVE",
                        GSI1SK=stamp(value.started_at) + "#" + component(value.id),
                    )
                self.uow.write("training", pointer)
                # Keep published pointer when reopening an editable draft.
                row["published"] = (
                    generation if value.status == "completed" else (old or {}).get("published")
                )
                row["publishedSummary"] = (
                    json_text(
                        {
                            "volumeKgReps": value.summary.volume_kg_reps,
                            "primaryMuscleVolumeKgReps": value.summary.primary_muscle_volume_kg_reps,
                        }
                    )
                    if value.status == "completed" and value.summary is not None
                    else (old or {}).get("publishedSummary")
                )
                if row["published"]:
                    row.update(
                        GSI1PK=user(p) + "#SESSIONS",
                        GSI1SK=stamp(value.started_at) + "#" + component(value.id),
                    )
            if kind == "workoutVersion":
                for exercise_id in {e.exercise_id for e in value.exercises}:
                    self.uow.write(
                        "training",
                        {
                            "PK": user(p) + "#EXERCISE#" + component(exercise_id),
                            "SK": "PERFORMANCE#"
                            + stamp(value.started_at)
                            + "#"
                            + component(value.id),
                            "revision": value.completed_version,
                            "sessionId": value.id,
                            "version": value.completed_version,
                        },
                    )
        self.uow.write(self.domain, row)
        self.uow.bump(self.domain, user(p), "COLLECTION#" + kind)
        if kind == "diary":
            if old:
                before = load_json(old["payload"])["date"]
                self._diary_index(p, before, value.id, None)
            self._diary_index(p, str(value.date), value.id, row)
        return Record(
            value, expected + 1, datetime.fromisoformat(row["created"]), self.uow.clock(), p.subject
        )

    def delete(self, p, kind, id, expected):
        p.require("form/write")
        if kind.endswith("Version") or kind != "diary":
            raise Problem(409, "IMMUTABLE_HISTORY")
        old = self.get(p, kind, id)
        if old.revision != expected:
            raise Problem(412, "REVISION_CONFLICT")
        pk, sk = self.key(p, kind, id)
        self.uow.write(
            self.domain,
            {"PK": pk, "SK": sk, "revision": expected + 1, "deleted": True, "owner": p.subject},
        )
        self.uow.bump(self.domain, user(p), "COLLECTION#" + kind)
        self._diary_index(p, str(old.value.date), id, None)

    def _diary_index(self, p, day, id, row):
        pk = user(p) + "#MONTH#" + day[:7]
        sk = "DAY#" + day + "#ENTRY#" + component(id)
        revision = self.uow.counter("nutrition", pk, sk) + 1
        self.uow.write(
            "nutrition",
            {"PK": pk, "SK": sk, "revision": revision, "id": id, "deleted": row is None},
        )
        self.uow.bump("nutrition", user(p), "DAYREV#" + day)

    def _stage_workout(self, p, value, old=None):
        checksum = digest(value.model_dump())
        if checksum in self.uow.generation_cache:
            return self.uow.generation_cache[checksum]
        editing_draft = (
            old and value.status == "active" and load_json(old["payload"])["status"] == "active"
        )
        generation = old["generation"] if editing_draft else secrets.token_hex(16)
        pk = user(p) + "#SESSION#" + component(value.id) + "#GEN#" + generation
        metadata = value.model_dump(exclude={"exercises"})
        metadata["entryOrder"] = [e.id for e in value.exercises]
        rows = [
            (
                self.uow.store.tables.training,
                {"PK": pk, "SK": "META", "payload": json_text(metadata)},
            )
        ]
        for entry in value.exercises:
            data = entry.model_dump(exclude={"sets"})
            data["setOrder"] = [r.id for r in entry.sets]
            rows.append(
                (
                    self.uow.store.tables.training,
                    {"PK": pk, "SK": "ENTRY#" + component(entry.id), "payload": json_text(data)},
                )
            )
            for row in entry.sets:
                rows.append(
                    (
                        self.uow.store.tables.training,
                        {
                            "PK": pk,
                            "SK": "SET#"
                            + component(entry.id)
                            + "#"
                            + component(row.group_id)
                            + "#"
                            + row.side,
                            "payload": json_text(row.model_dump()),
                        },
                    )
                )
        if len(rows) > 2500:
            raise Problem(413, "WORKOUT_TOO_LARGE")
        if editing_draft:
            # Mutate ONLY changed draft rows, in the SAME transaction as root CAS and receipt.
            # Frozen completed generations are never used for editable drafts.
            existing = {
                r["SK"]: r for r in self.uow.store.query(self.uow.store.tables.training, pk)
            }
            wanted = {r["SK"]: r for _, r in rows}
            for sk, part in wanted.items():
                prior = existing.get(sk)
                if prior and prior.get("payload") == part["payload"] and not prior.get("deleted"):
                    continue
                part["revision"] = int(prior["revision"]) + 1 if prior else 1
                self.uow.write("training", part)
            for sk, prior in existing.items():
                if sk not in wanted and not prior.get("deleted"):
                    self.uow.write(
                        "training",
                        {
                            "PK": pk,
                            "SK": sk,
                            "revision": int(prior["revision"]) + 1,
                            "deleted": True,
                        },
                    )
        else:
            for _, part in rows:
                part["revision"] = 1
            self.uow.store.stage(rows)
        self.uow.generation_cache[checksum] = generation
        return generation

    def _workout(self, p, row):
        base = load_json(row["payload"])
        pk = user(p) + "#SESSION#" + component(base["id"]) + "#GEN#" + row["generation"]
        rows = tuple(self.uow.store.query(self.uow.store.tables.training, pk))
        parts = {r["SK"]: load_json(r["payload"]) for r in rows if not r.get("deleted")}
        if base["status"] == "active":
            current = self.uow.read(self.domain, row["PK"], row["SK"])
            if (
                not current
                or current["revision"] != row["revision"]
                or current.get("generation") != row["generation"]
            ):
                raise Problem(503, "SNAPSHOT_CHANGED_RETRY")
        meta = parts.get("META")
        if meta is None:
            raise Problem(500, "CORRUPT_RECORD")
        exercises = []
        for id in meta.pop("entryOrder"):
            entry = parts["ENTRY#" + component(id)]
            sets = {
                v["id"]: v for k, v in parts.items() if k.startswith("SET#" + component(id) + "#")
            }
            entry["sets"] = [sets[r] for r in entry.pop("setOrder")]
            exercises.append(entry)
        return {**meta, "exercises": exercises}


class DynamoTraining(DynamoRepository):
    def __init__(self, uow):
        super().__init__(uow, "training", ("exercise", "template", "session", "workoutVersion"))

    def workouts_between(self, p, start, end):
        self.uow.subject(p)
        result = []
        for row in self.uow.store.query(
            self.uow.store.tables.training,
            user(p) + "#SESSIONS",
            start=stamp(start),
            end=stamp(end),
            reverse=True,
            index="GSI1",
        ):
            id = load_json(row["payload"])["id"]
            current = self.get(p, "session", id)
            if current.value.completed_version:
                record = self.get(p, "workoutVersion", f"{id}:{current.value.completed_version}")
                if start <= record.value.started_at < end:
                    result.append(record)
        return tuple(result)

    @decimal_math
    def weekly_volume(self, p, start, end):
        """Primary-muscle reporting reads bounded date headers, never lifetime set rows."""
        self.uow.subject(p)
        volume: dict[str, Decimal] = {}
        for indexed in self.uow.store.query(
            self.uow.store.tables.training,
            user(p) + "#SESSIONS",
            start=stamp(start),
            end=stamp(end),
            index="GSI1",
        ):
            row = self.uow.read("training", user(p), indexed["SK"])
            if not row or row.get("owner") != p.subject or not row.get("publishedSummary"):
                continue
            root = load_json(row["payload"])
            if root["mock"] or not start <= datetime.fromisoformat(root["started_at"]) < end:
                continue
            summary = load_json(row["publishedSummary"])
            for muscle, amount in summary["primaryMuscleVolumeKgReps"].items():
                volume[muscle] = volume.get(muscle, Decimal(0)) + amount
        return volume

    def active_workouts(self, p):
        self.uow.subject(p)
        result = []
        for row in self.uow.store.query(
            self.uow.store.tables.training, user(p) + "#ACTIVE", index="GSI1"
        ):
            root = self.get(p, "session", load_json(row["payload"])["id"])
            if root.value.status == "active":
                result.append(root)
        return tuple(result)

    def performances(self, p, exercise_id, limit=5):
        self.uow.subject(p)
        result = []
        for row in self.uow.store.query(
            self.uow.store.tables.training,
            user(p) + "#EXERCISE#" + component(exercise_id),
            "PERFORMANCE#",
            reverse=True,
        ):
            id = row["sessionId"]
            root = self.get(p, "session", id)
            if root.value.completed_version == int(row["version"]):
                result.append(self.get(p, "workoutVersion", f"{id}:{row['version']}"))
                if limit is not None and len(result) >= limit:
                    break
        return tuple(result)


class DynamoNutrition(DynamoRepository):
    def __init__(self, uow):
        super().__init__(
            uow, "nutrition", ("food", "recipe", "recipeVersion", "diary", "goals", "goalVersion")
        )

    def list(self, p, kind):
        if kind not in ("recipeVersion", "goalVersion"):
            return super().list(p, kind)
        if kind == "recipeVersion":
            raise Problem(400, "PARENT_REQUIRED")
        # Goal versions are keyed by owned singleton parent, rather than scanning all records.
        rows = self.uow.store.query(self.uow.store.tables.nutrition, user(p), "GOALVERSION#")
        return tuple(self.decode(p, row) for row in rows)

    def diary_day(self, p, day):
        self.uow.subject(p)
        before = self.uow.counter("nutrition", user(p), "DAYREV#" + str(day))
        rows = self.uow.store.query(
            self.uow.store.tables.nutrition,
            user(p) + "#MONTH#" + str(day)[:7],
            "DAY#" + str(day) + "#ENTRY#",
        )
        entries = tuple(self.get(p, "diary", row["id"]) for row in rows if not row.get("deleted"))
        after = self.uow.counter("nutrition", user(p), "DAYREV#" + str(day))
        if before != after:
            raise Problem(503, "SNAPSHOT_CHANGED_RETRY")
        return entries


class DynamoAccounts(DynamoRepository):
    def __init__(self, uow):
        super().__init__(uow, "accounts", ("profile",))

    def enabled(self, p):
        self.uow.subject(p)
        return True


class DynamoCatalog:
    def __init__(self, store):
        self.store = store

    def decode(self, kind, row):
        if kind not in ("exercise", "food") or row is None:
            raise Problem(404, "NOT_FOUND")
        value = MODELS[kind].model_validate(load_json(row["payload"]))
        return Record(
            value,
            int(row["revision"]),
            datetime.fromisoformat(row["created"]),
            datetime.fromisoformat(row["updated"]),
            None,
        )

    def get(self, kind, id):
        return self.decode(
            kind,
            self.store.get(
                self.store.tables.catalog, "TYPE#" + kind.upper(), "ID#" + component(id)
            ),
        )

    def list(self, kind):
        return tuple(
            self.decode(kind, row)
            for row in self.store.query(self.store.tables.catalog, "TYPE#" + kind.upper(), "ID#")
        )
