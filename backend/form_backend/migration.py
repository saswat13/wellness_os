"""Validated, read-only browser export preflight; NO importer or database writes.

v1/v2 must first use existing TypeScript normalization on a detached copy.
Raw bytes are hashed/retained by the caller; a blocked source is never called migrated.
"""

from datetime import datetime, timezone
from decimal import Decimal
from hashlib import sha256
from typing import Literal

from pydantic import ValidationError, field_validator

from .calculations import scale, total
from .core import Principal, Problem, digest, json_text, load_json
from .models import (
    ID,
    Annotated,
    BeforeValidator,
    Day,
    Exercise,
    ExerciseSnapshot,
    Field,
    Food,
    Meal,
    Model,
    Name,
    Nutrients,
    NutritionSnapshot,
    Positive,
    Prescription,
    ProfileWrite,
    SessionExercise,
    SetLog,
    Stamp,
    Template,
    TrainingType,
    numeric,
)


class LegacyExercise(Exercise):
    owner_id: ID | None
    source: Literal["system", "custom"]
    created_at: Stamp
    updated_at: Stamp


class LegacyFood(Food):
    owner_id: ID | None
    source: Literal["system", "custom"]


class LegacyTemplate(Template):
    owner_id: ID
    visibility: Literal["private", "public"]
    created_at: Stamp
    updated_at: Stamp


class LegacySet(SetLog):
    owner_id: ID
    session_id: ID
    session_exercise_id: ID
    exercise_id: ID
    rpe: Literal["", "5", "6", "7", "8", "9", "10"]  # type: ignore[assignment]  # Original browser DTO stores RPE text.


class LegacyEntry(Model):
    id: ID
    exercise_id: ID
    snapshot: LegacyExercise
    prescription: Prescription
    same_weight: bool = True


class LegacySession(Model):
    id: ID
    owner_id: ID
    template_id: ID | None
    name: Name
    training_type: TrainingType
    exercises: tuple[LegacyEntry, ...]
    logs: dict[str, tuple[LegacySet, ...]]
    notes: Annotated[str, Field(max_length=2000)]
    unit: Literal["kg", "lb"]
    finished: bool
    started: Annotated[Decimal, BeforeValidator(numeric)]
    completed_at: Stamp | None
    mock: bool

    @field_validator("logs", mode="before")
    @classmethod
    def rows(cls, value):
        if isinstance(value, dict):
            return {k: tuple(v) if isinstance(v, list) else v for k, v in value.items()}
        return value


class LegacyWorkoutStore(Model):
    version: Literal[3]
    user_id: ID
    library: tuple[LegacyExercise, ...]
    templates: tuple[LegacyTemplate, ...]
    session: LegacySession
    history: tuple[LegacySession, ...]


class LegacyIngredient(Model):
    id: ID
    food_id: ID
    grams: Positive
    snapshot: LegacyFood


class LegacyRecipe(Model):
    id: ID
    owner_id: ID
    name: Name
    finished_grams: Positive
    ingredients: Annotated[tuple[LegacyIngredient, ...], Field(min_length=1, max_length=100)]
    updated_at: Stamp


class LegacyDiary(Model):
    id: ID
    owner_id: ID
    date: Day
    meal: Meal
    source_type: Literal["food", "recipe"]
    source_id: ID
    grams: Positive
    snapshot: NutritionSnapshot
    created_at: Stamp


class LegacyUser(ProfileWrite):
    id: ID


class LegacyGoals(Nutrients):
    id: ID
    owner_id: ID


class LegacyNutritionStore(Model):
    version: Literal[1]
    user: LegacyUser
    goals: LegacyGoals
    foods: tuple[LegacyFood, ...]
    recipes: tuple[LegacyRecipe, ...]
    diary: tuple[LegacyDiary, ...]
    favorites: tuple[ID, ...]


class BrowserExport(Model):
    export_version: Literal[1]
    workouts: LegacyWorkoutStore | None = None
    nutrition: LegacyNutritionStore | None = None


class Mapping(Model):
    identity: str
    destination_owner: str
    destination_id: str
    source_digest: str


class MigrationPlan(Model):
    source_digest: str
    normalized_digest: str | None
    valid: bool
    blockers: tuple[str, ...]
    warnings: tuple[str, ...]
    mappings: tuple[Mapping, ...]
    counts: dict[str, int]
    daily_totals: dict[str, dict[str, Decimal]]


def unique(values):
    ids = [v.id for v in values]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate IDs")
    return set(ids)


