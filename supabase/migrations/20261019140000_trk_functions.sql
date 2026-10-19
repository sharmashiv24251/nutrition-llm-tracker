-- trk_ SQL functions: logical day, summaries, atomic writes, edit log and undo.
-- All totals the app or the model shows come from these functions, never from model arithmetic.
-- Only creates trk_-prefixed functions. EXECUTE is revoked from public/anon/authenticated at the end,
-- so only the server (service_role) can call them through PostgREST.

-- ───────────────────────── logical day ─────────────────────────

-- The day a moment belongs to: local time in the settings timezone, minus the cutoff hour.
-- 01:30 Dublin on the 19th → the 18th (cutoff 4).
create function trk_logical_day(p_at timestamptz default now()) returns date
language sql stable set search_path = public, pg_temp as $$
  select ((p_at at time zone coalesce(s.timezone, 'Europe/Dublin'))
          - make_interval(hours => coalesce(s.day_cutoff_hour, 4)::int))::date
  from (select 1) one
  left join trk_settings s on s.deleted_at is null
  limit 1
$$;

-- Makes sure a trk_days row exists. With p_reopen, a closed day is reopened and the reopen is logged.
create function trk_ensure_day(p_day date, p_reopen boolean default false, p_source text default 'llm',
                               p_message_id uuid default null) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  d trk_days;
  d2 trk_days;
begin
  insert into trk_days (day) values (p_day) on conflict (day) do nothing;
  select * into d from trk_days where day = p_day for update;
  if d.status = 'closed' and p_reopen then
    update trk_days set status = 'open', closed_at = null where id = d.id returning * into d2;
    insert into trk_edit_log (table_name, row_id, action, before, after, reason, source, message_id)
    values ('trk_days', d.id, 'update', to_jsonb(d), to_jsonb(d2), 'reopened for late logging', p_source, p_message_id);
    return jsonb_build_object('day', p_day, 'status', 'open', 'reopened', true);
  end if;
  return jsonb_build_object('day', p_day, 'status', d.status, 'reopened', false);
end $$;

-- ───────────────────────── read functions ─────────────────────────

create function trk_day_summary(p_day date) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with e as (
    select * from trk_food_entries where day = p_day and deleted_at is null
  ), tot as (
    select count(*) as n,
           coalesce(sum(kcal), 0) as kcal, coalesce(sum(protein_g), 0) as protein_g,
           coalesce(sum(carbs_g), 0) as carbs_g, coalesce(sum(fat_g), 0) as fat_g,
           coalesce(sum(fibre_g), 0) as fibre_g
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

create function trk_exercise_history(p_exercise_id uuid, p_weeks int default 8) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with ss as (
    select s.session_id, s.set_index, s.is_warmup, s.load_type, s.load_kg, s.full_reps, s.partial_reps,
           w.day, w.started_at, pd.name as program_day,
           to_jsonb(s) - array['created_at', 'updated_at', 'deleted_at', 'message_id', 'session_id', 'raw_text', 'exercise_id'] as j
    from trk_sets s
    join trk_workout_sessions w on w.id = s.session_id
    left join trk_program_days pd on pd.id = w.program_day_id
    where s.exercise_id = p_exercise_id and s.deleted_at is null and w.deleted_at is null
      and w.day >= trk_logical_day(now()) - p_weeks * 7
  ), sess as (
    select session_id, day, started_at, program_day,
           jsonb_agg(j order by set_index) as sets,
           -- heaviest working set; for assisted sets less assistance is heavier
           (array_agg(j order by is_warmup,
                      case when load_type = 'assisted' then -coalesce(load_kg, 0) else coalesce(load_kg, 0) end desc,
                      full_reps desc, partial_reps desc, set_index))[1] as top_set
    from ss
    group by session_id, day, started_at, program_day
  )
  select jsonb_build_object(
    'exercise', (select jsonb_build_object('id', id, 'name', name, 'default_load_type', default_load_type)
                 from trk_exercises where id = p_exercise_id),
    'weeks', p_weeks,
    'sessions', coalesce(jsonb_agg(jsonb_build_object(
      'session_id', session_id, 'day', day, 'program_day', program_day, 'top_set', top_set, 'sets', sets)
      order by day desc, started_at desc), '[]'::jsonb))
  from sess
$$;

create function trk_session_summary(p_session_id uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with w as (
    select w.*, pd.name as program_day
    from trk_workout_sessions w left join trk_program_days pd on pd.id = w.program_day_id
    where w.id = p_session_id
  ), s as (
    select s.exercise_id, s.set_index, s.performed_at, s.is_warmup,
           to_jsonb(s) - array['created_at', 'updated_at', 'deleted_at', 'message_id', 'session_id', 'exercise_id'] as j
    from trk_sets s where s.session_id = p_session_id and s.deleted_at is null
  ), ex as (
    select e.id, e.name, min(s.performed_at) as first_at,
           count(*) filter (where not s.is_warmup) as working_sets,
           jsonb_agg(s.j order by s.set_index) as sets
    from s join trk_exercises e on e.id = s.exercise_id
    group by e.id, e.name
  )
  select case when not exists (select 1 from w) then null else jsonb_build_object(
    'session', (select jsonb_build_object(
      'id', id, 'day', day, 'status', status, 'started_at', started_at, 'ended_at', ended_at,
      'program_day_id', program_day_id, 'program_day', program_day, 'note', note,
      'deleted', deleted_at is not null) from w),
    'total_sets', (select count(*) from s),
    'exercises', coalesce((select jsonb_agg(jsonb_build_object(
      'exercise_id', id, 'name', name, 'working_sets', working_sets, 'sets', sets) order by first_at) from ex),
      '[]'::jsonb)) end
$$;

create function trk_get_program() returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('id', p.id, 'name', p.name, 'days', coalesce((
    select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'order_index', d.order_index, 'exercises', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pe.id, 'exercise_id', pe.exercise_id, 'exercise', e.name, 'order_index', pe.order_index,
        'variation', pe.variation, 'sets', pe.sets, 'rep_min', pe.rep_min, 'rep_max', pe.rep_max,
        'target_load_kg', pe.target_load_kg, 'load_type', pe.load_type, 'rest_s', pe.rest_s, 'note', pe.note)
        order by pe.order_index)
      from trk_program_exercises pe join trk_exercises e on e.id = pe.exercise_id
      where pe.program_day_id = d.id and pe.deleted_at is null), '[]'::jsonb))
      order by d.order_index)
    from trk_program_days d where d.program_id = p.id and d.deleted_at is null), '[]'::jsonb))
  from trk_programs p
  where p.active and p.deleted_at is null
