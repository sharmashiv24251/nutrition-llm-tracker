// Browser-side API calls and shared types. The browser only ever talks to our own /api routes.
import type { LoadType } from "@/lib/format";

export type Mode = "workout" | "food";

export type SetRow = {
  id: string;
  exercise?: string;
  exercise_id?: string;
  variation: string | null;
  set_index: number;
  load_kg: number | null;
  load_type: LoadType;
  full_reps: number;
  partial_reps: number;
  rest_pause_reps: number;
  rpe: number | null;
  is_warmup: boolean;
  performed_at: string;
};

export type FoodRow = {
  id: string;
  display_name: string;
  meal: string;
  grams: number | null;
  quantity: number | null;
  unit: string | null;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fibre_g: number;
  confidence: "label" | "saved" | "estimate";
  assumptions: string | null;
  eaten_at: string;
};

export type Turn = {
  user: { id: string; content: string; has_image: boolean; status: "pending" | "done" | "error"; client_message_id: string; created_at: string };
  reply: { id: string; content: string; created_at: string } | null;
  food_entries: FoodRow[];
  sets: SetRow[];
  cost: { token_usd: number; search_usd: number; calls: number };
};

export type Spend = { day: string; token_usd: number; search_usd: number; total_usd: number; calls: number };

export type Session = {
  session: { id: string; day: string; status: "active" | "ended"; started_at: string; ended_at: string | null; program_day: string | null; note: string | null };
  total_sets: number;
  exercises: { exercise_id: string; name: string; working_sets: number; sets: SetRow[] }[];
};

export type ActiveSession = { id: string; day: string; started_at: string; program_day: string | null } | null;

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

/** JSON request to our API. A 429 (shared 2 req/s limit) is retried after the server's hint. */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers }, cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    if (res.status === 429 && attempt < 5) {
      await sleep(1000 * (json.retry_after_s ?? 1) + Math.random() * 200);
      continue;
    }
    if (!res.ok) throw new ApiError(res.status, json.message ?? `Request failed (${res.status})`, json);
    return json as T;
  }
}

export const api = {
  chatToday: (mode: Mode) =>
    request<{ day: string; turns: Turn[]; spend: Spend; status: Status }>(`/api/chat?mode=${mode}`),
  workoutDay: (day?: string) =>
    request<{ day: string; today: string; sessions: Session[]; active_session: ActiveSession; spend: Spend }>(
      `/api/workout${day ? `?day=${day}` : ""}`),
  endWorkout: (session_id: string) => request("/api/workout/end", { method: "POST", body: JSON.stringify({ session_id }) }),
  editEntry: (table: string, id: string, fields: Record<string, unknown>) =>
    request("/api/entries", { method: "PATCH", body: JSON.stringify({ table, id, fields }) }),
  deleteEntry: (table: string, id: string) =>
    request("/api/entries", { method: "DELETE", body: JSON.stringify({ table, id }) }),
  foodDay: (day?: string) =>
    request<{ day: string; today: string; entries: FoodRow[]; summary: DaySummary; spend: Spend }>(
      `/api/food${day ? `?day=${day}` : ""}`),
  endDay: (day: string) => request<DaySummary>("/api/day/end", { method: "POST", body: JSON.stringify({ day }) }),
  lastEdit: () => request<{ edit: Edit | null }>("/api/undo"),
  undo: (edit_id: string) => request("/api/undo", { method: "POST", body: JSON.stringify({ edit_id }) }),
  exercise: (id: string, weeks = 26) => request<ExerciseHistory>(`/api/exercise/${id}?weeks=${weeks}`),
  exercises: () => request<{ exercises: LibraryExercise[] }>("/api/exercises"),
  program: () => request<{ program: Program | null; next: { id: string; name: string; source: string } | null; today: string }>("/api/plan"),
  planDay: (day: string) => request<{ brief: PlanBrief }>(`/api/plan?day=${encodeURIComponent(day)}`),
  createExercise: (fields: ExerciseFields & { distinct_from?: string }) =>
    request<{ created: true; exercise: { id: string } }>("/api/exercises", { method: "POST", body: JSON.stringify(fields) }),
  updateExercise: (id: string, fields: Partial<ExerciseFields>) =>
    request(`/api/exercise/${id}`, { method: "PATCH", body: JSON.stringify(fields) }),
  costs: () => request<CostReport>("/api/costs"),
  history: (days = 30) => request<{ history: HistoryDay[]; status: Status; spend: Spend }>(`/api/history?days=${days}`),
  day: (day: string) => request<{ report: DayReport; today: string }>(`/api/day/${day}`),
  setCompleteness: (day: string, completeness: Completeness | null, note?: string | null) =>
    request<{ report: DayReport }>(`/api/day/${day}`, { method: "PATCH", body: JSON.stringify({ completeness, note }) }),
  writeSummary: (day: string) => request<{ summary: unknown }>(`/api/day/${day}/summary`, { method: "POST" }),
  settings: () => request<SettingsData>("/api/settings"),
  editSetting: (table: string, id: string, fields: Record<string, unknown>) =>
    request("/api/settings", { method: "PATCH", body: JSON.stringify({ table, id, fields }) }),
  addSetting: (table: string, row: Record<string, unknown>) =>
    request("/api/settings", { method: "POST", body: JSON.stringify({ table, row }) }),
};

