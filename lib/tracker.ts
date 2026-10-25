import { exercises as samples } from "./workout";
import { groupSets } from "./unilateral";
import {
  exerciseSchema,
  plannedReps,
  legacySessionSchema,
  storeSchema,
  type Exercise,
  type ExerciseSet,
  type Prescription,
  type SessionExercise,
  type TrackerStore,
  type WorkoutSession,
  type WorkoutTemplate,
} from "./models";
export const USER_ID = "local-demo-user";
export const STORAGE_KEY = "form-tracker-v3";
export const newId = () => crypto.randomUUID();
const stamp = () => new Date().toISOString();
export function canReadExercise(exercise: Exercise, userId: string) {
  return exercise.source === "system" || exercise.ownerId === userId;
}
export function blankExercise(name: string, ownerId = USER_ID): Exercise {
  return {
    id: newId(),
    ownerId,
    source: "custom",
    name: name.trim(),
    primaryMuscle: null,
    secondaryMuscles: [],
    movementPattern: null,
    equipment: null,
    tags: [],
    trainingTypes: [],
    unilateral: false,
    coachingNotes: "",
    demoUrl: "",
    archived: false,
    createdAt: stamp(),
    updatedAt: stamp(),
  };
}
export function saveExercise(
  store: TrackerStore,
  value: Exercise,
): TrackerStore {
  const exercise = exerciseSchema.parse(value);
  const existing = store.library.find((e) => e.id === exercise.id);
  if (
    exercise.ownerId !== store.userId ||
    exercise.source !== "custom" ||
    (existing &&
      (existing.source !== "custom" || existing.ownerId !== store.userId))
  )
    throw new Error("Only your custom exercises can be edited.");
  return {
    ...store,
    library: existing
      ? store.library.map((e) =>
          e.id === exercise.id
            ? { ...exercise, createdAt: existing.createdAt, updatedAt: stamp() }
            : e,
        )
      : [...store.library, exercise],
  };
}
export type ExercisePerformance = {
  sessionId: string;
  entryId: string;
  date: string;
  name: string;
  mock: boolean;
  unilateral: boolean;
  sets: ExerciseSet[];
};
export function historyFor(
  store: TrackerStore,
  exerciseId: string,
  excludeSessionId = store.session.id,
  timeZone = "America/Los_Angeles",
): ExercisePerformance[] {
  return store.history
    .filter(
      (s) =>
        s.ownerId === store.userId && s.finished && s.id !== excludeSessionId,
    )
    .sort((a, b) => b.started - a.started)
    .flatMap((s) =>
      s.exercises
        .filter((e) => e.exerciseId === exerciseId)
        .map((e) => ({
          sessionId: s.id,
          entryId: e.id,
          date: new Intl.DateTimeFormat("en-CA", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date(s.completedAt ?? s.started)),
          name: e.snapshot.name,
          mock: s.mock,
          unilateral: e.snapshot.unilateral,
          sets: structuredClone(s.logs[e.id]),
        })),
    )
    .filter((h) => h.sets.some((s) => s.done));
}
export function createEntry(
  store: TrackerStore,
  exercise: Exercise,
  sessionId: string,
  prescription: Prescription = {
    plannedSets: 3,
    target: "8–12",
    note: exercise.coachingNotes,
  },
): { entry: SessionExercise; sets: ExerciseSet[] } {
  if (!canReadExercise(exercise, store.userId) || exercise.archived)
    throw new Error("Exercise is unavailable.");
  const entry: SessionExercise = {
    sameWeight: true,
    id: newId(),
    exerciseId: exercise.id,
    snapshot: structuredClone(exercise),
    prescription: structuredClone(prescription),
  };
  const previous =
    historyFor(
      store,
      exercise.id,
      store.session.finished ? "" : store.session.id,
    ).find((h) => h.unilateral === exercise.unilateral)?.sets ?? [];
  const previousGroups = groupSets(previous);
  const sets: ExerciseSet[] = [];
  for (let index = 0; index < prescription.plannedSets; index++) {
    const groupId = newId();
    for (const side of exercise.unilateral
      ? (["L", "R"] as const)
      : (["both"] as const)) {
      const prev = previousGroups[index]?.rows.find(
        (s) => s.side === side && s.done,
      );
      sets.push({
        id: newId(),
        groupId,
        ownerId: store.userId,
        sessionId,
        sessionExerciseId: entry.id,
        exerciseId: exercise.id,
        side,
        reps: prev?.reps ?? plannedReps(prescription.target),
        kg: prev?.kg ?? 0,
        rpe: prev?.rpe ?? "",
        done: false,
      });
    }
  }
  return { entry, sets };
}
export function addToSession(
  store: TrackerStore,
  exerciseId: string,
): TrackerStore {
  if (store.session.ownerId !== store.userId || store.session.finished)
    throw new Error("Resume or start a workout before adding an exercise.");
  const exercise = store.library.find((e) => e.id === exerciseId);
  if (!exercise) throw new Error("Exercise not found.");
  const { entry, sets } = createEntry(store, exercise, store.session.id);
  return {
    ...store,
    session: {
      ...store.session,
      exercises: [...store.session.exercises, entry],
      logs: { ...store.session.logs, [entry.id]: sets },
    },
  };
}
export function removeFromSession(
  store: TrackerStore,
  entryId: string,
): TrackerStore {
  if (store.session.ownerId !== store.userId || store.session.finished)
    throw new Error("Only your active session can be edited.");
  const logs = { ...store.session.logs };
  delete logs[entryId];
  return {
    ...store,
    session: {
      ...store.session,
      exercises: store.session.exercises.filter((e) => e.id !== entryId),
      logs,
    },
  };
}
export function move<T extends { id: string }>(
  items: T[],
  id: string,
  direction: -1 | 1,
): T[] {
  const index = items.findIndex((e) => e.id === id);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= items.length) return items;
  const result = [...items];
  [result[index], result[next]] = [result[next], result[index]];
  return result;
}
export function templateFromSession(
  store: TrackerStore,
  name: string,
): WorkoutTemplate {
  return {
    id: newId(),
    ownerId: store.userId,
    name: name.trim(),
    trainingType: store.session.trainingType,
    visibility: "private",
    exercises: store.session.exercises.map((e) => ({
      id: newId(),
      exerciseId: e.exerciseId,
      prescription: structuredClone(e.prescription),
    })),
    createdAt: stamp(),
    updatedAt: stamp(),
  };
}
export function startSession(
  store: TrackerStore,
  templateId: string,
): TrackerStore {
  const template = store.templates.find(
    (t) =>
      t.id === templateId &&
      (t.ownerId === store.userId || t.visibility === "public"),
  );
  if (!template) throw new Error("Template is unavailable.");
  const session: WorkoutSession = {
    id: newId(),
    ownerId: store.userId,
    templateId,
    name: template.name,
    trainingType: template.trainingType,
    exercises: [],
    logs: {},
    notes: "",
    unit: store.session.unit,
    finished: false,
    started: Date.now(),
    completedAt: null,
    mock: false,
  };
  for (const t of template.exercises) {
    const exercise = store.library.find((e) => e.id === t.exerciseId);
    if (
      !exercise ||
      exercise.archived ||
      !canReadExercise(exercise, store.userId)
    )
      throw new Error(
        "This template contains an archived or unavailable exercise. Replace or restore it first.",
      );
    const { entry, sets } = createEntry(
      store,
      exercise,
      session.id,
      t.prescription,
    );
    session.exercises.push(entry);
    session.logs[entry.id] = sets;
  }
  return { ...store, session };
}
export function finishSession(store: TrackerStore): TrackerStore {
  if (store.session.ownerId !== store.userId)
    throw new Error("Session is private to its owner.");
  const session = { ...store.session, finished: true, completedAt: stamp() };
  return {
    ...store,
    session,
    history: [
      ...store.history.filter((s) => s.id !== session.id),
      structuredClone(session),
    ],
  };
}
// A strict allowlist: never serialize session logs, history, notes, or ownership identifiers.
export function shareableTemplate(
  store: TrackerStore,
  template: WorkoutTemplate,
) {
  if (template.ownerId !== store.userId && template.visibility !== "public")
    throw new Error("Template is private.");
  return {
    schemaVersion: 1,
    name: template.name,
    trainingType: template.trainingType,
    exercises: template.exercises.map((entry) => {
      const exercise = store.library.find(
        (e) => e.id === entry.exerciseId && canReadExercise(e, store.userId),
      );
      if (!exercise) throw new Error("Exercise is unavailable.");
      return {
        prescription: structuredClone(entry.prescription),
        exercise: {
          id: exercise.id,
          name: exercise.name,
          primaryMuscle: exercise.primaryMuscle,
          secondaryMuscles: [...exercise.secondaryMuscles],
          equipment: exercise.equipment,
          movementPattern: exercise.movementPattern,
          tags: [...exercise.tags],
          trainingTypes: [...exercise.trainingTypes],
          unilateral: exercise.unilateral,
          coachingNotes: exercise.coachingNotes,
          demoUrl: exercise.demoUrl,
        },
      };
    }),
  };
}
export function seedStore(): TrackerStore {
  const date = "2026-10-01T12:00:00.000Z";
  const library: Exercise[] = samples.map((e, i) => ({
    id: e.id,
    ownerId: null,
    source: "system",
    name: e.name,
    primaryMuscle: ["Lats", "Chest", "Upper back", "Chest"][
      i
    ] as Exercise["primaryMuscle"],
    secondaryMuscles:
      i === 0 || i === 2 ? ["Biceps"] : i === 3 ? ["Triceps", "Shoulders"] : [],
    movementPattern: [
      "Vertical pull",
      "Isolation",
      "Horizontal pull",
      "Horizontal push",
    ][i] as Exercise["movementPattern"],
    equipment: i === 3 ? "Smith machine" : "Cable",
    tags: [],
    trainingTypes: ["hypertrophy"],
    unilateral: e.unilateral,
    coachingNotes: e.note,
    demoUrl: "",
    archived: false,
    createdAt: date,
    updatedAt: date,
  }));
  library.push({
    ...blankExercise("Dumbbell lateral raise"),
    id: "sample-custom-lateral-raise",
    primaryMuscle: "Shoulders",
    equipment: "Dumbbell",
    movementPattern: "Isolation",
    tags: ["Shoulder day"],
    trainingTypes: ["hypertrophy"],
    createdAt: date,
    updatedAt: date,
  });
  const template: WorkoutTemplate = {
    id: "template-upper-a",
    ownerId: USER_ID,
    name: "Upper body A",
    trainingType: "hypertrophy",
    visibility: "private",
    exercises: samples.map((e) => ({
      id: "plan-" + e.id,
      exerciseId: e.id,
      prescription: {
        plannedSets: e.plannedSets,
        target: e.target,
        note: e.note,
      },
    })),
    createdAt: date,
    updatedAt: date,
  };
  const history: WorkoutSession[] = samples[0].history.map((h, index) => {
    const sessionId = "mock-session-" + index;
    const entries = samples.map((e) => ({
      id: e.id,
      exerciseId: e.id,
      snapshot: structuredClone(library.find((l) => l.id === e.id)!),
      sameWeight: true,
      prescription: {
        plannedSets: e.plannedSets,
        target: e.target,
        note: e.note,
      },
    }));
    return {
      id: sessionId,
      ownerId: USER_ID,
      templateId: template.id,
      name: "Upper body A",
      trainingType: "hypertrophy",
      exercises: entries,
      logs: Object.fromEntries(
        samples.map((e) => [
          e.id,
          e.history[index].sets.map((s, i) => ({
            ...s,
            id: `${sessionId}-${e.id}-${i}`,
            groupId: `${sessionId}-${e.id}-group-${e.unilateral ? Math.floor(i / 2) : i}`,
            ownerId: USER_ID,
            sessionId,
            sessionExerciseId: e.id,
            exerciseId: e.id,
            rpe: "",
            done: true,
          })),
        ]),
      ),
      notes: "",
      unit: "kg",
      finished: true,
      started: new Date(h.date + "T12:00:00Z").getTime(),
      completedAt: h.date + "T13:00:00Z",
      mock: true,
    };
  });
  const empty: WorkoutSession = {
    id: "initial-session",
    ownerId: USER_ID,
    templateId: template.id,
    name: template.name,
    trainingType: "hypertrophy",
    exercises: [],
    logs: {},
    notes: "",
    unit: "kg",
    finished: false,
    started: Date.now(),
    completedAt: null,
    mock: false,
  };
  const store: TrackerStore = {
    version: 3,
    userId: USER_ID,
    library,
    templates: [template],
    session: empty,
    history,
  };
  const fresh = startSession(store, template.id); // Preserve entry keys for migration and the original sample workout.
  fresh.session.id = "initial-session";
  fresh.session.exercises = fresh.session.exercises.map((e, i) => ({
    ...e,
    id: samples[i].id,
  }));
  fresh.session.logs = Object.fromEntries(
    Object.values(fresh.session.logs).map((sets, i) => [
      samples[i].id,
      sets.map((s) => ({
        ...s,
        sessionId: "initial-session",
        sessionExerciseId: samples[i].id,
      })),
    ]),
  );
  return fresh;
}
export function parseStore(value: unknown): TrackerStore {
  return validateStore(value, USER_ID);
}
/** Client integrity checks only; the server independently derives the authenticated owner. */
export function validateStore(
  value: unknown,
  expectedUserId: string,
): TrackerStore {
  const s = storeSchema.parse(value);
  if (s.userId !== expectedUserId) throw new Error("Unknown local owner.");
  const unique = (items: { id: string }[]) =>
    new Set(items.map((e) => e.id)).size === items.length;
  if (!unique(s.library) || !unique(s.templates) || !unique(s.history))
    throw new Error("Duplicate IDs.");
  if (
    s.library.some((e) => !canReadExercise(e, s.userId)) ||
    s.templates.some((t) => t.ownerId !== s.userId)
  )
    throw new Error("Ownership mismatch.");
  for (const t of s.templates)
    if (
      !unique(t.exercises) ||
      t.exercises.some((e) => !s.library.some((l) => l.id === e.exerciseId))
    )
      throw new Error("Invalid template reference.");
  for (const session of [s.session, ...s.history]) {
    if (
      session.ownerId !== s.userId ||
      !unique(session.exercises) ||
      Object.keys(session.logs).length !== session.exercises.length
    )
      throw new Error("Invalid session.");
    for (const e of session.exercises) {
      if (
        e.exerciseId !== e.snapshot.id ||
        !canReadExercise(e.snapshot, s.userId) ||
        !s.library.some((l) => l.id === e.exerciseId) ||
        !session.logs[e.id] ||
        !unique(session.logs[e.id]) ||
        session.logs[e.id].some(
          (v) =>
            v.sessionId !== session.id ||
            v.sessionExerciseId !== e.id ||
            v.exerciseId !== e.exerciseId ||
            v.ownerId !== s.userId,
        )
      )
        throw new Error("Invalid set reference.");
      for (const group of groupSets(session.logs[e.id])) {
        const sides = group.rows.map((s) => s.side);
        if (
          e.snapshot.unilateral
            ? sides.length !== 2 || !sides.includes("L") || !sides.includes("R")
            : sides.length !== 1 || sides[0] !== "both"
        )
          throw new Error("Invalid set pairing.");
      }
    }
  }
  return s;
}
export function migrateLegacy(value: unknown): TrackerStore {
  const store = seedStore();
  const old = legacySessionSchema.parse(value);
  const session = {
    ...store.session,
    notes: old.notes,
    unit: old.unit,
    finished: old.finished,
    started: old.started,
  };
  session.logs = Object.fromEntries(
    session.exercises.map((e) => [
      e.id,
      old.logs[e.id].map((v, i) => ({
        ...v,
        groupId: `${session.id}-${e.id}-group-${e.snapshot.unilateral ? Math.floor(i / 2) : i}`,
        ownerId: store.userId,
        sessionId: session.id,
        sessionExerciseId: e.id,
        exerciseId: e.exerciseId,
      })),
    ]),
  );
  store.session = session;
  return parseStore(old.finished ? finishSession(store) : store);
}
export function saveTemplate(
  store: TrackerStore,
  template: WorkoutTemplate,
): TrackerStore {
  const existing = store.templates.find((t) => t.id === template.id);
  if (
    template.ownerId !== store.userId ||
    (existing && existing.ownerId !== store.userId)
  )
    throw new Error("Only your templates can be edited.");
  const candidate = {
    ...store,
    templates: existing
      ? store.templates.map((t) =>
          t.id === template.id
            ? { ...structuredClone(template), updatedAt: stamp() }
            : t,
        )
      : [...store.templates, structuredClone(template)],
  };
  return validateStore(candidate, store.userId);
}

