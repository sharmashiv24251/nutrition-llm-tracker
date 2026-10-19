-- trk_ schema: enums, tables, indexes, updated_at trigger.
-- Only creates new trk_-prefixed objects. Touches nothing listed in docs/existing-objects.md.
-- Every logged row has id, created_at, updated_at, deleted_at (soft delete).
-- All timestamps are timestamptz (stored UTC). `day` is the logical day (Europe/Dublin, 4am cutoff).

-- ───────────────────────── enums ─────────────────────────

create type trk_load_type as enum (
  'added',            -- bodyweight plus extra (weighted pull-ups, dips)
  'assisted',         -- machine or band help (load_kg = assistance)
  'bodyweight_only',
  'total',            -- barbell, EZ-bar, machine stack
  'per_side',         -- plate-loaded machines
  'per_hand'          -- dumbbells
);

create type trk_confidence as enum ('label', 'saved', 'estimate');
create type trk_food_source as enum ('label_photo', 'web', 'manual', 'estimate');
create type trk_meal as enum ('breakfast', 'lunch', 'dinner', 'snack', 'other');
create type trk_day_status as enum ('open', 'closed');
create type trk_session_status as enum ('active', 'ended');
create type trk_mode as enum ('workout', 'food');
create type trk_role as enum ('user', 'assistant');
create type trk_message_status as enum ('pending', 'done', 'error');
create type trk_llm_purpose as enum ('agent', 'search');
create type trk_edit_action as enum ('update', 'delete', 'undo');

-- ───────────────────────── helpers ─────────────────────────

create function trk_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ───────────────────────── settings & targets ─────────────────────────

