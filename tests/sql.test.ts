// SQL layer tests against a throwaway local Postgres with every migration applied.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hasPostgres, startPg } from "./helpers/pg";

type Pg = Awaited<ReturnType<typeof startPg>>;
let pg: Pg;

// First column of the first row.
async function val<T = any>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
  const rows = await pg.sql(strings, ...values);
  return Object.values(rows[0] as object)[0] as T;
}
const j = (v: unknown) => JSON.stringify(v);

// Bun SQL queries are lazy thenables, so expect(...).rejects never runs them; await explicitly.
async function throws(query: PromiseLike<unknown>, pattern?: RegExp) {
  try {
    await query;
  } catch (e) {
    if (pattern) expect((e as Error).message).toMatch(pattern);
    return;
  }
  throw new Error("expected the query to fail");
}

async function exerciseId(name: string): Promise<string> {
  return val`select id from trk_exercises where name = ${name}`;
}

const rice = {
  raw_text: "I ate 360 g of thin tarakadal and 100 g of cooked white rice",
  display_name: "Cooked white rice", quantity: 100, unit: "g", grams: 100,
  kcal: 130, protein_g: 2.7, carbs_g: 28.2, fat_g: 0.3, fibre_g: 0.4, confidence: "estimate", meal: "lunch",
};
const tarakadal = {
  raw_text: rice.raw_text, display_name: "Tarakadal (thin)", quantity: 360, unit: "g", grams: 360,
  kcal: 410, protein_g: 21.6, carbs_g: 50, fat_g: 12, fibre_g: 14, confidence: "estimate", meal: "lunch",
  assumptions: "assumed 1 tbsp oil for the tadka.",
};

