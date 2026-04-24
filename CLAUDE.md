# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev          # Start local dev server on http://localhost:8787 (Miniflare, hot reload)
pnpm deploy       # Deploy to Cloudflare Workers (requires wrangler login)
pnpm cf-typegen   # Regenerate worker-configuration.d.ts from wrangler.jsonc bindings
pnpm bootstrap      # Interactive wizard — provisions D1, deploys Worker, sets up Zero Trust, wires Claude Desktop
pnpm connect-local  # Wire Claude Desktop to the local dev server (localhost:8787) — no Cloudflare needed
pnpm reset          # Clear .dev.vars + wrangler.jsonc (use before re-running bootstrap against a different CF account)
pnpm lint           # oxlint (typescript/no-explicit-any + recommended rules, --deny-warnings)
pnpm test           # Vitest unit tests
pnpm coverage       # Vitest + v8 coverage (≥90% threshold)
npx tsc --noEmit -p tsconfig.scripts.json   # Type-check the bootstrap script
npx tsc --noEmit                             # Type-check the Worker (no build step — wrangler bundles via esbuild)
```

Pre-commit hooks are managed by **lefthook** (`lefthook.yml`). They install automatically on `pnpm install` and run lint + both typechecks in parallel before every commit. To run manually: `pnpm lefthook run pre-commit`.

D1 migrations:
```bash
npx wrangler d1 execute oura-cache --local --file=./migrations/001_init.sql   # local
npx wrangler d1 execute oura-cache --remote --file=./migrations/001_init.sql  # production
```

`wrangler.jsonc` is gitignored — copy from the template and fill in your D1 `database_id`:
```bash
cp wrangler.example.jsonc wrangler.jsonc
```

Local secrets live in `.dev.vars` (gitignored). `pnpm bootstrap` manages this file — you should rarely need to touch it by hand:

```
OURA_API_TOKEN=...                # Oura PAT (user-provided)
CLOUDFLARE_API_TOKEN=...          # Scoped API token — drives both SDK calls and `wrangler deploy`
CLOUDFLARE_ACCOUNT_ID=...         # Selected during bootstrap, remembered across runs
WORKER_SUBDOMAIN=...              # Your *.workers.dev subdomain
CF_ACCESS_CLIENT_ID=...           # Service token credentials — used by mcp-remote via
CF_ACCESS_CLIENT_SECRET=...       #   the Claude Desktop config's `env` block
```

### `scripts/bootstrap.ts` — auth model

One manually-created Cloudflare API token drives everything — the SDK client and the wrangler CLI (via `CLOUDFLARE_API_TOKEN` in env). The user creates it once in the dashboard with the scope list in `REQUIRED_SCOPES` (Account Settings Read, Workers Scripts Edit, D1 Edit, Access: Apps and Policies Edit, Access: Service Tokens Edit, User Details Read) and pastes it; it's cached in `.dev.vars` and verified on every run.

Zero Trust subscription enrollment (credit card + Free plan signup) can't be done via API — fresh accounts have to complete the signup in the dashboard. `ensureAccessEnabled` opens `dash.cloudflare.com/<account>/one/` and waits for the user to finish the wizard, retrying the probe up to 3 times. After the org exists, everything else (app, service token, policy) is programmatic.

Why not OAuth? Wrangler's public OAuth client doesn't grant Access / Zero Trust scopes, and `POST /user/tokens` (the mint-a-scoped-token endpoint) also requires scopes the OAuth session doesn't have. One pasted token with the right scopes is simpler and covers both SDK and CLI needs.

Idempotency: D1 database, Access app, service token (reused from saved creds if still present on Cloudflare), and policy are all detected and reused. The only delete the script performs is removing a superseded service token after rotation, once the new one is wired into the policy.

## Architecture

There is no build step. Wrangler bundles `src/index.ts` directly via esbuild on `dev`/`deploy`. `worker-configuration.d.ts` is generated (gitignored) — run `pnpm cf-typegen` after changing bindings in `wrangler.jsonc`.

### Request flow

```
POST /mcp/sleep or /mcp/activity
  → handleMcp()          parse JSON-RPC, route by method
      → tools/list       return SLEEP_TOOLS or ACTIVITY_TOOLS from tools.ts
      → tools/call       dispatch to handleDateRangeTool() for all tools
          handleDateRangeTool()    per-day D1 cache, returns plain JSON
```

### Cache strategy (`src/cache.ts`)

`handleDateRangeTool`:
1. Enumerates all dates in the requested range via `datesInRange()`
2. Queries D1 for cached rows — TTL is **1h today / 6h yesterday / 24h older**
3. **Full cache hit** → returns JSON immediately
4. **Partial/no cache** → fetches only the missing date sub-range from Oura, merges with cache hits, returns JSON, caches new items via `ctx.waitUntil()` (non-blocking)

Multi-session days (e.g. nap + main sleep in `sleep_sessions`) are stored as an array under one `date_key` row via `groupByDay()`.

**Empty responses are never cached.** An empty `data: []` typically means the ring hasn't synced yet — open the Oura app to trigger a sync. Caching an empty response would serve stale emptiness until TTL expires, so empty results are always passed through uncached.

**Cache bypass — two levels:**
- `skip_cache: true` tool argument — per-call, Claude can pass this when data seems stale
- `?no_cache` query param on the endpoint URL — per-request; useful for `curl` smoke tests

Neither path writes to the cache.

### Tool split

Claude Desktop enforces a per-MCP-server tool cap (~5). Tools are split into two endpoints served by the same Worker:
- `/mcp/sleep` → `SLEEP_TOOLS` (daily_sleep, sleep_sessions, daily_readiness, daily_spo2)
- `/mcp/activity` → `ACTIVITY_TOOLS` (daily_activity, workouts, daily_stress)

Adding a new tool means: add the Oura fetch function in `oura.ts`, add the `ToolDef` to the appropriate array in `tools.ts`, add a `case` in `fetchFromOura()` in `index.ts`, and add the tool name to `DATE_KEYED_TOOLS` if it returns per-day items.

### Oura API

All endpoints are under `https://api.ouraring.com/v2/usercollection/`. Date-range endpoints accept `start_date`/`end_date` (YYYY-MM-DD) and return `{ data: [...], next_token }`. Defaults to last 7 days when params are omitted. The token is passed as `Authorization: Bearer`.

**Date conventions (empirically verified):**
- Sleep/readiness/SpO2 use the **wake-up date** for the `day` field — a session starting the night of Apr 23 and ending the morning of Apr 24 has `day: "2026-04-24"`. Use today's date to get last night's data.
- Activity/workouts/stress use the **calendar date** for the `day` field.
- `oura_daily_sleep` `end_date` is **inclusive** (Oura API exception).
- **All other endpoints** treat `end_date` as **exclusive** — querying through Apr 24 requires sending `end_date: "2026-04-25"` to the API. The Worker handles this transparently via `exclusiveEnd()` / `addOneDay()` in `fetchFromOura`, so all tool callers use the same inclusive `end_date` convention.
