import { test } from "node:test";
import assert from "node:assert/strict";
import { PersistenceConflict, writeSnapshot } from "./persistence";
import { parseNutrition, seedNutrition } from "./nutrition";
import { parseStore, seedStore, finishSession } from "./tracker";
function storage() {
  const records = new Map<string, string>();
  return {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => {
      records.set(key, value);
    },
  };
}
test("snapshot persistence rejects stale writes and invalid records without modifying saved data", () => {
  const disk = storage();
  const s = seedNutrition();
  const original = writeSnapshot(disk, "nutrition", null, s, parseNutrition);
  const changed = { ...s, goals: { ...s.goals, calories: 2222 } };
  const latest = writeSnapshot(
    disk,
    "nutrition",
    original,
    changed,
    parseNutrition,
  );
  assert.throws(
    () => writeSnapshot(disk, "nutrition", original, s, parseNutrition),
    PersistenceConflict,
  );
  assert.equal(disk.getItem("nutrition"), latest);
  assert.throws(() =>
    writeSnapshot(
      disk,
      "nutrition",
      latest,
      { ...changed, diary: [...changed.diary, changed.diary[0]] },
      parseNutrition,
    ),
  );
  assert.equal(disk.getItem("nutrition"), latest);
  assert.equal(
    writeSnapshot(disk, "nutrition", original, changed, parseNutrition),
    latest,
  );
});
test("storage failures preserve the last persisted snapshot and do not mutate in-memory records", () => {
  const disk = storage();
  const s = seedStore();
  const original = writeSnapshot(disk, "workouts", null, s, parseStore);
  const completed = finishSession(s);
  const unavailable = {
    getItem: disk.getItem,
    setItem: () => {
      throw new Error("Quota exceeded");
    },
  };
  assert.throws(() =>
    writeSnapshot(unavailable, "workouts", original, completed, parseStore),
  );
  assert.equal(disk.getItem("workouts"), original);
  assert.equal(s.history.length + 1, completed.history.length);
  const saved = writeSnapshot(
    disk,
    "workouts",
    original,
    completed,
    parseStore,
  );
  assert.deepEqual(parseStore(JSON.parse(saved)), completed);
});
