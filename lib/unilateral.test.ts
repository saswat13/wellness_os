import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addToSession,
  blankExercise,
  finishSession,
  historyFor,
  migrateV2,
  parseStore,
  saveExercise,
  saveTemplate,
  seedStore,
  startSession,
  templateFromSession,
} from "./tracker";
import {
  appendSet,
  editSide,
  groupSets,
  removeSetGroup,
  sessionCounts,
  setCounts,
  sideComparison,
} from "./unilateral";
import { volume } from "./workout";
function customStore() {
  let store = seedStore();
  const exercise = { ...blankExercise("Unilateral row"), unilateral: true };
  store = saveExercise(store, exercise);
  store = addToSession(store, exercise.id);
  const entry = store.session.exercises.at(-1)!;
  return { store, exercise, entry };
}

test("one pair counts once, partial completion persists and both sides contribute volume", () => {
  const store = seedStore();
  let sets = store.session.logs.pulldown;
  sets = editSide(sets, sets[0].id, { done: true, reps: 10, kg: 20 }, false);
  assert.deepEqual(setCounts(sets), {
    total: 3,
    completed: 0,
    partial: 1,
    completedSides: 1,
  });
  assert.equal(volume(sets), 200);
  sets = editSide(sets, sets[1].id, { done: true, reps: 8, kg: 18 }, false);
  assert.equal(setCounts(sets).completed, 1);
  assert.equal(volume(sets), 344);
  store.session.logs.pulldown = sets;
  assert.equal(sessionCounts(store.session).total, 12);
  assert.equal(sessionCounts(store.session).completed, 1);
  const parsed = parseStore(store);
  assert.equal(parsed.session.logs.pulldown[0].done, true);
  assert.equal(parsed.session.logs.pulldown[1].done, true);
});
test("shared weight copies only within a pair while reps/RPE/completion stay independent", () => {
  const { session } = seedStore();
  const original = session.logs.pulldown;
  let sets = editSide(original, original[0].id, { kg: 30 }, true);
  assert.equal(sets[1].kg, 30);
  assert.equal(sets[2].kg, original[2].kg);
  sets = editSide(sets, sets[0].id, { reps: 9, rpe: "8", done: true }, true);
  assert.equal(sets[1].reps, 12);
  assert.equal(sets[1].rpe, "");
  assert.equal(sets[1].done, false);
  sets = editSide(sets, sets[1].id, { kg: 24, rpe: "9" }, false);
  assert.equal(sets[0].kg, 30);
  assert.equal(sets[1].kg, 24);
  assert.equal(sets[0].rpe, "8");
  assert.equal(sets[1].rpe, "9");
  assert.equal(original[0].kg, 22.5);
});
test("side-specific prefill retains unequal loads/RPE and never shifts a missing side into another pair", () => {
  const initial = customStore();
  let store = initial.store;
  const { exercise, entry } = initial;
  const sets = store.session.logs[entry.id];
  sets[0] = { ...sets[0], kg: 25, reps: 10, rpe: "8", done: true };
  sets[1] = { ...sets[1], kg: 20, reps: 8, rpe: "9", done: true };
  sets[3] = { ...sets[3], kg: 17, reps: 7, rpe: "7", done: true };
  sets[4] = { ...sets[4], kg: 99, reps: 99, done: false };
  store = finishSession(store);
  const history = historyFor(store, exercise.id, "")[0];
  assert.equal(history.sets.length, 6);
  assert.equal(history.sets[2].done, false);
  const template = templateFromSession(store, "Side day");
  store = saveTemplate(store, template);
  store = startSession(store, template.id);
  const next = store.session.exercises.find(
    (e) => e.exerciseId === exercise.id,
  )!;
  const rows = store.session.logs[next.id];
  assert.deepEqual(
    rows.map((s) => [s.side, s.kg, s.reps, s.rpe]),
    [
      ["L", 25, 10, "8"],
      ["R", 20, 8, "9"],
      ["L", 0, 8, ""],
      ["R", 17, 7, "7"],
      ["L", 0, 8, ""],
      ["R", 0, 8, ""],
    ],
  );
  assert.ok(rows.every((s) => !s.done));
  assert.equal(next.sameWeight, true);
});
test("pair append/remove uses stable IDs, preserves opposite-side values and survives reordered rows", () => {
  let { session } = seedStore();
  session.logs.pulldown = editSide(
    session.logs.pulldown,
    session.logs.pulldown[4].id,
    { kg: 30, reps: 11, done: true },
    false,
  );
  session.logs.pulldown = editSide(
    session.logs.pulldown,
    session.logs.pulldown[5].id,
    { kg: 24, reps: 9 },
    false,
  );
  const originalIds = groupSets(session.logs.pulldown).map((g) => g.id);
  session = appendSet(session, "pulldown");
  const added = groupSets(session.logs.pulldown).at(-1)!;
  assert.deepEqual(
    added.rows.map((s) => [s.side, s.kg, s.reps, s.done]),
    [
      ["L", 30, 11, false],
      ["R", 24, 9, false],
    ],
  );
  assert.notEqual(added.rows[0].id, added.rows[1].id);
  session.logs.pulldown = [...session.logs.pulldown].reverse();
  session = removeSetGroup(session, "pulldown", added.id);
  assert.equal(session.logs.pulldown.length, 6);
  assert.ok(
    originalIds.every((id) =>
      session.logs.pulldown.some((s) => s.groupId === id),
    ),
  );
  assert.equal(
    session.logs.pulldown.find((s) => s.side === "L" && s.kg === 30)?.done,
    true,
  );
});
test("switching back to bilateral creates bilateral future logs and keeps original left/right history", () => {
  const initial = customStore();
  let store = initial.store;
  const { exercise, entry } = initial;
  store.session.logs[entry.id][0] = {
    ...store.session.logs[entry.id][0],
    done: true,
    kg: 30,
  };
  store.session.logs[entry.id][1] = {
    ...store.session.logs[entry.id][1],
    done: true,
    kg: 22,
  };
  store = finishSession(store);
  const before = structuredClone(store.history);
  const template = templateFromSession(store, "Both day");
  store = saveTemplate(store, template);
  store = saveExercise(store, { ...exercise, unilateral: false });
  assert.equal(store.session.exercises.at(-1)?.snapshot.unilateral, true);
  store = startSession(store, template.id);
  const next = store.session.exercises.find(
    (e) => e.exerciseId === exercise.id,
  )!;
  assert.equal(next.snapshot.unilateral, false);
  assert.deepEqual(
    store.session.logs[next.id].map((s) => s.side),
    ["both", "both", "both"],
  );
  assert.deepEqual(store.history, before);
  assert.equal(historyFor(store, exercise.id, "")[0].unilateral, true);
  assert.equal(historyFor(store, exercise.id, "")[0].sets[1].kg, 22);
  assert.doesNotThrow(() => parseStore(store));
});
test("v2 migration adds groups without mutating unequal values, RPE or partial completion", () => {
  const original = seedStore();
  original.session.logs.pulldown[0] = {
    ...original.session.logs.pulldown[0],
    kg: 29,
    reps: 11,
    rpe: "8",
    done: true,
  };
  original.session.logs.pulldown[1] = {
    ...original.session.logs.pulldown[1],
    kg: 23,
    reps: 9,
    rpe: "9",
    done: false,
  };
  const old = JSON.parse(JSON.stringify(original));
  old.version = 2;
  for (const session of [old.session, ...old.history]) {
    for (const entry of session.exercises) delete entry.sameWeight;
    for (const rows of Object.values(session.logs) as Record<
      string,
      unknown
    >[][])
      for (const row of rows) delete row.groupId;
  }
  const preserved = structuredClone(old);
  const migrated = migrateV2(old);
  assert.deepEqual(old, preserved);
  assert.equal(migrated.version, 3);
  assert.equal(
    migrated.session.logs.pulldown[0].groupId,
    migrated.session.logs.pulldown[1].groupId,
  );
  assert.notEqual(
    migrated.session.logs.pulldown[1].groupId,
    migrated.session.logs.pulldown[2].groupId,
  );
  assert.equal(migrated.session.logs.pulldown[1].kg, 23);
  assert.equal(migrated.session.logs.pulldown[1].rpe, "9");
  assert.equal(setCounts(migrated.session.logs.pulldown).partial, 1);
  assert.equal(migrated.session.exercises[0].sameWeight, true);
});
test("comparison uses completed sides and excludes partial pairs from matched-volume differences", () => {
  let sets = seedStore().session.logs.pulldown;
  sets = editSide(
    sets,
    sets[0].id,
    { done: true, kg: 20, reps: 10, rpe: "8" },
    false,
  );
  sets = editSide(
    sets,
    sets[1].id,
    { done: true, kg: 18, reps: 9, rpe: "7" },
    false,
  );
  sets = editSide(
    sets,
    sets[2].id,
    { done: true, kg: 25, reps: 6, rpe: "9" },
    false,
  );
  const stats = sideComparison(sets);
  assert.equal(stats.left.volume, 350);
  assert.equal(stats.right.volume, 162);
  assert.equal(stats.matchedPairs, 1);
  assert.equal(stats.matchedVolumeDelta, -38);
  assert.equal(stats.left.averageRpe, 8.5);
  assert.equal(stats.right.averageRpe, 7);
  const other = sets
    .slice(0, 2)
    .map((s) => ({ ...s, sessionId: "different-session" }));
  assert.equal(sideComparison([...sets, ...other]).matchedPairs, 2);
});
test("persistence rejects malformed pairs and forged ownership references", () => {
  const bad = seedStore();
  bad.session.logs.pulldown[1].side = "L";
  assert.throws(() => parseStore(bad), /pairing/);
  const missing = seedStore();
  missing.session.logs.pulldown.splice(1, 1);
  assert.throws(() => parseStore(missing), /pairing/);
  const owner = seedStore();
  owner.session.logs.pulldown[1].ownerId = "foreign";
  assert.throws(() => parseStore(owner), /reference/);
});
