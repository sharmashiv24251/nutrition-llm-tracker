// Trainer logic: what weight and reps to do next, and whether an exercise is progressing. Deterministic, so the
// model only explains the numbers and two asks of the same question get the same answer.
//
// Progression is standard double progression: stay at a weight and add reps until every working set reaches the
// top of the rep range, then go up one step and start again at the bottom of the range.
import { formatLoad, formatSet, type LoadType } from "./format";

export type BriefSet = {
  load_kg: number | null;
  load_type: LoadType;
  full_reps: number;
  partial_reps: number;
  rest_pause_reps: number;
  is_warmup: boolean;
  variation: string | null;
  rpe: number | null;
};

export type BriefExercise = {
  program_exercise_id: string;
  exercise_id: string;
  exercise: string;
  exercise_notes: string | null;
  variation: string | null;
  sets: number | null;
  rep_min: number | null;
  rep_max: number | null;
  target_load_kg: number | null;
  target_load_max_kg: number | null;
  load_type: LoadType;
  note: string | null;
  today_sets: BriefSet[];
  recent: { day: string; sets: BriefSet[] }[];
};

export type Suggestion = {
  load_kg: number | null;
  load: string; // "+20 kg", "40 kg/side"
  reps: string; // "6-8" or "8, 8, 7"
  sets_left: number | null;
  why: string;
};

export type Trend = { status: "new" | "progressing" | "holding" | "stalled" | "dipping"; detail: string };

/** Smallest sensible jump for this kind of load. */
export function increment(loadType: LoadType, load: number): number {
  if (loadType === "bodyweight_only") return 0;
  if (loadType === "per_hand") return load < 10 ? 1 : 2.5;
  return 2.5;
}

const working = (sets: BriefSet[]) => sets.filter((s) => !s.is_warmup);
const heaviness = (s: BriefSet) => (s.load_type === "assisted" ? -1 : 1) * Number(s.load_kg ?? 0);

/** > 0 when a is the better set: heavier, or the same weight for more reps. */
export function compareSets(a: BriefSet, b: BriefSet): number {
  return heaviness(a) - heaviness(b) || a.full_reps - b.full_reps || a.partial_reps - b.partial_reps;
}

const topSet = (sets: BriefSet[]) => [...working(sets)].sort(compareSets).at(-1) ?? null;

/**
 * Past sets that are comparable with the plan: same load type (40 kg/side and 40 kg total are different
 * weights), and the planned variation or no variation noted. A different grip with its own working weight
 * (neutral vs wide pulldown) isn't used to suggest the other.
 */
function matching(sets: BriefSet[], variation: string | null, loadType: LoadType): BriefSet[] {
  const v = variation?.toLowerCase() ?? null;
  return sets.filter((s) => s.load_type === loadType && (!v || !s.variation || s.variation.toLowerCase() === v));
}

