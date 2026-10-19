import { z } from "zod";
import { body, handle } from "@/lib/http";
import { data, store } from "@/lib/server";

/** The edit that Undo would revert (or null). */
export async function GET() {
  return handle(async () => Response.json({ edit: await store.rpc("trk_last_edit", {}) }));
}

/** Undo one edit; `edit_id` guards against undoing something other than what the UI showed. */
export async function POST(req: Request) {
  return handle(async () => {
    const { edit_id } = await body(req, z.object({ edit_id: z.uuid() }));
    return Response.json(await data.undoEdit(edit_id));
  });
}
