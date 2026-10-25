"""Pure decimal calculations. Paired counts and completed-side volume are distinct."""

from decimal import Decimal, localcontext
from functools import wraps

from .models import Nutrients, OutputAmount, Recipe, SetLog, Workout


def decimal_math(function):
    @wraps(function)
    def calculate(*args, **kwargs):
        with localcontext() as context:
            context.prec = 38
            return function(*args, **kwargs)

    return calculate


@decimal_math
def scale(n: Nutrients, grams: Decimal) -> Nutrients:
    return NutritionTotals(**{k: v * grams / 100 for k, v in n.model_dump().items()})


@decimal_math
def total(values) -> Nutrients:
    sums = dict.fromkeys(("calories", "protein", "carbs", "fat"), Decimal(0))
    for value in values:
        for k, v in value.model_dump().items():
            sums[k] += v
    # Computed totals may exceed individual-input caps; don't use input DTO for aggregates.
    return NutritionTotals(**sums)


class NutritionTotals(Nutrients):
    # Keep a separate read model so a valid large meal/day is not rejected by per-food limits.
    calories: OutputAmount
    protein: OutputAmount
    carbs: OutputAmount
    fat: OutputAmount


def recipe_total(recipe: Recipe) -> Nutrients:
    return total(scale(i.snapshot.per100g, i.grams) for i in recipe.ingredients)


@decimal_math
def recipe_per100g(recipe: Recipe) -> Nutrients:
    n = recipe_total(recipe)
    return NutritionTotals(
        **{k: v * 100 / recipe.finished_grams for k, v in n.model_dump().items()}
    )


@decimal_math
def workout_summary(workout: Workout) -> dict:
    volume = Decimal(0)
    completed = 0
    prescribed = 0
    muscle_volume: dict[str, Decimal] = {}
    comparisons = []
    for entry in workout.exercises:
        prescribed += entry.prescription.planned_sets
        groups: dict[str, list[SetLog]] = {}
        for row in entry.sets:
            groups.setdefault(row.group_id, []).append(row)
            if row.done:
                load = row.reps * row.kg
                volume += load
                if entry.snapshot.primary_muscle:
                    m = entry.snapshot.primary_muscle
                    muscle_volume[m] = muscle_volume.get(m, Decimal(0)) + load
        for group_id, rows in groups.items():
            if all(r.done for r in rows):
                completed += 1
                if entry.snapshot.unilateral:
                    sides = {r.side: r for r in rows}
                    comparisons.append(
                        {
                            "entryId": entry.id,
                            "groupId": group_id,
                            "left": sides["L"].model_dump(by_alias=True),
                            "right": sides["R"].model_dump(by_alias=True),
                        }
                    )
    return {
        "completedGroups": completed,
        "prescribedGroups": prescribed,
        "volumeKgReps": volume,
        "primaryMuscleVolumeKgReps": muscle_volume,
        "matchedPairs": comparisons,
    }