$$;

-- Food entries, sets or bodyweight readings in a day range, with their IDs. Range capped at 62 days.
create function trk_get_entries(p_from date, p_to date, p_type text) returns jsonb
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
  end if;
  raise exception 'unknown type %, expected food, sets or bodyweight', p_type;
end $$;

-- Everything the agent needs at the start of a request.
create function trk_status(p_at timestamptz default now()) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_today date := trk_logical_day(p_at);
  v_session jsonb;
  v_program trk_programs;
  v_next jsonb;
begin
  select to_jsonb(w) - array['created_at', 'updated_at', 'deleted_at'] || jsonb_build_object('program_day', pd.name)
    into v_session
  from trk_workout_sessions w left join trk_program_days pd on pd.id = w.program_day_id
  where w.status = 'active' and w.deleted_at is null;

  select * into v_program from trk_programs where active and deleted_at is null;

  if v_program.id is not null then
    -- Today's program day: today's session's day if set, else the one after the last session's, wrapping around.
    select jsonb_build_object('id', pd.id, 'name', pd.name, 'source', 'today_session') into v_next
    from trk_workout_sessions w join trk_program_days pd on pd.id = w.program_day_id
    where w.day = v_today and w.deleted_at is null and pd.program_id = v_program.id
    order by w.started_at desc limit 1;

    if v_next is null then
      with last as (
        select pd.order_index from trk_workout_sessions w join trk_program_days pd on pd.id = w.program_day_id
        where w.deleted_at is null and pd.program_id = v_program.id and w.day < v_today
        order by w.day desc, w.started_at desc limit 1
      )
      select jsonb_build_object('id', pd.id, 'name', pd.name, 'source', 'rotation') into v_next
      from trk_program_days pd
      where pd.program_id = v_program.id and pd.deleted_at is null
      order by (pd.order_index <= coalesce((select order_index from last), -32768)), pd.order_index
      limit 1;
    end if;
  end if;

  return jsonb_build_object(
    'now', p_at,
    'today', v_today,
    'yesterday', v_today - 1,
    'open_days', coalesce((select jsonb_agg(day order by day) from trk_days
                           where status = 'open' and day < v_today and deleted_at is null), '[]'::jsonb),
    'today_summary', trk_day_summary(v_today),
    'active_session', v_session,
    'program', case when v_program.id is null then null
                    else jsonb_build_object('id', v_program.id, 'name', v_program.name) end,
    'today_program_day', v_next);
end $$;

-- ───────────────────────── write functions ─────────────────────────

