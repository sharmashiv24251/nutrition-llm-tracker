// Input schemas for the data layer. Phase 3 reuses them as the agent's tool parameter schemas,
// so every field carries a description the model will read.
import { z } from "zod";

export const LOAD_TYPES = ["added", "assisted", "bodyweight_only", "total", "per_side", "per_hand"] as const;
export const MEALS = ["breakfast", "lunch", "dinner", "snack", "other"] as const;
export const CONFIDENCE = ["label", "saved", "estimate"] as const;
export const FOOD_SOURCES = ["label_photo", "web", "manual", "estimate"] as const;

/** Tables the agent may edit or delete rows in. The UI edit route uses the same list. */
export const EDITABLE_TABLES = [
  "trk_food_entries", "trk_sets", "trk_workout_sessions", "trk_bodyweight", "trk_foods", "trk_exercises",
  "trk_household_units", "trk_program_exercises",
] as const;
/** Settings-page tables, edited from the UI only. */
export const SETTINGS_TABLES = ["trk_targets", "trk_pricing", "trk_settings", "trk_household_units"] as const;

const day = z.iso.date().describe("Logical day, YYYY-MM-DD");
const uuid = z.uuid();
const nonneg = z.number().nonnegative();

export const DayRange = z.object({
  from: day,
  to: day,
  type: z.enum(["food", "sets", "bodyweight"]),
});

export const FoodQuery = z.object({ query: z.string().min(1).max(200) });

export const SaveFood = z.object({
  id: uuid.optional().describe("Set to update an existing library food"),
  name: z.string().min(1).max(120),
  aliases: z.array(z.string().max(120)).max(20).default([]),
  brand: z.string().max(120).nullish(),
  kcal_per_100g: nonneg,
  protein_per_100g: nonneg.default(0),
  carbs_per_100g: nonneg.default(0),
  fat_per_100g: nonneg.default(0),
  fibre_per_100g: nonneg.default(0),
  serving_name: z.string().max(60).nullish().describe("e.g. 'scoop', 'bar', 'piece'"),
  serving_g: z.number().positive().nullish(),
  source: z.enum(FOOD_SOURCES),
  source_url: z.url().nullish(),
});

export const FoodItem = z.object({
  raw_text: z.string().min(1).max(4000).describe("My exact words for this item"),
  display_name: z.string().min(1).max(120),
  food_id: uuid.optional().describe("Library food; its saved values are used and any macros given here are ignored"),
  quantity: z.number().positive().optional().describe("As I said it: 1.5 (katori), 3 (roti), 360 (g)"),
  unit: z.string().max(40).optional().describe("g, kg, ml, katori, bowl, roti, scoop, cup, serving, ..."),
  grams: nonneg.optional().describe("Total grams, when I stated them"),
  meal: z.enum(MEALS).optional(),
  eaten_at: z.iso.datetime({ offset: true }).optional(),
  kcal: nonneg.optional().describe("Required when food_id is not set"),
  protein_g: nonneg.optional(),
  carbs_g: nonneg.optional(),
  fat_g: nonneg.optional(),
  fibre_g: nonneg.optional(),
  confidence: z.enum(CONFIDENCE).optional(),
  assumptions: z.string().max(500).optional().describe("One sentence, e.g. 'assumed 100 g paneer and 2 tbsp oil.'"),
});

export const LogFood = z.object({ day, items: z.array(FoodItem).min(1).max(30) });

export const ExerciseQuery = z.object({ query: z.string().min(1).max(200) });

const exerciseNotes = z.string().max(2000)
  .describe("Free text on how I do it: machine or brand, seat/pin settings, grip, range of motion, tempo, cues");

export const CreateExercise = z.object({
  name: z.string().trim().min(1).max(80),
  aliases: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  equipment: z.string().max(60).nullish(),
  default_load_type: z.enum(LOAD_TYPES),
  notes: exerciseNotes.nullish(),
  distinct_from: uuid.optional().describe("Id of a close match you judged to be a different exercise"),
});

