"""Strict v1 DTOs; input ownership, snapshots and computed fields are never mass assigned."""

import re
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Annotated, Generic, Literal, TypeVar, get_args, get_origin
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    WithJsonSchema,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel


def numeric(v):
    if isinstance(v, bool) or not isinstance(v, (int, float, Decimal)):
        raise ValueError("Expected a JSON number")
    d = Decimal(str(v))
    if not d.is_finite() or len(d.as_tuple().digits) > 38 or abs(int(d.as_tuple().exponent)) > 128:
        raise ValueError("Expected finite number")
    return d


def calendar_date(v):
    if isinstance(v, date) and not isinstance(v, datetime):
        return v
    if not isinstance(v, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
        raise ValueError("Expected YYYY-MM-DD")
    return date.fromisoformat(v)


def timestamp(v):
    if isinstance(v, str):
        if not re.match(r"^\d{4}-\d{2}-\d{2}T", v):
            raise ValueError("Expected RFC3339 timestamp")
        v = datetime.fromisoformat(v.replace("Z", "+00:00"))
    if not isinstance(v, datetime) or v.tzinfo is None or v.utcoffset() is None:
        raise ValueError("Timestamp requires timezone")
    return v.astimezone(timezone.utc)


ID = Annotated[str, Field(min_length=1, max_length=128)]
Name = Annotated[str, Field(min_length=1, max_length=120)]
Amount = Annotated[
    Decimal,
    BeforeValidator(numeric),
    Field(ge=0, le=100000),
    WithJsonSchema({"type": "number", "minimum": 0, "maximum": 100000}),
]
OutputAmount = Annotated[
    Decimal, BeforeValidator(numeric), Field(ge=0), WithJsonSchema({"type": "number", "minimum": 0})
]
Positive = Annotated[
    Amount,
    Field(gt=0),
    WithJsonSchema({"type": "number", "exclusiveMinimum": 0, "maximum": 100000}),
]
Load = Annotated[
    Amount, Field(le=10000), WithJsonSchema({"type": "number", "minimum": 0, "maximum": 10000})
]
Day = Annotated[date, BeforeValidator(calendar_date)]
Stamp = Annotated[datetime, BeforeValidator(timestamp)]
TrainingType = Literal["hypertrophy", "powerlifting", "hyrox", "running", "other"]
Muscle = Literal[
    "Chest",
    "Lats",
    "Upper back",
    "Shoulders",
    "Biceps",
    "Triceps",
    "Quads",
    "Hamstrings",
    "Glutes",
    "Calves",
    "Core",
    "Other",
]
Pattern = Literal[
    "Vertical pull",
    "Horizontal pull",
    "Horizontal push",
    "Vertical push",
    "Squat",
    "Hinge",
    "Lunge",
    "Isolation",
    "Carry",
    "Locomotion",
    "Other",
]
Equipment = Literal[
    "Cable", "Smith machine", "Barbell", "Dumbbell", "Machine", "Bodyweight", "Band", "Other"
]
Preparation = Literal["raw", "cooked", "dry", "packaged"]
Meal = Literal["Breakfast", "Lunch", "Dinner", "Snacks"]


class Model(BaseModel):
    model_config = ConfigDict(
        extra="forbid", strict=True, frozen=True, alias_generator=to_camel, populate_by_name=True
    )

    @field_validator("name", check_fields=False)
    @classmethod
    def trim_name(cls, value):
        if not isinstance(value, str) or not value.strip():
            raise ValueError("Name must not be blank")
        return value.strip()

    @field_validator("*", mode="before")
    @classmethod
    def immutable_sequences(cls, value, info):
        annotation = cls.model_fields[info.field_name].annotation

        def has_tuple(t):
            return get_origin(t) is tuple or any(has_tuple(a) for a in get_args(t))

        tuple_field = has_tuple(annotation)
        if tuple_field and isinstance(value, list):
            return tuple(value)
        return value


class Nutrients(Model):
    calories: Amount
    protein: Amount
    carbs: Amount
    fat: Amount


class Exercise(Model):
    id: ID
    name: Name
    primary_muscle: Muscle | None = None
    secondary_muscles: tuple[Muscle, ...] = ()
    movement_pattern: Pattern | None = None
    equipment: Equipment | None = None
    tags: Annotated[
        tuple[Annotated[str, Field(min_length=1, max_length=40)], ...], Field(max_length=20)
    ] = ()
    training_types: tuple[TrainingType, ...] = ()
    unilateral: bool = False
    coaching_notes: Annotated[str, Field(max_length=2000)] = ""
    demo_url: Annotated[str, Field(max_length=2000)] = ""
    archived: bool = False

    @field_validator("demo_url")
    @classmethod
    def valid_url(cls, value):
        if value and not re.match(r"^https?://[^\s]+$", value):
            raise ValueError("Expected HTTP(S) URL")
        return value

    @field_validator("name")
    @classmethod
    def nonblank(cls, value):
        if not isinstance(value, str) or not value.strip():
            raise ValueError("Name must not be blank")
        return value.strip()


class Prescription(Model):
    planned_sets: Annotated[int, Field(ge=1, le=20)] = 3
    target: Annotated[str, Field(min_length=1, max_length=40)] = "8–12"
    note: Annotated[str, Field(max_length=2000)] = ""


class TemplateEntry(Model):
    id: ID
    exercise_id: ID
    prescription: Prescription = Prescription()


class Template(Model):
    id: ID
    name: Name
    training_type: TrainingType = "hypertrophy"
    exercises: tuple[TemplateEntry, ...] = ()

    @model_validator(mode="after")
    def unique_entries(self):
        if len({e.id for e in self.exercises}) != len(self.exercises):
            raise ValueError("Duplicate entry IDs")
        return self


class SetLog(Model):
    id: ID
    group_id: ID
    side: Literal["L", "R", "both"]
    reps: Annotated[int, Field(ge=0, le=999)]
    kg: Load
    rpe: Annotated[int, Field(ge=5, le=10)] | None = None
    done: bool = False


class ExerciseSnapshot(Exercise):
    source_revision: Annotated[int, Field(ge=1)] | None
    source: Literal["custom", "system"]


class SessionExercise(Model):
    id: ID
    exercise_id: ID
    snapshot: ExerciseSnapshot
    prescription: Prescription
    same_weight: bool = True
    sets: tuple[SetLog, ...]

    @model_validator(mode="after")
    def validate_pairs(self):
        if self.exercise_id != self.snapshot.id:
            raise ValueError("Snapshot ID mismatch")
        if len({s.id for s in self.sets}) != len(self.sets):
            raise ValueError("Duplicate set IDs")
        groups: dict[str, list[str]] = {}
        for row in self.sets:
            groups.setdefault(row.group_id, []).append(row.side)
        wanted = ["L", "R"] if self.snapshot.unilateral else ["both"]
        if any(sorted(sides) != wanted for sides in groups.values()):
            raise ValueError("Invalid side group")
        return self


class SessionCreate(Model):
    id: ID
    name: Name
    training_type: TrainingType = "hypertrophy"
    template_id: ID | None = None
    template_revision: Annotated[int, Field(ge=1)] | None = None
    exercises: tuple[TemplateEntry, ...] = ()
    started_at: Stamp
    unit: Literal["kg", "lb"] = "kg"

    @model_validator(mode="after")
    def source(self):
        if self.template_id and (self.exercises or self.template_revision is None):
            raise ValueError("Use template+revision or explicit exercises")
        if not self.template_id and self.template_revision is not None:
            raise ValueError("Template revision without template")
        if len({e.id for e in self.exercises}) != len(self.exercises):
            raise ValueError("Duplicate entry IDs")
        return self


class PairComparison(Model):
    entry_id: ID
    group_id: ID
    left: SetLog
    right: SetLog


class WorkoutSummary(Model):
    completed_groups: int
    prescribed_groups: int
    volume_kg_reps: OutputAmount
    primary_muscle_volume_kg_reps: dict[Muscle, OutputAmount]
    matched_pairs: tuple[PairComparison, ...]


class Workout(Model):
    id: ID
    name: Name
    training_type: TrainingType
    template_id: ID | None
    exercises: tuple[SessionExercise, ...]
    started_at: Stamp
    completed_at: Stamp | None = None
    status: Literal["active", "completed"] = "active"
    completed_version: int = 0
    unit: Literal["kg", "lb"] = "kg"
    notes: Annotated[str, Field(max_length=2000)] = ""
    mock: bool = False
    summary: WorkoutSummary | None = None

    @model_validator(mode="after")
    def graph(self):
        if len({e.id for e in self.exercises}) != len(self.exercises):
            raise ValueError("Duplicate entry IDs")
        if (self.status == "completed") != (self.completed_at is not None):
            raise ValueError("Completion timestamp/state mismatch")
        return self


class DraftEntry(Model):
    id: ID
    exercise_id: ID
    prescription: Prescription
    same_weight: bool = True
    sets: Annotated[tuple[SetLog, ...], Field(max_length=40)]


class DraftWrite(Model):
    name: Name
    notes: Annotated[str, Field(max_length=2000)] = ""
    unit: Literal["kg", "lb"] = "kg"
    exercises: Annotated[tuple[DraftEntry, ...], Field(max_length=50)]

    @model_validator(mode="after")
    def unique_graph(self):
        if len({e.id for e in self.exercises}) != len(self.exercises):
            raise ValueError("Duplicate entry IDs")
        sets = [row.id for e in self.exercises for row in e.sets]
        groups = [(e.id, row.group_id) for e in self.exercises for row in e.sets]
        if len(set(sets)) != len(sets):
            raise ValueError("Duplicate set IDs")
        # One group may have two sides only inside the same exercise entry.
        by_group: dict[str, str] = {}
        for entry_id, group_id in groups:
            if group_id in by_group and by_group[group_id] != entry_id:
                raise ValueError("Group reused across entries")
            by_group[group_id] = entry_id
        return self


class SessionPatch(Model):
    name: Name | None = None
    notes: Annotated[str, Field(max_length=2000)] | None = None
    unit: Literal["kg", "lb"] | None = None
    entry_order: tuple[ID, ...] | None = None


class SetEdit(Model):
    entry_id: ID
    group_id: ID
    set_id: ID
    side: Literal["L", "R", "both"]
    reps: Annotated[int, Field(ge=0, le=999)] | None = None
    kg: Load | None = None
    rpe: Annotated[int, Field(ge=5, le=10)] | None = None
    done: bool | None = None
    apply_weight_to_pair: bool = False


class SetEdits(Model):
    edits: Annotated[tuple[SetEdit, ...], Field(min_length=1, max_length=20)]


class GroupCreate(Model):
    id: ID


class EntryPatch(Model):
    same_weight: bool | None = None
    prescription: Prescription | None = None


class Food(Model):
    id: ID
    name: Name
    preparation: Preparation
    per100g: Nutrients = Field(alias="per100g")
    source_info: Annotated[str, Field(max_length=500)] = ""
    archived: bool = False


class FoodSnapshot(Food):
    source_revision: Annotated[int, Field(ge=1)] | None
    source: Literal["custom", "system"]


class IngredientRequest(Model):
    id: ID
    food_id: ID
    grams: Positive
    food_revision: Annotated[int, Field(ge=1)] | None = None
    retain_snapshot: bool = False


class Ingredient(Model):
    id: ID
    food_id: ID
    grams: Positive
    snapshot: FoodSnapshot


class RecipeWrite(Model):
    id: ID
    name: Name
    finished_grams: Positive
    ingredients: Annotated[tuple[IngredientRequest, ...], Field(min_length=1, max_length=100)]

    @model_validator(mode="after")
    def unique(self):
        if len({i.id for i in self.ingredients}) != len(self.ingredients):
            raise ValueError("Duplicate ingredient IDs")
        return self


class Recipe(Model):
    id: ID
    name: Name
    finished_grams: Positive
    ingredients: tuple[Ingredient, ...]
    version: Annotated[int, Field(ge=1)]
    archived: bool = False


class DiaryCreate(Model):
    id: ID
    date: Day
    meal: Meal
    source_type: Literal["food", "recipe"]
    source_id: ID
    source_revision: Annotated[int, Field(ge=1)]
    grams: Positive


class NutritionSnapshot(Model):
    name: Name
    preparation: Preparation
    per100g: Nutrients = Field(alias="per100g")


class DiaryEntry(DiaryCreate):
    source_revision: Annotated[int, Field(ge=1)] | None  # type: ignore[assignment]  # Legacy snapshots may have unknown versions.
    snapshot: NutritionSnapshot


class DiaryPatch(Model):
    grams: Positive | None = None
    date: Day | None = None
    meal: Meal | None = None


class GoalWrite(Nutrients):
    effective_from: Day


class Goals(GoalWrite):
    id: ID = "current"
    version: int = 1


class GoalChange(Goals):
    version: int


class ProfileWrite(Model):
    name: Annotated[str, Field(min_length=1, max_length=80)]
    unit: Literal["kg", "lb"] = "kg"
    time_zone: str = "America/Los_Angeles"
    favorite_food_ids: Annotated[tuple[ID, ...], Field(max_length=500)] = ()

    @field_validator("time_zone")
    @classmethod
    def zone(cls, value):
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("Unknown IANA time zone") from None
        return value


class Profile(ProfileWrite):
    id: ID = "profile"


class Empty(Model):
    pass


class Meta(Model):
    request_id: str
    revision: int | None = None


T = TypeVar("T")


class EntityResponse(Model, Generic[T]):
    data: T
    meta: Meta


class Page(Model, Generic[T]):
    items: tuple[T, ...]
    next_cursor: str | None
    meta: Meta


class ErrorDetail(Model):
    code: str
    message: str
    request_id: str


class ErrorResponse(Model):
    error: ErrorDetail


ChangedModel = TypeVar("ChangedModel", bound=Model)


def changed(model: ChangedModel, **fields) -> ChangedModel:
    """Unlike model_copy(update=...), validate every proposed mutation."""
    return type(model).model_validate({**model.model_dump(), **fields})
