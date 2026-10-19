// Quantity → grams, and grams → macros for saved foods. Pure functions, no I/O.
import { normalize, tokens } from "./fuzzy";

export type HouseholdUnit = { id: string; name: string; aliases: string[]; default_g: number; food_id: string | null };

export type Per100 = {
  kcal_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
  fibre_per_100g: number;
  serving_name?: string | null;
  serving_g?: number | null;
};

export type Macros = { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fibre_g: number };

const MASS_G: Record<string, number> = {
  g: 1, gm: 1, gms: 1, gr: 1, gram: 1, grams: 1, grm: 1,
  kg: 1000, kgs: 1000, kilo: 1000, kilos: 1000,
  ml: 1, mls: 1, l: 1000, litre: 1000, liter: 1000,
  oz: 28.35,
};

export type GramsResult =
  | { grams: number; method: "given" | "mass" | "serving" | "household"; unit_g?: number }
  | { grams: null; method: "unknown" };

/**
 * Resolves the weight of what I ate. Grams I state win ("3 roti 110g" → 110 g for all three).
 * Otherwise mass units convert directly, then the food's serving size, then household units
 * (a size for this specific food beats the generic size).
 */
export function resolveGrams(
  input: { quantity?: number | null; unit?: string | null; grams?: number | null; food_id?: string | null },
  units: HouseholdUnit[],
  food?: Pick<Per100, "serving_name" | "serving_g"> | null,
): GramsResult {
  if (input.grams != null && input.grams >= 0) return { grams: round1(input.grams), method: "given" };
  const qty = input.quantity ?? 1;
  const unit = input.unit ? normalize(input.unit) : "";

  if (unit in MASS_G) return { grams: round1(qty * MASS_G[unit]), method: "mass" };

  if (food?.serving_g && (unit === "" || unit === "serving" || unit === "servings" ||
      (food.serving_name && sameUnit(unit, food.serving_name)))) {
    return { grams: round1(qty * food.serving_g), method: "serving", unit_g: food.serving_g };
  }

  if (unit) {
    const matches = units.filter((u) => [u.name, ...u.aliases].some((n) => sameUnit(unit, n)));
    const hit = matches.find((u) => input.food_id && u.food_id === input.food_id) ?? matches.find((u) => u.food_id === null);
    if (hit) return { grams: round1(qty * hit.default_g), method: "household", unit_g: hit.default_g };
  }
  return { grams: null, method: "unknown" };
}

function sameUnit(a: string, b: string): boolean {
  return tokens(a).join(" ") === tokens(b).join(" ");
}

/** Macros for `grams` of a saved food. Same inputs always give the same numbers. */
export function macrosFor(food: Per100, grams: number): Macros {
  const f = grams / 100;
  return {
    kcal: round1(food.kcal_per_100g * f),
    protein_g: round1(food.protein_per_100g * f),
    carbs_g: round1(food.carbs_per_100g * f),
    fat_g: round1(food.fat_per_100g * f),
    fibre_g: round1(food.fibre_per_100g * f),
  };
}

/** Scales an entry's macros when only its weight changed ("that rice was 150 g not 100"). */
export function scaleMacros(m: Macros, fromGrams: number, toGrams: number): Macros {
  const f = toGrams / fromGrams;
  return {
    kcal: round1(m.kcal * f),
    protein_g: round1(m.protein_g * f),
    carbs_g: round1(m.carbs_g * f),
    fat_g: round1(m.fat_g * f),
    fibre_g: round1(m.fibre_g * f),
  };
}

export function round1(n: number): number {
  return Math.round((n + Number.EPSILON) * 10) / 10;
}
