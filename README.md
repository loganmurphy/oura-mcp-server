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

On a partial cache hit the worker streams the cached portion to the client immediately via SSE, fetches only the missing date range from Oura, then sends the merged complete result. Empty responses (data not yet synced from the ring) are never cached. Pass `skip_cache: true` on any tool call to bypass the cache entirely.

## Requirements

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is fine)
- [Oura developer account](https://cloud.ouraring.com/personal-access-tokens) with a Personal Access Token
- Node.js 22 LTS and pnpm 10 — [Volta](https://volta.sh) is recommended to manage these automatically (versions are pinned in `package.json`)

## Onboarding

```bash
pnpm install
pnpm onboard
```

An interactive wizard handles the full setup end-to-end — no manual Cloudflare dashboard clicks, no hand-edited config files. It will:

1. Log you in to Cloudflare via your browser (PKCE, no credentials stored — same flow `wrangler login` uses)
2. Pick an account and confirm your `workers.dev` subdomain
3. Create a D1 database (`oura-cache`) and apply the schema
4. Show a **plan preview** listing every resource that will be created or reused, and wait for your `y` before touching anything
5. Prompt for your Oura Personal Access Token (or open the token page if you don't have one)
6. Deploy the Worker and set `OURA_API_TOKEN` as a secret
7. Provision Cloudflare Access (Zero Trust) so only your service token can reach the Worker
8. Write the two `oura-sleep` / `oura-activity` entries into your Claude Desktop config (preserving any other MCP servers you have)

Re-running is safe — every step detects existing resources and reuses them. The wizard never deletes anything.

One manual step: the Zero Trust provisioning needs a Cloudflare API token with `Access: Apps and Policies` + `Access: Service Tokens` permissions. Wrangler's OAuth client doesn't grant Access scopes, so we can't mint this programmatically — the wizard opens the token page and asks you to paste one in, once. It's cached in `.dev.vars` for subsequent runs.

When it finishes, fully quit Claude Desktop (Cmd+Q) and relaunch — then ask *"What was my sleep score last night?"*

<details>
<summary>Prefer to do it by hand?</summary>

The sections below walk through the equivalent manual setup.
</details>

## Local development

```bash
# Copy the config template and fill in your own values (see Deploy section)
cp wrangler.example.jsonc wrangler.jsonc

pnpm install

# Generate Worker environment types (derives from wrangler.jsonc)
pnpm cf-typegen

# Add your Oura token (and any optional overrides) to local secrets
# .dev.vars contents:
#   OURA_API_TOKEN=your_token_here
#   NO_CACHE=true        # optional — disables D1 caching for this local session
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

**Sleep/activity data missing or empty (data not synced yet)**
- Oura processes session data after you wake up — the daily score arrives quickly but full HRV, stage breakdown, and heart rate data can take several hours
- Ask Claude to re-fetch with the cache bypassed: *"pull my sleep sessions for today with skip_cache: true"*
- Or bypass cache for an entire endpoint at the URL level (useful during testing): append `?no_cache` to the MCP endpoint in `claude_desktop_config.json`, e.g. `.../mcp/sleep?no_cache`
- Empty responses are never cached, so retrying later will always hit Oura fresh

**Oura API returning 401**
- Personal Access Tokens expire — generate a new one at [cloud.ouraring.com/personal-access-tokens](https://cloud.ouraring.com/personal-access-tokens) and update your `.dev.vars` or Worker secret

---

## Roadmap

- **Oura OAuth** — the server currently uses a Personal Access Token (personal use only). A future version will support the full Oura OAuth flow so this can be shared as a general-purpose server. The PAT approach is intentional for now to avoid incurring OAuth infrastructure costs.

## Tutorial

> 📸 _Screenshots and walkthrough coming soon._

## Project structure

```
src/
  index.ts       Worker entry — MCP routing + SSE streaming
  cache.ts       D1 cache layer (per-day TTL, partial hit detection)
  oura.ts        Oura API client
  tools.ts       MCP tool definitions (SLEEP_TOOLS / ACTIVITY_TOOLS)
migrations/
  001_init.sql   D1 schema
```