describe.skipIf(!hasPostgres)("sql layer", () => {
  beforeAll(async () => { pg = await startPg(); }, 60_000);
  afterAll(async () => { await pg?.stop(); });

  describe("logical day", () => {
    test("01:30 Dublin (summer time) belongs to the previous day", async () => {
      expect(await val`select trk_logical_day('2026-10-19T00:30:00Z')::text`).toBe("2026-10-18");
    });
    test("04:30 Dublin is the new day", async () => {
      expect(await val`select trk_logical_day('2026-10-19T03:30:00Z')::text`).toBe("2026-10-19");
    });
    test("winter time: 03:59 Dublin (UTC+0) is still the previous day", async () => {
      expect(await val`select trk_logical_day('2026-12-01T03:59:00Z')::text`).toBe("2026-11-30");
      expect(await val`select trk_logical_day('2026-12-01T04:00:00Z')::text`).toBe("2026-12-01");
    });
    test("cutoff hour comes from settings", async () => {
      await pg.sql`update trk_settings set day_cutoff_hour = 2`;
      expect(await val`select trk_logical_day('2026-10-19T01:30:00Z')::text`).toBe("2026-10-19");
      await pg.sql`update trk_settings set day_cutoff_hour = 4`;
    });
  });

  describe("food and day summary", () => {
    const day = "2026-10-20";
    let riceId: string;

    test("log_food inserts in order and returns totals from the database", async () => {
      const res = await val<any>`select trk_log_food(${day}::date, ${j([tarakadal, rice])}::text::jsonb)`;
      expect(res.entries.map((e: any) => e.display_name)).toEqual(["Tarakadal (thin)", "Cooked white rice"]);
      expect(res.entries[0].raw_text).toBe(rice.raw_text);
      expect(res.entries[0].assumptions).toBe(tarakadal.assumptions);
      riceId = res.entries[1].id;
      expect(res.summary.totals).toEqual({ kcal: 540, protein_g: 24.3, carbs_g: 78.2, fat_g: 12.3, fibre_g: 14.4 });
      expect(res.summary.targets.kcal).toBe(2200);
      expect(res.summary.remaining).toEqual({ kcal: 1660, protein_g: 95.7, carbs_g: null, fat_g: null, fibre_g: 15.6 });
      expect(res.summary.by_meal.lunch.entries).toBe(2);
    });

    test("days before the first target have no targets", async () => {
      const s = await val<any>`select trk_day_summary('2026-10-01')`;
      expect(s.targets).toBeNull();
      expect(s.remaining).toBeNull();
      expect(s.entries).toBe(0);
    });

    test("'that rice was 150 g not 100' updates the row, logs the edit, and totals change", async () => {
      const edit = await val<any>`select trk_apply_edit('trk_food_entries', ${riceId}::uuid,
        ${j({ quantity: 150, grams: 150, kcal: 195, protein_g: 4.1, carbs_g: 42.3, fat_g: 0.5, fibre_g: 0.6 })}::text::jsonb,
        'rice was 150 g not 100', 'llm')`;
      expect(Number(edit.before.grams)).toBe(100);
      expect(Number(edit.after.grams)).toBe(150);
      const log = await pg.sql`select action, reason, before->>'kcal' b, after->>'kcal' a from trk_edit_log where id = ${edit.edit_id}`;
      expect(log[0]).toEqual({ action: "update", reason: "rice was 150 g not 100", b: "130.0", a: "195.0" });
      const s = await val<any>`select trk_day_summary(${day}::date)`;
      expect(s.totals.kcal).toBe(605);
    });

    test("undo restores the previous values and marks the edit undone", async () => {
      const undo = await val<any>`select trk_undo_edit()`;
      expect(Number(undo.row.grams)).toBe(100);
      expect(await val`select undone_at is not null from trk_edit_log where id = ${undo.undid}`).toBe(true);
      expect((await val<any>`select trk_day_summary(${day}::date)`).totals.kcal).toBe(540);
    });

    test("soft delete removes a row from totals; undo brings it back", async () => {
      await pg.sql`select trk_soft_delete('trk_food_entries', ${riceId}::uuid, 'did not eat it', 'ui')`;
      expect((await val<any>`select trk_day_summary(${day}::date)`).totals.kcal).toBe(410);
      expect(await val`select count(*)::int from trk_food_entries where id = ${riceId}`).toBe(1); // still there
      await pg.sql`select trk_undo_edit()`;
      expect((await val<any>`select trk_day_summary(${day}::date)`).totals.kcal).toBe(540);
    });

    test("undo refuses when a newer edit on the same row is still in place", async () => {
      const a = await val<any>`select trk_apply_edit('trk_food_entries', ${riceId}::uuid, '{"meal":"dinner"}', 'x', 'ui')`;
      await pg.sql`select trk_apply_edit('trk_food_entries', ${riceId}::uuid, '{"meal":"snack"}', 'y', 'ui')`;
      await throws(pg.sql`select trk_undo_edit(${a.edit_id}::uuid)`, /newer edit/);
      await pg.sql`select trk_undo_edit()`;
      await pg.sql`select trk_undo_edit()`;
      expect(await val`select meal::text from trk_food_entries where id = ${riceId}`).toBe("lunch");
    });

    test("edits are restricted to allowed tables and real, non-system columns", async () => {
      await throws(pg.sql`select trk_apply_edit('profiles', gen_random_uuid(), '{"x":1}', 'r', 'llm')`, /not editable/);
      await throws(pg.sql`select trk_apply_edit('trk_food_entries', ${riceId}::uuid, '{"id":"00000000-0000-0000-0000-000000000000"}', 'r', 'llm')`, /cannot edit/);
      await throws(pg.sql`select trk_apply_edit('trk_food_entries', ${riceId}::uuid, '{"kcal; drop table x":1}', 'r', 'llm')`, /cannot edit/);
      await throws(pg.sql`select trk_soft_delete('trk_rate_limit', gen_random_uuid(), 'r', 'llm')`, /not editable/);
    });

    test("late logging reopens a closed day and says so", async () => {
      const closed = await val<any>`select trk_end_day(${day}::date)`;
      expect(closed.status).toBe("closed");
      const res = await val<any>`select trk_log_food(${day}::date, ${j([{ ...rice, raw_text: "yesterday I also had 100 g rice" }])}::text::jsonb)`;
      expect(res.day).toEqual({ day, status: "open", reopened: true });
      expect(res.summary.status).toBe("open");
      expect(await val`select count(*)::int from trk_edit_log where table_name = 'trk_days' and reason = 'reopened for late logging'`).toBe(1);
    });

    test("an item without raw_text or confidence is rejected and nothing is inserted", async () => {
      const before = await val<number>`select count(*)::int from trk_food_entries`;
      await throws(pg.sql`select trk_log_food(${day}::date, ${j([rice, { ...rice, confidence: null }])}::text::jsonb)`);
      expect(await val`select count(*)::int from trk_food_entries`).toBe(before);
    });
  });

  describe("workouts", () => {
    const day = "2026-10-21";
    let sessionId: string;

    test("start_workout opens one session; a second start returns the active one", async () => {
      const a = await val<any>`select trk_start_workout(${day}::date)`;
      expect(a.already_active).toBe(false);
      sessionId = a.session.id;
      const b = await val<any>`select trk_start_workout(${day}::date)`;
      expect(b).toMatchObject({ already_active: true, session: { id: sessionId } });
    });

    test("three-set message logs three sets in order with mixed loads and partial reps", async () => {
      const pullup = await exerciseId("Pull-up");
      const raw = "pull 2. weighted pullups, set 1 15 kg 8 reps, set 2 17.5 kg 7, set 3 17.5 kg 5 full one half";
      const sets = [
        { exercise_id: pullup, load_kg: 15, load_type: "added", full_reps: 8, raw_text: raw },
        { exercise_id: pullup, load_kg: 17.5, load_type: "added", full_reps: 7, raw_text: raw },
        { exercise_id: pullup, load_kg: 17.5, load_type: "added", full_reps: 5, partial_reps: 1, raw_text: raw },
      ];
      const res = await val<any>`select trk_log_sets(${sessionId}::uuid, ${j(sets)}::text::jsonb)`;
      expect(res.sets.map((s: any) => [s.set_index, Number(s.load_kg), s.full_reps, s.partial_reps])).toEqual([
        [1, 15, 8, 0], [2, 17.5, 7, 0], [3, 17.5, 5, 1],
      ]);
      expect(res.session.total_sets).toBe(3);
    });

    test("per-side machine sets keep variation; set_index continues per exercise", async () => {
      const row = await exerciseId("Machine row");
      const pullup = await exerciseId("Pull-up");
      const raw = "machine row wide underhand 40 kg per side 9 9 9";
      const sets = [9, 9, 9].map((r) => ({
        exercise_id: row, variation: "wide underhand", load_kg: 40, load_type: "per_side", full_reps: r, raw_text: raw,
      }));
      sets.push({ exercise_id: pullup, variation: null as any, load_kg: 0, load_type: "added", full_reps: 6, raw_text: "bw pullups 6" });
      const res = await val<any>`select trk_log_sets(${sessionId}::uuid, ${j(sets)}::text::jsonb)`;
      expect(res.sets.map((s: any) => [s.exercise, s.set_index, s.load_type, s.variation])).toEqual([
        ["Machine row", 1, "per_side", "wide underhand"],
        ["Machine row", 2, "per_side", "wide underhand"],
        ["Machine row", 3, "per_side", "wide underhand"],
        ["Pull-up", 4, "added", null],
      ]);
      expect(res.session.exercises.map((e: any) => [e.name, e.working_sets])).toEqual([["Pull-up", 4], ["Machine row", 3]]);
    });

    test("a set needs a load unless it is bodyweight only", async () => {
      const pullup = await exerciseId("Pull-up");
      await throws(pg.sql`select trk_log_sets(${sessionId}::uuid, ${j([{ exercise_id: pullup, load_type: "added", full_reps: 5, raw_text: "x" }])}::text::jsonb)`);
      const ok = await val<any>`select trk_log_sets(${sessionId}::uuid, ${j([{ exercise_id: pullup, load_type: "bodyweight_only", full_reps: 5, rest_pause_reps: 2, raw_text: "x" }])}::text::jsonb)`;
      expect(ok.sets[0]).toMatchObject({ load_kg: null, rest_pause_reps: 2, set_index: 5 });
    });

    test("end_workout closes the session and returns its summary", async () => {
      const s = await val<any>`select trk_end_workout(${sessionId}::uuid)`;
      expect(s.session.status).toBe("ended");
      expect(s.total_sets).toBe(8);
    });

    test("exercise history groups sets by session and picks the top set", async () => {
      const pullup = await exerciseId("Pull-up");
      const h = await val<any>`select trk_exercise_history(${pullup}::uuid, 520)`;
      expect(h.exercise.name).toBe("Pull-up");
      expect(h.sessions).toHaveLength(1);
      expect(h.sessions[0].sets).toHaveLength(5);
      expect(h.sessions[0].top_set).toMatchObject({ load_kg: 17.5, full_reps: 7 });
    });
  });

  describe("status and program", () => {
    test("program rotation picks the day after the last session's day", async () => {
      const prog = await val<string>`insert into trk_programs (name, active) values ('PPL', true) returning id`;
      const days = await pg.sql`insert into trk_program_days (program_id, name, order_index)
        select ${prog}::uuid, n, i from (values ('Push 1', 1), ('Pull 1', 2), ('Legs 1', 3)) v(n, i) returning id, name`;
      const pull = days.find((d: any) => d.name === "Pull 1").id;
      const legs = days.find((d: any) => d.name === "Legs 1").id;
      const s = await val<any>`select trk_start_workout('2026-10-22', ${pull}::uuid)`;
      await pg.sql`select trk_end_workout(${s.session.id}::uuid)`;

      let st = await val<any>`select trk_status('2026-10-23T10:00:00Z')`;
      expect(st.today).toBe("2026-10-23");
      expect(st.today_program_day).toMatchObject({ id: legs, source: "rotation" });

      const s2 = await val<any>`select trk_start_workout('2026-10-23', ${legs}::uuid)`;
      await pg.sql`select trk_end_workout(${s2.session.id}::uuid)`;
      st = await val<any>`select trk_status('2026-10-24T10:00:00Z')`;
      expect(st.today_program_day.name).toBe("Push 1"); // wraps around

      const prog2 = await val<any>`select trk_get_program()`;
      expect(prog2.days.map((d: any) => d.name)).toEqual(["Push 1", "Pull 1", "Legs 1"]);
    });

    test("old sessions keep their program day after switching programs", async () => {
      const pullup = await exerciseId("Pull-up");
      const days = [
        { name: "Upper", exercises: [{ exercise_id: pullup, sets: 3, rep_min: 5, rep_max: 8, target_load_kg: 17.5, load_type: "added" }] },
        { name: "Lower", exercises: [] },
      ];
      const prog = await val<any>`select trk_set_program('Upper/Lower', ${j(days)}::text::jsonb)`;
      expect(prog.name).toBe("Upper/Lower");
      expect(prog.days[0].exercises[0]).toMatchObject({ exercise: "Pull-up", rep_min: 5, rep_max: 8, target_load_kg: 17.5 });
      expect(await val`select count(*)::int from trk_programs where active`).toBe(1);
      const h = await pg.sql`select pd.name from trk_workout_sessions w join trk_program_days pd on pd.id = w.program_day_id where w.day = '2026-10-22'`;
      expect(h[0].name).toBe("Pull 1");
      const st = await val<any>`select trk_status('2026-10-25T10:00:00Z')`;
      expect(st.today_program_day.name).toBe("Upper"); // no sessions yet in the new program
    });

    test("status lists earlier open days and the active session", async () => {
      const st = await val<any>`select trk_status('2026-10-25T10:00:00Z')`;
      expect(st.open_days).toEqual(expect.arrayContaining(["2026-10-20", "2026-10-21"]));
      expect(st.active_session).toBeNull();
      expect(st.today_summary.day).toBe("2026-10-25");
    });

    test("get_entries returns rows with ids and enforces the range cap", async () => {
      const food = await val<any[]>`select trk_get_entries('2026-10-20', '2026-10-20', 'food')`;
      expect(food.length).toBeGreaterThan(0);
      expect(food[0].id).toBeString();
      const sets = await val<any[]>`select trk_get_entries('2026-10-21', '2026-10-21', 'sets')`;
      expect(sets[0]).toHaveProperty("exercise");
      await throws(pg.sql`select trk_get_entries('2026-01-01', '2026-10-01', 'food')`, /range too long/);
      await throws(pg.sql`select trk_get_entries('2026-10-01', '2026-10-02', 'nope')`, /unknown type/);
    });
  });

  describe("rate limit, costs, last edit", () => {
    test("a burst of 10 requests in one second gets at least 8 refusals at 2/s", async () => {
      const results = [];
      for (let i = 0; i < 10; i++) results.push(await val<any>`select trk_rate_limit_hit('burst', 2, 1000)`);
      const refused = results.filter((r) => !r.allowed);
      expect(refused.length).toBeGreaterThanOrEqual(8);
      expect(refused[0].retry_after_ms).toBeGreaterThan(0);
    });

    test("the limiter frees up after the window passes", async () => {
      await val`select trk_rate_limit_hit('slow', 1, 200)`;
      expect((await val<any>`select trk_rate_limit_hit('slow', 1, 200)`).allowed).toBe(false);
      await Bun.sleep(450);
      expect((await val<any>`select trk_rate_limit_hit('slow', 1, 200)`).allowed).toBe(true);
    });

    test("cost report splits tokens and search per Dublin day and totals the month", async () => {
      await pg.sql`insert into trk_llm_calls (purpose, model, token_cost_usd, search_cost_usd, search_queries, created_at) values
        ('agent', 'm', 0.010, 0, 0, '2026-09-30T22:30:00Z'),  -- 23:30 Dublin on the 30th
        ('search', 'm', 0.002, 0.028, 2, '2026-09-30T23:30:00Z'), -- 00:30 Dublin on Oct 1
        ('agent', 'm', 0.005, 0, 0, '2026-10-03T12:00:00Z')`;
      const r = await val<any>`select trk_cost_report(30, '2026-10-03T18:00:00Z')`;
      expect(r.days).toHaveLength(30);
      expect(r.days[0].day).toBe("2026-10-03");
      const oct1 = r.days.find((d: any) => d.day === "2026-10-01");
      expect(oct1).toMatchObject({ token_usd: 0.002, search_usd: 0.028, searches: 2, calls: 1 });
      expect(r.days.find((d: any) => d.day === "2026-09-30").token_usd).toBe(0.01);
      expect(r.month_to_date).toEqual({ token_usd: 0.007, search_usd: 0.028, total_usd: 0.035 });
    });

    test("last edit is what undo would revert", async () => {
      const last = await val<any>`select trk_last_edit()`;
      const undo = await val<any>`select trk_undo_edit()`;
      expect(undo.undid).toBe(last.id);
    });
  });

  describe("day reports, completeness, history", () => {
    test("day report has food by meal against targets, workouts, and the previous top set per exercise", async () => {
      const r = await val<any>`select trk_day_report('2026-10-21')`;
      expect(r.day).toBe("2026-10-21");
      expect(r.workouts.length).toBeGreaterThan(0);
      expect(r.workouts[0].exercises.map((e: any) => e.name)).toContain("Pull-up");
      const pullup = await exerciseId("Pull-up");
      // 2026-10-21 is the first pull-up day, so nothing earlier to compare with
      expect(r.previous_top_sets[pullup]).toBeUndefined();
      const lunch = (await val<any>`select trk_day_report('2026-10-20')`).meals.find((m: any) => m.meal === "lunch");
      expect(lunch.items.map((i: any) => i.display_name)).toContain("Tarakadal (thin)");
      expect(r.summary).toBeNull();
    });

    test("marking a day incomplete is logged and drops it from the chart averages", async () => {
      const before = await val<any[]>`select trk_history(10, '2026-10-22T12:00:00Z')`;
      expect(before.find((d) => d.day === "2026-10-20").counts).toBe(true);
      const edit = await val<any>`select trk_set_day_completeness('2026-10-20', 'incomplete', 'forgot dinner')`;
      expect(edit.after).toMatchObject({ completeness: "incomplete", completeness_note: "forgot dinner" });
      const after = await val<any[]>`select trk_history(10, '2026-10-22T12:00:00Z')`;
      const d20 = after.find((d) => d.day === "2026-10-20");
      expect(d20).toMatchObject({ completeness: "incomplete", counts: false });
      expect(d20.kcal).toBeGreaterThan(0);
      expect(after).toHaveLength(10);
      expect(after[0]).toMatchObject({ day: "2026-10-22", is_today: true });
      await pg.sql`select trk_undo_edit()`;
      expect((await val<any>`select trk_day_report('2026-10-20')`).completeness).toBeNull();
    });

    test("finished days with logs and no summary are queued; saving a summary replaces the old one", async () => {
      const queued = await val<string[]>`select trk_days_to_summarize(7, '2026-10-23T12:00:00Z')`;
      expect(queued).toEqual(expect.arrayContaining(["2026-10-20", "2026-10-21", "2026-10-22"]));
      expect(queued).not.toContain("2026-10-23"); // today isn't finished
      await pg.sql`select trk_save_day_summary('2026-10-20', 'first', '{}', 'm', 'cron')`;
      await pg.sql`select trk_save_day_summary('2026-10-20', 'second', '{}', 'm', 'manual')`;
      expect((await val<any>`select trk_day_report('2026-10-20')`).summary).toMatchObject({ prose: "second", source: "manual" });
      expect(await val<string[]>`select trk_days_to_summarize(7, '2026-10-23T12:00:00Z')`).not.toContain("2026-10-20");
      expect((await val<any[]>`select trk_history(5, '2026-10-23T12:00:00Z')`).find((d) => d.day === "2026-10-20").summary).toBe("second");
    });
  });

  describe("stale sessions", () => {
    test("a session left open from an earlier day is closed instead of taking today's sets", async () => {
      const old = await val<any>`select trk_start_workout('2026-11-01')`;
      const pullup = await exerciseId("Pull-up");
      await pg.sql`select trk_log_sets(${old.session.id}::uuid, ${j([{ exercise_id: pullup, load_kg: 10, load_type: "added", full_reps: 5, raw_text: "x" }])}::text::jsonb)`;
      const next = await val<any>`select trk_start_workout('2026-11-03')`;
      expect(next).toMatchObject({ already_active: false, closed_stale_session: old.session.id, session: { day: "2026-11-03" } });
      const closed = (await pg.sql`select status::text, ended_at is not null as ended from trk_workout_sessions where id = ${old.session.id}::uuid`)[0];
      expect(closed).toEqual({ status: "ended", ended: true });
      // same day: reused, and it picks up the program day it was missing
      const pd = (await pg.sql`select id from trk_program_days limit 1`)[0].id;
      const again = await val<any>`select trk_start_workout('2026-11-03', ${pd}::uuid)`;
      expect(again).toMatchObject({ already_active: true, session: { id: next.session.id, program_day_id: pd } });
      await pg.sql`select trk_end_workout(${next.session.id}::uuid)`;
    });
  });

  describe("program brief", () => {
    test("a program day's brief has the prescription with its weight range, today's sets and recent sessions", async () => {
      const pullup = await exerciseId("Pull-up");
      const prog = await val<any>`select trk_set_program('PPL', ${j([
        { name: "Pull 1", exercises: [{ exercise_id: pullup, sets: 3, rep_min: 6, rep_max: 7, target_load_kg: 17.5,
          target_load_max_kg: 20, load_type: "added", note: "weighted" }] },
      ])}::text::jsonb)`;
      expect(prog.days[0].exercises[0]).toMatchObject({ target_load_kg: 17.5, target_load_max_kg: 20, load_type: "added" });
      const brief = await val<any>`select trk_program_day_brief(${prog.days[0].id}::uuid, '2026-10-21T19:00:00Z')`;
      expect(brief.program_day).toMatchObject({ name: "Pull 1", program: "PPL" });
      const ex = brief.exercises[0];
      expect(ex).toMatchObject({ exercise: "Pull-up", sets: 3, rep_min: 6, rep_max: 7, note: "weighted" });
      expect(ex.today_sets.length).toBeGreaterThan(0); // sets logged on the 21st in the workout tests
      const later = await val<any>`select trk_program_day_brief(${prog.days[0].id}::uuid, '2026-10-30T12:00:00Z')`;
      expect(later.exercises[0].today_sets).toEqual([]);
      expect(later.exercises[0].recent[0].day).toBe("2026-10-21");
      expect(await val`select trk_program_day_brief(gen_random_uuid())`).toBeNull();
    });
  });

  describe("exercise library", () => {
    test("lists every exercise with usage, most recently trained first, including notes", async () => {
      const pullup = await exerciseId("Pull-up");
      await pg.sql`update trk_exercises set notes = 'Weight belt, dead hang start' where id = ${pullup}::uuid`;
      const lib = await val<any[]>`select trk_exercise_library()`;
      expect(lib.length).toBeGreaterThanOrEqual(5);
      const p = lib.find((e) => e.name === "Pull-up");
      expect(p).toMatchObject({ notes: "Weight belt, dead hang start", default_load_type: "added" });
      expect(p.working_sets).toBeGreaterThan(0);
      expect(p.last_day).toBeString();
      expect(lib.find((e) => e.name === "EZ-bar curl")).toMatchObject({ sessions: 0, last_day: null });
      expect(lib[0].last_day).not.toBeNull(); // trained ones first
      const h = await val<any>`select trk_exercise_history(${pullup}::uuid, 52)`;
      expect(h.exercise).toMatchObject({ notes: "Weight belt, dead hang start", aliases: expect.arrayContaining(["pullup"]) });
    });
  });

  describe("security", () => {
    test("anon and authenticated can't read trk_ tables or call trk_ functions", async () => {
      const rows = await pg.sql`
        select r.rolname,
          bool_or(has_table_privilege(r.rolname, c.oid, 'select')) as can_read,
          bool_or(has_function_privilege(r.rolname, p.oid, 'execute')) as can_exec
        from pg_roles r
        cross join pg_class c
        cross join pg_proc p
        where r.rolname in ('anon', 'authenticated')
          and c.relname like 'trk\\_%' and c.relkind = 'r'
          and p.proname like 'trk\\_%'
        group by r.rolname`;
      for (const r of rows) expect(r).toMatchObject({ can_read: false, can_exec: false });
    });

    test("every trk_ table has RLS on and no policies", async () => {
      const r = await pg.sql`select count(*) filter (where not relrowsecurity)::int no_rls,
        (select count(*)::int from pg_policy p join pg_class c2 on c2.oid = p.polrelid where c2.relname like 'trk\\_%') policies
        from pg_class where relname like 'trk\\_%' and relkind = 'r'`;
      expect(r[0]).toEqual({ no_rls: 0, policies: 0 });
    });
  });
});
