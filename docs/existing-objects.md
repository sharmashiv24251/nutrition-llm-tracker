# Existing Supabase objects (do not touch)

Captured 2026-10-19 through the Supabase MCP, before any trk_ migration was written.
Everything listed here belongs to the abandoned app. No migration in this repo may
alter, drop, rename, truncate, or write to any of it. Every new object is prefixed `trk_`.

At capture time **no object named `trk%` existed** (tables, views, indexes, types, functions).

## Tables (schema `public`, all RLS enabled, all 0 rows)

| Table | Columns |
|---|---|
| active_injuries | id, user_id, body_part, description, severity, contraindicated_patterns, started_at, expected_recovery_days, next_checkin_at, status, cleared_at, created_at |
| body_metrics | id, user_id, kind, value, value_low, value_high, unit, source, confidence, time_of_day, measured_at, created_at |
| chat_messages | id, thread_id, user_id, role, text, blocks, is_proactive, tokens_used, created_at |
| chat_threads | id, user_id, kind, created_at |
| checkins | id, user_id, date, readiness, note, created_at |
| coach_events | id, user_id, type, priority, payload, status, scheduled_for, sent_at, message_id, created_at |
| content_comments | id, post_id, user_id, body, created_at |
| content_posts | id, type, url, body, created_at |
| daily_volume_rollup | user_id, date, total_volume_kg, session_count, primary_focus |
| episodic_memories | id, user_id, kind, content, embedding, salience, source_message_id, last_used_at, expires_at, created_at |
| exercise_muscles | exercise_id, muscle_group_id, role, contribution |
| exercises | id, name, aliases, equipment, movement_pattern, unilateral, is_custom, created_by, default_rep_low, default_rep_high, created_at |
| feed_events | id, actor_id, type, payload, visibility, created_at |
| follows | follower_id, following_id, created_at |
| form_checks | id, user_id, exercise_id, storage_path, feedback, created_at |
| muscle_groups | id, name, region, display_order |
| muscle_volume_rollup | user_id, period_start, muscle_group_id, volume |
| nutrition_logs | id, user_id, logged_for, raw_text, kcal_low, kcal_high, protein_g, carbs_g, fat_g, confidence, created_at |
| personal_records | id, user_id, exercise_id, metric, value, achieved_at, session_id |
| plan_days | id, plan_id, weekday, focus, label, est_minutes |
| plan_exercises | id, plan_day_id, exercise_id, order_index, target_sets, target_reps, rep_low, rep_high, target_weight_kg, rest_seconds, notes |
| plans | id, user_id, name, goal, status, source, copied_from, days_per_week, session_minutes, created_at |
| profiles | id, username, display_name, goal, experience, dob, height_cm, bodyweight_kg, units, available_equipment, usual_train_time, timezone, session_counter, profile_visibility, created_at, updated_at |
| progress_photos | id, user_id, storage_path, taken_at, ai_commentary |
| published_plans | id, author_id, title, description, snapshot, visibility, copy_count, created_at |
| reactions | id, feed_event_id, user_id, kind |
| set_logs | id, session_id, user_id, exercise_id, set_index, weight_kg, reps, rpe, is_warmup, completed_at, client_set_id, created_at |
| subscriptions | user_id, is_premium, entitlement, product_id, store, rc_app_user_id, trial_ends_at, expires_at, updated_at |
| workout_sessions | id, user_id, session_number, plan_day_id, type, title, readiness, started_at, ended_at, duration_seconds, total_volume_kg, status, client_session_id, created_at |
| workout_summaries | id, user_id, session_id, summary_text, embedding, created_at |

## Views / materialized views / sequences

None in `public`.

## Indexes (`public`)

active_injuries_next_checkin_at_idx, active_injuries_pkey, body_metrics_pkey,
chat_messages_pkey, chat_threads_pkey, checkins_pkey, checkins_user_id_date_key,
coach_events_one_pending, coach_events_pkey, coach_events_user_id_status_priority_idx,
content_comments_pkey, content_posts_pkey, daily_volume_rollup_pkey,
daily_volume_rollup_user_id_date_idx, episodic_memories_embedding_idx,
episodic_memories_pkey, exercise_muscles_pkey, exercises_pkey, feed_events_pkey,
follows_pkey, form_checks_pkey, muscle_groups_pkey, muscle_volume_rollup_pkey,
nutrition_logs_pkey, personal_records_pkey,
personal_records_user_id_exercise_id_metric_value_key, plan_days_pkey,
plan_exercises_pkey, plans_pkey, profiles_pkey, profiles_username_key,
progress_photos_pkey, published_plans_pkey, reactions_feed_event_id_user_id_kind_key,
reactions_pkey, set_logs_client_set_id_key, set_logs_pkey,
set_logs_user_id_exercise_id_completed_at_idx, subscriptions_pkey,
workout_sessions_client_session_id_key, workout_sessions_pkey,
workout_sessions_user_id_started_at_idx, workout_sessions_user_number_idx,
workout_summaries_embedding_idx, workout_summaries_pkey

