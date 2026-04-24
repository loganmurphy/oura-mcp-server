# OAuth Migration Plan

Goal: replace the Personal-Access-Token + Cloudflare Access (Zero Trust) auth model with a
standards-based OAuth 2.1 flow so the Worker can serve any number of users — not just the owner.
After this migration, users authenticate through the Worker itself (it acts as both OAuth
Authorization Server and Resource Server), and the Worker stores per-user Oura tokens encrypted in D1.
Cloudflare Access / Zero Trust is removed entirely.

---

## Background & motivation

Current model:
- Single `OURA_API_TOKEN` Worker secret — one user, owner only
- Cloudflare Access Zero Trust gates the `/mcp/*` endpoints — Claude Desktop uses a service token
- `handleSingletonTool` stores personal_info in D1 without a `user_id` — breaks with multiple users

Target model:
- Worker is an MCP-compatible OAuth 2.1 Authorization Server (AS) + Resource Server (RS)
- MCP client (Claude Desktop / web / mobile) completes PKCE Authorization Code flow against the Worker
- Worker completes a separate Authorization Code flow against Oura's OAuth server to get the user's Oura access token
- Per-user Oura tokens encrypted (AES-GCM via WebCrypto) and stored in D1 `users` table
- `oura_cache` rows keyed by `(metric, date_key, user_id)` — full isolation between users
- Zero config for new users: just open Claude, click "Connect to Oura", done

---

## Phase 0 — Prep commits (no behaviour change, mergeable standalone)

These are small surgical changes to the existing code that make later diffs cleaner.

### 0a. Rename `_cache` table → `oura_cache` in source

`migrations/001_init.sql` already uses `oura_cache`.
Verify `src/cache.ts` SQL strings all reference `oura_cache` (they do). No change needed —
just confirming alignment.

### 0b. Extract `Env` interface to `src/env.ts`

Currently `Env` is defined inline in `src/index.ts`. Extract it so `cache.ts`, `oura.ts`, and
new OAuth files can import it without a circular dep.

```ts
// src/env.ts
export interface Env {
  DB: D1Database;
  OURA_ENCRYPTION_KEY: string;     // new — replaces OURA_API_TOKEN
  OURA_CLIENT_ID: string;          // new — Oura OAuth app credentials
  OURA_CLIENT_SECRET: string;      // new — Oura OAuth app credentials
  COOKIE_SECRET: string;           // new — signs state cookies
}
```

> `OURA_API_TOKEN` is removed in Phase 2. Keep it in `Env` as `optional` during the transition
> period so existing local `.dev.vars` files don't break mid-migration.

### 0c. D1 schema migration v2 (`migrations/002_users.sql`)

```sql
-- New table: one row per authenticated user
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,          -- UUID, issued by the Worker
  oura_token   TEXT NOT NULL,             -- AES-GCM ciphertext (base64)
  oura_refresh TEXT NOT NULL,             -- AES-GCM ciphertext (base64)
  oura_expiry  INTEGER NOT NULL,          -- unix seconds
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Add user scoping to the cache
ALTER TABLE oura_cache ADD COLUMN user_id TEXT NOT NULL DEFAULT '__legacy__';

-- Composite unique constraint (replaces existing unique on metric+date_key)
CREATE UNIQUE INDEX IF NOT EXISTS idx_oura_cache_user
  ON oura_cache (user_id, metric, date_key);
```

The `DEFAULT '__legacy__'` lets the column be added without breaking existing rows. The legacy
rows continue to work during the transition; they're just ignored once PAT support is removed.

Run locally:
```bash
npx wrangler d1 execute oura-cache --local --file=./migrations/002_users.sql
```

### 0d. Add `OURA_CACHE` KV namespace to `wrangler.example.jsonc`

Used in Phase 2 for short-lived OAuth state (auth codes, PKCE verifiers). KV is better suited
than D1 for these because they're ephemeral and need TTL-based expiry.

```jsonc
"kv_namespaces": [
  { "binding": "OAUTH_KV", "id": "<your-kv-id>" }
]
```

Add `OAUTH_KV: KVNamespace` to `Env`.

---

## Phase 1 — Oura OAuth client

These new source files make the Worker able to obtain and refresh per-user Oura tokens.
No routes are wired yet — this phase is purely library code + unit tests.

### `src/crypto.ts`

