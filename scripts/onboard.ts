/**
 * Interactive onboarding wizard for oura-mcp-server.
 *
 * Goal: take a non-technical user from zero to a working Cloudflare-deployed
 * MCP server wired into Claude Desktop, in one command.
 *
 * Flow:
 *   1. Welcome + consent
 *   2. Cloudflare browser OAuth (opens dash.cloudflare.com via PKCE)
 *   3. Account selection (auto if single)
 *   4. workers.dev subdomain (use existing / prompt to create)
 *   5. D1 cache database (reuse or create 'oura-cache')
 *   6. Write wrangler.jsonc from template with real database_id
 *   7. Apply D1 schema migration
 *   8. Oura Personal Access Token (reuse / paste existing / open browser + paste)
 *   9. Deploy Worker (`wrangler deploy` with OAuth token in env)
 *  10. Set OURA_API_TOKEN secret on the deployed worker
 *  11. Zero Trust: Access app + Service Token + Policy (reuse or recreate)
 *  12. Merge Claude Desktop config (only update oura-sleep / oura-activity keys)
 *  13. Success summary
 *
 * Re-running is safe — all steps detect and reuse existing resources.
 */

import Cloudflare from "cloudflare";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";

import {
  banner, c, confirm, closePrompts, info, ok, pick,
  promptHidden, pressEnter, step, warn,
} from "./prompts";

// ── Constants ─────────────────────────────────────────────────────────────────

const WORKER_NAME = "oura-mcp-server";
const D1_NAME = "oura-cache";
const ACCESS_APP_NAME = "oura-mcp-server";
const SERVICE_TOKEN_NAME = "oura-mcp-server-claude";
const OURA_PAT_URL = "https://cloud.ouraring.com/personal-access-tokens";
const OURA_SECRET_NAME = "OURA_API_TOKEN";

// Wrangler's public OAuth client — PKCE only, no client secret.
// The redirect URI is pre-registered on Cloudflare's side — it must be exactly
// this (fixed port, fixed path). If port 8976 is busy we can't do OAuth; the
// script will tell the user to free it (or use the Global API Key path).
const CF_OAUTH_CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7";
const CF_OAUTH_REDIRECT_PORT = 8976;
const CF_OAUTH_REDIRECT_PATH = "/oauth/callback";
const CF_AUTH_URL = "https://dash.cloudflare.com/oauth2/auth";
const CF_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const CF_SCOPES = [
  "account:read", "user:read",
  "workers:write", "workers_scripts:write", "workers_routes:write",
  "d1:write", "zone:read",
  "offline_access",
].join(" ");

const CF_SIGNUP_URL = "https://dash.cloudflare.com/sign-up";
const CF_API_TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

// Claude Desktop config location differs by OS:
//   macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
//   Windows: %APPDATA%\Claude\claude_desktop_config.json
//   Linux:   ~/.config/Claude/claude_desktop_config.json
// (Linux isn't officially supported by Claude Desktop today, but the XDG path is
// what community ports use — harmless to write there either way.)
const CLAUDE_CFG_PATH = (() => {
  switch (process.platform) {
    case "darwin":
      return path.join(
        os.homedir(),
        "Library/Application Support/Claude/claude_desktop_config.json",
      );
    case "win32":
      return path.join(
        process.env["APPDATA"] ?? path.join(os.homedir(), "AppData/Roaming"),
        "Claude",
        "claude_desktop_config.json",
      );
    default:
      return path.join(
        process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config"),
        "Claude",
        "claude_desktop_config.json",
      );
  }
})();

const DEV_VARS_PATH = path.resolve(process.cwd(), ".dev.vars");
const WRANGLER_JSONC_PATH = path.resolve(process.cwd(), "wrangler.jsonc");
const WRANGLER_EXAMPLE_PATH = path.resolve(process.cwd(), "wrangler.example.jsonc");
const SCHEMA_PATH = path.resolve(process.cwd(), "migrations/001_init.sql");

// ── .dev.vars load/save ───────────────────────────────────────────────────────

function loadDevVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!fs.existsSync(DEV_VARS_PATH)) return vars;
  for (const line of fs.readFileSync(DEV_VARS_PATH, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

function saveDevVars(vars: Record<string, string>): void {
  const existing = loadDevVars();
  const merged = { ...existing, ...vars };
  const content = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  fs.writeFileSync(DEV_VARS_PATH, content);
}

// ── Cross-platform browser open ──────────────────────────────────────────────

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? `open "${url}"` :
    process.platform === "win32"  ? `start "" "${url}"` :
    `xdg-open "${url}"`;
  try { execSync(cmd, { stdio: "ignore" }); } catch { /* non-fatal */ }
}

// ── Cloudflare browser OAuth (PKCE) ──────────────────────────────────────────

async function cloudflareBrowserAuth(): Promise<string> {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");

  // Cloudflare's OAuth client (the one wrangler uses) has this exact redirect
  // URI pre-registered. Random ports won't work — we must use 8976.
  const port = CF_OAUTH_REDIRECT_PORT;
  const redirectUri = `http://localhost:${port}${CF_OAUTH_REDIRECT_PATH}`;

  // Verify the port is free up-front with a friendly error if not
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(
          `Port ${port} is in use (required for Cloudflare OAuth callback).\n` +
          `  Free it (e.g. lsof -ti:${port} | xargs kill) and re-run, or\n` +
          `  use the Global API Key option instead.`
        ));
      } else {
        reject(err);
      }
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolve());
    });
  });

  const authUrl = new URL(CF_AUTH_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CF_OAUTH_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", CF_SCOPES);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { server.close(); reject(new Error("OAuth timed out")); }, 5 * 60 * 1000);

    const html = (okMark: boolean, msg: string) =>
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa}
        .box{text-align:center;padding:3rem;border-radius:16px;background:${okMark ? "#f0fdf4" : "#fef2f2"};box-shadow:0 4px 24px rgba(0,0,0,0.06)}
        h2{margin:0 0 0.5rem;font-size:1.5rem}p{color:#555;margin:0}
      </style></head><body><div class="box"><h2>${okMark ? "✅" : "❌"} ${msg}</h2><p>You can close this tab.</p></div></body></html>`;

    const server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (reqUrl.pathname !== CF_OAUTH_REDIRECT_PATH) { res.writeHead(404).end(); return; }

      clearTimeout(timeout);

      const code = reqUrl.searchParams.get("code");
      const returnedState = reqUrl.searchParams.get("state");
      const error = reqUrl.searchParams.get("error");

      if (error || !code || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(html(false, error ?? "Authorization failed"));
        server.close();
        reject(new Error(error ?? "Authorization failed"));
        return;
      }

      try {
        const resp = await fetch(CF_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: CF_OAUTH_CLIENT_ID,
            code, redirect_uri: redirectUri, code_verifier: verifier,
          }),
        });
        const data = await resp.json() as Record<string, unknown>;
        if (!resp.ok || !data["access_token"]) {
          const msg = (data["error_description"] as string) ?? "Token exchange failed";
          res.writeHead(400, { "Content-Type": "text/html" }).end(html(false, msg));
          server.close();
          reject(new Error(msg));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" }).end(html(true, "Authorized"));
        server.close();
        resolve(data["access_token"] as string);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Token exchange failed";
        res.writeHead(500, { "Content-Type": "text/html" }).end(html(false, msg));
        server.close();
        reject(new Error(msg));
      }
    });

    server.listen(port, "127.0.0.1", () => {
      info(`Redirect URL: ${redirectUri}`);
      info("Opening your browser to log in to Cloudflare...");
      openBrowser(authUrl.toString());
    });
  });
}

// ── Steps ────────────────────────────────────────────────────────────────────

async function doAuth(): Promise<{ client: Cloudflare; email: string; apiToken: string }> {
  step(1, "Connect to Cloudflare");

  // Only the Account ID is remembered across runs — never the OAuth token
  // (they expire) and never a long-lived user credential. One browser login
  // per run keeps the auth model dead simple and matches what wrangler does.
  const haveSavedAccountId = !!(
    loadDevVars()["CLOUDFLARE_ACCOUNT_ID"] ?? process.env["CLOUDFLARE_ACCOUNT_ID"]
  );

  if (!haveSavedAccountId) {
    const hasAccount = await confirm("Do you already have a Cloudflare account?", true);
    if (!hasAccount) {
      console.log("  No problem — it's free and takes about a minute.");
      info(`Opening the signup page: ${c.cyan(CF_SIGNUP_URL)}`);
      openBrowser(CF_SIGNUP_URL);
      console.log("  Create your account, verify your email, then come back here.\n");
      await pressEnter("Press Enter once your account is ready...");
    }
    console.log("  We'll use your Cloudflare account to host the MCP server.");
    console.log("  Your data stays in your account — we never see it.\n");
  }

  const apiToken = await cloudflareBrowserAuth();
  const client = new Cloudflare({ apiToken });
  ok("Browser login successful");

  // Verify + fetch identity
  try {
    const me = await client.user.get();
    const email = (me as { email?: string }).email ?? "unknown";
    ok(`Authenticated as ${c.cyan(email)}`);
    return { client, email, apiToken };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown auth error";
    throw new Error(`Couldn't verify credentials: ${msg}`);
  }
}

