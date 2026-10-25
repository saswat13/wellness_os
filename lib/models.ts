import { z } from "zod";
export const trainingTypes = [
  "hypertrophy",
  "powerlifting",
  "hyrox",
  "running",
  "other",
] as const;
export const muscles = [
  "Chest",
  "Lats",
  "Upper back",
  "Shoulders",
  "Biceps",
  "Triceps",
  "Quads",
  "Hamstrings",
  "Glutes",
  "Calves",
  "Core",
  "Other",
] as const;
export const patterns = [
  "Vertical pull",
  "Horizontal pull",
  "Horizontal push",
  "Vertical push",
  "Squat",
  "Hinge",
  "Lunge",
  "Isolation",
  "Carry",
  "Locomotion",
  "Other",
] as const;
export const equipmentOptions = [
  "Cable",
  "Smith machine",
  "Barbell",
  "Dumbbell",
  "Machine",
  "Bodyweight",
  "Band",
  "Other",
] as const;
const id = z.string().min(1);
const text = z.string().max(2000);
export const exerciseSchema = z
  .object({
    id,
    ownerId: id.nullable(),
    source: z.enum(["system", "custom"]),
    name: z.string().trim().min(1).max(120),
    aliases: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
    externalId: z.string().min(1).max(128).nullable().optional(),
    sourceInfo: z.string().max(500).optional(),
    primaryMuscle: z.enum(muscles).nullable(),
    secondaryMuscles: z.array(z.enum(muscles)),
    movementPattern: z.enum(patterns).nullable(),
    equipment: z.enum(equipmentOptions).nullable(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20),
    trainingTypes: z.array(z.enum(trainingTypes)),
    unilateral: z.boolean(),
    coachingNotes: text,
    demoUrl: z
      .string()
      .refine((v) => !v || /^https?:\/\//i.test(v), "Use an http or https URL"),
    archived: z.boolean(),
    createdAt: id,
    updatedAt: id,
  })
  .refine(
    (e) => (e.source === "system" ? e.ownerId === null : e.ownerId !== null),
    "Custom exercises require an owner",
  );
export type Exercise = z.infer<typeof exerciseSchema>;
export const prescriptionSchema = z.object({
  plannedSets: z.number().int().min(1).max(20),
  target: z.string().trim().min(1).max(40),
  note: text,
});
export type Prescription = z.infer<typeof prescriptionSchema>;
const templateEntrySchema = z.object({
  id,
  exerciseId: id,
  prescription: prescriptionSchema,
});
export type TemplateExercise = z.infer<typeof templateEntrySchema>;
export const templateSchema = z.object({
  id,
  ownerId: id,
  name: z.string().trim().min(1).max(120),
  trainingType: z.enum(trainingTypes),
  visibility: z.enum(["private", "public"]),
  exercises: z.array(templateEntrySchema),
  createdAt: id,
  updatedAt: id,
});
export type WorkoutTemplate = z.infer<typeof templateSchema>;
export const setSchema = z.object({
  id,
  groupId: id,
  ownerId: id,
  sessionId: id,
  sessionExerciseId: id,
  exerciseId: id,
  reps: z.number().int().min(0).max(999),
  kg: z.number().min(0).max(10000),
  rpe: z
    .string()
    .refine((v) => v === "" || ["5", "6", "7", "8", "9", "10"].includes(v)),
  done: z.boolean(),
  side: z.enum(["L", "R", "both"]),
});
export type ExerciseSet = z.infer<typeof setSchema>;
const sessionEntrySchema = z.object({
  id,
  sameWeight: z.boolean(),
  exerciseId: id,
  snapshot: exerciseSchema,
  prescription: prescriptionSchema,
});
export type SessionExercise = z.infer<typeof sessionEntrySchema>;
export const sessionSchema = z.object({
  id,
  ownerId: id,
  templateId: id.nullable(),
  name: z.string().trim().min(1).max(120),
  trainingType: z.enum(trainingTypes),
  exercises: z.array(sessionEntrySchema),
  logs: z.record(id, z.array(setSchema)),
  notes: text,
  unit: z.enum(["kg", "lb"]),
  finished: z.boolean(),
  started: z
    .number()
    .finite()
    .refine(
      (value) => Number.isFinite(new Date(value).getTime()),
      "Invalid session timestamp",
    ),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  mock: z.boolean(),
});
export type WorkoutSession = z.infer<typeof sessionSchema>;
export const storeSchema = z.object({
  version: z.literal(3),
  userId: id,
  library: z.array(exerciseSchema),
  templates: z.array(templateSchema),
  session: sessionSchema,
  history: z.array(sessionSchema),
});
export type TrackerStore = z.infer<typeof storeSchema>;
export const legacySessionSchema = sessionSchema
  .pick({ notes: true, unit: true, finished: true, started: true })
  .extend({
    logs: z.record(
      id,
      z.array(
        setSchema.omit({
          groupId: true,
          ownerId: true,
          sessionId: true,
          sessionExerciseId: true,
          exerciseId: true,
        }),
      ),
    ),
  });

/** Rep targets are descriptive text, but generated actual rows must fit the set schema. */
export function plannedReps(target: string): number {
  const match = target.match(/\d+/)?.[0];
  return match === undefined ? 10 : Math.min(999, Math.max(0, Number(match)));
}
