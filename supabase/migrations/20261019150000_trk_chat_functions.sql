-- Read functions for the chat route and the log views: turns with the rows they logged and what they cost,
-- the model's context window, today's spend, and a day's workouts. Only creates trk_-prefixed functions.
-- A "turn" is one user message, its assistant reply (trk_messages.reply_to), every row logged with
-- message_id = the user message, and every trk_llm_calls row for it.

create function trk_turn(p_user_message_id uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'user', jsonb_build_object('id', u.id, 'content', u.content, 'has_image', u.has_image, 'status', u.status,
                               'client_message_id', u.client_message_id, 'created_at', u.created_at, 'day', u.day,
                               'mode', u.mode),
    'reply', (select jsonb_build_object('id', a.id, 'content', a.content, 'created_at', a.created_at)
              from trk_messages a where a.reply_to = u.id and a.deleted_at is null),
    'food_entries', coalesce((select jsonb_agg(to_jsonb(f) - array['created_at', 'updated_at', 'message_id', 'raw_text']
                                               order by f.eaten_at)
                              from trk_food_entries f where f.message_id = u.id and f.deleted_at is null), '[]'::jsonb),
    'sets', coalesce((select jsonb_agg((to_jsonb(s) - array['created_at', 'updated_at', 'message_id', 'raw_text'])
                                       || jsonb_build_object('exercise', e.name) order by s.performed_at)
                      from trk_sets s join trk_exercises e on e.id = s.exercise_id
                      where s.message_id = u.id and s.deleted_at is null), '[]'::jsonb),
    'cost', (select jsonb_build_object(
               'token_usd', coalesce(sum(c.token_cost_usd), 0), 'search_usd', coalesce(sum(c.search_cost_usd), 0),
               'calls', count(*))
             from trk_llm_calls c where c.message_id = u.id and c.deleted_at is null))
  from trk_messages u
  where u.id = p_user_message_id and u.role = 'user'
$$;

create function trk_turn_by_client_id(p_client_message_id text) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select trk_turn(id) from trk_messages where client_message_id = p_client_message_id and role = 'user'
$$;

-- All turns of one mode on one logical day, oldest first (chat view).
create function trk_chat_turns(p_mode trk_mode, p_day date) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(trk_turn(id) order by created_at), '[]'::jsonb)
  from trk_messages
  where mode = p_mode and day = p_day and role = 'user' and deleted_at is null
$$;

-- The last p_limit finished messages of one mode on one day, oldest first (model context).
create function trk_model_context(p_mode trk_mode, p_day date, p_limit int default 20) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('role', role, 'content', content, 'has_image', has_image)
                            order by created_at), '[]'::jsonb)
  from (
    select role, content, has_image, created_at from trk_messages
    where mode = p_mode and day = p_day and status = 'done' and deleted_at is null
    order by created_at desc
    limit p_limit
  ) m
$$;

-- Spend on the calendar day (settings timezone) containing p_at. The cap compares against total_usd.
create function trk_spend_today(p_at timestamptz default now()) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with tz as (
    select coalesce((select timezone from trk_settings where deleted_at is null limit 1), 'Europe/Dublin') as name
  ), bounds as (
    select (p_at at time zone tz.name)::date as day,
           ((p_at at time zone tz.name)::date)::timestamp at time zone tz.name as start_at
    from tz
  )
  select jsonb_build_object(
    'day', b.day,
    'token_usd', coalesce(sum(c.token_cost_usd), 0),
    'search_usd', coalesce(sum(c.search_cost_usd), 0),
    'total_usd', coalesce(sum(c.token_cost_usd + c.search_cost_usd), 0),
    'calls', count(c.id))
  from bounds b
  left join trk_llm_calls c on c.created_at >= b.start_at and c.created_at < b.start_at + interval '1 day'
                           and c.deleted_at is null
  group by b.day
$$;

-- Every session on a logical day with its sets grouped by exercise (workout log view).
create function trk_day_workouts(p_day date) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(trk_session_summary(id) order by started_at), '[]'::jsonb)
  from trk_workout_sessions
  where day = p_day and deleted_at is null
$$;

revoke execute on function
  trk_turn(uuid),
  trk_turn_by_client_id(text),
  trk_chat_turns(trk_mode, date),
  trk_model_context(trk_mode, date, int),
  trk_spend_today(timestamptz),
  trk_day_workouts(date)
from public, anon, authenticated;

grant execute on function
  trk_turn(uuid),
  trk_turn_by_client_id(text),
  trk_chat_turns(trk_mode, date),
  trk_model_context(trk_mode, date, int),
  trk_spend_today(timestamptz),
  trk_day_workouts(date)
to service_role;
