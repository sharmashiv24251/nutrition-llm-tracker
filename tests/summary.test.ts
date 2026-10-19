// The nightly summary job and day completeness, with a scripted model, against a local Postgres.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dataLayer, type DataLayer } from "../lib/data";
import { summarizeDay, summarizePending } from "../lib/summary";
import { bunStore } from "./helpers/bun-store";
import { hasPostgres, startPg } from "./helpers/pg";
import { say, scriptedModel } from "./helpers/scripted-model";

let pg: Awaited<ReturnType<typeof startPg>>;
let data: DataLayer;
const morningAfter = new Date("2026-10-21T04:40:00Z"); // 05:40 Dublin on the 21st: the 20th is finished

describe.skipIf(!hasPostgres)("daily summaries", () => {
  beforeAll(async () => {
    pg = await startPg();
    data = dataLayer(bunStore(pg.sql), { now: () => morningAfter });
    const pullup = (await data.findExercise({ query: "pull-ups" })).best!.id;
    const session = (await data.startWorkout({ day: "2026-10-20" })).session.id;
    await data.logSets({ session_id: session, sets: [
      { exercise_id: pullup, load_kg: 15, load_type: "added", full_reps: 8, raw_text: "15 kg x 8" },
      { exercise_id: pullup, load_kg: 17.5, load_type: "added", full_reps: 6, partial_reps: 1, raw_text: "17.5 x 6 + half" },
    ] });
    await data.endWorkout(session);
    await data.logFood({ day: "2026-10-20", items: [
      { raw_text: "rice", display_name: "Cooked white rice", grams: 200, kcal: 260, protein_g: 5.4, meal: "lunch" },
      { raw_text: "paneer", display_name: "Chilli paneer", grams: 210, kcal: 590, protein_g: 31, meal: "dinner",
        assumptions: "assumed 2 tbsp oil." },
    ] });
  }, 60_000);
  afterAll(async () => { await pg?.stop(); });

  const deps = (model: ReturnType<typeof scriptedModel>, capUsd = 1) =>
    ({ store: bunStore(pg.sql), model, capUsd, now: () => morningAfter });

  test("the nightly job writes prose from the structured report and logs the call's cost", async () => {
    const model = scriptedModel([
      ({ contents }) => {
        const input = JSON.parse(contents[0].parts![0].text!);
        expect(input.nutrition.totals.kcal).toBe(850);
        expect(input.workouts[0].exercises[0]).toMatchObject({ name: "Pull-up", sets: ["+15 kg x 8", "+17.5 kg x 6 + 1 partial"] });
        expect(input.meals.map((m: any) => m.meal)).toEqual(["lunch", "dinner"]);
        return say("Pull day: you hit +17.5 kg x 6 + 1 partial. You ate 850 kcal against a 2200 ceiling.");
      },
    ]);
    const run = await summarizePending(deps(model));
    expect(run.days).toEqual(["2026-10-20"]);
    expect(run.results).toEqual([{ day: "2026-10-20", ok: true }]);
    expect(model.requests[0].tools).toBeUndefined(); // a plain write-up call, no tools
    const report = await data.dayReport("2026-10-20");
    expect(report.summary).toMatchObject({ source: "cron", prose: expect.stringContaining("Pull day") });
    const calls = await pg.sql`select purpose::text, token_cost_usd::float as c from trk_llm_calls`;
    expect(calls).toEqual([{ purpose: "summary", c: expect.any(Number) }]);
    expect(calls[0].c).toBeGreaterThan(0);
  });

  test("running the job again does nothing (idempotent)", async () => {
    const model = scriptedModel([]);
    const run = await summarizePending(deps(model));
    expect(run.days).toEqual([]);
    expect(model.requests).toHaveLength(0);
  });

  test("regenerating replaces the summary; the history row shows it", async () => {
    await summarizeDay("2026-10-20", "manual", deps(scriptedModel([() => say("Second take.")])));
    const history = await data.history(7);
    expect(history.find((d) => d.day === "2026-10-20")).toMatchObject({ summary: "Second take.", kcal: 850, working_sets: 2 });
  });

  test("with the spend cap reached, no model call is made", async () => {
    await pg.sql`insert into trk_llm_calls (purpose, model, token_cost_usd, created_at) values ('agent', 'm', 5, ${morningAfter.toISOString()})`;
    const model = scriptedModel([]);
    await expect(summarizeDay("2026-10-20", "manual", deps(model))).rejects.toThrow(/spend cap/);
    expect(model.requests).toHaveLength(0);
  });

  test("a day with nothing logged gets a fixed line and no model call", async () => {
    const model = scriptedModel([]);
    const row = await summarizeDay("2026-10-15", "manual", deps(model, 100));
    expect(row.prose).toBe("Nothing was logged on this day.");
    expect(model.requests).toHaveLength(0);
  });

  test("marking a day incomplete reaches the report and leaves it out of the averages", async () => {
    await data.setDayCompleteness({ day: "2026-10-20", completeness: "incomplete", note: "forgot snacks" }, { source: "llm" });
    const report = await data.dayReport("2026-10-20");
    expect(report).toMatchObject({ completeness: "incomplete", completeness_note: "forgot snacks" });
    expect((await data.history(7)).find((d) => d.day === "2026-10-20")!.counts).toBe(false);
    await data.setDayCompleteness({ day: "2026-10-20", completeness: "complete" });
    expect((await data.history(7)).find((d) => d.day === "2026-10-20")!.counts).toBe(true);
  });
});