create table trk_settings (
  id uuid primary key default gen_random_uuid(),
  singleton boolean not null default true unique check (singleton),  -- enforces exactly one row
  timezone text not null default 'Europe/Dublin',
  day_cutoff_hour smallint not null default 4 check (day_cutoff_hour between 0 and 12),
  units text not null default 'kg' check (units in ('kg')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table trk_targets (
  id uuid primary key default gen_random_uuid(),
  effective_from date not null,
  kcal numeric(7,1) not null check (kcal >= 0),
  protein_g numeric(6,1) not null check (protein_g >= 0),
  carbs_g numeric(6,1) not null check (carbs_g >= 0),
  fat_g numeric(6,1) not null check (fat_g >= 0),
  fibre_g numeric(6,1) not null check (fibre_g >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index trk_targets_effective_from_uq on trk_targets (effective_from) where deleted_at is null;

create table trk_days (
  id uuid primary key default gen_random_uuid(),
  day date not null unique,
  status trk_day_status not null default 'open',
  closed_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check ((status = 'closed') = (closed_at is not null))
);

-- ───────────────────────── chat & LLM accounting ─────────────────────────

create table trk_messages (
  id uuid primary key default gen_random_uuid(),
  mode trk_mode not null,
  day date not null,
  role trk_role not null,
  content text not null default '',
  has_image boolean not null default false,
  tool_calls jsonb,                         -- tool name, args, result summary per call
  client_message_id text unique,            -- set on user messages; retries dedupe on this
  reply_to uuid references trk_messages(id),-- assistant message → the user message it answers
  status trk_message_status not null default 'done',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index trk_messages_mode_day_idx on trk_messages (mode, day, created_at);
create unique index trk_messages_reply_to_uq on trk_messages (reply_to) where reply_to is not null;

create table trk_pricing (
  id uuid primary key default gen_random_uuid(),
  model text not null,
  input_per_m numeric(10,4) not null,       -- USD per 1M input tokens (text/image/video)
  output_per_m numeric(10,4) not null,      -- USD per 1M output tokens, thinking tokens included
  cached_per_m numeric(10,4) not null,      -- USD per 1M cached input tokens
  search_per_1k numeric(10,4) not null,     -- USD per 1,000 grounded search queries
  effective_from timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index trk_pricing_model_from_uq on trk_pricing (model, effective_from) where deleted_at is null;

create table trk_llm_calls (
  id uuid primary key default gen_random_uuid(),
  message_id uuid references trk_messages(id),  -- the user message whose turn caused this call
  purpose trk_llm_purpose not null,
  round smallint,                               -- tool-loop round, 1..8
  model text not null,
  pricing_id uuid references trk_pricing(id),   -- the price row used for the cost columns
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  thinking_tokens integer not null default 0,
  cached_tokens integer not null default 0,
  search_queries integer not null default 0,
  token_cost_usd numeric(12,6) not null default 0,
  search_cost_usd numeric(12,6) not null default 0,
  latency_ms integer,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index trk_llm_calls_created_at_idx on trk_llm_calls (created_at);
create index trk_llm_calls_message_idx on trk_llm_calls (message_id);

create table trk_edit_log (
  id uuid primary key default gen_random_uuid(),
  table_name text not null check (table_name in (
    'trk_food_entries', 'trk_sets', 'trk_workout_sessions', 'trk_bodyweight',
    'trk_foods', 'trk_exercises', 'trk_household_units', 'trk_targets',
    'trk_program_exercises', 'trk_days', 'trk_pricing', 'trk_settings'
  )),
  row_id uuid not null,
  action trk_edit_action not null,
  before jsonb,
  after jsonb,
  reason text,
  source text not null check (source in ('llm', 'ui')),
  message_id uuid references trk_messages(id),
  undo_of uuid references trk_edit_log(id),   -- set on 'undo' rows
  undone_at timestamptz,                      -- set on the original row once undone
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index trk_edit_log_created_at_idx on trk_edit_log (created_at desc);
create index trk_edit_log_row_idx on trk_edit_log (table_name, row_id);

create table trk_rate_limit (
  bucket text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (bucket, window_start)
);

-- ───────────────────────── food ─────────────────────────

create table trk_foods (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  aliases text[] not null default '{}',
  brand text,
  kcal_per_100g numeric(7,2) not null check (kcal_per_100g >= 0),
  protein_per_100g numeric(6,2) not null default 0 check (protein_per_100g >= 0),
  carbs_per_100g numeric(6,2) not null default 0 check (carbs_per_100g >= 0),
  fat_per_100g numeric(6,2) not null default 0 check (fat_per_100g >= 0),
  fibre_per_100g numeric(6,2) not null default 0 check (fibre_per_100g >= 0),
  serving_name text,
  serving_g numeric(7,2) check (serving_g > 0),
  source trk_food_source not null,
  source_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index trk_foods_name_brand_uq on trk_foods (lower(name), lower(coalesce(brand, ''))) where deleted_at is null;

create table trk_household_units (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  aliases text[] not null default '{}',
  default_g numeric(7,2) not null check (default_g > 0),
  food_id uuid references trk_foods(id),        -- null = generic size; set = size for that food
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index trk_household_units_name_food_uq
  on trk_household_units (lower(name), coalesce(food_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where deleted_at is null;

create table trk_food_entries (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  eaten_at timestamptz,
  meal trk_meal not null default 'other',
  raw_text text not null,                       -- my exact words
  food_id uuid references trk_foods(id),
  display_name text not null,
  quantity numeric(8,2),                        -- as I said it: 1.5 (katori), 3 (roti), 360 (g)
  unit text,                                    -- 'g', 'katori', 'roti', 'serving', ...
  grams numeric(8,2) check (grams >= 0),        -- resolved weight
  kcal numeric(7,1) not null check (kcal >= 0),
  protein_g numeric(6,1) not null default 0 check (protein_g >= 0),
  carbs_g numeric(6,1) not null default 0 check (carbs_g >= 0),
  fat_g numeric(6,1) not null default 0 check (fat_g >= 0),
  fibre_g numeric(6,1) not null default 0 check (fibre_g >= 0),
  confidence trk_confidence not null,
  assumptions text,
  message_id uuid references trk_messages(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index trk_food_entries_day_idx on trk_food_entries (day) where deleted_at is null;
create index trk_food_entries_message_idx on trk_food_entries (message_id);

-- ───────────────────────── workout ─────────────────────────

create table trk_exercises (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  aliases text[] not null default '{}',
  equipment text,
  default_load_type trk_load_type not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index trk_exercises_name_uq on trk_exercises (lower(name)) where deleted_at is null;

create table trk_programs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index trk_programs_one_active_uq on trk_programs (active) where active and deleted_at is null;

create table trk_program_days (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references trk_programs(id),
  name text not null,
  order_index smallint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index trk_program_days_order_uq on trk_program_days (program_id, order_index) where deleted_at is null;

create table trk_program_exercises (
  id uuid primary key default gen_random_uuid(),
  program_day_id uuid not null references trk_program_days(id),
  exercise_id uuid not null references trk_exercises(id),
  order_index smallint not null,
  variation text,
  sets smallint check (sets > 0),
  rep_min smallint check (rep_min >= 0),
  rep_max smallint check (rep_max >= rep_min),
  target_load_kg numeric(6,2),
  load_type trk_load_type,
  rest_s integer check (rest_s >= 0),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index trk_program_exercises_day_idx on trk_program_exercises (program_day_id) where deleted_at is null;

create table trk_workout_sessions (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  program_day_id uuid references trk_program_days(id),  -- frozen at log time; program changes don't rewrite it
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status trk_session_status not null default 'active',
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check ((status = 'ended') = (ended_at is not null))
);
create index trk_workout_sessions_day_idx on trk_workout_sessions (day) where deleted_at is null;
create unique index trk_workout_sessions_one_active_uq on trk_workout_sessions (status)
  where status = 'active' and deleted_at is null;

create table trk_sets (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references trk_workout_sessions(id),
  exercise_id uuid not null references trk_exercises(id),
  variation text,                               -- grip / stance / angle, e.g. 'wide underhand'
  set_index smallint not null check (set_index > 0),  -- 1-based, per exercise within the session
  performed_at timestamptz not null default now(),
  load_kg numeric(6,2) check (load_kg >= 0),    -- null for bodyweight_only
  load_type trk_load_type not null,
  full_reps smallint not null default 0 check (full_reps >= 0),
  partial_reps smallint not null default 0 check (partial_reps >= 0),
  rest_pause_reps smallint not null default 0 check (rest_pause_reps >= 0),
  rpe numeric(3,1) check (rpe between 1 and 10),
  is_warmup boolean not null default false,
  raw_text text not null,                       -- my exact words
  message_id uuid references trk_messages(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (load_type = 'bodyweight_only' or load_kg is not null)
);
create index trk_sets_session_idx on trk_sets (session_id, exercise_id, set_index) where deleted_at is null;
create index trk_sets_exercise_idx on trk_sets (exercise_id, performed_at) where deleted_at is null;
create index trk_sets_message_idx on trk_sets (message_id);

create table trk_bodyweight (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  measured_at timestamptz not null,
  kg numeric(5,2) not null check (kg > 20 and kg < 400),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index trk_bodyweight_measured_idx on trk_bodyweight (measured_at) where deleted_at is null;

-- ───────────────────────── updated_at triggers ─────────────────────────

create trigger trk_settings_touch before update on trk_settings for each row execute function trk_touch_updated_at();
create trigger trk_targets_touch before update on trk_targets for each row execute function trk_touch_updated_at();
create trigger trk_days_touch before update on trk_days for each row execute function trk_touch_updated_at();
create trigger trk_messages_touch before update on trk_messages for each row execute function trk_touch_updated_at();
create trigger trk_pricing_touch before update on trk_pricing for each row execute function trk_touch_updated_at();
create trigger trk_llm_calls_touch before update on trk_llm_calls for each row execute function trk_touch_updated_at();
create trigger trk_edit_log_touch before update on trk_edit_log for each row execute function trk_touch_updated_at();
create trigger trk_foods_touch before update on trk_foods for each row execute function trk_touch_updated_at();
create trigger trk_household_units_touch before update on trk_household_units for each row execute function trk_touch_updated_at();
create trigger trk_food_entries_touch before update on trk_food_entries for each row execute function trk_touch_updated_at();
create trigger trk_exercises_touch before update on trk_exercises for each row execute function trk_touch_updated_at();
create trigger trk_programs_touch before update on trk_programs for each row execute function trk_touch_updated_at();
create trigger trk_program_days_touch before update on trk_program_days for each row execute function trk_touch_updated_at();
create trigger trk_program_exercises_touch before update on trk_program_exercises for each row execute function trk_touch_updated_at();
create trigger trk_workout_sessions_touch before update on trk_workout_sessions for each row execute function trk_touch_updated_at();
create trigger trk_sets_touch before update on trk_sets for each row execute function trk_touch_updated_at();
create trigger trk_bodyweight_touch before update on trk_bodyweight for each row execute function trk_touch_updated_at();