// ── Scoped API token (needed for Zero Trust / Access endpoints) ──────────────
//
// Why this exists: OAuth tokens from wrangler's public client don't carry the
// Access / Zero Trust scopes, so we can't call the Access API with them.
// The "obvious" fix — calling POST /user/tokens to mint a scoped token from
// the OAuth session — doesn't work either: that endpoint also requires scopes
// the OAuth client doesn't grant. So for OAuth users we just ask them to
// create the Access-scoped token manually, once.

async function promptManualApiToken(): Promise<string> {
  const hasOne = await confirm(
    "Do you already have a Cloudflare API token with Access permissions?",
    false,
  );

  if (!hasOne) {
    console.log("\n  Create one with these two permissions:");
    console.log(`    • ${c.cyan("Account → Access: Apps and Policies → Edit")}`);
    console.log(`    • ${c.cyan("Account → Access: Service Tokens → Edit")}`);
    console.log();
    console.log(`  ${c.bold("Security tip:")} in the ${c.cyan('"TTL"')} section, set an ${c.bold("expiration date")}`);
    console.log(`  (${c.cyan("6-12 months")} is reasonable). A leaked non-expiring token is forever.`);
    console.log(`  When it expires this script will tell you, and you'll paste a new one.`);
    info(`Opening ${c.cyan(CF_API_TOKENS_URL)} in your browser...`);
    openBrowser(CF_API_TOKENS_URL);
    await pressEnter("Press Enter once you've created and copied the token...");
  }

  const token = await promptHidden("Paste the API token (hidden)");
  if (!token) throw new Error("API token is required to continue");
  return token;
}

/**
 * Returns a Cloudflare client that can access the Zero Trust / Access API.
 * OAuth tokens from wrangler's client don't include Access scopes, so we
 * prompt the user once for an Access-scoped API token and cache it under
 * CLOUDFLARE_ACCESS_API_TOKEN for subsequent runs.
 */
async function ensureZeroTrustClient(): Promise<Cloudflare> {
  const saved = loadDevVars()["CLOUDFLARE_ACCESS_API_TOKEN"];
  if (saved) {
    // Probe the saved token before trusting it. If it's expired or revoked
    // we'd otherwise blow up several calls deep into setupZeroTrust with an
    // opaque 401 — catch it here and prompt for a new one.
    const client = new Cloudflare({ apiToken: saved });
    try {
      await client.user.tokens.verify();
      info("Using saved CLOUDFLARE_ACCESS_API_TOKEN for Zero Trust");
      return client;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const looksExpired =
        msg.includes("expired") || msg.includes("1001") ||
        msg.includes("401") || msg.includes("Invalid access token");
      if (looksExpired) {
        warn("Saved Access API token is expired or revoked");
      } else {
        warn(`Saved Access API token isn't working: ${c.dim(msg)}`);
      }
      console.log(`  ${c.dim("Removing it from .dev.vars and asking for a new one.")}`);
      const current = loadDevVars();
      delete current["CLOUDFLARE_ACCESS_API_TOKEN"];
      fs.writeFileSync(
        DEV_VARS_PATH,
        Object.entries(current).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
      );
    }
  }

  info("Zero Trust needs an Access-scoped API token (your browser login doesn't cover it)");
  const token = await promptManualApiToken();
  ok("API token captured");
  saveDevVars({ CLOUDFLARE_ACCESS_API_TOKEN: token });
  return new Cloudflare({ apiToken: token });
}

