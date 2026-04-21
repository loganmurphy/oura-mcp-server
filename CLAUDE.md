# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev          # Start local dev server on http://localhost:8787 (Miniflare, hot reload)
pnpm deploy       # Deploy to Cloudflare Workers (requires wrangler login)
pnpm cf-typegen   # Regenerate worker-configuration.d.ts from wrangler.jsonc bindings
pnpm onboard      # Interactive wizard — provisions D1, deploys Worker, sets up Zero Trust, wires Claude Desktop
npx tsc --noEmit -p tsconfig.scripts.json   # Type-check the onboard script
npx tsc --noEmit                             # Type-check the Worker (no build step — wrangler bundles via esbuild)
```

D1 migrations:
```bash
npx wrangler d1 execute oura-cache --local --file=./migrations/001_init.sql   # local
npx wrangler d1 execute oura-cache --remote --file=./migrations/001_init.sql  # production
```

`wrangler.jsonc` is gitignored — copy from the template and fill in your D1 `database_id`:
```bash
cp wrangler.example.jsonc wrangler.jsonc
```

Local secrets live in `.dev.vars` (gitignored). `pnpm onboard` manages this file — you should rarely need to touch it by hand:

```
OURA_API_TOKEN=...                # Oura PAT (user-provided)
CLOUDFLARE_ACCOUNT_ID=...         # Selected during onboard, remembered across runs
WORKER_SUBDOMAIN=...              # Your *.workers.dev subdomain
CLOUDFLARE_ACCESS_API_TOKEN=...   # Access-scoped API token for Zero Trust calls
CF_ACCESS_CLIENT_ID=...           # Service token credentials — used by mcp-remote via
CF_ACCESS_CLIENT_SECRET=...       #   the Claude Desktop config's `env` block
```

### `scripts/onboard.ts` — auth model

Browser OAuth on every run (PKCE against wrangler's public client ID `54d11594-84e4-41aa-b438-e81b8fa78ee7`, fixed callback `http://localhost:8976/oauth/callback`). No persisted Cloudflare user credentials — OAuth tokens aren't saved because they expire, and we don't accept Global API Keys or user-supplied `CLOUDFLARE_API_TOKEN` anymore (simpler, one code path).

One wrinkle: OAuth scopes from wrangler's client don't cover Zero Trust / Access endpoints, and the `POST /user/tokens` mint-a-scoped-token endpoint also requires scopes OAuth doesn't grant. So the script has a one-time manual step — it asks the user to create an API token with `Access: Apps and Policies → Edit` + `Access: Service Tokens → Edit`, pasted once and cached under `CLOUDFLARE_ACCESS_API_TOKEN`.

Idempotency: D1 database, Access app, service token (reused from saved creds if still present on Cloudflare), and policy are all detected and reused. The script never deletes resources — stale leftovers are the user's to manage.

## Architecture

There is no build step. Wrangler bundles `src/index.ts` directly via esbuild on `dev`/`deploy`. `worker-configuration.d.ts` is generated (gitignored) — run `pnpm cf-typegen` after changing bindings in `wrangler.jsonc`.

### Request flow

```
POST /mcp/sleep or /mcp/activity
  → handleMcp()          parse JSON-RPC, route by method
      → tools/list       return SLEEP_TOOLS or ACTIVITY_TOOLS from tools.ts
      → tools/call       dispatch to one of three handlers:
          handleSingletonTool()    personal_info — D1 singleton cache, 24h TTL
          handleHeartRateTool()    heart_rate — no cache (datetime-keyed, not date-keyed)
          handleDateRangeTool()    all other tools — per-day D1 cache with SSE streaming
```

### Cache strategy (`src/cache.ts`)

`handleDateRangeTool` is the most complex path. It:
1. Enumerates all dates in the requested range via `datesInRange()`
2. Queries D1 for cached rows — TTL is **1h today / 6h yesterday / 24h older**
3. **All cached** → returns JSON immediately
4. **Partial/no cache** → opens a `TransformStream`, returns SSE response, then:
   - Writes cached dates as a partial SSE event (if any hits)
   - Fetches only the missing date sub-range from Oura
   - Writes the merged complete result as a final SSE event
   - Caches new items via `ctx.waitUntil()` (non-blocking)

Multi-session days (e.g. nap + main sleep in `sleep_sessions`) are stored as an array under one `date_key` row via `groupByDay()`.

**Empty responses are never cached.** Oura processes session data after waking — the daily score syncs quickly but full HRV/stage/HR data can lag by several hours. An empty `data: []` response means "not ready yet", not "no data", so caching it would serve stale emptiness until TTL expires.

**Cache bypass — three levels:**
- `skip_cache: true` tool argument — per-call, Claude can pass this when data seems stale
- `?no_cache` query param on the endpoint URL — per-request, bypasses cache for all tools in that request; useful for `curl` smoke tests
- `NO_CACHE=true` env var (in `.dev.vars` locally or as a `var` in `wrangler.jsonc`) — deployment-wide, disables all D1 reads/writes; intended for a dedicated debug worker, not production

None of the bypass paths write to the cache.

### Tool split

Claude Desktop enforces a per-MCP-server tool cap (~5). Tools are split into two endpoints served by the same Worker:
- `/mcp/sleep` → `SLEEP_TOOLS` (sleep, readiness, SpO2, personal info)
- `/mcp/activity` → `ACTIVITY_TOOLS` (activity, heart rate, workouts, stress)

Adding a new tool means: add the Oura fetch function in `oura.ts`, add the `ToolDef` to the appropriate array in `tools.ts`, add a `case` in `fetchFromOura()` in `index.ts`, and add the tool name to `DATE_KEYED_TOOLS` if it returns per-day items.

### Oura API

All endpoints are under `https://api.ouraring.com/v2/usercollection/`. Date-range endpoints accept `start_date`/`end_date` (YYYY-MM-DD) and return `{ data: [...], next_token }`. Defaults to last 7 days when params are omitted. The token is passed as `Authorization: Bearer`.
