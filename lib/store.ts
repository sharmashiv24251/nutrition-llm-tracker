// The narrow database surface the data layer uses. Production uses Supabase (lib/store-supabase.ts);
// tests use a local Postgres (tests/helpers/bun-store.ts). Both return rows as plain JSON.

export const TABLES = [
  "trk_settings", "trk_targets", "trk_days", "trk_messages", "trk_pricing", "trk_llm_calls", "trk_edit_log",
  "trk_foods", "trk_household_units", "trk_food_entries", "trk_exercises", "trk_programs", "trk_program_days",
  "trk_program_exercises", "trk_workout_sessions", "trk_sets", "trk_bodyweight",
] as const;
export type Table = (typeof TABLES)[number];

// Rows are JSON from PostgREST / to_jsonb; the data layer validates what it reads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export interface Store {
  /** Calls a trk_ SQL function with named arguments. */
  rpc<T = unknown>(fn: `trk_${string}`, args?: Record<string, unknown>): Promise<T>;
  /** All rows not soft-deleted, oldest first. */
  list<T = Row>(table: Table): Promise<T[]>;
  /** One row by id, including soft-deleted rows. */
  get<T = Row>(table: Table, id: string): Promise<T | null>;
  insert<T = Row>(table: Table, row: Row): Promise<T>;
  /** Internal bookkeeping only (message status). Edits to logged data go through trk_apply_edit. */
  update<T = Row>(table: "trk_messages", id: string, patch: Row): Promise<T>;
}

export class DbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbError";
  }
}