async function pickAccount(client: Cloudflare): Promise<{ id: string; name: string }> {
  step(2, "Select Cloudflare account");

  const accounts: { id: string; name: string }[] = [];
  for await (const a of client.accounts.list({})) {
    if (a.id && a.name) accounts.push({ id: a.id, name: a.name });
  }
  if (accounts.length === 0) throw new Error("No Cloudflare accounts found");

  // Reuse CLOUDFLARE_ACCOUNT_ID from .dev.vars if it matches an accessible account
  const saved = loadDevVars()["CLOUDFLARE_ACCOUNT_ID"] ?? process.env["CLOUDFLARE_ACCOUNT_ID"];
  if (saved) {
    const match = accounts.find((a) => a.id === saved);
    if (match) {
      info(`Using saved CLOUDFLARE_ACCOUNT_ID — ${c.cyan(match.name)}`);
      return match;
    }
    warn(`Saved account ID ${c.dim(saved)} not found among your accounts — prompting below.`);
  }

  let selected: { id: string; name: string };
  if (accounts.length === 1) {
    selected = accounts[0]!;
    ok(`Using ${c.cyan(selected.name)} ${c.dim(`(${selected.id})`)}`);
  } else {
    const idx = await pick(
      "You have multiple accounts — which one?",
      accounts,
      (a) => `${a.name} ${c.dim(`(${a.id})`)}`,
      0,
    );
    selected = accounts[idx]!;
    ok(`Using ${c.cyan(selected.name)}`);
  }

  saveDevVars({ CLOUDFLARE_ACCOUNT_ID: selected.id });
  return selected;
}

async function ensureWorkersSubdomain(client: Cloudflare, accountId: string): Promise<string> {
  step(3, "workers.dev subdomain");

  try {
    const res = await client.workers.subdomains.get({ account_id: accountId });
    const sub = (res as { subdomain?: string }).subdomain;
    if (sub) {
      ok(`workers.dev subdomain: ${c.cyan(`${sub}.workers.dev`)}`);
      saveDevVars({ WORKER_SUBDOMAIN: sub });
      return sub;
    }
  } catch {
    // fall through
  }

  warn("No workers.dev subdomain set on this account yet.");
  console.log(`  Open ${c.cyan("https://dash.cloudflare.com/")} → Workers & Pages → Subdomain`);
  console.log("  and choose a subdomain (e.g. your username).\n");
  await pressEnter("Press Enter once you've enabled it...");

  // Retry
  const res = await client.workers.subdomains.get({ account_id: accountId });
  const sub = (res as { subdomain?: string }).subdomain;
  if (!sub) throw new Error("Still no workers.dev subdomain — please enable it and re-run.");
  ok(`workers.dev subdomain: ${c.cyan(`${sub}.workers.dev`)}`);
  saveDevVars({ WORKER_SUBDOMAIN: sub });
  return sub;
}

async function ensureD1(client: Cloudflare, accountId: string): Promise<string> {
  step(4, "D1 cache database");

  // Look for existing by name
  for await (const db of client.d1.database.list({ account_id: accountId, name: D1_NAME })) {
    if (db.name === D1_NAME && db.uuid) {
      ok(`Found existing D1 database ${c.cyan(D1_NAME)}`);
      return db.uuid;
    }
  }

  info(`Creating D1 database "${D1_NAME}"...`);
  const created = await client.d1.database.create({ account_id: accountId, name: D1_NAME });
  const id = created.uuid;
  if (!id) throw new Error("D1 create returned no uuid");
  ok(`Created D1 database ${c.cyan(D1_NAME)} ${c.dim(`(${id})`)}`);
  return id;
}

