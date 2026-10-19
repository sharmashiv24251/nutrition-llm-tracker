-- My PPL x2 program as of 2026-10-19: missing exercises are added to the catalog, then the program is saved
-- as the active plan with working weights. Run once (already applied to Supabase on 2026-10-19).
-- Ranges like "77.5-80 kg" use target_load_kg / target_load_max_kg; "~60 kg" is stored as 60 with a note.
do $$
declare
  ex jsonb := '[
    ["Incline barbell bench press", "total", "barbell", ["incline bench", "incline barbell bench", "incline bb bench", "incline bench press"]],
    ["Machine shoulder press", "per_side", "plate-loaded machine", ["shoulder press machine", "machine ohp", "shoulder press"]],
    ["Dumbbell lateral raise", "per_hand", "dumbbells", ["db lateral raise", "lateral raise", "lateral raises", "lat raise", "side raise"]],
    ["Machine dip", "per_side", "plate-loaded machine", ["dips machine", "dip machine", "dips", "machine dips"]],
    ["Face pull", "total", "cable stack", ["face pulls", "rope face pull"]],
    ["Hammer curl", "per_hand", "dumbbells", ["hammer curls", "db hammer curl"]],
    ["Romanian deadlift", "total", "barbell", ["rdl", "rdls", "romanian deadlifts"]],
    ["Leg press", "per_side", "plate-loaded machine", ["leg press machine"]],
    ["Lying leg curl", "total", "machine", ["lying hamstring curl", "lying leg curls"]],
    ["Hip thrust", "total", "barbell", ["hip thrusts", "barbell hip thrust"]],
    ["Hip abduction machine", "total", "machine", ["bad girl", "abduction", "abductor machine", "hip abduction"]],
    ["Barbell overhead press", "total", "barbell", ["ohp", "barbell ohp", "overhead press", "military press"]],
    ["Converging chest press", "per_side", "plate-loaded machine", ["converging machine chest press", "machine chest press", "chest press"]],
    ["Machine lateral raise", "per_side", "machine", ["lateral raise machine", "machine lateral raises"]],
    ["Cable pushdown", "total", "cable stack", ["tricep pushdown", "triceps pushdown", "pushdown", "pushdowns", "single-arm cable pushdown"]],
    ["Chest-supported dumbbell row", "per_hand", "dumbbells + incline bench", ["chest supported db row", "chest-supported db row", "incline db row"]],
    ["Cable row", "total", "cable stack", ["seated cable row", "seated row", "close grip cable row"]],
    ["Preacher curl", "per_hand", "dumbbell + preacher bench", ["preacher curls", "one arm preacher curl"]],
    ["Reverse pec deck", "total", "machine", ["rear delt fly", "reverse fly", "rear delt machine"]],
    ["Leg extension", "total", "machine", ["leg extensions", "quad extension"]],
    ["Seated leg curl", "total", "machine", ["seated hamstring curl", "seated leg curls"]],
    ["Hip adduction machine", "total", "machine", ["good girl", "adduction", "adductor machine", "hip adduction"]]
  ]';
  e jsonb;
  id_of jsonb := '{}';
  r record;
