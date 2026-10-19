-- trk_history: list a day's exercises in the order they were first performed (main lift first) instead of
-- alphabetically. Same signature and output shape otherwise. Only replaces a trk_ function.

create or replace function trk_history(p_days int default 30, p_at timestamptz default now()) returns jsonb
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
           array_remove(array_agg(distinct pd.name), null) as program_days
    from trk_workout_sessions w
    cross join bounds
    left join trk_sets s on s.session_id = w.id and s.deleted_at is null
    left join trk_program_days pd on pd.id = w.program_day_id
    where w.deleted_at is null and w.day > bounds.today - p_days
    group by w.day
  ), first_done as (
    select w.day, e.name, min(s.performed_at) as first_at
    from trk_sets s
    join trk_workout_sessions w on w.id = s.session_id
    join trk_exercises e on e.id = s.exercise_id
    cross join bounds
    where s.deleted_at is null and w.deleted_at is null and w.day > bounds.today - p_days
    group by w.day, e.name
  ), exercise_order as (
    select day, array_agg(name order by first_at, name) as exercise_names from first_done group by day
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
    'exercises', coalesce(to_jsonb(eo.exercise_names), '[]'::jsonb),
    'bodyweight_kg', (select kg from trk_bodyweight b where b.day = d.day and b.deleted_at is null
                      order by measured_at desc limit 1),
    'summary', (select prose from trk_day_summaries s where s.day = d.day and s.deleted_at is null))
    order by d.day desc), '[]'::jsonb)
  from days d
  left join trk_days td on td.day = d.day and td.deleted_at is null
  left join food f on f.day = d.day
  left join training tr on tr.day = d.day
  left join exercise_order eo on eo.day = d.day
$$;