function writeWranglerConfig(d1DatabaseId: string): void {
  step(5, "Local Worker config (wrangler.jsonc)");

  if (!fs.existsSync(WRANGLER_EXAMPLE_PATH)) {
    throw new Error(`Missing ${WRANGLER_EXAMPLE_PATH}`);
  }
  const template = fs.readFileSync(WRANGLER_EXAMPLE_PATH, "utf8");
  const out = template.replace(/YOUR_DATABASE_ID/g, d1DatabaseId);
  fs.writeFileSync(WRANGLER_JSONC_PATH, out);
  ok(`Wrote wrangler.jsonc with database_id ${c.dim(d1DatabaseId)}`);
}

async function applyD1Schema(client: Cloudflare, accountId: string, dbId: string): Promise<void> {
  step(6, "D1 schema migration");

  if (!fs.existsSync(SCHEMA_PATH)) throw new Error(`Missing schema file ${SCHEMA_PATH}`);
  const sql = fs.readFileSync(SCHEMA_PATH, "utf8");

  info("Applying migrations/001_init.sql...");
  await client.d1.database.query(dbId, { account_id: accountId, sql });
  ok("Schema applied");
}

async function ensureOuraToken(): Promise<string> {
  step(7, "Oura Personal Access Token");

  const existing = loadDevVars()[OURA_SECRET_NAME];
  if (existing) {
    const reuse = await confirm(`Found existing Oura token in .dev.vars — use it?`, true);
    if (reuse) {
      ok("Reusing existing Oura token");
      return existing;
    }
  }

  console.log("  This connects the server to your Oura Ring data.");
  console.log(`  Token page: ${c.cyan(OURA_PAT_URL)}\n`);

  const hasToken = await confirm("Do you already have an Oura Personal Access Token?", false);

  if (!hasToken) {
    info("Opening the Oura token page in your browser...");
    openBrowser(OURA_PAT_URL);
    console.log("  Click 'Create New Personal Access Token', give it a name, and copy the token.");
    await pressEnter("Press Enter when you have it copied...");
  }

  const token = await promptHidden("Paste your Oura token (hidden)");
  if (!token) throw new Error("Oura token cannot be empty");
  saveDevVars({ [OURA_SECRET_NAME]: token });
  ok("Token saved to .dev.vars");
  return token;
}

function deployWorker(apiToken: string, accountId: string): void {
  step(8, "Deploy Worker to Cloudflare");

  info("Running `wrangler deploy`... (first deploy takes ~20s)");
  const result = spawnSync("npx", ["wrangler", "deploy"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: apiToken,
      CLOUDFLARE_ACCOUNT_ID: accountId,
    },
  });
  if (result.status !== 0) throw new Error(`wrangler deploy failed (exit ${result.status})`);
  ok("Worker deployed");
}

async function setWorkerSecret(client: Cloudflare, accountId: string, value: string): Promise<void> {
  step(9, "Set OURA_API_TOKEN secret on deployed Worker");

  await client.workers.scripts.secrets.update(WORKER_NAME, {
    account_id: accountId,
    name: OURA_SECRET_NAME,
    text: value,
    type: "secret_text",
  });
  ok(`Secret ${c.cyan(OURA_SECRET_NAME)} set`);
}

