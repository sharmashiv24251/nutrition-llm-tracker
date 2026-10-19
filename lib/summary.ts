// The nightly day write-up: the structured report from SQL plus a short prose recap written by Gemini.
// The model only phrases the database's numbers; it is told not to compute new totals.
import { formatSet, type SetLike } from "./format";
import type { Model, ModelTurn } from "./llm";
import { costOf, priceAt, type PriceRow } from "./pricing";
import type { Row, Store } from "./store";

export class SpendCapReached extends Error {}

const SUMMARY_PROMPT = `You write the end-of-day recap in my personal training and food log. You get one day's data
as JSON from my database. Write 50-110 words of plain prose, second person ("You..."), at most two short
paragraphs: training first (what I trained, notable sets, and how the top set compares with "last_time" when
given), then food (kcal against the target, which is a ceiling; protein and fibre against their floors).
Rules:
- I read this the next morning or later, so refer to the day by its weekday or as "this day", never "today".
- Use only numbers that appear in the data. Never add up or derive new totals; nutrition.totals and
  nutrition.remaining are already computed.
- Sets are already written out (e.g. "+17.5 kg x 5 + 1 partial", "40 kg/side x 9", "12.5 kg each x 11");
  copy them character for character. Dumbbell loads are "kg each", never "kg/hand" or "kg/side".
- If completeness is "incomplete" or "missed", say so in the first sentence and keep it short.
- If there was no workout, say it was a rest day only if nothing suggests otherwise.
- At most one short, concrete suggestion, and only if a target was clearly missed.
- Plain text. No markdown, no lists, no emojis, no headings.`;

export type SummaryDeps = { store: Store; model: Model; capUsd: number; now?: () => Date };

type Spend = { total_usd: number };

// The model copies plain "x" reliably; with "×" it rewrites the whole set.
const ascii = (set: string) => set.replace(/×/g, "x");

/** Strips ids and noise so the prompt stays small. */
function compact(report: Row) {
  // Sets go in pre-formatted by the app's own formatter, so units ("kg each", "kg/side") are never improvised.
  const previous = report.previous_top_sets as Record<string, SetLike & { day: string }>;
  const sessions = (report.workouts as Row[]).map((w) => ({
    program_day: w.session?.program_day ?? null,
    exercises: (w.exercises as Row[]).map((e) => ({
      name: e.name,
      sets: (e.sets as Row[]).map((s) => ascii(formatSet(s as SetLike)) + (s.variation ? ` (${s.variation})` : "")),
      last_time: previous[e.exercise_id]
        ? `${ascii(formatSet(previous[e.exercise_id]))} on ${previous[e.exercise_id].day}` : undefined,
    })),
  }));
  return {
    day: report.day,
    completeness: report.completeness,
    completeness_note: report.completeness_note,
    nutrition: {
      totals: report.nutrition?.totals, targets: report.nutrition?.targets, remaining: report.nutrition?.remaining,
    },
    meals: (report.meals as Row[]).map((m) => ({
      meal: m.meal, kcal: m.kcal, protein_g: m.protein_g,
      items: (m.items as Row[]).map((i) => `${i.display_name}${i.grams != null ? ` ${i.grams} g` : ""}`),
    })),
    workouts: sessions,
    bodyweight: report.bodyweight,
  };
}

function hasData(report: Row) {
  return (report.meals as Row[]).length > 0 || (report.workouts as Row[]).length > 0 || (report.bodyweight as Row[]).length > 0;
}

/** Writes (or rewrites) one day's summary. Returns the saved row. */
export async function summarizeDay(day: string, source: "cron" | "manual", deps: SummaryDeps): Promise<Row> {
  const { store, model, capUsd } = deps;
  const clock = () => deps.now?.() ?? new Date();
  const report = await store.rpc<Row>("trk_day_report", { p_day: day });
  if (!hasData(report)) {
    return store.rpc<Row>("trk_save_day_summary", {
      p_day: day, p_prose: "Nothing was logged on this day.", p_structured: report, p_model: null, p_source: source,
    });
  }

  const spend = await store.rpc<Spend>("trk_spend_today", { p_at: clock().toISOString() });
  if (spend.total_usd >= capUsd) throw new SpendCapReached(`Daily spend cap of $${capUsd.toFixed(2)} reached`);
  const price = priceAt(await store.list<PriceRow>("trk_pricing"), model.name, clock());
  if (!price) throw new Error(`No trk_pricing row for ${model.name}`);

  const started = Date.now();
  const turn: ModelTurn = await model.generate({
    system: SUMMARY_PROMPT,
    contents: [{ role: "user", parts: [{ text: JSON.stringify(compact(report)) }] }],
  });
  const cost = costOf(turn.usage, turn.searchQueries.length, price);
  await store.insert("trk_llm_calls", {
    message_id: null, purpose: "summary", round: null, model: turn.model, pricing_id: price.id,
    input_tokens: turn.usage.input + turn.usage.toolUse, output_tokens: turn.usage.output,
    thinking_tokens: turn.usage.thinking, cached_tokens: turn.usage.cached, search_queries: 0,
    token_cost_usd: cost.token_usd, search_cost_usd: cost.search_usd, latency_ms: Date.now() - started,
    created_at: clock().toISOString(),
  });

  const prose = turn.text.trim() || "Summary unavailable.";
  return store.rpc<Row>("trk_save_day_summary", {
    p_day: day, p_prose: prose, p_structured: report, p_model: turn.model, p_source: source,
  });
}

/** The nightly job: summarise every finished day from the last week that has logs but no summary. */
export async function summarizePending(deps: SummaryDeps, lookbackDays = 7) {
  const now = (deps.now?.() ?? new Date()).toISOString();
  const days = await deps.store.rpc<string[]>("trk_days_to_summarize", { p_lookback: lookbackDays, p_at: now });
  const results: { day: string; ok: boolean; error?: string }[] = [];
  for (const day of days) {
    try {
      await summarizeDay(day, "cron", deps);
      results.push({ day, ok: true });
    } catch (e) {
      results.push({ day, ok: false, error: e instanceof Error ? e.message : String(e) });
      if (e instanceof SpendCapReached) break;
    }
  }
  return { days, results };
}
