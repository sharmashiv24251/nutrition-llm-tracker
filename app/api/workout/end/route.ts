import { z } from "zod";
import { body, handle } from "@/lib/http";
import { data } from "@/lib/server";

export async function POST(req: Request) {
  return handle(async () => {
    const { session_id } = await body(req, z.object({ session_id: z.uuid() }));
    return Response.json(await data.endWorkout(session_id));
  });
}