async function setupZeroTrust(
  client: Cloudflare, accountId: string, workerDomain: string,
): Promise<{ clientId: string; clientSecret: string }> {
  step(10, "Cloudflare Access (Zero Trust) security");

  // Find or create Access application
  let appId: string | undefined;
  for await (const a of client.zeroTrust.access.applications.list({ account_id: accountId })) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const domain = (a as any).domain;
    if (domain === workerDomain) { appId = a.id; break; }
  }

  if (appId) {
    ok(`Reusing Access application ${c.dim(`(${appId})`)}`);
  } else {
    const app = await client.zeroTrust.access.applications.create({
      account_id: accountId,
      name: ACCESS_APP_NAME,
      domain: workerDomain,
      type: "self_hosted",
      session_duration: "720h",
      skip_interstitial: true,
    });
    appId = app.id!;
    ok(`Access application created ${c.dim(`(${appId})`)}`);
  }

  // ── Service token ──────────────────────────────────────────────────────────
  // client_secret is only returned on create, never on list/get. So reuse is
  // only possible when we have the saved secret locally AND the token with
  // that client_id still exists on Cloudflare. Otherwise we must rotate.
  const saved = loadDevVars();
  const savedClientId = saved["CF_ACCESS_CLIENT_ID"];
  const savedClientSecret = saved["CF_ACCESS_CLIENT_SECRET"];

  let svcId: string | undefined;
  let clientId: string | undefined;
  let clientSecret: string | undefined;

  // Important: `client_id` is the public identifier used in the CF-Access-Client-Id
  // header. The Access policy, however, references the service token by its
  // internal resource UUID (`id`), not its client_id. Getting this wrong yields
  // error 12130 "service token not found".
  if (savedClientId && savedClientSecret) {
    for await (const t of client.zeroTrust.access.serviceTokens.list({ account_id: accountId })) {
      if (t.client_id === savedClientId && t.id) {
        svcId = t.id;
        clientId = savedClientId;
        clientSecret = savedClientSecret;
        ok(`Reusing existing service token ${c.dim(`(${clientId.slice(0, 8)}…)`)}`);
        break;
      }
    }
    if (!svcId) {
      info("Saved service token no longer exists on Cloudflare — creating a new one");
    }
  }

  if (!svcId) {
    // No reusable token. If a token with our preferred name already exists
    // (from a previous run whose secret we lost), we can't reuse or overwrite
    // it — so suffix the name to avoid the conflict. The old token will sit
    // unused in the account; cleanup is the user's call, not ours.
    let desiredName = SERVICE_TOKEN_NAME;
    const existingNames = new Set<string>();
    for await (const t of client.zeroTrust.access.serviceTokens.list({ account_id: accountId })) {
      if (t.name) existingNames.add(t.name);
    }
    if (existingNames.has(desiredName)) {
      desiredName = `${SERVICE_TOKEN_NAME}-${new Date().toISOString().slice(0, 10)}`;
      let n = 2;
      while (existingNames.has(desiredName)) desiredName = `${SERVICE_TOKEN_NAME}-${new Date().toISOString().slice(0, 10)}-${n++}`;
      info(`An old "${SERVICE_TOKEN_NAME}" token already exists — creating "${desiredName}" instead`);
    }
    const svc = await client.zeroTrust.access.serviceTokens.create({
      account_id: accountId,
      name: desiredName,
    });
    svcId = svc.id!;
    clientId = svc.client_id!;
    clientSecret = svc.client_secret!;
    ok(`Service token created ${c.dim(`(${desiredName})`)}`);
    saveDevVars({ CF_ACCESS_CLIENT_ID: clientId, CF_ACCESS_CLIENT_SECRET: clientSecret });
  }

  // ── Policy ─────────────────────────────────────────────────────────────────
  // If any policy on the app already includes our service token, we're done —
  // no need to add another. We don't delete stale policies pointing at other
  // tokens; they're harmless (the referenced token is either valid or unused)
  // and may have been added by the user intentionally.
  const POLICY_NAME = "Allow oura-mcp-server service token";
  let policyOk = false;
  for await (const p of client.zeroTrust.access.applications.policies.list(appId, { account_id: accountId })) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const include = (p as any).include as Array<{ service_token?: { token_id?: string } }> | undefined;
    if (include?.some((rule) => rule.service_token?.token_id === svcId)) {
      ok("Reusing existing Access policy");
      policyOk = true;
      break;
    }
  }

  if (!policyOk) {
    // Policy — SDK type defs are incomplete, so cast
    await client.zeroTrust.access.applications.policies.create(appId, {
      account_id: accountId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({
        name: POLICY_NAME,
        decision: "non_identity",
        include: [{ service_token: { token_id: svcId } }],
      } as any),
    });
    ok("Access policy attached");
  }

  return { clientId: clientId!, clientSecret: clientSecret! };
}

