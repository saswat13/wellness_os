"use client";
import {
  useEffect,
  useState,
  useRef,
  type SetStateAction,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronLeft,
  Dumbbell,
  History,
  Plus,
  Timer,
  X,
  House,
  Utensils,
  ChartNoAxesCombined,
  Settings as SettingsIcon,
} from "lucide-react";
import { displayLoad, volume, type Unit } from "@/lib/workout";
import {
  ExerciseLibrary,
  Templates,
  PrescriptionFields,
  action,
} from "./components/management";
import {
  type TrackerStore,
  type WorkoutSession,
  type ExerciseSet as LoggedSet,
} from "@/lib/models";
import {
  STORAGE_KEY,
  seedStore,
  parseStore,
  migrateLegacy,
  migrateV2,
  historyFor,
  finishSession,
  move,
  removeFromSession,
  replaceInSession,
} from "@/lib/tracker";
import { SetLogger } from "./components/set-logger";
import {
  PerformanceHistory,
  SideComparison,
} from "./components/performance-history";
import {
  appendSet,
  editSide,
  removeSetGroup,
  sessionCounts,
  setCounts,
} from "@/lib/unilateral";
import {
  NUTRITION_KEY,
  seedNutrition,
  parseNutrition,
  type NutritionStore,
} from "@/lib/nutrition";
import { Nutrition } from "./components/nutrition";
import {
  Home,
  Progress,
  Settings,
  WorkoutArchive,
  type Section,
} from "./components/overview";
import { AccountBoundary, type CloudBinding } from "./components/cloud-account";
import { useSnapshotPersistence } from "./hooks/use-snapshot-persistence";
const button = action;
type WorkoutView = "workout" | "library" | "templates" | "history";
function currentNavigation() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("section");
  const section =
    requested &&
    ["home", "workouts", "nutrition", "progress", "settings"].includes(
      requested,
    )
      ? (requested as Section)
      : "home";
  const requestedView = params.get("view");
  const view =
    requestedView &&
    ["workout", "library", "templates", "history"].includes(requestedView)
      ? (requestedView as WorkoutView)
      : "workout";
  return { section, view, historySession: params.get("session") };
}
export default function Workout() {
  return (
    <AccountBoundary
      render={(cloud) => (
        <FormScreen key={cloud ? "cloud" : "local"} cloud={cloud} />
      )}
    />
  );
}
function FormScreen({ cloud }: { cloud?: CloudBinding }) {
  const [localStore, setLocalStore] = useState<TrackerStore>(seedStore);
  const [localNutrition, setLocalNutrition] =
    useState<NutritionStore>(seedNutrition);
  const store = cloud?.data.tracker ?? localStore;
  const nutrition = cloud?.data.nutrition ?? localNutrition;
  const setStore = cloud?.setTracker ?? setLocalStore;
  const setNutrition = cloud?.setNutrition ?? setLocalNutrition;
  const [section, setSection] = useState<Section>("home");
  const [quickLog, setQuickLog] = useState(false);
  const [nutritionBlocked, setNutritionBlocked] = useState(false);
  const [nutritionWarning, setNutritionWarning] = useState("");
  const [replacing, setReplacing] = useState<string | null>(null);
  const [historySession, setHistorySession] = useState<string | null>(null);
  const session = store.session;
  const setSession = (update: SetStateAction<WorkoutSession>) =>
    setStore((s) => ({
      ...s,
      session: typeof update === "function" ? update(s.session) : update,
    }));
  const [view, setView] = useState<
    "workout" | "library" | "templates" | "history"
  >("workout");
  const exercises = session.exercises.map((entry) => ({
    id: entry.id,
    exerciseId: entry.exerciseId,
    name: entry.snapshot.name,
    equipment:
      `${entry.snapshot.equipment ?? "Custom"} · ${entry.snapshot.primaryMuscle ?? "Exercise"}`.toUpperCase(),
    unilateral: entry.snapshot.unilateral,
    demoUrl: entry.snapshot.demoUrl,
    ...entry.prescription,
    history: historyFor(
      store,
      entry.exerciseId,
      store.session.id,
      nutrition.user.timeZone,
    ),
  }));
  const [ready, setReady] = useState(false);
  const workoutSnapshot = useRef<string | null>(null);
  const nutritionSnapshot = useRef<string | null>(null);
  const [storageWarning, setStorageWarning] = useState("");
  const [persistenceBlocked, setPersistenceBlocked] = useState(false);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [showRpe, setShowRpe] = useState(false);
  const [restDuration, setRestDuration] = useState(90);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [confirmFinish, setConfirmFinish] = useState(false);
  useEffect(() => {
    const restore = setTimeout(() => {
      if (!cloud) {
        try {
          const saved = localStorage.getItem(STORAGE_KEY);
          workoutSnapshot.current = saved;
          if (saved) setStore(parseStore(JSON.parse(saved)));
          else {
            const v2 = localStorage.getItem("form-tracker-v2");
            if (v2) setStore(migrateV2(JSON.parse(v2)));
            else {
              const legacy = localStorage.getItem("form-workout-v1");
              if (legacy) setStore(migrateLegacy(JSON.parse(legacy)));
            }
          }
        } catch {
          setPersistenceBlocked(true);
          setStorageWarning(
            "Saved data could not be restored or browser storage is unavailable. Your original saved data is preserved; this tab can still be used.",
          );
        }
        try {
          const savedNutrition = localStorage.getItem(NUTRITION_KEY);
          nutritionSnapshot.current = savedNutrition;
          if (savedNutrition)
            setNutrition(parseNutrition(JSON.parse(savedNutrition)));
        } catch {
          setNutritionBlocked(true);
          setNutritionWarning(
            "Saved nutrition data could not be restored. The original data is preserved; this tab can still be used temporarily.",
          );
        }
      }
      const nav = currentNavigation();
      setSection(nav.section);
      setView(nav.view);
      setHistorySession(nav.historySession);
      setReady(true);
    }, 0);
    return () => clearTimeout(restore);
    // Each account/mode mounts a fresh screen; cloud never restores browser records.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useSnapshotPersistence(
    STORAGE_KEY,
    "Workout data",
    store,
    ready && !cloud,
    persistenceBlocked,
    workoutSnapshot,
    parseStore,
    setStorageWarning,
    setPersistenceBlocked,
  );
  useSnapshotPersistence(
    NUTRITION_KEY,
    "Nutrition data",
    nutrition,
    ready && !cloud,
    nutritionBlocked,
    nutritionSnapshot,
    parseNutrition,
    setNutritionWarning,
    setNutritionBlocked,
  );
  const downloadUnsaved = () => {
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            { exportVersion: 1, workouts: store, nutrition },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "form-unsaved-backup.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const navigate = (next: Section, detail?: string) => {
    const [requestedView, selectedSession] = (detail ?? "workout").split(":");
    const nextView: WorkoutView = [
      "workout",
      "library",
      "templates",
      "history",
    ].includes(requestedView)
      ? (requestedView as WorkoutView)
      : "workout";
    setSection(next);
    setQuickLog(next === "nutrition" && detail === "log");
    if (next === "workouts") setView(nextView);
    setHistorySession(selectedSession ?? null);
    setHistoryId(null);
    setConfirmFinish(false);
    setReplacing(null);
    const params = new URLSearchParams({ section: next });
    if (cloud) {
      params.set("mode", "cloud");
      const draft = new URLSearchParams(window.location.search).get("draft");
      if (draft) params.set("draft", draft);
    }
    if (next === "workouts" && nextView !== "workout")
      params.set("view", nextView);
    if (selectedSession) params.set("session", selectedSession);
    const url = `?${params.toString()}`;
    if (window.location.search !== url) window.history.pushState(null, "", url);
    window.scrollTo(0, 0);
  };
  useEffect(() => {
    const restoreNavigation = () => {
      const nav = currentNavigation();
      setSection(nav.section);
      setView(nav.view);
      setHistorySession(nav.historySession);
      setQuickLog(false);
      setHistoryId(null);
      setConfirmFinish(false);
      setReplacing(null);
      window.scrollTo(0, 0);
    };
    window.addEventListener("popstate", restoreNavigation);
    return () => window.removeEventListener("popstate", restoreNavigation);
  }, []);
  useEffect(() => {
    if (!deadline) return;
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(seconds);
      if (!seconds) setDeadline(null);
    };
    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [deadline]);
  useEffect(() => {
    if (!historyId && !confirmFinish) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setHistoryId(null);
        setConfirmFinish(false);
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [historyId, confirmFinish]);
  const all = Object.values(session.logs).flat();
  const counts = sessionCounts(session);
  const completed = counts.completed;
  const completedSides = counts.completedSides;
  const totalVolume = displayLoad(volume(all), session.unit);
  const update = (
    id: string,
    setId: string,
    patch: Partial<Pick<LoggedSet, "reps" | "kg" | "rpe" | "done">>,
  ) =>
    setSession((s) => ({
      ...s,
      logs: {
        ...s.logs,
        [id]: editSide(
          s.logs[id],
          setId,
          patch,
          s.exercises.find((e) => e.id === id)!.sameWeight,
        ),
      },
    }));
  const startTimer = () => {
    if (!restDuration) return;
    setRemaining(restDuration);
    setDeadline(Date.now() + restDuration * 1000);
  };
  const historyExercise = exercises.find((e) => e.id === historyId);
  const finish = () => {
    setStore((s) => finishSession(s));
    setConfirmFinish(false);
    setDeadline(null);
    window.scrollTo(0, 0);
  };
  if (!ready)
    return <main className="mx-auto max-w-3xl p-8">Loading FORM…</main>;
  return (
    <>
      <header className="border-b border-[#dfe5dc] bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-4">
          <button
            aria-label="FORM home"
            onClick={() => navigate("home")}
            className="flex items-center gap-2 text-xl font-black tracking-tight"
          >
            <span className="rounded-xl bg-[#244b3c] p-2 text-[#d8edb9]">
              <Dumbbell size={22} />
            </span>{" "}
            FORM
            <span className="ml-2 hidden text-xs font-normal tracking-normal text-[#788478] sm:inline">
              A little stronger, every session.
            </span>
          </button>
          <span className="rounded-full bg-[#f0f3ec] px-3 py-2 text-xs font-medium">
            {cloud ? "CLOUD ACCOUNT" : "LOCAL PROTOTYPE"}
          </span>
        </div>
      </header>
      <main
        className={`mx-auto max-w-3xl px-4 pt-7 sm:px-6 ${section === "workouts" && view === "workout" && !session.finished ? "pb-56" : "pb-28"}`}
      >
        {storageWarning && (
          <p
            role="alert"
            className="mb-4 rounded-xl bg-amber-100 p-3 text-sm text-amber-900"
          >
            {storageWarning}
          </p>
        )}
        {nutritionWarning && (
          <p
            role="alert"
            className="mb-4 rounded-xl bg-amber-100 p-3 text-sm text-amber-900"
          >
            {nutritionWarning}
          </p>
        )}
        {(persistenceBlocked || nutritionBlocked) && (
          <div className="mb-4 flex flex-wrap gap-2">
            <button
              className={`${button} bg-white border border-[#dfe5dc]`}
              onClick={downloadUnsaved}
            >
              Download unsaved data
            </button>
            <button
              className={button}
              onClick={() => {
                if (
                  window.confirm(
                    "Load the latest saved data? Unsaved edits in this tab will be discarded. Download unsaved data first if you want to keep it.",
                  )
                )
                  window.location.reload();
              }}
            >
              Load latest saved data
            </button>
          </div>
        )}
        {section === "home" ? (
          <Home
            tracker={store}
            nutrition={nutrition}
            navigate={navigate}
            cloud={!!cloud}
          />
        ) : section === "nutrition" ? (
          <Nutrition
            store={nutrition}
            setStore={setNutrition}
            quickLog={quickLog}
            onGoals={() => navigate("settings")}
            cloud={!!cloud}
            onDateChange={cloud?.loadDay}
            serverDay={cloud?.day}
          />
        ) : section === "progress" ? (
          <Progress tracker={store} nutrition={nutrition} />
        ) : section === "settings" ? (
          <Settings
            store={nutrition}
            setStore={setNutrition}
            cloud={!!cloud}
            onUnit={(unit) => setSession((s) => ({ ...s, unit }))}
          />
        ) : (
          <>
            <nav
              aria-label="FORM sections"
              className="mb-5 flex gap-1 rounded-2xl border border-[#dfe5dc] bg-white p-1"
            >
              {(["workout", "library", "templates", "history"] as const).map(
                (section) => (
                  <button
                    key={section}
                    aria-current={view === section ? "page" : undefined}
                    className={`${button} min-w-0 flex-1 px-2 text-xs sm:px-3 sm:text-sm ${view === section ? "bg-[#244b3c] text-white" : "text-[#6c7c6e]"}`}
                    onClick={() => {
                      navigate("workouts", section);
                    }}
                  >
                    {section === "workout"
                      ? "Workout"
                      : section === "library"
                        ? "Library"
                        : section === "templates"
                          ? "Templates"
                          : "History"}
                  </button>
                ),
              )}
            </nav>
            {view === "workout" && (
              <div className="mb-5 flex items-center justify-between">
                <span className="text-xs font-bold tracking-[.16em] text-[#728274]">
                  TRAINING / {session.trainingType.toUpperCase()}
                </span>
                <label className="flex items-center gap-2 text-xs font-medium">
                  Units
                  <select
                    aria-label="Weight units"
                    value={session.unit}
                    onChange={(e) => {
                      const unit = e.target.value as Unit;
                      setSession((s) => ({ ...s, unit }));
                      setNutrition((n) => ({
                        ...n,
                        user: { ...n.user, unit },
                      }));
                    }}
                    className="min-h-11 rounded-xl border border-[#d8dfd4] bg-white px-3"
                  >
                    <option>kg</option>
                    <option>lb</option>
                  </select>
                </label>
              </div>
            )}
            {view === "library" ? (
              <>
                {replacing && (
                  <p className="mb-4 rounded-xl bg-[#edf1e7] p-3 text-sm">
                    Choose the replacement exercise. Only this session changes.{" "}
                    <button
                      className={button}
                      onClick={() => {
                        setReplacing(null);
                        navigate("workouts", "workout");
                      }}
                    >
                      Cancel replacement
                    </button>
                  </p>
                )}
                <ExerciseLibrary
                  timeZone={nutrition.user.timeZone}
                  store={store}
                  setStore={setStore}
                  onAdd={
                    replacing
                      ? (exercise) => {
                          setStore(
                            replaceInSession(store, replacing, exercise.id),
                          );
                          setReplacing(null);
                          navigate("workouts", "workout");
                        }
                      : undefined
                  }
                />
              </>
            ) : view === "templates" ? (
              <Templates
                timeZone={nutrition.user.timeZone}
                store={store}
                setStore={setStore}
                onStart={() => {
                  navigate("workouts", "workout");
                  setDeadline(null);
                  setCollapsed([]);
                }}
              />
            ) : view === "history" ? (
              <WorkoutArchive
                key={historySession ?? "archive"}
                initialSession={historySession}
                onSelect={(id) =>
                  navigate("workouts", id ? `history:${id}` : "history")
                }
                tracker={store}
                timeZone={nutrition.user.timeZone}
              />
            ) : session.finished ? (
              <>
                <div className="rounded-3xl bg-[#244b3c] p-7 text-white">
                  <Check
                    className="mb-5 rounded-full bg-[#d6ecb4] p-2 text-[#244b3c]"
                    size={48}
                  />
                  <p className="text-xs font-bold tracking-widest text-[#d6ecb4]">
                    SESSION COMPLETE
                  </p>
                  <h1 className="mt-3 text-4xl font-bold tracking-tight">
                    Work put in.
                  </h1>
                  <p className="mt-3 text-[#d7e0d7]">
                    {session.name} ·{" "}
                    {cloud
                      ? "Cloud save status is shown above."
                      : "Your session is saved in this browser."}
                  </p>
                  <div className="mt-7 grid grid-cols-3 gap-3">
                    <Stat
                      value={String(
                        exercises.filter((e) =>
                          session.logs[e.id].some((s) => s.done),
                        ).length,
                      )}
                      label="Exercises"
                    />
                    <Stat value={String(completed)} label="Completed sets" />
                    <Stat
                      value={totalVolume.toLocaleString()}
                      label={`${session.unit} · reps`}
                    />
                  </div>
                </div>
                <h2 className="mb-3 mt-7 text-lg font-bold">
                  Your session breakdown
                </h2>
                {exercises.map((e) => (
                  <div
                    key={e.id}
                    className="mb-3 rounded-2xl border border-[#dfe5dc] bg-white p-5"
                  >
                    <h3 className="font-semibold">{e.name}</h3>
                    <p className="mt-2 text-sm text-[#677669]">
                      {setCounts(session.logs[e.id]).completed} completed{" "}
                      {e.unilateral
                        ? setCounts(session.logs[e.id]).completed === 1
                          ? "pair"
                          : "pairs"
                        : setCounts(session.logs[e.id]).completed === 1
                          ? "set"
                          : "sets"}
                      {setCounts(session.logs[e.id]).partial
                        ? ` · ${setCounts(session.logs[e.id]).partial} partial ${setCounts(session.logs[e.id]).partial === 1 ? "pair" : "pairs"}`
                        : ""}{" "}
                      ·{" "}
                      {displayLoad(
                        volume(session.logs[e.id]),
                        session.unit,
                      ).toLocaleString()}{" "}
                      {session.unit} · reps
                    </p>
                    <p className="mt-2 text-sm">
                      {session.logs[e.id]
                        .filter((s) => s.done)
                        .map(
                          (s) =>
                            `${s.side === "both" ? "" : s.side + ": "}${s.reps} × ${displayLoad(s.kg, session.unit)} ${session.unit}`,
                        )
                        .join(" / ") || "No sets completed"}
                    </p>
                    {e.unilateral && (
                      <SideComparison
                        sets={session.logs[e.id]}
                        unit={session.unit}
                      />
                    )}
                  </div>
                ))}
                <p className="my-4 text-xs text-[#677669]">
                  Volume is logged load × reps for completed entries. Each
                  unilateral side contributes volume; paired sets count once;
                  cable load conventions are noted per exercise.
                </p>
                {session.notes && (
                  <div className="rounded-2xl bg-white p-5">
                    <h2 className="font-semibold">Workout notes</h2>
                    <p className="mt-2 whitespace-pre-wrap text-sm">
                      {session.notes}
                    </p>
                  </div>
                )}
                <button
                  className={`${button} mt-5 bg-[#244b3c] text-white`}
                  onClick={() => setSession((s) => ({ ...s, finished: false }))}
                >
                  <ChevronLeft size={16} />
                  Back to workout
                </button>
              </>
            ) : (
              <>
                <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
                  {session.name}
                  <span className="text-[#87a472]">.</span>
                </h1>
                <p className="mt-3 text-sm text-[#6c7c6e]">
                  Build with intention. Log one set at a time.
                </p>
                <div className="mt-6 grid grid-cols-3 divide-x divide-[#dce3d5] rounded-2xl border border-[#dce3d5] bg-[#edf1e7] py-4">
                  <Stat value={String(exercises.length)} label="Exercises" />
                  <Stat
                    value={`${completed}/${counts.total}`}
                    label="Sets complete"
                  />
                  <Stat
                    value={totalVolume.toLocaleString()}
                    label={`Volume · ${session.unit} × reps`}
                  />
                </div>
                {counts.partial > 0 && (
                  <p role="status" className="mt-3 text-xs text-[#6c7c6e]">
                    {counts.partial} partially completed{" "}
                    {counts.partial === 1 ? "pair" : "pairs"} · completed sides
                    count toward volume.
                  </p>
                )}
                <div className="mb-5 mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-[#6c7c6e]">
                  <span className="flex items-center gap-2">
                    <History size={14} />
                    Prefilled from previous results where available · mock
                    samples
                  </span>
                  <label className="flex min-h-11 cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={showRpe}
                      onChange={(e) => setShowRpe(e.target.checked)}
                      className="h-4 w-4 accent-[#244b3c]"
                    />
                    Show optional RPE
                  </label>
                </div>
                <div className="mb-4 flex flex-wrap gap-2">
                  <button
                    className={`${button} bg-white border border-[#dfe5dc]`}
                    onClick={() => navigate("workouts", "library")}
                  >
                    <Plus size={16} />
                    Add exercise
                  </button>
                  <button
                    className={`${button} text-[#57775d]`}
                    onClick={() => navigate("workouts", "templates")}
                  >
                    Manage templates
                  </button>
                </div>
                <details className="mb-4 rounded-2xl border border-[#dfe5dc] bg-white p-4">
                  <summary className="min-h-11 cursor-pointer text-sm font-semibold">
                    Edit this workout only
                  </summary>
                  <label className="mt-2 block text-sm">
                    Workout name
                    <input
                      aria-label="Current workout name"
                      maxLength={120}
                      className="mt-1 min-h-11 w-full rounded-xl border border-[#dfe5dc] p-3"
                      value={session.name}
                      onChange={(event) =>
                        setSession((s) => ({
                          ...s,
                          name: event.target.value.trim()
                            ? event.target.value
                            : "Untitled workout",
                        }))
                      }
                    />
                  </label>
                  <p className="mt-2 text-xs text-[#7b897a]">
                    Session changes never update the reusable template. Use
                    Templates to edit a reusable plan or save a new copy.
                  </p>
                </details>
                {!exercises.length && (
                  <p className="mb-4 rounded-2xl bg-white p-5 text-sm">
                    This workout is empty. Add any exercise from your library.
                  </p>
                )}
                <div className="space-y-4">
                  {exercises.map((e, index) => {
                    const sets = session.logs[e.id];
                    const isCollapsed = collapsed.includes(e.id);
                    const exerciseCounts = setCounts(sets);
                    const count = exerciseCounts.completed;
                    return (
                      <section
                        key={e.id}
                        className="overflow-hidden rounded-2xl border border-[#dfe5dc] bg-white shadow-[0_3px_12px_#18352c03]"
                      >
                        <button
                          aria-expanded={!isCollapsed}
                          aria-controls={`${e.id}-content`}
                          onClick={() =>
                            setCollapsed((c) =>
                              isCollapsed
                                ? c.filter((id) => id !== e.id)
                                : [...c, e.id],
                            )
                          }
                          className="flex min-h-20 w-full items-center gap-3 p-4 text-left sm:p-5"
                        >
                          <span
                            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold ${count === exerciseCounts.total && count > 0 ? "bg-[#d6ecb4]" : "bg-[#f1f4ed]"}`}
                          >
                            {count === exerciseCounts.total && count > 0 ? (
                              <Check size={19} />
                            ) : (
                              String(index + 1).padStart(2, "0")
                            )}
                          </span>
                          <span className="flex-1">
                            <span className="mb-1 block text-[10px] font-bold tracking-widest text-[#7b897a]">
                              {e.equipment}
                            </span>
                            <span className="block text-base font-bold sm:text-lg">
                              {e.name}
                            </span>
                          </span>
                          <span className="text-xs text-[#7b897a]">
                            {count}/{exerciseCounts.total}
                            {exerciseCounts.partial ? " · partial" : ""}
                          </span>
                          <ChevronDown
                            size={18}
                            className={isCollapsed ? "-rotate-90" : ""}
                          />
                        </button>
                        {!isCollapsed && (
                          <details className="mx-4 mb-3 rounded-xl bg-[#f6f7f3] px-3 sm:mx-5">
                            <summary className="min-h-11 cursor-pointer py-3 text-xs font-semibold text-[#57775d]">
                              Edit exercise in this session
                            </summary>
                            <div className="flex flex-wrap gap-1">
                              <button
                                className={`${button} disabled:opacity-30`}
                                disabled={index === 0}
                                aria-label={`Move ${e.name} up in session`}
                                onClick={() =>
                                  setSession((s) => ({
                                    ...s,
                                    exercises: move(s.exercises, e.id, -1),
                                  }))
                                }
                              >
                                Move up
                              </button>
                              <button
                                className={`${button} disabled:opacity-30`}
                                disabled={index === exercises.length - 1}
                                aria-label={`Move ${e.name} down in session`}
                                onClick={() =>
                                  setSession((s) => ({
                                    ...s,
                                    exercises: move(s.exercises, e.id, 1),
                                  }))
                                }
                              >
                                Move down
                              </button>
                              <button
                                className={button}
                                aria-label={`Replace ${e.name} in session`}
                                onClick={() => {
                                  if (
                                    !sets.some((s) => s.done) ||
                                    window.confirm(
                                      `Replace ${e.name} and its sets in this current workout? Completed history is preserved.`,
                                    )
                                  ) {
                                    navigate("workouts", "library");
                                    setReplacing(e.id);
                                    window.scrollTo(0, 0);
                                  }
                                }}
                              >
                                Replace exercise
                              </button>
                              <button
                                className={button}
                                aria-label={`Remove ${e.name} from session`}
                                onClick={() => {
                                  if (
                                    !sets.some((s) => s.done) ||
                                    window.confirm(
                                      `Remove ${e.name} and its logged sets from this workout only? Historical sessions are kept.`,
                                    )
                                  )
                                    setStore((s) => removeFromSession(s, e.id));
                                }}
                              >
                                Remove exercise
                              </button>
                            </div>
                            <PrescriptionFields
                              value={
                                session.exercises.find(
                                  (entry) => entry.id === e.id,
                                )!.prescription
                              }
                              onChange={(prescription) =>
                                setSession((s) => ({
                                  ...s,
                                  exercises: s.exercises.map((entry) =>
                                    entry.id === e.id
                                      ? {
                                          ...entry,
                                          prescription: {
                                            ...prescription,
                                            target:
                                              prescription.target.trim() ||
                                              "8–12",
                                          },
                                        }
                                      : entry,
                                  ),
                                }))
                              }
                            />
                            <p className="my-3 text-xs text-[#7b897a]">
                              Plan changes do not change your actual logged
                              sets. Add or remove actual sets below.
                            </p>
                          </details>
                        )}
                        {!isCollapsed && (
                          <div
                            id={`${e.id}-content`}
                            className="px-4 pb-5 sm:px-5"
                          >
                            <div className="mb-4 flex flex-wrap items-center gap-2">
                              <span className="rounded-lg bg-[#edf2e6] px-3 py-2 text-xs font-semibold">
                                PLAN · {e.plannedSets}{" "}
                                {e.unilateral ? "paired sets" : "sets"} ×{" "}
                                {e.target} reps
                              </span>
                              <a
                                className={`${button} ml-auto text-[#57775d]`}
                                href={
                                  e.demoUrl ||
                                  `https://www.youtube.com/results?search_query=${encodeURIComponent(e.name + " technique")}`
                                }
                                target="_blank"
                                rel="noreferrer"
                              >
                                Find a demo
                                <ArrowUpRight size={15} />
                              </a>
                            </div>
                            <p className="mb-4 border-l-2 border-[#c8dcb2] pl-3 text-sm leading-relaxed text-[#6a786c]">
                              {e.note}
                            </p>
                            <div className="mb-4 rounded-xl bg-[#f6f7f3] p-3">
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] font-bold tracking-widest text-[#778474]">
                                  {e.history[0]
                                    ? `PREVIOUS · ${new Date(e.history[0].date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }).toUpperCase()}${e.history[0].mock ? " · MOCK" : ""}`
                                    : "NO PREVIOUS WORKOUT"}
                                </span>
                                <button
                                  className={`${button} -my-2 text-[#355f47]`}
                                  onClick={() => {
                                    setHistoryId(e.id);
                                    if (cloud)
                                      void cloud.loadHistory(e.exerciseId);
                                  }}
                                >
                                  <History size={14} />
                                  History
                                </button>
                              </div>
                              <p className="mt-2 text-xs leading-6 text-[#566954]">
                                {e.history[0]?.sets.map((s, i) => (
                                  <span key={i} className="mr-3 inline-block">
                                    {s.side !== "both" && <b>{s.side} </b>}
                                    {s.reps} × {displayLoad(s.kg, session.unit)}{" "}
                                    {session.unit}
                                    {!s.done && " (not completed)"}
                                  </span>
                                ))}
                              </p>
                            </div>
                            <SetLogger
                              entry={session.exercises.find(
                                (entry) => entry.id === e.id,
                              )!}
                              sets={sets}
                              unit={session.unit}
                              showRpe={showRpe}
                              onEdit={(id, patch) => update(e.id, id, patch)}
                              onSharedWeight={(sameWeight) =>
                                setSession((s) => ({
                                  ...s,
                                  exercises: s.exercises.map((entry) =>
                                    entry.id === e.id
                                      ? { ...entry, sameWeight }
                                      : entry,
                                  ),
                                }))
                              }
                              onAdd={() =>
                                setSession((s) => appendSet(s, e.id))
                              }
                              onRemove={(groupId) =>
                                setSession((s) =>
                                  removeSetGroup(s, e.id, groupId),
                                )
                              }
                              onRest={startTimer}
                            />
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
                <section className="mt-6 rounded-2xl border border-[#dfe5dc] bg-white p-5">
                  <label htmlFor="notes" className="font-bold">
                    How did it feel?
                    <span className="ml-2 text-xs font-normal text-[#7b897a]">
                      Optional
                    </span>
                  </label>
                  <textarea
                    id="notes"
                    maxLength={2000}
                    rows={3}
                    value={session.notes}
                    onChange={(e) =>
                      setSession((s) => ({ ...s, notes: e.target.value }))
                    }
                    placeholder="Energy, technique cues, small wins…"
                    className="mt-3 w-full resize-y rounded-xl border border-[#dfe5dc] bg-[#fafbf8] p-3 text-sm"
                  />
                </section>
                <p className="mt-5 text-center text-xs leading-5 text-[#7b897a]">
                  {cloud
                    ? "Your workout saves online. Check the save status before closing this page."
                    : "Saved on this browser only · Sample history is marked mock."}
                  <br />
                  {cloud
                    ? "Local prototype records stay separate from your account."
                    : "Use cloud account for separate signed-in records. Public signup is unavailable."}
                </p>
              </>
            )}
          </>
        )}
      </main>
      <nav
        aria-label="Main navigation"
        className="fixed inset-x-0 bottom-0 z-20 h-[calc(72px+env(safe-area-inset-bottom))] border-t border-[#dce3d7] bg-white px-2 pt-2 pb-[env(safe-area-inset-bottom)]"
      >
        <div className="mx-auto flex max-w-3xl gap-1">
          {(
            [
              ["home", "Home", House],
              ["workouts", "Workouts", Dumbbell],
              ["nutrition", "Nutrition", Utensils],
              ["progress", "Progress", ChartNoAxesCombined],
              ["settings", "Settings", SettingsIcon],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              className={`flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-semibold sm:text-xs ${section === key ? "bg-[#edf1e7] text-[#244b3c]" : "text-[#728274]"}`}
              aria-current={section === key ? "page" : undefined}
              onClick={() => navigate(key)}
            >
              <Icon size={20} />
              {label}
            </button>
          ))}
        </div>
      </nav>
      {section === "workouts" && view === "workout" && !session.finished && (
        <footer className="fixed inset-x-0 bottom-[calc(72px+env(safe-area-inset-bottom))] border-t border-[#dce3d7] bg-white px-4 pb-3 pt-3">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2 sm:gap-4">
            <button
              className={`${button} px-2 text-[#57775d]`}
              aria-label="Start or restart rest timer"
              disabled={!restDuration}
              onClick={startTimer}
            >
              <Timer size={20} />
              <span className="min-w-10 tabular-nums">
                {deadline
                  ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`
                  : remaining === 0
                    ? "Rest"
                    : "Ready"}
              </span>
            </button>
            <select
              aria-label="Rest duration"
              className="min-h-11 rounded-xl bg-[#f0f3eb] px-2 text-xs"
              value={restDuration}
              onChange={(e) => {
                const duration = Number(e.target.value);
                setRestDuration(duration);
                if (!duration) {
                  setDeadline(null);
                  setRemaining(0);
                }
              }}
            >
              <option value={0}>Off</option>
              <option value={60}>60s</option>
              <option value={90}>90s</option>
              <option value={120}>120s</option>
              <option value={180}>180s</option>
            </select>
            {deadline && (
              <button
                aria-label="Stop timer"
                className="min-h-11 min-w-11"
                onClick={() => {
                  setDeadline(null);
                  setRemaining(0);
                }}
              >
                <X size={16} />
              </button>
            )}
            <button
              disabled={completedSides === 0}
              className={`${button} ml-auto bg-[#244b3c] px-4 text-white disabled:cursor-not-allowed disabled:opacity-40 sm:px-6`}
              onClick={() =>
                completed < counts.total ? setConfirmFinish(true) : finish()
              }
            >
              Finish workout
              <Check size={17} />
            </button>
          </div>
          <span role="status" className="sr-only">
            {!deadline && remaining === 0
              ? "Rest timer stopped or complete"
              : ""}
          </span>
        </footer>
      )}
      {historyExercise && (
        <div
          className="fixed inset-0 z-30 overflow-y-auto bg-[#10271cd9] p-4"
          onKeyDown={trapDialogFocus}
          role="dialog"
          aria-modal="true"
          aria-labelledby="history-title"
        >
          <div className="mx-auto my-8 max-w-xl rounded-3xl bg-[#f5f6f2] p-5 sm:p-7">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold tracking-widest text-[#718269]">
                  EXERCISE HISTORY · PRIVATE LOCAL DATA
                </p>
                <h2 id="history-title" className="mt-2 text-2xl font-bold">
                  {historyExercise.name}
                </h2>
              </div>
              <button
                autoFocus
                className={`${button} shrink-0`}
                aria-label="Close history"
                onClick={() => setHistoryId(null)}
              >
                <X />
              </button>
            </div>
            <p className="my-5 text-sm text-[#63725f]">
              {historyExercise.history.length > 0
                ? `${historyExercise.history.length} previous exercise entries. Review each side’s completed loads, reps and RPE below; volume progression is available in Progress.`
                : "No completed sessions yet. Your first workout will appear here."}
            </p>
            <PerformanceHistory
              sessions={historyExercise.history}
              unit={session.unit}
            />
            <button
              className={`${button} w-full bg-[#244b3c] text-white`}
              onClick={() => setHistoryId(null)}
            >
              Back to session
            </button>
          </div>
        </div>
      )}
      {confirmFinish && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-[#10271cd9] p-5"
          onKeyDown={trapDialogFocus}
          role="dialog"
          aria-modal="true"
          aria-labelledby="finish-title"
        >
          <div className="max-w-sm rounded-3xl bg-white p-6">
            <h2 id="finish-title" className="text-xl font-bold">
              Finish this session?
            </h2>
            <p className="my-4 text-sm leading-6 text-[#63725f]">
              You completed {completed} of {counts.total} sets
              {counts.partial ? `, with ${counts.partial} partial pairs` : ""}.
              Completed sides are saved and count toward volume, even when their
              paired side is unfinished.
            </p>
            <button
              autoFocus
              className={`${button} w-full bg-[#244b3c] text-white`}
              onClick={finish}
            >
              Finish & view summary
            </button>
            <button
              className={`${button} mt-2 w-full`}
              onClick={() => setConfirmFinish(false)}
            >
              Keep training
            </button>
          </div>
        </div>
      )}
    </>
  );
}
function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="text-center">
      <p className="text-2xl font-bold tracking-tight">{value}</p>
      <p className="mt-1 text-[10px] tracking-wide opacity-70 sm:text-xs">
        {label}
      </p>
    </div>
  );
}
function trapDialogFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (event.key !== "Tab") return;
  const controls = event.currentTarget.querySelectorAll<HTMLElement>(
    "button, a[href], input, select, textarea",
  );
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
