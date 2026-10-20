// POST /api/chat logic, framework-free so tests can run it against a local database and a scripted model.
import { PartMediaResolutionLevel, type Content, type Part } from "@google/genai";
import { runAgent, type ToolLog } from "./agent";
import type { DataLayer } from "./data";
import type { Model, ModelTurn } from "./llm";
import { costOf, priceAt, type PriceRow } from "./pricing";
import { RECENT_FOOD_DAYS, systemPrompt, type Mode } from "./prompt";
import type { Row, Store } from "./store";
import type { ToolCtx } from "./tools";

export type ChatInput = {
  mode: Mode;
  text: string;
  image?: { mime_type: string; data: string }; // base64
  client_message_id: string;
};

export type ChatDeps = {
  store: Store;
  data: DataLayer;
  model: Model;
  capUsd: number;
  now?: () => Date;
};

export type ChatResponse = { status: number; body: Row };

type Spend = { day: string; token_usd: number; search_usd: number; total_usd: number; calls: number };

class SpendCapError extends Error {}

export const capMessage = (cap: number) =>
  `Today's Gemini spend has reached the $${cap.toFixed(2)} daily cap, so I can't answer until tomorrow. The log views still work.`;

// Gemini 3 bills an image by this level, not its pixels: low 252, medium 546, high 1073 tokens. In a test with
// a small, tilted nutrition label, low invented values and medium misread one in four runs; high read every
// run correctly. A misread label is saved to the library and reused, so the extra ~$0.0004 per round is worth it.
export const IMAGE_RESOLUTION = PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH;

const SEARCH_PROMPT = `You look up nutrition facts on the web. Answer in at most 6 short lines: product and brand,
then kcal, protein, carbs, fat and fibre per 100 g (convert from per-serving values and say so), then the serving
size if listed. If sources disagree, say which you used. Plain text only.`;

export async function handleChat(input: ChatInput, deps: ChatDeps): Promise<ChatResponse> {
  const { store, data, model, capUsd } = deps;
  const clock = () => deps.now?.() ?? new Date();
  const now = clock();
  const spendNow = () => store.rpc<Spend>("trk_spend_today", { p_at: clock().toISOString() });

  // A retried request returns the first result instead of logging twice.
  const existing = await findTurn(store, input.client_message_id);
  if (existing) return replay(existing, await spendNow());

  const day = await store.rpc<string>("trk_logical_day", { p_at: now.toISOString() });
  let userMsg: Row;
  try {
    userMsg = await store.insert("trk_messages", {
      mode: input.mode, day, role: "user", content: input.text, has_image: Boolean(input.image),
      client_message_id: input.client_message_id, status: "pending",
    });
  } catch (e) {
    // Lost a race with a concurrent retry of the same message.
    const turn = /duplicate key|unique/i.test(String(e)) ? await findTurn(store, input.client_message_id) : null;
    if (turn) return replay(turn, await spendNow());
    throw e;
  }

  const finish = async (text: string, status: "done" | "error", tools: ToolLog[] = []) => {
    await store.insert("trk_messages", {
      mode: input.mode, day, role: "assistant", content: text, reply_to: userMsg.id, status: "done",
      tool_calls: tools.length ? tools : null,
    });
    await store.update("trk_messages", userMsg.id, { status });
    return { turn: await store.rpc<Row>("trk_turn", { p_user_message_id: userMsg.id }), spend: await spendNow() };
  };
  const refuse = async () => ({
    status: 402, body: { error: "spend_cap", message: capMessage(capUsd), ...(await finish(capMessage(capUsd), "error")) },
  });

  if ((await spendNow()).total_usd >= capUsd) return refuse();

  const price = priceAt(await store.list<PriceRow>("trk_pricing"), model.name, now);
  if (!price) {
    const msg = `No trk_pricing row for ${model.name}, so I can't track cost. Add one in settings.`;
    return { status: 500, body: { error: "no_pricing", message: msg, ...(await finish(msg, "error")) } };
  }

  // Every Gemini request, agent round or search, is checked against the cap first and logged after.
  const checkCap = async () => {
    if ((await spendNow()).total_usd >= capUsd) throw new SpendCapError();
  };
  const logCall = async (turn: ModelTurn, purpose: "agent" | "search", round: number | null, latencyMs: number) => {
    const cost = costOf(turn.usage, turn.searchQueries.length, price);
    await store.insert("trk_llm_calls", {
      message_id: userMsg.id, purpose, round, model: turn.model, pricing_id: price.id,
      input_tokens: turn.usage.input + turn.usage.toolUse, output_tokens: turn.usage.output,
      thinking_tokens: turn.usage.thinking, cached_tokens: turn.usage.cached,
      search_queries: turn.searchQueries.length,
      token_cost_usd: cost.token_usd, search_cost_usd: cost.search_usd, latency_ms: latencyMs,
      created_at: clock().toISOString(), // same clock the spend cap reads
    });
  };

  // web_search is a separate grounded call, so it works whether or not the model allows Google Search
  // alongside function declarations, and its cost is attributed on its own row.
  const search: ToolCtx["search"] = async (query) => {
    await checkCap();
    const started = Date.now();
    const turn = await model.generate({
      system: SEARCH_PROMPT, contents: [{ role: "user", parts: [{ text: query }] }], googleSearch: true,
    });
    await logCall(turn, "search", null, Date.now() - started);
    return { answer: turn.text, sources: turn.sources.slice(0, 5), queries: turn.searchQueries };
  };

  // The food chat gets the foods I logged this week in its prompt, so they're logged by id with no lookup.
  const [status, recentFoods, context] = await Promise.all([
    data.getStatus(now),
    input.mode === "food" ? data.recentFoods(RECENT_FOOD_DAYS, now) : Promise.resolve([]),
    store.rpc<{ role: "user" | "assistant"; content: string; has_image: boolean }[]>("trk_model_context", {
      p_mode: input.mode, p_day: day, p_limit: 20,
    }),
  ]);
  const history: Content[] = context.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.has_image ? `[photo attached earlier] ${m.content}` : m.content || "(empty)" }],
  }));
  const userParts: Part[] = [];
  if (input.image) {
    userParts.push({
      inlineData: { mimeType: input.image.mime_type, data: input.image.data },
      mediaResolution: { level: IMAGE_RESOLUTION },
    });
  }
  userParts.push({ text: input.text || "(photo, no text)" });

  try {
    const { text, tools } = await runAgent({
      model,
      mode: input.mode,
      ctx: { data, messageId: userMsg.id, search, freshFoodIds: new Set() },
      system: systemPrompt(input.mode, status, recentFoods),
      history,
      user: { role: "user", parts: userParts },
      hooks: {
        beforeCall: checkCap,
        afterCall: (turn, round, latencyMs) => logCall(turn, "agent", round, latencyMs),
      },
    });
    return { status: 200, body: await finish(text, "done", tools) };
  } catch (e) {
    if (e instanceof SpendCapError) return refuse();
    const msg = `Something went wrong: ${e instanceof Error ? e.message : String(e)}. Anything saved before the error is in the log.`;
    return { status: 500, body: { error: "agent_error", message: msg, ...(await finish(msg, "error")) } };
  }
}

async function findTurn(store: Store, clientMessageId: string) {
  return store.rpc<Row | null>("trk_turn_by_client_id", { p_client_message_id: clientMessageId });
}

function replay(turn: Row, spend: Spend): ChatResponse {
  if (turn.user.status === "pending") {
    return { status: 409, body: { error: "in_progress", message: "Still working on this message.", retry_after_s: 2 } };
  }
  return { status: 200, body: { turn, spend, duplicate: true } };
}
