import { z } from "zod";
import { body, handle } from "@/lib/http";
import { UpdateExercise } from "@/lib/schemas";
import { data } from "@/lib/server";

/** An exercise's details and its sessions with all sets and the top set per session. */
export async function GET(req: Request, ctx: RouteContext<"/api/exercise/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const weeks = z.coerce.number().int().min(1).max(260).catch(26).parse(new URL(req.url).searchParams.get("weeks") ?? 26);
    return Response.json(await data.getExerciseHistory(z.uuid().parse(id), weeks));
  });
}

/** Edits the exercise (name, aliases, equipment, load type, notes). Logged and undoable. */
export async function PATCH(req: Request, ctx: RouteContext<"/api/exercise/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const fields = await body(req, UpdateExercise.omit({ id: true }));
    return Response.json(await data.updateExercise({ id, ...fields }, { source: "ui" }));
  });
}
