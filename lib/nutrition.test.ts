import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dayTotals,
  deleteDiary,
  editDiary,
  entryNutrition,
  goalsDiffer,
  logPortion,
  macroCalories,
  parseNutrition,
  recipePer100g,
  recipeTotal,
  saveFood,
  saveGoals,
  saveRecipe,
  saveUser,
  scale,
  seedNutrition,
  shiftDate,
  today,
  toggleFavorite,
  type Food,
  type Recipe,
} from "./nutrition";
import { newId, replaceInSession, seedStore, parseStore } from "./tracker";
const customFood = (): Food => ({
  id: newId(),
  ownerId: "local-demo-user",
  source: "custom",
  name: "Homemade tofu",
  preparation: "cooked",
  per100g: { calories: 200, protein: 20, carbs: 10, fat: 8 },
  sourceInfo: "Mock label",
});
test("fractional gram scaling, diary edits and food changes preserve nutrition snapshots", () => {
  let s = seedNutrition();
  const f = customFood();
  const date = today(s.user.timeZone);
  s = saveFood(s, f);
  s = logPortion(s, "food", f.id, 125.5, "Snacks", date);
  const entry = s.diary.at(-1)!;
  assert.deepEqual(entryNutrition(entry), {
    calories: 251,
    protein: 25.1,
    carbs: 12.55,
    fat: 10.04,
  });
  const before = dayTotals(s, date);
  s = saveFood(s, {
    ...f,
    name: "Renamed tofu",
    per100g: { calories: 999, protein: 1, carbs: 1, fat: 1 },
  });
  assert.equal(s.diary.at(-1)!.snapshot.name, "Homemade tofu");
  assert.deepEqual(dayTotals(s, date), before);
  s = editDiary(s, entry.id, { grams: 50, meal: "Dinner", date });
  assert.equal(s.diary.at(-1)!.snapshot.per100g.calories, 200);
  assert.equal(entryNutrition(s.diary.at(-1)!).calories, 100);
  s = deleteDiary(s, entry.id);
  assert.ok(!s.diary.some((e) => e.id === entry.id));
  assert.equal(scale(f.per100g, 0).calories, 0);
  assert.deepEqual(parseNutrition(JSON.parse(JSON.stringify(s))), s);
});
test("recipe finished yield and historical portion snapshots survive ingredient and recipe edits", () => {
  let s = seedNutrition();
  const f = customFood();
  s = saveFood(s, f);
  const recipe: Recipe = {
    id: newId(),
    ownerId: s.user.id,
    name: "Tofu bowl",
    finishedGrams: 400,
    ingredients: [
      { id: newId(), foodId: f.id, grams: 200, snapshot: structuredClone(f) },
      {
        id: newId(),
        foodId: "rice-cooked",
        grams: 100,
        snapshot: structuredClone(s.foods.find((f) => f.id === "rice-cooked")!),
      },
    ],
    updatedAt: new Date().toISOString(),
  };
  assert.equal(recipeTotal(recipe).calories, 530);
  assert.equal(recipePer100g(recipe).calories, 132.5);
  s = saveRecipe(s, recipe);
  s = logPortion(s, "recipe", recipe.id, 150, "Dinner", today());
  const entry = structuredClone(s.diary.at(-1)!);
  assert.equal(entryNutrition(entry).calories, 198.75);
  s = saveRecipe(s, { ...recipe, name: "New tofu bowl", finishedGrams: 200 });
  assert.deepEqual(s.diary.at(-1), entry);
  s = saveFood(s, { ...f, per100g: { ...f.per100g, calories: 1000 } });
  assert.equal(recipeTotal(s.recipes[0]).calories, 530);
  s = logPortion(s, "recipe", recipe.id, 150, "Dinner", today());
  assert.equal(entryNutrition(s.diary.at(-1)!).calories, 397.5);
  s = editDiary(s, entry.id, {
    date: entry.date,
    meal: entry.meal,
    grams: 200,
  });
  assert.equal(
    entryNutrition(s.diary.find((e) => e.id === entry.id)!).calories,
    265,
  );
  assert.throws(() => saveRecipe(s, { ...recipe, finishedGrams: 0 }));
  assert.throws(() => logPortion(s, "recipe", recipe.id, 0, "Dinner", today()));
});
test("ownership, IDs, dates and references are checked at storage and mutation boundaries", () => {
  const s = seedNutrition();
  const originalSystem = structuredClone(s.foods[0]);
  assert.throws(() =>
    saveFood(s, { ...originalSystem, ownerId: s.user.id, source: "custom" }),
  );
  assert.throws(() => saveFood(s, { ...customFood(), ownerId: "other" }));
  assert.throws(() => logPortion(s, "food", "missing", 100, "Lunch", today()));
  assert.throws(() =>
    logPortion(s, "food", "oats", 100, "Lunch", "2026-02-30"),
  );
  assert.throws(() =>
    parseNutrition({ ...s, user: { ...s.user, id: "other" } }),
  );
  assert.throws(() =>
    parseNutrition({ ...s, diary: [...s.diary, s.diary[0]] }),
  );
  assert.throws(() => parseNutrition({ ...s, favorites: ["missing"] }));
  assert.throws(() =>
    parseNutrition({
      ...s,
      diary: s.diary.map((e, i) => (i === 0 ? { ...e, ownerId: "other" } : e)),
    }),
  );
  assert.throws(() =>
    editDiary(s, "other-entry", { grams: 100, meal: "Lunch", date: today() }),
  );
  const favorite = toggleFavorite(s, "oats");
  assert.ok(favorite.favorites.includes("oats"));
  assert.ok(!toggleFavorite(favorite, "oats").favorites.includes("oats"));
});
test("goals and preferences update independently with material macro mismatch information", () => {
  const s = seedNutrition();
  const changed = {
    ...s.goals,
    calories: 2100,
    protein: 140,
    carbs: 250,
    fat: 60,
  };
  assert.equal(macroCalories(changed), 2100);
  assert.equal(goalsDiffer(changed), false);
  assert.equal(goalsDiffer({ ...changed, calories: 3000 }), true);
  assert.deepEqual(saveGoals(s, changed).goals, changed);
  assert.throws(() => saveGoals(s, { ...changed, ownerId: "other" }));
  assert.throws(() => saveGoals(s, { ...changed, fat: -1 }));
  assert.equal(saveUser(s, { ...s.user, unit: "lb" }).user.unit, "lb");
  assert.throws(() => saveUser(s, { ...s.user, timeZone: "invalid" }));
  assert.equal(
    today("America/Los_Angeles", new Date("2026-10-10T01:00:00Z")),
    "2026-10-09",
  );
  assert.equal(shiftDate("2026-12-31", 1), "2027-01-01");
});
test("session replacement retains order and prescription while preserving templates and history", () => {
  const s = seedStore(),
    history = structuredClone(s.history),
    templates = structuredClone(s.templates);
  const entry = s.session.exercises[0];
  s.session.logs[entry.id][0].done = true;
  const next = replaceInSession(s, entry.id, "fly");
  assert.equal(next.session.exercises.length, s.session.exercises.length);
  assert.equal(next.session.exercises[0].exerciseId, "fly");
  assert.equal(
    next.session.exercises[0].prescription.plannedSets,
    entry.prescription.plannedSets,
  );
  assert.ok(
    next.session.logs[next.session.exercises[0].id].every(
      (set) => set.side === "both" && !set.done,
    ),
  );
  assert.ok(!next.session.logs[entry.id]);
  assert.deepEqual(next.history, history);
  assert.deepEqual(next.templates, templates);
  assert.doesNotThrow(() => parseStore(next));
  assert.throws(() =>
    replaceInSession(
      { ...s, session: { ...s.session, finished: true } },
      entry.id,
      "fly",
    ),
  );
});
