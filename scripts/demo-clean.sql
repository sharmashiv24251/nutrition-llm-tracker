-- Removes the demo data seeded on 2026-10-19 to preview the home screen (rows tagged 'demo-seed').
-- Safe to run more than once. Touches only trk_ tables. The Gemini cost rows stay: that spend was real.
begin;

update trk_food_entries set deleted_at = now() where raw_text = 'demo-seed' and deleted_at is null;
update trk_sets set deleted_at = now() where raw_text = 'demo-seed' and deleted_at is null;
update trk_workout_sessions set deleted_at = now() where note = 'demo-seed' and deleted_at is null;
update trk_bodyweight set deleted_at = now()
  where day in ('2026-10-15', '2026-10-18') and created_at between '2026-10-19 08:30:00+00' and '2026-10-19 08:31:00+00'
    and deleted_at is null;
-- recaps written for the demo days
update trk_day_summaries set deleted_at = now() where day between '2026-10-09' and '2026-10-18' and deleted_at is null;
-- status marks and edits made while previewing, so Undo doesn't offer them
update trk_edit_log set deleted_at = now()
  where table_name = 'trk_days' and created_at >= '2026-10-19 08:30:00+00' and created_at < '2026-10-19 09:00:00+00'
    and deleted_at is null;
-- day rows the demo created (no real logs on those days)
delete from trk_days where day between '2026-10-09' and '2026-10-18' and created_at >= '2026-10-19 08:30:00+00';

commit;
