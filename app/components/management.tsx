"use client";
import { PerformanceHistory } from "./performance-history";
import { useState, type Dispatch, type SetStateAction } from "react";
import {
  Plus,
  ArrowUp,
  ArrowDown,
  Archive,
  Pencil,
  Copy,
  Search,
  ChevronLeft,
} from "lucide-react";
import {
  equipmentOptions,
  muscles,
  patterns,
  trainingTypes,
  type Exercise,
  type Prescription,
  type TrackerStore,
  type WorkoutTemplate,
} from "@/lib/models";
import {
  addToSession,
  blankExercise,
  canReadExercise,
  historyFor,
  move,
  newId,
  saveExercise,
  saveTemplate,
  shareableTemplate,
  startSession,
  templateFromSession,
} from "@/lib/tracker";
export const control =
  "min-h-11 w-full rounded-xl border border-[#dfe5dc] bg-[#fafbf8] px-3 py-2 text-sm";
export const action =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold";
const panel = "rounded-2xl border border-[#dfe5dc] bg-white p-4 sm:p-5";
type Props = {
  timeZone?: string;
  store: TrackerStore;
  setStore: Dispatch<SetStateAction<TrackerStore>>;
};
export function ExerciseLibrary({
  store,
  setStore,
  onAdd,
  addLabel = "workout",
  timeZone = "America/Los_Angeles",
}: Props & {
  onAdd?: (exercise: Exercise) => void;
  addLabel?: "workout" | "template";
}) {
  const [search, setSearch] = useState("");
  const [primary, setPrimary] = useState("");
  const [equipment, setEquipment] = useState("");
  const [pattern, setPattern] = useState("");
  const [type, setType] = useState("");
  const [tag, setTag] = useState("");
  const [source, setSource] = useState("");
  const [archived, setArchived] = useState(false);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<Exercise | null>(null);
  const [message, setMessage] = useState("");
  const visible = store.library.filter(
    (e) =>
      canReadExercise(e, store.userId) &&
      (archived || !e.archived) &&
      (!primary || e.primaryMuscle === primary) &&
      (!equipment || e.equipment === equipment) &&
      (!pattern || e.movementPattern === pattern) &&
      (!type ||
        e.trainingTypes.includes(type as Exercise["trainingTypes"][number])) &&
      (!tag || e.tags.includes(tag)) &&
      (!source || e.source === source) &&
      [
        e.name,
        e.primaryMuscle,
        ...e.secondaryMuscles,
        e.equipment,
        e.movementPattern,
        ...e.tags,
      ]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase().trim()),
  );
  const tags = Array.from(
    new Set(
      store.library
        .filter((e) => canReadExercise(e, store.userId))
        .flatMap((e) => e.tags),
    ),
  ).sort();
  function save(exercise: Exercise) {
    try {
      setStore(saveExercise(store, exercise));
      setEditing(null);
      setMessage(
        "Exercise saved. Existing session snapshots and history stay unchanged.",
      );
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  function add(exercise: Exercise) {
    if (onAdd) {
      onAdd(exercise);
    } else {
      setStore(addToSession(store, exercise.id));
    }
    setMessage(`Added ${exercise.name} to this ${addLabel} only.`);
  }
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          Exercise library<span className="text-[#87a472]">.</span>
        </h1>
        <p className="mt-2 text-sm text-[#6c7c6e]">
          Your movements, your way. Start with a name; add detail when you need
          it.
        </p>
      </div>
      <form
        className={panel}
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          save(blankExercise(name, store.userId));
          setName("");
        }}
      >
        <label htmlFor="quick-exercise" className="text-sm font-bold">
          Create a custom exercise
        </label>
        <div className="mt-3 flex gap-2">
          <input
            id="quick-exercise"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Bulgarian split squat"
            className={`${control} min-w-0 flex-1`}
          />
          <button
            className={`${action} bg-[#244b3c] text-white`}
            aria-label="Create exercise"
          >
            <Plus size={16} />
            <span>Create</span>
          </button>
        </div>
        <p className="mt-2 text-xs text-[#7b897a]">
          No extra fields required. Use Edit to add optional attributes.
        </p>
      </form>
      {message && (
        <p role="status" className="rounded-xl bg-[#edf2e6] p-3 text-sm">
          {message}
        </p>
      )}
      {editing && (
        <ExerciseEditor
          key={editing.id}
          exercise={editing}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      )}
      <div className={panel}>
        <label className="relative block">
          <Search
            size={16}
            className="absolute left-3 top-3.5 text-[#7b897a]"
          />
          <input
            aria-label="Search exercises"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search names, muscles or tags"
            className={`${control} pl-9`}
          />
        </label>
        <details className="mt-2">
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold">
            Filter exercises
          </summary>
          <div className="grid grid-cols-2 gap-2">
            <Filter
              label="Primary muscle filter"
              value={primary}
              onChange={setPrimary}
              options={muscles}
            />
            <Filter
              label="Equipment filter"
              value={equipment}
              onChange={setEquipment}
              options={equipmentOptions}
            />
            <Filter
              label="Movement filter"
              value={pattern}
              onChange={setPattern}
              options={patterns}
            />
            <Filter
              label="Training type filter"
              value={type}
              onChange={setType}
              options={trainingTypes}
            />
            <Filter
              label="Tag filter"
              value={tag}
              onChange={setTag}
              options={tags}
            />
            <Filter
              label="Source filter"
              value={source}
              onChange={setSource}
              options={["system", "custom"]}
            />
          </div>
          <label className="mt-2 flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => setArchived(e.target.checked)}
            />
            Include archived
          </label>
          <button
            type="button"
            className={action}
            onClick={() => {
              setPrimary("");
              setEquipment("");
              setPattern("");
              setType("");
              setTag("");
              setSource("");
              setArchived(false);
            }}
          >
            Clear filters
          </button>
        </details>
      </div>
      <p className="text-xs text-[#7b897a]">
        {visible.length} exercises · System exercises can be copied and
        customized.
      </p>
      {!visible.length && (
        <p className={panel}>
          No matching exercises. Try a different search or create your own.
        </p>
      )}
      {visible.map((e) => (
        <article className={panel} key={e.id}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-[#7b897a]">
                {e.source === "system"
                  ? "System exercise"
                  : "Your custom exercise"}
                {e.archived ? " · Archived" : ""}
              </p>
              <h2 className="text-lg font-bold">{e.name}</h2>
              <p className="mt-1 text-xs text-[#6c7c6e]">
                {[e.primaryMuscle, e.equipment, e.movementPattern]
                  .filter(Boolean)
                  .join(" · ") || "Attributes optional"}
                {e.unilateral ? " · Left / right" : ""}
              </p>
              {e.secondaryMuscles.length > 0 && (
                <p className="mt-2 text-xs text-[#6c7c6e]">
                  Secondary: {e.secondaryMuscles.join(", ")}
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-1">
                {e.tags.map((t) => (
                  <span
                    key={t}
                    className="rounded-lg bg-[#edf2e6] px-2 py-1 text-xs"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1">
            {!e.archived && (
              <button
                className={`${action} bg-[#244b3c] text-white disabled:opacity-40`}
                disabled={addLabel === "workout" && store.session.finished}
                aria-label={`Add ${e.name} to ${addLabel}`}
                onClick={() => add(e)}
              >
                <Plus size={16} />
                Add to {addLabel}
              </button>
            )}
            {e.source === "custom" && e.ownerId === store.userId ? (
              <>
                <button
                  className={action}
                  aria-label={`Edit ${e.name}`}
                  onClick={() => {
                    setEditing(structuredClone(e));
                    setMessage("");
                  }}
                >
                  <Pencil size={15} />
                  Edit
                </button>
                <button
                  className={action}
                  aria-label={`${e.archived ? "Restore" : "Archive"} ${e.name}`}
                  onClick={() => save({ ...e, archived: !e.archived })}
                >
                  <Archive size={15} />
                  {e.archived ? "Restore" : "Archive"}
                </button>
              </>
            ) : (
              <button
                className={action}
                aria-label={`Customize ${e.name}`}
                onClick={() => {
                  const copy = {
                    ...structuredClone(e),
                    ...blankExercise(e.name + " (custom)", store.userId),
                    primaryMuscle: e.primaryMuscle,
                    secondaryMuscles: [...e.secondaryMuscles],
                    movementPattern: e.movementPattern,
                    equipment: e.equipment,
                    tags: [...e.tags],
                    trainingTypes: [...e.trainingTypes],
                    unilateral: e.unilateral,
                    coachingNotes: e.coachingNotes,
                    demoUrl: e.demoUrl,
                  };
                  setStore(saveExercise(store, copy));
                  setEditing(copy);
                }}
              >
                <Copy size={15} />
                Customize copy
              </button>
            )}
          </div>
          <LibraryHistory store={store} exercise={e} timeZone={timeZone} />
        </article>
      ))}
      {addLabel === "workout" && store.session.finished && (
        <p className="text-sm text-[#6c7c6e]">
          Resume your workout or start a template to add exercises.
        </p>
      )}
    </div>
  );
}
function Filter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
}) {
  return (
    <label className="text-xs text-[#6c7c6e]">
      {label.replace(" filter", "")}
      <select
        aria-label={label}
        className={`${control} mt-1`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">All</option>
        {options.map((v) => (
          <option key={v}>{v}</option>
        ))}
      </select>
    </label>
  );
}
function ExerciseEditor({
  exercise,
  onSave,
  onCancel,
}: {
  exercise: Exercise;
  onSave: (e: Exercise) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(exercise);
  const [tags, setTags] = useState(exercise.tags.join(", "));
  return (
    <form
      className={panel}
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          ...draft,
          name: draft.name.trim(),
          tags: Array.from(
            new Set(
              tags
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
            ),
          ),
        });
      }}
    >
      <h2 className="mb-3 font-bold">Edit custom exercise</h2>
      <label className="text-sm">
        Exercise name
        <input
          autoFocus
          required
          maxLength={120}
          className={`${control} mt-1`}
          value={draft.name}
          onChange={(e) => setDraft((v) => ({ ...v, name: e.target.value }))}
        />
      </label>
      <label className="my-2 flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.unilateral}
          onChange={(e) =>
            setDraft((v) => ({ ...v, unilateral: e.target.checked }))
          }
        />
        Log left and right separately
      </label>
      <details open={!!exercise.primaryMuscle || !!exercise.tags.length}>
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold">
          Advanced attributes (optional)
        </summary>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(["primaryMuscle", "equipment", "movementPattern"] as const).map(
            (field, i) => (
              <label key={field} className="text-sm">
                {["Primary muscle", "Equipment", "Movement pattern"][i]}
                <select
                  className={`${control} mt-1`}
                  value={draft[field] ?? ""}
                  onChange={(e) =>
                    setDraft((v) => ({ ...v, [field]: e.target.value || null }))
                  }
                >
                  <option value="">Not specified</option>
                  {(field === "primaryMuscle"
                    ? muscles
                    : field === "equipment"
                      ? equipmentOptions
                      : patterns
                  ).map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </label>
            ),
          )}
          <label className="text-sm">
            Custom tags (comma separated)
            <input
              className={`${control} mt-1`}
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="e.g. home gym, favourite"
            />
          </label>
        </div>
        <fieldset className="mt-4">
          <legend className="text-sm font-semibold">Secondary muscles</legend>
          <div className="grid grid-cols-2 gap-x-2">
            {muscles.map((m) => (
              <label
                key={m}
                className="flex min-h-11 items-center gap-2 text-xs"
              >
                <input
                  type="checkbox"
                  checked={draft.secondaryMuscles.includes(m)}
                  onChange={(e) =>
                    setDraft((v) => ({
                      ...v,
                      secondaryMuscles: e.target.checked
                        ? [...v.secondaryMuscles, m]
                        : v.secondaryMuscles.filter((x) => x !== m),
                    }))
                  }
                />
                {m}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="mt-3">
          <legend className="text-sm font-semibold">Training types</legend>
          <div className="flex flex-wrap gap-x-3">
            {trainingTypes.map((t) => (
              <label
                key={t}
                className="flex min-h-11 items-center gap-2 text-xs"
              >
                <input
                  type="checkbox"
                  checked={draft.trainingTypes.includes(t)}
                  onChange={(e) =>
                    setDraft((v) => ({
                      ...v,
                      trainingTypes: e.target.checked
                        ? [...v.trainingTypes, t]
                        : v.trainingTypes.filter((x) => x !== t),
                    }))
                  }
                />
                {t}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="mt-3 block text-sm">
          Coaching notes
          <textarea
            maxLength={2000}
            className={`${control} mt-1`}
            value={draft.coachingNotes}
            onChange={(e) =>
              setDraft((v) => ({ ...v, coachingNotes: e.target.value }))
            }
          />
        </label>
        <label className="mt-3 block text-sm">
          Demonstration URL
          <input
            type="url"
            className={`${control} mt-1`}
            value={draft.demoUrl}
            onChange={(e) =>
              setDraft((v) => ({ ...v, demoUrl: e.target.value }))
            }
            placeholder="https://…"
          />
        </label>
      </details>
      <div className="mt-3 flex gap-2">
        <button className={`${action} bg-[#244b3c] text-white`}>
          Save exercise
        </button>
        <button type="button" className={action} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="mt-3 text-xs text-[#7b897a]">
        Changes apply to the library and future sessions. Logged sessions keep
        their original exercise snapshot.
      </p>
    </form>
  );
}
function LibraryHistory({
  store,
  exercise,
  timeZone,
}: {
  store: TrackerStore;
  exercise: Exercise;
  timeZone: string;
}) {
  const sessions = historyFor(store, exercise.id, "", timeZone);
  return (
    <details className="mt-2">
      <summary className="min-h-11 cursor-pointer py-3 text-sm text-[#57775d]">
        Performance history ({sessions.length})
      </summary>
      {sessions.length ? (
        <PerformanceHistory sessions={sessions} unit={store.session.unit} />
      ) : (
        <p className="text-xs text-[#7b897a]">
          No completed history yet. Your first session will appear here.
        </p>
      )}
    </details>
  );
}
export function PrescriptionFields({
  value,
  onChange,
}: {
  value: Prescription;
  onChange: (value: Prescription) => void;
}) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-2">
      <label className="text-xs">
        Planned sets
        <input
          aria-label="Planned sets"
          className={`${control} mt-1`}
          type="number"
          min={1}
          max={20}
          value={value.plannedSets}
          onChange={(e) =>
            onChange({
              ...value,
              plannedSets: Math.min(
                20,
                Math.max(1, Math.floor(Number(e.target.value))),
              ),
            })
          }
        />
      </label>
      <label className="text-xs">
        Rep target
        <input
          aria-label="Rep target"
          required
          maxLength={40}
          className={`${control} mt-1`}
          value={value.target}
          onChange={(e) => onChange({ ...value, target: e.target.value })}
        />
      </label>
      <label className="col-span-2 text-xs">
        Coaching notes
        <textarea
          aria-label="Plan coaching notes"
          maxLength={2000}
          className={`${control} mt-1`}
          value={value.note}
          onChange={(e) => onChange({ ...value, note: e.target.value })}
        />
      </label>
    </div>
  );
}
export function Templates({
  store,
  setStore,
  onStart,
  timeZone = "America/Los_Angeles",
}: Props & { onStart: () => void }) {
  const [draft, setDraft] = useState<WorkoutTemplate | null>(null);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  function start(id: string) {
    try {
      setStore(startSession(store, id));
      setPending(null);
      onStart();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  function download(t: WorkoutTemplate) {
    try {
      const safe = shareableTemplate(store, t);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(safe, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "form-template.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(
        "Template exported. No private session logs, workout notes or history were included. Nothing was published.",
      );
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  if (draft)
    return (
      <div className="space-y-4">
        <button
          className={action}
          onClick={() => {
            setDraft(null);
            setPicker(false);
          }}
        >
          <ChevronLeft size={16} />
          Back to templates
        </button>
        <h1 className="text-3xl font-bold">
          Edit template<span className="text-[#87a472]">.</span>
        </h1>
        <p className="text-sm text-[#6c7c6e]">
          Reusable plan only. Your current session and past results stay
          unchanged.
        </p>
        {message && (
          <p role="status" className={panel}>
            {message}
          </p>
        )}
        <form
          className={panel}
          onSubmit={(e) => {
            e.preventDefault();
            try {
              setStore(saveTemplate(store, draft));
              setDraft(null);
              setPicker(false);
              setMessage("Template saved. Current workout unchanged.");
            } catch (error) {
              setMessage((error as Error).message);
            }
          }}
        >
          <label className="text-sm font-bold">
            Template name
            <input
              className={`${control} mt-2`}
              value={draft.name}
              maxLength={120}
              required
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className="mt-3 block text-sm">
            Training type
            <select
              className={`${control} mt-1`}
              value={draft.trainingType}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  trainingType: e.target
                    .value as WorkoutTemplate["trainingType"],
                })
              }
            >
              {trainingTypes.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <div className="mt-4 space-y-3">
            {draft.exercises.map((entry, i) => {
              const exercise = store.library.find(
                (e) => e.id === entry.exerciseId,
              )!;
              return (
                <div
                  key={entry.id}
                  className="rounded-xl border border-[#dfe5dc] p-3"
                >
                  <h2 className="font-bold">
                    {i + 1}. {exercise.name}
                    {exercise.archived ? " (archived)" : ""}
                  </h2>
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      aria-label={`Move ${exercise.name} up`}
                      disabled={i === 0}
                      className={`${action} disabled:opacity-30`}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          exercises: move(draft.exercises, entry.id, -1),
                        })
                      }
                    >
                      <ArrowUp size={16} />
                      Up
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${exercise.name} down`}
                      disabled={i === draft.exercises.length - 1}
                      className={`${action} disabled:opacity-30`}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          exercises: move(draft.exercises, entry.id, 1),
                        })
                      }
                    >
                      <ArrowDown size={16} />
                      Down
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${exercise.name} from template`}
                      className={action}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          exercises: draft.exercises.filter(
                            (e) => e.id !== entry.id,
                          ),
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                  <label className="mt-2 block text-xs">
                    Replace exercise in template
                    <select
                      aria-label={`Replace ${exercise.name} in template`}
                      className={`${control} my-2`}
                      value={entry.exerciseId}
                      onChange={(event) => {
                        const selected = store.library.find(
                          (e) => e.id === event.target.value,
                        )!;
                        setDraft({
                          ...draft,
                          exercises: draft.exercises.map((e) =>
                            e.id === entry.id
                              ? {
                                  ...e,
                                  exerciseId: selected.id,
                                  prescription: {
                                    ...e.prescription,
                                    note: selected.coachingNotes,
                                  },
                                }
                              : e,
                          ),
                        });
                      }}
                    >
                      {store.library
                        .filter(
                          (e) =>
                            canReadExercise(e, store.userId) &&
                            (!e.archived || e.id === entry.exerciseId),
                        )
                        .map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <PrescriptionFields
                    value={entry.prescription}
                    onChange={(p) =>
                      setDraft({
                        ...draft,
                        exercises: draft.exercises.map((e) =>
                          e.id === entry.id ? { ...e, prescription: p } : e,
                        ),
                      })
                    }
                  />
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className={`${action} my-3 text-[#57775d]`}
            onClick={() => setPicker(!picker)}
          >
            <Plus size={16} />
            {picker ? "Hide exercise picker" : "Add exercise to template"}
          </button>
          <div className="flex gap-2">
            <button className={`${action} bg-[#244b3c] text-white`}>
              Save template
            </button>
            <button
              type="button"
              className={action}
              onClick={() => {
                setDraft(null);
                setPicker(false);
              }}
            >
              Discard changes
            </button>
          </div>
        </form>
        {picker && (
          <ExerciseLibrary
            timeZone={timeZone}
            store={store}
            setStore={setStore}
            addLabel="template"
            onAdd={(exercise) =>
              setDraft({
                ...draft,
                exercises: [
                  ...draft.exercises,
                  {
                    id: newId(),
                    exerciseId: exercise.id,
                    prescription: {
                      plannedSets: 3,
                      target: "8–12",
                      note: exercise.coachingNotes,
                    },
                  },
                ],
              })
            }
          />
        )}
      </div>
    );
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">
        Workout templates<span className="text-[#87a472]">.</span>
      </h1>
      <p className="text-sm text-[#6c7c6e]">
        Make a plan once. Bring it to your next session.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          className={`${action} bg-[#244b3c] text-white`}
          onClick={() => {
            const t = templateFromSession(store, "My workout");
            setDraft({ ...t, exercises: [] });
            setMessage("");
          }}
        >
          <Plus size={16} />
          New template
        </button>
        <button
          className={`${action} border border-[#dfe5dc] bg-white`}
          onClick={() => {
            setDraft(templateFromSession(store, store.session.name + " copy"));
            setMessage("");
          }}
        >
          <Copy size={16} />
          Save current as template
        </button>
      </div>
      {message && (
        <p role="status" className={panel}>
          {message}
        </p>
      )}
      {pending && (
        <div role="alert" className={panel}>
          <h2 className="font-bold">Start a new workout?</h2>
          <p className="my-3 text-sm text-[#6c7c6e]">
            This replaces your unfinished current workout. Completed history is
            preserved. Finish the current session first if you want to keep its
            results.
          </p>
          <button
            className={`${action} bg-[#244b3c] text-white`}
            onClick={() => start(pending)}
          >
            Replace current workout
          </button>
          <button className={action} onClick={() => setPending(null)}>
            Keep current workout
          </button>
        </div>
      )}
      {store.templates
        .filter((t) => t.ownerId === store.userId || t.visibility === "public")
        .map((t) => (
          <article key={t.id} className={panel}>
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#7b897a]">
              {t.trainingType} · {t.visibility} template
            </p>
            <h2 className="mt-1 text-xl font-bold">{t.name}</h2>
            <ol className="my-3 space-y-1 text-sm text-[#6c7c6e]">
              {t.exercises.map((e) => (
                <li key={e.id}>
                  {store.library.find((l) => l.id === e.exerciseId)?.name ??
                    "Unavailable exercise"}{" "}
                  · {e.prescription.plannedSets} × {e.prescription.target}
                </li>
              ))}
            </ol>
            {!t.exercises.length && (
              <p className="my-3 text-sm text-[#6c7c6e]">
                No exercises yet. Edit this template to add some.
              </p>
            )}
            <div className="flex flex-wrap gap-1">
              <button
                disabled={!t.exercises.length}
                className={`${action} bg-[#244b3c] text-white disabled:opacity-40`}
                aria-label={`Start ${t.name}`}
                onClick={() => {
                  setMessage("");
                  if (store.session.exercises.length && !store.session.finished)
                    setPending(t.id);
                  else start(t.id);
                }}
              >
                Start workout
              </button>
              {t.ownerId === store.userId && (
                <button
                  aria-label={`Edit template ${t.name}`}
                  className={action}
                  onClick={() => {
                    setDraft(structuredClone(t));
                    setMessage("");
                  }}
                >
                  Edit template
                </button>
              )}
              <button
                aria-label={`Export template ${t.name}`}
                className={action}
                onClick={() => download(t)}
              >
                Export for sharing
              </button>
            </div>
          </article>
        ))}
      <p className="text-xs leading-5 text-[#7b897a]">
        Exports include exercise definitions and prescriptions only. Sharing
        exercise names, tags and coaching notes is intentional; review these
        before sharing. Exporting a template does not publish it or include
        private workout history.
      </p>
    </div>
  );
}
