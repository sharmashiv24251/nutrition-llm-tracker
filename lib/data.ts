// Server data layer: every read and write the agent tools and UI routes perform.
// Totals and summaries come from SQL functions; this layer resolves names, units and macros.
import { z } from "zod";
import { agentBrief, coachBrief, type BriefExercise } from "./coach";
import { CLOSE_MATCH, rank } from "./fuzzy";
import * as S from "./schemas";
import type { Row, Store, Table } from "./store";
import { macrosFor, resolveGrams, round1, scaleMacros, type HouseholdUnit, type Macros, type Per100 } from "./units";

export type Source = "llm" | "ui" | "mcp";
type Ctx = {
  source?: Source;
  messageId?: string | null;
  /** Foods saved from a label photo or web search earlier in this same turn: logging them is "label". */
  freshFoodIds?: ReadonlySet<string>;
};

export type RecentFood = Per100 & {
  id: string;
  name: string;
  brand: string | null;
  aliases: string[];
  units: { name: string; g: number }[];
  last_used: string;
  times: number;
};

const MACRO_KEYS =["kcal", "protein_g", "carbs_g", "fat_g", "fibre_g"] as const;

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

const routineNames = (i: Row) => [i.name, ...(i.aliases ?? [])];
/** Sodium for `grams` of a library food, or null when its label value isn't saved. */
const sodiumFor = (food: Row, grams: number) =>
  food.sodium_mg_per_100g == null ? null : round1(Number(food.sodium_mg_per_100g) * grams / 100);
const foodNames = (f: Row) => [f.name, ...(f.aliases ?? []), ...(f.brand ? [`${f.brand} ${f.name}`] : [])];
const exerciseNames = (e: Row) => [e.name, ...(e.aliases ?? [])];

