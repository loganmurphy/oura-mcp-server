# OAuth Migration Plan

## Goal

Replace Cloudflare Access / Zero Trust with a lightweight OAuth 2.1 layer built into the Worker
itself, so any MCP client — Claude Desktop, Claude.ai web, or mobile — can connect without the
manual service-token setup.

**What stays the same:** Oura PAT as a single Worker secret, D1 cache schema, all tool
implementations, Cloudflare Workers + D1 infrastructure.

**What changes:** Zero Trust removed, Worker gains its own OAuth endpoints, Claude Desktop
config simplifies to just a URL (no `env` block for service tokens).

---

## How it works

```
MCP client (Claude Desktop / web / mobile)
  │  hits /mcp/* without a token
  │
  ▼
Worker returns 401 + WWW-Authenticate: Bearer + metadata URL
  │
  ▼
mcp-remote (or native MCP client) opens browser to /oauth/authorize
  │
  ▼
Worker shows a password form — you type your MCP_AUTH_PASSWORD
  │
  ▼
Worker issues an access token (stored in KV with TTL)
  │
  ▼
All future /mcp/* requests carry Bearer token → Worker introspects → calls Oura API with PAT
```

The Worker is the OAuth Authorization Server. Oura is still reached with the single PAT Worker
secret — no Oura OAuth app, no per-user token storage, no encryption layer needed.

---

## Phase 0 — Prep

### New secrets

Two new Worker secrets alongside the existing `OURA_API_TOKEN`:

| Secret | Purpose | How to generate |
|---|---|---|
| `MCP_AUTH_PASSWORD` | Password shown in the browser during OAuth flow | Choose any strong password |
| `COOKIE_SECRET` | Signs the state param to prevent CSRF | `openssl rand -hex 32` |

### New KV namespace

Short-lived OAuth state (PKCE verifiers, issued tokens) lives in KV so it gets automatic TTL
expiry. D1 is not used for OAuth state.

```bash
npx wrangler kv:namespace create OAUTH_KV
# paste the printed id into wrangler.jsonc under kv_namespaces
```

### `wrangler.example.jsonc` additions

```jsonc
"kv_namespaces": [
  { "binding": "OAUTH_KV", "id": "<your-kv-id>" }
]
```

New `Env` fields (add to `src/index.ts` or extracted `src/env.ts`):

```ts
OAUTH_KV: KVNamespace;
MCP_AUTH_PASSWORD: string;
COOKIE_SECRET: string;
```

---

## Phase 1 — Add OAuth layer to the Worker

### Install the package

```bash
pnpm add @cloudflare/workers-oauth-provider
```

