# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev          # Start local dev server on http://localhost:8787 (Miniflare, hot reload)
pnpm deploy       # Deploy to Cloudflare Workers (requires wrangler login)
pnpm cf-typegen   # Regenerate worker-configuration.d.ts from wrangler.jsonc bindings
pnpm bootstrap      # Interactive wizard — provisions D1, KV, deploys Worker, copies MCP URL to clipboard
pnpm connect-local  # Wire Claude Desktop to the local dev server (localhost:8787) — no Cloudflare needed
pnpm revoke         # Invalidate all active OAuth sessions in KV (Claude re-auths on next use)
pnpm reset          # Clear .dev.vars + .bootstrap-state + wrangler.jsonc (local state only, does not touch KV)
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

`wrangler.jsonc` is gitignored — copy from the template and fill in both IDs:
```bash
cp wrangler.example.jsonc wrangler.jsonc
```

Local secrets live in `.dev.vars` (gitignored). `pnpm bootstrap` manages this file — you should rarely need to touch it by hand:

```
OURA_API_TOKEN=...      # Oura PAT (user-provided)
MCP_AUTH_PASSWORD=...   # Password for the OAuth login page
```

Bootstrap state (Cloudflare account ID) is stored separately in `.bootstrap-state` — also gitignored.

### `scripts/bootstrap.ts` — auth model

Bootstrap authenticates to Cloudflare entirely via `wrangler login` — a standard browser OAuth flow. No Cloudflare SDK is used; all resource provisioning (D1, KV, Worker deploy, secrets) is done through wrangler CLI commands (`wrangler d1 list/create`, `wrangler kv namespace list/create`, `wrangler deploy`, `wrangler secret put`).

Only two manual inputs: an Oura Personal Access Token and a password for the MCP server's login page. All Cloudflare resources are fully automated and idempotent — re-running detects and reuses existing resources. On completion, the MCP server URL is copied to clipboard and `https://claude.ai/settings/connectors` is opened in the browser.

## Architecture

There is no build step. Wrangler bundles `src/index.ts` directly via esbuild on `dev`/`deploy`. `worker-configuration.d.ts` is generated (gitignored) — run `pnpm cf-typegen` after changing bindings in `wrangler.jsonc`.

### Request flow

```
POST /mcp  (with Bearer token)
  → OAuthProvider.fetch()         verify token in OAUTH_KV
      → McpApiHandler.fetch()     single /mcp route
          → handleMcp()           parse JSON-RPC, route by method
              → tools/list        return OURA_TOOLS (all 7) from tools.ts
              → tools/call        dispatch to handleDateRangeTool() for all tools
                  handleDateRangeTool()    per-day D1 cache, returns plain JSON

GET /authorize  → defaultHandler  render password form (HTML)
POST /authorize → defaultHandler  validate MCP_AUTH_PASSWORD, completeAuthorization() → redirect
/oauth/token    → OAuthProvider   token exchange (handled internally)
/oauth/register → OAuthProvider   dynamic client registration (handled internally)
```

### OAuth layer (`src/index.ts`)

`export default new OAuthProvider<Env>({...})` wraps the Worker. All `/mcp/*` requests require a valid Bearer token (stored in `OAUTH_KV`). Unauthenticated requests get 401 with a `WWW-Authenticate` header pointing to the discovery endpoint.

The auth UI is a password form served at `GET /authorize`. On submit it calls `env.OAUTH_PROVIDER.completeAuthorization()` and redirects back to the client. `mcp-remote` handles the full OAuth PKCE flow automatically — the user just enters their password in the browser that opens.

**Env bindings:**
- `OAUTH_KV: KVNamespace` — required by `@cloudflare/workers-oauth-provider` (binding name is hardcoded in the library)
- `MCP_AUTH_PASSWORD: string` — Worker secret; checked by the login form
- `OAUTH_PROVIDER: OAuthHelpers` — injected by OAuthProvider at runtime into env before delegating to handlers

**Token TTLs:** 30-day access tokens, refresh tokens never expire (single-user personal tool).

**`handleMcp` is exported** as a named export so tests can call MCP logic directly without going through the OAuth wrapper.

### Testing strategy

`src/__tests__/index.test.ts` calls `handleMcp` directly (bypassing OAuth) for MCP logic tests. The routing tests that call `worker.fetch()` only exercise the `defaultHandler` routes (`/health`, `/`) and the OAuthProvider's 401 behavior on unauthenticated `/mcp/*` requests.

`src/__tests__/mocks/cloudflare-workers.ts` provides a minimal `WorkerEntrypoint` stub — `cloudflare:workers` is not available in Node's ESM loader, so `vitest.config.ts` maps it to this stub (with `server.deps.inline` forcing `@cloudflare/workers-oauth-provider` through Vite's pipeline so the alias applies to its internal imports too).

**End-to-end testing with ngrok:** Claude.ai web and mobile require HTTPS. Use ngrok to expose the local dev server:
```bash
pnpm dev          # terminal 1
ngrok http 8787   # terminal 2 — produces https://xxx.ngrok-free.app
```
Use the ngrok URL in place of the Cloudflare Worker URL when testing Claude.ai web/mobile integrations. See README for the full pre-merge checklist.

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

### Tools

All 7 tools are served from a single `/mcp` endpoint via `OURA_TOOLS` in `tools.ts` (a combined export of `SLEEP_TOOLS` + `ACTIVITY_TOOLS`). `McpApiHandler` calls `handleMcp` with `OURA_TOOLS` directly.

Adding a new tool: add the Oura fetch function in `oura.ts`, add the `ToolDef` to `SLEEP_TOOLS` or `ACTIVITY_TOOLS` in `tools.ts`, add a `case` in `fetchFromOura()` in `index.ts`, and add the tool name to `DATE_KEYED_TOOLS` if it returns per-day items.

### Oura API

All endpoints are under `https://api.ouraring.com/v2/usercollection/`. Date-range endpoints accept `start_date`/`end_date` (YYYY-MM-DD) and return `{ data: [...], next_token }`. Defaults to last 7 days when params are omitted. The token is passed as `Authorization: Bearer`.

**Date conventions (empirically verified):**
- Sleep/readiness/SpO2 use the **wake-up date** for the `day` field — a session starting the night of Apr 23 and ending the morning of Apr 24 has `day: "2026-04-24"`. Use today's date to get last night's data.
- Activity/workouts/stress use the **calendar date** for the `day` field.
- `oura_daily_sleep` `end_date` is **inclusive** (Oura API exception).
- **All other endpoints** treat `end_date` as **exclusive** — querying through Apr 24 requires sending `end_date: "2026-04-25"` to the API. The Worker handles this transparently via `exclusiveEnd()` / `addOneDay()` in `fetchFromOura`, so all tool callers use the same inclusive `end_date` convention.