type Macros = { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fibre_g: number };

export type Completeness = "complete" | "incomplete" | "missed";

export type HistoryDay = {
  day: string;
  is_today: boolean;
  status: "open" | "closed";
  completeness: Completeness | null;
  /** counted in averages and charts: has food and isn't marked incomplete or missed */
  counts: boolean;
  kcal: number | null;
  protein_g: number | null;
  fibre_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  food_entries: number;
  targets: { kcal: number; protein_g: number; fibre_g: number } | null;
  sessions: number;
  working_sets: number;
  program_days: string[];
  exercises: string[];
  bodyweight_kg: number | null;
  summary: string | null;
};

export type DayReport = {
  day: string;
  status: "open" | "closed";
  completeness: Completeness | null;
  completeness_note: string | null;
  nutrition: DaySummary;
  meals: { meal: string; kcal: number; protein_g: number; items: FoodRow[] }[];
  workouts: Session[];
  previous_top_sets: Record<string, { day: string; load_kg: number | null; load_type: LoadType; full_reps: number; partial_reps: number }>;
  bodyweight: { kg: number; measured_at: string }[];
  summary: { prose: string; generated_at: string; source: "cron" | "manual"; model: string | null } | null;
};
export type DaySummary = {
  day: string;
  status: "open" | "closed";
  entries: number;
  totals: Macros;
  targets: { kcal: number; protein_g: number; carbs_g: number | null; fat_g: number | null; fibre_g: number } | null;
  remaining: { kcal: number; protein_g: number; carbs_g: number | null; fat_g: number | null; fibre_g: number } | null;
};

export type Status = {
  today: string;
  yesterday: string;
  open_days: string[];
  active_session: ActiveSession;
  today_program_day: { id: string; name: string; source: string } | null;
};

export type Edit = {
  id: string;
  table_name: string;
  row_id: string;
  action: "update" | "delete";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
};

export type ExerciseFields = {
  name: string;
  default_load_type: LoadType;
  equipment: string | null;
  aliases: string[];
  notes: string | null;
};

export type LibraryExercise = ExerciseFields & {
  id: string;
  sessions: number;
  working_sets: number;
  last_day: string | null;
  variations: string[];
};

export const LOAD_TYPE_LABEL: Record<LoadType, string> = {
  added: "Bodyweight + added weight",
  assisted: "Assisted (machine or band)",
  bodyweight_only: "Bodyweight only",
  total: "Total (barbell, EZ-bar, stack)",
  per_side: "Per side (plate-loaded)",
  per_hand: "Per hand (dumbbells)",
};

export type ExerciseHistory = {
  exercise: (ExerciseFields & { id: string }) | null;
  weeks: number;
  sessions: { session_id: string; day: string; program_day: string | null; top_set: SetRow; sets: SetRow[] }[];
};

export type CostReport = {
  today: string;
  days: { day: string; token_usd: number; search_usd: number; calls: number; searches: number }[];
  month_to_date: { token_usd: number; search_usd: number; total_usd: number };
};