-- Inserts food entries in order. Reopens the day if it was closed (late logging).
-- Items are trk_food_entries fields; macros are computed by the server before this call.
create function trk_log_food(p_day date, p_items jsonb, p_message_id uuid default null,
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
                                  kcal, protein_g, carbs_g, fat_g, fibre_g, confidence, assumptions, message_id)
    -- items logged together keep their order: default eaten_at is now() plus 1µs per position
    select p_day, coalesce(r.eaten_at, now() + r.ordinality * interval '1 microsecond'), coalesce(r.meal, 'other'),
           r.raw_text, r.food_id, r.display_name,
           r.quantity, r.unit, r.grams, r.kcal, coalesce(r.protein_g, 0), coalesce(r.carbs_g, 0),
           coalesce(r.fat_g, 0), coalesce(r.fibre_g, 0), r.confidence, r.assumptions, p_message_id
    from jsonb_populate_recordset(null::trk_food_entries, p_items) with ordinality as r
    order by r.ordinality
    returning *
  )
  select jsonb_agg(to_jsonb(ins) - array['created_at', 'updated_at', 'deleted_at'] order by ins.eaten_at, ins.id)
    into v_rows from ins;
  return jsonb_build_object('day', v_day, 'entries', v_rows, 'summary', trk_day_summary(p_day));
end $$;

create function trk_start_workout(p_day date, p_program_day_id uuid default null, p_source text default 'llm',
                                  p_message_id uuid default null) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  w trk_workout_sessions;
begin
  select * into w from trk_workout_sessions where status = 'active' and deleted_at is null;
  if found then
    return jsonb_build_object('session', to_jsonb(w), 'already_active', true);
  end if;
  perform trk_ensure_day(p_day, true, p_source, p_message_id);
  insert into trk_workout_sessions (day, program_day_id) values (p_day, p_program_day_id) returning * into w;
  return jsonb_build_object('session', to_jsonb(w), 'already_active', false);
end $$;

