import { z } from "zod";
import { handle } from "@/lib/http";
import { data, store } from "@/lib/server";

/** Sessions on a day (default today) with sets grouped by exercise. No LLM involved. */
export async function GET(req: Request) {
  return handle(async () => {
    const param = new URL(req.url).searchParams.get("day");
    const status = await data.getStatus();
    const day = param ? z.iso.date().parse(param) : status.today;
    const [sessions, spend] = await Promise.all([
      store.rpc("trk_day_workouts", { p_day: day }),
      store.rpc("trk_spend_today", {}),
    ]);
    return Response.json({ day, today: status.today, sessions, active_session: status.active_session, spend });
  });
}
