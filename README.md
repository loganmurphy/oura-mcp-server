# oura-mcp-server

[![CI](https://img.shields.io/github/actions/workflow/status/loganmurphy/oura-mcp-server/ci.yml?label=CI)](https://github.com/loganmurphy/oura-mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-5F7FFF?logo=buy-me-a-coffee&logoColor=white)](https://www.buymeacoffee.com/loganmurphc)

A lightweight [Model Context Protocol](https://modelcontextprotocol.io) server that exposes your [Oura Ring](https://ouraring.com) data as tools for Claude. Runs on Cloudflare Workers with a D1 cache layer for fast repeated queries.

Tested with **Claude.ai (web), Claude Desktop, and Claude mobile** via `claude.ai/settings/connectors`. Any MCP client that supports OAuth 2.1 remote servers should work — though only Claude is officially tested and the bootstrap wizard targets Claude exclusively.

## Architecture

```
Claude (web / desktop / mobile)
     │  OAuth 2.1 (PKCE)
Cloudflare Worker  (@cloudflare/workers-oauth-provider)
     ├─ KV       OAuth tokens (30-day access, non-expiring refresh)
     ├─ D1       per-day cache (5m today / 6h yesterday / 24h older)
     └─ Oura API fetched only on cache miss
```

All 7 tools share a single `/mcp` endpoint and one OAuth login. On a partial cache hit the worker fetches only the missing date range and merges it with cached data. Empty responses are never cached (ring not yet synced).

## Requirements

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier)
- [Oura Personal Access Token](https://cloud.ouraring.com/personal-access-tokens)
- Node.js 24, pnpm 10 — [Volta](https://volta.sh) recommended (versions pinned in `package.json`)

## Bootstrap

```bash
pnpm install
pnpm bootstrap
```

The wizard handles everything:

1. Sign in to Cloudflare via `wrangler login`
2. Select your account and preview what will be created
3. Create D1 (`oura-cache`) and KV (`oura-oauth`) — or reuse if they exist
4. Prompt for your Oura PAT and a password for the MCP login page
5. Deploy the Worker and set secrets
6. Copy the MCP URL to your clipboard and open `claude.ai/settings/connectors` (first run only)

Re-running is fully idempotent.

### Local dev first?

```bash
pnpm connect-local   # prompts for tokens, applies local D1 schema, guides ngrok tunnel setup
pnpm dev             # keep running in a separate terminal
```

Run `pnpm bootstrap` when ready to deploy.

---

## Connect

All clients connect to the same MCP endpoint. `pnpm bootstrap` copies this URL to your clipboard on completion:

```
https://oura-mcp-server.<your-subdomain>.workers.dev/mcp
```

Customize → [Connectors](https://claude.ai/customize/connectors) → Add custom connector → paste URL → Connect → enter password → Authorize.

After connecting, click **Configure** on the Oura connector and set each tool to **Allow** — otherwise Claude may ask for permission on every use.

> Setup must be done on [claude.ai](https://claude.ai) (web) — the mobile app doesn't support adding connectors. Once added via web, it's available across all Claude clients.

`pnpm bootstrap` opens this page and copies the URL automatically.

---

## Local development

```bash
cp wrangler.example.jsonc wrangler.jsonc   # fill in YOUR_KV_NAMESPACE_ID + YOUR_DATABASE_ID
pnpm install && pnpm cf-typegen
printf 'OURA_API_TOKEN=your_token\nMCP_AUTH_PASSWORD=your_password\n' > .dev.vars
npx wrangler d1 execute oura-cache --local --file=./migrations/001_init.sql
pnpm dev   # http://localhost:8787
```

### Testing with ngrok

Claude.ai (web/mobile) requires HTTPS. Use ngrok to expose the local dev server:

```bash
brew install ngrok/ngrok/ngrok
ngrok config add-authtoken YOUR_TOKEN   # free at ngrok.com

pnpm dev             # terminal 1
ngrok http 8787      # terminal 2 → https://xxxx.ngrok-free.app
```

Add `<ngrok-url>/mcp` as a custom connector at `claude.ai/customize/connectors`.

> Free tier URLs change on restart — re-add the connector in Claude when that happens.

---

## Smoke testing

```bash
BASE=https://oura-mcp-server.<subdomain>.workers.dev   # or http://localhost:8787

# Server reachable
curl -s $BASE/.well-known/oauth-authorization-server | jq .
curl -s $BASE/health

# Unauthenticated call returns 401 — expected
curl -s -X POST $BASE/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq .
```

### Full OAuth flow (cURL PKCE)

No browser required — curl handles the full flow end-to-end. Run this as one block, substituting your `MCP_AUTH_PASSWORD`:

```bash
MCP_PASSWORD="your-password-here"

# 1. Register a client
CLIENT=$(curl -s -X POST $BASE/oauth/register -H "Content-Type: application/json" \
  -d '{"client_name":"curl-test","redirect_uris":["http://localhost:9999/callback"],
       "grant_types":["authorization_code"],"response_types":["code"],
       "token_endpoint_auth_method":"none"}')
CLIENT_ID=$(echo $CLIENT | jq -r .client_id)

# 2. PKCE challenge
CODE_VERIFIER=$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-43)
CODE_CHALLENGE=$(printf '%s' "$CODE_VERIFIER" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=')

# 3. GET the login form, then POST the password to complete authorization
FORM_HTML=$(curl -s "$BASE/authorize?client_id=$CLIENT_ID&response_type=code&redirect_uri=http://localhost:9999/callback&code_challenge=$CODE_CHALLENGE&code_challenge_method=S256&state=test")
OAUTH_PARAMS=$(echo "$FORM_HTML" | grep -o 'name="oauth_params" value="[^"]*"' | sed 's/name="oauth_params" value="//;s/"$//' | sed 's/&amp;/\&/g')
AUTH_PAGE=$(curl -s -X POST $BASE/authorize \
  --data-urlencode "oauth_params=$OAUTH_PARAMS" \
  --data-urlencode "password=$MCP_PASSWORD")

# Extract and decode the auth code from the success page iframe
RAW_CODE=$(echo "$AUTH_PAGE" | grep -o 'code=[^&"]*' | head -1 | sed 's/code=//')
AUTH_CODE=$(node -e "process.stdout.write(decodeURIComponent('$RAW_CODE'))")

# 4. Exchange code for token
TOKEN=$(curl -s -X POST $BASE/oauth/token \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=$AUTH_CODE" \
  --data-urlencode "redirect_uri=http://localhost:9999/callback" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "code_verifier=$CODE_VERIFIER" \
  | jq -r .access_token)
echo "Token: ${TOKEN:0:30}..."

# 5. Call a tool
curl -s -X POST $BASE/mcp -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"oura_daily_sleep","arguments":{"start_date":"2026-04-18","end_date":"2026-04-25"}}}' | jq .
```

---

## Manual deploy

If you prefer not to use `pnpm bootstrap`:

```bash
npx wrangler login
npx wrangler d1 create oura-cache
npx wrangler kv namespace create OAUTH_KV
# paste both IDs into wrangler.jsonc
npx wrangler d1 execute oura-cache --remote --file=./migrations/001_init.sql
npx wrangler secret put OURA_API_TOKEN
npx wrangler secret put MCP_AUTH_PASSWORD
pnpm deploy
```

---

## Tool reference

All date params optional, default to last 7 days (YYYY-MM-DD). `end_date` is always **inclusive** from the caller's perspective.

| Tool                   | Returns                                |
| ---------------------- | -------------------------------------- |
| `oura_daily_sleep`     | Sleep score + contributors             |
| `oura_sleep_sessions`  | Sleep stages, HRV, HR, breathing, temp |
| `oura_daily_readiness` | Readiness score + contributors         |
| `oura_daily_spo2`      | Blood oxygen saturation                |
| `oura_daily_activity`  | Steps, calories, activity minutes      |
| `oura_workouts`        | Session type, duration, calories, HR   |
| `oura_daily_stress`    | Stress, recovery, ruggedness scores    |

All tools accept `start_date`, `end_date`, and `skip_cache` (bool).

**`day` field convention:**

- Sleep, readiness, SpO2 → **wake-up date** (session ending morning of Apr 24 → `day: "2026-04-24"`)
- Activity, workouts, stress → **calendar date**

### Third-party integrations

Workouts synced to Oura from external apps (e.g. Strava) do not always appear in the Oura API — this is an upstream sync limitation, not a server issue. A dedicated Strava MCP server is coming soon.

## Troubleshooting

**Tools not appearing** — remove and re-add the connector at `claude.ai/customize/connectors`; tool list refreshes on reconnect.

**`OURA_API_TOKEN` not configured** — local: check `.dev.vars` and restart `pnpm dev`; production: `npx wrangler secret put OURA_API_TOKEN`.

**Today's data empty** — open the Oura app to trigger a sync, then ask Claude to use `skip_cache: true`.

**Oura 401 / token rejected** — PATs expire ~every 3 months. Rotate: `npx wrangler secret put OURA_API_TOKEN` (no redeploy needed).

**Rotate MCP password** — `npx wrangler secret put MCP_AUTH_PASSWORD`, then `pnpm revoke` (invalidates existing sessions so Claude re-auths with the new password).

**`pnpm bootstrap` fails at Cloudflare login** — run `npx wrangler login` manually first.

**Port 8787 in use** — `lsof -ti :8787 | xargs kill -9 && pnpm dev`

---

## Project structure

```
src/
  index.ts          Worker entry — OAuth wrapper, /mcp dispatch, auth UI
  cache.ts          D1 cache (per-day TTL, partial-hit merging)
  oura.ts           Oura API client + response noise stripping
  tools.ts          MCP tool definitions
  ui.ts             Login and success page HTML
scripts/
  bootstrap.ts      Setup wizard (D1, KV, Worker deploy, secrets)
  connect-local.ts  Credentials + D1 schema setup for local dev
  revoke.ts         Purge all OAuth KV tokens to force re-auth
migrations/
  001_init.sql      D1 schema
```

---

If this saved you some time, a coffee is always appreciated!

[![Buy Me a Coffee](https://cdn.buymeacoffee.com/buttons/v2/default-blue.png)](https://www.buymeacoffee.com/loganmurphc)
