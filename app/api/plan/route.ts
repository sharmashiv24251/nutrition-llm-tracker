import { handle } from "@/lib/http";
import { data } from "@/lib/server";

/**
 * Without ?day: the active program and the next day in the rotation.
 * With ?day=<id or name>: that day's trainer brief (plan, last sessions, suggested weights, trends).
 */
export async function GET(req: Request) {
  return handle(async () => {
    const day = new URL(req.url).searchParams.get("day");
    if (day) return Response.json({ brief: await data.planWorkout({ program_day: day }) });
    const [program, status] = await Promise.all([data.getProgram(), data.getStatus()]);
    return Response.json({ program, next: status.today_program_day ?? null, today: status.today });
  });
}
