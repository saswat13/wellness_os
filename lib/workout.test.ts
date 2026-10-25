import { test } from "node:test";
import assert from "node:assert/strict";
import { exercises, initialSets, volume, displayLoad, toKg } from "./workout";
test("prefill actual history without completing sets or changing planned targets", () => {
  const sets = initialSets(exercises[0]);
  assert.equal(sets.length, 6);
  assert.deepEqual(
    sets.map((s) => s.side),
    ["L", "R", "L", "R", "L", "R"],
  );
  assert.ok(sets.every((s) => !s.done));
  assert.equal(exercises[0].plannedSets, 3);
});
test("volume counts only completed entries including each unilateral side", () => {
  assert.equal(
    volume([
      { kg: 20, reps: 10, done: true },
      { kg: 20, reps: 9, done: true },
      { kg: 100, reps: 10, done: false },
    ]),
    380,
  );
});
test("unit conversion preserves canonical loads", () => {
  assert.ok(Math.abs(toKg(displayLoad(40, "lb"), "lb") - 40) < 0.03);
});
