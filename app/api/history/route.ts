import { z } from "zod";
import { handle } from "@/lib/http";
import { data, store } from "@/lib/server";

/** The home screen: one row per day (newest first), today's status and today's spend. */
export async function GET(req: Request) {
  return handle(async () => {
    const days = z.coerce.number().int().min(7).max(120).catch(30).parse(new URL(req.url).searchParams.get("days") ?? 30);
    const [history, status, spend] = await Promise.all([
      data.history(days),
      data.getStatus(),
      store.rpc("trk_spend_today", {}),
    ]);
    return Response.json({ history, status, spend });
  });
}
