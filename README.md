# Swolify

A personal workout and food log driven by plain-sentence chat. Postgres (Supabase) is the source of
truth. Gemini reads and writes it only through tools, and every total comes from SQL functions.

## Run it locally

```bash
bun install
bun dev
```

Open http://localhost:3000. It opens the workout chat. `.env` needs:

| Name | Purpose |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only database access (secret key) |
| `GEMINI_API_KEY` | Server-only model access (`GOOGLE_GENERATIVE_AI_API_KEY` is accepted as an alias) |
| `DAILY_SPEND_CAP_USD` | Hard stop on Gemini spend per day (default 1.00) |
| `CRON_SECRET` | Random string, 16+ characters. Vercel sends it to the nightly job; the job rejects anything else |

None of these is exposed to the browser. The browser only calls this app's own `/api` routes.

## Screens

- **Home** (`/`): today against targets, 7-day averages, a 14 or 30-day calories/protein chart with the
  target line, and every past day with its status, totals, training and the start of its recap.
- **Day** (`/day/2026-10-15`): the AI recap, then food by meal and training by exercise (with last time's top
  set). Tap any row to edit or delete it; Undo reverts the last change. Mark the day Complete, Incomplete or
  Missed. Incomplete and missed days are left out of averages and charts, and the AI can set this too ("I
  forgot to log dinner yesterday").
- **Exercises** (`/exercises`, `/exercise/[id]`): the exercise catalog. Add exercises, and edit the name, other
  names, equipment, how the weight is counted, and free-text notes on how you do it. Each exercise page shows
  its progress charts. Renaming keeps all history and keeps the old name as an alias. In Workout chat the AI
  does the same with `create_exercise` / `update_exercise` ("I do machine rows on the Hammer Strength, seat 4"
  is saved to that exercise's notes). Grip or stance differences stay a variation on the set, not a new
  exercise.
- **Plan** (`/plan`): the active program (PPL x2) day by day. Each exercise shows the planned sets, reps and
  working weight, the suggested weight and reps for next time (or the next set, mid-workout), last session,
  and a trend: progressing, holding, stalled or dipping.
- **Workout** and **Food** (`/workout`, `/food`): the logging chats. "Add to this day" on a past day opens
  them with the date already filled in.

## How the AI works

The AI is given data tools and principles, not a script. Each tool's description says what it returns. The AI
decides what to fetch, chains calls (up to 8 rounds) and reasons from the results, so new kinds of questions
work without new prompt rules: "what weight should I do?", "am I progressing?", "which exercise have I skipped
longest?", "which days was I under 100 g protein?".

- **Read tools work in both chats:** status, a whole day, daily history, raw entries, the plan, one program day
  (plan, today's sets and recent sessions per exercise), exercise history, the exercise library, and food and
  exercise lookup. **Write tools** stay in their own chat to keep each request smaller.
- **The prompt (`lib/prompt.ts`)** describes how to work (look it up, ground every number in tool results,
  ask only when it changes what gets saved), what the data means (logical days, load types, variations,
  plan vs. what was logged), and the few rules that protect the data: exact words as `raw_text`, food totals
  from the database, no duplicate exercises, tagging sessions with their program day, one-off swaps vs. plan
  changes.
- **Training advice is the AI's own reasoning** over your plan and history. The Plan screen also shows a
  rule-of-thumb suggestion from `lib/coach.ts` (double progression) as a quick visual hint; the AI doesn't
  see it.

## Nightly recap

`vercel.json` runs `GET /api/cron/daily-summary` daily at `30 4 * * *` UTC. That is 04:30–05:00 Dublin time in
winter and 05:30–06:00 in summer, always after the 4 am cutoff, so the day is really over (a 3 am run would
cut it short). The job writes a recap for every finished day from the last week that has logs but no recap
yet. Missed or repeated runs are harmless, and so is the Hobby plan's "any time within the hour" timing.
Each recap is one Gemini call (about $0.001) and is stored with the structured day report in
`trk_day_summaries`. Run it locally with:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/daily-summary
```

Or tap **Write recap** on any day.

## Tests

```bash
bun run test               # 102 tests; SQL + data layer + chat run against a throwaway local Postgres
bun run check:migrations   # no migration creates or touches anything without the trk_ prefix
bun run typecheck
bun run lint
```

The database tests need `initdb`, `pg_ctl` and `psql` on PATH (`brew install postgresql@16`). They start a
temporary cluster, apply every migration in `supabase/migrations`, and never touch Supabase. Chat tests
use a scripted model in place of Gemini.

## Where things are

| Path | What |
|---|---|
| `supabase/migrations/` | All schema, functions and seeds. Every object is `trk_`-prefixed |
| `docs/existing-objects.md` | The old app's objects, captured before any migration. None were touched |
| `lib/data.ts` | Data layer: name matching, unit conversion, macros, calls into SQL functions |
| `lib/agent.ts`, `lib/tools.ts`, `lib/prompt.ts` | Tool-calling loop (8 rounds max), tool definitions, system prompt |
| `lib/chat.ts` | `/api/chat`: idempotency, spend cap, cost logging, `web_search` |
| `app/api/*` | Route handlers. All are rate-limited to 2 requests/second in total (Postgres-backed) |
| `components/` | Phone-first UI: chat and log views per mode, costs, settings, exercise progress |

## Design notes and deviations from the brief

- **Model**: `gemini-3.8-flash` through `@google/genai` `generateContent`. The docs now default to the newer
  Interactions API and label `generateContent` "legacy", but it is still supported, and its function-calling
  and usage metadata are documented in full.
- **web_search stays a separate grounded call.** Combining Google Search with function declarations is
  still Preview for Gemini 3 models. It needs `includeServerSideToolInvocations` and strict thought-signature
  handling, so it isn't worth switching yet. Search cost lands on its own `trk_llm_calls` row
  (`purpose = 'search'`).
- **Pricing**: seeded from the Gemini pricing page (cited in the seed migration). $0.75/1M input and $3.75/1M
  output until 31 Dec 2026, doubling on 1 Jan 2027 (both rows are seeded). Search is $14 per 1,000 queries,
  charged in full even inside the 5,000 free monthly queries, which overstates spend in the safe direction.
- **get_status**: its result is put into the system prompt for every request, rather than spending a
  model round to fetch it. The tool is still available for fresh state.
- **Tools per mode**: workout mode doesn't get the food tools and vice versa, which cuts input tokens by
  about a third. `log_sets` without a `session_id` uses the active session or opens one.
- **Carbs and fat targets are optional**: kcal is a ceiling, protein and fibre are floors.
- **Added objects beyond the brief**: `trk_set_program` (switching splits), `trk_turn` and friends (chat
  history with logged rows and cost per turn), `trk_cost_report`, `trk_last_edit`, `trk_rate_limit_hit`.
- **Sets have no `day` column.** They inherit it from their session, so the two can't disagree.
- **Photos** are prepared entirely in the browser (`components/photo.ts`): the preview shows instantly and the
  photo is decoded with EXIF orientation, halved step by step to 1600 px on the long side, and re-encoded
  as JPEG at quality 0.82 (about 150–400 KB). Encoding is async and never blocks the main thread, and
  re-encoding strips GPS metadata. Only a `has_image` flag is stored.
- **Image tokens**: Gemini 3 bills an image by `media_resolution`, not by pixels (low 252, medium 546,
  high 1073 tokens). Tested on a small, tilted label photo: low invented values, medium misread 1 run in 4,
  and high at 1600 px read all 4 runs correctly. We send `high` (`IMAGE_RESOLUTION` in `lib/chat.ts`), about
  $0.0008 per model round. Earlier turns' photos are never re-sent.
- **Fuzzy matching** of exercise and food names runs in TypeScript over the small catalogs, because
  `pg_trgm` isn't installed and installing it would add a non-`trk_` object.

## Cost per message (measured live)

About $0.006 per model call. A typical logging message takes 3 calls (about $0.018). A new packaged food
looked up on the web takes about $0.05. At the default $1 cap that's roughly 50 messages a day.

## Fresh start (2026-10-19)

All demo and test logs were removed on 19 Oct 2026, leaving the exercise catalog, the PPL x2 plan, targets,
settings, household units and pricing. A full copy of the data from just before is in `backups/` (git-ignored).
`scripts/demo-clean.sql` and `scripts/seed-program.sql` are kept for reference.

## Deploying (not done yet)

1. Create the Vercel project and add the five environment variables above (production only).
2. Put the functions in the region nearest the Supabase project. Each database round trip costs latency,
   and a chat turn makes several.
3. After the deploy, check:
   - `/robots.txt` disallows everything.
   - A burst of 10 requests to `/api/costs` returns at least 8 `429` responses.
