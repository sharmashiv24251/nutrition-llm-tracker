-- Day completeness, nightly AI summaries, the structured day report and the history behind the home screen.
-- Only creates or alters trk_-prefixed objects.

-- complete: the log is the whole day. incomplete: something is missing, so leave it out of averages and charts.
-- missed: nothing worth counting was logged. null means not marked yet (counted like complete).
create type trk_day_completeness as enum ('complete', 'incomplete', 'missed');

alter table trk_days add column completeness trk_day_completeness;
alter table trk_days add column completeness_note text;

-- 'summary' = the nightly day write-up. A new enum value can't be used in the transaction that adds it,
-- and nothing below uses it.
alter type trk_llm_purpose add value 'summary';

create table trk_day_summaries (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  prose text not null,
  structured jsonb not null,       -- trk_day_report(day) at generation time
  model text,
  source text not null check (source in ('cron', 'manual')),
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index trk_day_summaries_day_uq on trk_day_summaries (day) where deleted_at is null;
create trigger trk_day_summaries_touch before update on trk_day_summaries
  for each row execute function trk_touch_updated_at();
alter table trk_day_summaries enable row level security;
revoke all on trk_day_summaries from anon, authenticated;

-- Everything about one day, structured: food by meal with totals against targets, workouts by exercise with
-- each exercise's previous top set for comparison, bodyweight, and the day's status.
create function trk_day_report(p_day date) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with d as (
    select status, closed_at, completeness, completeness_note from trk_days where day = p_day and deleted_at is null
  ), food as (
    select meal, jsonb_agg(jsonb_build_object(
             'id', id, 'display_name', display_name, 'grams', grams, 'quantity', quantity, 'unit', unit,
             'kcal', kcal, 'protein_g', protein_g, 'carbs_g', carbs_g, 'fat_g', fat_g, 'fibre_g', fibre_g,
             'confidence', confidence, 'assumptions', assumptions, 'eaten_at', eaten_at, 'meal', meal)
             order by eaten_at) as items,
           round(sum(kcal), 1) as kcal, round(sum(protein_g), 1) as protein_g
    from trk_food_entries where day = p_day and deleted_at is null group by meal
  ), workouts as (
    select coalesce(jsonb_agg(trk_session_summary(id) order by started_at), '[]'::jsonb) as sessions
    from trk_workout_sessions where day = p_day and deleted_at is null
  ), trained as (
    select distinct s.exercise_id from trk_sets s join trk_workout_sessions w on w.id = s.session_id
    where w.day = p_day and s.deleted_at is null and w.deleted_at is null
  ), previous as (
    -- the most recent earlier session's top working set, per exercise trained today
    select t.exercise_id, (
      select jsonb_build_object('day', w.day, 'load_kg', s.load_kg, 'load_type', s.load_type,
                                'full_reps', s.full_reps, 'partial_reps', s.partial_reps)
      from trk_sets s join trk_workout_sessions w on w.id = s.session_id
      where s.exercise_id = t.exercise_id and w.day < p_day and s.deleted_at is null and w.deleted_at is null
        and not s.is_warmup
      order by w.day desc,
               case when s.load_type = 'assisted' then -coalesce(s.load_kg, 0) else coalesce(s.load_kg, 0) end desc,
               s.full_reps desc
      limit 1) as top
    from trained t
  )
  select jsonb_build_object(
    'day', p_day,
    'status', coalesce((select status::text from d), 'open'),
    'closed_at', (select closed_at from d),
    'completeness', (select completeness from d),
    'completeness_note', (select completeness_note from d),
    'nutrition', trk_day_summary(p_day),
    'meals', coalesce((select jsonb_agg(jsonb_build_object('meal', meal, 'kcal', kcal, 'protein_g', protein_g,
                                                           'items', items)
                                        order by array_position(array['breakfast','lunch','snack','dinner','other']::text[], meal::text))
                       from food), '[]'::jsonb),
    'workouts', (select sessions from workouts),
    'previous_top_sets', coalesce((select jsonb_object_agg(exercise_id, top) from previous where top is not null),
                                  '{}'::jsonb),
    'bodyweight', coalesce((select jsonb_agg(jsonb_build_object('kg', kg, 'measured_at', measured_at) order by measured_at)
                            from trk_bodyweight where day = p_day and deleted_at is null), '[]'::jsonb),
    'summary', (select jsonb_build_object('prose', prose, 'generated_at', generated_at, 'source', source, 'model', model)
                from trk_day_summaries where day = p_day and deleted_at is null))
$$;

-- One row per day for the last p_days logical days (newest first), for the home screen list and charts.
create function trk_history(p_days int default 30, p_at timestamptz default now()) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with bounds as (
    select trk_logical_day(p_at) as today
  ), days as (
    select generate_series(b.today - (p_days - 1), b.today, interval '1 day')::date as day from bounds b
  ), food as (
    select day, round(sum(kcal), 1) as kcal, round(sum(protein_g), 1) as protein_g, round(sum(fibre_g), 1) as fibre_g,
           round(sum(carbs_g), 1) as carbs_g, round(sum(fat_g), 1) as fat_g, count(*) as entries
    from trk_food_entries, bounds
    where deleted_at is null and day > bounds.today - p_days
    group by day
  ), training as (
    select w.day, count(distinct w.id) as sessions, count(s.id) filter (where not s.is_warmup) as working_sets,
           array_remove(array_agg(distinct pd.name), null) as program_days,
           array_remove(array_agg(distinct e.name), null) as exercise_names
    from trk_workout_sessions w
    cross join bounds
    left join trk_sets s on s.session_id = w.id and s.deleted_at is null
    left join trk_exercises e on e.id = s.exercise_id
    left join trk_program_days pd on pd.id = w.program_day_id
    where w.deleted_at is null and w.day > bounds.today - p_days
    group by w.day
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'day', d.day,
    'is_today', d.day = (select today from bounds),
    'status', coalesce(td.status::text, 'open'),
    'completeness', td.completeness,
    'counts', coalesce(coalesce(td.completeness, 'complete') = 'complete' and f.entries > 0, false),
    'kcal', f.kcal, 'protein_g', f.protein_g, 'fibre_g', f.fibre_g, 'carbs_g', f.carbs_g, 'fat_g', f.fat_g,
    'food_entries', coalesce(f.entries, 0),
    'targets', (select jsonb_build_object('kcal', t.kcal, 'protein_g', t.protein_g, 'fibre_g', t.fibre_g)
                from trk_targets t where t.effective_from <= d.day and t.deleted_at is null
                order by t.effective_from desc limit 1),
    'sessions', coalesce(tr.sessions, 0), 'working_sets', coalesce(tr.working_sets, 0),
    'program_days', coalesce(to_jsonb(tr.program_days), '[]'::jsonb),
    'exercises', coalesce(to_jsonb(tr.exercise_names), '[]'::jsonb),
    'bodyweight_kg', (select kg from trk_bodyweight b where b.day = d.day and b.deleted_at is null
                      order by measured_at desc limit 1),
    'summary', (select prose from trk_day_summaries s where s.day = d.day and s.deleted_at is null))
    order by d.day desc), '[]'::jsonb)
  from days d
  left join trk_days td on td.day = d.day and td.deleted_at is null
  left join food f on f.day = d.day
  left join training tr on tr.day = d.day
