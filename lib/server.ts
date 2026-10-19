import "server-only";
import type { ChatDeps } from "./chat";
import { dataLayer } from "./data";
import { env } from "./env";
import { geminiModel } from "./gemini";
import { supabaseStore } from "./store-supabase";
import type { SummaryDeps } from "./summary";

/** Supabase-backed store and data layer. Import only from server code (route handlers). */
export const store = supabaseStore();
export const data = dataLayer(store);

export function summaryDeps(): SummaryDeps {
  const e = env();
  return { store, model: geminiModel(e.GEMINI_API_KEY), capUsd: e.DAILY_SPEND_CAP_USD };
}

export function chatDeps(): ChatDeps {
  const e = env();
  return { store, data, model: geminiModel(e.GEMINI_API_KEY), capUsd: e.DAILY_SPEND_CAP_USD };
}
