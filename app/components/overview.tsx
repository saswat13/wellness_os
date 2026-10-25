"use client";
import { useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Dumbbell,
  Plus,
  History,
  Check,
  ChevronLeft,
} from "lucide-react";
import type { TrackerStore, WorkoutSession } from "@/lib/models";
import { historyFor } from "@/lib/tracker";
import { sessionCounts, setCounts, groupSets } from "@/lib/unilateral";
import { displayLoad, volume } from "@/lib/workout";
import {
  today,
  shiftDate,
  dayTotals,
  sum,
  entryNutrition,
  meals,
  saveGoals,
  saveUser,
  macroCalories,
  goalsDiffer,
  type NutritionStore,
  type NutritionGoals,
} from "@/lib/nutrition";
import { action, control } from "./management";
import {
  panel,
  primary,
  muted,
  fmt,
  NutritionSummary,
  NutritionNumbers,
  NutrientInputs,
  type NutritionProps,
} from "./nutrition";
import { PerformanceHistory, SideComparison } from "./performance-history";
export type Section =
  "home" | "workouts" | "nutrition" | "progress" | "settings";
export function Home({
  tracker,
  nutrition,
  navigate,
  cloud = false,
}: {
  cloud?: boolean;
  tracker: TrackerStore;
  nutrition: NutritionStore;
  navigate: (section: Section, detail?: string) => void;
}) {
  const counts = sessionCounts(tracker.session),
    date = today(nutrition.user.timeZone);
  const [exerciseId, setExerciseId] = useState("");
  const recent = tracker.history
    .filter((s) => s.ownerId === tracker.userId && s.finished)
    .slice()
    .sort((a, b) => b.started - a.started)
    .slice(0, 3);
  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2 text-xs font-bold tracking-widest text-[#728274]">
          YOUR DAILY PRACTICE
        </p>
        <h1 className="text-4xl font-bold tracking-tight">
          A little stronger<span className="text-[#87a472]">.</span>
        </h1>
        <p className={`mt-3 ${muted}`}>
          {nutrition.user.name} ·{" "}
          {new Date(date + "T12:00:00").toLocaleDateString("en-US", {
            weekday: "long",
            month: "short",
            day: "numeric",
          })}
        </p>
      </div>
      <section className="rounded-3xl bg-[#244b3c] p-5 text-white sm:p-7">
        <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-[#d6ecb4]">
          <Dumbbell size={17} />
          Today’s training
        </div>
        <h2 className="text-2xl font-bold">{tracker.session.name}</h2>
        <p className="mt-2 text-sm text-[#d7e0d7]">
          {tracker.session.exercises.length} exercises · {counts.completed}/
          {counts.total} sets complete
          {counts.partial ? ` · ${counts.partial} partial pairs` : ""}
          {tracker.session.finished
            ? " · session saved"
            : " · ready when you are"}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            className={`${action} bg-[#d6ecb4] text-[#244b3c]`}
            onClick={() => navigate("workouts", "workout")}
          >
            {tracker.session.finished
              ? "View workout summary"
              : counts.completedSides
                ? "Resume workout"
                : "Open workout"}
            <ArrowUpRight size={16} />
          </button>
          <button
            className={`${action} border border-[#587463] text-white`}
            onClick={() => navigate("workouts", "templates")}
          >
            Choose a template
          </button>
        </div>
      </section>
      <NutritionSummary
        totals={dayTotals(nutrition, date)}
        goals={nutrition.goals}
        onGoals={() => navigate("settings")}
      />
      <div className="flex flex-wrap gap-2">
        <button
          className={primary}
          onClick={() => navigate("nutrition", "log")}
        >
          <Plus size={16} />
          Quick Log Food
        </button>
        <button
          className={`${action} border border-[#dfe5dc] bg-white`}
          onClick={() => navigate("nutrition")}
        >
          Open food diary
        </button>
      </div>
      <section className={panel}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold">Today’s meals</h2>
          <button
            className={`${action} text-[#57775d]`}
            onClick={() => navigate("nutrition")}
          >
            View diary
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {meals.map((meal) => {
            const entries = nutrition.diary.filter(
              (e) =>
                e.ownerId === nutrition.user.id &&
                e.date === date &&
                e.meal === meal,
            );
            return (
              <button
                key={meal}
                className="rounded-xl bg-[#f6f7f3] p-3 text-left"
                aria-label={`View ${meal} diary`}
                onClick={() => navigate("nutrition")}
              >
                <p className="text-sm font-semibold">{meal}</p>
                <p className="mt-1 text-xs text-[#6c7c6e]">
                  {entries.length} items ·{" "}
                  {fmt(sum(entries.map(entryNutrition)).calories)} kcal
                </p>
              </button>
            );
          })}
        </div>
      </section>
      <section className={panel}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold">Recent training</h2>
          <button
            className={`${action} text-[#57775d]`}
            onClick={() => navigate("workouts", "history")}
          >
            All history
          </button>
        </div>
        {recent.map((s) => (
          <button
            key={s.id}
            className="flex min-h-16 w-full items-center justify-between gap-3 border-t border-[#edf1e7] py-3 text-left"
            aria-label={`View recent workout ${s.name} ${s.id}`}
            onClick={() => navigate("workouts", `history:${s.id}`)}
          >
            <div>
              <p className="font-semibold">{s.name}</p>
              <p className="mt-1 text-xs text-[#6c7c6e]">
                {sessionDate(s, nutrition.user.timeZone)}
                {s.mock ? " · mock" : ""}
              </p>
            </div>
            <span className="text-xs">
              {sessionCounts(s).completed} sets
              <ArrowUpRight size={14} className="ml-auto mt-1" />
            </span>
          </button>
        ))}
        {!recent.length && (
          <p className={muted}>Finish a workout to see it here.</p>
        )}
      </section>
      <section className={panel}>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-bold">
          <History size={18} />
          Exercise history
        </h2>
        <ExerciseSelect
          tracker={tracker}
          value={exerciseId}
          onChange={setExerciseId}
        />
        {exerciseId && (
          <PerformanceHistory
            sessions={historyFor(
              tracker,
              exerciseId,
              "",
              nutrition.user.timeZone,
            )}
            unit={nutrition.user.unit}
          />
        )}
      </section>
      <p className="text-xs leading-5 text-[#7b897a]">
        {cloud
          ? "Your workouts and meals are saved to your account."
          : "Local prototype · one mock user · seeded workouts and nutrition values are mock data. Everything is saved in this browser."}
      </p>
    </div>
  );
}
function sessionDate(s: WorkoutSession, zone = "America/Los_Angeles") {
  return new Date(s.completedAt ?? s.started).toLocaleDateString("en-US", {
    timeZone: zone,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
function ExerciseSelect({
  tracker,
  value,
  onChange,
}: {
  tracker: TrackerStore;
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <label className="block text-sm">
      Exercise
      <select
        className={`${control} mb-4 mt-2`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Choose an exercise</option>
        {tracker.library
          .filter((e) => e.ownerId === null || e.ownerId === tracker.userId)
          .map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
              {e.archived ? " (archived)" : ""}
            </option>
          ))}
      </select>
    </label>
  );
}
export function WorkoutArchive({
  tracker,
  timeZone,
  initialSession = null,
  onSelect,
}: {
  tracker: TrackerStore;
  timeZone: string;
  initialSession?: string | null;
  onSelect?: (id: string | null) => void;
}) {
  const [selected, setSelected] = useState<string | null>(initialSession);
  const sessions = tracker.history
    .filter((s) => s.ownerId === tracker.userId && s.finished)
    .slice()
    .sort((a, b) => b.started - a.started);
  const session = sessions.find((s) => s.id === selected);
  if (session) {
    const counts = sessionCounts(session);
    return (
      <div className="space-y-4">
        <button
          className={action}
          onClick={() => (onSelect ? onSelect(null) : setSelected(null))}
        >
          <ChevronLeft size={16} />
          Back to workout history
        </button>
        <h1 className="text-3xl font-bold">{session.name}</h1>
        <p className={muted}>
          {sessionDate(session, timeZone)} ·{" "}
          {session.mock ? "mock session" : "completed session"} · read-only
          history
        </p>
        <div className="rounded-2xl bg-[#edf1e7] p-4">
          <p className="font-bold">
            {counts.completed} completed sets
            {counts.partial ? ` · ${counts.partial} partial pairs` : ""}
          </p>
          <p className={`mt-2 ${muted}`}>
            {fmt(
              displayLoad(
                volume(Object.values(session.logs).flat()),
                tracker.session.unit,
              ),
            )}{" "}
            {tracker.session.unit} × reps · {session.exercises.length} exercises
          </p>
        </div>
        {session.exercises.map((entry) => (
          <article key={entry.id} className={panel}>
            <h2 className="text-lg font-bold">{entry.snapshot.name}</h2>
            <p className={`my-2 ${muted}`}>
              Plan: {entry.prescription.plannedSets}{" "}
              {entry.snapshot.unilateral ? "paired sets" : "sets"} ×{" "}
              {entry.prescription.target}
            </p>
            {entry.prescription.note && (
              <p className={`mb-3 ${muted}`}>{entry.prescription.note}</p>
            )}
            {groupSets(session.logs[entry.id]).map((group, i) => (
              <div key={group.id} className="mb-2 rounded-xl bg-[#f6f7f3] p-3">
                <p className="mb-2 text-xs font-bold">
                  Set {i + 1}
                  {group.partial ? " · Partially complete" : ""}
                </p>
                {group.rows.map((s) => (
                  <div
                    key={s.id}
                    className="flex flex-wrap justify-between gap-2 py-1 text-xs"
                  >
                    <b>
                      {s.side === "L"
                        ? "Left"
                        : s.side === "R"
                          ? "Right"
                          : "Both"}
                    </b>
                    <span>
                      {s.reps} × {displayLoad(s.kg, tracker.session.unit)}{" "}
                      {tracker.session.unit}
                      {s.rpe ? ` · RPE ${s.rpe}` : ""}
                    </span>
                    <span>{s.done ? "Completed" : "Not completed"}</span>
                  </div>
                ))}
              </div>
            ))}
            {entry.snapshot.unilateral && (
              <SideComparison
                sets={session.logs[entry.id]}
                unit={tracker.session.unit}
              />
            )}
            <details className="mt-2">
              <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold">
                Exercise progression
              </summary>
              <PerformanceHistory
                sessions={historyFor(tracker, entry.exerciseId, "", timeZone)}
                unit={tracker.session.unit}
              />
            </details>
          </article>
        ))}
        {session.notes && (
          <div className={panel}>
            <h2 className="font-bold">Workout notes</h2>
            <p className={`mt-2 whitespace-pre-wrap ${muted}`}>
              {session.notes}
            </p>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold">
        Workout history<span className="text-[#87a472]">.</span>
      </h1>
      <p className={muted}>
        Private session snapshots. Library and template edits keep these results
        intact.
      </p>
      {sessions.map((s) => {
        const c = sessionCounts(s);
        return (
          <article key={s.id} className={panel}>
            <p className="text-xs text-[#728274]">
              {sessionDate(s, timeZone)}
              {s.mock ? " · MOCK" : ""}
            </p>
            <h2 className="mt-2 text-xl font-bold">{s.name}</h2>
            <p className={`mt-2 ${muted}`}>
              {c.completed} completed sets
              {c.partial ? ` · ${c.partial} partial pairs` : ""} ·{" "}
              {fmt(
                displayLoad(
                  volume(Object.values(s.logs).flat()),
                  tracker.session.unit,
                ),
              )}{" "}
              {tracker.session.unit} × reps
            </p>
            <button
              className={`${action} mt-3 bg-[#edf1e7]`}
              aria-label={`View workout ${s.id}`}
              onClick={() => {
                if (onSelect) onSelect(s.id);
                else setSelected(s.id);
                window.scrollTo(0, 0);
              }}
            >
              View session
              <ArrowUpRight size={16} />
            </button>
          </article>
        );
      })}
      {!sessions.length && (
        <p className={`${panel} ${muted}`}>
          Finish a workout to start your history.
        </p>
      )}
    </div>
  );
}
export function Progress({
  tracker,
  nutrition,
}: {
  tracker: TrackerStore;
  nutrition: NutritionStore;
}) {
  const [tab, setTab] = useState<"Training" | "Nutrition">("Training");
  const [exerciseId, setExerciseId] = useState("");
  const [groupBy, setGroupBy] = useState("primaryMuscle");
  const sessions = tracker.history
    .filter((s) => s.ownerId === tracker.userId && s.finished)
    .slice()
    .sort((a, b) => b.started - a.started);
  const all = sessions.flatMap((s) => Object.values(s.logs).flat());
  const completed = sessions.reduce(
    (n, s) => n + sessionCounts(s).completed,
    0,
  );
  const dates = Array.from({ length: 7 }, (_, i) =>
    shiftDate(today(nutrition.user.timeZone), i - 6),
  );
  const days = dates.map((date) => ({ date, n: dayTotals(nutrition, date) }));
  const reports = new Map<string, { sets: number; volume: number }>();
  sessions.forEach((s) =>
    s.exercises.forEach((e) => {
      const label =
        groupBy === "trainingType"
          ? s.trainingType
          : (e.snapshot[
              groupBy as "primaryMuscle" | "equipment" | "movementPattern"
            ] ?? "Unspecified");
      const old = reports.get(label) ?? { sets: 0, volume: 0 };
      reports.set(label, {
        sets: old.sets + setCounts(s.logs[e.id]).completed,
        volume: old.volume + volume(s.logs[e.id]),
      });
    }),
  );
  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2 text-xs font-bold tracking-widest text-[#728274]">
          CONSISTENCY / OVER TIME
        </p>
        <h1 className="text-3xl font-bold">
          Your progress<span className="text-[#87a472]">.</span>
        </h1>
      </div>
      <nav
        aria-label="Progress sections"
        className="flex gap-1 rounded-2xl border border-[#dfe5dc] bg-white p-1"
      >
        {(["Training", "Nutrition"] as const).map((t) => (
          <button
            key={t}
            className={`${action} flex-1 ${tab === t ? "bg-[#244b3c] text-white" : ""}`}
            aria-current={tab === t ? "page" : undefined}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>
      {tab === "Training" ? (
        <>
          <div className="grid grid-cols-3 gap-2">
            {[
              [sessions.length, "Sessions"],
              [completed, "Complete sets"],
              [
                fmt(displayLoad(volume(all), nutrition.user.unit)),
                `${nutrition.user.unit} × reps`,
              ],
            ].map(([value, label]) => (
              <div key={label} className={`${panel} px-2 text-center`}>
                <p className="break-words text-xl font-bold">{value}</p>
                <p className="mt-1 text-[10px] text-[#6c7c6e]">{label}</p>
              </div>
            ))}
          </div>
          <div className={panel}>
            <h2 className="mb-4 font-bold">
              Training volume · last 6 sessions
            </h2>
            <Bars
              values={sessions
                .slice(0, 6)
                .reverse()
                .map((s) => ({
                  label: sessionDate(s, nutrition.user.timeZone),
                  value: displayLoad(
                    volume(Object.values(s.logs).flat()),
                    nutrition.user.unit,
                  ),
                  suffix: nutrition.user.unit + " × reps",
                }))}
            />
            <p className="mt-3 text-xs text-[#6c7c6e]">
              Completed sides contribute volume; complete pairs count once.
              Includes labeled mock history.
            </p>
          </div>
          <div className={panel}>
            <label className="block text-sm font-bold">
              Report by
              <select
                className={`${control} my-3`}
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value)}
              >
                <option value="primaryMuscle">Primary muscle</option>
                <option value="equipment">Equipment</option>
                <option value="movementPattern">Movement pattern</option>
                <option value="trainingType">Training type</option>
              </select>
            </label>
            <table className="w-full table-fixed text-left text-xs">
              <thead>
                <tr>
                  <th className="w-2/5 py-2">Category</th>
                  <th>Sets</th>
                  <th>Volume ({nutrition.user.unit} × reps)</th>
                </tr>
              </thead>
              <tbody>
                {Array.from(reports.entries()).map(([label, n]) => (
                  <tr key={label} className="border-t border-[#edf1e7]">
                    <th className="break-words py-3 pr-2 font-normal">
                      {label}
                    </th>
                    <td>{n.sets}</td>
                    <td className="break-words">
                      {fmt(displayLoad(n.volume, nutrition.user.unit))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-[#7b897a]">
              Uses metadata frozen at workout time, so renamed exercises retain
              their original classification.
            </p>
          </div>
          <div className={panel}>
            <h2 className="mb-3 font-bold">
              Exercise progression & side comparisons
            </h2>
            <ExerciseSelect
              tracker={tracker}
              value={exerciseId}
              onChange={setExerciseId}
            />
            {exerciseId && (
              <>
                <Bars
                  values={historyFor(
                    tracker,
                    exerciseId,
                    "",
                    nutrition.user.timeZone,
                  )
                    .slice(0, 6)
                    .reverse()
                    .map((h) => ({
                      label: h.date,
                      value: displayLoad(volume(h.sets), nutrition.user.unit),
                      suffix: nutrition.user.unit + " × reps",
                    }))}
                />
                <PerformanceHistory
                  sessions={historyFor(
                    tracker,
                    exerciseId,
                    "",
                    nutrition.user.timeZone,
                  )}
                  unit={nutrition.user.unit}
                />
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <div className={panel}>
            <h2 className="mb-4 font-bold">Calories · past 7 days</h2>
            <Bars
              values={days.map(({ date, n }) => ({
                label: date,
                value: n.calories,
                suffix: "kcal",
              }))}
              target={nutrition.goals.calories}
            />
            <p className="mt-3 text-xs text-[#6c7c6e]">
              Current daily target: {fmt(nutrition.goals.calories)} kcal. Empty
              days count as zero logged intake.
            </p>
          </div>
          <div className={panel}>
            <h2 className="mb-2 font-bold">7-day average logged intake</h2>
            <NutritionNumbers
              value={scaleAverage(sum(days.map((d) => d.n)), 7)}
            />
            <p className="mt-3 text-xs text-[#7b897a]">
              Averages describe diary entries, including seeded mock meals.
            </p>
          </div>
          <div className={panel}>
            <h2 className="mb-3 font-bold">Daily macros</h2>
            {days.map((d) => (
              <div key={d.date} className="border-t border-[#edf1e7] py-3">
                <p className="text-xs font-semibold">{d.date}</p>
                <NutritionNumbers value={d.n} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
function scaleAverage(
  n: { calories: number; protein: number; carbs: number; fat: number },
  days: number,
) {
  return {
    calories: n.calories / days,
    protein: n.protein / days,
    carbs: n.carbs / days,
    fat: n.fat / days,
  };
}
function Bars({
  values,
  target,
}: {
  values: { label: string; value: number; suffix: string }[];
  target?: number;
}) {
  const max = Math.max(target ?? 0, ...values.map((v) => v.value), 1);
  return (
    <div className="space-y-4">
      {values.map((v, i) => (
        <div key={i}>
          <div className="mb-1 flex justify-between gap-2 text-xs">
            <span>{v.label}</span>
            <span className="text-right">
              {fmt(v.value)} {v.suffix}
            </span>
          </div>
          <div className="relative h-3 overflow-hidden rounded-full bg-[#edf1e7]">
            <div
              className="h-full rounded-full bg-[#86a66e]"
              style={{ width: `${(v.value / max) * 100}%` }}
            />
            {target !== undefined && (
              <span
                className="absolute inset-y-0 border-l-2 border-[#244b3c]"
                style={{ left: `${Math.min(99, (target / max) * 100)}%` }}
              />
            )}
          </div>
        </div>
      ))}
      {!values.length && (
        <p className={muted}>Complete a session to see your progression.</p>
      )}
    </div>
  );
}
export function Settings({
  store,
  setStore,
  onUnit,
  cloud = false,
  accountControls,
  locked = false,
}: NutritionProps & {
  cloud?: boolean;
  onUnit: (unit: "kg" | "lb") => void;
  accountControls?: ReactNode;
  locked?: boolean;
}) {
  const [goals, setGoals] = useState<NutritionGoals>(
    structuredClone(store.goals),
  );
  const [user, setUser] = useState(structuredClone(store.user));
  const [message, setMessage] = useState("");
  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2 text-xs font-bold tracking-widest text-[#728274]">
          MAKE IT YOURS
        </p>
        <h1 className="text-3xl font-bold">
          Settings<span className="text-[#87a472]">.</span>
        </h1>
      </div>
      {message && (
        <p role="status" className="rounded-xl bg-[#edf1e7] p-3 text-sm">
          {message}
        </p>
      )}
      {accountControls}
      <fieldset className="min-w-0 space-y-5" disabled={locked}>
        <form
          className={`${panel} space-y-4`}
          onSubmit={(e) => {
            e.preventDefault();
            try {
              setStore(saveGoals(store, goals));
              setMessage(
                "Nutrition goals saved. Dashboard and diary targets updated.",
              );
            } catch {
              setMessage("Enter valid, non-negative targets.");
            }
          }}
        >
          <h2 className="text-xl font-bold">Nutrition Goals</h2>
          <p className={muted}>
            Your daily targets. Set values that suit your own plan.
          </p>
          <NutrientInputs
            value={goals}
            onChange={(n) => setGoals({ ...goals, ...n })}
            prefix="Goal "
          />
          <div className="rounded-xl bg-[#f6f7f3] p-3">
            <p className="text-sm font-semibold">
              Macro-derived calories: {fmt(macroCalories(goals))} kcal
            </p>
            <p className={`mt-1 ${muted}`}>
              Protein × 4 + carbohydrates × 4 + fat × 9
            </p>
          </div>
          {goalsDiffer(goals) && (
            <p
              role="status"
              className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900"
            >
              Your macro targets imply {fmt(macroCalories(goals))} kcal, which
              differs materially from your {fmt(goals.calories)} kcal target.
              You can save these targets independently.
            </p>
          )}
          <div className="flex gap-2">
            <button className={primary}>
              <Check size={16} />
              Save goals
            </button>
            <button
              className={action}
              type="button"
              onClick={() => {
                setGoals(structuredClone(store.goals));
                setMessage("Unsaved goal changes canceled.");
              }}
            >
              Cancel
            </button>
          </div>
        </form>
        <form
          className={`${panel} space-y-4`}
          onSubmit={(e) => {
            e.preventDefault();
            try {
              setStore(saveUser(store, user));
              onUnit(user.unit);
              setMessage("Preferences saved.");
            } catch {
              setMessage("Check your name and time zone.");
            }
          }}
        >
          <h2 className="text-xl font-bold">Preferences</h2>
          <label className="block text-sm">
            Display name
            <input
              className={`${control} mt-1`}
              required
              maxLength={80}
              value={user.name}
              onChange={(e) => setUser({ ...user, name: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            Preferred weight units
            <select
              className={`${control} mt-1`}
              value={user.unit}
              onChange={(e) =>
                setUser({ ...user, unit: e.target.value as "kg" | "lb" })
              }
            >
              <option>kg</option>
              <option>lb</option>
            </select>
          </label>
          <label className="block text-sm">
            Time zone
            <select
              className={`${control} mt-1`}
              value={user.timeZone}
              onChange={(e) => setUser({ ...user, timeZone: e.target.value })}
            >
              {Array.from(
                new Set([
                  user.timeZone,
                  "America/Los_Angeles",
                  "America/New_York",
                  "Europe/London",
                  "Europe/Berlin",
                  "Asia/Kolkata",
                  "Asia/Singapore",
                  "Australia/Sydney",
                  "UTC",
                ]),
              ).map((z) => (
                <option key={z}>{z}</option>
              ))}
            </select>
          </label>
          <p className="text-xs text-[#7b897a]">
            Sets always store kilograms internally. Time zone controls Today in
            the diary and dashboard.
          </p>
          <div className="flex gap-2">
            <button className={primary}>Save preferences</button>
            <button
              type="button"
              className={action}
              onClick={() => {
                setUser(structuredClone(store.user));
                setMessage("Unsaved preference changes canceled.");
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      </fieldset>
      <div className={panel}>
        <h2 className="font-bold">
          {cloud ? "About FORM" : "About this prototype"}
        </h2>
        <p className={`mt-2 leading-6 ${muted}`}>
          {cloud
            ? "Your signed-in account saves online. Local browser records stay separate. Public signup, public publishing and offline cloud synchronization are unavailable."
            : "FORM runs with one mock user and browser storage. Use cloud account to select your separate signed-in records. No browser data is automatically imported."}
        </p>
      </div>
    </div>
  );
}