export const UpdateExercise = z.object({
  id: uuid,
  name: z.string().trim().min(1).max(80).optional().describe("New name; history is kept and the old name becomes an alias"),
  aliases: z.array(z.string().trim().min(1).max(80)).max(30).optional().describe("Replaces the alias list"),
  add_aliases: z.array(z.string().trim().min(1).max(80)).max(10).optional().describe("Adds to the alias list"),
  equipment: z.string().max(60).nullish(),
  default_load_type: z.enum(LOAD_TYPES).optional(),
  notes: exerciseNotes.nullish().describe("Replaces the notes. Use append_note to add without losing what's there"),
  append_note: z.string().trim().min(1).max(500).optional().describe("Adds a line to the existing notes"),
});

export const SetInput = z.object({
  exercise_id: uuid,
  variation: z.string().max(80).nullish().describe("Grip, stance or angle, e.g. 'wide underhand'"),
  load_kg: nonneg.nullish().describe("Extra weight for added, assistance for assisted, per side/hand for per_side/per_hand"),
  load_type: z.enum(LOAD_TYPES),
  full_reps: z.int().nonnegative(),
  partial_reps: z.int().nonnegative().default(0),
  rest_pause_reps: z.int().nonnegative().default(0),
  rpe: z.number().min(1).max(10).nullish(),
  is_warmup: z.boolean().default(false),
  raw_text: z.string().min(1).max(4000).describe("My exact words"),
});

export const LogSets = z.object({
  session_id: uuid.optional().describe("Omit to use the active session, or open one for today"),
  program_day_id: uuid.optional().describe("When this opens a new session: the program day it belongs to"),
  sets: z.array(SetInput).min(1).max(50),
});

export const StartWorkout = z.object({ day: day.optional(), program_day_id: uuid.optional() });

export const ProgramExerciseInput = z.object({
  exercise_id: uuid,
  variation: z.string().max(80).nullish(),
  sets: z.int().positive().nullish(),
  rep_min: z.int().nonnegative().nullish(),
  rep_max: z.int().nonnegative().nullish(),
  target_load_kg: nonneg.nullish().describe("Working weight, or the low end of a range"),
  target_load_max_kg: nonneg.nullish().describe("High end of a weight range like 77.5-80 kg"),
  load_type: z.enum(LOAD_TYPES).nullish(),
  rest_s: z.int().nonnegative().nullish(),
  note: z.string().max(300).nullish(),
});

export const PlanWorkout = z.object({
  program_day: z.string().max(60).optional()
    .describe("Program day name like 'pull 2' or its id; omit for today's day in the rotation"),
});

export const AddProgramExercise = ProgramExerciseInput.extend({
  program_day: z.string().min(1).max(60).describe("Program day name like 'legs 1' or its id"),
  position: z.int().min(1).max(30).optional().describe("1-based slot in the day; omit to add at the end"),
});

export const SetProgram = z.object({
  name: z.string().min(1).max(80),
  days: z.array(z.object({ name: z.string().min(1).max(60), exercises: z.array(ProgramExerciseInput).max(20) }))
    .min(1).max(14),
});

export const LogBodyweight = z.object({
  kg: z.number().gt(20).lt(400),
  measured_at: z.iso.datetime({ offset: true }).optional(),
});

export const UpdateEntry = z.object({
  table: z.enum(EDITABLE_TABLES),
  id: uuid,
  fields: z.record(z.string(), z.unknown()).refine((f) => Object.keys(f).length > 0, "fields is empty"),
  reason: z.string().min(1).max(300),
});

export const DeleteEntry = z.object({
  table: z.enum(EDITABLE_TABLES),
  id: uuid,
  reason: z.string().min(1).max(300),
});

export const COMPLETENESS = ["complete", "incomplete", "missed"] as const;

export const SetDayCompleteness = z.object({
  day,
  completeness: z.enum(COMPLETENESS).nullable()
    .describe("complete = whole day logged; incomplete = something missing, leave out of averages; missed = not logged; null clears it"),
  note: z.string().max(300).nullish(),
});
