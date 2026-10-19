-- Lock every trk_ table down: RLS on, no policies, and no grants to the API roles.
-- Only the server (service_role, which bypasses RLS) can read or write.
-- Every statement here targets a trk_ object only.

alter table trk_settings          enable row level security;
alter table trk_targets           enable row level security;
alter table trk_days              enable row level security;
alter table trk_messages          enable row level security;
alter table trk_pricing           enable row level security;
alter table trk_llm_calls         enable row level security;
alter table trk_edit_log          enable row level security;
alter table trk_rate_limit        enable row level security;
alter table trk_foods             enable row level security;
alter table trk_household_units   enable row level security;
alter table trk_food_entries      enable row level security;
alter table trk_exercises         enable row level security;
alter table trk_programs          enable row level security;
alter table trk_program_days      enable row level security;
alter table trk_program_exercises enable row level security;
alter table trk_workout_sessions  enable row level security;
alter table trk_sets              enable row level security;
alter table trk_bodyweight        enable row level security;

revoke all on
  trk_settings, trk_targets, trk_days, trk_messages, trk_pricing, trk_llm_calls,
  trk_edit_log, trk_rate_limit, trk_foods, trk_household_units, trk_food_entries,
  trk_exercises, trk_programs, trk_program_days, trk_program_exercises,
  trk_workout_sessions, trk_sets, trk_bodyweight
from anon, authenticated;

revoke execute on function trk_touch_updated_at() from public, anon, authenticated;
