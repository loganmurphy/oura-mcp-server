# oura-mcp-server

A lightweight [Model Context Protocol](https://modelcontextprotocol.io) server that exposes your [Oura Ring](https://ouraring.com) data as tools for Claude. Runs on Cloudflare Workers with a D1 cache layer for fast repeated queries.

## Architecture

```
Claude Desktop
     │  stdio
  mcp-remote (npx)
     │  HTTP POST /mcp/sleep  or  /mcp/activity
Cloudflare Worker
     ├─ D1 cache  (per-day TTL: 1h today / 6h yesterday / 24h older)
     └─ Oura API  (fetched only for cache misses)
```

Tools are split across two MCP server endpoints to stay within Claude Desktop's per-server tool limit:

| Endpoint | Tools |
|---|---|
| `/mcp/sleep` | `personal_info`, `daily_sleep`, `sleep_sessions`, `daily_readiness`, `daily_spo2` |
| `/mcp/activity` | `daily_activity`, `heart_rate`, `workouts`, `daily_stress` |

On a partial cache hit the worker fetches only the missing date range from Oura and merges it with the cached portion before responding. Empty responses (data not yet synced from the ring) are never cached. Pass `skip_cache: true` on any tool call to bypass the cache entirely.

## Requirements

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is fine)
- [Oura developer account](https://cloud.ouraring.com/personal-access-tokens) with a Personal Access Token
- Node.js 22 LTS and pnpm 10 — [Volta](https://volta.sh) is recommended to manage these automatically (versions are pinned in `package.json`)

## Bootstrap

```bash
pnpm install
pnpm bootstrap
```

An interactive wizard handles the full setup end-to-end. It will:

1. Prompt you for a Cloudflare API token (opens the dashboard and walks through the required permissions)
2. Pick an account and confirm your `workers.dev` subdomain
3. Create a D1 database (`oura-cache`) and apply the schema
4. Show a **plan preview** listing every resource that will be created or reused, and wait for your `y` before touching anything
5. Prompt for your Oura Personal Access Token (or open the token page if you don't have one)
6. Deploy the Worker and set `OURA_API_TOKEN` as a secret
7. Provision Cloudflare Access (Zero Trust) so only your service token can reach the Worker
8. Write the two `oura-sleep` / `oura-activity` entries into your Claude Desktop config (preserving any other MCP servers you have)

Re-running is safe — every step detects existing resources and reuses them. The only delete the wizard performs is removing a superseded service token after rotation.

One manual step: Cloudflare API tokens can't be minted programmatically without an existing token, so the wizard opens the token page and asks you to paste one in, once. The required scopes are listed in the prompt. It's cached in `.dev.vars` and drives both the SDK calls and the `wrangler deploy` step.

When it finishes, fully quit Claude Desktop (Cmd+Q) and relaunch — then ask *"What was my sleep score last night?"*

The sections below cover manual setup (local dev, direct `wrangler deploy`) if you'd rather skip the wizard.

### Just want to try it locally first?

If you'd rather skip Cloudflare entirely and run against the local dev server:

```bash
pnpm install
echo "OURA_API_TOKEN=your_token_here" > .dev.vars
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

# Add your Oura token to local secrets
echo "OURA_API_TOKEN=your_token_here" > .dev.vars

# Apply the D1 schema locally (Miniflare, no Cloudflare account needed)
npx wrangler d1 execute oura-cache --local --file=./migrations/001_init.sql

# Start the dev server on http://localhost:8787
pnpm dev
```

### Smoke test

```bash
# List tools
curl -s -X POST http://localhost:8787/mcp/sleep \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'

# Call a tool
curl -s -X POST http://localhost:8787/mcp/sleep \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"oura_daily_readiness","arguments":{"start_date":"2026-04-14","end_date":"2026-04-20"}}}' | jq .
```

## Deploy to Cloudflare

```bash
# 1. Authenticate
npx wrangler login

# 2. Create the D1 database — copy the printed database_id
npx wrangler d1 create oura-cache

# 3. Paste the database_id into wrangler.jsonc (created from wrangler.example.jsonc)

# 4. Apply the schema to production
npx wrangler d1 execute oura-cache --remote --file=./migrations/001_init.sql

# 5. Set your Oura token as a Worker secret
npx wrangler secret put OURA_API_TOKEN

# 6. Deploy
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

Restart Claude Desktop after any config change.

## Tool reference

All date params are optional and default to the last 7 days (`YYYY-MM-DD` format).

| Tool | Params | Returns |
|---|---|---|
| `oura_personal_info` | — | Age, weight, height, biological sex |
| `oura_daily_sleep` | `start_date`, `end_date` | Sleep score + contributors |
| `oura_sleep_sessions` | `start_date`, `end_date` | Sleep stages, HRV, HR, breathing, temp |
| `oura_daily_readiness` | `start_date`, `end_date` | Readiness score + contributors |
| `oura_daily_spo2` | `start_date`, `end_date` | Blood oxygen saturation |
| `oura_daily_activity` | `start_date`, `end_date` | Steps, calories, activity minutes |
| `oura_heart_rate` | `start_datetime`, `end_datetime` | Continuous BPM readings (ISO 8601) |
| `oura_workouts` | `start_date`, `end_date` | Session type, duration, calories, HR |
| `oura_daily_stress` | `start_date`, `end_date` | Stress, recovery, ruggedness scores |

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

**Only 5 tools showing instead of 9**
- This is expected — Claude Desktop has a per-server tool cap, so tools are intentionally split across two servers (`oura-sleep` and `oura-activity`)
- Confirm both entries exist in `claude_desktop_config.json` and restart Claude Desktop

**Port 8787 already in use**
```bash
lsof -ti :8787 | xargs kill -9
pnpm dev
```

**Today's data missing**
- The Oura v2 API does not expose same-day data in real time — daily scores (sleep, readiness, activity) are computed end-of-day, and workouts can lag several hours even after they appear in the app. This is an Oura API limitation; the app has a direct ring connection the API does not.
- For historical data that should be available but isn't, open the Oura app and trigger a manual sync, then ask Claude again

**Sleep/activity data missing or empty (data not synced yet)**
- Full HRV, stage breakdown, and heart rate detail can take several hours after waking to appear in the API
- Ask Claude to re-fetch with the cache bypassed: *"pull my sleep sessions for today with skip_cache: true"*
- Or bypass cache for an entire endpoint at the URL level (useful during testing): append `?no_cache` to the MCP endpoint in `claude_desktop_config.json`, e.g. `.../mcp/sleep?no_cache`
- Empty responses are never cached, so retrying later will always hit Oura fresh

**Oura API returning 401 / Claude sees "Oura rejected the token"**
- Personal Access Tokens expire every ~3 months. The Worker detects 401/403 from Oura and returns an actionable error in the MCP tool response — so the error you see in Claude will already include the fix command
- Generate a new PAT at [cloud.ouraring.com/personal-access-tokens](https://cloud.ouraring.com/personal-access-tokens)
- Rotate the production secret: `npx wrangler secret put OURA_API_TOKEN` (no redeploy needed — it picks up on the next request)
- For local dev: update `OURA_API_TOKEN=` in `.dev.vars` and restart `pnpm dev`

**`pnpm bootstrap` fails with "Saved API token isn't working"**
- The Cloudflare API token you pasted earlier has expired or been revoked — the wizard automatically removes it from `.dev.vars` and prompts for a new one on the same run, so just follow the prompt
- The API token is separate from the Access *service* token used by Claude Desktop. Only the API token expires; the service token keeps working. Re-running `pnpm bootstrap` is purely to keep admin access to your Cloudflare resources
- **Recommendation:** when you create the replacement, set a **6-12 month TTL** in the Cloudflare token creation UI (`TTL` section). A non-expiring token that leaks is a forever problem

**Cloudflare Access blocking legitimate requests / "Forbidden" in mcp-remote logs**
- Your service token (the one Claude Desktop uses, `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET`) has been revoked, has expired, or the Access policy has drifted
- Re-run `pnpm bootstrap` — it detects the broken state and provisions a fresh service token, then updates your Claude Desktop config
- Don't forget to fully quit Claude Desktop (Cmd+Q) and relaunch afterward

**Service token expiry / rotation**
- Access service tokens default to a **1-year expiry** set by Cloudflare — the wizard accepts that default
- Re-running `pnpm bootstrap` within 14 days of expiry automatically rotates the token and updates your Claude Desktop config — a one-command refresh once a year
- Rotate manually anytime (e.g. if you suspect the secret leaked) by re-running `pnpm bootstrap`

---

## Roadmap

- **Oura OAuth** — the server currently uses a Personal Access Token (personal use only). A future version will support the full Oura OAuth flow so this can be shared as a general-purpose server. The PAT approach is intentional for now to avoid incurring OAuth infrastructure costs.

## Project structure

```
src/
  index.ts       Worker entry — MCP routing and tool dispatch
  cache.ts       D1 cache layer (per-day TTL, partial hit merging)
  oura.ts        Oura API client
  tools.ts       MCP tool definitions (SLEEP_TOOLS / ACTIVITY_TOOLS)
migrations/
  001_init.sql   D1 schema
```
