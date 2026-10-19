import { z } from "zod";
import { body, handle } from "@/lib/http";
import { data } from "@/lib/server";

export async function POST(req: Request) {
  return handle(async () => {
    const { day } = await body(req, z.object({ day: z.iso.date() }));
    return Response.json(await data.endDay(day));
  });
}
