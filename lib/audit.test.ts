import { test } from "node:test";
import assert from "node:assert/strict";
import {
  seedStore,
  saveTemplate,
  startSession,
  parseStore,
  finishSession,
  historyFor,
} from "./tracker";
import { appendSet } from "./unilateral";
import {
  dayTotals,
  seedNutrition,
  logPortion,
  editDiary,
  deleteDiary,
  parseNutrition,
  recipePer100g,
  saveRecipe,
  recipeTotal,
} from "./nutrition";
import { volume } from "./workout";

test("free-text rep targets cannot produce invalid sets in a new workout or added pair", () => {
  let s = seedStore();
  const t = structuredClone(s.templates[0]);
  t.exercises[0].prescription.target = "1000–1200";
  s = saveTemplate(s, t);
  // Remove matching previous performance to test target-derived initial values.
  s.history = [];
  s = startSession(s, t.id);
  assert.equal(s.session.logs[s.session.exercises[0].id][0].reps, 999);
  s.session.logs[s.session.exercises[0].id] = [];
  s.session = appendSet(s.session, s.session.exercises[0].id);
  assert.equal(s.session.logs[s.session.exercises[0].id][0].reps, 999);
  assert.doesNotThrow(() => parseStore(JSON.parse(JSON.stringify(s))));
});

test("daily totals and snapshot values stay independent when reassigning or deleting entries", () => {
  let s = seedNutrition();
  const a = "2026-12-01",
    b = "2026-12-02";
  s = logPortion(s, "food", "rice-dry", 75.5, "Breakfast", a);
  const entry = structuredClone(s.diary.at(-1)!);
  assert.equal(dayTotals(s, a).calories, 271.8);
  s = editDiary(s, entry.id, { date: b, meal: "Dinner", grams: 50 });
  assert.equal(dayTotals(s, a).calories, 0);
  assert.equal(dayTotals(s, b).calories, 180);
  assert.deepEqual(s.diary.at(-1)!.snapshot, entry.snapshot);
  s = parseNutrition(JSON.parse(JSON.stringify(s)));
  s = deleteDiary(s, entry.id);
  assert.equal(dayTotals(s, b).calories, 0);
  assert.throws(() => deleteDiary(s, entry.id));
});

test("recipe yield scales nutrients once and zero yield is rejected without changing a saved recipe", () => {
  let s = seedNutrition();
  const food = s.foods.find((f) => f.id === "rice-dry")!;
  const r = {
    id: "audit-recipe",
    ownerId: s.user.id,
    name: "Cooked rice",
    finishedGrams: 300,
    ingredients: [
      {
        id: "ingredient",
        foodId: food.id,
        grams: 100,
        snapshot: structuredClone(food),
      },
    ],
    updatedAt: new Date().toISOString(),
  };
  assert.equal(recipeTotal(r).calories, 360);
  assert.equal(recipePer100g(r).calories, 120);
  s = saveRecipe(s, r);
  const snapshot = structuredClone(s.recipes);
  assert.throws(() => saveRecipe(s, { ...r, finishedGrams: 0 }));
  assert.deepEqual(s.recipes, snapshot);
});

test("repeated workout finish never duplicates a session; draft edits leave historical volume frozen", () => {
  let s = seedStore();
  const [entry] = s.session.exercises;
  s.session.logs[entry.id][0] = {
    ...s.session.logs[entry.id][0],
    kg: 30,
    reps: 10,
    done: true,
  };
  s = finishSession(s);
  const completed = structuredClone(
    s.history.find((h) => h.id === s.session.id)!,
  );
  s = finishSession(s);
  assert.equal(s.history.filter((h) => h.id === s.session.id).length, 1);
  s.session.logs[entry.id][0].kg = 99;
  assert.equal(volume(completed.logs[entry.id]), 300);
  assert.equal(
    volume(s.history.find((h) => h.id === s.session.id)!.logs[entry.id]),
    300,
  );
  assert.equal(historyFor(s, entry.exerciseId, "")[0].sets[0].kg, 30);
});

test("exercise history calendar dates agree with the selected user time zone across UTC midnight", () => {
  const s = seedStore();
  const history = s.history[0];
  history.completedAt = "2026-10-18T01:00:00Z";
  assert.equal(
    historyFor(s, history.exercises[0].exerciseId, "", "America/Los_Angeles")[0]
      .date,
    "2026-10-17",
  );
  assert.equal(
    historyFor(s, history.exercises[0].exerciseId, "", "UTC")[0].date,
    "2026-10-18",
  );
});

test("invalid historical timestamps are rejected at restore instead of crashing history rendering", () => {
  const s = seedStore();
  assert.throws(() =>
    parseStore({
      ...s,
      history: s.history.map((h, i) =>
        i ? h : { ...h, completedAt: "invalid date" },
      ),
    }),
  );
  assert.throws(() =>
    parseStore({ ...s, session: { ...s.session, started: 1e100 } }),
  );
});

test("raw and cooked food definitions retain distinct values and preparation snapshots", () => {
  let s = seedNutrition();
  const date = "2026-12-03";
  s = logPortion(s, "food", "chicken-raw", 200, "Lunch", date);
  assert.equal(dayTotals(s, date).calories, 240);
  assert.equal(s.diary.at(-1)!.snapshot.preparation, "raw");
  s = logPortion(s, "food", "chicken-cooked", 200, "Dinner", date);
  assert.equal(dayTotals(s, date).calories, 570);
  assert.equal(s.diary.at(-1)!.snapshot.preparation, "cooked");
  assert.deepEqual(
    s.diary.slice(-2).map((e) => e.snapshot.per100g.calories),
    [120, 165],
  );
});
