-- Exercise notes (free text on how I do the exercise) and the exercise library list.
-- Only alters or creates trk_-prefixed objects.

alter table trk_exercises add column notes text check (char_length(notes) <= 2000);

-- Every exercise with how much I've done it, for the library screen. Most recently trained first.
create function trk_exercise_library() returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(x order by x ->> 'last_day' desc nulls last, x ->> 'name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', e.id, 'name', e.name, 'aliases', e.aliases, 'equipment', e.equipment,
      'default_load_type', e.default_load_type, 'notes', e.notes,
      'sessions', count(distinct w.id),
      'working_sets', count(s.id) filter (where not s.is_warmup),
      'last_day', max(w.day),
      'variations', coalesce(jsonb_agg(distinct s.variation) filter (where s.variation is not null), '[]'::jsonb)
    ) as x
    from trk_exercises e
    left join trk_sets s on s.exercise_id = e.id and s.deleted_at is null
    left join trk_workout_sessions w on w.id = s.session_id and w.deleted_at is null
    where e.deleted_at is null
    group by e.id
  ) lib
$$;

-- trk_exercise_history now also returns the exercise's aliases, equipment and notes.
create or replace function trk_exercise_history(p_exercise_id uuid, p_weeks int default 8) returns jsonb
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
           (array_agg(j order by is_warmup,
                      case when load_type = 'assisted' then -coalesce(load_kg, 0) else coalesce(load_kg, 0) end desc,
                      full_reps desc, partial_reps desc, set_index))[1] as top_set
    from ss
    group by session_id, day, started_at, program_day
  )
  select jsonb_build_object(
    'exercise', (select jsonb_build_object('id', id, 'name', name, 'default_load_type', default_load_type,
                                           'aliases', aliases, 'equipment', equipment, 'notes', notes)
                 from trk_exercises where id = p_exercise_id),
    'weeks', p_weeks,
    'sessions', coalesce(jsonb_agg(jsonb_build_object(
      'session_id', session_id, 'day', day, 'program_day', program_day, 'top_set', top_set, 'sets', sets)
      order by day desc, started_at desc), '[]'::jsonb))
  from sess
$$;

revoke execute on function trk_exercise_library() from public, anon, authenticated;
grant execute on function trk_exercise_library() to service_role;
