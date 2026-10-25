import { test } from "node:test";
import assert from "node:assert/strict";
import { exercises as samples, initialSets } from "./workout";
import {
  addToSession,
  blankExercise,
  finishSession,
  historyFor,
  migrateLegacy,
  move,
  parseStore,
  saveExercise,
  saveTemplate,
  seedStore,
  shareableTemplate,
  startSession,
  templateFromSession,
} from "./tracker";
test("stable IDs and snapshots preserve history after rename, archive and template edits", () => {
  let store = seedStore();
  const custom = blankExercise("My row");
  store = saveExercise(store, custom);
  store = addToSession(store, custom.id);
  const entry = store.session.exercises.at(-1)!;
  store.session.logs[entry.id][0] = {
    ...store.session.logs[entry.id][0],
    reps: 12,
    kg: 30,
    done: true,
  };
  store.session.notes = "private workout note";
  store = finishSession(store);
  const historical = structuredClone(store.history.at(-1));
  store = saveExercise(store, {
    ...custom,
    name: "Renamed row",
    primaryMuscle: "Upper back",
    tags: ["home", "favourite"],
  });
  assert.equal(store.library.at(-1)?.id, custom.id);
  assert.equal(historyFor(store, custom.id, "")[0].name, "My row");
  assert.equal(historyFor(store, custom.id, "")[0].sets[0].kg, 30);
  assert.deepEqual(store.history.at(-1), historical);
  const template = templateFromSession(store, "Custom day");
  store = saveTemplate(store, template);
  store = startSession(store, template.id);
  const current = store.session.exercises.at(-1)!;
  assert.equal(current.snapshot.name, "Renamed row");
  assert.equal(store.session.logs[current.id][0].kg, 30);
  assert.ok(store.session.logs[current.id].every((s) => !s.done));
  const before = structuredClone(store.session);
  store = saveTemplate(store, {
    ...template,
    name: "New plan name",
    exercises: move(template.exercises, template.exercises[0].id, 1),
  });
  assert.deepEqual(store.session, before);
  store = saveExercise(store, {
    ...store.library.find((e) => e.id === custom.id)!,
    archived: true,
  });
  assert.throws(() => addToSession(store, custom.id), /unavailable/);
  assert.throws(() => startSession(store, template.id), /archived/);
  assert.deepEqual(store.history.at(-1), historical);
  assert.doesNotThrow(() => parseStore(store));
});
test("ownership guards reject system edits, foreign records and forged set references", () => {
  const store = seedStore();
  assert.throws(
    () =>
      saveExercise(store, {
        ...store.library[0],
        source: "custom",
        ownerId: store.userId,
      }),
    /Only your/,
  );
  assert.throws(
    () => saveExercise(store, blankExercise("Foreign", "someone-else")),
    /Only your/,
  );
  assert.throws(
    () =>
      saveTemplate(store, { ...store.templates[0], ownerId: "someone-else" }),
    /Only your/,
  );
  const forged = structuredClone(store);
  forged.session.logs.pulldown[0].ownerId = "someone-else";
  assert.throws(() => parseStore(forged), /set reference/);
});
test("share export contains prescriptions and exercise metadata, never private sessions", () => {
  const store = seedStore();
  store.session.notes = "SECRET";
  store.session.logs.pulldown[0].kg = 876;
  const publicPlan = shareableTemplate(store, store.templates[0]);
  const json = JSON.stringify(publicPlan);
  assert.ok(json.includes("primaryMuscle"));
  assert.ok(!json.includes("SECRET"));
  assert.ok(!json.includes("876"));
  for (const key of ["ownerId", "sessionId", "logs", "history", "completedAt"])
    assert.ok(!json.includes(`"${key}"`));
});
test("v1 migration retains logged results, units and completion without erasing fixtures", () => {
  const old = {
    logs: Object.fromEntries(samples.map((e) => [e.id, initialSets(e)])),
    notes: "saved note",
    unit: "lb",
    finished: false,
    started: 12345,
  };
  old.logs.pulldown[0].done = true;
  old.logs.pulldown[0].kg = 31;
  const store = migrateLegacy(old);
  assert.equal(store.session.logs.pulldown[0].kg, 31);
  assert.equal(store.session.logs.pulldown[0].done, true);
  assert.equal(store.session.unit, "lb");
  assert.equal(store.history.length, 3);
  assert.doesNotThrow(() => parseStore(store));
  assert.throws(() => migrateLegacy({ ...old, logs: {} }));
});
test("session-only additions do not change templates; repeated exercises have independent IDs", () => {
  let store = seedStore();
  const template = structuredClone(store.templates[0]);
  store = addToSession(store, "pulldown");
  const entries = store.session.exercises.filter(
    (e) => e.exerciseId === "pulldown",
  );
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].id, entries[1].id);
  assert.deepEqual(store.templates[0], template);
  assert.doesNotThrow(() => parseStore(store));
});
