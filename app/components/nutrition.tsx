"use client";
import type { Day } from "@/lib/cloud-workspace";
import { matchesCatalogSearch } from "@/lib/catalog-search";
import {
  useState,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
} from "react";
import {
  Plus,
  Search,
  Star,
  ChevronLeft,
  ChevronRight,
  Utensils,
  Pencil,
  Trash2,
} from "lucide-react";
import { action, control } from "./management";
import { newId } from "@/lib/tracker";
import {
  preparations,
  meals,
  today,
  shiftDate,
  dayTotals,
  scale,
  sum,
  zero,
  entryNutrition,
  recipeTotal,
  recipePer100g,
  logPortion,
  editDiary,
  deleteDiary,
  saveFood,
  saveRecipe,
  toggleFavorite,
  type NutritionStore,
  type Nutrients,
  type Food,
  type Recipe,
  type DiaryEntry,
} from "@/lib/nutrition";
export const panel = "rounded-2xl border border-[#dfe5dc] bg-white p-4 sm:p-5";
export const primary = `${action} bg-[#244b3c] text-white`;
export const muted = "text-sm text-[#6c7c6e]";
export const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(n);
const nutrientFields = [
  ["calories", "Calories", "kcal"],
  ["protein", "Protein", "g"],
  ["carbs", "Carbohydrates", "g"],
  ["fat", "Fat", "g"],
] as const;
export type NutritionProps = {
  store: NutritionStore;
  setStore: Dispatch<SetStateAction<NutritionStore>>;
};
export function NutritionSummary({
  totals,
  goals,
  onGoals,
}: {
  totals: Nutrients;
  goals: Nutrients;
  onGoals?: () => void;
}) {
  const remaining = goals.calories - totals.calories;
  return (
    <div className={panel}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-widest text-[#728274]">
          Daily nutrition
        </p>
        {onGoals && (
          <button className={`${action} text-[#57775d]`} onClick={onGoals}>
            Edit Goals
          </button>
        )}
      </div>
      <div className="my-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <span className="text-4xl font-bold tracking-tight">
            {fmt(totals.calories)}
          </span>
          <span className={muted}> / {fmt(goals.calories)} kcal</span>
        </div>
        <p className={muted}>
          {fmt(Math.abs(remaining))} kcal{" "}
          {remaining >= 0 ? "remaining" : "over target"}
        </p>
      </div>
      <Meter
        value={totals.calories}
        target={goals.calories}
        label="Calorie progress"
      />
      <div className="mt-5 grid grid-cols-3 gap-3">
        {nutrientFields.slice(1).map(([key, label]) => (
          <div key={key}>
            <p className="text-xs font-semibold">
              {key === "carbs" ? "Carbs" : label}
            </p>
            <p className="my-2 text-xs text-[#6c7c6e]">
              {fmt(totals[key])} / {fmt(goals[key])} g
            </p>
            <Meter
              value={totals[key]}
              target={goals[key]}
              label={`${label} progress`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
export function Meter({
  value,
  target,
  label,
}: {
  value: number;
  target: number;
  label: string;
}) {
  const percent = target > 0 ? Math.min(100, (value / target) * 100) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${fmt(value)} of ${fmt(target)}`}
      className="h-2 overflow-hidden rounded-full bg-[#edf1e7]"
    >
      <div
        className="h-full rounded-full bg-[#86a66e]"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
export function NutritionNumbers({
  value,
  suffix = "",
}: {
  value: Nutrients;
  suffix?: string;
}) {
  return (
    <p className="text-xs leading-6 text-[#6c7c6e]">
      {fmt(value.calories)} kcal · P {fmt(value.protein)} g · C{" "}
      {fmt(value.carbs)} g · F {fmt(value.fat)} g{suffix}
    </p>
  );
}
export function NutrientInputs({
  value,
  onChange,
  prefix = "",
}: {
  value: Nutrients;
  onChange: (n: Nutrients) => void;
  prefix?: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {nutrientFields.map(([key, label, unit]) => (
        <label key={key} className="text-sm">
          {label} ({unit})
          <input
            className={`${control} mt-1`}
            aria-label={`${prefix}${label}`}
            type="number"
            inputMode="decimal"
            min={0}
            max={100000}
            step="any"
            required
            value={value[key]}
            onChange={(e) =>
              onChange({ ...value, [key]: e.target.valueAsNumber || 0 })
            }
          />
        </label>
      ))}
    </div>
  );
}
function errorText(error: unknown) {
  return error instanceof Error && !error.message.startsWith("[")
    ? error.message
    : "Check the name, ingredients and positive gram amounts before saving.";
}
export function FoodPicker({
  store,
  onPick,
  onFavorite,
  includeRecipes = true,
}: {
  store: NutritionStore;
  onPick: (type: "food" | "recipe", id: string) => void;
  onFavorite?: (id: string) => void;
  includeRecipes?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [preparation, setPreparation] = useState("");
  const recent = new Set(
    store.diary
      .filter((e) => e.ownerId === store.user.id && e.sourceType === "food")
      .slice()
      .reverse()
      .slice(0, 30)
      .map((e) => e.sourceId),
  );
  const foods = store.foods.filter(
    (f) =>
      (f.ownerId === null || f.ownerId === store.user.id) &&
      matchesCatalogSearch(search, [
        f.name,
        f.preparation,
        ...(f.aliases ?? []),
        f.externalId,
      ]) &&
      (!preparation || f.preparation === preparation) &&
      (filter === "all" ||
        (filter === "favorites" && store.favorites.includes(f.id)) ||
        (filter === "recent" && recent.has(f.id)) ||
        (filter === "custom" && f.ownerId === store.user.id)),
  );
  const recipes =
    includeRecipes &&
    filter === "all" &&
    (!preparation || preparation === "cooked")
      ? store.recipes.filter(
          (r) =>
            r.ownerId === store.user.id &&
            r.name.toLowerCase().includes(search.toLowerCase()),
        )
      : [];
  return (
    <div className="space-y-3">
      <label className="relative block">
        <Search size={16} className="absolute left-3 top-3.5 text-[#728274]" />
        <input
          className={`${control} pl-10`}
          aria-label="Search foods and recipes"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search foods and recipes…"
        />
      </label>
      <div className="flex gap-2">
        <select
          className={control}
          aria-label="Food list filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All foods</option>
          <option value="recent">Recent</option>
          <option value="favorites">Favorites</option>
          <option value="custom">My foods</option>
        </select>
        <select
          className={control}
          aria-label="Preparation filter"
          value={preparation}
          onChange={(e) => setPreparation(e.target.value)}
        >
          <option value="">Any preparation</option>
          {preparations.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </div>
      <div className="max-h-[26rem] space-y-2 overflow-y-auto">
        {foods.map((f) => (
          <div
            key={f.id}
            className="flex items-center gap-1 rounded-xl border border-[#dfe5dc] bg-white p-2"
          >
            <button
              className="min-h-11 min-w-0 flex-1 px-2 py-1 text-left"
              aria-label={`Select ${f.name} ${f.preparation}`}
              onClick={() => onPick("food", f.id)}
            >
              <span className="block font-semibold">{f.name}</span>
              <span className="text-xs capitalize text-[#6c7c6e]">
                {f.preparation} · {fmt(f.per100g.calories)} kcal / 100 g
                {f.source === "custom"
                  ? " · custom"
                  : f.externalId
                    ? " · USDA"
                    : " · mock"}
              </span>
              {f.source === "system" && f.externalId && (
                <span
                  className="block text-xs text-[#6c7c6e]"
                  title={f.sourceInfo}
                >
                  USDA FoodData Central · FDC {f.externalId}
                </span>
              )}
            </button>
            {onFavorite && (
              <button
                aria-label={`${store.favorites.includes(f.id) ? "Unfavorite" : "Favorite"} ${f.name} ${f.preparation}`}
                aria-pressed={store.favorites.includes(f.id)}
                className={`${action} shrink-0`}
                onClick={() => onFavorite(f.id)}
              >
                <Star
                  size={18}
                  fill={store.favorites.includes(f.id) ? "#d6ecb4" : "none"}
                />
              </button>
            )}
          </div>
        ))}
        {recipes.map((r) => (
          <button
            key={r.id}
            className="min-h-16 w-full rounded-xl border border-[#dfe5dc] bg-white p-3 text-left"
            onClick={() => onPick("recipe", r.id)}
            aria-label={`Select recipe ${r.name}`}
          >
            <span className="block font-semibold">{r.name}</span>
            <span className="text-xs text-[#6c7c6e]">
              Recipe · cooked · {fmt(recipePer100g(r).calories)} kcal / 100 g
            </span>
          </button>
        ))}
        {!foods.length && !recipes.length && (
          <p className={`${panel} ${muted}`}>
            No matches. Try another filter or create a custom food in Foods.
          </p>
        )}
      </div>
    </div>
  );
}
export function PortionLogger({
  store,
  type,
  id,
  date,
  meal,
  onSave,
  onCancel,
}: {
  store: NutritionStore;
  type: "food" | "recipe";
  id: string;
  date: string;
  meal: DiaryEntry["meal"];
  onSave: (grams: number, meal: DiaryEntry["meal"], date: string) => void;
  onCancel: () => void;
}) {
  const [grams, setGrams] = useState(100);
  const [selectedMeal, setMeal] = useState(meal);
  const [selectedDate, setDate] = useState(date);
  const item =
    type === "food"
      ? store.foods.find((f) => f.id === id)!
      : store.recipes.find((r) => r.id === id)!;
  const nutrients = "per100g" in item ? item.per100g : recipePer100g(item);
  return (
    <form
      className={`${panel} space-y-4`}
      onSubmit={(e) => {
        e.preventDefault();
        onSave(grams, selectedMeal, selectedDate);
      }}
    >
      <button type="button" className={action} onClick={onCancel}>
        <ChevronLeft size={16} />
        Choose another food
      </button>
      <h2 className="text-xl font-bold">Log {item.name}</h2>
      <p className={`${muted} capitalize`}>
        {"preparation" in item ? item.preparation : "cooked recipe"} · nutrition
        per 100 g
      </p>
      <NutritionNumbers value={nutrients} />
      <label className="block text-sm font-bold">
        Weight (grams)
        <input
          autoFocus
          className={`${control} mt-2 text-lg`}
          type="number"
          inputMode="decimal"
          min={0.1}
          max={100000}
          step="any"
          required
          aria-label="Portion grams"
          value={grams}
          onChange={(e) => setGrams(e.target.valueAsNumber || 0)}
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">
          Meal
          <select
            className={`${control} mt-1`}
            value={selectedMeal}
            onChange={(e) => setMeal(e.target.value as DiaryEntry["meal"])}
          >
            {meals.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Date
          <input
            className={`${control} mt-1`}
            type="date"
            required
            value={selectedDate}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
      </div>
      <div className="rounded-xl bg-[#edf1e7] p-3">
        <p className="text-xs font-bold">YOUR {fmt(grams)} G PORTION</p>
        <NutritionNumbers value={scale(nutrients, grams)} />
      </div>
      <button className={primary}>
        <Plus size={16} />
        Log portion
      </button>
    </form>
  );
}
export function Nutrition({
  store,
  setStore,
  onGoals,
  quickLog = false,
  onDateChange,
  serverDay,
  cloud = false,
  recipeHistory,
  readOnly = false,
}: NutritionProps & {
  onGoals: () => void;
  quickLog?: boolean;
  cloud?: boolean;
  onDateChange?: (date: string) => void;
  serverDay?: Day | null;
  recipeHistory?: ReactNode;
  readOnly?: boolean;
}) {
  const [tab, setTab] = useState<"Diary" | "Foods" | "Recipes">("Diary");
  const [date, setDate] = useState(() => today(store.user.timeZone));
  const [logging, setLogging] = useState(quickLog);
  const [meal, setMeal] = useState<DiaryEntry["meal"]>("Snacks");
  const [picked, setPicked] = useState<{
    type: "food" | "recipe";
    id: string;
  } | null>(null);
  const [editing, setEditing] = useState<DiaryEntry | null>(null);
  const [message, setMessage] = useState("");
  const update = (fn: () => NutritionStore, success?: string) => {
    try {
      setStore(fn());
      if (success) setMessage(success);
      return true;
    } catch (e) {
      setMessage(errorText(e));
      return false;
    }
  };
  const pick = (type: "food" | "recipe", id: string) => {
    setPicked({ type, id });
    setLogging(true);
    setTab("Diary");
    setEditing(null);
  };
  const changeDate = (next: string) => {
    if (!next) return;
    setDate(next);
    onDateChange?.(next);
    setLogging(false);
    setPicked(null);
    setEditing(null);
    setMessage("");
  };
  const entries = store.diary.filter(
    (e) => e.ownerId === store.user.id && e.date === date,
  );
  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2 text-xs font-bold tracking-widest text-[#728274]">
          NOURISH / EVERY DAY
        </p>
        <h1 className="text-3xl font-bold tracking-tight">
          Nutrition<span className="text-[#87a472]">.</span>
        </h1>
        <p className={`mt-2 ${muted}`}>
          Weigh it. Log it. Get on with your day.
        </p>
      </div>
      <nav
        aria-label="Nutrition sections"
        className="flex gap-1 rounded-2xl border border-[#dfe5dc] bg-white p-1"
      >
        {(["Diary", "Foods", "Recipes"] as const).map((t) => (
          <button
            key={t}
            aria-current={tab === t ? "page" : undefined}
            className={`${action} flex-1 ${tab === t ? "bg-[#244b3c] text-white" : "text-[#6c7c6e]"}`}
            onClick={() => {
              setTab(t);
              setLogging(false);
              setPicked(null);
              setEditing(null);
              setMessage("");
            }}
          >
            {t}
          </button>
        ))}
      </nav>
      <fieldset className="min-w-0 space-y-5" disabled={readOnly}>
        {message && (
          <p role="status" className="rounded-xl bg-[#edf1e7] p-3 text-sm">
            {message}
          </p>
        )}
        {tab === "Diary" ? (
          <>
            <div className="flex min-w-0 items-center justify-between gap-2">
              <button
                className={action}
                aria-label="Previous diary day"
                onClick={() => {
                  changeDate(shiftDate(date, -1));
                }}
              >
                <ChevronLeft size={18} />
              </button>
              <input
                className="min-h-11 min-w-0 flex-1 rounded-xl border border-[#dfe5dc] bg-[#fafbf8] px-2 py-2 text-xs"
                aria-label="Diary date"
                type="date"
                required
                value={date}
                onChange={(e) => {
                  changeDate(e.target.value);
                }}
              />
              <button
                className={action}
                aria-label="Next diary day"
                onClick={() => {
                  changeDate(shiftDate(date, 1));
                }}
              >
                <ChevronRight size={18} />
              </button>
              <button
                className={`${action} px-2`}
                onClick={() => changeDate(today(store.user.timeZone))}
              >
                Today
              </button>
            </div>
            <NutritionSummary
              totals={
                serverDay?.date === date
                  ? serverDay.totals
                  : dayTotals(store, date)
              }
              goals={
                serverDay?.date === date
                  ? (serverDay.goals ?? {
                      calories: 0,
                      protein: 0,
                      carbs: 0,
                      fat: 0,
                    })
                  : store.goals
              }
              onGoals={onGoals}
            />
            {logging ? (
              picked ? (
                <PortionLogger
                  key={`${picked.type}-${picked.id}`}
                  store={store}
                  {...picked}
                  date={date}
                  meal={meal}
                  onCancel={() => setPicked(null)}
                  onSave={(grams, meal, loggedDate) => {
                    if (
                      update(
                        () =>
                          logPortion(
                            store,
                            picked.type,
                            picked.id,
                            grams,
                            meal,
                            loggedDate,
                          ),
                        "Portion logged. Daily totals updated.",
                      )
                    ) {
                      setLogging(false);
                      setPicked(null);
                      setDate(loggedDate);
                      onDateChange?.(loggedDate);
                    }
                  }}
                />
              ) : (
                <div className={panel}>
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="font-bold">
                      Add food to {meal.toLowerCase()}
                    </h2>
                    <button
                      className={action}
                      onClick={() => setLogging(false)}
                    >
                      Cancel
                    </button>
                  </div>
                  <FoodPicker
                    store={store}
                    onPick={pick}
                    onFavorite={(id) => update(() => toggleFavorite(store, id))}
                  />
                  <p className="mt-3 text-xs text-[#6c7c6e]">
                    Match the food’s raw, cooked, dry or packaged state to the
                    grams you weigh.
                  </p>
                </div>
              )
            ) : (
              <button
                className={primary}
                onClick={() => {
                  setMeal("Snacks");
                  setLogging(true);
                  setEditing(null);
                }}
              >
                <Plus size={16} />
                Log food
              </button>
            )}
            {editing && (
              <DiaryEditor
                key={editing.id}
                entry={editing}
                onCancel={() => setEditing(null)}
                onSave={(patch) => {
                  if (
                    update(
                      () => editDiary(store, editing.id, patch),
                      "Diary entry updated using its original nutrition values.",
                    )
                  ) {
                    setDate(patch.date);
                    onDateChange?.(patch.date);
                    setEditing(null);
                  }
                }}
              />
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              {meals.map((m) => {
                const rows = entries.filter((e) => e.meal === m);
                return (
                  <section key={m} className={panel}>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div>
                        <h2 className="font-bold">{m}</h2>
                        <p className="text-xs text-[#6c7c6e]">
                          {fmt(sum(rows.map(entryNutrition)).calories)} kcal
                        </p>
                      </div>
                      <button
                        className={`${action} text-[#57775d]`}
                        aria-label={`Add food to ${m}`}
                        onClick={() => {
                          setMeal(m);
                          setLogging(true);
                          window.scrollTo(0, 0);
                          setPicked(null);
                          setEditing(null);
                        }}
                      >
                        <Plus size={16} />
                        Add
                      </button>
                    </div>
                    {rows.length ? (
                      rows.map((e) => (
                        <div
                          key={e.id}
                          className="border-t border-[#edf1e7] py-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="break-words text-sm font-semibold">
                                {e.snapshot.name}
                              </p>
                              <p className="mt-1 text-xs capitalize text-[#6c7c6e]">
                                {fmt(e.grams)} g · {e.snapshot.preparation}
                                {e.sourceType === "recipe" ? " recipe" : ""}
                              </p>
                            </div>
                            <div className="flex shrink-0">
                              <button
                                className={`${action} px-2`}
                                aria-label={`Edit diary ${e.snapshot.name}`}
                                onClick={() => {
                                  setEditing(e);
                                  setLogging(false);
                                  window.scrollTo(0, 0);
                                }}
                              >
                                <Pencil size={16} />
                              </button>
                              <button
                                className={`${action} px-2`}
                                aria-label={`Delete diary ${e.snapshot.name}`}
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      `Delete ${e.snapshot.name} from this day?`,
                                    )
                                  )
                                    update(
                                      () => deleteDiary(store, e.id),
                                      "Diary entry deleted.",
                                    );
                                }}
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </div>
                          <NutritionNumbers value={entryNutrition(e)} />
                        </div>
                      ))
                    ) : (
                      <p className={`py-3 ${muted}`}>Nothing logged yet.</p>
                    )}
                  </section>
                );
              })}
            </div>
            <p className="text-xs leading-5 text-[#7b897a]">
              {cloud
                ? "Cloud diary · nutrition snapshots are calculated and retained by the server. Unsaved changes require a connection."
                : "Seeded meals and system food values are illustrative mock data. This diary stores gram-based snapshots in this browser."}
            </p>
          </>
        ) : tab === "Foods" ? (
          <Foods store={store} setStore={setStore} onPick={pick} />
        ) : (
          <>
            <Recipes store={store} setStore={setStore} onPick={pick} />
            {recipeHistory}
          </>
        )}
      </fieldset>
    </div>
  );
}
function DiaryEditor({
  entry,
  onSave,
  onCancel,
}: {
  entry: DiaryEntry;
  onSave: (patch: Pick<DiaryEntry, "grams" | "meal" | "date">) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState({
    grams: entry.grams,
    meal: entry.meal,
    date: entry.date,
  });
  return (
    <form
      className={`${panel} space-y-3`}
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
    >
      <h2 className="font-bold">Edit {entry.snapshot.name}</h2>
      <p className={muted}>Original nutrition snapshot preserved.</p>
      <label className="block text-sm">
        Grams
        <input
          className={`${control} mt-1`}
          aria-label="Edit portion grams"
          type="number"
          min={0.1}
          max={100000}
          step="any"
          required
          value={draft.grams}
          onChange={(e) =>
            setDraft({ ...draft, grams: e.target.valueAsNumber || 0 })
          }
        />
      </label>
      <label className="block text-sm">
        Meal
        <select
          className={`${control} mt-1`}
          value={draft.meal}
          onChange={(e) =>
            setDraft({ ...draft, meal: e.target.value as DiaryEntry["meal"] })
          }
        >
          {meals.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        Date
        <input
          className={`${control} mt-1`}
          type="date"
          required
          value={draft.date}
          onChange={(e) => setDraft({ ...draft, date: e.target.value })}
        />
      </label>
      <NutritionNumbers value={scale(entry.snapshot.per100g, draft.grams)} />
      <div className="flex gap-2">
        <button className={primary}>Save diary entry</button>
        <button type="button" className={action} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
function Foods({
  store,
  setStore,
  onPick,
}: NutritionProps & { onPick: (type: "food" | "recipe", id: string) => void }) {
  const [draft, setDraft] = useState<Food | null>(null);
  const [message, setMessage] = useState("");
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">Food library</h2>
        <button
          className={primary}
          onClick={() => {
            setDraft({
              id: newId(),
              ownerId: store.user.id,
              source: "custom",
              name: "",
              preparation: "packaged",
              per100g: zero(),
              sourceInfo: "",
            });
            setMessage("");
          }}
        >
          <Plus size={16} />
          Custom food
        </button>
      </div>
      {message && (
        <p role="status" className={muted}>
          {message}
        </p>
      )}
      {draft && (
        <form
          className={`${panel} space-y-4`}
          onSubmit={(e) => {
            e.preventDefault();
            try {
              setStore(saveFood(store, draft));
              setDraft(null);
              setMessage(
                "Food saved. Existing diary and recipe snapshots unchanged.",
              );
            } catch (error) {
              setMessage(errorText(error));
            }
          }}
        >
          <h3 className="font-bold">
            {store.foods.some((f) => f.id === draft.id)
              ? "Edit custom food"
              : "Create custom food"}
          </h3>
          <label className="block text-sm">
            Food name
            <input
              className={`${control} mt-1`}
              required
              maxLength={120}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            Preparation state
            <select
              className={`${control} mt-1`}
              value={draft.preparation}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  preparation: e.target.value as Food["preparation"],
                })
              }
            >
              {preparations.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <p className="text-xs font-bold text-[#728274]">
            NUTRITION PER 100 G
          </p>
          <NutrientInputs
            value={draft.per100g}
            onChange={(per100g) => setDraft({ ...draft, per100g })}
            prefix="Food "
          />
          <label className="block text-sm">
            Source information (optional)
            <input
              className={`${control} mt-1`}
              maxLength={500}
              placeholder="Food label, package, or your source"
              value={draft.sourceInfo}
              onChange={(e) =>
                setDraft({ ...draft, sourceInfo: e.target.value })
              }
            />
          </label>
          <div className="flex gap-2">
            <button className={primary}>Save food</button>
            <button
              className={action}
              type="button"
              onClick={() => setDraft(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      <FoodPicker
        store={store}
        onPick={onPick}
        onFavorite={(id) => setStore(toggleFavorite(store, id))}
        includeRecipes={false}
      />
      {store.foods
        .filter((f) => f.ownerId === store.user.id)
        .map((f) => (
          <div key={f.id} className={panel}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-bold">{f.name}</h3>
              <button
                className={action}
                aria-label={`Edit food ${f.name}`}
                onClick={() => {
                  setDraft(structuredClone(f));
                  setMessage("");
                  window.scrollTo(0, 0);
                }}
              >
                Edit
              </button>
            </div>
            <p className="text-xs capitalize text-[#6c7c6e]">
              {f.preparation} · your food · per 100 g
            </p>
            <NutritionNumbers value={f.per100g} />
            {f.sourceInfo && (
              <p className="mt-2 break-words text-xs text-[#6c7c6e]">
                Source: {f.sourceInfo}
              </p>
            )}
          </div>
        ))}
      <p className="text-xs text-[#7b897a]">
        {store.foods.some((f) => f.source === "system" && f.externalId)
          ? "Reference nutrition is per 100 g. Match the preparation state and check current package labels. Custom foods stay separate."
          : "System foods contain mock values. Create your own foods from package or source values for this prototype."}
      </p>
    </div>
  );
}
function Recipes({
  store,
  setStore,
  onPick,
}: NutritionProps & { onPick: (type: "food" | "recipe", id: string) => void }) {
  const [draft, setDraft] = useState<Recipe | null>(null);
  const [foodId, setFoodId] = useState(store.foods[0]?.id ?? "");
  const [grams, setGrams] = useState(100);
  const [message, setMessage] = useState("");
  const foods = store.foods.filter(
    (f) => f.ownerId === null || f.ownerId === store.user.id,
  );
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">Your recipes</h2>
        <button
          className={primary}
          onClick={() => {
            setDraft({
              id: newId(),
              ownerId: store.user.id,
              name: "",
              finishedGrams: 500,
              ingredients: [],
              updatedAt: new Date().toISOString(),
            });
            setMessage("");
          }}
        >
          <Plus size={16} />
          New recipe
        </button>
      </div>
      {message && (
        <p role="status" className="rounded-xl bg-[#edf1e7] p-3 text-sm">
          {message}
        </p>
      )}
      {draft && (
        <form
          className={`${panel} space-y-4`}
          onSubmit={(e) => {
            e.preventDefault();
            try {
              setStore(
                saveRecipe(store, {
                  ...draft,
                  updatedAt: new Date().toISOString(),
                }),
              );
              setDraft(null);
              setMessage(
                "Recipe saved. Previously logged portions keep their original nutrition.",
              );
            } catch (error) {
              setMessage(errorText(error));
            }
          }}
        >
          <h3 className="text-lg font-bold">Recipe builder</h3>
          <label className="block text-sm">
            Recipe name
            <input
              className={`${control} mt-1`}
              required
              maxLength={120}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <div className="rounded-xl bg-[#f6f7f3] p-3">
            <h4 className="mb-3 text-sm font-bold">Ingredients</h4>
            {draft.ingredients.map((i) => (
              <div key={i.id} className="mb-3 border-b border-[#dfe5dc] pb-3">
                <p className="text-sm font-semibold">
                  {i.snapshot.name}{" "}
                  <span className="text-xs font-normal">
                    · {i.snapshot.preparation}
                  </span>
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <label className="flex-1 text-xs">
                    Grams
                    <input
                      aria-label={`Ingredient grams ${i.snapshot.name} ${i.id}`}
                      className={`${control} mt-1`}
                      type="number"
                      min={0.1}
                      max={100000}
                      step="any"
                      required
                      value={i.grams}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          ingredients: draft.ingredients.map((x) =>
                            x.id === i.id
                              ? { ...x, grams: e.target.valueAsNumber || 0 }
                              : x,
                          ),
                        })
                      }
                    />
                  </label>
                  <button
                    className={`${action} mt-4`}
                    type="button"
                    aria-label={`Remove ingredient ${i.snapshot.name} ${i.id}`}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        ingredients: draft.ingredients.filter(
                          (x) => x.id !== i.id,
                        ),
                      })
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                <NutritionNumbers value={scale(i.snapshot.per100g, i.grams)} />
              </div>
            ))}
            <label className="block text-xs">
              Food for ingredient
              <select
                className={`${control} mt-1`}
                value={foodId}
                onChange={(e) => setFoodId(e.target.value)}
              >
                {foods.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} · {f.preparation}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-2 block text-xs">
              New ingredient grams
              <input
                className={`${control} mt-1`}
                type="number"
                step="any"
                value={grams}
                onChange={(e) => setGrams(e.target.valueAsNumber || 0)}
              />
            </label>
            <button
              disabled={
                !foodId ||
                !Number.isFinite(grams) ||
                grams <= 0 ||
                grams > 100000
              }
              className={`${action} mt-2 text-[#57775d] disabled:opacity-40`}
              type="button"
              onClick={() => {
                const food = foods.find((f) => f.id === foodId)!;
                setDraft({
                  ...draft,
                  ingredients: [
                    ...draft.ingredients,
                    {
                      id: newId(),
                      foodId: food.id,
                      grams,
                      snapshot: structuredClone(food),
                    },
                  ],
                });
              }}
            >
              <Plus size={16} />
              Add ingredient
            </button>
          </div>
          <div>
            <p className="text-xs font-bold">WHOLE RECIPE TOTAL</p>
            <NutritionNumbers value={recipeTotal(draft)} />
          </div>
          <label className="block text-sm font-semibold">
            Finished cooked/baked weight (grams)
            <input
              className={`${control} mt-1`}
              type="number"
              min={0.1}
              max={100000}
              step="any"
              required
              value={draft.finishedGrams}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  finishedGrams: e.target.valueAsNumber || 0,
                })
              }
            />
          </label>
          <p className="text-xs text-[#6c7c6e]">
            Weigh the finished food, excluding its container. Water gained or
            lost changes the nutrition per 100 g.
          </p>
          <div className="rounded-xl bg-[#edf1e7] p-3">
            <p className="text-xs font-bold">PER 100 G FINISHED RECIPE</p>
            {draft.finishedGrams > 0 ? (
              <NutritionNumbers value={recipePer100g(draft)} />
            ) : (
              <p className={muted}>Enter a positive finished weight.</p>
            )}
          </div>
          <div className="flex gap-2">
            <button className={primary} disabled={!draft.ingredients.length}>
              Save recipe
            </button>
            <button
              type="button"
              className={action}
              onClick={() => setDraft(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {store.recipes
        .filter((r) => r.ownerId === store.user.id)
        .map((r) => (
          <article key={r.id} className={panel}>
            <div className="mb-2 flex items-center gap-3">
              <Utensils size={20} />
              <h3 className="text-lg font-bold">{r.name}</h3>
            </div>
            <p className={muted}>
              {r.ingredients.length} ingredients · {fmt(r.finishedGrams)} g
              finished yield
            </p>
            <NutritionNumbers value={recipePer100g(r)} suffix=" / 100 g" />
            <div className="mt-3 flex gap-2">
              <button
                className={primary}
                aria-label={`Log recipe ${r.name}`}
                onClick={() => onPick("recipe", r.id)}
              >
                Log portion
              </button>
              <button
                className={action}
                aria-label={`Edit recipe ${r.name}`}
                onClick={() => {
                  setDraft(structuredClone(r));
                  setMessage("");
                  window.scrollTo(0, 0);
                }}
              >
                Edit recipe
              </button>
            </div>
            <details className="mt-2">
              <summary className="min-h-11 cursor-pointer py-3 text-xs font-semibold">
                Ingredients & recipe totals
              </summary>
              {r.ingredients.map((i) => (
                <p key={i.id} className={muted}>
                  {i.snapshot.name} · {i.snapshot.preparation} · {fmt(i.grams)}{" "}
                  g
                </p>
              ))}
              <NutritionNumbers value={recipeTotal(r)} />
            </details>
          </article>
        ))}
      {!store.recipes.length && !draft && (
        <p className={`${panel} ${muted}`}>
          Build a recipe from weighed ingredients, then log any weighed portion.
        </p>
      )}
    </div>
  );
}
