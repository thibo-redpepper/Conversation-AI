# ghl-vastgoed-inbox-tool

Internal MVP for searching contacts in GoHighLevel (LeadConnector), viewing conversations/messages, composing replies, and generating Dutch draft suggestions.

## Setup

1) Install deps:

```bash
npm install
```

2) Create `.env` in the repo root:

```bash
cp .env.example .env
```

Fill in:
- `GHL_<NAME>_PRIVATE_TOKEN` and `GHL_<NAME>_LOCATION_ID` for each subaccount
  - e.g. `GHL_VASTGOED_PRIVATE_TOKEN`, `GHL_VASTGOED_LOCATION_ID`
- Optional legacy fallback: `GHL_PRIVATE_TOKEN` + `GHL_LOCATION_ID`
- `GHL_API_VERSION` (optional; defaults to `2021-07-28`)
- `OPENAI_API_KEY` (optional)
- `OPENAI_MODEL` (optional; defaults to `gpt-4o-mini`)
- `OPENAI_PRICE_INPUT_PER_1M` and `OPENAI_PRICE_OUTPUT_PER_1M` (optional; for cost display)
- `USD_TO_EUR_RATE` (optional; for € estimate in UI)
- `SUPABASE_PROJECT_ID` or `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (for sync/storage)
- `HASH_SALT` (optional; salt for anonymized IDs)
- `SYNC_ENABLED` (set `true` to run background sync)
- `SYNC_INTERVAL_SEC`, `SYNC_MAX_CONVERSATIONS`, `SYNC_MAX_PAGES`, `SYNC_MESSAGE_LIMIT`, `SYNC_MAX_MESSAGES` (tuning)
- `SYNC_CREATE_DRAFTS_ON_BACKFILL` (set `true` to generate drafts during backfill)
- `SUPABASE_PROJECT_ID` or `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (optional; for draft logging)
- `HASH_SALT` (optional; used to hash ids)
- `SYNC_ENABLED` and `SYNC_INTERVAL_SECONDS` (optional; background sync to Supabase)

### Supabase migrations for AI Agents + Workflows

Run these scripts in the Supabase SQL editor (in this order):

1. `server/supabase/schema.sql`
2. `server/supabase/ai_agents.sql`
3. `server/supabase/workflows.sql`

Without `ai_agents.sql`, the AI Agents page falls back to local storage and advanced features
(versions, publish/rollback, knowledge index, evals, handoff logging, KPI stats) are not persisted.

3) Run dev servers:

```bash
npm run dev
```

- Client: http://localhost:5173
- Server: http://localhost:3001

## Scripts

- `npm run dev` – starts server + client
- `npm run build` – builds server + client
- `npm run test` – runs server tests (builders + pagination)

## Troubleshooting

### 401 Unauthorized
- Check `GHL_PRIVATE_TOKEN` in `.env`.

### Version header errors
- Ensure `GHL_API_VERSION` is set (default is `2021-07-28`).

### 429 Rate limit
- Reduce request frequency; wait and retry. The UI will surface the 429 message.

## Notes
- The OpenAI suggestion is optional. If `OPENAI_API_KEY` is missing, the server returns a deterministic Dutch template based on the latest inbound message.
- The UI shows an estimated cost per auto-suggest based on token usage and your configured pricing + FX rate.
- Supabase tables are defined in `server/db/schema.sql`.
- Optional views + example queries are in `server/db/views.sql` and `server/db/examples.sql`.
- Dashboard helper views are in `server/db/dashboard.sql`.
- DNS storage table is defined in `server/db/dns.sql`.
- Mailgun send endpoint is `POST /api/mailgun/send` and uses `.env` keys.
- Mailgun inbound webhook endpoint: `POST /api/mailgun/webhook/inbound`
- Twilio inbound webhook endpoint: `POST /api/twilio/webhook/inbound` (configure this on your Twilio number).
- Fallback polling for inbound SMS is enabled by default when Twilio creds are present:
  - `TWILIO_INBOUND_POLL_ENABLED=true|false`
  - `TWILIO_INBOUND_POLL_INTERVAL_SEC` (default `30`)
  - `TWILIO_INBOUND_POLL_LOOKBACK_MIN` (default `180`)
  - `TWILIO_INBOUND_POLL_TO_NUMBERS` (optional comma-separated receive numbers; fallback is `TWILIO_FROM_NUMBER`)
- Use `POST /api/sync` with `{ "full": true }` to backfill all conversations.
- AI agent selection in Conversations is intentionally manual for now.
- Lost draft test mode uses `server/db/lost_drafts.sql` + `server/db/dashboard.sql` (view `dashboard_lost_drafts_recent`).

## Supabase (optional logging)

If you want to log all inbound messages + AI drafts to Supabase:

1) Run the SQL in `server/supabase/schema.sql` inside the Supabase SQL editor.
2) Set env vars:
   - `SUPABASE_PROJECT_ID` (or `SUPABASE_URL`)
   - `SUPABASE_SERVICE_KEY` (server-only)
   - `SYNC_ENABLED=true`
3) Restart the server.

By default, IDs are hashed and message bodies are lightly redacted (emails/phones).
