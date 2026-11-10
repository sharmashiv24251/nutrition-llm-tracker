// The agent's tools: name, description, input schema (zod, sent to Gemini as JSON Schema), and handler.
// Handlers only call the data layer, which only touches trk_ tables through parameterised calls.
import type { FunctionDeclaration } from "@google/genai";
import { z } from "zod";
import type { DataLayer, Source } from "./data";
import type { Row } from "./store";
import type { Mode } from "./prompt";
import * as S from "./schemas";

export type ToolCtx = {
  data: DataLayer;
  /** The chat message that caused the call; absent for MCP clients, which keep their own conversation. */
  messageId?: string | null;
  /** Who is calling, recorded in the edit log (default "llm", the in-app chat). */
  source?: Source;
  /** Library foods saved from a label or the web during this turn (filled in by save_food). */
  freshFoodIds?: Set<string>;
  /** The web_search implementation (a separate grounded Gemini call); absent means the tool isn't offered. */
  search?: (query: string) => Promise<{ answer: string; sources: { uri: string; title?: string }[]; queries?: string[] }>;
};

type Tool<T extends z.ZodType = z.ZodType> = {
  name: string;
  /** In-app chat modes that get this tool; fewer declarations means fewer input tokens on every call. */
  modes?: Mode[];
  description: string;
  schema: T;
  run: (args: z.output<T>, ctx: ToolCtx) => Promise<unknown>;
};

const tool = <T extends z.ZodType>(t: Tool<T>) => t as unknown as Tool;

const llm = (ctx: ToolCtx) => ({ source: ctx.source ?? ("llm" as const), messageId: ctx.messageId ?? null });
/** Tools only MCP clients get: the in-app chats are for lifting and food, and each declaration costs them tokens. */
const MCP_ONLY: Mode[] = [];
const day = z.iso.date().describe("Logical day, YYYY-MM-DD");
const none = z.object({});

/** What's still missing from today's log, most worth asking first, phrased as things to ask me. */
function notLoggedToday(status: Row, wellness: Row, weighed: boolean): string[] {
  const out: string[] = [];
  const c = wellness.checkin;
  const scores = ["energy", "mood", "stress", "hunger"].filter((k) => c?.[k] == null);
  if (!c) out.push("check-in: energy, mood, stress and hunger (1 to 5) and how my skin looks");
  else if (scores.length || !c.skin) out.push(`rest of the check-in: ${[...scores, ...(c.skin ? [] : ["skin"])].join(", ")}`);
  if (!wellness.sleep) out.push("last night's sleep: bed time, wake time and how well I slept");
  if (!weighed) out.push("morning weight");
  const due = (wellness.routine as Row[]).filter((r) => !r.done).map((r) => r.name);
  if (due.length) out.push(`routine not ticked yet: ${due.join(", ")}`);
  if (!wellness.water.total_ml) out.push("water so far");
  if (!status.today_summary?.entries) out.push("what I've eaten so far");
  if (wellness.steps == null) out.push("step count (ask in the evening)");
  return out;
}

