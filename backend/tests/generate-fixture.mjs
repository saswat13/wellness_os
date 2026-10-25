// Synthetic fixtures only. Never reads browser storage or user exports.
import { readFileSync, writeFileSync } from "node:fs";
import { parseStore, seedStore } from "../../lib/tracker.ts";
import {
  dayTotals,
  parseNutrition,
  recipePer100g,
  recipeTotal,
  seedNutrition,
} from "../../lib/nutrition.ts";
import { sessionCounts } from "../../lib/unilateral.ts";
import { volume } from "../../lib/workout.ts";
const location = new URL("./fixtures/browser-export.json", import.meta.url);
const regenerate = process.argv.includes("--regenerate");
const raw = regenerate
  ? { exportVersion: 1, workouts: seedStore(), nutrition: seedNutrition() }
  : JSON.parse(readFileSync(location, "utf8"));
const workouts = parseStore(raw.workouts);
const nutrition = parseNutrition(raw.nutrition);
if (regenerate) writeFileSync(location, JSON.stringify(raw, null, 2) + "\n");
const parity = {
  days: [...new Set(nutrition.diary.map((x) => x.date))].map((date) => ({
    date,
    totals: dayTotals(nutrition, date),
  })),
  workouts: workouts.history.map((s) => ({
    id: s.id,
    volume: Object.values(s.logs).reduce((sum, rows) => sum + volume(rows), 0),
    counts: sessionCounts(s),
  })),
  recipes: nutrition.recipes.map((r) => ({
    id: r.id,
    total: recipeTotal(r),
    per100g: recipePer100g(r),
  })),
};
writeFileSync(
  new URL("./fixtures/calculation-parity.json", import.meta.url),
  JSON.stringify(parity, null, 2) + "\n",
);
