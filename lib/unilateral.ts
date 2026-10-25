import { plannedReps, type ExerciseSet, type WorkoutSession } from "./models";
export type SetGroup = {
  id: string;
  rows: ExerciseSet[];
  complete: boolean;
  partial: boolean;
};
export function groupSets(sets: ExerciseSet[]): SetGroup[] {
  const groups = new Map<string, ExerciseSet[]>();
  for (const set of sets) {
    const key = JSON.stringify([
      set.sessionId,
      set.sessionExerciseId,
      set.groupId,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), set]);
  }
  return [...groups.values()].map((rows) => {
    const id = rows[0].groupId;
    rows.sort(
      (a, b) =>
        ["both", "L", "R"].indexOf(a.side) - ["both", "L", "R"].indexOf(b.side),
    );
    const complete =
      rows.length === 1 && rows[0].side === "both"
        ? rows[0].done
        : rows.length === 2 &&
          rows.some((s) => s.side === "L" && s.done) &&
          rows.some((s) => s.side === "R" && s.done);
    return {
      id,
      rows,
      complete,
      partial: !complete && rows.some((s) => s.done),
    };
  });
}
export function setCounts(sets: ExerciseSet[]) {
  const groups = groupSets(sets);
  return {
    total: groups.length,
    completed: groups.filter((g) => g.complete).length,
    partial: groups.filter((g) => g.partial).length,
    completedSides: sets.filter((s) => s.done).length,
  };
}
export function sessionCounts(session: WorkoutSession) {
  return session.exercises.reduce(
    (sum, e) => {
      const c = setCounts(session.logs[e.id]);
      return {
        total: sum.total + c.total,
        completed: sum.completed + c.completed,
        partial: sum.partial + c.partial,
        completedSides: sum.completedSides + c.completedSides,
      };
    },
    { total: 0, completed: 0, partial: 0, completedSides: 0 },
  );
}
export function editSide(
  sets: ExerciseSet[],
  setId: string,
  patch: Partial<Pick<ExerciseSet, "reps" | "kg" | "rpe" | "done">>,
  sameWeight: boolean,
): ExerciseSet[] {
  const target = sets.find((s) => s.id === setId);
  if (!target) return sets;
  return sets.map((s) =>
    s.id === setId
      ? { ...s, ...patch }
      : sameWeight &&
          target.side !== "both" &&
          s.groupId === target.groupId &&
          patch.kg !== undefined
        ? { ...s, kg: patch.kg }
        : s,
  );
}
export function appendSet(
  session: WorkoutSession,
  entryId: string,
): WorkoutSession {
  const entry = session.exercises.find((e) => e.id === entryId);
  if (!entry) return session;
  const previous = groupSets(session.logs[entryId]).at(-1)?.rows ?? [];
  const groupId = crypto.randomUUID();
  const added: ExerciseSet[] = (
    entry.snapshot.unilateral ? (["L", "R"] as const) : (["both"] as const)
  ).map((side) => {
    const last = previous.find((s) => s.side === side);
    return {
      id: crypto.randomUUID(),
      groupId,
      ownerId: session.ownerId,
      sessionId: session.id,
      sessionExerciseId: entryId,
      exerciseId: entry.exerciseId,
      side,
      reps: last?.reps ?? plannedReps(entry.prescription.target),
      kg: last?.kg ?? 0,
      rpe: "",
      done: false,
    };
  });
  return {
    ...session,
    logs: { ...session.logs, [entryId]: [...session.logs[entryId], ...added] },
  };
}
export function removeSetGroup(
  session: WorkoutSession,
  entryId: string,
  groupId: string,
): WorkoutSession {
  return {
    ...session,
    logs: {
      ...session.logs,
      [entryId]: session.logs[entryId].filter((s) => s.groupId !== groupId),
    },
  };
}
export function sideComparison(sets: ExerciseSet[]) {
  const totals = (side: "L" | "R") => {
    const rows = sets.filter((s) => s.side === side && s.done);
    const rpes = rows.filter((s) => s.rpe !== "");
    return {
      completed: rows.length,
      reps: rows.reduce((n, s) => n + s.reps, 0),
      volume: rows.reduce((n, s) => n + s.kg * s.reps, 0),
      averageLoad: rows.length
        ? rows.reduce((n, s) => n + s.kg, 0) / rows.length
        : null,
      averageRpe: rpes.length
        ? rpes.reduce((n, s) => n + Number(s.rpe), 0) / rpes.length
        : null,
    };
  };
  const matched = groupSets(sets).filter(
    (g) => g.complete && g.rows.length === 2,
  );
  const left = matched.reduce((n, g) => {
    const s = g.rows.find((s) => s.side === "L")!;
    return n + s.reps * s.kg;
  }, 0);
  const right = matched.reduce((n, g) => {
    const s = g.rows.find((s) => s.side === "R")!;
    return n + s.reps * s.kg;
  }, 0);
  return {
    left: totals("L"),
    right: totals("R"),
    matchedPairs: matched.length,
    matchedVolumeDelta: right - left,
  };
}
