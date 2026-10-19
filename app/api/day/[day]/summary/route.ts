import { z } from "zod";
import { handle } from "@/lib/http";
import { summaryDeps } from "@/lib/server";
import { SpendCapReached, summarizeDay } from "@/lib/summary";

export const maxDuration = 60;

/** Writes or rewrites a day's AI summary on demand. */
export async function POST(_req: Request, ctx: RouteContext<"/api/day/[day]/summary">) {
  return handle(async () => {
    const day = z.iso.date().parse((await ctx.params).day);
    try {
      return Response.json({ summary: await summarizeDay(day, "manual", summaryDeps()) });
    } catch (e) {
      if (e instanceof SpendCapReached) return Response.json({ error: "spend_cap", message: e.message }, { status: 402 });
      throw e;
    }
  });
}
