import { describe, expect, test } from "bun:test";
import { CLOSE_MATCH, rank } from "../lib/fuzzy";
import { formatSet } from "../lib/format";
import { withRetry } from "../lib/llm";
import { macrosFor, resolveGrams, scaleMacros, type HouseholdUnit } from "../lib/units";

// Catalog without typo aliases, so matching has to do the work.
const catalog = [
  { id: "pu", name: "Pull-up", aliases: ["pullup", "pull up", "weighted pull-up"] },
  { id: "mr", name: "Machine row", aliases: ["plate-loaded row"] },
  { id: "lp", name: "Lat pulldown", aliases: ["pulldown"] },
  { id: "dc", name: "Dumbbell curl", aliases: ["db curl", "curls"] },
  { id: "ez", name: "EZ-bar curl", aliases: ["ez curl"] },
];
const names = (e: (typeof catalog)[number]) => [e.name, ...e.aliases];
const best = (q: string) => rank(q, catalog, names)[0];

describe("exercise matching", () => {
  test.each([
    ["weighted pullips", "pu"],
    ["weighted pulups", "pu"],
    ["pullups", "pu"],
    ["Pull ups", "pu"],
    ["bw + pull-ups", "pu"],
    ["neutral-grip lat pulldown", "lp"],
    ["machine row wide underhand", "mr"],
    ["ez bar curls", "ez"],
    ["DB curls", "dc"],
    ["underhand rowing machine", "mr"],
    ["rowing machine", "mr"],
    ["pulling up", "pu"],
  ])("%p → %p", (q, id) => {
    const m = best(q);
    expect(m.item.id).toBe(id);
    expect(m.score).toBeGreaterThanOrEqual(CLOSE_MATCH);
  });

  test("extra words come back as a variation hint", () => {
    expect(best("neutral-grip lat pulldown").leftover.join(" ")).toBe("neutral grip");
    expect(best("machine row wide underhand").leftover.join(" ")).toBe("wide underhand");
  });

  test.each(["incline dumbbell press", "cable row", "seated row", "romanian deadlift", "pullover", "squatting"])("%p has no close match", (q) => {
    expect(best(q)?.score ?? 0).toBeLessThan(CLOSE_MATCH);
  });
});

describe("food matching", () => {
  const foods = [
    { name: "Perform Whey", brand: "Nakpro", aliases: [] as string[] },
    { name: "Cooked white rice", brand: null, aliases: ["rice", "chawal"] },
  ];
  const foodNames = (f: (typeof foods)[number]) => [f.name, ...f.aliases, ...(f.brand ? [`${f.brand} ${f.name}`] : [])];
  test("brand plus product name", () => {
    const m = rank("nakpro perform", foods, foodNames)[0];
    expect(m.item.name).toBe("Perform Whey");
    expect(m.score).toBeGreaterThanOrEqual(CLOSE_MATCH);
  });
  test("alias", () => expect(rank("chawal", foods, foodNames)[0].item.name).toBe("Cooked white rice"));
});

describe("grams", () => {
  const units: HouseholdUnit[] = [
    { id: "1", name: "katori", aliases: ["katoris", "vati"], default_g: 150, food_id: null },
    { id: "2", name: "roti", aliases: ["chapati"], default_g: 40, food_id: null },
    { id: "3", name: "katori", aliases: [], default_g: 120, food_id: "dal" },
  ];
  test("stated grams win", () => {
    expect(resolveGrams({ quantity: 3, unit: "roti", grams: 110 }, units)).toEqual({ grams: 110, method: "given" });
  });
  test("household unit converts and keeps the per-unit size", () => {
    expect(resolveGrams({ quantity: 1.5, unit: "katori" }, units)).toEqual({ grams: 225, method: "household", unit_g: 150 });
    expect(resolveGrams({ quantity: 2, unit: "Katoris" }, units)).toMatchObject({ grams: 300 });
    expect(resolveGrams({ quantity: 3, unit: "chapatis" }, units)).toMatchObject({ grams: 120 });
  });
  test("a food-specific size beats the generic one", () => {
    expect(resolveGrams({ quantity: 1, unit: "katori", food_id: "dal" }, units)).toMatchObject({ grams: 120 });
  });
  test("mass units and servings", () => {
    expect(resolveGrams({ quantity: 0.36, unit: "kg" }, units)).toMatchObject({ grams: 360, method: "mass" });
    expect(resolveGrams({ quantity: 2, unit: "scoop" }, units, { serving_name: "scoop", serving_g: 33 }))
      .toMatchObject({ grams: 66, method: "serving" });
    expect(resolveGrams({ quantity: 1, unit: "handful" }, units)).toEqual({ grams: null, method: "unknown" });
  });
  test("saved foods always give the same macros", () => {
    const nakpro = { kcal_per_100g: 393.3, protein_per_100g: 80, carbs_per_100g: 6.7, fat_per_100g: 5.3, fibre_per_100g: 0 };
    const a = macrosFor(nakpro, 30);
    expect(a).toEqual({ kcal: 118, protein_g: 24, carbs_g: 2, fat_g: 1.6, fibre_g: 0 });
    expect(macrosFor(nakpro, 30)).toEqual(a);
  });
  test("scaling an estimate by weight", () => {
    expect(scaleMacros({ kcal: 130, protein_g: 2.7, carbs_g: 28.2, fat_g: 0.3, fibre_g: 0.4 }, 100, 150))
      .toEqual({ kcal: 195, protein_g: 4.1, carbs_g: 42.3, fat_g: 0.5, fibre_g: 0.6 });
  });
});

describe("set labels", () => {
  test.each([
    [{ load_kg: 17.5, load_type: "added", full_reps: 5, partial_reps: 1 }, "+17.5 kg × 5 + 1 partial"],
    [{ load_kg: 15, load_type: "added", full_reps: 6, rest_pause_reps: 2 }, "+15 kg × 6 + 2 rest-pause"],
    [{ load_kg: 40, load_type: "per_side", full_reps: 9 }, "40 kg/side × 9"],
    [{ load_kg: 22.5, load_type: "per_hand", full_reps: 10 }, "22.5 kg each × 10"],
    [{ load_kg: 30, load_type: "total", full_reps: 12 }, "30 kg × 12"],
    [{ load_kg: 20, load_type: "assisted", full_reps: 8 }, "20 kg assist × 8"],
    [{ load_kg: null, load_type: "bodyweight_only", full_reps: 15, is_warmup: true }, "BW × 15 (warm-up)"],
    [{ load_kg: "0.00", load_type: "added", full_reps: 8, rpe: "8.5" }, "BW × 8 @8.5"],
  ] as const)("%o", (set, label) => {
    expect(formatSet(set as any)).toBe(label);
  });
});

describe("Gemini retries", () => {
  const noSleep = async () => {};
  test("retries a 503 and then succeeds", async () => {
    let n = 0;
    const out = await withRetry(async () => {
      if (++n < 3) throw new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}');
      return "ok";
    }, noSleep);
    expect([out, n]).toEqual(["ok", 3]);
  });
  test("gives up after two retries", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new Error("503 UNAVAILABLE"); }, noSleep)).rejects.toThrow(/503/);
    expect(n).toBe(3);
  });
  test("doesn't retry a bad request", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new Error("400 INVALID_ARGUMENT"); }, noSleep)).rejects.toThrow(/400/);
    expect(n).toBe(1);
  });
});