/** The weight most working sets used (ties go to the heavier one). */
function workingLoad(sets: BriefSet[]): number {
  const counts = new Map<number, number>();
  for (const s of sets) counts.set(Number(s.load_kg ?? 0), (counts.get(Number(s.load_kg ?? 0)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
}

const round = (n: number) => Math.round(n * 100) / 100;
const range = (min: number | null, max: number | null) =>
  min != null && max != null ? (min === max ? `${min}` : `${min}-${max}`) : `${min ?? max ?? "?"}`;

function load(kg: number | null, type: LoadType): string {
  return formatLoad(kg, type);
}

/** "27.5–30 kg/side", "77.5–80 kg", "+17.5–20 kg" */
export function loadRange(min: number, max: number, type: LoadType): string {
  return type === "added" ? `+${min}–${max} kg` : `${min}–${formatLoad(max, type)}`;
}

/** Next weight and reps: for the next set if sets are already logged today, otherwise for the next session. */
export function suggest(ex: BriefExercise): Suggestion {
  const type = ex.load_type;
  const reps = range(ex.rep_min, ex.rep_max);
  const today = working(matching(ex.today_sets, ex.variation, ex.load_type));

  if (today.length) {
    const last = today.at(-1)!;
    const L = Number(last.load_kg ?? 0);
    const step = increment(type, L) * (type === "assisted" ? -1 : 1);
    const setsLeft = ex.sets != null ? Math.max(0, ex.sets - today.length) : null;
    if (setsLeft === 0) {
      return { load_kg: L, load: load(L, type), reps, sets_left: 0, why: `All ${ex.sets} planned sets are done.` };
    }
    if (ex.rep_max != null && last.full_reps >= ex.rep_max + 2 && step !== 0) {
      const next = round(Math.max(0, L + step));
      return { load_kg: next, load: load(next, type), reps, sets_left: setsLeft,
        why: `${last.full_reps} reps is well past ${ex.rep_max}, so the weight is too light; go up a step.` };
    }
    if (ex.rep_min != null && last.full_reps < ex.rep_min && step !== 0) {
      const next = round(Math.max(0, L - step));
      return { load_kg: next, load: load(next, type), reps, sets_left: setsLeft,
        why: `${last.full_reps} reps is under the ${ex.rep_min}-rep floor; drop a step to stay in range.` };
    }
    return { load_kg: L, load: load(L, type), reps, sets_left: setsLeft,
      why: `${last.full_reps} reps at ${load(L, type)} is in range; stay there.` };
  }

  const sessions = ex.recent.map((r) => working(matching(r.sets, ex.variation, ex.load_type))).filter((s) => s.length);
  if (!sessions.length) {
    const kg = ex.target_load_kg;
    return { load_kg: kg, load: kg != null ? load(kg, type) : "your choice", reps, sets_left: ex.sets,
      why: "No history yet, so start at the planned weight." };
  }

  const last = sessions[0];
  const L = workingLoad(last);
  const atL = last.filter((s) => Number(s.load_kg ?? 0) === L);
  const step = increment(type, L) * (type === "assisted" ? -1 : 1);
  const lastReps = atL.map((s) => s.full_reps);
  const plannedSets = ex.sets ?? atL.length;

  if (ex.rep_max == null || ex.rep_min == null) {
    return { load_kg: L, load: load(L, type), reps: lastReps.join(", "), sets_left: ex.sets, why: "Repeat last time." };
  }
  if (atL.length >= plannedSets && lastReps.every((r) => r >= ex.rep_max!) && step !== 0) {
    const next = round(Math.max(0, L + step));
    return { load_kg: next, load: load(next, type), reps: `${ex.rep_min}-${ex.rep_max}`, sets_left: ex.sets,
      why: `Every set hit ${ex.rep_max} at ${load(L, type)} last time, so go up to ${load(next, type)}.` };
  }
  if (Math.max(...lastReps) < ex.rep_min) {
    const before = sessions[1];
    const missedTwice = before && workingLoad(before) === L &&
      Math.max(...before.filter((s) => Number(s.load_kg ?? 0) === L).map((s) => s.full_reps)) < ex.rep_min;
    if (missedTwice && step !== 0) {
      const next = round(Math.max(0, L - step));
      return { load_kg: next, load: load(next, type), reps, sets_left: ex.sets,
        why: `Under ${ex.rep_min} reps at ${load(L, type)} two sessions running; drop to ${load(next, type)} and build back.` };
    }
    return { load_kg: L, load: load(L, type), reps, sets_left: ex.sets,
      why: `Last time topped out at ${Math.max(...lastReps)}; stay at ${load(L, type)} and get back to ${ex.rep_min}.` };
  }
  // In range: same weight, one more rep on the sets that haven't reached the top yet.
  const aim = Array.from({ length: plannedSets }, (_, i) => Math.min(ex.rep_max!, (lastReps[i] ?? lastReps.at(-1)!) + 1));
  return { load_kg: L, load: load(L, type), reps: aim.join(", "), sets_left: ex.sets,
    why: `Last time ${lastReps.join(", ")} at ${load(L, type)}; add a rep where you can until every set hits ${ex.rep_max}.` };
}

/** Compares the top set of the latest session with the best of the sessions before it. */
export function trend(ex: BriefExercise): Trend {
  const tops = ex.recent
    .map((r) => ({ day: r.day, top: topSet(matching(r.sets, ex.variation, ex.load_type)) }))
    .filter((t): t is { day: string; top: BriefSet } => t.top !== null); // newest first
  if (tops.length < 2) return { status: "new", detail: tops.length ? "Only one session so far." : "Not done yet." };

  const [latest, ...older] = tops;
  const window = older.slice(0, 3);
  const bestBefore = [...window].sort((a, b) => compareSets(a.top, b.top)).at(-1)!;
  const oldest = window.at(-1)!;
  const fmt = (s: BriefSet) => formatSet(s);
  const vsBest = compareSets(latest.top, bestBefore.top);

  if (vsBest > 0) {
    return { status: "progressing", detail: `${fmt(latest.top)} on ${latest.day}, up from ${fmt(oldest.top)} on ${oldest.day}.` };
  }
  if (vsBest === 0) return { status: "holding", detail: `Matched ${fmt(latest.top)}; next step is one more rep.` };
  if (compareSets(latest.top, oldest.top) < 0) {
    return { status: "dipping", detail: `${fmt(latest.top)} is below ${fmt(oldest.top)} from ${oldest.day}. Check sleep, food and recovery.` };
  }
  return { status: "stalled", detail: `Best is still ${fmt(bestBefore.top)} (${bestBefore.day}); latest ${fmt(latest.top)}.` };
}

/** The brief the agent reads: plan, history summarised as text, suggestion and trend per exercise. */
export function coachBrief(brief: { program_day: { id: string; name: string; program: string }; today: string; exercises: BriefExercise[] }) {
  return {
    program_day: brief.program_day,
    today: brief.today,
    exercises: brief.exercises.map((ex) => ({
      exercise: ex.exercise,
      exercise_id: ex.exercise_id,
      program_exercise_id: ex.program_exercise_id,
      variation: ex.variation,
      plan: {
        sets: ex.sets,
        reps: range(ex.rep_min, ex.rep_max),
        weight: ex.target_load_kg == null ? null
          : ex.target_load_max_kg != null && Number(ex.target_load_max_kg) !== Number(ex.target_load_kg)
            ? loadRange(Number(ex.target_load_kg), Number(ex.target_load_max_kg), ex.load_type)
            : load(ex.target_load_kg, ex.load_type),
        note: ex.note,
      },
      how_i_do_it: ex.exercise_notes,
      done_today: working(ex.today_sets).map((s) => formatSet(s)),
      // only sessions comparable with the plan (same load type, same or no grip)
      last_sessions: ex.recent
        .map((r) => ({ day: r.day, sets: working(matching(r.sets, ex.variation, ex.load_type)).map((s) => formatSet(s)) }))
        .filter((r) => r.sets.length)
        .slice(0, 3),
      suggestion: suggest(ex),
      trend: trend(ex),
    })),
  };
}

const describeSet = (s: BriefSet) => formatSet(s) + (s.variation ? ` (${s.variation})` : "");

/**
 * The same program day for the AI, as data only: plan, sets done today, and recent sessions with every working
 * set written out (grip noted). No suggestion or verdict; the model reasons from this.
 */
export function agentBrief(brief: { program_day: { id: string; name: string; program: string }; today: string; exercises: BriefExercise[] }) {
  return {
    program_day: brief.program_day,
    today: brief.today,
    exercises: brief.exercises.map((ex) => ({
      exercise: ex.exercise,
      exercise_id: ex.exercise_id,
      program_exercise_id: ex.program_exercise_id,
      plan: {
        sets: ex.sets,
        reps: range(ex.rep_min, ex.rep_max),
        weight: ex.target_load_kg == null ? null
          : ex.target_load_max_kg != null && Number(ex.target_load_max_kg) !== Number(ex.target_load_kg)
            ? loadRange(Number(ex.target_load_kg), Number(ex.target_load_max_kg), ex.load_type)
            : load(ex.target_load_kg, ex.load_type),
        load_type: ex.load_type,
        variation: ex.variation,
        note: ex.note,
      },
      how_i_do_it: ex.exercise_notes,
      done_today: ex.today_sets.map((s) => (s.is_warmup ? "warm-up " : "") + describeSet(s)),
      recent_sessions: ex.recent.map((r) => ({
        day: r.day,
        sets: r.sets.map((s) => (s.is_warmup ? "warm-up " : "") + describeSet(s)),
      })),
    })),
  };
}