WebCrypto helpers. Workers runtime exposes `globalThis.crypto` (Web Crypto API).

```ts
export async function encrypt(plaintext: string, keyHex: string): Promise<string>
export async function decrypt(ciphertext: string, keyHex: string): Promise<string>
```

- AES-GCM, 256-bit key derived from `keyHex` via `crypto.subtle.importKey`
- Prepend random 96-bit IV to ciphertext; encode as `base64(iv + ciphertext)`
- `keyHex` is the `OURA_ENCRYPTION_KEY` env var — 64 hex chars (32 bytes)
- Generate one with `openssl rand -hex 32` or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

### `src/oura-oauth.ts`

Oura OAuth 2.0 endpoints (Oura uses standard auth code + PKCE).

```ts
export function ouraAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string

export async function exchangeOuraCode(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ access_token: string; refresh_token: string; expires_in: number }>

export async function refreshOuraToken(params: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ access_token: string; refresh_token: string; expires_in: number }>
```

Oura token endpoint: `https://api.ouraring.com/oauth/token`
Oura auth endpoint: `https://cloud.ouraring.com/oauth/authorize`
Scopes needed: `personal daily heartrate workout stress`

### `src/users.ts`

D1 user CRUD — thin wrapper, no business logic.

```ts
export interface User {
  id: string;
  ouraToken: string;       // decrypted at-rest
  ouraRefresh: string;     // decrypted at-rest
  ouraExpiry: number;      // unix seconds
}

export async function getUser(db: D1Database, userId: string, encKey: string): Promise<User | null>
export async function upsertUser(db: D1Database, user: User, encKey: string): Promise<void>
```

`getUser` decrypts on the way out; `upsertUser` encrypts on the way in.

### `src/oura-token.ts`

Token lifecycle management: returns a valid Oura access token for a user, refreshing if necessary.

```ts
export async function getValidOuraToken(
  db: D1Database,
  userId: string,
  encKey: string,
  ouraClientId: string,
  ouraClientSecret: string,
): Promise<string>
```

- Calls `getUser`, checks `ouraExpiry - 300` (5-min buffer)
- If expired: calls `refreshOuraToken`, calls `upsertUser` with new tokens, returns new access token
- If not found: throws `OuraAuthError` (caller redirects to Oura OAuth)

### Phase 1 tests

`src/__tests__/crypto.test.ts` — round-trip encrypt/decrypt, different IVs each call

`src/__tests__/oura-oauth.test.ts` — URL construction, fetch mock for exchange + refresh

`src/__tests__/users.test.ts` — CRUD with mock D1 (reuse `createMockD1` pattern from cache.test.ts),
verify plaintext never written to DB

`src/__tests__/oura-token.test.ts` — fresh token returned, expired token refreshes, missing user throws

---

## Phase 2 — MCP OAuth AS + big switch

This is the largest phase. It rewires `/mcp/*` to require OAuth bearer tokens, adds OAuth
endpoints, and removes Cloudflare Access.

### 2a. Install `@cloudflare/workers-oauth-provider`

```bash
pnpm add @cloudflare/workers-oauth-provider
```

This package provides a `McpAgent` base class and an `OAuthProvider` helper that implements
OAuth 2.1 with PKCE, Dynamic Client Registration (DCR), and token introspection — exactly
what MCP clients expect.

Documentation: https://github.com/cloudflare/workers-oauth-provider

### 2b. `src/oura-auth-handler.ts` — Oura OAuth callback

Handles `/oauth/callback` — the redirect URI that Oura sends the user back to after they
authorize the app.

```ts
export async function handleOuraCallback(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response>
```

Flow:
1. Parse `code` + `state` from query params
2. Load `state` from KV (`OAUTH_KV.get(state)`) — contains `{ userId, codeVerifier, redirectBack }`
3. Delete state from KV (one-time use)
4. Exchange `code` for Oura tokens via `exchangeOuraCode()`
5. `upsertUser()` with new tokens
6. Redirect to `redirectBack` (the original MCP client redirect URI from step 1 of the outer flow)

### 2c. Refactor `src/index.ts`

**Remove:**
- `OURA_API_TOKEN` from `Env` (after transition period)
- Cloudflare Access header check (if any — currently handled by CF Access at the network layer,
  not in Worker code, so there may be nothing to remove here)

