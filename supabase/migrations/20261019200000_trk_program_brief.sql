-- Program weight ranges ("77.5-80 kg") and the per-day workout brief the AI trainer reads: each prescribed
-- exercise with its target, today's sets so far, and recent sessions. Only alters or creates trk_ objects.

alter table trk_program_exercises add column target_load_max_kg numeric(6,2)
  check (target_load_max_kg is null or target_load_kg is null or target_load_max_kg >= target_load_kg);

-- trk_set_program also stores target_load_max_kg.
create or replace function trk_set_program(p_name text, p_days jsonb) returns jsonb
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
                                       target_load_kg, target_load_max_kg, load_type, rest_s, note)
    select v_day, x.exercise_id, x.ordinality, x.variation, x.sets, x.rep_min, x.rep_max,
           x.target_load_kg, x.target_load_max_kg, x.load_type, x.rest_s, x.note
    from jsonb_populate_recordset(null::trk_program_exercises, coalesce(d.value -> 'exercises', '[]'::jsonb))
         with ordinality as x;
  end loop;
  return trk_get_program();
end $$;

-- trk_get_program also returns the weight range and each exercise's default load type.
create or replace function trk_get_program() returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('id', p.id, 'name', p.name, 'days', coalesce((
    select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'order_index', d.order_index, 'exercises', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pe.id, 'exercise_id', pe.exercise_id, 'exercise', e.name, 'order_index', pe.order_index,
        'variation', pe.variation, 'sets', pe.sets, 'rep_min', pe.rep_min, 'rep_max', pe.rep_max,
        'target_load_kg', pe.target_load_kg, 'target_load_max_kg', pe.target_load_max_kg,
        'load_type', coalesce(pe.load_type, e.default_load_type), 'rest_s', pe.rest_s, 'note', pe.note)
        order by pe.order_index)
      from trk_program_exercises pe join trk_exercises e on e.id = pe.exercise_id
      where pe.program_day_id = d.id and pe.deleted_at is null), '[]'::jsonb))
      order by d.order_index)
    from trk_program_days d where d.program_id = p.id and d.deleted_at is null), '[]'::jsonb))
  from trk_programs p
  where p.active and p.deleted_at is null
$$;

-- One program day as a workout brief: prescription per exercise, the sets already done today (logical day of
-- p_at), and up to 6 earlier sessions of that exercise. The server turns this into suggestions.
create function trk_program_day_brief(p_program_day_id uuid, p_at timestamptz default now()) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with today as (
    select trk_logical_day(p_at) as d
  ), pd as (
    select d.id, d.name, p.name as program_name
    from trk_program_days d join trk_programs p on p.id = d.program_id
    where d.id = p_program_day_id and d.deleted_at is null
  ), pe as (
    select pe.*, e.name as exercise_name, e.notes as exercise_notes, e.default_load_type
    from trk_program_exercises pe join trk_exercises e on e.id = pe.exercise_id
    where pe.program_day_id = p_program_day_id and pe.deleted_at is null
  )
  select case when not exists (select 1 from pd) then null else jsonb_build_object(
    'program_day', (select jsonb_build_object('id', id, 'name', name, 'program', program_name) from pd),
    'today', (select d from today),
    'exercises', coalesce((select jsonb_agg(jsonb_build_object(
      'program_exercise_id', pe.id, 'exercise_id', pe.exercise_id, 'exercise', pe.exercise_name,
      'exercise_notes', pe.exercise_notes, 'order_index', pe.order_index, 'variation', pe.variation,
      'sets', pe.sets, 'rep_min', pe.rep_min, 'rep_max', pe.rep_max,
      'target_load_kg', pe.target_load_kg, 'target_load_max_kg', pe.target_load_max_kg,
      'load_type', coalesce(pe.load_type, pe.default_load_type), 'rest_s', pe.rest_s, 'note', pe.note,
      'today_sets', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'load_kg', s.load_kg, 'load_type', s.load_type, 'full_reps', s.full_reps,
                 'partial_reps', s.partial_reps, 'rest_pause_reps', s.rest_pause_reps, 'is_warmup', s.is_warmup,
                 'variation', s.variation, 'rpe', s.rpe) order by s.performed_at), '[]'::jsonb)
        from trk_sets s join trk_workout_sessions w on w.id = s.session_id
        where s.exercise_id = pe.exercise_id and w.day = (select d from today)
          and s.deleted_at is null and w.deleted_at is null),
      'recent', (
        select coalesce(jsonb_agg(r.x order by r.day desc), '[]'::jsonb)
        from (
          select w.day, jsonb_build_object('day', w.day, 'sets', jsonb_agg(jsonb_build_object(
                   'load_kg', s.load_kg, 'load_type', s.load_type, 'full_reps', s.full_reps,
                   'partial_reps', s.partial_reps, 'rest_pause_reps', s.rest_pause_reps, 'is_warmup', s.is_warmup,
                   'variation', s.variation, 'rpe', s.rpe) order by s.performed_at)) as x
          from trk_sets s join trk_workout_sessions w on w.id = s.session_id
          where s.exercise_id = pe.exercise_id and w.day < (select d from today)
            and s.deleted_at is null and w.deleted_at is null
          group by w.id, w.day
          order by w.day desc
          limit 6
        ) r)
    ) order by pe.order_index) from pe), '[]'::jsonb)) end
$$;

revoke execute on function trk_program_day_brief(uuid, timestamptz) from public, anon, authenticated;
grant execute on function trk_program_day_brief(uuid, timestamptz) to service_role;
