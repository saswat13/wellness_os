import { z } from "zod";
import { USER_ID, newId } from "./tracker";

export const NUTRITION_KEY = "form-nutrition-v1";
export const preparations = ["raw", "cooked", "dry", "packaged"] as const;
export const meals = ["Breakfast", "Lunch", "Dinner", "Snacks"] as const;
const id = z.string().min(1);
const amount = z.number().finite().min(0).max(100000);
export const nutrientsSchema = z.object({
  calories: amount,
  protein: amount,
  carbs: amount,
  fat: amount,
});
export type Nutrients = z.infer<typeof nutrientsSchema>;
export const userSchema = z.object({
  id,
  name: z.string().trim().min(1).max(80),
  unit: z.enum(["kg", "lb"]),
  timeZone: id,
});
export type User = z.infer<typeof userSchema>;
export const goalsSchema = nutrientsSchema.extend({ id, ownerId: id });
export type NutritionGoals = z.infer<typeof goalsSchema>;
export const foodSchema = z
  .object({
    id,
    ownerId: id.nullable(),
    source: z.enum(["system", "custom"]),
    name: z.string().trim().min(1).max(120),
    aliases: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
    externalId: z.string().min(1).max(128).nullable().optional(),
    preparation: z.enum(preparations),
    per100g: nutrientsSchema,
    sourceInfo: z.string().max(500),
  })
  .refine((f) =>
    f.source === "system" ? f.ownerId === null : f.ownerId !== null,
  );
export type Food = z.infer<typeof foodSchema>;
export const recipeSchema = z.object({
  id,
  ownerId: id,
  name: z.string().trim().min(1).max(120),
  finishedGrams: z.number().finite().positive().max(100000),
  ingredients: z
    .array(
      z.object({
        id,
        foodId: id,
        grams: z.number().finite().positive().max(100000),
        snapshot: foodSchema,
      }),
    )
    .min(1)
    .max(100),
  updatedAt: id,
});
export type Recipe = z.infer<typeof recipeSchema>;
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + "T12:00:00Z");
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  });
export const diarySchema = z.object({
  id,
  ownerId: id,
  date: dateSchema,
  meal: z.enum(meals),
  sourceId: id,
  sourceType: z.enum(["food", "recipe"]),
  grams: z.number().finite().positive().max(100000),
  snapshot: z.object({
    name: id.max(120),
    preparation: z.enum(preparations),
    per100g: nutrientsSchema,
  }),
  createdAt: id,
});
export type DiaryEntry = z.infer<typeof diarySchema>;
export const nutritionSchema = z.object({
  version: z.literal(1),
  user: userSchema,
  goals: goalsSchema,
  foods: z.array(foodSchema),
  recipes: z.array(recipeSchema),
  diary: z.array(diarySchema),
  favorites: z.array(id),
});
export type NutritionStore = z.infer<typeof nutritionSchema>;
export const zero = (): Nutrients => ({
  calories: 0,
  protein: 0,
  carbs: 0,
  fat: 0,
});
export function scale(n: Nutrients, grams: number): Nutrients {
  return {
    calories: (n.calories * grams) / 100,
    protein: (n.protein * grams) / 100,
    carbs: (n.carbs * grams) / 100,
    fat: (n.fat * grams) / 100,
  };
}
export function sum(values: Nutrients[]): Nutrients {
  return values.reduce(
    (a, b) => ({
      calories: a.calories + b.calories,
      protein: a.protein + b.protein,
      carbs: a.carbs + b.carbs,
      fat: a.fat + b.fat,
    }),
    zero(),
  );
}
export const macroCalories = (n: Nutrients) =>
  n.protein * 4 + n.carbs * 4 + n.fat * 9;
export const goalsDiffer = (n: Nutrients) =>
  Math.abs(macroCalories(n) - n.calories) > Math.max(100, n.calories * 0.1);
export const recipeTotal = (r: Pick<Recipe, "ingredients">) =>
  sum(r.ingredients.map((i) => scale(i.snapshot.per100g, i.grams)));
export const recipePer100g = (r: Recipe) =>
  scale(recipeTotal(r), 10000 / r.finishedGrams);
export const entryNutrition = (e: DiaryEntry) =>
  scale(e.snapshot.per100g, e.grams);
