import { dayParam, handle } from "@/lib/http";
import { data, store } from "@/lib/server";

/** Food entries for a day (default today) with the database's totals against targets. No LLM involved. */
export async function GET(req: Request) {
  return handle(async () => {
    const status = await data.getStatus();
    const day = dayParam(req) ?? status.today;
    const [entries, summary, spend] = await Promise.all([
      data.getEntries({ from: day, to: day, type: "food" }),
      data.getDaySummary(day),
      store.rpc("trk_spend_today", {}),
    ]);
    return Response.json({ day, today: status.today, entries, summary, spend });
  });
}