begin
  for e in select * from jsonb_array_elements(ex) loop
    if not exists (select 1 from trk_exercises where lower(name) = lower(e ->> 0) and deleted_at is null) then
      insert into trk_exercises (name, default_load_type, equipment, aliases)
      values (e ->> 0, (e ->> 1)::trk_load_type, e ->> 2, array(select jsonb_array_elements_text(e -> 3)));
    end if;
  end loop;

  -- my lat pulldown is plate-loaded ("35 kg/side")
  update trk_exercises set default_load_type = 'per_side', equipment = 'plate-loaded machine'
  where name = 'Lat pulldown' and deleted_at is null;

  for r in select name, id from trk_exercises where deleted_at is null loop
    id_of := id_of || jsonb_build_object(r.name, r.id);
  end loop;

  perform trk_set_program('PPL x2', jsonb_build_array(
    jsonb_build_object('name', 'Push 1', 'exercises', jsonb_build_array(
      jsonb_build_object('exercise_id', id_of ->> 'Incline barbell bench press', 'sets', 3, 'rep_min', 6, 'rep_max', 8, 'target_load_kg', 77.5, 'target_load_max_kg', 80, 'load_type', 'total'),
      jsonb_build_object('exercise_id', id_of ->> 'Machine shoulder press', 'sets', 3, 'rep_min', 8, 'rep_max', 10, 'target_load_kg', 35, 'load_type', 'per_side'),
      jsonb_build_object('exercise_id', id_of ->> 'Dumbbell lateral raise', 'sets', 4, 'rep_min', 12, 'rep_max', 15, 'target_load_kg', 15, 'load_type', 'per_hand'),
      jsonb_build_object('exercise_id', id_of ->> 'Machine dip', 'sets', 3, 'rep_min', 8, 'rep_max', 12, 'target_load_kg', 30, 'load_type', 'per_side'),
      jsonb_build_object('exercise_id', id_of ->> 'Face pull', 'variation', 'double rope', 'sets', 3, 'rep_min', 15, 'rep_max', 20, 'target_load_kg', 45, 'target_load_max_kg', 50, 'load_type', 'total'))),
    jsonb_build_object('name', 'Pull 1', 'exercises', jsonb_build_array(
      jsonb_build_object('exercise_id', id_of ->> 'Pull-up', 'sets', 3, 'rep_min', 6, 'rep_max', 7, 'target_load_kg', 17.5, 'load_type', 'added', 'note', 'weighted'),
      jsonb_build_object('exercise_id', id_of ->> 'Machine row', 'variation', 'wide underhand', 'sets', 3, 'rep_min', 8, 'rep_max', 12, 'target_load_kg', 40, 'load_type', 'per_side'),
      jsonb_build_object('exercise_id', id_of ->> 'Lat pulldown', 'variation', 'neutral grip', 'sets', 3, 'rep_min', 10, 'rep_max', 12, 'target_load_kg', 35, 'load_type', 'per_side'),
      jsonb_build_object('exercise_id', id_of ->> 'Hammer curl', 'sets', 3, 'rep_min', 8, 'rep_max', 10, 'target_load_kg', 25, 'load_type', 'per_hand'),
      jsonb_build_object('exercise_id', id_of ->> 'EZ-bar curl', 'sets', 3, 'rep_min', 8, 'rep_max', 12, 'target_load_kg', 30, 'load_type', 'total', 'note', 'fixed bar'))),
    jsonb_build_object('name', 'Legs 1', 'exercises', jsonb_build_array(
      jsonb_build_object('exercise_id', id_of ->> 'Romanian deadlift', 'sets', 3, 'rep_min', 8, 'rep_max', 10, 'target_load_kg', 60, 'load_type', 'total', 'note', 'about 60 kg'),
      jsonb_build_object('exercise_id', id_of ->> 'Leg press', 'variation', 'feet high', 'sets', 3, 'rep_min', 10, 'rep_max', 12, 'target_load_kg', 75, 'load_type', 'per_side'),
      jsonb_build_object('exercise_id', id_of ->> 'Lying leg curl', 'sets', 3, 'rep_min', 10, 'rep_max', 12, 'target_load_kg', 40, 'load_type', 'total', 'note', 'about 40 kg'),
      jsonb_build_object('exercise_id', id_of ->> 'Hip thrust', 'sets', 3, 'rep_min', 8, 'rep_max', 12, 'target_load_kg', 60, 'load_type', 'total', 'note', 'about 60 kg'),
      jsonb_build_object('exercise_id', id_of ->> 'Hip abduction machine', 'sets', 3, 'rep_min', 12, 'rep_max', 15, 'target_load_kg', 55, 'load_type', 'total'))),
    jsonb_build_object('name', 'Push 2', 'exercises', jsonb_build_array(
      jsonb_build_object('exercise_id', id_of ->> 'Barbell overhead press', 'sets', 3, 'rep_min', 6, 'rep_max', 8, 'target_load_kg', 57.5, 'target_load_max_kg', 60, 'load_type', 'total'),
      jsonb_build_object('exercise_id', id_of ->> 'Converging chest press', 'sets', 3, 'rep_min', 8, 'rep_max', 12, 'target_load_kg', 40, 'load_type', 'per_side', 'note', 'about 40 kg/side'),
      jsonb_build_object('exercise_id', id_of ->> 'Machine lateral raise', 'variation', 'one arm', 'sets', 4, 'rep_min', 10, 'rep_max', 15, 'target_load_kg', 7.5, 'load_type', 'per_side'),
      jsonb_build_object('exercise_id', id_of ->> 'Cable pushdown', 'variation', 'single arm', 'sets', 3, 'rep_min', 10, 'rep_max', 12, 'target_load_kg', 25, 'load_type', 'total', 'note', 'reps per arm'),
      jsonb_build_object('exercise_id', id_of ->> 'Face pull', 'sets', 3, 'rep_min', 15, 'rep_max', 20, 'target_load_kg', 45, 'target_load_max_kg', 50, 'load_type', 'total'))),
    jsonb_build_object('name', 'Pull 2', 'exercises', jsonb_build_array(
      jsonb_build_object('exercise_id', id_of ->> 'Chest-supported dumbbell row', 'sets', 3, 'rep_min', 8, 'rep_max', 12, 'target_load_kg', 30, 'load_type', 'per_hand', 'note', 'use straps'),
      jsonb_build_object('exercise_id', id_of ->> 'Lat pulldown', 'variation', 'wide', 'sets', 3, 'rep_min', 8, 'rep_max', 12, 'target_load_kg', 27.5, 'target_load_max_kg', 30, 'load_type', 'per_side'),
      jsonb_build_object('exercise_id', id_of ->> 'Cable row', 'variation', 'close grip', 'sets', 3, 'rep_min', 10, 'rep_max', 12, 'target_load_kg', 50, 'load_type', 'total'),
      jsonb_build_object('exercise_id', id_of ->> 'Preacher curl', 'variation', 'one arm', 'sets', 3, 'rep_min', 8, 'rep_max', 12, 'target_load_kg', 20, 'load_type', 'per_hand'),
      jsonb_build_object('exercise_id', id_of ->> 'Hammer curl', 'sets', 3, 'rep_min', 10, 'rep_max', 12, 'target_load_kg', 22.5, 'load_type', 'per_hand'),
      jsonb_build_object('exercise_id', id_of ->> 'Reverse pec deck', 'sets', 2, 'rep_min', 12, 'rep_max', 15, 'target_load_kg', 15, 'target_load_max_kg', 20, 'load_type', 'total', 'note', 'optional'))),
    jsonb_build_object('name', 'Legs 2', 'exercises', jsonb_build_array(
      jsonb_build_object('exercise_id', id_of ->> 'Leg press', 'variation', 'feet low', 'sets', 3, 'rep_min', 8, 'rep_max', 12, 'target_load_kg', 75, 'load_type', 'per_side'),
      jsonb_build_object('exercise_id', id_of ->> 'Leg extension', 'sets', 3, 'rep_min', 12, 'rep_max', 15, 'target_load_kg', 50, 'load_type', 'total'),
      jsonb_build_object('exercise_id', id_of ->> 'Seated leg curl', 'sets', 3, 'rep_min', 10, 'rep_max', 12, 'target_load_kg', 70, 'load_type', 'total'),
      jsonb_build_object('exercise_id', id_of ->> 'Hip thrust', 'sets', 3, 'rep_min', 10, 'rep_max', 15, 'target_load_kg', 55, 'target_load_max_kg', 60, 'load_type', 'total', 'note', 'about 55-60 kg'),
      jsonb_build_object('exercise_id', id_of ->> 'Hip adduction machine', 'sets', 3, 'rep_min', 10, 'rep_max', 12, 'target_load_kg', 55, 'load_type', 'total')))
  ));
end $$;