create function trk_end_workout(p_session_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  update trk_workout_sessions set status = 'ended', ended_at = now()
  where id = p_session_id and status = 'active' and deleted_at is null;
  if not found and not exists (select 1 from trk_workout_sessions where id = p_session_id and deleted_at is null) then
    raise exception 'session % not found', p_session_id;
  end if;
  return trk_session_summary(p_session_id);
end $$;

-- Inserts sets in the given order. set_index continues per exercise within the session.
create function trk_log_sets(p_session_id uuid, p_sets jsonb, p_message_id uuid default null,
                             p_source text default 'llm') returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  w trk_workout_sessions;
  v_rows jsonb;
begin
  if jsonb_typeof(p_sets) <> 'array' or jsonb_array_length(p_sets) = 0 then
    raise exception 'sets must be a non-empty array';
  end if;
  select * into w from trk_workout_sessions where id = p_session_id and deleted_at is null;
  if not found then raise exception 'session % not found', p_session_id; end if;
  perform trk_ensure_day(w.day, true, p_source, p_message_id);

  with r as (
    select x.*, x.ordinality as ord
    from jsonb_populate_recordset(null::trk_sets, p_sets) with ordinality as x
  ), base as (
    select exercise_id, max(set_index) as mx from trk_sets
    where session_id = p_session_id and deleted_at is null group by exercise_id
  ), ins as (
    insert into trk_sets (session_id, exercise_id, variation, set_index, performed_at, load_kg, load_type,
                          full_reps, partial_reps, rest_pause_reps, rpe, is_warmup, raw_text, message_id)
    select p_session_id, r.exercise_id, r.variation,
           coalesce(b.mx, 0) + row_number() over (partition by r.exercise_id order by r.ord),
           coalesce(r.performed_at, clock_timestamp() + r.ord * interval '1 millisecond'),
           r.load_kg, r.load_type, coalesce(r.full_reps, 0), coalesce(r.partial_reps, 0),
           coalesce(r.rest_pause_reps, 0), r.rpe, coalesce(r.is_warmup, false), r.raw_text, p_message_id
    from r left join base b on b.exercise_id = r.exercise_id
    order by r.ord
    returning *
  )
  select jsonb_agg((to_jsonb(ins) - array['created_at', 'updated_at', 'deleted_at'])
                   || jsonb_build_object('exercise', e.name) order by ins.performed_at)
    into v_rows
  from ins join trk_exercises e on e.id = ins.exercise_id;
  return jsonb_build_object('sets', v_rows, 'session', trk_session_summary(p_session_id));
end $$;

-- Creates a new active program (days and prescriptions) and deactivates the old one.
-- Old sessions keep pointing at the old program's days.
-- p_days: [{ name, exercises: [{ exercise_id, variation, sets, rep_min, rep_max, target_load_kg, load_type, rest_s, note }] }]
create function trk_set_program(p_name text, p_days jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_program uuid;
  v_day uuid;
  d record;
begin
  if jsonb_typeof(p_days) <> 'array' or jsonb_array_length(p_days) = 0 then
    raise exception 'days must be a non-empty array';
  end if;
  update trk_programs set active = false where active and deleted_at is null;
  insert into trk_programs (name, active) values (p_name, true) returning id into v_program;
  for d in select value, ordinality from jsonb_array_elements(p_days) with ordinality loop
    insert into trk_program_days (program_id, name, order_index)
    values (v_program, d.value ->> 'name', d.ordinality) returning id into v_day;
    insert into trk_program_exercises (program_day_id, exercise_id, order_index, variation, sets, rep_min, rep_max,
                                       target_load_kg, load_type, rest_s, note)
    select v_day, x.exercise_id, x.ordinality, x.variation, x.sets, x.rep_min, x.rep_max,
           x.target_load_kg, x.load_type, x.rest_s, x.note
    from jsonb_populate_recordset(null::trk_program_exercises, coalesce(d.value -> 'exercises', '[]'::jsonb))
         with ordinality as x;
  end loop;
  return trk_get_program();
end $$;

create function trk_end_day(p_day date) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  perform trk_ensure_day(p_day);
  update trk_days set status = 'closed', closed_at = now() where day = p_day and status = 'open';
  return trk_day_summary(p_day);
end $$;

-- ───────────────────────── edits, deletes, undo ─────────────────────────

create function trk_editable_table(p_table text) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select p_table in ('trk_food_entries', 'trk_sets', 'trk_workout_sessions', 'trk_bodyweight', 'trk_foods',
                     'trk_exercises', 'trk_household_units', 'trk_targets', 'trk_program_exercises',
                     'trk_days', 'trk_pricing', 'trk_settings')
$$;

-- Applies `fields` to one row and logs before/after. Columns are checked against the table; values are
-- cast through jsonb_populate_record, never spliced into SQL text.
create function trk_apply_edit(p_table text, p_id uuid, p_fields jsonb, p_reason text, p_source text,
                               p_message_id uuid default null) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_bad text;
  v_set text;
  v_log uuid;
begin
  if not trk_editable_table(p_table) then raise exception 'table % is not editable', p_table; end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' or p_fields = '{}'::jsonb then
    raise exception 'fields must be a non-empty object';
  end if;
  select string_agg(k, ', ') into v_bad
  from jsonb_object_keys(p_fields) as k
  where k in ('id', 'created_at', 'updated_at', 'deleted_at')
     or not exists (select 1 from pg_attribute a
                    where a.attrelid = ('public.' || p_table)::regclass and a.attname = k
                      and a.attnum > 0 and not a.attisdropped);
  if v_bad is not null then raise exception 'cannot edit column(s) % on %', v_bad, p_table; end if;

  execute format('select to_jsonb(t) from public.%I t where id = $1 and deleted_at is null for update', p_table)
    into v_before using p_id;
  if v_before is null then raise exception '% row % not found', p_table, p_id; end if;

  select string_agg(format('%I = r.%I', k, k), ', ') into v_set from jsonb_object_keys(p_fields) as k;
  execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I, $1) r where t.id = $2 returning to_jsonb(t)',
                 p_table, v_set, p_table)
    into v_after using v_before || p_fields, p_id;

  insert into trk_edit_log (table_name, row_id, action, before, after, reason, source, message_id)
  values (p_table, p_id, 'update', v_before, v_after, p_reason, p_source, p_message_id)
  returning id into v_log;
  return jsonb_build_object('edit_id', v_log, 'table', p_table, 'before', v_before, 'after', v_after);
end $$;

create function trk_soft_delete(p_table text, p_id uuid, p_reason text, p_source text,
                                p_message_id uuid default null) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_log uuid;
begin
  if not trk_editable_table(p_table) then raise exception 'table % is not editable', p_table; end if;
  execute format('select to_jsonb(t) from public.%I t where id = $1 and deleted_at is null for update', p_table)
    into v_before using p_id;
  if v_before is null then raise exception '% row % not found', p_table, p_id; end if;
  execute format('update public.%I set deleted_at = now() where id = $1 returning to_jsonb(%I)', p_table, p_table)
    into v_after using p_id;
  insert into trk_edit_log (table_name, row_id, action, before, after, reason, source, message_id)
  values (p_table, p_id, 'delete', v_before, v_after, p_reason, p_source, p_message_id)
  returning id into v_log;
  return jsonb_build_object('edit_id', v_log, 'table', p_table, 'before', v_before);
