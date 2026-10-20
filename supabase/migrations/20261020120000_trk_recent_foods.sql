-- trk_recent_foods: library foods I've logged in the last p_days logical days, most recent first, with their
-- per-100 g values, serving size and food-specific units. The food chat puts this list in the system prompt so
-- a food I eat often is logged by id straight away, with no find_food or web_search round. A food not logged
-- for p_days drops off the list but stays in the library, where find_food still finds it.
-- Only adds a trk_ function.

create function trk_recent_foods(p_at timestamptz default now(), p_days int default 7, p_limit int default 40)
returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with used as (
    select food_id, max(day) as last_day, count(*)::int as times
    from trk_food_entries
    where deleted_at is null and food_id is not null and day > trk_logical_day(p_at) - p_days
    group by food_id
  ),
  recent as (
    select f.*, used.last_day, used.times
    from used join trk_foods f on f.id = used.food_id and f.deleted_at is null
    order by used.last_day desc, used.times desc, f.name
    limit p_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'name', r.name, 'brand', r.brand, 'aliases', r.aliases,
      'kcal_per_100g', r.kcal_per_100g, 'protein_per_100g', r.protein_per_100g, 'carbs_per_100g', r.carbs_per_100g,
      'fat_per_100g', r.fat_per_100g, 'fibre_per_100g', r.fibre_per_100g,
      'serving_name', r.serving_name, 'serving_g', r.serving_g, 'source', r.source,
      'units', (select coalesce(jsonb_agg(jsonb_build_object('name', hu.name, 'g', hu.default_g) order by hu.name), '[]'::jsonb)
                from trk_household_units hu where hu.food_id = r.id and hu.deleted_at is null),
      'last_used', r.last_day, 'times', r.times)
    order by r.last_day desc, r.times desc, r.name), '[]'::jsonb)
  from recent r
$$;

revoke execute on function trk_recent_foods(timestamptz, int, int) from public, anon, authenticated;
grant execute on function trk_recent_foods(timestamptz, int, int) to service_role;
