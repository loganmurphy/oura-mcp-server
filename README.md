# oura-mcp-server

[![CI](https://img.shields.io/github/actions/workflow/status/loganmurphy/oura-mcp-server/ci.yml?label=CI)](https://github.com/loganmurphy/oura-mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-5F7FFF?logo=buy-me-a-coffee&logoColor=white)](https://www.buymeacoffee.com/loganmurphc)

A lightweight [Model Context Protocol](https://modelcontextprotocol.io) server that exposes your [Oura Ring](https://ouraring.com) data as tools for Claude. Runs on Cloudflare Workers with a D1 cache layer for fast repeated queries.

Works with **Claude Desktop, Claude.ai (web), and Claude mobile** — any MCP client that supports OAuth 2.1 remote servers.

## Architecture

```
Claude Desktop / Claude.ai Web / Claude Mobile
     │  OAuth 2.1 (PKCE)
Cloudflare Worker  (@cloudflare/workers-oauth-provider)
     ├─ KV            (OAuth tokens — 30-day access tokens)
     ├─ D1 cache      (per-day TTL: 1h today / 6h yesterday / 24h older)
     └─ Oura API      (fetched only for cache misses)
```

Access is protected by a password you set during bootstrap. The OAuth PKCE flow is handled automatically — on first connection your client opens a browser login page, then caches the access token for 30 days before re-auth is needed.

All 7 tools are served from a single `/mcp` endpoint — one connection, one OAuth login.

On a partial cache hit the worker fetches only the missing date range from Oura and merges it with the cached portion before responding. Empty responses (data not yet synced from the ring) are never cached. Pass `skip_cache: true` on any tool call to bypass the cache entirely.

## Requirements

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is fine)
- [Oura developer account](https://cloud.ouraring.com/personal-access-tokens) with a Personal Access Token
- Node.js 24 and pnpm 10 — [Volta](https://volta.sh) is recommended (versions pinned in `package.json`)

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
8. Write the `oura` entry into your Claude Desktop config (preserving any other MCP servers you have)

Re-running is safe — every step detects existing resources and reuses them. The only manual inputs are your Oura PAT and your chosen password.

When it finishes, your Worker is live at `https://oura-mcp-server.<your-subdomain>.workers.dev`. Use that URL to connect any client below.

### Just want to try it locally first?

```bash
pnpm install
pnpm connect-local   # prompts for tokens, patches configs, wires Claude Desktop
pnpm dev             # keep this running in a separate terminal
```

Fully quit Claude Desktop (Cmd+Q) and relaunch. Run `pnpm bootstrap` when you're ready to deploy.

---

## Connecting clients

All clients connect to the same URL: `https://oura-mcp-server.<your-subdomain>.workers.dev/mcp`

> **Testing without deploying?** Use [ngrok](#testing-with-ngrok) to create a public HTTPS tunnel to your local dev server. Claude.ai web and mobile require HTTPS, but ngrok gives you a real `https://` URL pointing at `localhost:8787`.

### Claude Desktop

`pnpm bootstrap` writes this automatically. To add it manually, edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "oura": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://oura-mcp-server.<your-subdomain>.workers.dev/mcp"]
    }
  }
}
```

Fully quit Claude Desktop (Cmd+Q) and relaunch. On first connection a browser window opens — enter your MCP password and click Authorize. The token lasts 30 days.

For local dev use `http://localhost:8787/mcp` and keep `pnpm dev` running.

---

### Claude.ai (web)

> Requires HTTPS. Use a deployed Worker URL **or** an [ngrok tunnel](#testing-with-ngrok) pointing at `localhost:8787` for local testing.

1. Open **claude.ai** → click your avatar (bottom-left) → **Settings**
2. Go to **Integrations** → **Custom Connectors** → **Add custom connector**
3. Paste your Worker URL (or ngrok URL for local testing):
   ```
   https://oura-mcp-server.<your-subdomain>.workers.dev/mcp
   ```
4. Click **Connect** — a popup opens and navigates to your Worker's login page
5. Enter your MCP password and click **Authorize**
6. The popup closes and you'll see "Oura" listed under active connectors

In any conversation, the Oura tools will be available automatically. Start a new chat and ask: *"What was my sleep score last night?"*

To disconnect: Settings → Integrations → Custom Connectors → click the three-dot menu next to Oura → **Remove**.

---

### Claude mobile (iOS / Android)

> Requires HTTPS. Use a deployed Worker URL **or** an [ngrok tunnel](#testing-with-ngrok) for local testing.

1. Open the Claude app → tap the **menu** (☰) → **Settings**
2. Tap **Integrations** → **Add integration**
3. Paste your Worker URL (or ngrok URL for local testing):
   ```
   https://oura-mcp-server.<your-subdomain>.workers.dev/mcp
   ```
4. Tap **Connect** — Safari/Chrome opens and loads your Worker's login page
5. Enter your MCP password and tap **Authorize** — the app resumes with Oura connected

In any conversation tap the **+** or tools icon to confirm Oura tools are listed.

---

## Local development

```bash
cp wrangler.example.jsonc wrangler.jsonc   # fill in YOUR_KV_NAMESPACE_ID + YOUR_DATABASE_ID
pnpm install
pnpm cf-typegen                             # generate Worker types from wrangler.jsonc

echo "OURA_API_TOKEN=your_token_here" > .dev.vars
echo "MCP_AUTH_PASSWORD=your_password"    >> .dev.vars

npx wrangler d1 execute oura-cache --local --file=./migrations/001_init.sql
pnpm dev   # http://localhost:8787
```

---

## Testing with ngrok

[ngrok](https://ngrok.com) tunnels your local dev server to a public HTTPS URL, so you can test Claude.ai web and mobile OAuth flows without deploying to Cloudflare.

### Setup (one-time)

```bash
brew install ngrok/ngrok/ngrok   # macOS; or download from ngrok.com
ngrok config add-authtoken YOUR_NGROK_TOKEN   # free account at ngrok.com
```

### Start the tunnel

```bash
# Terminal 1 — local Worker
pnpm dev

# Terminal 2 — ngrok tunnel
ngrok http 8787
```

ngrok prints a forwarding URL like `https://a1b2c3d4.ngrok-free.app`. Use that as your MCP server URL in place of the Cloudflare Worker URL:

```
https://a1b2c3d4.ngrok-free.app/mcp
```

> **Free tier note:** The URL changes every time you restart ngrok. Re-add the integration in Claude.ai / mobile settings whenever the URL changes. A paid ngrok plan lets you reserve a static subdomain.

### Use the ngrok URL with each client

**Claude Desktop** — update `claude_desktop_config.json` temporarily (or use `pnpm connect-local` for localhost, which Claude Desktop can reach directly without ngrok):

```json
{
  "mcpServers": {
    "oura": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://a1b2c3d4.ngrok-free.app/mcp"]
    }
  }
}
```

**Claude.ai web / mobile** — follow the [Connecting clients](#connecting-clients) steps, substituting the ngrok URL where the Worker URL appears. The OAuth flow is identical.

**cURL** — set `BASE=https://a1b2c3d4.ngrok-free.app` in the [smoke test commands below](#smoke-testing) and follow the full OAuth flow section.

---

## Smoke testing

### Without auth (metadata)

These endpoints don't require a token and are useful for verifying the server is reachable:

```bash
BASE=http://localhost:8787   # or https://oura-mcp-server.<subdomain>.workers.dev

# OAuth discovery — confirms the server is up
curl -s $BASE/.well-known/oauth-authorization-server | jq .

# Health check
curl -s $BASE/health

# Unauthenticated /mcp call returns 401 + WWW-Authenticate — this is expected
curl -s -X POST $BASE/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq .
```

### Full OAuth flow (cURL PKCE)

This walks through the complete OAuth 2.1 PKCE handshake — useful for debugging or scripted testing. You'll need `openssl` and `jq`.

```bash
BASE=https://oura-mcp-server.<your-subdomain>.workers.dev

# ── 1. Dynamic client registration ───────────────────────────────────────────
CLIENT=$(curl -s -X POST $BASE/oauth/register \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "curl-test",
    "redirect_uris": ["http://localhost:9999/callback"],
    "grant_types": ["authorization_code"],
    "response_types": ["code"],
    "token_endpoint_auth_method": "none"
  }')
echo $CLIENT | jq .
CLIENT_ID=$(echo $CLIENT | jq -r .client_id)

# ── 2. Generate PKCE code verifier + challenge ────────────────────────────────
CODE_VERIFIER=$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-43)
CODE_CHALLENGE=$(printf '%s' "$CODE_VERIFIER" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=')

# ── 3. Open this URL in your browser, enter your MCP password, authorize ──────
echo ""
echo "Open this URL in your browser:"
echo "$BASE/authorize?client_id=$CLIENT_ID&response_type=code&redirect_uri=http://localhost:9999/callback&code_challenge=$CODE_CHALLENGE&code_challenge_method=S256&state=curl-test"
echo ""
echo "After authorizing, copy the 'code' value from the redirect URL and paste it:"
read -r AUTH_CODE

# ── 4. Exchange code for access token ────────────────────────────────────────
TOKEN_RESP=$(curl -s -X POST $BASE/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=$AUTH_CODE&redirect_uri=http://localhost:9999/callback&client_id=$CLIENT_ID&code_verifier=$CODE_VERIFIER")
echo $TOKEN_RESP | jq .
TOKEN=$(echo $TOKEN_RESP | jq -r .access_token)

# ── 5. List tools ─────────────────────────────────────────────────────────────
curl -s -X POST $BASE/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq '.result.tools[].name'

# ── 6. Call a tool ────────────────────────────────────────────────────────────
curl -s -X POST $BASE/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "oura_daily_sleep",
      "arguments": {
        "start_date": "2026-04-18",
        "end_date": "2026-04-25"
      }
    }
  }' | jq .
```

> **Tip:** Once you have a `$TOKEN` you can reuse it for subsequent cURL calls until it expires (30 days). The token from `mcp-remote` is cached at `~/.mcp-remote/` if you want to extract it instead of running the PKCE flow manually.

---

## Pre-merge testing checklist

Test local dev first with ngrok (fast iteration), then verify once against the deployed Worker.

### Local (ngrok)

```bash
pnpm dev         # terminal 1
ngrok http 8787  # terminal 2 — copy the https://xxx.ngrok-free.app URL
```

```
[ ] Smoke checks (no auth)
    [ ] curl $NGROK_URL/.well-known/oauth-authorization-server returns JSON
    [ ] curl $NGROK_URL/health returns 200
    [ ] Unauthenticated POST /mcp returns 401 with WWW-Authenticate header

[ ] cURL PKCE flow (ngrok URL)
    [ ] Dynamic client registration returns client_id
    [ ] Browser opens authorize URL, password accepted, "Connected to Oura" page shown
    [ ] Code exchange returns access_token
    [ ] tools/list returns all 7 tool names
    [ ] tools/call oura_daily_sleep returns real data

[ ] Claude Desktop (localhost — no ngrok needed)
    [ ] pnpm connect-local completes, Claude Desktop config updated
    [ ] Restart Claude Desktop, Oura tools appear
    [ ] "What was my sleep score last night?" returns data

[ ] Claude.ai web (ngrok URL)
    [ ] Settings → Integrations → Custom Connectors → Add → paste ngrok URL → Connect
    [ ] Login popup opens, password accepted, "Connected to Oura" shown, popup closes
    [ ] New conversation: Oura tools available
    [ ] Sleep / readiness / activity queries return data

[ ] Claude mobile (ngrok URL)
    [ ] Integrations → Add → paste ngrok URL → Connect
    [ ] Browser opens, password accepted, app resumes with Oura connected
    [ ] Tools listed and returning data in a conversation

[ ] Cache behavior
    [ ] First call for a date range is slower (Oura fetch)
    [ ] Identical call immediately after is instant (cache hit)
    [ ] skip_cache: true returns fresh data
```

### Production (deployed Worker)

```bash
pnpm deploy   # or pnpm bootstrap on a fresh machine
```

```
[ ] pnpm bootstrap completes, Worker live at workers.dev URL
    [ ] Re-run detects and reuses existing resources (idempotent)

[ ] Claude Desktop (workers.dev URL)
    [ ] First connection opens browser OAuth
    [ ] Data returned after login

[ ] Claude.ai web (workers.dev URL)
    [ ] Connect flow succeeds with production URL
    [ ] Tools work end-to-end

[ ] Claude mobile (workers.dev URL)
    [ ] Connect flow succeeds
    [ ] Tools work end-to-end
```

---

## Deploy to Cloudflare (manual)

If you prefer not to use `pnpm bootstrap`:

```bash
npx wrangler login
npx wrangler d1 create oura-cache           # copy the database_id
npx wrangler kv namespace create OAUTH_KV   # copy the id
# paste both IDs into wrangler.jsonc
npx wrangler d1 execute oura-cache --remote --file=./migrations/001_init.sql
npx wrangler secret put OURA_API_TOKEN
npx wrangler secret put MCP_AUTH_PASSWORD
pnpm deploy
```

---

## Tool reference

All date params are optional and default to the last 7 days (`YYYY-MM-DD` format). All `end_date` values are **inclusive** from the caller's perspective.

| Tool | Returns |
|---|---|
| `oura_daily_sleep` | Sleep score + contributors |
| `oura_sleep_sessions` | Sleep stages, HRV, HR, breathing, temp |
| `oura_daily_readiness` | Readiness score + contributors |
| `oura_daily_spo2` | Blood oxygen saturation |
| `oura_daily_activity` | Steps, calories, activity minutes |
| `oura_workouts` | Session type, duration, calories, HR |
| `oura_daily_stress` | Stress, recovery, ruggedness scores |

All tools accept `start_date`, `end_date` (YYYY-MM-DD, inclusive), and `skip_cache` (bool).

### Date conventions

**`day` field:**
- Sleep, readiness, and SpO2 use the **wake-up date** — a session starting the night of Apr 23 ending the morning of Apr 24 has `day: "2026-04-24"`. Use **today's date** to get last night's data.
- Activity, workouts, and stress use the **calendar date** of the event.

**`end_date` behavior:**
Inclusive across all tools from the caller's perspective. Internally, the server adds +1 day before calling the Oura API for all endpoints except `daily_sleep` (which is natively inclusive). You never need to adjust dates.

---

## Troubleshooting

**Tools not appearing in Claude Desktop**
- Fully quit Claude Desktop (Cmd+Q) and relaunch — tool list loads at startup only
- Confirm `~/Library/Application Support/Claude/claude_desktop_config.json` is valid JSON with an `oura` entry pointing to `/mcp`

**OAuth popup doesn't close / "Connected" page stuck (Claude.ai web)**
- The success page uses a hidden `<iframe>` to complete the token exchange — if the popup stays open, wait ~5 seconds then close it manually; the token will still be stored

**"OURA_API_TOKEN secret not configured" error**
- Local dev: confirm `.dev.vars` has `OURA_API_TOKEN=...` and restart `pnpm dev`
- Production: `npx wrangler secret put OURA_API_TOKEN` (no redeploy needed)

**Claude can't connect / "MCP server disconnected"**
- Local dev: confirm `pnpm dev` is running
- Test reachability: `curl http://localhost:8787/health`
- Clear the mcp-remote token cache: `rm -rf ~/.mcp-remote`

**Today's data missing or empty**
- Sleep/readiness/SpO2 are available after the ring syncs — open the Oura app to trigger
- Ask Claude to bypass the cache: *"pull my sleep for today with skip_cache: true"*

**Oura API 401 / "token rejected"**
- Personal Access Tokens expire ~every 3 months. Generate a new one at [cloud.ouraring.com/personal-access-tokens](https://cloud.ouraring.com/personal-access-tokens)
- Production: `npx wrangler secret put OURA_API_TOKEN` (no redeploy needed)
- Local: update `OURA_API_TOKEN=` in `.dev.vars` and restart `pnpm dev`

**Re-authenticating / rotating the MCP password**
- `npx wrangler secret put MCP_AUTH_PASSWORD`, then `rm -rf ~/.mcp-remote` and relaunch Claude Desktop

**`pnpm bootstrap` fails at the Cloudflare login step**
- Run `npx wrangler login` manually, then retry bootstrap
- Or set `CLOUDFLARE_API_TOKEN` in your environment for CI / token-based auth

**Port 8787 already in use**
```bash
lsof -ti :8787 | xargs kill -9 && pnpm dev
```

---

## Project structure

```
src/
  index.ts          Worker entry — OAuthProvider wrapper, single /mcp endpoint, tool dispatch
  ui.ts             HTML templates (login page, success page)
  cache.ts          D1 cache layer (per-day TTL, partial hit merging)
  oura.ts           Oura API client
  tools.ts          MCP tool definitions (SLEEP_TOOLS / ACTIVITY_TOOLS / OURA_TOOLS)
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
