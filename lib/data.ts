// Server data layer: every read and write the agent tools and UI routes perform.
// Totals and summaries come from SQL functions; this layer resolves names, units and macros.
import { z } from "zod";
import { agentBrief, coachBrief, type BriefExercise } from "./coach";
import { CLOSE_MATCH, rank } from "./fuzzy";
import * as S from "./schemas";
import type { Row, Store, Table } from "./store";
import { macrosFor, resolveGrams, scaleMacros, type HouseholdUnit, type Macros, type Per100 } from "./units";

export type Source = "llm" | "ui";
type Ctx = {
  source?: Source;
  messageId?: string | null;
  /** Foods saved from a label photo or web search earlier in this same turn: logging them is "label". */
  freshFoodIds?: ReadonlySet<string>;
};

const MACRO_KEYS = ["kcal", "protein_g", "carbs_g", "fat_g", "fibre_g"] as const;

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

const foodNames = (f: Row) => [f.name, ...(f.aliases ?? []), ...(f.brand ? [`${f.brand} ${f.name}`] : [])];
const exerciseNames = (e: Row) => [e.name, ...(e.aliases ?? [])];

export function dataLayer(store: Store, opts: { now?: () => Date } = {}) {
  const now = () => opts.now?.() ?? new Date();
  const today = () => store.rpc<string>("trk_logical_day", { p_at: now().toISOString() });

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
            ...item, ...macrosFor(food, g.grams), grams: g.grams,
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

    async undoEdit(editId?: string) {
      return store.rpc<Row>("trk_undo_edit", { p_edit_id: editId ? z.uuid().parse(editId) : null, p_source: "ui" });
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
    if (food) return { ...patch, ...macrosFor(food, grams) };
  }
  if (Number(row.grams) > 0) {
    const current = Object.fromEntries(MACRO_KEYS.map((k) => [k, Number(row[k])])) as Macros;
    return { ...patch, ...scaleMacros(current, Number(row.grams), grams) };
  }
  return patch;
}

export type DataLayer = ReturnType<typeof dataLayer>;