def source_owner(value, owner):
    if value.source == "system":
        if value.owner_id is not None:
            raise ValueError("System definition has owner")
    elif value.owner_id != owner:
        raise ValueError("Foreign legacy definition owner")


def validate_workouts(store):
    owner = store.user_id
    library = unique(store.library)
    for ex in store.library:
        source_owner(ex, owner)
    unique(store.templates)
    for template in store.templates:
        if template.owner_id != owner or any(
            e.exercise_id not in library for e in template.exercises
        ):
            raise ValueError("Template owner/reference mismatch")
    unique(store.history)
    for session in (store.session, *store.history):
        datetime.fromtimestamp(float(session.started / 1000), timezone.utc)
        if session.owner_id != owner:
            raise ValueError("Session owner mismatch")
        entries = unique(session.exercises)
        if set(session.logs) != entries:
            raise ValueError("Session logs/entries mismatch")
        row_ids = []
        for entry in session.exercises:
            source_owner(entry.snapshot, owner)
            rows = session.logs[entry.id]
            for row in rows:
                if (row.owner_id, row.session_id, row.session_exercise_id, row.exercise_id) != (
                    owner,
                    session.id,
                    entry.id,
                    entry.exercise_id,
                ):
                    raise ValueError("Set graph mismatch")
                row_ids.append(row.id)
            # Reuse real pairing validator without inferring pairing from row order.
            SessionExercise(
                id=entry.id,
                exercise_id=entry.exercise_id,
                snapshot=ExerciseSnapshot(
                    **entry.snapshot.model_dump(
                        exclude={"owner_id", "source", "created_at", "updated_at"}
                    ),
                    source="custom" if entry.snapshot.source == "custom" else "system",
                    source_revision=None,
                ),
                prescription=entry.prescription,
                same_weight=entry.same_weight,
                sets=tuple(
                    SetLog(
                        **r.model_dump(
                            exclude={
                                "owner_id",
                                "session_id",
                                "session_exercise_id",
                                "exercise_id",
                                "rpe",
                            }
                        ),
                        rpe=int(r.rpe) if r.rpe else None,
                    )
                    for r in rows
                ),
            )
            if entry.exercise_id not in library:
                raise ValueError("Missing library reference; recover snapshot explicitly")
        if len(row_ids) != len(set(row_ids)):
            raise ValueError("Duplicate session set IDs")


def validate_nutrition(store):
    owner = store.user.id
    food_ids, recipe_ids = unique(store.foods), unique(store.recipes)
    unique(store.diary)
    if store.goals.owner_id != owner:
        raise ValueError("Goal owner mismatch")
    for food in store.foods:
        source_owner(food, owner)
    for recipe in store.recipes:
        unique(recipe.ingredients)
        if recipe.owner_id != owner:
            raise ValueError("Recipe owner mismatch")
        for i in recipe.ingredients:
            source_owner(i.snapshot, owner)
            if i.food_id != i.snapshot.id or i.food_id not in food_ids:
                raise ValueError("Ingredient reference mismatch")
    for entry in store.diary:
        if entry.owner_id != owner or entry.source_id not in (
            food_ids if entry.source_type == "food" else recipe_ids
        ):
            raise ValueError("Diary owner/reference mismatch; manual recovery needed")
    if len(store.favorites) != len(set(store.favorites)) or not set(store.favorites) <= food_ids:
        raise ValueError("Invalid favorites")