export function dataLayer(store: Store, opts: { now?: () => Date } = {}) {
  const now = () => opts.now?.() ?? new Date();
  const today = () => store.rpc<string>("trk_logical_day", { p_at: now().toISOString() });
  /** The logical day a moment falls in (default: now). */
  const logicalDay = (at?: string) => store.rpc<string>("trk_logical_day", { p_at: at ?? now().toISOString() });

  /** Inserts a row, or applies the given fields to the existing one through the edit log. */
  async function upsert(table: Table, existing: Row | undefined | null, fields: Row, reason: string, ctx: Ctx) {
    const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (!existing) return { action: "created" as const, row: await store.insert(table, patch) };
    const edit = await store.rpc<Row>("trk_apply_edit", {
      p_table: table, p_id: existing.id, p_fields: patch, p_reason: reason,
      p_source: ctx.source ?? "llm", p_message_id: ctx.messageId ?? null,
    });
    return { action: "updated" as const, row: edit.after as Row };
  }

  return {
    today,

    async getStatus(at?: Date) {
      return store.rpc<Row>("trk_status", { p_at: (at ?? now()).toISOString() });
    },

    async getDaySummary(day: string) {
      return store.rpc<Row>("trk_day_summary", { p_day: z.iso.date().parse(day) });
    },

    async getEntries(input: z.input<typeof S.DayRange>) {
      const { from, to, type } = S.DayRange.parse(input);
      return store.rpc<Row[]>("trk_get_entries", { p_from: from, p_to: to, p_type: type });
    },

    // ───────────── food ─────────────

    async findFood(input: z.input<typeof S.FoodQuery>) {
      const { query } = S.FoodQuery.parse(input);
      const foods = await store.list("trk_foods");
      const matches: Row[] = rank(query, foods, foodNames).map((m) => ({ ...m.item, score: m.score, matched: m.matched }));
      return { matches, best: matches[0] && matches[0].score >= CLOSE_MATCH ? matches[0] : null };
    },

    /** Library foods logged in the last `days` logical days, most recent first (the food chat's prompt list). */
    async recentFoods(days: number, at?: Date) {
      return store.rpc<RecentFood[]>("trk_recent_foods", {
        p_at: (at ?? now()).toISOString(), p_days: z.int().min(1).max(60).parse(days),
      });
    },

    async saveFood(input: z.input<typeof S.SaveFood>, ctx: Ctx = {}) {
      const { id, ...food } = S.SaveFood.parse(input);
      const existing = id
        ? await store.get("trk_foods", id)
        : (await store.list("trk_foods")).find(
            (f) => f.name.toLowerCase() === food.name.toLowerCase() &&
              (f.brand ?? "").toLowerCase() === (food.brand ?? "").toLowerCase(),
          );
      if (id && (!existing || existing.deleted_at)) throw new InputError(`food ${id} not found`);
      if (existing) {
        const edit = await store.rpc<Row>("trk_apply_edit", {
          p_table: "trk_foods", p_id: existing.id, p_fields: food, p_reason: "save_food update",
          p_source: ctx.source ?? "llm", p_message_id: ctx.messageId ?? null,
        });
        return { action: "updated" as const, food: edit.after };
      }
      return { action: "created" as const, food: await store.insert("trk_foods", food) };
    },

    async logFood(input: z.input<typeof S.LogFood>, ctx: Ctx = {}) {
      const { day, items } = S.LogFood.parse(input);
      const units = await store.list<HouseholdUnit>("trk_household_units");
      const resolved = [];
      for (const [i, item] of items.entries()) {
        const where = `item ${i + 1} (${item.display_name})`;
        if (item.food_id) {
          const food = await store.get<Row & Per100>("trk_foods", item.food_id);
          if (!food || food.deleted_at) throw new InputError(`${where}: food ${item.food_id} not found`);
          const g = resolveGrams(item, units, food);
          if (g.grams === null) throw new InputError(`${where}: can't convert "${item.quantity ?? ""} ${item.unit ?? ""}" to grams; ask for grams`);
          resolved.push({
            ...item, ...macrosFor(food, g.grams), sodium_mg: sodiumFor(food, g.grams), grams: g.grams,
            confidence: item.confidence ?? (ctx.freshFoodIds?.has(food.id) ? "label" : "saved"), grams_method: g.method,
          });
        } else {
          if (item.kcal == null) throw new InputError(`${where}: kcal is required when food_id is not set`);
          const g = resolveGrams(item, units);
          resolved.push({
            ...item, grams: g.grams, confidence: item.confidence ?? "estimate", grams_method: g.method,
            protein_g: item.protein_g ?? 0, carbs_g: item.carbs_g ?? 0, fat_g: item.fat_g ?? 0, fibre_g: item.fibre_g ?? 0,
          });
        }
      }
      const res = await store.rpc<Row>("trk_log_food", {
        p_day: day,
        p_items: resolved.map(({ grams_method, ...r }) => (void grams_method, r)),
        p_message_id: ctx.messageId ?? null,
        p_source: ctx.source ?? "llm",
      });
      return Object.assign(res, { grams_methods: resolved.map((r) => r.grams_method) });
    },

    // ───────────── workouts ─────────────

    async findExercise(input: z.input<typeof S.ExerciseQuery>) {
      const { query } = S.ExerciseQuery.parse(input);
      const exercises = await store.list("trk_exercises");
      const matches = rank(query, exercises, exerciseNames).map((m) => ({
        id: m.item.id, name: m.item.name, default_load_type: m.item.default_load_type, equipment: m.item.equipment,
        notes: m.item.notes ?? null, score: m.score, matched: m.matched,
        // words in the query that aren't part of the name: grip, stance, "weighted", ...
        extra_words: m.leftover.join(" ") || null,
      }));
      return { matches, best: matches[0] && matches[0].score >= CLOSE_MATCH ? matches[0] : null };
    },

    async createExercise(input: z.input<typeof S.CreateExercise>) {
      const { distinct_from, ...ex } = S.CreateExercise.parse(input);
      const exercises = await store.list("trk_exercises");
      const close = [ex.name, ...ex.aliases]
        .flatMap((n) => rank(n, exercises, exerciseNames, 3))
        .filter((m) => m.score >= CLOSE_MATCH && m.item.id !== distinct_from)
        .sort((a, b) => b.score - a.score);
      if (close.length) {
        return {
          created: false as const,
          reason: "a close match already exists; log against it, or pass distinct_from with its id if it really is different",
          existing: close.map((m) => ({ id: m.item.id, name: m.item.name, score: m.score })),
        };
      }
      if (exercises.some((e) => e.name.toLowerCase() === ex.name.toLowerCase())) {
        throw new InputError(`an exercise named "${ex.name}" already exists`);
      }
      return { created: true as const, exercise: await store.insert("trk_exercises", ex) };
    },

    /**
     * Renames or edits an exercise. All sets keep pointing at it, so history is untouched; a renamed
     * exercise keeps its old name as an alias so the way I used to say it still matches.
     */
    async updateExercise(input: z.input<typeof S.UpdateExercise>, ctx: Ctx = {}) {
      const { id, add_aliases, append_note, ...fields } = S.UpdateExercise.parse(input);
      const current = await store.get("trk_exercises", id);
      if (!current || current.deleted_at) throw new InputError(`exercise ${id} not found`);
      const patch: Row = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

      if (patch.name && patch.name.toLowerCase() !== current.name.toLowerCase()) {
        const others = await store.list("trk_exercises");
        if (others.some((e) => e.id !== id && e.name.toLowerCase() === patch.name.toLowerCase())) {
          throw new InputError(`another exercise is already called "${patch.name}"`);
        }
      }
      const renamedFrom = patch.name && patch.name !== current.name ? [current.name] : [];
      if (patch.aliases || add_aliases || renamedFrom.length) {
        const seen = new Set<string>();
        const newName = (patch.name ?? current.name).toLowerCase();
        patch.aliases = [...(patch.aliases ?? current.aliases ?? []), ...(add_aliases ?? []), ...renamedFrom]
          .filter((a: string) => {
            const k = a.toLowerCase();
            if (k === newName || seen.has(k)) return false;
            seen.add(k);
            return true;
          });
      }
      if (append_note) {
        const base = (patch.notes !== undefined ? patch.notes : current.notes) ?? "";
        patch.notes = (base ? `${base.trimEnd()}\n` : "") + append_note;
        if (patch.notes.length > 2000) throw new InputError("notes would be over 2000 characters; replace them instead");
      }
      if (!Object.keys(patch).length) throw new InputError("nothing to change");
      return store.rpc<Row>("trk_apply_edit", {
        p_table: "trk_exercises", p_id: id, p_fields: patch,
        p_reason: renamedFrom.length ? `renamed from ${current.name}` : "exercise edited",
        p_source: ctx.source ?? "llm", p_message_id: ctx.messageId ?? null,
      });
    },

    async exerciseLibrary() {
      return store.rpc<Row[]>("trk_exercise_library", {});
    },

    async startWorkout(input: z.input<typeof S.StartWorkout> = {}, ctx: Ctx = {}) {
      const { day, program_day_id } = S.StartWorkout.parse(input);
      return store.rpc<Row>("trk_start_workout", {
        p_day: day ?? (await today()), p_program_day_id: program_day_id ?? null,
        p_source: ctx.source ?? "llm", p_message_id: ctx.messageId ?? null,
      });
    },

    async endWorkout(sessionId: string) {
      return store.rpc<Row>("trk_end_workout", { p_session_id: z.uuid().parse(sessionId) });
    },

    async logSets(input: z.input<typeof S.LogSets>, ctx: Ctx = {}) {
      const { session_id, program_day_id, sets } = S.LogSets.parse(input);
      for (const [i, s] of sets.entries()) {
        if (s.load_type !== "bodyweight_only" && s.load_kg == null) {
          throw new InputError(`set ${i + 1}: load_kg is required for load_type ${s.load_type} (use 0 for plain bodyweight with "added")`);
        }
      }
      // trk_start_workout returns the active session when one is open, so this never opens a second one.
      const session = session_id ?? (await store.rpc<Row>("trk_start_workout", {
        p_day: await today(), p_program_day_id: program_day_id ?? null, p_source: ctx.source ?? "llm",
        p_message_id: ctx.messageId ?? null,
      })).session.id;
      return store.rpc<Row>("trk_log_sets", {
        p_session_id: session, p_sets: sets, p_message_id: ctx.messageId ?? null, p_source: ctx.source ?? "llm",
      });
    },

    async getSessionSummary(sessionId: string) {
      return store.rpc<Row | null>("trk_session_summary", { p_session_id: z.uuid().parse(sessionId) });
    },

    async getExerciseHistory(exerciseId: string, weeks = 8) {
      return store.rpc<Row>("trk_exercise_history", {
        p_exercise_id: z.uuid().parse(exerciseId), p_weeks: z.int().min(1).max(260).parse(weeks),
      });
    },

    async getProgram() {
      return store.rpc<Row | null>("trk_get_program", {});
    },

    /** Resolves "pull 2", an id, or nothing (today's day in the rotation) to a program day of the active plan. */
    async resolveProgramDay(nameOrId?: string) {
      const program = await store.rpc<Row | null>("trk_get_program", {});
      if (!program) throw new InputError("there is no active program; set one up first");
      const days = program.days as Row[];
      if (!nameOrId) {
        const status = await store.rpc<Row>("trk_status", { p_at: now().toISOString() });
        const next = status.today_program_day ?? null;
        return { program, day: days.find((d) => d.id === next?.id) ?? days[0], source: next?.source ?? "first" };
      }
      const byId = days.find((d) => d.id === nameOrId);
      if (byId) return { program, day: byId, source: "asked" };
      const match = rank(nameOrId, days, (d) => [d.name])[0];
      if (!match || match.score < CLOSE_MATCH) {
        throw new InputError(`no program day called "${nameOrId}"; days are ${days.map((d) => d.name).join(", ")}`);
      }
      return { program, day: match.item, source: "asked" };
    },

    /**
     * The trainer view of one program day: the plan per exercise, what's done today, recent sessions, the next
     * suggested weight and reps, and whether each exercise is progressing.
     */
    async planWorkout(input: z.input<typeof S.PlanWorkout> = {}) {
      const { program_day } = S.PlanWorkout.parse(input);
      const { program, day, source } = await this.resolveProgramDay(program_day);
      const brief = await store.rpc<{ program_day: { id: string; name: string; program: string }; today: string; exercises: BriefExercise[] }>(
        "trk_program_day_brief", { p_program_day_id: day.id, p_at: now().toISOString() });
      const order = (program.days as Row[]).map((d) => d.name);
      return { ...coachBrief(brief), chosen_because: source, rotation: order };
    },

    /** One program day for the AI: plan, today's sets and recent sessions per exercise, as data only. */
    async programDay(input: z.input<typeof S.PlanWorkout> = {}) {
      const { program_day } = S.PlanWorkout.parse(input);
      const { program, day, source } = await this.resolveProgramDay(program_day);
      const brief = await store.rpc<{ program_day: { id: string; name: string; program: string }; today: string; exercises: BriefExercise[] }>(
        "trk_program_day_brief", { p_program_day_id: day.id, p_at: now().toISOString() });
      return {
        ...agentBrief(brief),
        chosen_because: source === "asked" ? "you asked for this day" : "next in the rotation",
        rotation: (program.days as Row[]).map((d) => d.name),
      };
    },

    async addProgramExercise(input: z.input<typeof S.AddProgramExercise>, ctx: Ctx = {}) {
      const { program_day, position, ...fields } = S.AddProgramExercise.parse(input);
      const { day } = await this.resolveProgramDay(program_day);
      const existing = (day.exercises as Row[]).sort((a, b) => a.order_index - b.order_index);
      const slot = Math.min(position ?? existing.length + 1, existing.length + 1);
      // make room: shift later exercises down one, logged like any other edit
      for (const pe of existing.filter((e) => e.order_index >= slot).reverse()) {
        await store.rpc("trk_apply_edit", {
          p_table: "trk_program_exercises", p_id: pe.id, p_fields: { order_index: pe.order_index + 1 },
          p_reason: `made room for a new exercise in ${day.name}`, p_source: ctx.source ?? "llm", p_message_id: ctx.messageId ?? null,
        });
      }
      const row = await store.insert("trk_program_exercises", { ...fields, program_day_id: day.id, order_index: slot });
      return { program_day: day.name, added: row };
    },

    async setProgram(input: z.input<typeof S.SetProgram>) {
      const { name, days } = S.SetProgram.parse(input);
      return store.rpc<Row>("trk_set_program", { p_name: name, p_days: days });
    },

    async logBodyweight(input: z.input<typeof S.LogBodyweight>) {
      const { kg, measured_at } = S.LogBodyweight.parse(input);
      const at = measured_at ?? now().toISOString();
      const day = await store.rpc<string>("trk_logical_day", { p_at: at });
      return store.insert("trk_bodyweight", { kg, measured_at: at, day });
    },

    // ───────────── water, activity, body, sleep, check-ins ─────────────

    /** Everything logged on a day outside food and lifting: water, activity, sleep, check-in, measurements, routine. */
    async dayWellness(day: string) {
      return store.rpc<Row>("trk_day_wellness", { p_day: z.iso.date().parse(day) });
    },

    async trends(days = 30) {
      return store.rpc<Row>("trk_trends", { p_days: z.int().min(7).max(180).parse(days), p_at: now().toISOString() });
    },

    async logWater(input: z.input<typeof S.LogWater>) {
      const { day, drinks } = S.LogWater.parse(input);
      const logged = [];
      let last = day ?? (await today());
      for (const d of drinks) {
        last = day ?? (await logicalDay(d.drunk_at));
        logged.push(await store.insert("trk_water", { ...d, drunk_at: d.drunk_at ?? now().toISOString(), day: last }));
      }
      return { logged, day: last, water: (await this.dayWellness(last)).water };
    },

    async logActivity(input: z.input<typeof S.LogActivity>) {
      const { day, ...activity } = S.LogActivity.parse(input);
      const d = day ?? (await logicalDay(activity.started_at));
      const row = await store.insert("trk_activities", { ...activity, day: d });
      const w = await this.dayWellness(d);
      return { activity: row, day: d, activities_today: w.activities.length, active_kcal_today: w.active_kcal };
    },

    async logMeasurements(input: z.input<typeof S.LogMeasurements>) {
      const { day, measured_at, readings } = S.LogMeasurements.parse(input);
      const at = measured_at ?? now().toISOString();
      const d = day ?? (await logicalDay(at));
      const logged = [];
      for (const r of readings) logged.push(await store.insert("trk_measurements", { ...r, measured_at: at, day: d }));
      return { logged, day: d };
    },

    /** One night per day: logging again for the same day corrects it. */
    async logSleep(input: z.input<typeof S.LogSleep>, ctx: Ctx = {}) {
      const { day, ...sleep } = S.LogSleep.parse(input);
      const d = day ?? (await logicalDay(sleep.wake_at));
      if (sleep.bed_at && sleep.wake_at) {
        const h = (Date.parse(sleep.wake_at) - Date.parse(sleep.bed_at)) / 3_600_000;
        if (h <= 0 || h > 24) throw new InputError("wake_at must be after bed_at, and within 24 hours of it");
        sleep.hours ??= Math.round(h * 100) / 100;
      }
      const existing = (await store.list("trk_sleep")).find((r) => r.day === d);
      if (!existing && sleep.hours == null) throw new InputError("give hours, or both bed_at and wake_at");
      return { day: d, ...(await upsert("trk_sleep", existing, { ...sleep, day: d }, "sleep corrected", ctx)) };
    },

    /** One check-in per day: logging again fills in or corrects the same one. */
    async logCheckin(input: z.input<typeof S.LogCheckin>, ctx: Ctx = {}) {
      const { day, ...checkin } = S.LogCheckin.parse(input);
      if (!Object.values(checkin).some((v) => v !== undefined)) throw new InputError("nothing to save");
      const d = day ?? (await today());
      const existing = (await store.list("trk_checkins")).find((r) => r.day === d);
      return { day: d, ...(await upsert("trk_checkins", existing, { ...checkin, day: d }, "check-in updated", ctx)) };
    },

    // ───────────── routines (supplements, skincare) ─────────────

    async routine(day?: string) {
      const d = day ?? (await today());
      return { day: d, items: (await this.dayWellness(d)).routine as Row[] };
    },

    async saveRoutineItem(input: z.input<typeof S.SaveRoutineItem>, ctx: Ctx = {}) {
      const { id, ...item } = S.SaveRoutineItem.parse(input);
      const items = await store.list("trk_routine_items");
      const existing = id ? items.find((i) => i.id === id) : items.find((i) => i.name.toLowerCase() === item.name.toLowerCase());
      if (id && !existing) throw new InputError(`routine item ${id} not found`);
      return upsert("trk_routine_items", existing, item, "routine item edited", ctx);
    },

    /** Ticks items off for a day. Ticking one that's already done changes nothing. */
    async tickRoutine(input: z.input<typeof S.TickRoutine>) {
      const { day, items: asked, all_of_kind } = S.TickRoutine.parse(input);
      if (!asked.length && !all_of_kind) throw new InputError("give items or all_of_kind");
      const d = day ?? (await today());
      const items = (await store.list("trk_routine_items")).filter((i) => i.active);
      const wanted = new Map<string, Row>();
      const not_found: string[] = [];
      for (const q of asked) {
        const hit = items.find((i) => i.id === q) ?? rank(q, items, routineNames)[0];
        const item = hit && "item" in hit ? (hit.score >= CLOSE_MATCH ? hit.item : null) : hit;
        if (item) wanted.set(item.id, item);
        else not_found.push(q);
      }
      if (all_of_kind) for (const i of items.filter((i) => i.kind === all_of_kind)) wanted.set(i.id, i);

      const done = new Set((await store.list("trk_routine_logs")).filter((l) => l.day === d).map((l) => l.item_id));
      const ticked: string[] = [];
      const already_done: string[] = [];
      for (const item of wanted.values()) {
        if (done.has(item.id)) already_done.push(item.name);
        else {
          await store.insert("trk_routine_logs", { item_id: item.id, day: d, done_at: now().toISOString() });
          ticked.push(item.name);
        }
      }
      const routine = (await this.dayWellness(d)).routine as Row[];
      return {
        day: d, ticked, already_done, not_found,
        ...(not_found.length ? { known_items: items.map((i) => i.name) } : {}),
        still_to_do: routine.filter((r) => !r.done).map((r) => r.name),
      };
    },

    // ───────────── notes and targets ─────────────

    async getNotes(input: z.input<typeof S.GetNotes> = {}) {
      const { kind } = S.GetNotes.parse(input);
      return (await store.list("trk_notes"))
        .filter((n) => !kind || n.kind === kind)
        .map(({ id, kind, title, body, day, updated_at }) => ({ id, kind, title, body, day, updated_at }))
        .reverse();
    },

    async saveNote(input: z.input<typeof S.SaveNote>, ctx: Ctx = {}) {
      const { id, day, ...note } = S.SaveNote.parse(input);
      const existing = id ? await store.get("trk_notes", id) : undefined;
      if (id && (!existing || existing.deleted_at)) throw new InputError(`note ${id} not found`);
      return upsert("trk_notes", existing, { ...note, ...(day || !existing ? { day: day ?? (await today()) } : {}) }, "note rewritten", ctx);
    },

    /** New targets from a day onward (unchanged ones carry over), with the reason kept as a decision note. */
    async setTargets(input: z.input<typeof S.SetTargets>, ctx: Ctx = {}) {
      const { effective_from, reason, ...given } = S.SetTargets.parse(input);
      const changes = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined));
      if (!Object.keys(changes).length) throw new InputError("no target given");
      const from = effective_from ?? (await today());
      const all = (await store.list("trk_targets")).sort((a, b) => a.effective_from.localeCompare(b.effective_from));
      const before = all.filter((t) => t.effective_from <= from).at(-1);
      const sameDay = before?.effective_from === from ? before : undefined;
      const keys = ["kcal", "protein_g", "fibre_g", "carbs_g", "fat_g", "water_ml"];
      const merged = { ...Object.fromEntries(keys.map((k) => [k, before?.[k] ?? null])), ...changes };
      for (const k of ["kcal", "protein_g", "fibre_g"]) {
        if (merged[k] == null) throw new InputError(`${k} is required: there are no earlier targets to carry it over from`);
      }
      const targets = sameDay
        ? (await store.rpc<Row>("trk_apply_edit", {
            p_table: "trk_targets", p_id: sameDay.id, p_fields: changes, p_reason: reason,
            p_source: ctx.source ?? "llm", p_message_id: ctx.messageId ?? null,
          })).after
        : await store.insert("trk_targets", { ...merged, effective_from: from });
      const was = before ? Object.fromEntries(Object.keys(changes).map((k) => [k, before[k] ?? null])) : null;
      const note = await store.insert("trk_notes", {
        kind: "decision", day: from, title: `Targets changed: ${Object.keys(changes).join(", ")}`,
        body: `${reason}\nNow: ${JSON.stringify(changes)}${was ? `\nBefore: ${JSON.stringify(was)}` : ""}`,
      });
      return { targets, previous: was, decision_note_id: note.id };
    },

    // ───────────── edits ─────────────

    async updateEntry(input: z.input<typeof S.UpdateEntry>, ctx: Ctx = {}) {
      const { table, id, fields, reason } = S.UpdateEntry.parse(input);
      const patch = table === "trk_food_entries" ? await foodEntryPatch(store, id, fields) : fields;
      return store.rpc<Row>("trk_apply_edit", {
        p_table: table, p_id: id, p_fields: patch, p_reason: reason,
        p_source: ctx.source ?? "llm", p_message_id: ctx.messageId ?? null,
      });
    },

    async deleteEntry(input: z.input<typeof S.DeleteEntry>, ctx: Ctx = {}) {
      const { table, id, reason } = S.DeleteEntry.parse(input);
      return store.rpc<Row>("trk_soft_delete", {
        p_table: table, p_id: id, p_reason: reason, p_source: ctx.source ?? "llm", p_message_id: ctx.messageId ?? null,
      });
    },

    async undoEdit(editId?: string, source: Source = "ui") {
      return store.rpc<Row>("trk_undo_edit", { p_edit_id: editId ? z.uuid().parse(editId) : null, p_source: source });
    },

    async endDay(day: string) {
      return store.rpc<Row>("trk_end_day", { p_day: z.iso.date().parse(day) });
    },

    async list(table: Table) {
      return store.list(table);
    },

    // ───────────── days ─────────────

    async dayReport(day: string) {
      return store.rpc<Row>("trk_day_report", { p_day: z.iso.date().parse(day) });
    },

    async history(days = 30) {
      return store.rpc<Row[]>("trk_history", { p_days: z.int().min(1).max(366).parse(days), p_at: now().toISOString() });
    },

    async setDayCompleteness(input: z.input<typeof S.SetDayCompleteness>, ctx: Ctx = {}) {
      const { day, completeness, note } = S.SetDayCompleteness.parse(input);
      return store.rpc<Row>("trk_set_day_completeness", {
        p_day: day, p_completeness: completeness, p_note: note ?? null,
        p_source: ctx.source ?? "llm", p_message_id: ctx.messageId ?? null,
      });
    },

    // ───────────── settings page ─────────────

    async editSetting(table: (typeof S.SETTINGS_TABLES)[number], id: string, fields: Row) {
      z.enum(S.SETTINGS_TABLES).parse(table);
      return store.rpc<Row>("trk_apply_edit", {
        p_table: table, p_id: z.uuid().parse(id), p_fields: fields, p_reason: "edited in settings", p_source: "ui",
        p_message_id: null,
      });
    },

    async addSetting(table: "trk_targets" | "trk_household_units" | "trk_pricing", row: Row) {
      return store.insert(table, row);
    },
  };
}

