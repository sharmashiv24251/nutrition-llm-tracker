-- Everything else worth tracking besides food and lifting: water, activity, body measurements, sleep,
-- daily check-ins, routines (supplements, skincare), notes and decisions, plus sodium on food and a water
-- target. Also lets the MCP endpoint be recorded as the source of an edit.
-- Only creates or alters trk_-prefixed objects.

-- ───────────────────────── food: sodium; targets: water ─────────────────────────

-- null = not known (never guessed as 0)
alter table trk_foods add column sodium_mg_per_100g numeric(8,2) check (sodium_mg_per_100g >= 0);
alter table trk_food_entries add column sodium_mg numeric(8,1) check (sodium_mg >= 0);
alter table trk_targets add column water_ml integer check (water_ml > 0);
comment on column trk_targets.water_ml is 'Floor (drink at least this); null = no target';

-- ───────────────────────── tables ─────────────────────────

create table trk_water (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  drunk_at timestamptz not null default now(),
  ml integer not null check (ml > 0 and ml <= 5000),
  drink text not null default 'water',          -- water, milk, electrolytes, tea, ...
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index trk_water_day_idx on trk_water (day) where deleted_at is null;

-- Walks, runs, sport, and gym visits logged without sets.
create table trk_activities (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  started_at timestamptz,
  kind text not null,                           -- walk, run, cycle, swim, gym, football, ...
  duration_min numeric(6,1) check (duration_min > 0),
  distance_km numeric(6,2) check (distance_km >= 0),
  kcal_burned numeric(6,1) check (kcal_burned >= 0),   -- an estimate unless a device measured it
  steps integer check (steps >= 0),             -- steps in this activity; the day's total is a 'steps' measurement
  note text,
  raw_text text,                                -- my exact words
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index trk_activities_day_idx on trk_activities (day) where deleted_at is null;

-- Any number about my body or day that isn't bodyweight: body_fat_pct, waist_cm, chest_cm, steps, resting_hr...
-- Several readings of one metric on a day are kept; the latest is the day's value.
create table trk_measurements (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  measured_at timestamptz not null,
  metric text not null check (metric ~ '^[a-z][a-z0-9_]{1,39}$'),
  value numeric(10,2) not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index trk_measurements_metric_idx on trk_measurements (metric, day) where deleted_at is null;

-- One night per day; `day` is the day I woke up into.
create table trk_sleep (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  bed_at timestamptz,
  wake_at timestamptz,
  hours numeric(4,2) not null check (hours > 0 and hours <= 24),
  quality smallint check (quality between 1 and 5),    -- 1 awful … 5 great
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (wake_at > bed_at)
);
create unique index trk_sleep_day_uq on trk_sleep (day) where deleted_at is null;

-- One check-in per day; every score is 1 (low) to 5 (high).
create table trk_checkins (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  energy smallint check (energy between 1 and 5),
  mood smallint check (mood between 1 and 5),
  stress smallint check (stress between 1 and 5),
  hunger smallint check (hunger between 1 and 5),
  skin text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index trk_checkins_day_uq on trk_checkins (day) where deleted_at is null;

-- Things ticked off once a day: supplements, skincare, anything else.
create table trk_routine_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  aliases text[] not null default '{}',
  kind text not null check (kind in ('supplement', 'skincare', 'other')),
  dose text,                                    -- '5 g', '2 capsules', 'pea-sized'
  schedule text,                                -- free text: 'night', 'morning', 'mon/wed/fri'; null = daily
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index trk_routine_items_name_uq on trk_routine_items (lower(name)) where deleted_at is null;

create table trk_routine_logs (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references trk_routine_items(id),
  day date not null,
  done_at timestamptz not null default now(),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index trk_routine_logs_item_day_uq on trk_routine_logs (item_id, day) where deleted_at is null;

-- What the assistant should remember about me between conversations: profile, goals, the current plan, and
-- each decision with its reason.
create table trk_notes (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('profile', 'goal', 'plan', 'decision', 'note')),
  title text not null,
  body text not null,
  day date not null,                            -- when it was written or decided
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index trk_notes_kind_idx on trk_notes (kind, day desc) where deleted_at is null;

create trigger trk_water_touch before update on trk_water for each row execute function trk_touch_updated_at();
create trigger trk_activities_touch before update on trk_activities for each row execute function trk_touch_updated_at();
create trigger trk_measurements_touch before update on trk_measurements for each row execute function trk_touch_updated_at();
create trigger trk_sleep_touch before update on trk_sleep for each row execute function trk_touch_updated_at();
create trigger trk_checkins_touch before update on trk_checkins for each row execute function trk_touch_updated_at();
create trigger trk_routine_items_touch before update on trk_routine_items for each row execute function trk_touch_updated_at();
create trigger trk_routine_logs_touch before update on trk_routine_logs for each row execute function trk_touch_updated_at();
create trigger trk_notes_touch before update on trk_notes for each row execute function trk_touch_updated_at();

alter table trk_water         enable row level security;
alter table trk_activities    enable row level security;
alter table trk_measurements  enable row level security;
alter table trk_sleep         enable row level security;
alter table trk_checkins      enable row level security;
alter table trk_routine_items enable row level security;
alter table trk_routine_logs  enable row level security;
alter table trk_notes         enable row level security;

revoke all on
  trk_water, trk_activities, trk_measurements, trk_sleep, trk_checkins, trk_routine_items, trk_routine_logs, trk_notes
from anon, authenticated;

insert into trk_routine_items (name, kind) values
  ('Creatine', 'supplement'), ('Fish oil', 'supplement'), ('Vitamin D3', 'supplement'),
  ('Adapalene', 'skincare'), ('Azelaic acid', 'skincare'), ('Sunscreen', 'skincare'), ('Moisturiser', 'skincare');
update trk_routine_items set aliases = '{d3,vit d,vitamin d}' where name = 'Vitamin D3';
update trk_routine_items set aliases = '{omega 3,omega-3}' where name = 'Fish oil';
update trk_routine_items set aliases = '{spf,sunblock}' where name = 'Sunscreen';
update trk_routine_items set aliases = '{moisturizer}' where name = 'Moisturiser';

-- ───────────────────────── edit log: new tables, new source ─────────────────────────

create or replace function trk_editable_table(p_table text) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select p_table in ('trk_food_entries', 'trk_sets', 'trk_workout_sessions', 'trk_bodyweight', 'trk_foods',
                     'trk_exercises', 'trk_household_units', 'trk_targets', 'trk_program_exercises',
                     'trk_days', 'trk_pricing', 'trk_settings',
                     'trk_water', 'trk_activities', 'trk_measurements', 'trk_sleep', 'trk_checkins',
                     'trk_routine_items', 'trk_routine_logs', 'trk_notes')
$$;

alter table trk_edit_log drop constraint trk_edit_log_table_name_check;
alter table trk_edit_log add constraint trk_edit_log_table_name_check check (trk_editable_table(table_name));
alter table trk_edit_log drop constraint trk_edit_log_source_check;
alter table trk_edit_log add constraint trk_edit_log_source_check check (source in ('llm', 'ui', 'mcp'));

-- ───────────────────────── food functions, now with sodium ─────────────────────────

create or replace function trk_day_summary(p_day date) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with e as (
    select * from trk_food_entries where day = p_day and deleted_at is null
  ), tot as (
    select count(*) as n,
           coalesce(sum(kcal), 0) as kcal, coalesce(sum(protein_g), 0) as protein_g,
           coalesce(sum(carbs_g), 0) as carbs_g, coalesce(sum(fat_g), 0) as fat_g,
           coalesce(sum(fibre_g), 0) as fibre_g,
           coalesce(sum(sodium_mg), 0) as sodium_mg, count(sodium_mg) as sodium_n
    from e
  ), meals as (
    select coalesce(jsonb_object_agg(meal, jsonb_build_object(
             'kcal', round(kcal, 1), 'protein_g', round(protein_g, 1), 'entries', n)), '{}'::jsonb) as m
    from (select meal, sum(kcal) as kcal, sum(protein_g) as protein_g, count(*) as n from e group by meal) x
  ), t as (
    select * from trk_targets
    where effective_from <= p_day and deleted_at is null
    order by effective_from desc limit 1
  ), d as (
    select status, closed_at from trk_days where day = p_day and deleted_at is null
  )
  select jsonb_build_object(
    'day', p_day,
    'status', coalesce((select status::text from d), 'open'),
    'closed_at', (select closed_at from d),
    'entries', tot.n,
    'totals', jsonb_build_object(
      'kcal', round(tot.kcal, 1), 'protein_g', round(tot.protein_g, 1), 'carbs_g', round(tot.carbs_g, 1),
      'fat_g', round(tot.fat_g, 1), 'fibre_g', round(tot.fibre_g, 1)),
    -- sodium is only known for some entries, so it's a lower bound: say how many entries it covers
    'sodium', jsonb_build_object('mg', round(tot.sodium_mg), 'entries_with_sodium', tot.sodium_n,
                                 'entries_without', tot.n - tot.sodium_n),
    'targets', (select jsonb_build_object(
      'kcal', t.kcal, 'protein_g', t.protein_g, 'carbs_g', t.carbs_g, 'fat_g', t.fat_g,
      'fibre_g', t.fibre_g, 'effective_from', t.effective_from) from t),
    -- target minus eaten; negative means over (kcal) or past the floor (protein, fibre)
    'remaining', (select jsonb_build_object(
      'kcal', round(t.kcal - tot.kcal, 1), 'protein_g', round(t.protein_g - tot.protein_g, 1),
      'carbs_g', round(t.carbs_g - tot.carbs_g, 1), 'fat_g', round(t.fat_g - tot.fat_g, 1),
      'fibre_g', round(t.fibre_g - tot.fibre_g, 1)) from t),
    'by_meal', meals.m)
  from tot, meals
$$;

create or replace function trk_log_food(p_day date, p_items jsonb, p_message_id uuid default null,
                                        p_source text default 'llm') returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_day jsonb;
  v_rows jsonb;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'items must be a non-empty array';
  end if;
  v_day := trk_ensure_day(p_day, true, p_source, p_message_id);
  with ins as (
    insert into trk_food_entries (day, eaten_at, meal, raw_text, food_id, display_name, quantity, unit, grams,
                                  kcal, protein_g, carbs_g, fat_g, fibre_g, sodium_mg, confidence, assumptions,
                                  message_id)
    -- items logged together keep their order: default eaten_at is now() plus 1µs per position
    select p_day, coalesce(r.eaten_at, now() + r.ordinality * interval '1 microsecond'), coalesce(r.meal, 'other'),
           r.raw_text, r.food_id, r.display_name,
           r.quantity, r.unit, r.grams, r.kcal, coalesce(r.protein_g, 0), coalesce(r.carbs_g, 0),
           coalesce(r.fat_g, 0), coalesce(r.fibre_g, 0), r.sodium_mg, r.confidence, r.assumptions, p_message_id
    from jsonb_populate_recordset(null::trk_food_entries, p_items) with ordinality as r
    order by r.ordinality
    returning *
  )
  select jsonb_agg(to_jsonb(ins) - array['created_at', 'updated_at', 'deleted_at'] order by ins.eaten_at, ins.id)
    into v_rows from ins;
  return jsonb_build_object('day', v_day, 'entries', v_rows, 'summary', trk_day_summary(p_day));
end $$;

-- ───────────────────────── reads ─────────────────────────

-- Raw rows with their ids in a day range, by type. Range capped at 62 days.
create or replace function trk_get_entries(p_from date, p_to date, p_type text) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
begin
  if p_to < p_from then raise exception 'to (%) is before from (%)', p_to, p_from; end if;
  if p_to - p_from > 62 then raise exception 'range too long: max 62 days'; end if;
  if p_type = 'food' then
    return coalesce((select jsonb_agg(to_jsonb(f) - array['created_at', 'updated_at', 'deleted_at', 'message_id']
                                      order by f.day, f.eaten_at, f.created_at)
                     from trk_food_entries f where f.day between p_from and p_to and f.deleted_at is null), '[]'::jsonb);
  elsif p_type = 'sets' then
    return coalesce((select jsonb_agg((to_jsonb(s) - array['created_at', 'updated_at', 'deleted_at', 'message_id'])
                                      || jsonb_build_object('day', w.day, 'exercise', e.name)
                                      order by w.day, s.performed_at)
                     from trk_sets s
                     join trk_workout_sessions w on w.id = s.session_id
                     join trk_exercises e on e.id = s.exercise_id
                     where w.day between p_from and p_to and s.deleted_at is null and w.deleted_at is null), '[]'::jsonb);
  elsif p_type = 'bodyweight' then
    return coalesce((select jsonb_agg(to_jsonb(b) - array['created_at', 'updated_at', 'deleted_at'] order by b.measured_at)
                     from trk_bodyweight b where b.day between p_from and p_to and b.deleted_at is null), '[]'::jsonb);
  elsif p_type = 'water' then
    return coalesce((select jsonb_agg(to_jsonb(x) - array['created_at', 'updated_at', 'deleted_at'] order by x.drunk_at)
                     from trk_water x where x.day between p_from and p_to and x.deleted_at is null), '[]'::jsonb);
  elsif p_type = 'activity' then
    return coalesce((select jsonb_agg(to_jsonb(x) - array['created_at', 'updated_at', 'deleted_at']
                                      order by x.day, x.started_at nulls last, x.created_at)
                     from trk_activities x where x.day between p_from and p_to and x.deleted_at is null), '[]'::jsonb);
  elsif p_type = 'measurement' then
    return coalesce((select jsonb_agg(to_jsonb(x) - array['created_at', 'updated_at', 'deleted_at'] order by x.measured_at)
                     from trk_measurements x where x.day between p_from and p_to and x.deleted_at is null), '[]'::jsonb);
  elsif p_type = 'sleep' then
    return coalesce((select jsonb_agg(to_jsonb(x) - array['created_at', 'updated_at', 'deleted_at'] order by x.day)
                     from trk_sleep x where x.day between p_from and p_to and x.deleted_at is null), '[]'::jsonb);
  elsif p_type = 'checkin' then
    return coalesce((select jsonb_agg(to_jsonb(x) - array['created_at', 'updated_at', 'deleted_at'] order by x.day)
                     from trk_checkins x where x.day between p_from and p_to and x.deleted_at is null), '[]'::jsonb);
  elsif p_type = 'routine' then
    return coalesce((select jsonb_agg((to_jsonb(x) - array['created_at', 'updated_at', 'deleted_at'])
                                      || jsonb_build_object('item', i.name, 'kind', i.kind) order by x.day, x.done_at)
                     from trk_routine_logs x join trk_routine_items i on i.id = x.item_id
                     where x.day between p_from and p_to and x.deleted_at is null), '[]'::jsonb);
  end if;
  raise exception 'unknown type %, expected food, sets, bodyweight, water, activity, measurement, sleep, checkin or routine', p_type;
end $$;

-- Everything logged on one day outside food and lifting.
create function trk_day_wellness(p_day date) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'day', p_day,
    'water', jsonb_build_object(
      'total_ml', coalesce((select sum(ml) from trk_water where day = p_day and deleted_at is null), 0),
      'target_ml', (select t.water_ml from trk_targets t where t.effective_from <= p_day and t.deleted_at is null
                    order by t.effective_from desc limit 1),
      'drinks', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'ml', ml, 'drink', drink, 'drunk_at', drunk_at,
                                                             'note', note) order by drunk_at)
                          from trk_water where day = p_day and deleted_at is null), '[]'::jsonb)),
    'activities', coalesce((select jsonb_agg(to_jsonb(a) - array['created_at', 'updated_at', 'deleted_at', 'day', 'raw_text']
                                             order by a.started_at nulls last, a.created_at)
                            from trk_activities a where a.day = p_day and a.deleted_at is null), '[]'::jsonb),
    'active_kcal', coalesce((select sum(kcal_burned) from trk_activities where day = p_day and deleted_at is null), 0),
    'steps', (select value from trk_measurements where day = p_day and metric = 'steps' and deleted_at is null
              order by measured_at desc limit 1),
    'sleep', (select to_jsonb(s) - array['created_at', 'updated_at', 'deleted_at', 'day']
              from trk_sleep s where s.day = p_day and s.deleted_at is null),
    'checkin', (select to_jsonb(c) - array['created_at', 'updated_at', 'deleted_at', 'day']
                from trk_checkins c where c.day = p_day and c.deleted_at is null),
    'measurements', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'metric', metric, 'value', value,
                                                                  'measured_at', measured_at, 'note', note)
                                               order by measured_at)
                              from trk_measurements where day = p_day and deleted_at is null), '[]'::jsonb),
    'routine', coalesce((select jsonb_agg(jsonb_build_object(
                           'item_id', i.id, 'name', i.name, 'kind', i.kind, 'dose', i.dose, 'schedule', i.schedule,
                           'done', l.id is not null, 'log_id', l.id, 'done_at', l.done_at)
                           order by i.kind, i.created_at, i.name)
                         from trk_routine_items i
                         left join trk_routine_logs l on l.item_id = i.id and l.day = p_day and l.deleted_at is null
                         where i.deleted_at is null and (i.active or l.id is not null)), '[]'::jsonb))