$$;

-- Finished logical days in the last p_lookback days that have something logged and no summary yet.
-- The nightly job summarises these, so a missed or repeated cron run is harmless.
create function trk_days_to_summarize(p_lookback int default 7, p_at timestamptz default now()) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with b as (select trk_logical_day(p_at) as today)
  select coalesce(jsonb_agg(day order by day), '[]'::jsonb)
  from (
    select distinct day from (
      select day from trk_food_entries where deleted_at is null
      union select day from trk_workout_sessions where deleted_at is null
      union select day from trk_bodyweight where deleted_at is null
    ) logged, b
    where day < b.today and day >= b.today - p_lookback
      and not exists (select 1 from trk_day_summaries s where s.day = logged.day and s.deleted_at is null)
  ) x
$$;

-- Marks a day complete / incomplete / missed (or clears it with null), logged in trk_edit_log.
create function trk_set_day_completeness(p_day date, p_completeness trk_day_completeness, p_note text default null,
                                         p_source text default 'ui', p_message_id uuid default null) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  perform trk_ensure_day(p_day);
  select id into v_id from trk_days where day = p_day;
  return trk_apply_edit('trk_days', v_id,
    jsonb_build_object('completeness', p_completeness, 'completeness_note', p_note),
    'marked ' || coalesce(p_completeness::text, 'unmarked'), p_source, p_message_id);
end $$;

-- Saves a day's write-up, replacing any earlier one (the old row is soft-deleted).
create function trk_save_day_summary(p_day date, p_prose text, p_structured jsonb, p_model text, p_source text)
returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_row trk_day_summaries;
begin
  update trk_day_summaries set deleted_at = now() where day = p_day and deleted_at is null;
  insert into trk_day_summaries (day, prose, structured, model, source)
  values (p_day, p_prose, p_structured, p_model, p_source) returning * into v_row;
  return to_jsonb(v_row);
end $$;

revoke execute on function
  trk_day_report(date),
  trk_history(int, timestamptz),
  trk_days_to_summarize(int, timestamptz),
  trk_set_day_completeness(date, trk_day_completeness, text, text, uuid),
  trk_save_day_summary(date, text, jsonb, text, text)
from public, anon, authenticated;

grant execute on function
  trk_day_report(date),
  trk_history(int, timestamptz),
  trk_days_to_summarize(int, timestamptz),
  trk_set_day_completeness(date, trk_day_completeness, text, text, uuid),
  trk_save_day_summary(date, text, jsonb, text, text)
to service_role;
