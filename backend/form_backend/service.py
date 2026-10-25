"""Domain operations: source resolution and snapshots occur on the server boundary."""

import re
from decimal import Decimal
from uuid import uuid4
from zoneinfo import ZoneInfo

from .calculations import recipe_per100g, scale, total, workout_summary
from .core import Problem
from .models import (
    DiaryEntry,
    ExerciseSnapshot,
    FoodSnapshot,
    GoalChange,
    Goals,
    Ingredient,
    Nutrients,
    NutritionSnapshot,
    Recipe,
    SessionExercise,
    SetLog,
    Workout,
    WorkoutSummary,
    changed,
)
from .repositories import (
    AccountsRepository,
    CatalogRepository,
    NutritionRepository,
    Record,
    Result,
    TrainingRepository,
)


class Service:
    def __init__(
        self,
        uow,
        training: TrainingRepository,
        nutrition: NutritionRepository,
        accounts: AccountsRepository,
        catalog: CatalogRepository,
    ):
        self.uow, self.training, self.nutrition = uow, training, nutrition
        self.accounts, self.catalog = accounts, catalog

    def today(self, p):
        try:
            zone = self.accounts.get(p, "profile", "profile").value.time_zone
        except Problem as err:
            if err.code != "NOT_FOUND":
                raise
            zone = "America/Los_Angeles"
        return self.uow.clock().astimezone(ZoneInfo(zone)).date()

    def definition(self, p, kind, id):
        repo = self.training if kind == "exercise" else self.nutrition
        try:
            return repo.get(p, kind, id)
        except Problem as err:
            if err.code != "NOT_FOUND":
                raise
            return self.catalog.get(kind, id)

    def writable_definition(self, p, kind, id):
        try:
            self.catalog.get(kind, id)
        except Problem as error:
            if error.code == "NOT_FOUND":
                return
            raise
        raise Problem(403, "SYSTEM_RECORD_READ_ONLY")

    def save_definition(self, p, kind, req, expected):
        self.writable_definition(p, kind, req.id)
        repo = self.training if kind == "exercise" else self.nutrition
        record = repo.put(p, kind, req, expected)
        return Result(201 if expected == 0 else 200, record.dto(), record.revision)

    def save_template(self, p, req, expected):
        for entry in req.exercises:
            self.definition(p, "exercise", entry.exercise_id)
        record = self.training.put(p, "template", req, expected)
        return Result(201 if expected == 0 else 200, record.dto(), record.revision)

    def new_entry(self, p, plan):
        source = self.definition(p, "exercise", plan.exercise_id)
        if source.value.archived:
            raise Problem(409, "EXERCISE_ARCHIVED")
        snapshot = ExerciseSnapshot(
            **source.value.model_dump(),
            source_revision=source.revision,
            source="system" if source.owner_sub is None else "custom",
        )
        # Find latest corresponding mode, with independent completed-side defaults.
        previous = None
        for performance in self.training.performances(p, plan.exercise_id, None):
            for entry in performance.value.exercises:
                if (
                    entry.exercise_id == plan.exercise_id
                    and entry.snapshot.unilateral == snapshot.unilateral
                ):
                    previous = entry
                    break
            if previous:
                break
        match = re.search(r"\d+", plan.prescription.target)
        reps = min(999, int(match.group())) if match else 10
        old_groups: dict[str, dict[str, SetLog]] = {}
        if previous:
            for row in previous.sets:
                old_groups.setdefault(row.group_id, {})[row.side] = row
        ordered = list(old_groups.values())
        rows = []
        for index in range(plan.prescription.planned_sets):
            group = str(uuid4())
            for side in ("L", "R") if snapshot.unilateral else ("both",):
                old = ordered[index].get(side) if index < len(ordered) else None
                rows.append(
                    SetLog(
                        id=str(uuid4()),
                        group_id=group,
                        side=side,
                        reps=old.reps if old and old.done else reps,
                        kg=old.kg if old and old.done else Decimal(0),
                        rpe=old.rpe if old and old.done else None,
                        done=False,
                    )
                )
        return SessionExercise(
            id=plan.id,
            exercise_id=plan.exercise_id,
            snapshot=snapshot,
            prescription=plan.prescription,
            sets=tuple(rows),
        )

    def create_session(self, p, req):
        plans = req.exercises
        if req.template_id:
            template = self.training.get(p, "template", req.template_id)
            if template.revision != req.template_revision:
                raise Problem(409, "SOURCE_CHANGED")
            plans = template.value.exercises
        session = Workout(
            id=req.id,
            name=req.name,
            training_type=req.training_type,
            template_id=req.template_id,
            started_at=req.started_at,
            unit=req.unit,
            exercises=tuple(self.new_entry(p, plan) for plan in plans),
        )
        record = self.training.put(p, "session", session, 0)
        return Result(201, record.dto(), record.revision)

    def active(self, p, id):
        record = self.training.get(p, "session", id)
        if record.value.status != "active":
            raise Problem(409, "IMMUTABLE_HISTORY")
        return record

    def write_draft(self, p, id, req, expected):
        old = self.active(p, id)
        previous = {e.id: e for e in old.value.exercises}
        old_rows = {
            r.id: (e.id, e.exercise_id, r.group_id, r.side)
            for e in old.value.exercises
            for r in e.sets
        }
        entries = []
        for value in req.exercises:
            prior = previous.get(value.id)
            if prior and prior.exercise_id == value.exercise_id:
                snapshot = prior.snapshot
            else:
                source = self.definition(p, "exercise", value.exercise_id)
                if source.value.archived:
                    raise Problem(409, "EXERCISE_ARCHIVED")
                snapshot = ExerciseSnapshot(
                    **source.value.model_dump(),
                    source_revision=source.revision,
                    source="system" if source.owner_sub is None else "custom",
                )
            for row in value.sets:
                if row.id in old_rows and old_rows[row.id] != (
                    value.id,
                    value.exercise_id,
                    row.group_id,
                    row.side,
                ):
                    raise Problem(422, "SET_IDENTITY_CHANGED")
            entries.append(SessionExercise(**value.model_dump(), snapshot=snapshot))
        updated = changed(
            old.value, name=req.name, notes=req.notes, unit=req.unit, exercises=tuple(entries)
        )
        record = self.training.put(p, "session", updated, expected)
        return Result(200, record.dto(), record.revision)

    def patch_session(self, p, id, req, expected):
        old = self.active(p, id)
        fields = req.model_dump(exclude_unset=True)
        if "entry_order" in fields:
            order = fields.pop("entry_order")
            entries = {e.id: e for e in old.value.exercises}
            if order is None or len(order) != len(entries) or set(order) != set(entries):
                raise Problem(422, "INVALID_ENTRY_ORDER")
            fields["exercises"] = tuple(entries[i] for i in order)
        record = self.training.put(p, "session", changed(old.value, **fields), expected)
        return Result(200, record.dto(), record.revision)

    def patch_entry(self, p, id, entry_id, req, expected):
        old = self.active(p, id)
        if entry_id not in {e.id for e in old.value.exercises}:
            raise Problem(404, "NOT_FOUND")
        entries = tuple(
            changed(e, **req.model_dump(exclude_unset=True)) if e.id == entry_id else e
            for e in old.value.exercises
        )
        record = self.training.put(p, "session", changed(old.value, exercises=entries), expected)
        return Result(200, record.dto(), record.revision)

    def edit_sets(self, p, id, req, expected):
        old = self.active(p, id)
        entries = {e.id: e for e in old.value.exercises}
        seen = set()
        for edit in req.edits:
            identity = (edit.entry_id, edit.set_id)
            if identity in seen:
                raise Problem(422, "DUPLICATE_SET_EDIT")
            seen.add(identity)
            entry = entries.get(edit.entry_id)
            if not entry:
                raise Problem(404, "NOT_FOUND")
            row = next((r for r in entry.sets if r.id == edit.set_id), None)
            if not row or row.group_id != edit.group_id or row.side != edit.side:
                raise Problem(404, "NOT_FOUND")
            fields = edit.model_dump(
                exclude_unset=True,
                exclude={"entry_id", "group_id", "set_id", "side", "apply_weight_to_pair"},
            )
            changed_row = changed(row, **fields)
            rows = []
            if edit.apply_weight_to_pair and (not entry.same_weight or "kg" not in fields):
                raise Problem(422, "INVALID_WEIGHT_SHORTCUT")
            for candidate in entry.sets:
                if candidate.id == row.id:
                    rows.append(changed_row)
                elif edit.apply_weight_to_pair and candidate.group_id == row.group_id:
                    rows.append(changed(candidate, kg=edit.kg))
                else:
                    rows.append(candidate)
            entries[entry.id] = changed(entry, sets=tuple(rows))
        record = self.training.put(
            p,
            "session",
            changed(old.value, exercises=tuple(entries[e.id] for e in old.value.exercises)),
            expected,
        )
        return Result(200, record.dto(), record.revision)

    def change_group(self, p, id, entry_id, group_id, expected, remove=False):
        old = self.active(p, id)
        entry = next((e for e in old.value.exercises if e.id == entry_id), None)
        if not entry:
            raise Problem(404, "NOT_FOUND")
        exists = any(r.group_id == group_id for r in entry.sets)
        if remove and not exists:
            raise Problem(404, "NOT_FOUND")
        if not remove and exists:
            raise Problem(409, "ID_EXISTS")
        rows = tuple(r for r in entry.sets if r.group_id != group_id)
        if not remove:
            match = re.search(r"\d+", entry.prescription.target)
            reps = min(999, int(match.group())) if match else 10
            group_order = list(dict.fromkeys(row.group_id for row in entry.sets))
            previous = {
                row.side: row
                for row in entry.sets
                if group_order and row.group_id == group_order[-1]
            }
            rows += tuple(
                SetLog(
                    id=str(uuid4()),
                    group_id=group_id,
                    side=side,
                    reps=previous[side].reps if side in previous else reps,
                    kg=previous[side].kg if side in previous else Decimal(0),
                )
                for side in (("L", "R") if entry.snapshot.unilateral else ("both",))
            )
        entries = tuple(
            changed(e, sets=rows) if e.id == entry_id else e for e in old.value.exercises
        )
        record = self.training.put(p, "session", changed(old.value, exercises=entries), expected)
        return Result(200, record.dto(), record.revision)

    def complete(self, p, id, expected):
        old = self.active(p, id)
        completed = changed(
            old.value,
            status="completed",
            completed_at=self.uow.clock(),
            completed_version=old.value.completed_version + 1,
        )
        completed = changed(
            completed, summary=WorkoutSummary.model_validate(workout_summary(completed))
        )
        head = self.training.put(p, "session", completed, expected)
        self.training.put(
            p, "workoutVersion", completed, 0, storage_id=f"{id}:{completed.completed_version}"
        )
        return Result(200, {**head.dto(), "summary": workout_summary(completed)}, head.revision)

    def reopen(self, p, id, expected):
        old = self.training.get(p, "session", id)
        if old.value.status != "completed":
            raise Problem(409, "INVALID_STATE")
        draft = changed(old.value, status="active", completed_at=None, summary=None)
        record = self.training.put(p, "session", draft, expected)
        return Result(200, record.dto(), record.revision)

    def save_recipe(self, p, req, expected):
        old = self.nutrition.get(p, "recipe", req.id) if expected else None
        existing = {i.id: i for i in old.value.ingredients} if old else {}
        ingredients = []
        for i in req.ingredients:
            if i.retain_snapshot:
                prior = existing.get(i.id)
                if not prior or prior.food_id != i.food_id or i.food_revision is not None:
                    raise Problem(422, "INVALID_INGREDIENT_RETENTION")
                snapshot = prior.snapshot
            else:
                source = self.definition(p, "food", i.food_id)
                if source.value.archived:
                    raise Problem(409, "FOOD_ARCHIVED")
                if source.revision != i.food_revision:
                    raise Problem(409, "SOURCE_CHANGED")
                snapshot = FoodSnapshot(
                    **source.value.model_dump(),
                    source_revision=source.revision,
                    source="system" if source.owner_sub is None else "custom",
                )
            ingredients.append(
                Ingredient(id=i.id, food_id=i.food_id, grams=i.grams, snapshot=snapshot)
            )
        version = old.value.version + 1 if old else 1
        recipe = Recipe(
            id=req.id,
            name=req.name,
            finished_grams=req.finished_grams,
            ingredients=tuple(ingredients),
            version=version,
        )
        # Validate calculated portion snapshot before committing an unusable recipe.
        Nutrients.model_validate(recipe_per100g(recipe).model_dump())
        head = self.nutrition.put(p, "recipe", recipe, expected)
        self.nutrition.put(p, "recipeVersion", recipe, 0, storage_id=f"{req.id}:{version}")
        return Result(201 if not expected else 200, head.dto(), head.revision)

    def create_diary(self, p, req):
        if req.source_type == "food":
            source = self.definition(p, "food", req.source_id)
            if source.revision != req.source_revision:
                raise Problem(409, "SOURCE_CHANGED")
            if source.value.archived:
                raise Problem(409, "FOOD_ARCHIVED")
            snapshot = NutritionSnapshot(
                name=source.value.name,
                preparation=source.value.preparation,
                per100g=source.value.per100g,
            )
        else:
            if self.nutrition.get(p, "recipe", req.source_id).value.archived:
                raise Problem(409, "RECIPE_ARCHIVED")
            source = self.nutrition.get(
                p, "recipeVersion", f"{req.source_id}:{req.source_revision}"
            )
            snapshot = NutritionSnapshot(
                name=source.value.name, preparation="cooked", per100g=recipe_per100g(source.value)
            )
        entry = DiaryEntry(**req.model_dump(), snapshot=snapshot)
        record = self.nutrition.put(p, "diary", entry, 0)
        return Result(201, record.dto(), record.revision)

    def edit_diary(self, p, id, req, expected):
        old = self.nutrition.get(p, "diary", id)
        record = self.nutrition.put(
            p, "diary", changed(old.value, **req.model_dump(exclude_unset=True)), expected
        )
        return Result(200, record.dto(), record.revision)

    def save_goals(self, p, req, expected):
        goal = Goals(**req.model_dump(), version=expected + 1)
        head = self.nutrition.put(p, "goals", goal, expected)
        self.nutrition.put(
            p,
            "goalVersion",
            GoalChange(**goal.model_dump()),
            0,
            storage_id=f"current:{head.revision}",
        )
        return Result(200, head.dto(), head.revision)

    def goals_on(self, p, day):
        candidates = [
            r for r in self.nutrition.list(p, "goalVersion") if r.value.effective_from <= day
        ]
        if not candidates:
            return None
        selected = max(candidates, key=lambda r: (r.value.effective_from, r.value.version))
        head = self.nutrition.get(p, "goals", "current")
        return Record(
            Goals.model_validate(selected.value.model_dump()),
            head.revision,
            selected.created_at,
            selected.updated_at,
            selected.owner_sub,
        )

    def diary(self, p, day):
        with self.uow.lock:
            entries = self.nutrition.diary_day(p, day)
            goal = self.goals_on(p, day)
            return {
                "date": day,
                "entries": tuple(r.dto() for r in entries),
                "totals": total(
                    scale(r.value.snapshot.per100g, r.value.grams) for r in entries
                ).model_dump(),
                "goals": goal.dto() if goal else None,
                "dayRevision": self.uow.day_revisions.get((p.subject, day), 0),
            }

    def archive(self, p, repo, kind, id, expected, archived):
        if kind in ("exercise", "food"):
            self.writable_definition(p, kind, id)
        old = repo.get(p, kind, id)
        record = repo.put(p, kind, changed(old.value, archived=archived), expected)
        return Result(200, record.dto(), record.revision)
