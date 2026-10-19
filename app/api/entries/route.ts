// Direct edits and deletes from the log views. No LLM call; every change goes through trk_apply_edit /
// trk_soft_delete, so it lands in trk_edit_log and can be undone.
import { z } from "zod";
import { body, handle } from "@/lib/http";
import { CONFIDENCE, LOAD_TYPES, MEALS } from "@/lib/schemas";
import { data } from "@/lib/server";

const n = z.number().nonnegative();
const reps = z.int().nonnegative();

// Fields the log view may change, per table.
const Edit = z.discriminatedUnion("table", [
  z.object({
    table: z.literal("trk_sets"),
    id: z.uuid(),
    fields: z.strictObject({
      load_kg: n.nullable(), load_type: z.enum(LOAD_TYPES), full_reps: reps, partial_reps: reps,
      rest_pause_reps: reps, rpe: z.number().min(1).max(10).nullable(), is_warmup: z.boolean(),
      variation: z.string().max(80).nullable(),
    }).partial(),
  }),
  z.object({
    table: z.literal("trk_food_entries"),
    id: z.uuid(),
    fields: z.strictObject({
      display_name: z.string().min(1).max(120), meal: z.enum(MEALS), quantity: n.nullable(), unit: z.string().max(40).nullable(),
      grams: n.nullable(), kcal: n, protein_g: n, carbs_g: n, fat_g: n, fibre_g: n, confidence: z.enum(CONFIDENCE),
    }).partial(),
  }),
  z.object({
    table: z.literal("trk_workout_sessions"),
    id: z.uuid(),
    fields: z.strictObject({ note: z.string().max(500).nullable() }).partial(),
  }),
]);

const Delete = z.object({ table: z.enum(["trk_sets", "trk_food_entries", "trk_workout_sessions"]), id: z.uuid() });

export async function PATCH(req: Request) {
  return handle(async () => {
    const edit = await body(req, Edit);
    return Response.json(await data.updateEntry({ ...edit, reason: "edited in log view" }, { source: "ui" }));
  });
}

export async function DELETE(req: Request) {
  return handle(async () => {
    const del = await body(req, Delete);
    return Response.json(await data.deleteEntry({ ...del, reason: "deleted in log view" }, { source: "ui" }));
  });
}
