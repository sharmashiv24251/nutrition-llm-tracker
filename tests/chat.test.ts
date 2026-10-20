// POST /api/chat logic with a scripted model standing in for Gemini, against a local Postgres.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MAX_TOOL_ROUNDS } from "../lib/agent";
import { handleChat, type ChatInput } from "../lib/chat";
import { dataLayer } from "../lib/data";
import { toolDeclarations } from "../lib/tools";
import { bunStore } from "./helpers/bun-store";
import { hasPostgres, startPg } from "./helpers/pg";
import { call, say, scriptedModel, searchResult, type Step } from "./helpers/scripted-model";

let pg: Awaited<ReturnType<typeof startPg>>;
let clock = new Date("2026-10-20T18:00:00Z"); // 19:00 Dublin

let n = 0;
const msg = (text: string, extra: Partial<ChatInput> = {}): ChatInput => ({
  mode: "workout", text, client_message_id: `test-${++n}`, ...extra,
});

async function chat(input: ChatInput, steps: Step[], capUsd = 1) {
  const store = bunStore(pg.sql);
  const model = scriptedModel(steps);
  const res = await handleChat(input, {
    store, data: dataLayer(store, { now: () => clock }), model, capUsd, now: () => clock,
  });
  return { ...res, model };
}

const q = (strings: TemplateStringsArray, ...v: unknown[]) => pg.sql(strings, ...v);

