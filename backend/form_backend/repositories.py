"""Replaceable ownership-scoped repositories and an atomic local unit of work.

Locks/rollback model process-local semantics only, NOT a DynamoDB transaction implementation.
"""

from bisect import bisect_left, insort
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from threading import RLock
from typing import Any, Callable, Generic, Protocol, TypeVar

from .core import Principal, Problem, digest, utcnow
from .models import Exercise, Food, Model

RecordModel = TypeVar("RecordModel", bound=Model, default=Any)


@dataclass(frozen=True)
class Record(Generic[RecordModel]):
    value: RecordModel
    revision: int
    created_at: datetime
    updated_at: datetime
    owner_sub: str | None

    def dto(self):
        source = (
            {"source": "system" if self.owner_sub is None else "custom"}
            if isinstance(self.value, (Exercise, Food))
            else {}
        )
        return {
            **source,
            **self.value.model_dump(by_alias=True),
            "ownerSub": self.owner_sub,
            "revision": self.revision,
            "schemaVersion": 1,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


class Repository(Protocol):
    def get(self, principal: Principal, kind: str, id: str) -> Record: ...
    def list(self, principal: Principal, kind: str) -> tuple[Record, ...]: ...
    def put(
        self,
        principal: Principal,
        kind: str,
        value: Model,
        expected: int,
        *,
        storage_id: str | None = None,
    ) -> Record: ...
    def delete(self, principal: Principal, kind: str, id: str, expected: int) -> None: ...


class TrainingRepository(Repository, Protocol):
    def active_workouts(self, principal: Principal) -> tuple[Record, ...]: ...

    def workouts_between(
        self, principal: Principal, start: datetime, end: datetime
    ) -> tuple[Record, ...]: ...
    def performances(
        self, principal: Principal, exercise_id: str, limit: int | None
    ) -> tuple[Record, ...]: ...


class NutritionRepository(Repository, Protocol):
    def diary_day(self, principal: Principal, day) -> tuple[Record, ...]: ...


class AccountsRepository(Repository, Protocol):
    def enabled(self, principal: Principal) -> bool: ...


class CatalogRepository(Protocol):
    def get(self, kind: str, id: str) -> Record: ...
    def list(self, kind: str) -> tuple[Record, ...]: ...


@dataclass(frozen=True)
class Result:
    status: int
    data: object
    revision: int | None = None
    replayed: bool = False


class MemoryUnitOfWork:
    def __init__(self, clock=utcnow):
        self.clock = clock
        self.lock = RLock()
        self.records = {}
        self.receipts = {}
        self.deleted = set()
        self.disabled = set()
        self.indexes = {}
        self.day_revisions = {}
        self.collection_revisions = {}

    def subject(self, principal):
        if not isinstance(principal, Principal) or not principal.subject or not principal.invited:
            raise Problem(401, "AUTHENTICATION_REQUIRED")
        if principal.subject in self.disabled:
            raise Problem(403, "ACCOUNT_DISABLED")
        return principal.subject

    def mutate(self, principal, domain, method, path, key, body, expected, action: Callable):
        principal.require("form/write")
        if not key:
            raise Problem(400, "IDEMPOTENCY_KEY_REQUIRED")
        # Include precondition in fingerprint but NOT receipt lookup key.
        token = (domain, self.subject(principal), method, path, key)
        fingerprint = digest({"body": body, "expected": expected})
        with self.lock:
            if token in self.receipts:
                old_hash, result = self.receipts[token]
                if old_hash != fingerprint:
                    raise Problem(409, "IDEMPOTENCY_KEY_REUSED")
                return Result(result.status, deepcopy(result.data), result.revision, True)
            backup = deepcopy(
                (
                    self.records,
                    self.deleted,
                    self.indexes,
                    self.day_revisions,
                    self.collection_revisions,
                )
            )
            try:
                result = action()
            except BaseException:
                (
                    self.records,
                    self.deleted,
                    self.indexes,
                    self.day_revisions,
                    self.collection_revisions,
                ) = backup
                raise
            # Same critical section as domain commit: response-loss replay cannot double-apply.
            self.receipts[token] = (fingerprint, deepcopy(result))
            return deepcopy(result)


class MemoryRepository:
    def __init__(self, uow, domain, kinds):
        self.uow, self.domain, self.kinds = uow, domain, frozenset(kinds)

    def key(self, p, kind, id):
        if kind not in self.kinds:
            raise Problem(404, "NOT_FOUND")
        return self.domain, self.uow.subject(p), kind, id

    def get(self, p, kind, id):
        with self.uow.lock:
            record = self.uow.records.get(self.key(p, kind, id))
            if record is None:
                raise Problem(404, "NOT_FOUND")
            return deepcopy(record)

    def list(self, p, kind):
        with self.uow.lock:
            prefix = self.key(p, kind, "")[:3]
            ids = self.uow.indexes.get(("entities", *prefix), ())
            return tuple(deepcopy(self.uow.records[(*prefix, id)]) for id in ids)

    def put(self, p, kind, value, expected, *, storage_id=None):
        with self.uow.lock:
            key = self.key(p, kind, storage_id or value.id)
            old = self.uow.records.get(key)
            if key in self.uow.deleted:
                raise Problem(409, "ID_EXISTS")
            if old and kind.endswith("Version"):
                raise Problem(409, "IMMUTABLE_HISTORY")
            if old is None and expected != 0:
                raise Problem(404, "NOT_FOUND")
            if old and expected == 0 and kind not in ("goals",):
                raise Problem(409, "ID_EXISTS")
            if old and old.revision != expected:
                raise Problem(412, "REVISION_CONFLICT")
            now = self.uow.clock()
            record = Record(
                deepcopy(value), expected + 1, old.created_at if old else now, now, p.subject
            )
            if old is None:
                insort(self.uow.indexes.setdefault(("entities", *key[:3]), []), key[3])
            self.uow.records[key] = record
            return deepcopy(record)

    def delete(self, p, kind, id, expected):
        with self.uow.lock:
            old = self.get(p, kind, id)
            if kind.endswith("Version"):
                raise Problem(409, "IMMUTABLE_HISTORY")
            if old.revision != expected:
                raise Problem(412, "REVISION_CONFLICT")
            key = self.key(p, kind, id)
            self.uow.indexes[("entities", *key[:3])].remove(key[3])
            del self.uow.records[key]
            self.uow.deleted.add(key)


class MemoryTraining(MemoryRepository):
    def __init__(self, uow):
        super().__init__(uow, "training", ("exercise", "template", "session", "workoutVersion"))
        self.last_query_reads = 0

    def put(self, p, kind, value, expected, *, storage_id=None):
        with self.uow.lock:
            record = super().put(p, kind, value, expected, storage_id=storage_id)
            if kind == "session":
                active = self.uow.indexes.setdefault(("active", p.subject), [])
                if value.id in active:
                    active.remove(value.id)
                if value.status == "active":
                    insort(active, value.id)
            if kind == "workoutVersion":
                session_id = value.id
                refs = [("workouts", p.subject)] + [
                    ("exercise", p.subject, ex) for ex in {e.exercise_id for e in value.exercises}
                ]
                for index in refs:
                    rows = self.uow.indexes.setdefault(index, [])
                    # One current completed performance per logical workout, not per correction.
                    rows[:] = [r for r in rows if r[1] != session_id]
                    insort(rows, (value.started_at, session_id, storage_id or value.id))
            return record

    def active_workouts(self, p):
        with self.uow.lock:
            self.uow.subject(p)
            return tuple(
                self.get(p, "session", id) for id in self.uow.indexes.get(("active", p.subject), ())
            )

    def _between(self, p, index, start, end, limit=None):
        self.uow.subject(p)
        with self.uow.lock:
            rows = self.uow.indexes.get(index, [])
            chosen = rows[bisect_left(rows, (start,)) : bisect_left(rows, (end,))]
            chosen = list(reversed(chosen))
            if limit:
                chosen = chosen[:limit]
            self.last_query_reads = len(chosen)
            return tuple(self.get(p, "workoutVersion", r[2]) for r in chosen)

    def workouts_between(self, p, start, end):
        return self._between(p, ("workouts", p.subject), start, end)

    def performances(self, p, exercise_id, limit=5):
        from datetime import timezone

        return self._between(
            p,
            ("exercise", p.subject, exercise_id),
            datetime.min.replace(tzinfo=timezone.utc),
            datetime.max.replace(tzinfo=timezone.utc),
            limit,
        )


class MemoryNutrition(MemoryRepository):
    def __init__(self, uow):
        super().__init__(
            uow, "nutrition", ("food", "recipe", "recipeVersion", "diary", "goals", "goalVersion")
        )

    def _day_change(self, p, day, id, remove=False):
        key = ("diary", p.subject, day)
        ids = self.uow.indexes.setdefault(key, [])
        if remove:
            ids.remove(id)
        elif id not in ids:
            insort(ids, id)
        revkey = (p.subject, day)
        self.uow.day_revisions[revkey] = self.uow.day_revisions.get(revkey, 0) + 1

    def put(self, p, kind, value, expected, *, storage_id=None):
        with self.uow.lock:
            old = self.uow.records.get(self.key(p, kind, value.id))
            record = super().put(p, kind, value, expected, storage_id=storage_id)
            if kind == "diary":
                if old and old.value.date != value.date:
                    self._day_change(p, old.value.date, value.id, True)
                self._day_change(p, value.date, value.id)
            return record

    def delete(self, p, kind, id, expected):
        with self.uow.lock:
            old = self.get(p, kind, id)
            super().delete(p, kind, id, expected)
            if kind == "diary":
                self._day_change(p, old.value.date, id, True)

    def diary_day(self, p, day):
        with self.uow.lock:
            self.uow.subject(p)
            return tuple(
                self.get(p, "diary", id)
                for id in self.uow.indexes.get(("diary", p.subject, day), ())
            )


class MemoryAccounts(MemoryRepository):
    def __init__(self, uow):
        super().__init__(uow, "accounts", ("profile",))

    def enabled(self, p):
        return p.subject not in self.uow.disabled


class MemoryCatalog:
    def __init__(self, exercises=(), foods=(), clock=utcnow):
        self._records = {
            (kind, v.id): Record(deepcopy(v), 1, clock(), clock(), None)
            for kind, values in (("exercise", exercises), ("food", foods))
            for v in values
        }

    def get(self, kind, id):
        record = self._records.get((kind, id))
        if record is None:
            raise Problem(404, "NOT_FOUND")
        return deepcopy(record)

    def list(self, kind):
        return tuple(deepcopy(v) for k, v in sorted(self._records.items()) if k[0] == kind)
