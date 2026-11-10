// The MCP endpoint's protocol handling and the trackers it adds (water, activity, sleep, check-ins,
// measurements, routines, notes, targets), against a local Postgres with every migration applied.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dataLayer, type DataLayer } from "../lib/data";
import { mcpHandle, mcpTools, MCP_VERSIONS } from "../lib/mcp";
import { runTool, type ToolCtx } from "../lib/tools";
import { bunStore } from "./helpers/bun-store";
import { hasPostgres, startPg } from "./helpers/pg";

let pg: Awaited<ReturnType<typeof startPg>>;
let data: DataLayer;
let ctx: ToolCtx;

// 09:00 UTC on Tue 10 Nov 2026 = 09:00 in Dublin, so the logical day is 2026-11-10.
const NOW = new Date("2026-11-10T09:00:00Z");
const TODAY = "2026-11-10";

let nextId = 1;
async function rpc(method: string, params?: Record<string, unknown>) {
  return (await mcpHandle({ jsonrpc: "2.0", id: nextId++, method, params }, ctx)) as any;
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await rpc("tools/call", { name, arguments: args });
  const text = res.result.content[0].text as string;
  if (res.result.isError) throw new Error(text);
  return JSON.parse(text);
}

describe.skipIf(!hasPostgres)("mcp", () => {
  beforeAll(async () => {
    pg = await startPg();
    data = dataLayer(bunStore(pg.sql), { now: () => NOW });
    ctx = { data, source: "mcp" };
  }, 60_000);
  afterAll(async () => { await pg?.stop(); });

  describe("protocol", () => {
    test("initialize echoes a supported version and falls back to the newest for an unknown one", async () => {
      const a = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
      expect(a.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "swolify" } });
      expect(a.result.instructions).toContain("get_status");
      const b = await rpc("initialize", { protocolVersion: "1999-01-01" });
      expect(b.result.protocolVersion).toBe(MCP_VERSIONS[0]);
    });

    test("notifications get no reply; unknown methods and bad messages get JSON-RPC errors", async () => {
      expect(await mcpHandle({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx)).toBeNull();
      expect((await rpc("resources/list")).error.code).toBe(-32601);
      expect(await mcpHandle({ hello: "world" }, ctx)).toMatchObject({ id: null, error: { code: -32600 } });
      expect(await rpc("ping")).toMatchObject({ result: {} });
    });

    test("a batch answers only the requests in it", async () => {
      const res = await mcpHandle([
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: "a", method: "ping" },
      ], ctx);
      expect(res).toEqual([{ jsonrpc: "2.0", id: "a", result: {} }]);
    });

    test("tools/list has every tool except web_search, each with an object schema and read-only hints", async () => {
      const { tools } = (await rpc("tools/list")).result;
      const names = tools.map((t: { name: string }) => t.name);
      expect(names).toContain("log_sets");
      expect(names).toContain("log_food");
      expect(names).toContain("log_water");
      expect(names).not.toContain("web_search");
      expect(new Set(names).size).toBe(names.length);
      for (const t of mcpTools()) {
        expect(t.inputSchema.type).toBe("object");
        expect(t.description.length).toBeGreaterThan(20);
      }
      const byName = Object.fromEntries(mcpTools().map((t) => [t.name, t.annotations]));
      expect(byName.get_trends.readOnlyHint).toBe(true);
      expect(byName.log_water.readOnlyHint).toBe(false);
      expect(byName.delete_entry.destructiveHint).toBe(true);
    });

    test("an unknown tool is a protocol error; bad arguments are a tool error the model can read", async () => {
      expect((await rpc("tools/call", { name: "web_search", arguments: { query: "protein bar" } })).error.code).toBe(-32602);
      const bad = await rpc("tools/call", { name: "log_water", arguments: { drinks: [{ ml: -5 }] } });
      expect(bad.result.isError).toBe(true);
      expect(bad.result.content[0].text).toMatch(/invalid arguments/);
    });
  });

  describe("trackers", () => {
    test("water adds up against the target set with set_targets, which also records the decision", async () => {
      const set = await call("set_targets", { water_ml: 3000, reason: "Skin looks better when I drink more" });
      expect(set.targets).toMatchObject({ water_ml: 3000, effective_from: TODAY });
      expect(Number(set.targets.kcal)).toBe(2200); // carried over from the earlier targets
      const res = await call("log_water", { drinks: [{ ml: 250 }, { ml: 500, drink: "electrolytes" }] });
      expect(res.day).toBe(TODAY);
      expect(res.water).toMatchObject({ total_ml: 750, target_ml: 3000 });
      expect(res.water.drinks.map((d: { drink: string }) => d.drink)).toEqual(["water", "electrolytes"]);

      const notes = await call("get_notes", { kind: "decision" });
      expect(notes).toHaveLength(1);
      expect(notes[0].body).toContain("Skin looks better");

      // changing them again the same day edits that row instead of adding a second one
      const again = await call("set_targets", { water_ml: 3500, protein_g: 140, reason: "Bulking a little" });
      expect(again.previous).toEqual({ water_ml: 3000, protein_g: 120 });
      expect(await pg.psql(`select count(*) from trk_targets where effective_from = '${TODAY}' and deleted_at is null`)).toBe("1\n");
    });

    test("sodium is carried from a saved food and summed only over entries that have it", async () => {
      const { food } = await call("save_food", {
        name: "Masala noodles", kcal_per_100g: 450, protein_per_100g: 9, sodium_mg_per_100g: 1200, source: "manual", serving_g: 70,
      });
      const res = await call("log_food", {
        day: TODAY,
        items: [
          { raw_text: "a packet of masala noodles", display_name: "Masala noodles", food_id: food.id, quantity: 1, unit: "serving" },
          { raw_text: "an apple", display_name: "Apple", kcal: 95 },
        ],
      });
      expect(Number(res.entries[0].sodium_mg)).toBe(840);
      expect(res.entries[1].sodium_mg).toBeNull();
      expect(res.summary.sodium).toEqual({ mg: 840, entries_with_sodium: 1, entries_without: 1 });

      const edit = await call("update_entry", { table: "trk_food_entries", id: res.entries[0].id, fields: { grams: 35 }, reason: "ate half" });
      expect(Number(edit.after.sodium_mg)).toBe(420);
      expect(edit.before.sodium_mg).not.toBe(edit.after.sodium_mg);
      expect(await pg.psql("select distinct source from trk_edit_log where reason = 'ate half'")).toBe("mcp\n");
      const undone = await call("undo_edit", { edit_id: edit.edit_id });
      expect(Number(undone.row.sodium_mg)).toBe(840);
    });

    test("activity, measurements, sleep and the check-in land on the right day and show in the day report", async () => {
      await call("log_activity", { kind: "Walk", duration_min: 40, distance_km: 3.2, kcal_burned: 160, raw_text: "40 min walk, 3.2 km" });
      await call("log_measurements", { readings: [{ metric: "body_fat_pct", value: 20.8 }, { metric: "steps", value: 8400 }] });
      await call("log_bodyweight", { kg: 78 });

      const sleep = await call("log_sleep", { bed_at: "2026-11-09T23:30:00Z", wake_at: "2026-11-10T07:00:00Z", quality: 3 });
      expect(sleep).toMatchObject({ day: TODAY, action: "created" });
      expect(Number(sleep.row.hours)).toBe(7.5);
      const fixed = await call("log_sleep", { day: TODAY, quality: 4 }); // same night: corrected, not duplicated
      expect(fixed.action).toBe("updated");
      expect(Number(fixed.row.hours)).toBe(7.5);

      await call("log_checkin", { energy: 4, skin: "less puffy" });
      await call("log_checkin", { mood: 5 });

      const report = await call("get_day_report", { day: TODAY });
      expect(report.wellness).toMatchObject({
        active_kcal: 160, steps: 8400,
        sleep: { hours: 7.5, quality: 4 },
        checkin: { energy: 4, mood: 5, skin: "less puffy" },
      });
      expect(report.wellness.activities[0]).toMatchObject({ kind: "walk", distance_km: 3.2 });
      expect(report.nutrition.entries).toBe(2);

      const status = await call("get_status");
      expect(status.today).toBe(TODAY);
      expect(status.today_wellness.water.total_ml).toBe(750);
      // asks only for what's still missing: the check-in has no stress or hunger yet, nothing is ticked
      expect(status.not_logged_today).toEqual([
        "rest of the check-in: stress, hunger",
        "routine not ticked yet: Adapalene, Azelaic acid, Moisturiser, Sunscreen, Creatine, Fish oil, Vitamin D3",
      ]);
      // the in-app chat can't log these, so it isn't told
      const inApp = await runTool("get_status", {}, { data });
      expect(inApp.ok && "not_logged_today" in (inApp.result as object)).toBe(false);

      const rows = await call("get_entries", { from: TODAY, to: TODAY, type: "measurement" });
      expect(rows.map((r: { metric: string }) => r.metric).sort()).toEqual(["body_fat_pct", "steps"]);
      await expect(call("log_sleep", { day: "2026-11-08" })).rejects.toThrow(/give hours/);
    });

    test("routine items tick once a day by fuzzy name, and streaks count back from today or yesterday", async () => {
      const first = await call("tick_routine", { items: ["d3", "creatin", "retinol"] });
      expect(first.ticked.sort()).toEqual(["Creatine", "Vitamin D3"]);
      expect(first.not_found).toEqual(["retinol"]);
      expect(first.known_items).toContain("Adapalene");
      expect(first.still_to_do).toContain("Fish oil");

      const second = await call("tick_routine", { all_of_kind: "supplement" });
      expect(second.ticked).toEqual(["Fish oil"]);
      expect(second.already_done.sort()).toEqual(["Creatine", "Vitamin D3"]);

      await call("tick_routine", { day: "2026-11-09", items: ["creatine"] });
      await call("tick_routine", { day: "2026-11-08", items: ["creatine"] });
      await call("tick_routine", { day: "2026-11-06", items: ["creatine", "sunscreen"] });

      const added = await call("save_routine_item", { name: "Magnesium", kind: "supplement", dose: "400 mg", schedule: "night" });
      expect(added.action).toBe("created");

      const trends = await call("get_trends", { days: 14 });
      const streak = Object.fromEntries(trends.routine.map((r: { name: string }) => [r.name, r]));
      expect(streak.Creatine).toMatchObject({ current_streak: 3, done_today: true, done_last_7d: 4 });
      expect(streak.Sunscreen).toMatchObject({ current_streak: 0, done_today: false, done_in_range: 1 });
      expect(streak.Magnesium.current_streak).toBe(0);

      // un-ticking is a normal, undoable delete
      const today = await call("get_routine");
      const d3 = today.items.find((i: { name: string }) => i.name === "Vitamin D3");
      await call("delete_entry", { table: "trk_routine_logs", id: d3.log_id, reason: "didn't actually take it" });
      expect((await call("get_routine")).items.find((i: { name: string }) => i.name === "Vitamin D3").done).toBe(false);
    });

    test("trends give the weight average, weekly averages and the latest body measurements", async () => {
      await call("log_bodyweight", { kg: 79, measured_at: "2026-11-08T08:00:00Z" });
      const t = await call("get_trends", { days: 14 });
      expect(t.today).toBe(TODAY);
      expect(t.days).toHaveLength(14);
      expect(t.days[0]).toMatchObject({ day: TODAY, weight_kg: 78, weight_7d_avg: 78.5, water_ml: 750, sleep_hours: 7.5, steps: 8400 });
      expect(t.weight).toMatchObject({ latest_kg: 78, latest_day: TODAY, avg_7d: 78.5, readings_last_7d: 2 });
      expect(t.body).toEqual([{ metric: "body_fat_pct", value: 20.8, day: TODAY }]);
      const week = t.weeks.find((w: { week_start: string }) => w.week_start === "2026-11-09");
      expect(week).toMatchObject({ water_ml: 750, sleep_hours: 7.5, steps: 8400, active_kcal: 160 });
    });

    test("notes are added, rewritten by id and listed newest first", async () => {
      const a = await call("save_note", { kind: "profile", title: "Basics", body: "78 kg, 20.8% body fat" });
      await call("save_note", { kind: "goal", title: "Cut", body: "Get to 15% body fat" });
      const b = await call("save_note", { id: a.row.id, kind: "profile", title: "Basics", body: "78 kg, 20.8% body fat, vegetarian" });
      expect(b.action).toBe("updated");
      const profile = await call("get_notes", { kind: "profile" });
      expect(profile).toHaveLength(1);
      expect(profile[0].body).toContain("vegetarian");
      expect((await call("get_notes"))[0].kind).toBe("goal");
    });
  });
});
