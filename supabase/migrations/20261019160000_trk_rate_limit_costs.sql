-- Rate limiting, the costs report, and the last undoable edit. Only creates trk_-prefixed objects.

-- Sliding-window limiter over trk_rate_limit's fixed windows: the previous window's count is weighted by how
-- much of it still overlaps the last p_window_ms. Calls for one bucket are serialised with an advisory lock,
-- so concurrent serverless instances can't both slip under the limit.
create function trk_rate_limit_hit(p_bucket text, p_limit int, p_window_ms int default 1000) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window interval := make_interval(secs => p_window_ms / 1000.0);
  v_epoch_ms bigint := floor(extract(epoch from v_now) * 1000);
  v_start timestamptz := to_timestamp((v_epoch_ms - v_epoch_ms % p_window_ms) / 1000.0);
  v_cur int;
  v_prev int;
  v_elapsed float := (v_epoch_ms % p_window_ms)::float / p_window_ms;
  v_weighted float;
begin
  perform pg_advisory_xact_lock(hashtext('trk_rate_limit:' || p_bucket));
  select coalesce(sum(count) filter (where window_start = v_start), 0),
         coalesce(sum(count) filter (where window_start = v_start - v_window), 0)
    into v_cur, v_prev
  from trk_rate_limit where bucket = p_bucket and window_start >= v_start - v_window;

  v_weighted := v_cur + v_prev * (1 - v_elapsed);
  if v_weighted >= p_limit then
    return jsonb_build_object('allowed', false,
      'retry_after_ms', greatest(50, ceil((1 - v_elapsed) * p_window_ms))::int);
  end if;

  insert into trk_rate_limit (bucket, window_start, count) values (p_bucket, v_start, 1)
  on conflict (bucket, window_start) do update set count = trk_rate_limit.count + 1;
  -- keep the table tiny
  delete from trk_rate_limit where bucket = p_bucket and window_start < v_start - v_window * 2;
  return jsonb_build_object('allowed', true, 'retry_after_ms', 0);
end $$;

-- Daily Gemini spend for the last p_days calendar days (settings timezone), newest first, plus month to date.
create function trk_cost_report(p_days int default 30, p_at timestamptz default now()) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with tz as (
    select coalesce((select timezone from trk_settings where deleted_at is null limit 1), 'Europe/Dublin') as name
  ), today as (
    select (p_at at time zone tz.name)::date as d, tz.name from tz
  ), days as (
    select generate_series(t.d - (p_days - 1), t.d, interval '1 day')::date as day, t.name from today t
  ), calls as (
    select (c.created_at at time zone t.name)::date as day, c.token_cost_usd, c.search_cost_usd, c.purpose,
           c.search_queries
    from trk_llm_calls c, today t
    where c.deleted_at is null
      and c.created_at >= ((least(t.d - (p_days - 1), date_trunc('month', t.d)::date))::timestamp at time zone t.name)
  )
  select jsonb_build_object(
    'days', (select jsonb_agg(x order by x ->> 'day' desc) from (
               select jsonb_build_object(
                 'day', d.day,
                 'token_usd', round(coalesce(sum(c.token_cost_usd), 0), 6),
                 'search_usd', round(coalesce(sum(c.search_cost_usd), 0), 6),
                 'calls', count(c.day),
                 'searches', coalesce(sum(c.search_queries), 0)) as x
               from days d left join calls c on c.day = d.day
               group by d.day) per_day),
    'month_to_date', (select jsonb_build_object(
                'token_usd', round(coalesce(sum(token_cost_usd), 0), 6),
                'search_usd', round(coalesce(sum(search_cost_usd), 0), 6),
                'total_usd', round(coalesce(sum(token_cost_usd + search_cost_usd), 0), 6))
             from calls, today where calls.day >= date_trunc('month', today.d)::date),
    'today', (select d from today))
$$;

-- The edit that "Undo" would revert right now, or null.
create function trk_last_edit() returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('id', id, 'table_name', table_name, 'row_id', row_id, 'action', action,
                            'before', before, 'after', after, 'reason', reason, 'source', source,
                            'created_at', created_at)
  from trk_edit_log
  where action in ('update', 'delete') and undone_at is null and deleted_at is null
  order by created_at desc, id desc
  limit 1
$$;

revoke execute on function
  trk_rate_limit_hit(text, int, int),
  trk_cost_report(int, timestamptz),
  trk_last_edit()
from public, anon, authenticated;

grant execute on function
  trk_rate_limit_hit(text, int, int),
  trk_cost_report(int, timestamptz),
  trk_last_edit()
to service_role;