**Add routes:**
```
GET  /oauth/authorize     → OAuthProvider.handleAuthorize()
POST /oauth/token         → OAuthProvider.handleToken()
GET  /oauth/callback      → handleOuraCallback()
GET  /.well-known/oauth-authorization-server → OAuthProvider.handleMetadata()
```

**Change MCP tool dispatch:**

Current `fetchFromOura(toolName, args, env)` — uses `env.OURA_API_TOKEN`

New `fetchFromOura(toolName, args, ouraToken: string)` — caller passes the decrypted token

In `handleMcp()`, extract the bearer token from `Authorization: Bearer <token>`, introspect it
via `OAuthProvider.introspect()` to get `userId`, call `getValidOuraToken()` to get the Oura
token, then pass it to `fetchFromOura`.

**Fix `handleSingletonTool`:** add `userId` parameter; use it in `getCachedSingleton` /
`setCachedSingleton` so personal_info is per-user. Update `getCachedSingleton` signature:

```ts
export async function getCachedSingleton(
  db: D1Database,
  metric: string,
  userId: string,
): Promise<unknown | null>
```

The `date_key` for singleton rows becomes `__singleton__` (unchanged), but the `user_id` column
discriminates between users.

**Fix `handleDateRangeTool`:** pass `userId` through to `getCachedRange` / `setCachedRange`.

Update cache function signatures:

```ts
export async function getCachedRange(
  db: D1Database,
  metric: string,
  dates: string[],
  userId: string,
): Promise<{ hits: Map<string, unknown>; misses: string[] }>

export async function setCachedRange(
  db: D1Database,
  metric: string,
  entries: Array<{ dateKey: string; data: unknown }>,
  userId: string,
): Promise<void>
```

SQL changes: add `user_id = ?` to all WHERE clauses and include `user_id` in INSERT.

### 2d. Remove Cloudflare Access from `wrangler.example.jsonc`

The `[triggers]` / access-policy section (if present in the template) is removed.
The Worker is now open on the internet — protected by its own OAuth layer.

### 2e. Update `wrangler.example.jsonc` bindings

Add:
```jsonc
"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "<your-kv-id>" }],
"vars": {
  "OURA_CLIENT_ID": "",
  "COOKIE_SECRET": ""
}
```

Secrets (not in jsonc): `OURA_CLIENT_SECRET`, `OURA_ENCRYPTION_KEY`

---

## Phase 3 — Bootstrap wizard simplification

The wizard currently does ~700 lines of work to provision Zero Trust. After removing Access,
it drops to ~300 lines.

**Remove steps:**
- `ensureAccessEnabled()` (Zero Trust org enrollment check)
- `ensureAccessApp()` (creates CF Access application)
- `ensureServiceToken()` (creates CF service token)
- `ensureAccessPolicy()` (wires service token to app)
- Service-token rotation / expiry handling
- Writing `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` to Claude Desktop config

**Keep / update:**
- Cloudflare API token input + validation
- Account + subdomain selection
- D1 database create + schema migration (now runs both `001_init.sql` and `002_users.sql`)
- Worker deploy
- Setting secrets: `OURA_ENCRYPTION_KEY` (generate if not present), `OURA_CLIENT_ID`,
  `OURA_CLIENT_SECRET`, `COOKIE_SECRET`
- **New prompt:** "Set up Oura OAuth app" — walk user through creating an app at
  `https://cloud.ouraring.com/oauth/applications/create` and pasting the client ID + secret

**Claude Desktop config written:**
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

No `env` block needed (no service token). `mcp-remote` handles the OAuth browser redirect flow
automatically when the server returns a 401 with `WWW-Authenticate: Bearer`.

---

## Phase 4 — Tests

**Update existing tests:**

`src/__tests__/cache.test.ts`
- Add `userId` param to all `getCachedRange` / `setCachedRange` calls
- Add test: two users with same metric + date_key return independent data

`src/__tests__/index.test.ts`
- Update `makeCtx()` / `makeEnv()` — remove `OURA_API_TOKEN`, add new env vars
- Replace static token in fetch spy with per-call `getValidOuraToken` mock
- Add test: missing / invalid bearer token → 401
- Add test: `handleSingletonTool` uses `userId` from token introspection

**New tests:**

`src/__tests__/oura-auth-handler.test.ts`
- Valid callback: state in KV, code exchange succeeds, user upserted, redirect issued
- Missing state: 400
- KV hit but exchange fails: 502

