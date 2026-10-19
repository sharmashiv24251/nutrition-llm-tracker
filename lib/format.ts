// Display strings for sets and loads, e.g. "+17.5 kg × 5 + 1 partial", "40 kg/side × 9".

export type LoadType = "added" | "assisted" | "bodyweight_only" | "total" | "per_side" | "per_hand";

export type SetLike = {
  load_kg: number | string | null;
  load_type: LoadType;
  full_reps: number;
  partial_reps?: number | null;
  rest_pause_reps?: number | null;
  rpe?: number | string | null;
  is_warmup?: boolean | null;
};

export function kg(n: number | string): string {
  return `${Number(n)} kg`;
}

export function formatLoad(load_kg: number | string | null, load_type: LoadType): string {
  const n = load_kg == null ? 0 : Number(load_kg);
  switch (load_type) {
    case "added":
      return n === 0 ? "BW" : `+${kg(n)}`;
    case "assisted":
      return `${kg(n)} assist`;
    case "bodyweight_only":
      return "BW";
    case "total":
      return kg(n);
    case "per_side":
      return `${kg(n)}/side`;
    case "per_hand":
      return `${kg(n)} each`;
  }
}

export function formatSet(s: SetLike): string {
  let out = `${formatLoad(s.load_kg, s.load_type)} × ${s.full_reps}`;
  if (s.partial_reps) out += ` + ${s.partial_reps} partial`;
  if (s.rest_pause_reps) out += ` + ${s.rest_pause_reps} rest-pause`;
  if (s.rpe != null) out += ` @${Number(s.rpe)}`;
  if (s.is_warmup) out += " (warm-up)";
  return out;
}