describe.skipIf(!hasPostgres)("chat route logic", () => {
  beforeAll(async () => { pg = await startPg(); }, 60_000);
  afterAll(async () => { await pg?.stop(); });

  test("each mode only gets its own tools", () => {
    const workout = toolDeclarations({}, "workout").map((d) => d.name);
    const food = toolDeclarations({ search: async () => ({ answer: "", sources: [] }) }, "food").map((d) => d.name);
    expect(workout).toContain("log_sets");
    expect(workout).not.toContain("log_food");
    expect(food).toEqual(expect.arrayContaining(["log_food", "web_search", "log_bodyweight"]));
    expect(food).not.toContain("log_sets");
    // reading works everywhere
    for (const t of ["get_program_day", "get_history", "get_day_report", "find_exercise", "find_food", "list_exercises"]) {
      expect(workout).toContain(t);
      expect(food).toContain(t);
    }
  });

  test("log_sets without session_id uses the active session or opens one", async () => {
    clock = new Date("2026-11-10T18:00:00Z");
    const raw = "bw pull-ups 12";
    const steps = (): Step[] => [
      () => call("find_exercise", { query: "pull-ups" }),
      ({ lastResults }) => call("log_sets", { sets: [
        { exercise_id: lastResults.find_exercise.result.best.id, load_kg: 0, load_type: "added", full_reps: 12, raw_text: raw },
      ] }),
      () => say("ok"),
    ];
    const a = await chat(msg(raw), steps());
    const b = await chat(msg(raw), steps());
    expect(a.body.turn.sets[0].session_id).toBe(b.body.turn.sets[0].session_id);
    expect(b.body.turn.sets[0].set_index).toBe(2);
    expect((await q`select count(*)::int as n from trk_workout_sessions where day = '2026-11-10'`)[0].n).toBe(1);
    await pg.sql`update trk_workout_sessions set status = 'ended', ended_at = now() where day = '2026-11-10'`;
    clock = new Date("2026-10-20T18:00:00Z");
  });

  test("tool declarations are valid JSON Schema objects", () => {
    const decls = toolDeclarations({});
    expect(decls.map((d) => d.name)).toContain("log_sets");
    expect(decls.map((d) => d.name)).not.toContain("web_search");
    for (const d of decls) expect((d.parametersJsonSchema as any).type).toBe("object");
  });

  test("'bw + 15 kg pull-ups, 7 full reps and 2 half reps' creates one added set: 15 kg, 7 full, 2 partial", async () => {
    const text = "bw + 15 kg pull-ups, 7 full reps and 2 half reps";
    const r = await chat(msg(text), [
      () => call("find_exercise", { query: "pull-ups" }),
      ({ lastResults }) => {
        expect(lastResults.find_exercise.result.best.name).toBe("Pull-up");
        return call("start_workout", {});
      },
      ({ contents, lastResults }) => {
        const exerciseId = (contents.at(-3)!.parts![0].functionResponse!.response as any).result.best.id;
        return call("log_sets", { session_id: lastResults.start_workout.result.session.id, sets: [
          { exercise_id: exerciseId, load_kg: 15, load_type: "added", full_reps: 7, partial_reps: 2, raw_text: text },
        ] });
      },
      () => say("Saved: Pull-up +15 kg × 7 + 2 partial."),
    ]);
    expect(r.status).toBe(200);
    expect(r.model.remaining()).toBe(0);
    const { turn } = r.body;
    expect(turn.sets).toHaveLength(1);
    expect(turn.sets[0]).toMatchObject({ exercise: "Pull-up", load_type: "added", load_kg: 15, full_reps: 7, partial_reps: 2 });
    expect(turn.reply.content).toContain("Saved");
    expect(turn.user.status).toBe("done");
    expect(turn.cost.calls).toBe(4);
    expect(turn.cost.token_usd).toBeGreaterThan(0);
    const raw = await q`select raw_text from trk_sets where id = ${turn.sets[0].id}`;
    expect(raw[0].raw_text).toBe(text);
    // The model saw the status and the request's text.
    expect(r.model.requests[0].system).toContain('"today":"2026-10-20"');
  });

  test("the three-set Pull 2 message creates three sets in order with the right loads", async () => {
    const text = "pull 2. weighted pullups, set 1 15 kg 8 reps, set 2 17.5 kg 7, set 3 17.5 kg 5 full one half";
    const r = await chat(msg(text), [
      () => ({ calls: [{ name: "get_status", args: {} }, { name: "find_exercise", args: { query: "weighted pullups" } }] }),
      ({ lastResults }) => {
        const session = lastResults.get_status.result.active_session.id;
        const id = lastResults.find_exercise.result.best.id;
        const set = (load_kg: number, full_reps: number, partial_reps = 0) =>
          ({ exercise_id: id, load_kg, load_type: "added", full_reps, partial_reps, raw_text: text });
        return call("log_sets", { session_id: session, sets: [set(15, 8), set(17.5, 7), set(17.5, 5, 1)] });
      },
      () => say("Logged 3 sets."),
    ]);
    expect(r.body.turn.sets.map((s: any) => [s.set_index, s.load_kg, s.full_reps, s.partial_reps])).toEqual([
      [2, 15, 8, 0], [3, 17.5, 7, 0], [4, 17.5, 5, 1],
    ]);
  });

  test("'machine row wide underhand 40 kg per side 9 9 9' creates three per_side sets with the variation", async () => {
    const text = "machine row wide underhand 40 kg per side 9 9 9";
    const r = await chat(msg(text), [
      () => ({ calls: [{ name: "get_status", args: {} }, { name: "find_exercise", args: { query: "machine row wide underhand" } }] }),
      ({ lastResults }) => {
        const best = lastResults.find_exercise.result.best;
        expect(best.extra_words).toBe("wide underhand");
        return call("log_sets", { session_id: lastResults.get_status.result.active_session.id, sets: [9, 9, 9].map((reps) => ({
          exercise_id: best.id, variation: best.extra_words, load_kg: 40, load_type: "per_side", full_reps: reps, raw_text: text,
        })) });
      },
      () => say("Logged."),
    ]);
    expect(r.body.turn.sets.map((s: any) => [s.load_type, s.load_kg, s.variation, s.full_reps])).toEqual([
      ["per_side", 40, "wide underhand", 9], ["per_side", 40, "wide underhand", 9], ["per_side", 40, "wide underhand", 9],
    ]);
  });

  test("'weighted pullips' matches the existing pull-up; create_exercise is refused", async () => {
    const r = await chat(msg("weighted pullips +20 kg 5"), [
      () => call("create_exercise", { name: "Weighted pullips", default_load_type: "added" }),
      ({ lastResults }) => {
        expect(lastResults.create_exercise.result.created).toBe(false);
        return call("find_exercise", { query: "weighted pullips" });
      },
      ({ lastResults }) => {
        expect(lastResults.find_exercise.result.best.name).toBe("Pull-up");
        return say("That's your pull-up.");
      },
    ]);
    expect(r.status).toBe(200);
    expect((await q`select count(*)::int as n from trk_exercises`)[0].n).toBe(5);
  });

  test("tool errors go back to the model, which can correct itself", async () => {
    const r = await chat(msg("curls 22.5 each 10"), [
      () => ({ calls: [{ name: "get_status", args: {} }, { name: "find_exercise", args: { query: "curls" } }] }),
      ({ lastResults }) => call("log_sets", { session_id: lastResults.get_status.result.active_session.id, sets: [
        { exercise_id: lastResults.find_exercise.result.best.id, load_type: "per_hand", full_reps: 10, raw_text: "curls 22.5 each 10" },
      ] }),
      ({ lastResults }) => {
        expect(lastResults.log_sets.error).toMatch(/load_kg is required/);
        return say("How heavy were the dumbbells?");
      },
    ]);
    expect(r.body.turn.sets).toHaveLength(0);
  });

  test("off-topic questions log nothing", async () => {
    const before = (await q`select count(*)::int as n from trk_sets`)[0].n;
    const r = await chat(msg("is the EZ bar easier on the wrists than dumbbells?"), [() => say("Usually, yes…")]);
    expect(r.body.turn.sets).toHaveLength(0);
    expect((await q`select count(*)::int as n from trk_sets`)[0].n).toBe(before);
  });

  test("a message at 01:30 Dublin logs to the previous day", async () => {
    clock = new Date("2026-10-22T00:30:00Z"); // 01:30 IST on the 22nd
    const r = await chat(msg("late session, starting now"), [
      ({ lastResults }) => (void lastResults, call("end_workout", { session_id: "00000000-0000-0000-0000-000000000000" })),
      ({ system }) => {
        expect(system).toContain('"today":"2026-10-21"');
        return say("ok");
      },
    ]);
    expect(r.body.turn.user.day).toBe("2026-10-21");
    // start_workout without a day uses the logical day too
    const active = (await q`select id from trk_workout_sessions where status = 'active'`)[0].id;
    await pg.sql`select trk_end_workout(${active}::uuid)`;
    const r2 = await chat(msg("start"), [() => call("start_workout", {}), () => say("started")]);
    expect(r2.status).toBe(200);
    expect((await q`select day::text from trk_workout_sessions where status = 'active'`)[0].day).toBe("2026-10-21");
    clock = new Date("2026-10-20T18:00:00Z");
  });

  test("sending the same client_message_id twice logs once and returns the first result", async () => {
    const input = msg("bw pull-ups 10");
    const steps = (): Step[] => [
      () => ({ calls: [{ name: "get_status", args: {} }, { name: "find_exercise", args: { query: "pull-ups" } }] }),
      ({ lastResults }) => call("log_sets", { session_id: lastResults.get_status.result.active_session.id, sets: [
        { exercise_id: lastResults.find_exercise.result.best.id, load_kg: 0, load_type: "added", full_reps: 10, raw_text: "bw pull-ups 10" },
      ] }),
      () => say("Logged."),
    ];
    const first = await chat(input, steps());
    const second = await chat(input, steps());
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.model.requests).toHaveLength(0);
    expect(second.body.turn).toEqual(first.body.turn);
    expect((await q`select count(*)::int as n from trk_sets where raw_text = 'bw pull-ups 10'`)[0].n).toBe(1);
  });

  test("the loop stops after 8 tool rounds with a forced final answer", async () => {
    const steps: Step[] = Array.from({ length: MAX_TOOL_ROUNDS }, () => () => call("get_status"));
    steps.push(() => say("Giving up."));
    const r = await chat(msg("loop forever"), steps);
    expect(r.body.turn.cost.calls).toBe(MAX_TOOL_ROUNDS + 1);
    expect(r.model.requests.at(-1)!.allowTools).toBe(false);
    expect(r.body.turn.reply.content).toBe("Giving up.");
  });

  test("with today's spend at the cap, chat refuses without calling the model and the log still works", async () => {
    clock = new Date("2026-11-05T12:00:00Z");
    await pg.sql`insert into trk_llm_calls (purpose, model, token_cost_usd, created_at)
                 values ('agent', 'gemini-3.8-flash', 1.00, '2026-11-05T09:00:00Z')`;
    const r = await chat(msg("bw pull-ups 8"), [() => say("should not be called")], 1);
    expect(r.status).toBe(402);
    expect(r.body.message).toMatch(/daily cap/);
    expect(r.model.requests).toHaveLength(0);
    expect(r.body.turn.reply.content).toMatch(/daily cap/);
    // the log view's reads don't touch Gemini
    const workouts = await pg.sql`select trk_day_workouts('2026-10-20') as w`;
    expect(workouts[0].w.length).toBeGreaterThan(0);
    clock = new Date("2026-10-20T18:00:00Z");
  });

  test("the cap is also checked between tool rounds", async () => {
    clock = new Date("2026-11-06T12:00:00Z");
    // Each scripted call costs 2000*0.75/1e6 + 150*3.75/1e6 = $0.0020625; a cap of $0.002 allows the first call only.
    const r = await chat(msg("x"), [() => call("get_status"), () => say("never")], 0.002);
    expect(r.status).toBe(402);
    expect(r.body.turn.cost.calls).toBe(1);
    clock = new Date("2026-10-20T18:00:00Z");
  });

  test("'30g nakpro perform' with a label photo saves the food once; next day reuses it with no search", async () => {
    clock = new Date("2026-11-20T09:00:00Z");
    const label = {
      name: "Perform Whey", brand: "Nakpro", aliases: ["nakpro perform"], kcal_per_100g: 393.3, protein_per_100g: 80,
      carbs_per_100g: 6.7, fat_per_100g: 5.3, fibre_per_100g: 0, serving_name: "scoop", serving_g: 33, source: "label_photo",
    };
    const photo = { mime_type: "image/jpeg", data: Buffer.from("fake jpeg").toString("base64") };
    const day1 = await chat(msg("30g of this", { mode: "food", image: photo }), [
      () => call("find_food", { query: "nakpro perform" }),
      ({ lastResults }) => {
        expect(lastResults.find_food.result.best).toBeNull();
        return call("save_food", label);
      },
      ({ lastResults }) => call("log_food", { day: "2026-11-20", items: [{
        raw_text: "30g of this", display_name: "Nakpro Perform", food_id: lastResults.save_food.result.food.id,
        quantity: 30, unit: "g", confidence: "label",
      }] }),
      () => say("Saved Nakpro Perform from the label: 30 g, 118 kcal, 24 g protein."),
    ]);
    const imagePart = day1.model.requests[0].contents.at(-1)!.parts![0];
    expect(imagePart.inlineData?.mimeType).toBe("image/jpeg");
    expect(String(imagePart.mediaResolution?.level)).toBe("MEDIA_RESOLUTION_HIGH");
    expect(day1.body.turn.user.has_image).toBe(true);
    expect(day1.body.turn.food_entries[0]).toMatchObject({ grams: 30, kcal: 118, protein_g: 24, confidence: "label" });

    // Next day it's in the food chat's prompt with its id and scoop size, so it's logged with no lookup at all.
    const foodId = day1.body.turn.food_entries[0].food_id;
    clock = new Date("2026-11-21T09:00:00Z");
    const day2 = await chat(msg("1 scoop nakpro perform", { mode: "food" }), [
      ({ system }) => {
        expect(system).toContain(`Nakpro Perform Whey (also: nakpro perform): food_id ${foodId}`);
        expect(system).toContain("1 scoop = 33 g; logged 1x, last 2026-11-20");
        return call("log_food", { day: "2026-11-21", items: [{
          raw_text: "1 scoop nakpro perform", display_name: "Nakpro Perform", food_id: foodId, quantity: 1, unit: "scoop",
        }] });
      },
      () => say("Logged."),
    ]);
    expect(day2.model.requests.length).toBe(2);
    expect(day2.model.requests.some((r) => r.googleSearch)).toBe(false);
    expect(day2.body.turn.food_entries[0]).toMatchObject({ grams: 33, confidence: "saved" });
    expect(Number(day2.body.turn.food_entries[0].protein_g)).toBeCloseTo(26.4);

    // The workout chat doesn't carry the list.
    const workout = await chat(msg("hi"), [({ system }) => {
      expect(system).not.toContain("MY RECENT FOODS (");
      return say("hi");
    }]);
    expect(workout.status).toBe(200);

    // A week without it drops it from the prompt; it stays in the library for find_food.
    clock = new Date("2026-11-28T09:00:00Z");
    await chat(msg("hi", { mode: "food" }), [({ system }) => {
      expect(system).not.toContain(foodId);
      expect(system).toContain("MY RECENT FOODS (");
      return say("hi");
    }]);
    expect((await q`select count(*)::int as n from trk_foods`)[0].n).toBe(1);
    // Images are never stored: only the has_image flag.
    expect((await q`select content from trk_messages where has_image`)[0].content).toBe("30g of this");
    clock = new Date("2026-10-20T18:00:00Z");
  });

  test("web_search is a separate grounded call with its own cost row", async () => {
    clock = new Date("2026-11-22T09:00:00Z");
    const r = await chat(msg("2 Lindt 70% squares", { mode: "food" }), [
      () => call("web_search", { query: "Lindt Excellence 70% nutrition per 100 g" }),
      // the grounded call made inside the tool
      () => searchResult("Lindt Excellence 70%: 566 kcal, 9.5 g protein per 100 g. 1 square ≈ 10 g.",
        ["lindt excellence 70 nutrition", "lindt 70 square weight"], ["https://www.lindt.example/70"]),
      ({ lastResults }) => {
        expect(lastResults.web_search.result.sources[0].uri).toBe("https://www.lindt.example/70");
        return call("save_food", { name: "Excellence 70%", brand: "Lindt", kcal_per_100g: 566, protein_per_100g: 9.5,
          carbs_per_100g: 34, fat_per_100g: 41, fibre_per_100g: 11.4, serving_name: "square", serving_g: 10,
          source: "web", source_url: "https://www.lindt.example/70" });
      },
      ({ lastResults }) => call("log_food", { day: "2026-11-22", items: [{
        raw_text: "2 Lindt 70% squares", display_name: "Lindt 70%", food_id: lastResults.save_food.result.food.id,
        quantity: 2, unit: "square",
      }] }),
      () => say("Logged 20 g, 113.2 kcal."),
    ]);
    const searchReq = r.model.requests[1];
    expect(searchReq.googleSearch).toBe(true);
    expect(searchReq.tools).toBeUndefined();
    // Saved from the web in this turn, so it's badged "label" without the model having to say so.
    expect(r.body.turn.food_entries[0]).toMatchObject({ grams: 20, kcal: 113.2, confidence: "label" });
    const calls = await q`select purpose, search_queries, search_cost_usd::float as s from trk_llm_calls
                          where message_id = ${r.body.turn.user.id} order by created_at`;
    const search = calls.find((c: any) => c.purpose === "search");
    expect(search).toMatchObject({ search_queries: 2, s: 0.028 });
    expect(r.body.turn.cost.search_usd).toBeCloseTo(0.028, 6);
    expect(calls.filter((c: any) => c.purpose === "agent")).toHaveLength(4);
    clock = new Date("2026-10-20T18:00:00Z");
  });

  test("telling the AI how I do an exercise saves it as notes on that exercise; renaming keeps it one exercise", async () => {
    const text = "I do machine rows on the Hammer Strength, seat 4, chest on the pad";
    const r = await chat(msg(text), [
      () => call("find_exercise", { query: "machine rows" }),
      ({ lastResults }) => call("update_exercise", {
        id: lastResults.find_exercise.result.best.id, append_note: "Hammer Strength, seat 4, chest on the pad.",
        equipment: "Hammer Strength plate-loaded",
      }),
      () => say("Saved how you do machine rows."),
    ]);
    expect(r.status).toBe(200);
    const row = (await q`select id, notes, equipment from trk_exercises where name = 'Machine row'`)[0];
    expect(row).toMatchObject({ notes: "Hammer Strength, seat 4, chest on the pad.", equipment: "Hammer Strength plate-loaded" });

    await chat(msg("rename machine row to Hammer Strength row"), [
      () => call("update_exercise", { id: row.id, name: "Hammer Strength row" }),
      () => say("Renamed."),
    ]);
    const renamed = (await q`select name, aliases from trk_exercises where id = ${row.id}`)[0];
    expect(renamed.name).toBe("Hammer Strength row");
    expect(renamed.aliases).toContain("Machine row");
    expect((await q`select count(*)::int as n from trk_exercises where deleted_at is null`)[0].n).toBe(5);
  });

  describe("trainer", () => {
    let legPress: string;
    let program: any;

    beforeAll(async () => {
      clock = new Date("2026-12-01T10:00:00Z");
      const store = bunStore(pg.sql);
      const data = dataLayer(store, { now: () => clock });
      const ex = async (name: string, type: string) =>
        (await data.findExercise({ query: name })).best?.id
          ?? ((await data.createExercise({ name, default_load_type: type as any })) as any).exercise.id;
      const pullup = await ex("Pull-up", "added");
      legPress = await ex("Leg press", "per_side");
      program = await data.setProgram({ name: "PPL x2", days: [
        { name: "Pull 1", exercises: [{ exercise_id: pullup, sets: 3, rep_min: 6, rep_max: 7, target_load_kg: 17.5, load_type: "added" }] },
        { name: "Legs 1", exercises: [{ exercise_id: legPress, variation: "feet high", sets: 3, rep_min: 10, rep_max: 12, target_load_kg: 75, load_type: "per_side" }] },
      ] });
      // last Pull 1: every set at the top of the range
      const s = await data.startWorkout({ day: "2026-11-28", program_day_id: program.days[0].id });
      await data.logSets({ session_id: s.session.id, sets: [1, 2, 3].map(() => (
        { exercise_id: pullup, load_kg: 17.5, load_type: "added" as const, full_reps: 7, raw_text: "17.5 x 7" })) });
      await data.endWorkout(s.session.id);
    });

    test("'what's my next workout?' gets Legs 1 from the rotation, as data for the model to reason over", async () => {
      const r = await chat(msg("hey, what's my next workout?"), [
        () => call("get_program_day", {}),
        ({ lastResults }) => {
          const brief = lastResults.get_program_day.result;
          expect(brief).toMatchObject({ program_day: { name: "Legs 1" }, chosen_because: "next in the rotation" });
          expect(brief.exercises[0]).toMatchObject({
            exercise: "Leg press",
            plan: { sets: 3, reps: "10-12", weight: "75 kg/side", variation: "feet high" },
            done_today: [], recent_sessions: [],
          });
          expect(brief.exercises[0].suggestion).toBeUndefined(); // the model reasons; no pre-baked answer
          return say("Legs 1 next: leg press feet high, 3 x 10-12 at 75 kg/side.");
        },
      ]);
      expect(r.status).toBe(200);
    });

    test("'today I'm doing pull 1, what's on it?' resolves the day and returns my history to reason from", async () => {
      await chat(msg("today I'm doing pull 1, what's on the list?"), [
        () => call("get_program_day", { program_day: "pull 1" }),
        ({ lastResults }) => {
          const ex = lastResults.get_program_day.result.exercises[0];
          expect(ex.plan).toMatchObject({ weight: "+17.5 kg", reps: "6-7" });
          expect(ex.recent_sessions[0]).toMatchObject({ day: "2026-11-28", sets: ["+17.5 kg × 7", "+17.5 kg × 7", "+17.5 kg × 7"] });
          return say("Pull-ups: you hit 7s across last time, go +20 kg today.");
        },
      ]);
      await chat(msg("is there a pull 9?"), [
        () => call("get_program_day", { program_day: "pull 9" }),
        ({ lastResults }) => {
          expect(lastResults.get_program_day.error).toMatch(/no program day called/);
          return say("No, your days are Pull 1 and Legs 1.");
        },
      ]);
    });

    test("'change my plan to belt squat instead of leg press' swaps the exercise in the plan only", async () => {
      await chat(msg("change my plan to add belt squat instead of leg press"), [
        () => ({ calls: [{ name: "find_exercise", args: { query: "belt squat" } }, { name: "get_program", args: {} }] }),
        ({ lastResults }) => {
          expect(lastResults.find_exercise.result.best).toBeNull();
          return call("create_exercise", { name: "Belt squat", default_load_type: "total" });
        },
        ({ contents, lastResults }) => {
          const prog = (contents.at(-3)!.parts![1].functionResponse!.response as any).result;
          const slot = prog.days[1].exercises[0];
          return call("update_program_exercise", {
            id: slot.id, fields: { exercise_id: lastResults.create_exercise.result.exercise.id, variation: null, target_load_kg: null, load_type: "total" },
            reason: "belt squat instead of leg press",
          });
        },
        () => say("Done: Legs 1 now has belt squat instead of leg press."),
      ]);
      const day = (await pg.sql`select trk_get_program() as p`)[0].p.days[1];
      expect(day.exercises.map((e: any) => e.exercise)).toEqual(["Belt squat"]);
      // the leg press itself and its history are untouched
      expect((await q`select count(*)::int as n from trk_exercises where id = ${legPress} and deleted_at is null`)[0].n).toBe(1);
    });

    test("add_program_exercise inserts at a position and shifts the rest down", async () => {
      const curl = (await q`select id from trk_exercises where name = 'EZ-bar curl'`)[0].id;
      await chat(msg("add EZ-bar curls first on pull 1, 3 x 8-12 at 30"), [
        () => call("add_program_exercise", { program_day: "pull 1", position: 1, exercise_id: curl, sets: 3, rep_min: 8, rep_max: 12, target_load_kg: 30, load_type: "total" }),
        () => say("Added."),
      ]);
      const day = (await pg.sql`select trk_get_program() as p`)[0].p.days[0];
      expect(day.exercises.map((e: any) => [e.order_index, e.exercise])).toEqual([[1, "EZ-bar curl"], [2, "Pull-up"]]);
    });

    afterAll(() => {
      clock = new Date("2026-10-20T18:00:00Z");
    });
  });

  test("chat history for the model is limited to today's last 20 messages of the mode", async () => {
    const r = await chat(msg("what did I do today?"), [() => say("…")]);
    const history = r.model.requests[0].contents.slice(0, -1);
    expect(history.length).toBeLessThanOrEqual(20);
    expect(history.length).toBeGreaterThan(0);
  });
});