end $$;

-- Undoes one edit (default: the most recent one not yet undone). Refuses if a newer edit on the same
-- row is still in place, so undo never clobbers a later change.
create function trk_undo_edit(p_edit_id uuid default null, p_source text default 'ui') returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  e trk_edit_log;
  v_cur jsonb;
  v_new jsonb;
  v_restore jsonb;
  v_set text;
  v_log uuid;
begin
  if p_edit_id is null then
    select * into e from trk_edit_log
    where action in ('update', 'delete') and undone_at is null and deleted_at is null
    order by created_at desc, id desc limit 1;
  else
    select * into e from trk_edit_log where id = p_edit_id and deleted_at is null;
  end if;
  if e.id is null then raise exception 'nothing to undo'; end if;
  if e.action = 'undo' then raise exception 'cannot undo an undo'; end if;
  if e.undone_at is not null then raise exception 'edit % was already undone', e.id; end if;
  if exists (select 1 from trk_edit_log n
             where n.table_name = e.table_name and n.row_id = e.row_id and n.action in ('update', 'delete')
               and n.undone_at is null and n.created_at > e.created_at and n.deleted_at is null) then
    raise exception 'a newer edit on this row exists; undo that first';
  end if;

  execute format('select to_jsonb(t) from public.%I t where id = $1 for update', e.table_name)
    into v_cur using e.row_id;
  if v_cur is null then raise exception '% row % no longer exists', e.table_name, e.row_id; end if;

  if e.action = 'delete' then
    execute format('update public.%I set deleted_at = null where id = $1 returning to_jsonb(%I)', e.table_name, e.table_name)
      into v_new using e.row_id;
  else
    select jsonb_object_agg(k, e.before -> k) into v_restore
    from jsonb_object_keys(e.after) as k
    where k <> 'updated_at' and (e.before -> k) is distinct from (e.after -> k);
    if v_restore is null then
      v_new := v_cur;
    else
      select string_agg(format('%I = r.%I', k, k), ', ') into v_set from jsonb_object_keys(v_restore) as k;
      execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I, $1) r where t.id = $2 returning to_jsonb(t)',
                     e.table_name, v_set, e.table_name)
        into v_new using v_cur || v_restore, e.row_id;
    end if;
  end if;

  update trk_edit_log set undone_at = now() where id = e.id;
  insert into trk_edit_log (table_name, row_id, action, before, after, reason, source, undo_of)
  values (e.table_name, e.row_id, 'undo', v_cur, v_new, 'undo of ' || e.action, p_source, e.id)
  returning id into v_log;
  return jsonb_build_object('edit_id', v_log, 'undid', e.id, 'table', e.table_name, 'row', v_new);
end $$;

-- ───────────────────────── privileges ─────────────────────────

revoke execute on function
  trk_logical_day(timestamptz),
  trk_ensure_day(date, boolean, text, uuid),
  trk_day_summary(date),
  trk_exercise_history(uuid, int),
  trk_session_summary(uuid),
  trk_get_program(),
  trk_get_entries(date, date, text),
  trk_status(timestamptz),
  trk_log_food(date, jsonb, uuid, text),
  trk_start_workout(date, uuid, text, uuid),
  trk_end_workout(uuid),
  trk_log_sets(uuid, jsonb, uuid, text),
  trk_set_program(text, jsonb),
  trk_end_day(date),
  trk_editable_table(text),
  trk_apply_edit(text, uuid, jsonb, text, text, uuid),
  trk_soft_delete(text, uuid, text, text, uuid),
  trk_undo_edit(uuid, text)
from public, anon, authenticated;

grant execute on function
  trk_logical_day(timestamptz),
  trk_ensure_day(date, boolean, text, uuid),
  trk_day_summary(date),
  trk_exercise_history(uuid, int),
  trk_session_summary(uuid),
  trk_get_program(),
  trk_get_entries(date, date, text),
  trk_status(timestamptz),
  trk_log_food(date, jsonb, uuid, text),
  trk_start_workout(date, uuid, text, uuid),
  trk_end_workout(uuid),
  trk_log_sets(uuid, jsonb, uuid, text),
  trk_set_program(text, jsonb),
  trk_end_day(date),
  trk_editable_table(text),
  trk_apply_edit(text, uuid, jsonb, text, text, uuid),
  trk_soft_delete(text, uuid, text, text, uuid),
  trk_undo_edit(uuid, text)
to service_role;