export function dayTotals(s: NutritionStore, date: string) {
  return sum(
    s.diary
      .filter((e) => e.ownerId === s.user.id && e.date === date)
      .map(entryNutrition),
  );
}
export function today(timeZone = "America/Los_Angeles", now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function shiftDate(date: string, offset: number) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
export function saveFood(s: NutritionStore, value: Food): NutritionStore {
  const f = foodSchema.parse(value),
    old = s.foods.find((x) => x.id === f.id);
  if (
    f.ownerId !== s.user.id ||
    f.source !== "custom" ||
    (old && old.ownerId !== s.user.id)
  )
    throw new Error("Only your custom foods can be edited.");
  return {
    ...s,
    foods: old ? s.foods.map((x) => (x.id === f.id ? f : x)) : [...s.foods, f],
  };
}
export function saveRecipe(s: NutritionStore, value: Recipe): NutritionStore {
  const r = recipeSchema.parse(value),
    old = s.recipes.find((x) => x.id === r.id);
  if (
    r.ownerId !== s.user.id ||
    (old && old.ownerId !== s.user.id) ||
    r.ingredients.some(
      (i) =>
        i.foodId !== i.snapshot.id ||
        (i.snapshot.ownerId !== null && i.snapshot.ownerId !== s.user.id) ||
        !s.foods.some(
          (f) =>
            f.id === i.foodId &&
            (f.ownerId === null || f.ownerId === s.user.id),
        ),
    )
  )
    throw new Error("Recipe or ingredients are unavailable.");
  return {
    ...s,
    recipes: old
      ? s.recipes.map((x) => (x.id === r.id ? r : x))
      : [...s.recipes, r],
  };
}
export function logPortion(
  s: NutritionStore,
  sourceType: "food" | "recipe",
  sourceId: string,
  grams: number,
  meal: DiaryEntry["meal"],
  date: string,
): NutritionStore {
  const item =
    sourceType === "food"
      ? s.foods.find(
          (f) =>
            f.id === sourceId &&
            (f.ownerId === null || f.ownerId === s.user.id),
        )
      : s.recipes.find((r) => r.id === sourceId && r.ownerId === s.user.id);
  if (!item) throw new Error("Food or recipe is unavailable.");
  const snapshot =
    "per100g" in item
      ? {
          name: item.name,
          preparation: item.preparation,
          per100g: item.per100g,
        }
      : {
          name: item.name,
          preparation: "cooked" as const,
          per100g: recipePer100g(item),
        };
  const entry = diarySchema.parse({
    id: newId(),
    ownerId: s.user.id,
    sourceId,
    sourceType,
    grams,
    meal,
    date,
    snapshot: structuredClone(snapshot),
    createdAt: new Date().toISOString(),
  });
  return { ...s, diary: [...s.diary, entry] };
}
export function editDiary(
  s: NutritionStore,
  id: string,
  patch: Pick<DiaryEntry, "grams" | "meal" | "date">,
): NutritionStore {
  const e = s.diary.find((e) => e.id === id && e.ownerId === s.user.id);
  if (!e) throw new Error("Diary entry is unavailable.");
  const updated = diarySchema.parse({ ...e, ...patch });
  return { ...s, diary: s.diary.map((e) => (e.id === id ? updated : e)) };
}
export function deleteDiary(s: NutritionStore, id: string): NutritionStore {
  if (!s.diary.some((e) => e.id === id && e.ownerId === s.user.id))
    throw new Error("Diary entry is unavailable.");
  return { ...s, diary: s.diary.filter((e) => e.id !== id) };
}
export function saveGoals(
  s: NutritionStore,
  value: NutritionGoals,
): NutritionStore {
  const goals = goalsSchema.parse(value);
  if (goals.ownerId !== s.user.id || goals.id !== s.goals.id)
    throw new Error("Goals belong to another user.");
  return { ...s, goals };
}
export function saveUser(s: NutritionStore, value: User): NutritionStore {
  const user = userSchema.parse(value);
  if (user.id !== s.user.id)
    throw new Error("Profile belongs to another user.");
  new Intl.DateTimeFormat("en", { timeZone: user.timeZone });
  return { ...s, user };
}
export function toggleFavorite(s: NutritionStore, id: string): NutritionStore {
  if (
    !s.foods.some(
      (f) => f.id === id && (f.ownerId === null || f.ownerId === s.user.id),
    )
  )
    throw new Error("Food is unavailable.");
  return {
    ...s,
    favorites: s.favorites.includes(id)
      ? s.favorites.filter((f) => f !== id)
      : [...s.favorites, id],
  };
}
export function parseNutrition(value: unknown): NutritionStore {
  const s = nutritionSchema.parse(value);
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  if (
    s.user.id !== USER_ID ||
    s.goals.ownerId !== s.user.id ||
    s.foods.some((f) => f.ownerId !== null && f.ownerId !== s.user.id) ||
    s.recipes.some(
      (r) =>
        r.ownerId !== s.user.id ||
        !unique(r.ingredients.map((i) => i.id)) ||
        r.ingredients.some(
          (i) =>
            i.foodId !== i.snapshot.id ||
            (i.snapshot.ownerId !== null && i.snapshot.ownerId !== s.user.id) ||
            !s.foods.some((f) => f.id === i.foodId),
        ),
    ) ||
    s.diary.some(
      (e) =>
        e.ownerId !== s.user.id ||
        !(e.sourceType === "food" ? s.foods : s.recipes).some(
          (x) => x.id === e.sourceId,
        ),
    ) ||
    s.favorites.some((id) => !s.foods.some((f) => f.id === id)) ||
    ![s.foods, s.recipes, s.diary].every((items) =>
      unique(items.map((i) => i.id)),
    ) ||
    !unique(s.favorites)
  )
    throw new Error("Invalid nutrition ownership or references.");
  new Intl.DateTimeFormat("en", { timeZone: s.user.timeZone });
  return s;
}
export function seedNutrition(): NutritionStore {
  const foods: Food[] = [
    ["oats", "Rolled oats", "dry", 379, 13.2, 67.7, 6.5],
    ["yogurt", "Greek yogurt · plain", "packaged", 73, 10, 3.9, 2],
    ["banana", "Banana", "raw", 89, 1.1, 22.8, 0.3],
    ["rice-dry", "Basmati rice", "dry", 360, 7, 79, 0.7],
    ["rice-cooked", "Basmati rice", "cooked", 130, 2.7, 28.2, 0.3],
    ["chicken-raw", "Chicken breast", "raw", 120, 22.5, 0, 2.6],
    ["chicken-cooked", "Chicken breast", "cooked", 165, 31, 0, 3.6],
    ["broccoli", "Broccoli", "cooked", 35, 2.4, 7.2, 0.4],
    ["olive-oil", "Olive oil", "packaged", 884, 0, 0, 100],
    ["eggs", "Whole egg", "raw", 143, 12.6, 0.7, 9.5],
    ["bread", "Wholegrain bread", "packaged", 247, 13, 41, 4.2],
    ["berries", "Blueberries", "raw", 57, 0.7, 14.5, 0.3],
  ].map(([id, name, preparation, calories, protein, carbs, fat]) => ({
    id: String(id),
    ownerId: null,
    source: "system",
    name: String(name),
    preparation: preparation as Food["preparation"],
    per100g: {
      calories: Number(calories),
      protein: Number(protein),
      carbs: Number(carbs),
      fat: Number(fat),
    },
    sourceInfo:
      "Illustrative mock nutrition values; check your own food label.",
  }));
  let s: NutritionStore = {
    version: 1,
    user: {
      id: USER_ID,
      name: "FORM Athlete",
      unit: "kg",
      timeZone: "America/Los_Angeles",
    },
    goals: {
      id: "nutrition-goals",
      ownerId: USER_ID,
      calories: 2400,
      protein: 160,
      carbs: 290,
      fat: 67,
    },
    foods,
    recipes: [],
    diary: [],
    favorites: ["yogurt", "rice-cooked", "chicken-cooked"],
  };
  const date = today(s.user.timeZone);
  for (let day = -6; day <= 0; day++) {
    for (const [foodId, grams, meal] of [
      ["oats", 60, "Breakfast"],
      ["yogurt", 200, "Breakfast"],
      ["berries", 80, "Breakfast"],
      ["rice-cooked", 180 + day * 5, "Lunch"],
      ["chicken-cooked", 150, "Lunch"],
      ["broccoli", 100, "Lunch"],
    ] as const)
      s = logPortion(s, "food", foodId, grams, meal, shiftDate(date, day));
    if (day < 0)
      for (const [foodId, grams, meal] of [
        ["bread", 120, "Dinner"],
        ["eggs", 150, "Dinner"],
        ["banana", 120, "Snacks"],
        ["yogurt", 150, "Snacks"],
      ] as const)
        s = logPortion(s, "food", foodId, grams, meal, shiftDate(date, day));
  }
  return s;
}
