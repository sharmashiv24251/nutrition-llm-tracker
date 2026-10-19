// Data layer against a local Postgres with every migration applied and a seeded test day.
// These are the tool calls the agent will make in phase 3, with the model's parsing written out by hand.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dataLayer, InputError, type DataLayer } from "../lib/data";
import { bunStore } from "./helpers/bun-store";
import { hasPostgres, startPg } from "./helpers/pg";

let pg: Awaited<ReturnType<typeof startPg>>;
let data: DataLayer;

async function fails(p: Promise<unknown>, pattern: RegExp) {
  try {
    await p;
  } catch (e) {
    expect((e as Error).message).toMatch(pattern);
    return e;
  }
  throw new Error("expected a failure");
}

const DAY = "2026-10-20";
const NEXT_DAY = "2026-10-21";

describe.skipIf(!hasPostgres)("data layer", () => {
  beforeAll(async () => {
    pg = await startPg();
    data = dataLayer(bunStore(pg.sql));
  }, 60_000);
  afterAll(async () => { await pg?.stop(); });

  describe("workout logging", () => {
    let session: string;
    let pullup: string;

    test("'bw + 15 kg pull-ups, 7 full reps and 2 half reps' → one added set, 15 kg, 7 full, 2 partial", async () => {
      const raw = "bw + 15 kg pull-ups, 7 full reps and 2 half reps";
      const found = await data.findExercise({ query: "pull-ups" });
      expect(found.best?.name).toBe("Pull-up");
      pullup = found.best!.id;
      session = (await data.startWorkout({ day: DAY })).session.id;
      const res = await data.logSets({
        session_id: session,
        sets: [{ exercise_id: pullup, load_kg: 15, load_type: "added", full_reps: 7, partial_reps: 2, raw_text: raw }],
      });
      expect(res.sets).toHaveLength(1);
      expect(res.sets[0]).toMatchObject({ load_type: "added", load_kg: 15, full_reps: 7, partial_reps: 2, raw_text: raw });
    });

    test("'weighted pullips' matches the existing pull-up instead of creating one", async () => {
      expect((await data.findExercise({ query: "weighted pullips" })).best?.id).toBe(pullup);
      expect((await data.findExercise({ query: "weighted pulups" })).best?.id).toBe(pullup);
      const create = await data.createExercise({ name: "Weighted pullips", default_load_type: "added" });
      expect(create.created).toBe(false);
      expect(await pg.psql("select count(*) from trk_exercises")).toBe("5\n");
    });

    test("'neutral-grip lat pulldown' resolves to lat pulldown with the grip as extra words", async () => {
      const r = await data.findExercise({ query: "neutral-grip lat pulldown" });
      expect(r.best).toMatchObject({ name: "Lat pulldown", extra_words: "neutral grip" });
    });

    test("a genuinely new exercise is created; a close one needs distinct_from", async () => {
      const created = await data.createExercise({ name: "Romanian deadlift", aliases: ["rdl"], default_load_type: "total" });
      expect(created.created).toBe(true);
      const smith = await data.createExercise({ name: "Smith machine row", default_load_type: "total" });
      expect(smith.created).toBe(false);
      const row = (await data.findExercise({ query: "machine row" })).best!.id;
      const ok = await data.createExercise({ name: "Smith machine row", default_load_type: "total", distinct_from: row });
      expect(ok.created).toBe(true);
    });

    test("'machine row wide underhand 40 kg per side 9 9 9' → three per_side sets with the variation", async () => {
      const raw = "machine row wide underhand 40 kg per side 9 9 9";
      const r = await data.findExercise({ query: "machine row wide underhand" });
      expect(r.best).toMatchObject({ name: "Machine row", extra_words: "wide underhand" });
      const res = await data.logSets({
        session_id: session,
        sets: [9, 9, 9].map((reps) => ({
          exercise_id: r.best!.id, variation: "wide underhand", load_kg: 40, load_type: "per_side" as const,
          full_reps: reps, raw_text: raw,
        })),
      });
      expect(res.sets.map((s: any) => [s.set_index, s.load_type, s.load_kg, s.variation, s.full_reps])).toEqual([
        [1, "per_side", 40, "wide underhand", 9], [2, "per_side", 40, "wide underhand", 9], [3, "per_side", 40, "wide underhand", 9],
      ]);
    });

    test("exercises can be created with notes and edited; renaming keeps history and the old name", async () => {
      const created = await data.createExercise({
        name: "Hammer Strength high row", default_load_type: "per_side", equipment: "plate-loaded machine",
        notes: "Seat 4, chest on pad.",
      });
      expect(created).toMatchObject({ created: true, exercise: { notes: "Seat 4, chest on pad." } });
      const row = (await data.findExercise({ query: "machine row" })).best!;

      // the AI records how I do it without wiping what's there
      await data.updateExercise({ id: row.id, notes: "Plate-loaded, pads at chest height." });
      const appended = await data.updateExercise({ id: row.id, append_note: "Wide underhand grip, 2 s squeeze." });
      expect(appended.after.notes).toBe("Plate-loaded, pads at chest height.\nWide underhand grip, 2 s squeeze.");

      // rename: history stays on the same id, the old name becomes an alias
      const renamed = await data.updateExercise({ id: row.id, name: "Chest-supported row" }, { source: "ui" });
      expect(renamed.after.name).toBe("Chest-supported row");
      expect(renamed.after.aliases).toContain("Machine row");
      expect((await data.findExercise({ query: "underhand rowing machine" })).best?.id).toBe(row.id);
      expect((await data.getExerciseHistory(row.id, 52)).sessions.length).toBeGreaterThan(0);
      expect(await pg.psql(`select reason from trk_edit_log where row_id = '${row.id}' order by created_at desc limit 1`))
        .toBe("renamed from Machine row\n");

      await fails(data.updateExercise({ id: row.id, name: "Pull-up" }), /already called/);
      await fails(data.createExercise({ name: "pull-up", default_load_type: "added", distinct_from: pullup }), /already exists/);
      await fails(data.updateExercise({ id: row.id }), /nothing to change/);
      await data.updateExercise({ id: row.id, name: "Machine row" }); // put it back for the tests below
    });

    test("a loaded set without a load is rejected before reaching the database", async () => {
      const err = await fails(
        data.logSets({ session_id: session, sets: [{ exercise_id: pullup, load_type: "per_hand", full_reps: 10, raw_text: "curls" }] }),
        /load_kg is required/,
      );
      expect(err).toBeInstanceOf(InputError);
    });

    test("history and session summary come from SQL", async () => {
      await data.endWorkout(session);
      const h = await data.getExerciseHistory(pullup, 52);
      expect(h.sessions[0].top_set).toMatchObject({ load_kg: 15, full_reps: 7, partial_reps: 2 });
      const s = await data.getSessionSummary(session);
      expect(s!.exercises.map((e: any) => e.name)).toEqual(["Pull-up", "Machine row"]);
    });
  });

  describe("food logging", () => {
    let nakpro: string;
    let riceEntry: string;
    let bhindiEntry: string;

    test("a label food is saved once; saving again updates instead of duplicating", async () => {
      const label = {
        name: "Perform Whey", brand: "Nakpro", aliases: ["nakpro perform"], kcal_per_100g: 393.3,
        protein_per_100g: 80, carbs_per_100g: 6.7, fat_per_100g: 5.3, fibre_per_100g: 0,
        serving_name: "scoop", serving_g: 33, source: "label_photo" as const,
      };
      const a = await data.saveFood(label);
      expect(a.action).toBe("created");
      nakpro = a.food.id;
      const b = await data.saveFood({ ...label, serving_g: 30 });
      expect(b).toMatchObject({ action: "updated", food: { id: nakpro, serving_g: 30 } });
      expect(await pg.psql("select count(*) from trk_foods")).toBe("1\n");
    });

    test("'30g nakpro perform' uses saved values, and the next day gives the same numbers with no search", async () => {
      const found = await data.findFood({ query: "nakpro perform" });
      expect(found.best?.id).toBe(nakpro);
      const item = { raw_text: "30g nakpro perform", display_name: "Nakpro Perform", food_id: nakpro, quantity: 30, unit: "g",
        kcal: 999 /* ignored: library values win */ };
      const d1 = await data.logFood({ day: DAY, items: [item] });
      const d2 = await data.logFood({ day: NEXT_DAY, items: [item] });
      const pick = (e: any) => [e.grams, e.kcal, e.protein_g, e.carbs_g, e.fat_g, e.confidence];
      expect(pick(d1.entries[0])).toEqual([30, 118, 24, 2, 1.6, "saved"]);
      expect(pick(d2.entries[0])).toEqual(pick(d1.entries[0]));
    });

    test("'I ate 360 g of thin tarakadal and 100 g of cooked white rice' → two estimates with exact words", async () => {
      const raw = "I ate 360 g of thin tarakadal and 100 g of cooked white rice";
      const res = await data.logFood({
        day: DAY,
        items: [
          { raw_text: raw, display_name: "Tarakadal (thin)", quantity: 360, unit: "g", kcal: 410, protein_g: 21.6,
            carbs_g: 50, fat_g: 12, fibre_g: 14, assumptions: "assumed 1 tbsp oil for the tadka.", meal: "lunch" },
          { raw_text: raw, display_name: "Cooked white rice", quantity: 100, unit: "g", kcal: 130, protein_g: 2.7,
            carbs_g: 28.2, fat_g: 0.3, fibre_g: 0.4, meal: "lunch" },
        ],
      });
      expect(res.entries.map((e: any) => [e.display_name, e.grams, e.confidence, e.raw_text])).toEqual([
        ["Tarakadal (thin)", 360, "estimate", raw], ["Cooked white rice", 100, "estimate", raw],
      ]);
      riceEntry = res.entries[1].id;
      expect(res.summary.totals.kcal).toBe(118 + 410 + 130);
    });

    test("'1.5 katori bhindi sabzi, very oily' converts through household units and stores both", async () => {
      const res = await data.logFood({ day: DAY, items: [{
        raw_text: "1.5 katori bhindi sabzi, very oily", display_name: "Bhindi sabzi (oily)", quantity: 1.5, unit: "katori",
        kcal: 290, protein_g: 4.5, carbs_g: 16, fat_g: 23, fibre_g: 7, assumptions: "assumed 2 tbsp oil per katori.",
      }] });
      expect(res.entries[0]).toMatchObject({ quantity: 1.5, unit: "katori", grams: 225, confidence: "estimate" });
      expect(res.grams_methods).toEqual(["household"]);
      bhindiEntry = res.entries[0].id;
    });

    test("'3 roti 110g' keeps the stated grams", async () => {
      const res = await data.logFood({ day: DAY, items: [{
        raw_text: "3 roti 110g", display_name: "Roti", quantity: 3, unit: "roti", grams: 110, kcal: 330, protein_g: 10,
      }] });
      expect(res.entries[0]).toMatchObject({ quantity: 3, unit: "roti", grams: 110 });
    });

    test("an estimate without kcal is rejected", async () => {
      await fails(data.logFood({ day: DAY, items: [{ raw_text: "some dal", display_name: "Dal" }] }), /kcal is required/);
    });

    test("'that rice was 150 g not 100' updates the row, rescales macros, logs the edit, totals change", async () => {
      const before = (await data.getDaySummary(DAY)).totals.kcal;
      const edit = await data.updateEntry({
        table: "trk_food_entries", id: riceEntry, fields: { quantity: 150, grams: 150 }, reason: "rice was 150 g not 100",
      });
      expect(edit.after).toMatchObject({ grams: 150, kcal: 195, protein_g: 4.1, carbs_g: 42.3 });
      expect(await pg.psql(`select count(*) from trk_edit_log where row_id = '${riceEntry}' and action = 'update'`)).toBe("1\n");
      expect((await data.getDaySummary(DAY)).totals.kcal).toBe(before + 65);
    });

    test("changing a household quantity recomputes grams and macros", async () => {
      const edit = await data.updateEntry({ table: "trk_food_entries", id: bhindiEntry, fields: { quantity: 1 }, reason: "it was 1 katori" });
      expect(edit.after).toMatchObject({ quantity: 1, grams: 150, kcal: 193.3 });
    });

    test("changing grams on a library food recomputes from per-100 g values", async () => {
      const [entry] = (await data.getEntries({ from: NEXT_DAY, to: NEXT_DAY, type: "food" }));
      const edit = await data.updateEntry({ table: "trk_food_entries", id: entry.id, fields: { grams: 60, quantity: 60 }, reason: "2 scoops" });
      expect(edit.after).toMatchObject({ grams: 60, kcal: 236, protein_g: 48 });
    });

    test("delete and undo from the log view", async () => {
      const before = (await data.getDaySummary(DAY)).totals.kcal;
      await data.deleteEntry({ table: "trk_food_entries", id: riceEntry, reason: "replaced by paneer meal" }, { source: "ui" });
      expect((await data.getDaySummary(DAY)).totals.kcal).toBeCloseTo(before - 195, 1);
      await data.undoEdit();
      expect((await data.getDaySummary(DAY)).totals.kcal).toBe(before);
    });

    test("only whitelisted tables can be edited", async () => {
      await fails(data.updateEntry({ table: "profiles" as any, id: riceEntry, fields: { x: 1 }, reason: "r" }), /invalid_value/);
      await fails(data.deleteEntry({ table: "trk_pricing" as any, id: riceEntry, reason: "r" }), /invalid_value/);
    });
  });

  describe("days", () => {
    test("bodyweight at 01:30 Dublin belongs to the previous day", async () => {
      const bw = await data.logBodyweight({ kg: 78.4, measured_at: "2026-10-22T00:30:00Z" });
      expect(bw.day).toBe("2026-10-21");
    });

    test("closing a day, then late logging, reopens it", async () => {
      expect((await data.endDay(DAY)).status).toBe("closed");
      const res = await data.logFood({ day: DAY, items: [{
        raw_text: "yesterday I also had 2 eggs", display_name: "Boiled eggs", quantity: 2, unit: "egg", kcal: 140, protein_g: 12,
      }] });
      expect(res.day.reopened).toBe(true);
    });

    test("status reports today and earlier open days", async () => {
      const st = await data.getStatus(new Date("2026-10-23T09:00:00Z"));
      expect(st.today).toBe("2026-10-23");
      expect(st.open_days).toEqual(expect.arrayContaining([DAY, NEXT_DAY]));
    });
  });
});