export type SettingsData = {
  settings: { id: string; timezone: string; day_cutoff_hour: number; units: string } | null;
  targets: { id: string; effective_from: string; kcal: number; protein_g: number; carbs_g: number | null; fat_g: number | null; fibre_g: number }[];
  units: { id: string; name: string; aliases: string[]; default_g: number }[];
  pricing: { id: string; model: string; input_per_m: number; output_per_m: number; cached_per_m: number; search_per_1k: number; effective_from: string }[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends a chat message. Network failures and "still processing" answers are retried with the same
 * client_message_id, so a flaky gym connection never logs a message twice.
 */
export async function sendChat(payload: {
  mode: Mode; text: string; client_message_id: string; image?: { mime_type: string; data: string } | null;
}): Promise<{ status: number; body: { turn?: Turn; spend?: Spend; message?: string; error?: string } }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch("/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, image: payload.image ?? undefined }), cache: "no-store",
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 || res.status === 429) {
        await sleep(1000 * (body.retry_after_s ?? 2));
        continue;
      }
      return { status: res.status, body };
    } catch (e) {
      lastError = e;
      await sleep(800 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Couldn't reach the server");
}

export function usd(n: number | undefined | null): string {
  const v = Number(n ?? 0);
  if (v === 0) return "$0";
  return `$${v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2)}`;
}

const timeFmt = new Intl.DateTimeFormat("en-IE", { timeZone: "Europe/Dublin", hour: "2-digit", minute: "2-digit" });
export const dublinTime = (iso: string) => timeFmt.format(new Date(iso));

export function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const TABLE_LABEL: Record<string, string> = {
  trk_sets: "set", trk_food_entries: "food entry", trk_workout_sessions: "session", trk_bodyweight: "bodyweight",
  trk_foods: "library food", trk_exercises: "exercise", trk_household_units: "unit", trk_targets: "targets",
  trk_program_exercises: "program exercise", trk_days: "day", trk_pricing: "pricing", trk_settings: "settings",
};

/** "edited food entry Cooked white rice: grams 100 → 150, kcal 130 → 195" */
export function describeEdit(e: Edit): string {
  const what = TABLE_LABEL[e.table_name] ?? e.table_name;
  const name = (e.before?.display_name ?? e.before?.name ?? "") as string;
  if (e.action === "delete") return `deleted ${what}${name ? ` ${name}` : ""}`;
  const changes = Object.keys(e.after ?? {})
    .filter((k) => k !== "updated_at" && JSON.stringify(e.before?.[k]) !== JSON.stringify(e.after?.[k]))
    .slice(0, 3)
    .map((k) => `${k} ${String(e.before?.[k] ?? "–")} → ${String(e.after?.[k] ?? "–")}`);
  return `edited ${what}${name ? ` ${name}` : ""}${changes.length ? `: ${changes.join(", ")}` : ""}`;
}

// ───────────── dates (logical days are plain YYYY-MM-DD strings) ─────────────

const asDate = (day: string) => new Date(`${day}T12:00:00Z`);
const fmtShort = new Intl.DateTimeFormat("en-IE", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const fmtLong = new Intl.DateTimeFormat("en-IE", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const fmtParts = new Intl.DateTimeFormat("en-IE", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** "Mon 13 Oct" */
export const shortDay = (day: string) => fmtShort.format(asDate(day));
/** "Monday 13 October" */
export const longDay = (day: string) => fmtLong.format(asDate(day));
/** { weekday: "Mon", date: "13", month: "Oct" } */
export function dayParts(day: string) {
  const parts = Object.fromEntries(fmtParts.formatToParts(asDate(day)).map((p) => [p.type, p.value]));
  return { weekday: parts.weekday, date: parts.day, month: parts.month };
}
/** "Today", "Yesterday" or "Mon 13 Oct" */
export function relativeDay(day: string, today: string) {
  if (day === today) return "Today";
  if (day === shiftDay(today, -1)) return "Yesterday";
  return shortDay(day);
}

export const round0 = (n: number | null | undefined) => (n == null ? "–" : Math.round(Number(n)).toLocaleString("en-IE"));
export const round1 = (n: number | null | undefined) => (n == null ? "–" : String(Math.round(Number(n) * 10) / 10));

// ───────────── plan ─────────────

export type Program = {
  id: string;
  name: string;
  days: {
    id: string;
    name: string;
    order_index: number;
    exercises: {
      id: string; exercise_id: string; exercise: string; variation: string | null; sets: number | null;
      rep_min: number | null; rep_max: number | null; target_load_kg: number | null; target_load_max_kg: number | null;
      load_type: LoadType; note: string | null;
    }[];
  }[];
};

export type TrendStatus = "new" | "progressing" | "holding" | "stalled" | "dipping";

export type PlanBrief = {
  program_day: { id: string; name: string; program: string };
  today: string;
  chosen_because: string;
  exercises: {
    exercise: string;
    exercise_id: string;
    program_exercise_id: string;
    variation: string | null;
    plan: { sets: number | null; reps: string; weight: string | null; note: string | null };
    how_i_do_it: string | null;
    done_today: string[];
    last_sessions: { day: string; sets: string[] }[];
    suggestion: { load_kg: number | null; load: string; reps: string; sets_left: number | null; why: string };
    trend: { status: TrendStatus; detail: string };
  }[];
};
