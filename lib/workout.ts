export type Unit = "kg" | "lb";
export type Side = "L" | "R" | "both";
export type LoggedSet = {
  id: string;
  reps: number;
  kg: number;
  rpe: string;
  done: boolean;
  side: Side;
};
export type HistoricalSession = {
  date: string;
  sets: { reps: number; kg: number; side: Side }[];
};
export type SampleExercise = {
  id: string;
  name: string;
  equipment: string;
  target: string;
  plannedSets: number;
  note: string;
  unilateral: boolean;
  history: HistoricalSession[];
};
const dates = ["2026-10-06", "2026-09-29", "2026-09-22"];
function history(
  load: number,
  reps: number,
  unilateral = false,
): HistoricalSession[] {
  return dates.map((date, index) => ({
    date,
    sets: Array.from({ length: unilateral ? 6 : 3 }, (_, i) => ({
      reps: reps - Math.floor(i / (unilateral ? 2 : 1)),
      kg: load - index * 2.5,
      side: unilateral ? (i % 2 === 0 ? "L" : "R") : "both",
    })),
  }));
}
export const exercises: SampleExercise[] = [
  {
    id: "pulldown",
    name: "Single-arm cable lat pulldown",
    equipment: "CABLE · LATS",
    target: "10–12",
    plannedSets: 3,
    note: "Drive your elbow toward your hip. Pause at the bottom; control the stretch. Match both sides.",
    unilateral: true,
    history: history(22.5, 12, true),
  },
  {
    id: "fly",
    name: "Seated cable chest flyes",
    equipment: "CABLE · CHEST",
    target: "12–15",
    plannedSets: 3,
    note: "Keep a soft bend in your elbows. Bring your hands together without shrugging. Load is per handle.",
    unilateral: false,
    history: history(12.5, 15),
  },
  {
    id: "row",
    name: "Seated cable row (wide grip)",
    equipment: "CABLE · UPPER BACK",
    target: "8–12",
    plannedSets: 3,
    note: "Keep your torso steady. Pull toward your lower chest and squeeze your shoulder blades.",
    unilateral: false,
    history: history(45, 12),
  },
  {
    id: "press",
    name: "Incline Smith machine chest press",
    equipment: "SMITH MACHINE · CHEST",
    target: "8–10",
    plannedSets: 3,
    note: "Set the bench to 30°. Lower with control and keep your feet planted. Log total external load, excluding the bar.",
    unilateral: false,
    history: history(40, 10),
  },
];
export function initialSets(exercise: SampleExercise): LoggedSet[] {
  return exercise.history[0].sets.map((set, i) => ({
    ...set,
    id: `${exercise.id}-${i}`,
    rpe: "",
    done: false,
  }));
}
export function volume(
  sets: Pick<LoggedSet, "kg" | "reps" | "done">[],
): number {
  return sets.filter((s) => s.done).reduce((sum, s) => sum + s.kg * s.reps, 0);
}
export function displayLoad(kg: number, unit: Unit): number {
  return Math.round(kg * (unit === "lb" ? 2.2046226218 : 1) * 10) / 10;
}
export function toKg(value: number, unit: Unit): number {
  return value / (unit === "lb" ? 2.2046226218 : 1);
}
