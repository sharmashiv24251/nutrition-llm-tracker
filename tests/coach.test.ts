import { describe, expect, test } from "bun:test";
import { loadRange, suggest, trend, type BriefExercise, type BriefSet } from "../lib/coach";

const set = (load_kg: number | null, full_reps: number, extra: Partial<BriefSet> = {}): BriefSet => ({
  load_kg, load_type: "added", full_reps, partial_reps: 0, rest_pause_reps: 0, is_warmup: false, variation: null, rpe: null,
  ...extra,
});

const pullups = (recent: BriefExercise["recent"], today: BriefSet[] = []): BriefExercise => ({
  program_exercise_id: "pe", exercise_id: "ex", exercise: "Pull-up", exercise_notes: null, variation: null,
  sets: 3, rep_min: 6, rep_max: 7, target_load_kg: 17.5, target_load_max_kg: null, load_type: "added", note: null,
  today_sets: today, recent,
});

describe("next-session suggestion (double progression)", () => {
  test("no history: start at the planned weight", () => {
    expect(suggest(pullups([]))).toMatchObject({ load_kg: 17.5, load: "+17.5 kg", reps: "6-7" });
  });

  test("every set hit the top of the range: go up one step", () => {
    const s = suggest(pullups([{ day: "2026-10-15", sets: [set(17.5, 7), set(17.5, 7), set(17.5, 7)] }]));
    expect(s).toMatchObject({ load_kg: 20, load: "+20 kg", reps: "6-7" });
    expect(s.why).toMatch(/go up/);
  });

  test("in range but not all at the top: same weight, one more rep where possible", () => {
    const s = suggest(pullups([{ day: "2026-10-15", sets: [set(17.5, 7), set(17.5, 6), set(17.5, 6)] }]));
    expect(s).toMatchObject({ load_kg: 17.5, reps: "7, 7, 7" });
  });

  test("warm-ups are ignored and the working weight is the one most sets used", () => {
    const s = suggest(pullups([{ day: "d", sets: [set(5, 10, { is_warmup: true }), set(17.5, 6), set(17.5, 6), set(15, 8)] }]));
    expect(s.load_kg).toBe(17.5);
  });

  test("under the range twice at the same weight: drop a step", () => {
    const s = suggest(pullups([
      { day: "2026-10-17", sets: [set(20, 5), set(20, 4), set(20, 4)] },
      { day: "2026-10-15", sets: [set(20, 5), set(20, 5), set(20, 4)] },
    ]));
    expect(s).toMatchObject({ load_kg: 17.5 });
    expect(s.why).toMatch(/two sessions/);
  });

  test("per-side machines step 2.5 kg, light dumbbells step 1 kg", () => {
    const rowSets = [40, 40, 40].map((l) => set(l, 12, { load_type: "per_side" }));
    const row: BriefExercise = { ...pullups([{ day: "d", sets: rowSets }]), load_type: "per_side", rep_min: 8, rep_max: 12 };
    expect(suggest(row)).toMatchObject({ load_kg: 42.5, load: "42.5 kg/side" });
    const raiseSets = [7.5, 7.5, 7.5, 7.5].map((l) => set(l, 15, { load_type: "per_hand" }));
    const raise: BriefExercise = { ...pullups([{ day: "d", sets: raiseSets }]), load_type: "per_hand", sets: 4, rep_min: 12, rep_max: 15 };
    expect(suggest(raise)).toMatchObject({ load_kg: 8.5, load: "8.5 kg each" });
  });

  test("sets with a different load type or a different grip don't count; plan weight is used instead", () => {
    const pd: BriefExercise = { ...pullups([{ day: "d", sets: [
      set(55, 12, { load_type: "total", variation: "neutral grip" }),
      set(35, 12, { load_type: "per_side", variation: "neutral grip" }),
    ] }]), load_type: "per_side", variation: "wide", rep_min: 8, rep_max: 12, target_load_kg: 27.5 };
    expect(suggest(pd)).toMatchObject({ load_kg: 27.5, load: "27.5 kg/side" });
    expect(suggest(pd).why).toMatch(/No history/);
    // sets logged without a grip still count for a planned grip
    const plain: BriefExercise = { ...pd, recent: [{ day: "d", sets: [30, 30, 30].map((l) => set(l, 10, { load_type: "per_side" })) }] };
    expect(suggest(plain)).toMatchObject({ load_kg: 30, reps: "11, 11, 11" });
  });

  test("the planned variation's sets are used when it has been logged", () => {
    const pd: BriefExercise = { ...pullups([{ day: "d", sets: [
      set(35, 12, { load_type: "per_side", variation: "neutral grip" }), set(35, 12, { load_type: "per_side", variation: "neutral grip" }),
      set(35, 12, { load_type: "per_side", variation: "neutral grip" }), set(30, 9, { load_type: "per_side", variation: "wide" }),
    ] }]), load_type: "per_side", variation: "neutral grip", rep_min: 10, rep_max: 12 };
    expect(suggest(pd)).toMatchObject({ load_kg: 37.5 });
  });
});

describe("next set during a session", () => {
  test("in range: stay; counts the sets left", () => {
    expect(suggest(pullups([], [set(17.5, 7)]))).toMatchObject({ load_kg: 17.5, sets_left: 2 });
  });
  test("well past the top: go up; under the floor: drop", () => {
    expect(suggest(pullups([], [set(17.5, 10)]))).toMatchObject({ load_kg: 20 });
    expect(suggest(pullups([], [set(17.5, 4)]))).toMatchObject({ load_kg: 15 });
  });
  test("all planned sets done", () => {
    expect(suggest(pullups([], [set(17.5, 7), set(17.5, 7), set(17.5, 6)]))).toMatchObject({ sets_left: 0 });
  });
});

describe("plan weights", () => {
  test("ranges read compactly", () => {
    expect(loadRange(27.5, 30, "per_side")).toBe("27.5–30 kg/side");
    expect(loadRange(77.5, 80, "total")).toBe("77.5–80 kg");
    expect(loadRange(17.5, 20, "added")).toBe("+17.5–20 kg");
  });
});

describe("trend", () => {
  const sessions = (...tops: [number, number][]) =>
    tops.map(([l, r], i) => ({ day: `2026-10-${String(20 - i * 2).padStart(2, "0")}`, sets: [set(l, r)] }));

  test("new best: progressing", () => {
    expect(trend(pullups(sessions([20, 6], [17.5, 7], [17.5, 6], [15, 7]))).status).toBe("progressing");
  });
  test("same weight, more reps also counts as progress", () => {
    expect(trend(pullups(sessions([17.5, 7], [17.5, 6]))).status).toBe("progressing");
  });
  test("matched the best: holding", () => {
    expect(trend(pullups(sessions([17.5, 7], [17.5, 7], [17.5, 6]))).status).toBe("holding");
  });
  test("not a new best but not worse than 3 sessions ago: stalled", () => {
    expect(trend(pullups(sessions([17.5, 6], [17.5, 7], [17.5, 6], [17.5, 6]))).status).toBe("stalled");
  });
  test("below where it was 3 sessions ago: dipping", () => {
    expect(trend(pullups(sessions([15, 6], [17.5, 7], [17.5, 6], [17.5, 6]))).status).toBe("dipping");
  });
  test("one session: new", () => {
    expect(trend(pullups(sessions([17.5, 6]))).status).toBe("new");
  });
});