[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
is Cloudflare's first-party library that implements an MCP-compatible OAuth 2.1 Authorization
Server (PKCE, Dynamic Client Registration, token introspection). It handles all the OAuth
protocol work; we just provide a password-check handler.

### New file: `src/auth-handler.ts`

The only custom logic needed — renders the login form and validates the password:

```ts
import type { Env } from "./index";

/** Called by OAuthProvider during GET /oauth/authorize after PKCE params are validated */
export async function handleAuthorize(
  request: Request,
  env: Env,
  oauthState: string,         // opaque string from OAuthProvider to round-trip
): Promise<Response> {
  // GET  → show password form
  // POST → validate password, redirect back to OAuthProvider with oauthState
  if (request.method === "POST") {
    const form = await request.formData();
    const pw = form.get("password");
    if (pw !== env.MCP_AUTH_PASSWORD) {
      return renderForm(oauthState, "Incorrect password.");
    }
    // Password correct — tell OAuthProvider to issue a token
    const redirectUrl = new URL(request.url);
    redirectUrl.searchParams.set("approved", "true");
    redirectUrl.searchParams.set("state", oauthState);
    return Response.redirect(redirectUrl.toString(), 302);
  }
  return renderForm(oauthState);
}

function renderForm(state: string, error?: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Connect to Oura MCP</title>
<style>body{font-family:system-ui;max-width:360px;margin:80px auto;padding:0 1rem}
input{width:100%;padding:.5rem;margin:.5rem 0;box-sizing:border-box}
button{width:100%;padding:.6rem;background:#1a1a1a;color:#fff;border:none;cursor:pointer}
.err{color:#c00;font-size:.9rem}</style></head>
<body>
<h2>Connect to your Oura data</h2>
${error ? `<p class="err">${error}</p>` : ""}
<form method="POST">
  <input type="hidden" name="state" value="${state}">
  <label>Password<input type="password" name="password" autofocus></label>
  <button type="submit">Approve</button>
</form>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}
```

### Refactor `src/index.ts`

**Add routes** (before the existing `/mcp/*` handler):

```ts
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { handleAuthorize } from "./auth-handler";

// OAuth discovery + token endpoints — handled entirely by the library
const oauthProvider = new OAuthProvider({ kv: env.OAUTH_KV, cookieSecret: env.COOKIE_SECRET });

if (url.pathname === "/.well-known/oauth-authorization-server")
  return oauthProvider.handleMetadata(request);
if (url.pathname === "/oauth/authorize")
  return oauthProvider.handleAuthorize(request, (req, state) => handleAuthorize(req, env, state));
if (url.pathname === "/oauth/token")
  return oauthProvider.handleToken(request);
```

**Gate `/mcp/*` with token introspection:**

```ts
if (url.pathname.startsWith("/mcp/")) {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return oauthProvider.unauthorizedResponse(request); // 401 + WWW-Authenticate
  const claims = await oauthProvider.introspect(token);
  if (!claims) return new Response("Forbidden", { status: 403 });
  return handleMcp(request, env, ctx, url.pathname);
}
```

No other changes to `handleMcp`, `handleDateRangeTool`, `handleSingletonTool`, or the cache
layer — they all continue to use `env.OURA_API_TOKEN` exactly as before.

**Remove** (in Phase 3): the Cloudflare Access check is at the network layer, not in Worker
code, so there is nothing to delete from `index.ts`. Removing Access is a bootstrap/config change only.

---

## Phase 2 — Update tests

**`src/__tests__/index.test.ts`:**
- Add `OAUTH_KV`, `MCP_AUTH_PASSWORD`, `COOKIE_SECRET` to the mock `Env`
- Add test: request to `/mcp/sleep` without a token returns 401
- Add test: request with a valid token passes through to tool dispatch
  (mock `oauthProvider.introspect` to return a claims object)
- Keep all existing tool-dispatch tests — they call `handleMcp` directly and are unaffected

**New `src/__tests__/auth-handler.test.ts`:**
- GET → renders form containing `<input type="password">`
- POST correct password → 302 redirect with `approved=true`
- POST wrong password → re-renders form with error message

Coverage target: maintain ≥ 90% on all four dimensions.

---

## Phase 3 — Simplify bootstrap wizard

**Remove (~300 lines):**
- `ensureAccessEnabled()` — Zero Trust org enrollment
- `ensureAccessApp()` — CF Access application creation
- `ensureServiceToken()` — service token create/reuse
- `ensureAccessPolicy()` — wires service token to app
- Service token rotation / expiry logic
- Writing `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` to Claude Desktop config

**Add:**
- KV namespace create-or-reuse step (same idempotent pattern used for D1)
- `MCP_AUTH_PASSWORD` prompt — ask user to choose a password, set as Worker secret
- `COOKIE_SECRET` — generate automatically (`crypto.randomBytes(32).toString("hex")`), set as secret

**Claude Desktop config written (simplified):**

```json
{
  "oura-sleep": {
    "command": "npx",
    "args": ["-y", "mcp-remote", "https://<worker>.workers.dev/mcp/sleep"]
  },
  "oura-activity": {
    "command": "npx",
    "args": ["-y", "mcp-remote", "https://<worker>.workers.dev/mcp/activity"]
  }
}
```

No `env` block. `mcp-remote` detects the 401 + `WWW-Authenticate` header and opens the browser
automatically for the password form.

---

## Phase 4 — Docs

**`README.md`:**
- Remove Zero Trust troubleshooting section
- Add one-liner under "Connect to Claude Desktop": "On first use, `mcp-remote` will open a
  browser tab asking for your password — this is a one-time step per device."
- Add to "Deploy": `npx wrangler secret put MCP_AUTH_PASSWORD`
- No other structural changes

**`CLAUDE.md`:**
- Update `Env` interface docs (add `OAUTH_KV`, `MCP_AUTH_PASSWORD`, `COOKIE_SECRET`)
- Update request flow diagram to show OAuth gate before tool dispatch
- Note `src/auth-handler.ts` in project structure

---

## Phase 5 — Deploy & verify

```bash
# 1. Create KV namespace
npx wrangler kv:namespace create OAUTH_KV
# paste id into wrangler.jsonc

# 2. Set new secrets
npx wrangler secret put MCP_AUTH_PASSWORD   # choose a password
npx wrangler secret put COOKIE_SECRET       # openssl rand -hex 32

# 3. Deploy
pnpm deploy

# 4. Smoke test — should return 401 with WWW-Authenticate header
curl -si https://<worker>.workers.dev/mcp/sleep \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -5

# 5. Full flow test
# Quit + relaunch Claude Desktop — mcp-remote will open browser, enter password, done.

# 6. Remove Cloudflare Access app + service token from dashboard (manual, one-time cleanup)
```

### Rollback

Redeploy the previous version from the Cloudflare dashboard. Re-add the Access application and
service token policy to restore the old auth model. D1 and the tool logic are untouched.

---

## Suggested PR split

| PR | Contents |
|---|---|
| PR A `feat/oauth-prep` | Phase 0 — KV namespace, new `Env` fields, wrangler.example.jsonc update |
| PR B `feat/oauth-switch` | Phase 1 + 2 — `auth-handler.ts`, `index.ts` refactor, tests |
| PR C `feat/oauth-bootstrap` | Phase 3 + 4 — bootstrap simplification, README + CLAUDE.md updates |

PR A and B can be combined if preferred — they're both additive. PR C touches the most files
and is easier to review separately.