/**
 * When a food entry's amount changes without new macros, recompute them so the numbers stay consistent:
 * library foods from their per-100 g values, estimates scaled by weight. A changed quantity in a
 * household unit ("2 katori not 1.5") converts to grams first.
 */
async function foodEntryPatch(store: Store, id: string, fields: Record<string, unknown>) {
  const touchesMacros = MACRO_KEYS.some((k) => k in fields);
  if (touchesMacros || !("grams" in fields || "quantity" in fields)) return fields;

  const row = await store.get("trk_food_entries", id);
  if (!row || row.deleted_at) throw new InputError(`food entry ${id} not found`);
  const patch: Record<string, unknown> = { ...fields };

  let grams = typeof fields.grams === "number" ? fields.grams : null;
  if (grams === null && typeof fields.quantity === "number") {
    const units = await store.list<HouseholdUnit>("trk_household_units");
    const food = row.food_id ? await store.get("trk_foods", row.food_id) : null;
    const g = resolveGrams({ quantity: fields.quantity, unit: (fields.unit as string) ?? row.unit, food_id: row.food_id }, units, food);
    if (g.method === "unknown" || g.method === "given") {
      if (row.unit && row.grams && Number(row.quantity) > 0) {
        grams = (Number(row.grams) / Number(row.quantity)) * fields.quantity; // same unit, same size per unit
      }
    } else {
      grams = g.grams;
    }
    if (grams !== null) patch.grams = Math.round(grams * 10) / 10;
  }
  if (grams === null) return patch;

  if (row.food_id) {
    const food = await store.get<Row & Per100>("trk_foods", row.food_id);
    if (food) return { ...patch, ...macrosFor(food, grams), ...("sodium_mg" in fields ? {} : { sodium_mg: sodiumFor(food, grams) }) };
  }
  if (Number(row.grams) > 0) {
    const current = Object.fromEntries(MACRO_KEYS.map((k) => [k, Number(row[k])])) as Macros;
    const sodium = row.sodium_mg == null || "sodium_mg" in fields ? {} : { sodium_mg: round1(Number(row.sodium_mg) * grams / Number(row.grams)) };
    return { ...patch, ...scaleMacros(current, Number(row.grams), grams), ...sodium };
  }
  return patch;
}

export type DataLayer = ReturnType<typeof dataLayer>;
