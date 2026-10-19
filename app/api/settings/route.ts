// Settings page: targets, day cutoff hour, household units and pricing rows. Edits go through
// trk_apply_edit (logged, undoable); new rows are plain inserts.
import { z } from "zod";
import { body, handle } from "@/lib/http";
import { data } from "@/lib/server";

const n = z.number().nonnegative();
const day = z.iso.date();

const TargetFields = z.strictObject({
  effective_from: day, kcal: n, protein_g: n, carbs_g: n.nullable(), fat_g: n.nullable(), fibre_g: n,
});
const UnitFields = z.strictObject({
  name: z.string().min(1).max(40), aliases: z.array(z.string().min(1).max(40)).max(20), default_g: z.number().positive(),
});
const PricingFields = z.strictObject({
  model: z.string().min(1).max(80), input_per_m: n, output_per_m: n, cached_per_m: n, search_per_1k: n,
  effective_from: z.iso.datetime({ offset: true }),
});
const SettingsFields = z.strictObject({ day_cutoff_hour: z.int().min(0).max(12) });

const Edit = z.discriminatedUnion("table", [
  z.object({ table: z.literal("trk_targets"), id: z.uuid(), fields: TargetFields.partial() }),
  z.object({ table: z.literal("trk_household_units"), id: z.uuid(), fields: UnitFields.partial() }),
  z.object({ table: z.literal("trk_pricing"), id: z.uuid(), fields: PricingFields.partial() }),
  z.object({ table: z.literal("trk_settings"), id: z.uuid(), fields: SettingsFields.partial() }),
]);

const Add = z.discriminatedUnion("table", [
  z.object({ table: z.literal("trk_targets"), row: TargetFields }),
  z.object({ table: z.literal("trk_household_units"), row: UnitFields }),
  z.object({ table: z.literal("trk_pricing"), row: PricingFields }),
]);

const byDate = (key: string) => (a: Record<string, string>, b: Record<string, string>) => (a[key] < b[key] ? 1 : -1);

export async function GET() {
  return handle(async () => {
    const [settings, targets, units, pricing] = await Promise.all([
      data.list("trk_settings"), data.list("trk_targets"), data.list("trk_household_units"), data.list("trk_pricing"),
    ]);
    return Response.json({
      settings: settings[0] ?? null,
      targets: targets.sort(byDate("effective_from")),
      units: units.filter((u) => !u.food_id),
      pricing: pricing.sort(byDate("effective_from")),
    });
  });
}

export async function PATCH(req: Request) {
  return handle(async () => {
    const { table, id, fields } = await body(req, Edit);
    return Response.json(await data.editSetting(table, id, fields));
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const { table, row } = await body(req, Add);
    return Response.json(await data.addSetting(table, row));
  });
}