export function migrateV2(value: unknown): TrackerStore {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 2
  )
    throw new Error("Invalid v2 data.");
  const raw = structuredClone(value) as {
    version: number;
    session: WorkoutSession;
    history: WorkoutSession[];
  };
  for (const session of [raw.session, ...raw.history]) {
    for (const entry of session.exercises) {
      entry.sameWeight = true;
      session.logs[entry.id] = session.logs[entry.id].map((set, index) => ({
        ...set,
        groupId: `${session.id}-${entry.id}-group-${entry.snapshot.unilateral ? Math.floor(index / 2) : index}`,
      }));
    }
  }
  raw.version = 3;
  return parseStore(raw);
}

/** Replace an active entry in place; historical sessions and templates are immutable. */
export function replaceInSession(
  store: TrackerStore,
  entryId: string,
  exerciseId: string,
): TrackerStore {
  if (store.session.ownerId !== store.userId || store.session.finished)
    throw new Error("Only your active session can be edited.");
  const old = store.session.exercises.find((e) => e.id === entryId);
  const exercise = store.library.find((e) => e.id === exerciseId);
  if (!old || !exercise) throw new Error("Exercise is unavailable.");
  const { entry, sets } = createEntry(store, exercise, store.session.id, {
    ...old.prescription,
    note: exercise.coachingNotes,
  });
  const logs = { ...store.session.logs };
  delete logs[entryId];
  logs[entry.id] = sets;
  return {
    ...store,
    session: {
      ...store.session,
      exercises: store.session.exercises.map((e) =>
        e.id === entryId ? entry : e,
      ),
      logs,
    },
  };
}
