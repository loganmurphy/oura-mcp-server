# oura-mcp-server

[![CI](https://img.shields.io/github/actions/workflow/status/loganmurphy/oura-mcp-server/ci.yml?label=CI)](https://github.com/loganmurphy/oura-mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-5F7FFF?logo=buy-me-a-coffee&logoColor=white)](https://www.buymeacoffee.com/loganmurphc)

A lightweight [Model Context Protocol](https://modelcontextprotocol.io) server that exposes your [Oura Ring](https://ouraring.com) data as tools for Claude. Runs on Cloudflare Workers with a D1 cache layer for fast repeated queries.

> **Platform support:** currently works with **Claude Desktop** only. Web and mobile support is coming soon.

## Architecture

```
Claude Desktop
     │  stdio
  mcp-remote (npx)
     │  HTTP POST /mcp/sleep  or  /mcp/activity
Cloudflare Worker  (OAuth 2.1 via @cloudflare/workers-oauth-provider)
     ├─ KV            (OAuth tokens — 30-day access tokens)
     ├─ D1 cache      (per-day TTL: 1h today / 6h yesterday / 24h older)
     └─ Oura API      (fetched only for cache misses)
```

Access is protected by a password you set during bootstrap. `mcp-remote` handles the OAuth flow automatically — it opens a browser login page on first connection, then caches the access token for 30 days before re-auth is needed.

Tools are split across two MCP server endpoints to stay within Claude Desktop's per-server tool limit:

| Endpoint | Tools |
|---|---|
| `/mcp/sleep` | `daily_sleep`, `sleep_sessions`, `daily_readiness`, `daily_spo2` |
| `/mcp/activity` | `daily_activity`, `workouts`, `daily_stress` |

On a partial cache hit the worker fetches only the missing date range from Oura and merges it with the cached portion before responding. Empty responses (data not yet synced from the ring) are never cached. Pass `skip_cache: true` on any tool call to bypass the cache entirely.

## Requirements

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is fine)
- [Oura developer account](https://cloud.ouraring.com/personal-access-tokens) with a Personal Access Token
- Node.js 24 and pnpm 10 — [Volta](https://volta.sh) is recommended to manage these automatically (versions are pinned in `package.json`)

## Bootstrap

```bash
pnpm install
pnpm bootstrap
```

An interactive wizard handles the full setup end-to-end. It will:

1. Sign in to Cloudflare via `wrangler login` (opens a browser — free account sign-up works)
2. Pick an account and confirm your `workers.dev` subdomain
3. Show a **plan preview** listing every resource that will be created or reused, and wait for your `y` before touching anything
4. Create a D1 database (`oura-cache`) and a KV namespace (`oura-oauth`)
5. Prompt for your Oura Personal Access Token (or open the token page if you don't have one)
6. Prompt you to choose an MCP server password
7. Deploy the Worker and set `OURA_API_TOKEN` + `MCP_AUTH_PASSWORD` as secrets
8. Write the two `oura-sleep` / `oura-activity` entries into your Claude Desktop config (preserving any other MCP servers you have)

Re-running is safe — every step detects existing resources and reuses them. The only manual inputs are your Oura PAT and your chosen password.

When it finishes, fully quit Claude Desktop (Cmd+Q) and relaunch — then ask *"What was my sleep score last night?"*

On first connection, `mcp-remote` will open a browser window and ask you to enter the password you set during bootstrap. The access token lasts 30 days before you need to re-authenticate.

### Just want to try it locally first?

If you'd rather skip Cloudflare entirely and run against the local dev server:

```bash
pnpm install
echo "OURA_API_TOKEN=your_token_here" > .dev.vars
echo "MCP_AUTH_PASSWORD=your_password" >> .dev.vars
pnpm connect-local   # writes Claude Desktop config pointing at localhost:8787
pnpm dev             # keep running in a separate terminal
```

Then fully quit Claude Desktop (Cmd+Q) and relaunch. Run `pnpm bootstrap` when you're ready to deploy.

## Local development

```bash
# Copy the config template and fill in your own values (see Deploy section)
cp wrangler.example.jsonc wrangler.jsonc

pnpm install

# Generate Worker environment types (derives from wrangler.jsonc)
pnpm cf-typegen

# Add your secrets to local secrets
echo "OURA_API_TOKEN=your_token_here" > .dev.vars
echo "MCP_AUTH_PASSWORD=your_password" >> .dev.vars

# Apply the D1 schema locally (Miniflare, no Cloudflare account needed)
npx wrangler d1 execute oura-cache --local --file=./migrations/001_init.sql

# Start the dev server on http://localhost:8787
pnpm dev
```

### Smoke test

```bash
# List tools (no auth needed for metadata discovery)
curl -s http://localhost:8787/.well-known/oauth-authorization-server | jq .

# Unauthenticated call returns 401 — this is expected
curl -s -X POST http://localhost:8787/mcp/sleep \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq .

# Use mcp-remote to go through the full OAuth flow and call a tool:
npx mcp-remote http://localhost:8787/mcp/sleep
```

## Deploy to Cloudflare

```bash
# 1. Authenticate
npx wrangler login

# 2. Create the D1 database — copy the printed database_id
npx wrangler d1 create oura-cache

# 3. Create the KV namespace — copy the printed id
npx wrangler kv namespace create OAUTH_KV

# 4. Paste both IDs into wrangler.jsonc (created from wrangler.example.jsonc)

# 5. Apply the schema to production
npx wrangler d1 execute oura-cache --remote --file=./migrations/001_init.sql

# 6. Set your secrets
npx wrangler secret put OURA_API_TOKEN
npx wrangler secret put MCP_AUTH_PASSWORD

# 7. Deploy
pnpm deploy
```

Your Worker will be live at `https://oura-mcp-server.<your-subdomain>.workers.dev`.

## Connect to Claude Desktop

Add both MCP servers to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "oura-sleep": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://oura-mcp-server.<your-subdomain>.workers.dev/mcp/sleep"]
    },
    "oura-activity": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://oura-mcp-server.<your-subdomain>.workers.dev/mcp/activity"]
    }
  }
}
```

For local dev, use `http://localhost:8787/mcp/sleep` etc. and keep `pnpm dev` running.

Restart Claude Desktop after any config change. On first connection, a browser window will open for the password prompt.

## Tool reference

All date params are optional and default to the last 7 days (`YYYY-MM-DD` format). All `end_date` values are **inclusive** from the caller's perspective.

| Tool | Params | Returns |
|---|---|---|
| `oura_daily_sleep` | `start_date`, `end_date` | Sleep score + contributors |
| `oura_sleep_sessions` | `start_date`, `end_date` | Sleep stages, HRV, HR, breathing, temp |
| `oura_daily_readiness` | `start_date`, `end_date` | Readiness score + contributors |
| `oura_daily_spo2` | `start_date`, `end_date` | Blood oxygen saturation |
| `oura_daily_activity` | `start_date`, `end_date` | Steps, calories, activity minutes |
| `oura_workouts` | `start_date`, `end_date` | Session type, duration, calories, HR |
| `oura_daily_stress` | `start_date`, `end_date` | Stress, recovery, ruggedness scores |

### Date conventions

**`day` field:**
- Sleep, readiness, and SpO2 use the **wake-up date** — a sleep starting the night of Apr 23 and ending the morning of Apr 24 has `day: "2026-04-24"`. Use today's date to get last night's data. `oura_daily_sleep` and `oura_sleep_sessions` share the same `day` field and can be joined by it.
- Activity, workouts, and stress use the **calendar date** of the event.

**`end_date` behavior:**
All `end_date` values are **inclusive** from the caller's perspective across all tools. Internally, the Oura `daily_sleep` endpoint is the only one that treats `end_date` as inclusive; every other endpoint treats it as exclusive. The server adds +1 day automatically before calling the API for all non-daily_sleep tools, so you never need to adjust dates yourself.

## Troubleshooting

**Tools not appearing in Claude Desktop**
- Fully quit Claude Desktop (Cmd+Q, not just close the window) and relaunch — it only loads the MCP tool list at startup
- Check the config file path is exactly `~/Library/Application Support/Claude/claude_desktop_config.json`
- Make sure you saved the file and it's valid JSON — a trailing comma will silently break it

**"OURA_API_TOKEN secret not configured" error**
- For local dev: confirm `.dev.vars` exists in the project root with `OURA_API_TOKEN=your_token_here`
- The dev server must be restarted after creating or editing `.dev.vars`
- For production: run `npx wrangler secret put OURA_API_TOKEN` and redeploy

**Claude can't connect / "MCP server disconnected"**
- For local dev: confirm `pnpm dev` is running in the project directory
- Test the server is reachable: `curl http://localhost:8787/health`
- `mcp-remote` requires Node.js — confirm with `node --version` (needs 22 LTS; use [Volta](https://volta.sh) to match the pinned version)
- Try clearing the mcp-remote cache: `rm -rf ~/.mcp-remote`

**Not seeing all 7 tools (4 sleep + 3 activity)**
- Claude Desktop has a per-server tool cap, so tools are intentionally split across two servers (`oura-sleep` and `oura-activity`)
- Confirm both entries exist in `claude_desktop_config.json` and restart Claude Desktop

**Port 8787 already in use**
```bash
lsof -ti :8787 | xargs kill -9
pnpm dev
```

**Today's sleep/activity data missing or empty**
- Sleep scores, readiness, and SpO2 are available as soon as the ring syncs after waking — open the Oura app to trigger a sync if data isn't showing up
- Today's activity data is live and partial while the day is still in progress (steps/calories accumulate throughout the day)
- If data appears stale, ask Claude to re-fetch with the cache bypassed: *"pull my sleep sessions for today with skip_cache: true"*
- Empty responses are never cached, so retrying later will always hit Oura fresh

**Oura API returning 401 / Claude sees "Oura rejected the token"**
- Personal Access Tokens expire every ~3 months. The Worker detects 401/403 from Oura and returns an actionable error in the MCP tool response — so the error you see in Claude will already include the fix command
- Generate a new PAT at [cloud.ouraring.com/personal-access-tokens](https://cloud.ouraring.com/personal-access-tokens)
- Rotate the production secret: `npx wrangler secret put OURA_API_TOKEN` (no redeploy needed — it picks up on the next request)
- For local dev: update `OURA_API_TOKEN=` in `.dev.vars` and restart `pnpm dev`

**`pnpm bootstrap` fails at the Cloudflare login step**
- Run `npx wrangler login` manually to re-authenticate — the wizard will pick up the cached token on the next run
- If you need to use a specific API token instead of browser login, set `CLOUDFLARE_API_TOKEN` in your environment before running bootstrap

**Re-authenticating / rotating the MCP password**
- To change the password: run `npx wrangler secret put MCP_AUTH_PASSWORD`, then clear the mcp-remote token cache (`rm -rf ~/.mcp-remote`) and relaunch Claude Desktop
- Existing 30-day access tokens are automatically revoked when `completeAuthorization` is called with `revokeExistingGrants: true` (the default)

---

## Roadmap

- **Web & mobile support** — currently requires Claude Desktop. The OAuth layer is already in place; a future update will expose a public registration flow so any MCP-compatible client (Claude.ai web, mobile) can connect.

## Project structure

```
src/
  index.ts          Worker entry — OAuthProvider wrapper, MCP routing, tool dispatch
  cache.ts          D1 cache layer (per-day TTL, partial hit merging)
  oura.ts           Oura API client
  tools.ts          MCP tool definitions (SLEEP_TOOLS / ACTIVITY_TOOLS)
scripts/
  bootstrap.ts      Interactive setup wizard (D1, KV, Worker deploy, Claude Desktop config)
  connect-local.ts  Wire Claude Desktop to the local dev server
  utils.ts          Shared helpers (prompts, platform detection)
migrations/
  001_init.sql      D1 schema
```

---

If this saved you some time, a coffee is always appreciated!

[![Buy Me a Coffee](https://cdn.buymeacoffee.com/buttons/v2/default-blue.png)](https://www.buymeacoffee.com/loganmurphc)
