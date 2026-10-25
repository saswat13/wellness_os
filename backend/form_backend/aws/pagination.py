"""Bounded DynamoDB pages using signed, tenant/query/snapshot-bound continuations."""

import base64
import hashlib
import hmac
from datetime import timedelta

from ..api import API
from ..core import Problem, digest, json_text, load_json
from ..models import Meta, Page, timestamp
from ..repositories import Result
from .dynamo import attributes, component, native, stamp, user


class DynamoAPI(API):
    def _encode(self, data):
        token = base64.urlsafe_b64encode(json_text(data).encode()).decode().rstrip("=")
        return token + "." + hmac.new(self.cursor_key, token.encode(), hashlib.sha256).hexdigest()

    def _decode(self, cursor, scope, snapshot):
        try:
            if len(cursor) > 4096:
                raise ValueError()
            token, mac = cursor.split(".")
            expected = hmac.new(self.cursor_key, token.encode(), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(mac, expected):
                raise ValueError()
            data = load_json(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))
            if data["scope"] != scope or data["exp"] <= self.service.uow.clock().timestamp():
                raise ValueError()
            if data["snapshot"] != snapshot:
                raise Problem(409, "COLLECTION_CHANGED")
            return data
        except (ValueError, TypeError, KeyError):
            raise Problem(400, "INVALID_CURSOR") from None

    def page_result(self, route, params, principal, query, request_id, path):
        limit = int(query.get("limit", "25"))
        if not 1 <= limit <= 100:
            raise Problem(422, "INVALID_LIMIT")
        service, uow = self.service, self.service.uow
        store = uow.store
        kind, op = route.operation.split(":")
        domain = "training" if kind in ("exercise", "template", "session") else "nutrition"
        repo = service.training if domain == "training" else service.nutrition
        scope = digest([principal.subject, path, {k: v for k, v in query.items() if k != "cursor"}])
        revision_kind = "session" if op == "history" else kind
        snapshot = uow.counter(domain, user(principal), "COLLECTION#" + revision_kind)
        cursor = self._decode(query["cursor"], scope, snapshot) if query.get("cursor") else {}
        phase = cursor.get("phase", "custom")
        names = {"#pk": "PK", "#sk": "SK"}
        prefix = kind.upper() + "#"
        pk, table, index = user(principal), getattr(store.tables, domain), None
        if op == "history":
            service.definition(principal, "exercise", params["id"])
            pk, prefix = user(principal) + "#EXERCISE#" + component(params["id"]), "PERFORMANCE#"
        elif op == "active":
            pk, index = user(principal) + "#ACTIVE", "GSI1"
            names = {"#pk": "GSI1PK"}
        elif kind == "session":
            end = (
                timestamp(cursor["end"])
                if cursor
                else (
                    timestamp(query["to"])
                    if "to" in query
                    else uow.clock() + timedelta(milliseconds=1)
                )
            )
            start = (
                timestamp(cursor["start"])
                if cursor
                else (timestamp(query["from"]) if "from" in query else end - timedelta(days=90))
            )
            if start >= end or end - start > timedelta(days=366):
                raise Problem(422, "INVALID_DATE_RANGE")
            cursor.update(start=stamp(start), end=stamp(end))
            pk, index = user(principal) + "#SESSIONS", "GSI1"
            names = {"#pk": "GSI1PK", "#sk": "GSI1SK"}
        elif phase == "catalog":
            if kind not in ("exercise", "food"):
                raise Problem(400, "INVALID_CURSOR")
            pk, prefix, table = "TYPE#" + kind.upper(), "ID#", store.tables.catalog
        values = {":pk": pk}
        expression = "#pk = :pk"
        if index and op == "active":
            pass
        elif index:
            expression += " AND #sk BETWEEN :start AND :end"
            values.update({":start": cursor["start"], ":end": cursor["end"]})
        else:
            expression += " AND begins_with(#sk, :prefix)"
            values[":prefix"] = prefix
        args = dict(
            TableName=table,
            KeyConditionExpression=expression,
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=attributes(values),
            Limit=limit,
            ScanIndexForward=kind != "session" and op != "history",
        )
        if index:
            args["IndexName"] = index
        else:
            args["ConsistentRead"] = True
        if cursor.get("last"):
            last = cursor["last"]
            if last.get("GSI1PK" if index else "PK") != pk:
                raise Problem(400, "INVALID_CURSOR")
            args["ExclusiveStartKey"] = attributes(last)
        response = store.call("query", **args)
        records = []
        for item in response.get("Items", ()):
            row = native(item)
            if row.get("deleted"):
                continue
            if phase == "catalog":
                records.append(service.catalog.decode(kind, row))
            elif op == "history" or kind == "session":
                id = row["sessionId"] if op == "history" else load_json(row["payload"])["id"]
                root = service.training.get(principal, "session", id)
                if op == "active":
                    if root.value.status == "active":
                        records.append(root)
                    continue
                version = root.value.completed_version
                if version and (op != "history" or version == int(row["version"])):
                    record = service.training.get(principal, "workoutVersion", f"{id}:{version}")
                    if not index or timestamp(
                        cursor["start"]
                    ) <= record.value.started_at < timestamp(cursor["end"]):
                        records.append(record)
            else:
                records.append(repo.get(principal, kind, load_json(row["payload"])["id"]))
        if snapshot != uow.counter(domain, user(principal), "COLLECTION#" + revision_kind):
            raise Problem(409, "COLLECTION_CHANGED")
        next_cursor = None
        if response.get("LastEvaluatedKey"):
            cursor["last"] = native(response["LastEvaluatedKey"])
        elif kind in ("exercise", "food") and phase == "custom":
            cursor.update(phase="catalog", last=None)
        else:
            cursor = None
        if cursor is not None:
            cursor.update(scope=scope, snapshot=snapshot, exp=int(uow.clock().timestamp()) + 900)
            next_cursor = self._encode(cursor)
        data = Page[route.read](  # type: ignore[name-defined]  # Runtime response model from versioned registry.
            items=tuple(route.read.model_validate(r.dto()) for r in records),
            next_cursor=next_cursor,
            meta=Meta(request_id=request_id),
        ).model_dump(by_alias=True)
        return Result(200, None), data
