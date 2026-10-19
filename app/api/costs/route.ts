import { handle } from "@/lib/http";
import { store } from "@/lib/server";

/** Daily Gemini spend for the last 30 days, split into tokens and search, plus month to date. */
export async function GET() {
  return handle(async () => Response.json(await store.rpc("trk_cost_report", { p_days: 30 })));
}