## Functions (`public`, excluding extension-owned)

- assign_session_number()
- handle_new_user()
- ping_slack_presence()
- rls_auto_enable()

## Triggers (`public`)

- before_insert_workout_session ON workout_sessions → assign_session_number()

## Event triggers (database-wide)

- ensure_rls (ddl_command_end → rls_auto_enable): automatically enables RLS on any new
  table created in `public`. It will also fire for our trk_ tables, which is harmless;
  our migrations enable RLS explicitly anyway.
- issue_graphql_placeholder, pgrst_ddl_watch, pgrst_drop_watch, issue_pg_cron_access,
  issue_pg_net_access, issue_pg_graphql_access (Supabase platform)

## Cron jobs

- slack-presence-ping: `*/4 9-17 * * 1-5` → `select ping_slack_presence()`

## Enum types (`public`)

| Type | Values |
|---|---|
| chat_role | user, coach, system |
| event_status | pending, sent, dismissed, expired |
| event_type | workout_reminder, injury_checkin, streak_risk, missed_sessions, ready_to_advance, deload_suggestion, morning_weighin, return_flow, plan_proposal |
| experience_level | beginner, intermediate, advanced |
| feed_type | workout_completed, pr, selfie, milestone |
| injury_severity | minor, moderate, major |
| injury_status | active, recovering, cleared |
| memory_kind | preference, life_context, injury_note, training_note, body_note |
| metric_kind | weight, bodyfat, waist, resting_hr, mile_time |
| metric_source | manual, ai_visual_estimate, dexa, healthkit, googlefit |
| muscle_role | primary, secondary |
| plan_source | ai, copied, manual |
| plan_status | active, archived, proposed |
| pr_metric | top_weight, est_1rm, session_volume |
| session_status | active, completed, abandoned |
| session_type | planned, free |
| training_goal | strength, hypertrophy, fatloss_keep_strength, general |
| unit_system | kg, lb |
| visibility | private, friends, public |

No domain types.

## RLS policies (`public`)

insert custom exercise ON exercises; insert feed ON feed_events; insert own profile ON profiles;
own follows ON follows; own published plans update ON published_plans;
own published plans write ON published_plans; own reactions ON reactions;
own rows ON active_injuries, body_metrics, chat_messages, chat_threads, checkins,
coach_events, content_comments, daily_volume_rollup, episodic_memories, form_checks,
muscle_volume_rollup, nutrition_logs, personal_records, plan_days, plan_exercises, plans,
progress_photos, set_logs, subscriptions, workout_sessions, workout_summaries;
read exercises ON exercises; read feed ON feed_events; read profiles ON profiles;
read published plans ON published_plans; update own exercise ON exercises;
update own profile ON profiles

## Installed extensions

pgcrypto (extensions), pg_net (extensions), supabase_vault (vault), pg_cron (pg_catalog),
uuid-ossp (extensions), plpgsql, vector (extensions), pg_stat_statements (extensions).
Notably **pg_trgm and fuzzystrmatch are not installed.**

## Migration history (supabase_migrations)

20260623062357 enable_extensions · 20260623062422 create_enums ·
20260623062433 create_core_tables · 20260623062442 create_plan_tables ·
20260623062454 create_workout_tables · 20260623062506 create_body_health_tables ·
20260623062515 create_chat_memory_tables · 20260623062526 create_outreach_rollup_tables ·
20260623062538 create_social_content_tables · 20260623062546 create_indexes ·
20260623062608 enable_rls · 20260625085122 slack_presence_ping

## Machine-readable name list

Used by `scripts/check-migrations.ts` to verify no migration references these names.

```names
active_injuries body_metrics chat_messages chat_threads checkins coach_events
content_comments content_posts daily_volume_rollup episodic_memories exercise_muscles
exercises feed_events follows form_checks muscle_groups muscle_volume_rollup
nutrition_logs personal_records plan_days plan_exercises plans profiles progress_photos
published_plans reactions set_logs subscriptions workout_sessions workout_summaries
assign_session_number handle_new_user ping_slack_presence rls_auto_enable
before_insert_workout_session
chat_role event_status event_type experience_level feed_type injury_severity
injury_status memory_kind metric_kind metric_source muscle_role plan_source plan_status
pr_metric session_status session_type training_goal unit_system visibility
```
