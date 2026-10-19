-- Seed data for trk_ tables only. Everything here is editable later from the settings page.

-- ───────────────────────── settings ─────────────────────────
insert into trk_settings (timezone, day_cutoff_hour, units) values ('Europe/Dublin', 4, 'kg');

-- ───────────────────────── household units ─────────────────────────
-- Generic sizes (food_id null). Food-specific sizes can be added per food later.
insert into trk_household_units (name, aliases, default_g) values
  ('katori', array['katoris', 'katori bowl', 'small bowl', 'vati'], 150),
  ('bowl',   array['bowls', 'big bowl'],                             250),
  ('roti',   array['rotis', 'chapati', 'chapatis', 'phulka'],         40),
  ('scoop',  array['scoops'],                                          30),
  ('cup',    array['cups'],                                           240);

-- ───────────────────────── exercises ─────────────────────────
-- Only the exercises that appear in the build prompt's examples. The rest get created as I log.
insert into trk_exercises (name, aliases, equipment, default_load_type) values
  ('Pull-up',
   array['pullup', 'pull up', 'pull-ups', 'pullups', 'weighted pull-up', 'weighted pullup',
         'weighted pullups', 'weighted pull-ups', 'pullips', 'weighted pullips'],
   'bodyweight', 'added'),
  ('Machine row',
   array['machine rows', 'plate-loaded row', 'plate loaded row', 'chest-supported machine row'],
   'plate-loaded machine', 'per_side'),
  ('Lat pulldown',
   array['lat pull down', 'pulldown', 'pull-down', 'lat pull-down'],
   'cable stack', 'total'),
  ('Dumbbell curl',
   array['db curl', 'dumbbell curls', 'db curls', 'curls', 'bicep curl'],
   'dumbbells', 'per_hand'),
  ('EZ-bar curl',
   array['ez bar curl', 'ez curl', 'ezbar curl', 'ez-bar curls'],
   'EZ-bar', 'total');

-- ───────────────────────── pricing ─────────────────────────
-- Gemini 3.8 Flash, paid tier (Standard), USD. Checked 2026-10-19.
-- Source: https://ai.google.dev/gemini-api/docs/pricing
--   Input  $0.75 / 1M through 2026-12-31, $1.50 / 1M from 2027-01-01 (no prompt-size tiers, all modalities)
--   Output $3.75 / 1M through 2026-12-31, $7.50 / 1M from 2027-01-01, thinking tokens billed as output
--     (https://ai.google.dev/gemini-api/docs/thinking: "response pricing is the sum of output tokens and thinking tokens")
--   Context cache reads $0.075 / 1M, then $0.15 / 1M (we don't create explicit caches, so no storage cost)
-- Grounding with Google Search: $14 / 1,000 search queries, billed per query the model runs,
--   after 5,000 free queries per month shared across Gemini 3+ models.
--   (https://ai.google.dev/gemini-api/docs/generate-content/google-search)
--   We charge every query at the full rate. That overstates cost while inside the free allowance,
--   which is the safe direction for the daily spend cap.
insert into trk_pricing (model, input_per_m, output_per_m, cached_per_m, search_per_1k, effective_from) values
  ('gemini-3.8-flash', 0.75, 3.75, 0.075, 14.00, '2026-10-01 00:00:00+00'),
  ('gemini-3.8-flash', 1.50, 7.50, 0.150, 14.00, '2027-01-01 00:00:00+00');