$$;

-- Trends over the last p_days logical days: one row per day, weekly averages, the weight trend (7-day
-- average, so daily water swings don't show), the latest body measurements and routine streaks.
create function trk_trends(p_days int default 30, p_at timestamptz default now()) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with b as (
    select trk_logical_day(p_at) as today
  ), days as (
    select generate_series(b.today - (p_days - 1), b.today, interval '1 day')::date as day from b
  ), w as (
    -- one weight per day: the first reading (the morning one)
    select distinct on (day) day, kg from trk_bodyweight where deleted_at is null order by day, measured_at
  ), food as (
    select f.day, sum(f.kcal) as kcal, sum(f.protein_g) as protein_g
    from trk_food_entries f
    left join trk_days td on td.day = f.day and td.deleted_at is null
    where f.deleted_at is null and coalesce(td.completeness, 'complete') = 'complete'
    group by f.day
  ), water as (
    select day, sum(ml) as ml from trk_water where deleted_at is null group by day
  ), act as (
    select day, sum(kcal_burned) as kcal, sum(duration_min) as minutes, count(*) as n
    from trk_activities where deleted_at is null group by day
  ), steps as (
    select distinct on (day) day, value from trk_measurements
    where metric = 'steps' and deleted_at is null order by day, measured_at desc
  ), lifts as (
    select day, count(*) as n from trk_workout_sessions where deleted_at is null group by day
  ), per as (
    select d.day,
           w.kg as weight_kg,
           (select round(avg(w2.kg), 2) from w w2 where w2.day between d.day - 6 and d.day) as weight_7d_avg,
           round(food.kcal, 1) as kcal, round(food.protein_g, 1) as protein_g,
           water.ml as water_ml, sl.hours as sleep_hours, sl.quality as sleep_quality,
           steps.value as steps, act.kcal as active_kcal, act.minutes as active_min,
           coalesce(lifts.n, 0) as lifting_sessions,
           c.energy, c.mood, c.stress, c.hunger
    from days d
    left join w on w.day = d.day
    left join food on food.day = d.day
    left join water on water.day = d.day
    left join trk_sleep sl on sl.day = d.day and sl.deleted_at is null
    left join steps on steps.day = d.day
    left join act on act.day = d.day
    left join lifts on lifts.day = d.day
    left join trk_checkins c on c.day = d.day and c.deleted_at is null
  ), weeks as (
    -- averages are over the days that have a value, never over empty days
    select date_trunc('week', day)::date as week_start, count(*) as days_in_range,
           round(avg(weight_kg), 2) as weight_kg, round(avg(kcal), 0) as kcal, round(avg(protein_g), 0) as protein_g,
           count(kcal) as food_days, round(avg(water_ml), 0) as water_ml, round(avg(sleep_hours), 2) as sleep_hours,
           round(avg(sleep_quality), 1) as sleep_quality, round(avg(steps), 0) as steps,
           round(sum(active_kcal), 0) as active_kcal, sum(lifting_sessions) as lifting_sessions,
           round(avg(energy), 1) as energy, round(avg(mood), 1) as mood, round(avg(stress), 1) as stress
    from per group by 1
  ), islands as (
    select item_id, max(day) as last_day, count(*) as len
    from (select item_id, day, day - (row_number() over (partition by item_id order by day))::int as grp
          from trk_routine_logs where deleted_at is null) g
    group by item_id, grp
  )
  select jsonb_build_object(
    'today', (select today from b),
    'days', (select jsonb_agg(jsonb_strip_nulls(to_jsonb(per)) order by per.day desc) from per),
    'weeks', (select jsonb_agg(jsonb_strip_nulls(to_jsonb(weeks)) order by weeks.week_start desc) from weeks),
    'weight', (select jsonb_build_object(
        'latest_kg', (select kg from w order by day desc limit 1),
        'latest_day', (select day from w order by day desc limit 1),
        'avg_7d', (select round(avg(kg), 2) from w where day between b.today - 6 and b.today),
        'avg_7d_a_week_ago', (select round(avg(kg), 2) from w where day between b.today - 13 and b.today - 7),
        'readings_last_7d', (select count(*) from w where day between b.today - 6 and b.today)) from b),
    'body', coalesce((select jsonb_agg(jsonb_build_object('metric', metric, 'value', value, 'day', day) order by metric)
                      from (select distinct on (metric) metric, value, day from trk_measurements
                            where deleted_at is null and metric <> 'steps'
                            order by metric, measured_at desc) m), '[]'::jsonb),
    'routine', coalesce((select jsonb_agg(jsonb_build_object(
        'item_id', i.id, 'name', i.name, 'kind', i.kind,
        -- a streak still counts if today isn't ticked yet
        'current_streak', coalesce((select len from islands s where s.item_id = i.id and s.last_day >= b.today - 1), 0),
        'done_today', exists (select 1 from trk_routine_logs l where l.item_id = i.id and l.day = b.today and l.deleted_at is null),
        'done_last_7d', (select count(*) from trk_routine_logs l where l.item_id = i.id and l.deleted_at is null
                         and l.day between b.today - 6 and b.today),
        'done_in_range', (select count(*) from trk_routine_logs l where l.item_id = i.id and l.deleted_at is null
                          and l.day between b.today - (p_days - 1) and b.today))
        order by i.kind, i.created_at, i.name)
      from trk_routine_items i, b where i.deleted_at is null and i.active), '[]'::jsonb))
$$;

revoke execute on function trk_day_wellness(date), trk_trends(int, timestamptz) from public, anon, authenticated;
grant execute on function trk_day_wellness(date), trk_trends(int, timestamptz) to service_role;
