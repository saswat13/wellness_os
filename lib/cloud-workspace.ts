/** Server-backed projection for the existing UI. No localStorage or browser imports. */
import { z } from "zod";
import type { Schemas } from "./api-v1.generated";
import { FormApi, ApiError } from "./form-api";
import {
  exerciseSchema,
  storeSchema,
  sessionSchema,
  templateSchema,
  type Exercise,
  type TrackerStore,
  type WorkoutSession,
} from "./models";
import { validateStore } from "./tracker";
import {
  nutritionSchema,
  foodSchema,
  recipeSchema,
  diarySchema,
  today,
  shiftDate,
  type NutritionStore,
  type Food,
  type Recipe,
  type DiaryEntry,
} from "./nutrition";

type Ex = Schemas["ExerciseResource"];
type FoodRead = Schemas["FoodResource"];
type Work = Schemas["WorkoutResource"];
type RecipeRead = Schemas["RecipeResource"];
type DiaryRead = Schemas["DiaryEntryResource"];
export type Day = Schemas["DiaryDay"];
export type CloudData = { tracker: TrackerStore; nutrition: NutritionStore };
/** Check recovery data independently of the fixed prototype user. Server auth remains authoritative. */
export function validateCloudData(raw: unknown, subject: string): CloudData {
  const parsed = z
    .object({ tracker: storeSchema, nutrition: nutritionSchema })
    .strict()
    .parse(raw);
  const tracker = validateStore(parsed.tracker, subject),
    nutrition = parsed.nutrition;
  if (
    nutrition.user.id !== subject ||
    nutrition.goals.ownerId !== subject ||
    nutrition.foods.some((f) => f.ownerId !== null && f.ownerId !== subject) ||
    nutrition.diary.some((e) => e.ownerId !== subject) ||
    nutrition.recipes.some(
      (r) =>
        r.ownerId !== subject ||
        r.ingredients.some(
          (i) => i.snapshot.ownerId !== null && i.snapshot.ownerId !== subject,
        ),
    )
  )
    throw new Error("PENDING_OWNER_MISMATCH");
  return { tracker, nutrition };
}
export function pendingData(data: CloudData): CloudData {
  // Completed history is on the server and is not required to replay pending mutations.
  return { ...data, tracker: { ...data.tracker, history: [] } };
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const stamp = () => new Date().toISOString();
const meta = z.object({
  ownerSub: z.string().nullable(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
function owner(record: unknown, subject: string, system = false) {
  const m = meta.parse(record);
  if (m.ownerSub !== subject && !(system && m.ownerSub === null))
    throw new Error("ACCOUNT_CHANGED");
}
export function exercise(r: Ex, subject: string): Exercise {
  owner(r, subject, true);
  return exerciseSchema.parse({
    ...r,
    ownerId: r.ownerSub,
    primaryMuscle: r.primaryMuscle ?? null,
    secondaryMuscles: r.secondaryMuscles ?? [],
    movementPattern: r.movementPattern ?? null,
    equipment: r.equipment ?? null,
    tags: r.tags ?? [],
    trainingTypes: r.trainingTypes ?? [],
    unilateral: r.unilateral ?? false,
    coachingNotes: r.coachingNotes ?? "",
    demoUrl: r.demoUrl ?? "",
    archived: r.archived ?? false,
  });
}
function food(r: FoodRead, subject: string): Food {
  owner(r, subject, true);
  return foodSchema.parse({
    ...r,
    ownerId: r.ownerSub,
    sourceInfo: r.sourceInfo ?? "",
  });
}
export function workout(r: Work, subject: string): WorkoutSession {
  owner(r, subject);
  return sessionSchema.parse({
    id: r.id,
    ownerId: subject,
    templateId: r.templateId,
    name: r.name,
    trainingType: r.trainingType,
    exercises: r.exercises.map((e) => ({
      id: e.id,
      exerciseId: e.exerciseId,
      prescription: e.prescription,
      sameWeight: e.sameWeight ?? true,
      snapshot: exercise(
        {
          ...e.snapshot,
          ownerSub: e.snapshot.source === "system" ? null : subject,
          revision: e.snapshot.sourceRevision ?? 1,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        },
        subject,
      ),
    })),
    logs: Object.fromEntries(
      r.exercises.map((e) => [
        e.id,
        e.sets.map((s) => ({
          ...s,
          rpe: s.rpe == null ? "" : String(s.rpe),
          done: s.done ?? false,
          ownerId: subject,
          sessionId: r.id,
          sessionExerciseId: e.id,
          exerciseId: e.exerciseId,
        })),
      ]),
    ),
    started: Date.parse(r.startedAt),
    completedAt: r.completedAt ?? null,
    finished: r.status === "completed",
    unit: r.unit ?? "kg",
    notes: r.notes ?? "",
    mock: r.mock ?? false,
  });
}
function recipe(r: RecipeRead, subject: string): Recipe {
  owner(r, subject);
  return recipeSchema.parse({
    ...r,
    ownerId: subject,
    ingredients: r.ingredients.map((i) => ({
      ...i,
      snapshot: food(
        {
          ...i.snapshot,
          sourceInfo: i.snapshot.sourceInfo ?? "",
          ownerSub: i.snapshot.source === "system" ? null : subject,
          revision: i.snapshot.sourceRevision ?? 1,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        },
        subject,
      ),
    })),
  });
}
function diary(r: DiaryRead, subject: string): DiaryEntry {
  owner(r, subject);
  return diarySchema.parse({ ...r, ownerId: subject });
}
function emptyWorkout(subject: string): WorkoutSession {
  return {
    id: crypto.randomUUID(),
    ownerId: subject,
    templateId: null,
    name: "Your workout",
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
}
export function draft(s: WorkoutSession): Schemas["DraftWrite"] {
  return {
    name: s.name,
    unit: s.unit,
    notes: s.notes,
    exercises: s.exercises.map((e) => ({
      id: e.id,
      exerciseId: e.exerciseId,
      prescription: e.prescription,
      sameWeight: e.sameWeight,
      sets: s.logs[e.id].map((row) => ({
        id: row.id,
        groupId: row.groupId,
        side: row.side,
        reps: row.reps,
        kg: row.kg,
        rpe: row.rpe === "" ? null : Number(row.rpe),
        done: row.done,
      })),
    })),
  };
}
function exBody(e: Exercise): Schemas["Exercise"] {
  const {
    id,
    name,
    primaryMuscle,
    secondaryMuscles,
    movementPattern,
    equipment,
    tags,
    trainingTypes,
    unilateral,
    coachingNotes,
    demoUrl,
    archived,
  } = e;
  return {
    id,
    name,
    primaryMuscle,
    secondaryMuscles,
    movementPattern,
    equipment,
    tags,
    trainingTypes,
    unilateral,
    coachingNotes,
    demoUrl,
    archived,
  };
}
function recipeFields(r: Recipe) {
  return {
    name: r.name,
    finishedGrams: r.finishedGrams,
    ingredients: r.ingredients,
  };
}
function foodBody(f: Food): Schemas["Food"] {
  return {
    id: f.id,
    name: f.name,
    preparation: f.preparation,
    per100g: f.per100g,
    sourceInfo: f.sourceInfo,
  };
}

export class CloudWorkspace {
  data!: CloudData;
  exercises = new Map<string, Ex>();
  foods = new Map<string, FoodRead>();
  templates = new Map<string, Schemas["TemplateResource"]>();
  recipes = new Map<string, RecipeRead>();
  sessions = new Map<string, Work>();
  entries = new Map<string, DiaryRead>();
  days = new Map<string, Day>();
  profile: Schemas["ProfileResource"] | null = null;
  goals: Schemas["GoalsResource"] | null = null;
  private mutations = new Map<string, string>();
  private historyBefore = new Date();
  private closed = false;
  private startRequest: Schemas["SessionCreate"] | null = null;
  constructor(
    public readonly api: FormApi,
    public readonly subject: string,
    private readonly beforeMutation: () => void = () => {},
  ) {}
  checkpoint() {
    return {
      data: pendingData(this.data),
      exercises: [...this.exercises.values()],
      foods: [...this.foods.values()],
      templates: [...this.templates.values()],
      recipes: [...this.recipes.values()],
      sessions: [...this.sessions.values()].filter(
        (s) => s.status === "active" || s.id === this.data.tracker.session.id,
      ),
      entries: [...this.entries.values()],
      profile: this.profile,
      goals: this.goals,
      mutations: [...this.mutations],
      startRequest: this.startRequest,
    };
  }
  restore(raw: unknown) {
    const c = z
      .object({
        data: z.unknown(),
        exercises: z.array(z.unknown()),
        foods: z.array(z.unknown()),
        templates: z.array(z.unknown()),
        recipes: z.array(z.unknown()),
        sessions: z.array(z.unknown()),
        entries: z.array(z.unknown()),
        profile: z.unknown().nullable(),
        goals: z.unknown().nullable(),
        mutations: z.array(z.tuple([z.string(), z.string().uuid()])),
        startRequest: z.unknown().nullable(),
      })
      .strict()
      .parse(raw);
    this.data = validateCloudData(c.data, this.subject);
    const restore = <T extends { id: string }>(
      values: unknown[],
      validate: (r: T) => void,
    ) =>
      new Map(
        values.map((raw) => {
          const r = raw as T;
          z.object({ id: z.string().min(1).max(128) }).parse(r);
          validate(r);
          return [r.id, r] as const;
        }),
      );
    this.exercises = restore<Ex>(c.exercises, (r) => {
      exercise(r, this.subject);
    });
    this.foods = restore<FoodRead>(c.foods, (r) => {
      food(r, this.subject);
    });
    this.templates = restore<Schemas["TemplateResource"]>(c.templates, (r) => {
      owner(r, this.subject);
      templateSchema.parse({
        ...r,
        ownerId: this.subject,
        visibility: "private",
      });
    });
    this.recipes = restore<RecipeRead>(c.recipes, (r) => {
      recipe(r, this.subject);
    });
    this.sessions = restore<Work>(c.sessions, (r) => {
      workout(r, this.subject);
    });
    this.entries = restore<DiaryRead>(c.entries, (r) => {
      diary(r, this.subject);
    });
    if (c.profile) owner(c.profile, this.subject);
    if (c.goals) owner(c.goals, this.subject);
    this.profile = c.profile as Schemas["ProfileResource"] | null;
    this.goals = c.goals as Schemas["GoalsResource"] | null;
    this.mutations = new Map(c.mutations);
    if (c.startRequest)
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1),
        startedAt: z.iso.datetime({ offset: true }),
        unit: z.enum(["kg", "lb"]),
      }).parse(c.startRequest);
    this.startRequest = c.startRequest as Schemas["SessionCreate"] | null;
    this.project();
  }
  forgetReceipts() {
    this.mutations.clear();
  }
  acknowledgeStart() {
    this.startRequest = null;
  }
  dispose() {
    this.closed = true;
    this.mutations.clear();
    this.days.clear();
    this.entries.clear();
    this.sessions.clear();
    this.exercises.clear();
    this.foods.clear();
    this.templates.clear();
    this.recipes.clear();
    this.profile = null;
    this.goals = null;
  }
  private guard() {
    if (this.closed || this.api.transport.subject !== this.subject)
      throw new Error("ACCOUNT_CHANGED");
  }
  // A failed response keeps the exact request key AND If-Match value for explicit retry.
  private async mutate<K extends keyof import("./api-v1.generated").Operations>(
    operation: K,
    options: Parameters<FormApi["call"]>[1] & {
      body?: import("./api-v1.generated").Operations[K]["body"];
    },
  ) {
    this.guard();
    const fingerprint = JSON.stringify([operation, options]);
    let key = this.mutations.get(fingerprint);
    if (!key) {
      key = crypto.randomUUID();
      this.mutations.set(fingerprint, key);
    }
    this.beforeMutation();
    const result = await this.api.call(operation, { ...options, key });
    this.guard();
    // Retain keys until the entire durable batch is acknowledged and its journal is cleared.
    return result;
  }
  private async optional<T>(fn: () => Promise<{ data: T }>) {
    try {
      return (await fn()).data;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }
  async load(): Promise<CloudData> {
    this.guard();
    // Bootstrap must fit the backend's bounded Lambda concurrency. Each collection
    // includes its continuation pages; finish it before starting the next read.
    const ex = await this.api.all("GET /v1/workouts/exercises");
    const foods = await this.api.all("GET /v1/nutrition/foods");
    const templates = await this.api.all("GET /v1/workouts/templates");
    const recipes = await this.api.all("GET /v1/nutrition/recipes");
    const active = await this.api.all("GET /v1/workouts/sessions/active");
    const profile = await this.optional(() => this.api.call("GET /v1/me"));
    const goals = await this.optional(() =>
      this.api.call("GET /v1/nutrition/goals", {
        query: { date: "9999-12-31" },
      }),
    );
    this.guard();
    ex.forEach((r) => {
      exercise(r, this.subject);
      this.exercises.set(r.id, r);
    });
    foods.forEach((r) => {
      food(r, this.subject);
      this.foods.set(r.id, r);
    });
    templates.forEach((r) => {
      owner(r, this.subject);
      this.templates.set(r.id, r);
    });
    recipes.forEach((r) => {
      recipe(r, this.subject);
      this.recipes.set(r.id, r);
    });
    active.forEach((r) => {
      workout(r, this.subject);
      this.sessions.set(r.id, r);
    });
    if (profile) owner(profile, this.subject);
    if (goals) owner(goals, this.subject);
    this.profile = profile;
    this.goals = goals;
    const user = {
      id: this.subject,
      name: profile?.name ?? "Your profile",
      unit: profile?.unit ?? "kg",
      timeZone: profile?.timeZone ?? "America/Los_Angeles",
    };
    this.data = {
      tracker: {
        version: 3,
        userId: this.subject,
        library: [],
        templates: [],
        session: emptyWorkout(this.subject),
        history: [],
      },
      nutrition: {
        version: 1,
        user,
        foods: [],
        recipes: [],
        diary: [],
        favorites: profile?.favoriteFoodIds ?? [],
        goals: {
          id: "current",
          ownerId: this.subject,
          calories: goals?.calories ?? 2400,
          protein: goals?.protein ?? 160,
          carbs: goals?.carbs ?? 290,
          fat: goals?.fat ?? 67,
        },
      },
    };
    await this.loadOlderHistory();
    // Strong direct read from URL also resumes a just-created draft while the GSI propagates.
    const requested =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("draft")
        : null;
    if (requested && /^[A-Za-z0-9_-]+$/.test(requested)) {
      const r = await this.optional(() =>
        this.api.call("GET /v1/workouts/sessions/{id}", {
          params: { id: requested },
        }),
      );
      if (r) {
        owner(r, this.subject);
        this.sessions.set(r.id, r);
      }
    }
    const candidates = [...this.sessions.values()]
      .filter((s) => s.status === "active")
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const selected =
      candidates.find((s) => s.id === requested) ?? candidates[0];
    if (selected) this.data.tracker.session = workout(selected, this.subject);
    const day = today(user.timeZone);
    for (let i = 0; i < 7; i++) await this.readDay(shiftDate(day, -i));
    const effective = this.days.get(day)?.goals;
    if (effective)
      this.data.nutrition.goals = {
        id: "current",
        ownerId: this.subject,
        calories: effective.calories,
        protein: effective.protein,
        carbs: effective.carbs,
        fat: effective.fat,
      };
    this.guard();
    return this.project();
  }
  project(): CloudData {
    this.guard();
    const old = this.data;
    const history = [...this.sessions.values()]
      .filter((s) => s.status === "completed")
      .map((s) => workout(s, this.subject));
    // Completed versions remain visible when a logical workout has been reopened.
    const archived = old.tracker.history.filter(
      (s) => !history.some((h) => h.id === s.id),
    );
    this.data = {
      tracker: validateStore(
        {
          ...old.tracker,
          library: [...this.exercises.values()].map((r) =>
            exercise(r, this.subject),
          ),
          templates: [...this.templates.values()].map((r) =>
            templateSchema.parse({
              ...r,
              ownerId: this.subject,
              visibility: "private",
              exercises: r.exercises ?? [],
              trainingType: r.trainingType ?? "hypertrophy",
            }),
          ),
          history: [...archived, ...history],
        },
        this.subject,
      ),
      nutrition: nutritionSchema.parse({
        ...old.nutrition,
        foods: [...this.foods.values()].map((r) => food(r, this.subject)),
        recipes: [...this.recipes.values()]
          .filter((r) => !r.archived)
          .map((r) => recipe(r, this.subject)),
        diary: [...this.entries.values()].map((r) => diary(r, this.subject)),
      }),
    };
    return this.data;
  }
  async loadOlderHistory() {
    const end = this.historyBefore;
    const start = new Date(end.getTime() - 365 * 86400000);
    const values = await this.api.all("GET /v1/workouts/sessions", undefined, {
      from: start.toISOString(),
      to: end.toISOString(),
    });
    this.guard();
    values.forEach((r) => {
      owner(r, this.subject);
      // A reopened logical workout also has an immutable completed generation.
      // Keep the active root discoverable while adding its old generation to history.
      if (this.sessions.get(r.id)?.status !== "active")
        this.sessions.set(r.id, r);
    });
    this.historyBefore = start;
    if (this.data)
      this.data.tracker.history = [
        ...new Map(
          [
            ...this.data.tracker.history,
            ...values.map((r) => workout(r, this.subject)),
          ].map((s) => [s.id, s]),
        ).values(),
      ];
  }
  async loadExerciseHistory(id: string) {
    const values = await this.api.all(
      "GET /v1/workouts/exercises/{id}/history",
      { id },
    );
    this.guard();
    this.data.tracker.history = [
      ...new Map(
        [
          ...this.data.tracker.history,
          ...values.map((r) => workout(r, this.subject)),
        ].map((s) => [s.id, s]),
      ).values(),
    ];
    return this.project();
  }
  async readDay(date: string) {
    const r = await this.api.call("GET /v1/nutrition/diary", {
      query: { date },
    });
    this.guard();
    r.data.entries.forEach((e) => owner(e, this.subject));
    if (r.data.goals) owner(r.data.goals, this.subject);
    for (const [id, e] of this.entries)
      if (e.date === date) this.entries.delete(id);
    r.data.entries.forEach((e) => this.entries.set(e.id, e));
    this.days.set(date, r.data);
    return r.data;
  }
  async historicalRecipe(id: string, version: number) {
    const result = await this.api.call(
      "GET /v1/nutrition/recipes/{id}/versions/{version}",
      { params: { id, version } },
    );
    this.guard();
    return recipe(result.data, this.subject);
  }
  async start(name = "Your workout", templateId?: string) {
    const id = crypto.randomUUID();
    const t = templateId ? this.templates.get(templateId) : null;
    this.startRequest ??= {
      id,
      name,
      startedAt: stamp(),
      unit: this.data.nutrition.user.unit,
      ...(t
        ? { templateId: t.id, templateRevision: t.revision }
        : { exercises: [] }),
    };
    const response = await this.mutate("POST /v1/workouts/sessions", {
      body: this.startRequest,
    });
    this.sessions.set(response.data.id, response.data);
    this.data.tracker.session = workout(response.data, this.subject);
    return this.project();
  }
  async saveTracker(target: TrackerStore): Promise<CloudData> {
    this.guard();
    if (target.userId !== this.subject) throw new Error("ACCOUNT_CHANGED");
    for (const e of target.library.filter((e) => e.source === "custom")) {
      const old = this.exercises.get(e.id);
      const body = exBody(e);
      if (!old) {
        const r = await this.mutate("POST /v1/workouts/exercises", { body });
        this.exercises.set(e.id, r.data);
      } else if (!same(exBody(exercise(old, this.subject)), body)) {
        const { id, ...patch } = body;
        const r = await this.mutate("PATCH /v1/workouts/exercises/{id}", {
          params: { id },
          revision: old.revision,
          body: patch,
        });
        this.exercises.set(id, r.data);
      }
    }
    for (const t of target.templates) {
      const old = this.templates.get(t.id);
      const body = {
        id: t.id,
        name: t.name,
        trainingType: t.trainingType,
        exercises: t.exercises,
      };
      if (!old) {
        const r = await this.mutate("POST /v1/workouts/templates", { body });
        this.templates.set(t.id, r.data);
      } else if (
        !same(
          {
            name: old.name,
            trainingType: old.trainingType,
            exercises: old.exercises,
          },
          {
            name: t.name,
            trainingType: t.trainingType,
            exercises: t.exercises,
          },
        )
      ) {
        const { id, ...patch } = body;
        const r = await this.mutate("PATCH /v1/workouts/templates/{id}", {
          params: { id },
          revision: old.revision,
          body: patch,
        });
        this.templates.set(id, r.data);
      }
    }
    const value = target.session;
    let old = this.sessions.get(value.id);
    if (!old && !same(value, this.data.tracker.session)) {
      const template = value.templateId
        ? this.templates.get(value.templateId)
        : null;
      const r = await this.mutate("POST /v1/workouts/sessions", {
        body: {
          id: value.id,
          name: value.name,
          trainingType: value.trainingType,
          unit: value.unit,
          startedAt: new Date(value.started).toISOString(),
          ...(template
            ? { templateId: template.id, templateRevision: template.revision }
            : {
                exercises: value.exercises.map((e) => ({
                  id: e.id,
                  exerciseId: e.exerciseId,
                  prescription: e.prescription,
                })),
              }),
        },
      });
      // Server determines initial per-side prefill and IDs; no unacknowledged defaults overwrite it.
      this.sessions.set(value.id, r.data);
      this.data.tracker.session = workout(r.data, this.subject);
      return this.project();
    }
    if (old) {
      if (old.status === "completed" && !value.finished) {
        const r = await this.mutate("POST /v1/workouts/sessions/{id}/reopen", {
          params: { id: value.id },
          body: {},
          revision: old.revision,
        });
        old = r.data;
        this.sessions.set(value.id, old);
      }
      if (
        old.status === "active" &&
        !same(draft(workout(old, this.subject)), draft(value))
      ) {
        const r = await this.mutate("PUT /v1/workouts/sessions/{id}/draft", {
          params: { id: value.id },
          body: draft(value),
          revision: old.revision,
        });
        old = r.data;
        this.sessions.set(value.id, old);
      }
      if (value.finished && old.status === "active") {
        const r = await this.mutate(
          "POST /v1/workouts/sessions/{id}/complete",
          { params: { id: value.id }, body: {}, revision: old.revision },
        );
        old = r.data;
        this.sessions.set(value.id, old);
      }
      this.data.tracker.session = workout(old, this.subject);
    }
    return this.project();
  }
  async saveNutrition(target: NutritionStore): Promise<CloudData> {
    this.guard();
    if (target.user.id !== this.subject) throw new Error("ACCOUNT_CHANGED");
    for (const f of target.foods.filter((f) => f.source === "custom")) {
      const old = this.foods.get(f.id),
        body = foodBody(f);
      if (!old) {
        const r = await this.mutate("POST /v1/nutrition/foods", { body });
        this.foods.set(f.id, r.data);
      } else if (!same(foodBody(food(old, this.subject)), body)) {
        const { id, ...patch } = body;
        const r = await this.mutate("PATCH /v1/nutrition/foods/{id}", {
          params: { id },
          revision: old.revision,
          body: patch,
        });
        this.foods.set(id, r.data);
      }
    }
    for (const r of target.recipes) {
      const old = this.recipes.get(r.id);
      if (old && same(recipeFields(recipe(old, this.subject)), recipeFields(r)))
        continue;
      const body = {
        id: r.id,
        name: r.name,
        finishedGrams: r.finishedGrams,
        ingredients: r.ingredients.map((i) => {
          const existing = old?.ingredients.find(
            (e) => e.id === i.id && e.foodId === i.foodId,
          );
          return {
            id: i.id,
            foodId: i.foodId,
            grams: i.grams,
            ...(existing
              ? { retainSnapshot: true }
              : { foodRevision: this.foods.get(i.foodId)?.revision }),
          };
        }),
      };
      if (!old) {
        const response = await this.mutate("POST /v1/nutrition/recipes", {
          body,
        });
        this.recipes.set(r.id, response.data);
      } else {
        const { id, ...patch } = body;
        const response = await this.mutate("PATCH /v1/nutrition/recipes/{id}", {
          params: { id },
          revision: old.revision,
          body: patch,
        });
        this.recipes.set(id, response.data);
      }
    }
    const affected = new Set<string>();
    for (const e of target.diary) {
      const old = this.entries.get(e.id);
      if (!old) {
        const source =
          e.sourceType === "food"
            ? this.foods.get(e.sourceId)
            : this.recipes.get(e.sourceId);
        if (!source) throw new Error("SOURCE_UNAVAILABLE");
        const r = await this.mutate("POST /v1/nutrition/diary/entries", {
          body: {
            id: e.id,
            date: e.date,
            meal: e.meal,
            sourceId: e.sourceId,
            sourceType: e.sourceType,
            grams: e.grams,
            sourceRevision:
              e.sourceType === "recipe"
                ? (source as RecipeRead).version
                : source.revision,
          },
        });
        this.entries.set(e.id, r.data);
        affected.add(e.date);
      } else if (
        !same(
          { date: old.date, meal: old.meal, grams: old.grams },
          { date: e.date, meal: e.meal, grams: e.grams },
        )
      ) {
        const r = await this.mutate("PATCH /v1/nutrition/diary/entries/{id}", {
          params: { id: e.id },
          revision: old.revision,
          body: { date: e.date, meal: e.meal, grams: e.grams },
        });
        this.entries.set(e.id, r.data);
        affected.add(e.date);
        affected.add(old.date);
      }
    }
    const ids = new Set(target.diary.map((e) => e.id));
    for (const [id, e] of this.entries)
      if (!ids.has(id)) {
        await this.mutate("DELETE /v1/nutrition/diary/entries/{id}", {
          params: { id },
          body: {},
          revision: e.revision,
        });
        this.entries.delete(id);
        affected.add(e.date);
      }
    const { id: _id, ownerId: _owner, ...nextGoals } = target.goals;
    void _id;
    void _owner;
    const oldGoals = this.data.nutrition.goals;
    if (!same(target.goals, oldGoals)) {
      const r = await this.mutate("PUT /v1/nutrition/goals", {
        body: { ...nextGoals, effectiveFrom: today(target.user.timeZone) },
        revision: this.goals?.revision ?? 0,
      });
      this.goals = r.data;
      this.data.nutrition.goals = {
        ...target.goals,
        calories: r.data.calories,
        protein: r.data.protein,
        carbs: r.data.carbs,
        fat: r.data.fat,
      };
      for (const date of this.days.keys()) affected.add(date);
    }
    if (
      !same(target.user, this.data.nutrition.user) ||
      !same(target.favorites, this.data.nutrition.favorites)
    ) {
      const { id, ...user } = target.user;
      void id;
      const body = { ...user, favoriteFoodIds: target.favorites };
      const r = this.profile
        ? await this.mutate("PATCH /v1/me", {
            body,
            revision: this.profile.revision,
          })
        : await this.mutate("POST /v1/me", { body });
      this.profile = r.data;
      this.data.nutrition.user = {
        ...target.user,
        name: r.data.name,
        unit: r.data.unit ?? "kg",
        timeZone: r.data.timeZone ?? "America/Los_Angeles",
      };
      this.data.nutrition.favorites = r.data.favoriteFoodIds ?? [];
    }
    await Promise.all([...affected].map((date) => this.readDay(date)));
    return this.project();
  }
}
