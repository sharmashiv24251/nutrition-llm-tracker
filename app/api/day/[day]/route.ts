import { z } from "zod";
import { body, handle } from "@/lib/http";
import { COMPLETENESS } from "@/lib/schemas";
import { data } from "@/lib/server";

/** Everything about one day: food by meal, workouts, bodyweight, status and the AI summary. */
export async function GET(_req: Request, ctx: RouteContext<"/api/day/[day]">) {
  return handle(async () => {
    const { day } = await ctx.params;
    const [report, status] = await Promise.all([data.dayReport(day), data.getStatus()]);
    return Response.json({ report, today: status.today });
  });
}

/** Marks the day complete / incomplete / missed, or clears it (null). */
export async function PATCH(req: Request, ctx: RouteContext<"/api/day/[day]">) {
  return handle(async () => {
    const { day } = await ctx.params;
    const { completeness, note } = await body(req, z.object({
      completeness: z.enum(COMPLETENESS).nullable(),
      note: z.string().max(300).nullish(),
    }));
    await data.setDayCompleteness({ day, completeness, note }, { source: "ui" });
    return Response.json({ report: await data.dayReport(day) });
  });
}