def plan_export(raw: bytes, principal: Principal, *, claim=False, existing=None) -> MigrationPlan:
    principal.require("form/write")
    if not claim:
        raise Problem(422, "EXPLICIT_LOCAL_CLAIM_REQUIRED")
    source_digest = sha256(raw).hexdigest()
    warnings, mappings, blockers, daily = [], [], [], {}
    counts: dict[str, int] = {}
    try:
        exported = BrowserExport.model_validate(load_json(raw), by_alias=True, by_name=False)
        if exported.workouts is None and exported.nutrition is None:
            raise ValueError("Empty export")
        if exported.workouts:
            validate_workouts(exported.workouts)
        if exported.nutrition:
            validate_nutrition(exported.nutrition)
        normalized_digest = digest(exported.model_dump(by_alias=True))

        def add(identity, obj, destination_id=None):
            value_hash = digest(obj.model_dump(by_alias=True))
            identity_key = json_text(identity)
            if existing and identity_key in existing and existing[identity_key] != value_hash:
                blockers.append("ID conflict: " + identity_key)
            mappings.append(
                Mapping(
                    identity=identity_key,
                    destination_owner=principal.subject,
                    destination_id=destination_id or obj.id,
                    source_digest=value_hash,
                )
            )

        if exported.workouts:
            w = exported.workouts
            counts.update(
                exercises=len(w.library), templates=len(w.templates), history=len(w.history)
            )
            for kind, values in (("exercise", w.library), ("template", w.templates)):
                for obj in values:
                    add([kind, obj.id], obj)
            for session in (*w.history, w.session):
                # Current/history may share ID legitimately, keep distinct source roles.
                role = "current" if session is w.session else "history"
                add(["session", role, session.id], session)
                for entry in session.exercises:
                    add(["entry", role, session.id, entry.id], entry)
                    for row in session.logs[entry.id]:
                        add(
                            ["set", role, session.id, entry.id, row.group_id, row.side, row.id], row
                        )
            if any(h.id == w.session.id for h in w.history):
                warnings.append(
                    "Current/history shared ID: preserve completed version plus distinct draft if changed."
                )
            warnings.append(
                "Retain workout mock flags; exclude mock from real analytics by default."
            )
        if exported.nutrition:
            n = exported.nutrition
            counts.update(foods=len(n.foods), recipes=len(n.recipes), diary=len(n.diary))
            counts.update(profiles=1, goals=1, favorites=len(n.favorites))
            add(["profile", n.user.id], n.user, "profile")
            add(["goals", n.goals.id], n.goals, "current")
            for food_id in n.favorites:
                mappings.append(
                    Mapping(
                        identity=json_text(["favorite", food_id]),
                        destination_owner=principal.subject,
                        destination_id=food_id,
                        source_digest=digest({"foodId": food_id}),
                    )
                )
            for kind, nutrition_values in (
                ("food", n.foods),
                ("recipe", n.recipes),
                ("diary", n.diary),
            ):
                for nutrition_obj in nutrition_values:
                    add([kind, nutrition_obj.id], nutrition_obj)
            for day in sorted({d.date for d in n.diary}):
                daily[day.isoformat()] = total(
                    scale(e.snapshot.per100g, e.grams) for e in n.diary if e.date == day
                ).model_dump()
            warnings.extend(
                (
                    "Legacy nutrition has no reliable mock flag; review samples, do not guess.",
                    "Preserve diary/ingredient snapshots even if current definitions differ; source versions may be unknown.",
                    "Current goal has no known historical effective date; confirm import date.",
                )
            )
        warnings.append(
            "Dry run only. Keep all original storage keys/bytes and a private backup; no data uploaded."
        )
    except (ValidationError, ValueError, OverflowError, TypeError, OSError):
        normalized_digest = None
        blockers.append(
            "Invalid/unsupported source graph. Preserve raw bytes; normalize v1/v2 with existing frontend migrations or recover manually."
        )
    return MigrationPlan(
        source_digest=source_digest,
        normalized_digest=normalized_digest,
        valid=not blockers,
        blockers=tuple(blockers),
        warnings=tuple(warnings),
        mappings=tuple(mappings),
        counts=counts,
        daily_totals=daily,
    )


def normalized_workout(session: LegacySession):
    """Pure fixture/preflight transformation, not a write/import operation.

    The original source bytes/digest remain authoritative recovery provenance.
    Only the existing per-side group IDs determine pairing.
    """
    from .models import Workout

    entries = []
    for entry in session.exercises:
        snapshot = ExerciseSnapshot(
            **entry.snapshot.model_dump(exclude={"owner_id", "source", "created_at", "updated_at"}),
            source=entry.snapshot.source,
            source_revision=None,
        )
        rows = tuple(
            SetLog(
                **row.model_dump(
                    exclude={"owner_id", "session_id", "session_exercise_id", "exercise_id", "rpe"}
                ),
                rpe=int(row.rpe) if row.rpe else None,
            )
            for row in session.logs[entry.id]
        )
        entries.append(
            SessionExercise(
                id=entry.id,
                exercise_id=entry.exercise_id,
                snapshot=snapshot,
                prescription=entry.prescription,
                same_weight=entry.same_weight,
                sets=rows,
            )
        )
    return Workout(
        id=session.id,
        name=session.name,
        training_type=session.training_type,
        template_id=session.template_id,
        exercises=tuple(entries),
        started_at=datetime.fromtimestamp(float(session.started / 1000), timezone.utc),
        completed_at=session.completed_at if session.finished else None,
        status="completed" if session.finished else "active",
        completed_version=1 if session.finished else 0,
        unit=session.unit,
        notes=session.notes,
        mock=session.mock,
    )