interface McpRemoteEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function mergeClaudeDesktopConfig(
  workerDomain: string, clientId: string, clientSecret: string,
): boolean {
  step(11, "Claude Desktop config");

  // mcp-remote expands ${VAR} references in --header values from process env,
  // so we keep the secrets out of the args array and put them in `env` instead.
  // Benefits: less noise in the args, easier to rotate (update env, not args),
  // and secrets don't show up in `ps` output for the npx process.
  const build = (endpoint: string): McpRemoteEntry => ({
    command: "npx",
    args: [
      "-y", "mcp-remote",
      `https://${workerDomain}/mcp/${endpoint}`,
      "--header", "CF-Access-Client-Id:${CF_ACCESS_CLIENT_ID}",
      "--header", "CF-Access-Client-Secret:${CF_ACCESS_CLIENT_SECRET}",
    ],
    env: {
      CF_ACCESS_CLIENT_ID: clientId,
      CF_ACCESS_CLIENT_SECRET: clientSecret,
    },
  });

  const newEntries = {
    "oura-sleep": build("sleep"),
    "oura-activity": build("activity"),
  };

  // Read existing config if any
  let config: { mcpServers?: Record<string, McpRemoteEntry> } & Record<string, unknown> = {};
  const exists = fs.existsSync(CLAUDE_CFG_PATH);

  if (exists) {
    try {
      const raw = fs.readFileSync(CLAUDE_CFG_PATH, "utf8");
      if (raw.trim()) config = JSON.parse(raw);
    } catch (err) {
      warn("Couldn't parse existing config:");
      console.log(`  ${c.dim(err instanceof Error ? err.message : String(err))}`);
      const proceed = confirm("Skip this step? You can paste the snippet manually later.", true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (proceed as any) {
        printManualSnippet(workerDomain, clientId, clientSecret);
        return false;
      }
    }
  }

  const existingServers = config.mcpServers ?? {};
  const otherServers = Object.keys(existingServers).filter(
    (k) => k !== "oura-sleep" && k !== "oura-activity",
  );

  if (otherServers.length > 0) {
    console.log(`  Found ${otherServers.length} other MCP server(s): ${c.dim(otherServers.join(", "))}`);
    console.log(`  ${c.dim("These will be preserved unchanged.")}`);
  }
  if (existingServers["oura-sleep"] || existingServers["oura-activity"]) {
    console.log(`  ${c.dim("Existing oura-sleep / oura-activity entries will be updated.")}`);
  }

  config.mcpServers = {
    ...existingServers,
    ...newEntries,
  };

  // Backup if overwriting
  if (exists) {
    const bak = `${CLAUDE_CFG_PATH}.bak`;
    fs.copyFileSync(CLAUDE_CFG_PATH, bak);
    info(`Backed up original to ${c.dim(bak)}`);
  } else {
    fs.mkdirSync(path.dirname(CLAUDE_CFG_PATH), { recursive: true });
  }

  fs.writeFileSync(CLAUDE_CFG_PATH, JSON.stringify(config, null, 2) + "\n");
  ok(`Config updated at ${c.dim(CLAUDE_CFG_PATH)}`);
  return true;
}

function printManualSnippet(workerDomain: string, clientId: string, clientSecret: string): void {
  console.log(`
  Add these two entries under "mcpServers" in:
    ${c.cyan(CLAUDE_CFG_PATH)}

    "oura-sleep": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://${workerDomain}/mcp/sleep",
        "--header", "CF-Access-Client-Id:\${CF_ACCESS_CLIENT_ID}",
        "--header", "CF-Access-Client-Secret:\${CF_ACCESS_CLIENT_SECRET}"
      ],
      "env": {
        "CF_ACCESS_CLIENT_ID": "${clientId}",
        "CF_ACCESS_CLIENT_SECRET": "${clientSecret}"
      }
    },
    "oura-activity": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://${workerDomain}/mcp/activity",
        "--header", "CF-Access-Client-Id:\${CF_ACCESS_CLIENT_ID}",
        "--header", "CF-Access-Client-Secret:\${CF_ACCESS_CLIENT_SECRET}"
      ],
      "env": {
        "CF_ACCESS_CLIENT_ID": "${clientId}",
        "CF_ACCESS_CLIENT_SECRET": "${clientSecret}"
      }
    }
`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner("oura-mcp-server — Onboarding", [
    "This will set up everything needed to chat with",
    "your Oura Ring data inside Claude Desktop.",
    "",
    "It creates (in your Cloudflare account):",
    "  • A D1 database for caching",
    "  • A Worker that talks to the Oura API",
    "  • Cloudflare Access (Zero Trust) so only you can reach it",
    "",
    "And it updates your Claude Desktop config",
    "(only the two oura-* entries — nothing else is touched).",
    "",
    `${c.bold("You'll need:")}`,
    `  • A ${c.cyan("Cloudflare account")} — we'll open signup if you don't have one`,
    `  • An ${c.cyan("Oura Ring")} + account with a Personal Access Token`,
    "",
    `Estimated time: ${c.bold("~2 minutes")}`,
  ]);

  if (!(await confirm("Ready to start?", true))) {
    console.log("  Cancelled. Run again any time with `pnpm onboard`.");
    return;
  }

  // 1. Auth
  const { client, apiToken } = await doAuth();

  // 2. Account
  const account = await pickAccount(client);

  // 3. workers.dev subdomain
  const subdomain = await ensureWorkersSubdomain(client, account.id);
  const workerDomain = `${WORKER_NAME}.${subdomain}.workers.dev`;

  // ── Plan preview ─────────────────────────────────────────────────────────
  // Everything above is read-only (or prompts for creation of things the user
  // has already agreed they need — account, workers.dev subdomain). Before we
  // start actually creating Cloudflare resources / deploying / editing the
  // Claude Desktop config, show the concrete plan and get a go-ahead.
  let existingD1 = false;
  for await (const db of client.d1.database.list({ account_id: account.id, name: D1_NAME })) {
    if (db.name === D1_NAME) { existingD1 = true; break; }
  }
  const claudeCfgExists = fs.existsSync(CLAUDE_CFG_PATH);

  console.log();
  banner("Ready to provision", [
    `Cloudflare account:  ${c.cyan(account.name)} ${c.dim(`(${account.id})`)}`,
    `Worker URL:          ${c.cyan(`https://${workerDomain}`)}`,
    "",
    `${c.bold("The following will happen:")}`,
    `  • D1 database "${D1_NAME}" — ${existingD1 ? c.dim("reuse existing") : c.green("create new")}`,
    `  • Apply D1 schema (idempotent)`,
    `  • Deploy Worker "${WORKER_NAME}" (create on first run, update otherwise)`,
    `  • Set OURA_API_TOKEN secret on the Worker`,
    `  • Cloudflare Access app, service token & policy — reuse when possible, otherwise create`,
    `  • ${claudeCfgExists ? "Update" : "Create"} ${c.cyan(CLAUDE_CFG_PATH)}`,
    `    ${c.dim("(other MCP servers in this file are preserved)")}`,
  ]);
  if (!(await confirm("Proceed?", true))) {
    console.log("  Cancelled — no changes were made.");
    return;
  }

  // 4. D1 database
  const dbId = await ensureD1(client, account.id);

  // 5. Write wrangler.jsonc
  writeWranglerConfig(dbId);

  // 6. Apply schema
  await applyD1Schema(client, account.id, dbId);

  // 7. Oura PAT
  const ouraToken = await ensureOuraToken();

  // 8. Deploy Worker
  deployWorker(apiToken, account.id);

  // 9. Set secret on deployed worker
  await setWorkerSecret(client, account.id, ouraToken);

  // 10. Zero Trust — swap to a scoped-token client because OAuth scopes
  //     from wrangler's client don't include Access permissions.
  const ztClient = await ensureZeroTrustClient();
  const { clientId, clientSecret } = await setupZeroTrust(ztClient, account.id, workerDomain);

  // 11. Claude Desktop config
  const configUpdated = mergeClaudeDesktopConfig(workerDomain, clientId, clientSecret);

  // 12. Done!
  console.log();
  banner("✅  Setup complete!", [
    `Worker:    ${c.cyan(`https://${workerDomain}`)}`,
    `Protected: ${c.green("yes")} — only your Service Token can reach it`,
    "",
    configUpdated
      ? `${c.bold("Next:")} quit Claude Desktop fully (Cmd+Q) and reopen,`
      : `${c.bold("Next:")} add the snippet above to claude_desktop_config.json,`,
    `       then ask: "What was my sleep score last night?"`,
  ]);
}

main()
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n${c.red("✗ Setup failed:")} ${msg}`);
    process.exit(1);
  })
  .finally(() => closePrompts());
