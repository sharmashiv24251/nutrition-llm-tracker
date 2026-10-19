-- trk_start_workout: a session left open from an earlier day is closed (ended at its last set) instead of
-- swallowing today's sets, and an open session from today picks up the program day if it had none.
-- Only replaces a trk_ function.

create or replace function trk_start_workout(p_day date, p_program_day_id uuid default null, p_source text default 'llm',
                                             p_message_id uuid default null) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  w trk_workout_sessions;
  v_closed uuid;
begin
  select * into w from trk_workout_sessions where status = 'active' and deleted_at is null;
  if found and w.day < p_day then
    update trk_workout_sessions
    set status = 'ended',
        ended_at = greatest(started_at, coalesce((select max(performed_at) from trk_sets
                                                  where session_id = w.id and deleted_at is null), started_at))
    where id = w.id;
    v_closed := w.id;
  elsif found then
    if p_program_day_id is not null and w.program_day_id is null then
      update trk_workout_sessions set program_day_id = p_program_day_id where id = w.id returning * into w;
    end if;
    return jsonb_build_object('session', to_jsonb(w), 'already_active', true);
  end if;

  perform trk_ensure_day(p_day, true, p_source, p_message_id);
  insert into trk_workout_sessions (day, program_day_id) values (p_day, p_program_day_id) returning * into w;
  return jsonb_build_object('session', to_jsonb(w), 'already_active', false, 'closed_stale_session', v_closed);
end $$;