// Read tools work in both chats so any question can be answered anywhere. Write tools belong to their chat
// (food or workout) to keep each request's tool list, and so its input tokens, smaller.
export const TOOLS: Tool[] = [
  // ───────────── reading: days and history ─────────────
  tool({
    name: "get_status",
    description: "Returns now: the current time, today's and yesterday's logical day, days still open, today's food totals vs targets, the active workout session (if any), the active program and which program day is next in the rotation, today's water, activity, sleep, check-in and routine ticks, and not_logged_today: what I haven't told you yet today, for you to ask me about. Call it at the start of every conversation and before anything that depends on the date or on what's already logged today.",
    schema: none,
    run: async (_, { data, source }) => {
      const status = await data.getStatus();
      const wellness = await data.dayWellness(status.today);
      // Only MCP clients can log these, so only they are told what's missing.
      if (source !== "mcp") return { ...status, today_wellness: wellness };
      const weighed = await data.getEntries({ from: status.today, to: status.today, type: "bodyweight" });
      return { ...status, today_wellness: wellness, not_logged_today: notLoggedToday(status, wellness, weighed.length > 0) };
    },
  }),
  tool({
    name: "get_day_report",
    description: "Returns everything about one day: food by meal (each entry with grams, macros, confidence, assumptions) and totals vs targets, every workout session with sets grouped by exercise, the previous top set for each exercise trained, bodyweight, the day's status (complete/incomplete/missed) and its written recap, plus water vs target, activities and calories burned, steps, sleep, the check-in, measurements and which routine items were ticked.",
    schema: z.object({ day }),
    run: async (a, { data }) => {
      const [report, wellness] = await Promise.all([data.dayReport(a.day), data.dayWellness(a.day)]);
      return { ...report, wellness };
    },
  }),
  tool({
    name: "get_history",
    description: "Returns one row per day for the last N days (newest first): kcal, protein, carbs, fat and fibre totals, targets, food entry count, sessions and working sets, program day and exercises trained, bodyweight, status, whether the day counts toward averages, and the recap. Use for trends, averages and 'how was my week'.",
    schema: z.object({ days: z.int().min(1).max(60).default(14) }),
    run: (a, { data }) => data.history(a.days),
  }),
  tool({
    name: "get_entries",
    description: "Returns the raw rows (with ids) of one type between two days inclusive (max 62 days): food, sets, bodyweight, water, activity, measurement, sleep, checkin or routine. Use it to find the exact row before an edit or delete.",
    schema: S.DayRange,
    run: (a, { data }) => data.getEntries(a),
  }),
  tool({
    name: "get_day_summary",
    description: "Returns one day's food totals, targets and remaining amounts as computed by the database. Quote these instead of adding numbers yourself.",
    schema: z.object({ day }),
    run: (a, { data }) => data.getDaySummary(a.day),
  }),

  // ───────────── reading: training ─────────────
  tool({
    name: "get_program",
    description: "Returns the active plan: its days in rotation order, and for each day the prescribed exercises with ids, sets, rep range, working weight (min-max), load type, variation and notes.",
    schema: none,
    run: (_, { data }) => data.getProgram(),
  }),
  tool({
    name: "get_program_day",
    description: "Returns one program day ready for training: for each exercise the plan (sets, reps, weight, variation, notes), my notes on how I do it, the sets I've already done today, and my last sessions of that exercise with every set written out. Pass a day name like 'pull 2', or omit it for the next day in the rotation.",
    schema: S.PlanWorkout,
    run: (a, { data }) => data.programDay(a),
  }),
  tool({
    name: "get_exercise_history",
    description: "Returns every session of one exercise in the last N weeks, newest first, with all its sets (load, load type, reps, partials, rest-pause, variation, warm-up) and the top set per session.",
    schema: z.object({ exercise_id: z.uuid(), weeks: z.int().min(1).max(260).default(12) }),
    run: (a, { data }) => data.getExerciseHistory(a.exercise_id, a.weeks),
  }),
  tool({
    name: "list_exercises",
    description: "Returns the whole exercise catalog: name, other names, equipment, default load type, my notes on how I do it, sessions and working sets logged, last day trained and the variations used.",
    schema: none,
    run: (_, { data }) => data.exerciseLibrary(),
  }),
  tool({
    name: "find_exercise",
    description: "Fuzzy-matches a spoken exercise name (typos, plurals, word order) against the catalog. Returns the closest matches with ids, load type and notes, `best` when one is confidently the same exercise, and `extra_words` (grip, stance, 'weighted') that belong in variation.",
    schema: S.ExerciseQuery,
    run: (a, { data }) => data.findExercise(a),
  }),

  // ───────────── reading: food ─────────────
  tool({
    name: "find_food",
    description: "Fuzzy-matches a food against my saved library (name, other names, brand). Returns matches with per-100 g macros, serving size and source, and `best` when one is confidently the same food.",
    schema: S.FoodQuery,
    run: (a, { data }) => data.findFood(a),
  }),
  tool({
    name: "web_search",
    modes: ["food"],
    description: "Searches the web (a separate Google-grounded call) for nutrition facts of a branded or packaged item. Returns a short answer with per-100 g values and source URLs.",
    schema: z.object({ query: z.string().min(3).max(200) }),
    run: (a, ctx) => ctx.search!(a.query),
  }),

  // ───────────── writing: training ─────────────
  tool({
    name: "start_workout",
    modes: ["workout"],
    description: "Opens a session for a day (default today), tagged with a program day id. If one is open today it's reused (and tagged if it wasn't); one left open from an earlier day is closed first. Returns the session.",
    schema: S.StartWorkout,
    run: (a, ctx) => ctx.data.startWorkout(a, llm(ctx)),
  }),
  tool({
    name: "log_sets",
    modes: ["workout"],
    description: "Saves sets in the order performed (all sets from one message in one call). Omit session_id to use today's session, opening one tagged with program_day_id if needed. Returns the saved sets and the session so far.",
    schema: S.LogSets,
    run: (a, ctx) => ctx.data.logSets(a, llm(ctx)),
  }),
  tool({
    name: "end_workout",
    modes: ["workout"],
    description: "Closes a session. Returns its summary.",
    schema: z.object({ session_id: z.uuid() }),
    run: (a, { data }) => data.endWorkout(a.session_id),
  }),
  tool({
    name: "create_exercise",
    modes: ["workout"],
    description: "Adds an exercise to the catalog (optionally with notes on how I do it). Refuses and returns the close matches if a similar exercise exists, unless distinct_from names the one you judged different.",
    schema: S.CreateExercise,
    run: (a, { data }) => data.createExercise(a),
  }),
  tool({
    name: "update_exercise",
    modes: ["workout"],
    description: "Edits an exercise: rename (history kept, old name becomes another name), other names, equipment, default load type, or notes (append_note adds a line). Returns before and after.",
    schema: S.UpdateExercise,
    run: (a, ctx) => ctx.data.updateExercise(a, llm(ctx)),
  }),
  tool({
    name: "update_program_exercise",
    modes: ["workout"],
    description: "Edits one exercise slot in the plan by its id from get_program: swap the exercise (exercise_id), sets, rep_min, rep_max, target_load_kg, target_load_max_kg, load_type, variation, rest_s, note, order_index. Returns before and after. Remove a slot with delete_entry on trk_program_exercises.",
    schema: z.object({
      id: z.uuid().describe("program exercise id from get_program or get_program_day"),
      fields: z.record(z.string(), z.unknown()),
      reason: z.string().min(1).max(300),
    }),
    run: (a, ctx) => ctx.data.updateEntry({ table: "trk_program_exercises", ...a }, llm(ctx)),
  }),
  tool({
    name: "add_program_exercise",
    modes: ["workout"],
    description: "Adds an exercise to a program day (by name like 'legs 1'), at a position or at the end, with sets, rep range and working weight. Returns the new slot.",
    schema: S.AddProgramExercise,
    run: (a, ctx) => ctx.data.addProgramExercise(a, llm(ctx)),
  }),
  tool({
    name: "set_program",
    modes: ["workout"],
    description: "Replaces the active plan with a new one (days with their exercises). Old sessions keep their program day. Returns the new plan.",
    schema: S.SetProgram,
    run: (a, { data }) => data.setProgram(a),
  }),

  // ───────────── writing: food ─────────────
  tool({
    name: "save_food",
    modes: ["food"],
    description: "Adds a food to my library or updates it (same name and brand, or by id), per 100 g, with its source. Returns the saved food.",
    schema: S.SaveFood,
    run: async (a, ctx) => {
      const res = await ctx.data.saveFood(a, llm(ctx));
      if (a.source === "label_photo" || a.source === "web") ctx.freshFoodIds?.add(res.food.id);
      return res;
    },
  }),
  tool({
    name: "log_food",
    modes: ["food"],
    description: "Saves food entries to a day. With food_id the library's values are used; without it give kcal and macros as an estimate with assumptions. Quantity and unit (katori, roti, scoop…) are converted to grams. Returns the saved rows and the day's new totals.",
    schema: S.LogFood,
    run: (a, ctx) => ctx.data.logFood(a, { ...llm(ctx), freshFoodIds: ctx.freshFoodIds }),
  }),

  // ───────────── water, activity, body, sleep, check-ins ─────────────
  tool({
    name: "log_water",
    modes: MCP_ONLY,
    description: "Saves drinks toward the day's water: each glass or bottle, and the liquid in shakes, milk and electrolyte drinks. Returns the saved rows and the day's total against the water target.",
    schema: S.LogWater,
    run: (a, { data }) => data.logWater(a),
  }),
  tool({
    name: "log_activity",
    modes: MCP_ONLY,
    description: "Saves a walk, run, sport or other activity with duration, distance and calories burned. Lifting with sets goes to log_sets instead. Returns the row and the day's activity totals.",
    schema: S.LogActivity,
    run: (a, { data }) => data.logActivity(a),
  }),
  tool({
    name: "log_measurements",
    modes: MCP_ONLY,
    description: "Saves body or daily numbers other than bodyweight: body fat %, waist and other tape measurements, the day's step count, resting heart rate. Returns the saved rows.",
    schema: S.LogMeasurements,
    run: (a, { data }) => data.logMeasurements(a),
  }),
  tool({
    name: "log_sleep",
    modes: MCP_ONLY,
    description: "Saves last night's sleep against the day I woke up: bed time, wake time (or just hours) and quality. One night per day, so calling it again for the same day corrects it. Returns the row.",
    schema: S.LogSleep,
    run: (a, ctx) => ctx.data.logSleep(a, llm(ctx)),
  }),
  tool({
    name: "log_checkin",
    modes: MCP_ONLY,
    description: "Saves the day's check-in: energy, mood, stress and hunger (1 to 5) and how my skin looks. One per day; calling it again fills in or corrects the fields given. Returns the row.",
    schema: S.LogCheckin,
    run: (a, ctx) => ctx.data.logCheckin(a, llm(ctx)),
  }),
  tool({
    name: "get_trends",
    modes: MCP_ONLY,
    description: "Returns trends over the last N days: one row per day (weight, 7-day average weight, kcal, protein, water, sleep, steps, calories burned, check-in scores), weekly averages, the weight trend (this week's 7-day average vs last week's), the latest body measurements, and each routine item's streak. Use it for 'how's my weight going', weekly reviews and streaks.",
    schema: z.object({ days: z.int().min(7).max(180).default(30) }),
    run: (a, { data }) => data.trends(a.days),
  }),

  // ───────────── routines: supplements, skincare ─────────────
  tool({
    name: "get_routine",
    modes: MCP_ONLY,
    description: "Returns my routine items (supplements, skincare, other) with dose and schedule, and which are ticked off on a day (default today).",
    schema: z.object({ day: day.optional() }),
    run: (a, { data }) => data.routine(a.day),
  }),
  tool({
    name: "tick_routine",
    modes: MCP_ONLY,
    description: "Ticks routine items off for a day when I say I took or applied them. Names are fuzzy-matched; ticking something already done changes nothing. Returns what was ticked, anything not recognised, and what's still to do that day.",
    schema: S.TickRoutine,
    run: (a, { data }) => data.tickRoutine(a),
  }),
  tool({
    name: "save_routine_item",
    modes: MCP_ONLY,
    description: "Adds a supplement, skincare product or other daily habit to my routine, or updates one (same name, or by id): dose, schedule, other names, or active=false to retire it. Returns the item.",
    schema: S.SaveRoutineItem,
    run: (a, ctx) => ctx.data.saveRoutineItem(a, llm(ctx)),
  }),

  // ───────────── notes, decisions, targets ─────────────
  tool({
    name: "get_notes",
    modes: MCP_ONLY,
    description: "Returns what's been saved about me, newest first: my profile, goals, current plan, past decisions with their reasons, and other notes. Read it before giving advice so it fits what we already decided.",
    schema: S.GetNotes,
    run: (a, { data }) => data.getNotes(a),
  }),
  tool({
    name: "save_note",
    modes: MCP_ONLY,
    description: "Saves something worth remembering in later conversations: a fact about me (profile), a goal, the current plan, or a decision and why we made it. Pass id to rewrite an existing note rather than adding a near-duplicate. Returns the note.",
    schema: S.SaveNote,
    run: (a, ctx) => ctx.data.saveNote(a, llm(ctx)),
  }),
  tool({
    name: "set_targets",
    modes: MCP_ONLY,
    description: "Changes my daily targets from a day onward: kcal ceiling, protein and fibre floors, optional carbs and fat, and a water floor. Targets not given carry over. The reason is saved as a decision note. Only when I ask to change them. Returns the new targets and the previous values.",
    schema: S.SetTargets,
    run: (a, ctx) => ctx.data.setTargets(a, llm(ctx)),
  }),
  tool({
    name: "undo_edit",
    modes: MCP_ONLY,
    description: "Undoes an edit or delete made with update_entry or delete_entry: the most recent one, or the one with the given edit_id. Returns the restored row.",
    schema: z.object({ edit_id: z.uuid().optional() }),
    run: (a, ctx) => ctx.data.undoEdit(a.edit_id, ctx.source ?? "llm"),
  }),

  // ───────────── writing: both chats ─────────────
  tool({
    name: "log_bodyweight",
    description: "Saves a bodyweight reading in kg (measured_at defaults to now). Returns the row.",
    schema: S.LogBodyweight,
    run: (a, { data }) => data.logBodyweight(a),
  }),
  tool({
    name: "update_entry",
    description: "Edits one row by id (food entry, set, session, bodyweight, food, exercise, unit, program exercise, water, activity, measurement, sleep, check-in, routine item, note) and records it in the edit log. Changing only a food entry's grams or quantity recomputes its macros. Returns before and after.",
    schema: S.UpdateEntry,
    run: (a, ctx) => ctx.data.updateEntry(a, llm(ctx)),
  }),
  tool({
    name: "delete_entry",
    description: "Soft-deletes one row by id and records it in the edit log (undoable). Returns what was deleted. Un-tick a routine item by deleting its trk_routine_logs row (log_id in the day's routine).",
    schema: S.DeleteEntry,
    run: (a, ctx) => ctx.data.deleteEntry(a, llm(ctx)),
  }),
  tool({
    name: "set_day_completeness",
    description: "Marks a day complete, incomplete or missed, with an optional note, or clears it. Incomplete and missed days are left out of averages and charts.",
    schema: S.SetDayCompleteness,
    run: (a, ctx) => ctx.data.setDayCompleteness(a, llm(ctx)),
  }),
  tool({
    name: "end_day",
    description: "Closes a day. Logging to it later reopens it. Returns the day's totals.",
    schema: z.object({ day }),
    run: (a, { data }) => data.endDay(a.day),
  }),
];

function jsonSchema(schema: z.ZodType) {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  void _;
  return rest;
}

export function toolDeclarations(ctx: Pick<ToolCtx, "search">, mode?: Mode): FunctionDeclaration[] {
  return TOOLS.filter((t) => (t.name !== "web_search" || ctx.search) && (!mode || !t.modes || t.modes.includes(mode))).map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: jsonSchema(t.schema),
  }));
}

export type ToolResult = { ok: true; result: unknown } | { ok: false; error: string };

/** Validates and runs one tool call. Errors come back as data so the model can correct itself. */
export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const t = TOOLS.find((x) => x.name === name);
  if (!t || (name === "web_search" && !ctx.search)) return { ok: false, error: `unknown tool ${name}` };
  const parsed = t.schema.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, error: `invalid arguments: ${z.prettifyError(parsed.error)}` };
  try {
    return { ok: true, result: (await t.run(parsed.data, ctx)) ?? null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