`src/__tests__/oura-token.test.ts`
- Token still valid: no refresh call
- Token within 5-min buffer: refresh called
- User not found: throws

Coverage target: maintain ≥ 90% on all four dimensions.

---

## Phase 5 — Docs

**`README.md`** — full rewrite of the Setup section:

1. Create Oura OAuth app at `cloud.ouraring.com/oauth/applications/create`
   - Redirect URI: `https://<worker>.workers.dev/oauth/callback`
   - Scopes: `personal daily heartrate workout stress`
2. `pnpm install && pnpm bootstrap` — wizard handles everything else
3. Quit + relaunch Claude Desktop, click "Connect to Oura" in the first tool call

Remove the Zero Trust troubleshooting section. Add "Multi-user" note: anyone can authenticate;
their data is isolated by `user_id` in D1.

**`CLAUDE.md`** — update Architecture section:

- New request flow diagram (OAuth token introspection → `getValidOuraToken` → Oura API)
- New env vars table
- Note about `migrations/002_users.sql`
- Update `Env` interface docs

---

## Phase 6 — Deploy & verify

### Checklist

- [ ] Run `migrations/002_users.sql` against production D1
  ```bash
  npx wrangler d1 execute oura-cache --remote --file=./migrations/002_users.sql
  ```
- [ ] Create KV namespace and update `wrangler.jsonc`
  ```bash
  npx wrangler kv:namespace create OAUTH_KV
  ```
- [ ] Set secrets
  ```bash
  npx wrangler secret put OURA_ENCRYPTION_KEY   # openssl rand -hex 32
  npx wrangler secret put OURA_CLIENT_ID
  npx wrangler secret put OURA_CLIENT_SECRET
  npx wrangler secret put COOKIE_SECRET         # openssl rand -hex 32
  ```
- [ ] Deploy: `pnpm deploy`
- [ ] Test with owner account: open Claude, complete OAuth flow, ask "what was my sleep score last night?"
- [ ] Test token refresh: manually expire token in D1 (`UPDATE users SET oura_expiry = 1`), ask again
- [ ] Test second user: authenticate a second Oura account, verify it sees its own data (not yours)
- [ ] Remove Cloudflare Access application + service token from dashboard (manual, one-time)

### Rollback plan

The `__legacy__` default on `user_id` means the schema change is fully backwards-compatible.
If something breaks post-deploy, redeploy the previous Worker version from the Cloudflare
dashboard — D1 rows with `user_id = '__legacy__'` continue to work with the old PAT code.

---

## Suggested PR split

| PR | Branch | Contents |
|---|---|---|
| PR A | `feat/oauth-prep` | Phase 0 (env.ts, schema 002, KV binding) + Phase 1 (crypto, oura-oauth, users, oura-token) + Phase 1 tests |
| PR B | `feat/oauth-switch` | Phase 2 (MCP AS, callback handler, index.ts refactor, cache user_id) + Phase 3 (bootstrap simplification) + Phase 4 updated tests + Phase 5 docs |

PR A is pure additions — no behaviour change, easy to review. PR B is the big switch — do it in
one commit so the before/after is clear, not a series of half-working intermediate states.

---

## Open questions / parking lot

- **Token expiry UX**: when the Oura refresh token itself expires (Oura issues 30-day refresh
  tokens), the user needs to re-authorize. `getValidOuraToken` will throw; the MCP tool response
  should include a human-readable message with the re-auth URL. Plan: catch `OuraAuthError` in
  `handleMcp` and return a structured MCP error with `data.reauth_url`.

- **KV vs D1 for OAuth state**: short-lived PKCE state (< 10 min) is a good fit for KV TTL.
  Auth codes issued by the Worker (step 2 of the outer flow) also go in KV with a 60s TTL.
  Access tokens and refresh tokens stay in D1 (durable, user-keyed).

- **Dynamic Client Registration**: `@cloudflare/workers-oauth-provider` supports DCR out of the
  box — `mcp-remote` will register itself automatically. No manual client ID needed.

- **Oura app redirect URI in bootstrap**: the wizard will print the exact redirect URI the user
  needs to paste into the Oura app creation form before running bootstrap. The URI is deterministic
  (`https://<subdomain>.workers.dev/oauth/callback`) so it can be shown before deploy.
