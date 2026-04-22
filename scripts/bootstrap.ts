/**
 * Interactive bootstrap wizard for oura-mcp-server.
 *
 * Goal: take a non-technical user from zero to a working Cloudflare-deployed
 * MCP server wired into Claude Desktop, in one command.
 *
 * Flow:
 *   1. Welcome + consent
 *   2. Cloudflare API token (paste once; cached under CLOUDFLARE_API_TOKEN)
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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";

import {
  banner, c, confirm, closePrompts, info, ok, pick,
  prompt, promptHidden, pressEnter, step, warn,
} from "./prompts";

// ── Constants ─────────────────────────────────────────────────────────────────

const WORKER_NAME = "oura-mcp-server";
const D1_NAME = "oura-cache";
const ACCESS_APP_NAME = "oura-mcp-server";
const SERVICE_TOKEN_NAME = "oura-mcp-server-claude";
const OURA_PAT_URL = "https://cloud.ouraring.com/personal-access-tokens";
const OURA_SECRET_NAME = "OURA_API_TOKEN";

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

// ── Cloudflare API token ─────────────────────────────────────────────────────
//
// One manually-created API token drives everything: the SDK calls we make
// directly, and the wrangler CLI (via CLOUDFLARE_API_TOKEN in env). We ask
// the user to create it once with the full scope list below. Wrangler's
// public OAuth client doesn't grant Access scopes and can't mint scoped
// tokens from its session, so OAuth isn't a viable alternative here.

const REQUIRED_SCOPES: ReadonlyArray<[string, string]> = [
  ["Account → Account Settings → Read", "list accounts, detect the workers.dev subdomain"],
  ["Account → Workers Scripts → Edit", "deploy the Worker and set its secrets"],
  ["Account → D1 → Edit", "create the cache database and apply migrations"],
  ["Account → Access: Apps and Policies → Edit", "provision the Zero Trust app + policy"],
  ["Account → Access: Service Tokens → Edit", "mint and rotate the token Claude Desktop uses"],
  ["User → User Details → Read", "verify the token itself hasn't been revoked"],
];

async function promptApiToken(): Promise<string> {
  const hasOne = await confirm(
    "Do you already have a Cloudflare API token with the right permissions?",
    false,
  );

  if (!hasOne) {
    console.log(`\n  ${c.bold("Skip the templates")} — none cover what we need.`);
    console.log(`  Scroll down and click ${c.cyan('"Create Custom Token"')}, then add these permissions:`);
    for (const [scope, why] of REQUIRED_SCOPES) {
      console.log(`    • ${c.cyan(scope)} ${c.dim(`— ${why}`)}`);
    }
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

async function ensureApiToken(): Promise<{ client: Cloudflare; apiToken: string }> {
  step(1, "Connect to Cloudflare");

  const saved = loadDevVars()["CLOUDFLARE_API_TOKEN"] ?? process.env["CLOUDFLARE_API_TOKEN"];
  if (saved) {
    const client = new Cloudflare({ apiToken: saved });
    try {
      await client.user.tokens.verify();
      const me = await client.user.get();
      const email = (me as { email?: string }).email ?? "unknown";
      ok(`Using saved CLOUDFLARE_API_TOKEN ${c.dim(`(${email})`)}`);
      return { client, apiToken: saved };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warn(`Saved API token isn't working: ${c.dim(msg)}`);
      console.log(`  ${c.dim("Removing it from .dev.vars and asking for a new one.")}`);
      const current = loadDevVars();
      delete current["CLOUDFLARE_API_TOKEN"];
      fs.writeFileSync(
        DEV_VARS_PATH,
        Object.entries(current).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
      );
    }
  } else {
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

  const apiToken = await promptApiToken();
  const client = new Cloudflare({ apiToken });
  try {
    const me = await client.user.get();
    const email = (me as { email?: string }).email ?? "unknown";
    ok(`Authenticated as ${c.cyan(email)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown auth error";
    throw new Error(`Couldn't verify credentials: ${msg}`);
  }
  saveDevVars({ CLOUDFLARE_API_TOKEN: apiToken });
  return { client, apiToken };
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
      console.log(`  ${c.dim("(To switch accounts, run `pnpm reset` to clear .dev.vars + wrangler.jsonc, then re-run bootstrap.)")}`);
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

async function ensureWorkersSubdomain(
  client: Cloudflare, accountId: string, accountName: string,
): Promise<string> {
  step(3, "workers.dev subdomain");

  // Existing subdomain? Reuse it.
  try {
    const res = await client.workers.subdomains.get({ account_id: accountId });
    const sub = (res as { subdomain?: string }).subdomain;
    if (sub) {
      ok(`workers.dev subdomain: ${c.cyan(`${sub}.workers.dev`)}`);
      saveDevVars({ WORKER_SUBDOMAIN: sub });
      return sub;
    }
  } catch (e) {
    // 10007 = "subdomain not registered" — fall through to creation.
    if (!(e as Error).message?.includes("10007")) throw e;
  }

  // No subdomain yet. Create one with slugified account name; re-prompt on
  // global-uniqueness collision.
  info("No workers.dev subdomain yet — creating one.");
  let chosen = slugify(accountName);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await client.workers.subdomains.update({
        account_id: accountId,
        subdomain: chosen,
      });
      const sub = (res as { subdomain?: string }).subdomain ?? chosen;
      ok(`workers.dev subdomain: ${c.cyan(`${sub}.workers.dev`)}`);
      saveDevVars({ WORKER_SUBDOMAIN: sub });
      return sub;
    } catch (e) {
      const msg = (e as Error).message ?? "";
      warn(`"${chosen}.workers.dev" is not available: ${c.dim(msg)}`);
      const alt = await prompt(`Pick another subdomain (attempt ${attempt + 2}/5)`).catch(() => "");
      if (!alt) break;
      chosen = slugify(alt);
    }
  }
  throw new Error("Couldn't register a workers.dev subdomain after 5 attempts.");
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

function slugify(name: string, fallback = "oura-mcp"): string {
  // CF auth_domain rules: 3-63 chars, a-z / 0-9 / -, no leading/trailing -.
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return slug.length >= 3 ? slug : fallback;
}

async function ensureAccessEnabled(
  client: Cloudflare, accountId: string, accountName: string,
): Promise<void> {
  // Fresh accounts need a Zero Trust organization before we can touch the
  // Access APIs. Probe first — if Access is already enabled, we're done.
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of client.zeroTrust.access.applications.list({ account_id: accountId })) break;
    return;
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (!msg.includes("9999") && !msg.includes("not enabled")) throw e;
  }

  // Can't automate this: `POST /access/organizations` configures an existing
  // Zero Trust subscription but can't enroll an account in one. Fresh accounts
  // must hit the dashboard to sign up for the Free plan (credit card required,
  // never charged), which creates the organization server-side as a side
  // effect. After that the rest of setupZeroTrust works fine.
  const dashUrl = `https://dash.cloudflare.com/${accountId}/one/`;
  const suggested = slugify(accountName).split("-")[0]?.slice(0, 32) ?? "oura-mcp";
  warn("Cloudflare Zero Trust isn't enabled yet on this account.");
  console.log(`  It's ${c.bold("free")} for up to 50 users but has to be enabled in the dashboard.`);
  console.log(`  ${c.dim("(A credit card is required to sign up but the Free plan is never billed.)")}`);
  console.log(`  Opening ${c.cyan(dashUrl)}`);
  console.log(`  Suggested team name: ${c.cyan(suggested)} ${c.dim("(or your choice)")} → select the ${c.bold("Free")} plan → Finish.`);
  openBrowser(dashUrl);

  for (let attempt = 0; attempt < 3; attempt++) {
    await pressEnter("Press Enter once you've completed the Zero Trust setup...");
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.zeroTrust.access.applications.list({ account_id: accountId })) break;
      ok("Zero Trust enabled");
      return;
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (!msg.includes("9999") && !msg.includes("not enabled")) throw e;
      warn(`Zero Trust still not enabled (attempt ${attempt + 1}/3). Finish the wizard at ${c.cyan(dashUrl)} and press Enter.`);
    }
  }
  throw new Error(`Zero Trust still not enabled after 3 retries. Complete setup at ${dashUrl}, then re-run pnpm bootstrap.`);
}

async function setupZeroTrust(
  client: Cloudflare, accountId: string, accountName: string, workerDomain: string,
): Promise<{ clientId: string; clientSecret: string }> {
  step(10, "Cloudflare Access (Zero Trust) security");

  await ensureAccessEnabled(client, accountId, accountName);

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
  // Old token to delete *after* the replacement is in place. The only delete
  // operation this script performs — and only when we're replacing a token
  // with a fresh one that supersedes it (near-expiry rotation or a stale
  // same-named token whose secret we've lost).
  let supersededTokenId: string | undefined;

  // Important: `client_id` is the public identifier used in the CF-Access-Client-Id
  // header. The Access policy, however, references the service token by its
  // internal resource UUID (`id`), not its client_id. Getting this wrong yields
  // error 12130 "service token not found".
  if (savedClientId && savedClientSecret) {
    for await (const t of client.zeroTrust.access.serviceTokens.list({ account_id: accountId })) {
      if (t.client_id === savedClientId && t.id) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const expiresAt = (t as any).expires_at as string | undefined;
        const nearExpiry = expiresAt
          ? new Date(expiresAt).getTime() - Date.now() < 14 * 24 * 60 * 60 * 1000
          : false;
        if (nearExpiry) {
          const expDate = new Date(expiresAt!).toISOString().slice(0, 10);
          warn(`Saved service token expires on ${expDate} — rotating now`);
          info("Claude Desktop will get new credentials; quit + relaunch after this finishes");
          supersededTokenId = t.id; // delete after new token is saved
          // Leave svcId undefined so the creation branch below fires.
        } else {
          svcId = t.id;
          clientId = savedClientId;
          clientSecret = savedClientSecret;
          const expStr = expiresAt ? ` expires ${new Date(expiresAt).toISOString().slice(0, 10)}` : "";
          ok(`Reusing existing service token ${c.dim(`(${clientId.slice(0, 8)}…${expStr})`)}`);
        }
        break;
      }
    }
    if (!svcId && !savedClientId) {
      info("Saved service token no longer exists on Cloudflare — creating a new one");
    }
  }

  if (!svcId) {
    // ── Duration (expiry) ────────────────────────────────────────────────────
    // Cloudflare Access service tokens default to a 1-year expiry (other
    // options are 2y, 5y, 10y, or forever). We take the 1-year default — it's
    // already a reasonable blast-radius cap, and re-running `pnpm bootstrap`
    // within 14 days of expiry auto-rotates.
    info(`Service token will use Cloudflare's ${c.bold("1-year")} default expiry — re-run ${c.cyan("pnpm bootstrap")} before then to auto-rotate.`);

    // If a token with our preferred name already exists (e.g. from a previous
    // run whose client_secret we no longer have), mark it for deletion after
    // the replacement is provisioned. We can't reuse it — the secret is only
    // returned at creation time.
    for await (const t of client.zeroTrust.access.serviceTokens.list({ account_id: accountId })) {
      if (t.name === SERVICE_TOKEN_NAME && t.id && t.id !== supersededTokenId) {
        supersededTokenId = t.id;
        info(`Found existing "${SERVICE_TOKEN_NAME}" token — will replace it`);
        break;
      }
    }
    const svc = await client.zeroTrust.access.serviceTokens.create({
      account_id: accountId,
      name: SERVICE_TOKEN_NAME,
      // CF applies the 1-year default when `duration` is omitted.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    svcId = svc.id!;
    clientId = svc.client_id!;
    clientSecret = svc.client_secret!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const expiresAt = (svc as any).expires_at as string | undefined;
    const expStr = expiresAt ? `, expires ${new Date(expiresAt).toISOString().slice(0, 10)}` : ", no expiry";
    ok(`Service token created ${c.dim(`(${SERVICE_TOKEN_NAME}${expStr})`)}`);
    // Save the new creds *before* deleting the old token — if delete fails,
    // we've still got a working replacement committed to .dev.vars.
    saveDevVars({ CF_ACCESS_CLIENT_ID: clientId, CF_ACCESS_CLIENT_SECRET: clientSecret });
    // Note: the superseded token is deleted *after* the policy block below
    // reattaches to the new token — CF refuses to delete a token still
    // referenced by any policy (error 12139).
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

  // ── Clean up the superseded token (rotation path only) ────────────────────
  // Now that the new token is referenced by a policy, remove any stale
  // policies pointing at the old token, then delete the old token itself.
  // CF returns error 12139 if a token is still referenced by a policy, group,
  // or app SCIM config, so we unhook policies first.
  if (supersededTokenId) {
    try {
      for await (const p of client.zeroTrust.access.applications.policies.list(appId, { account_id: accountId })) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const include = (p as any).include as Array<{ service_token?: { token_id?: string } }> | undefined;
        if (p.id && include?.some((rule) => rule.service_token?.token_id === supersededTokenId)) {
          await client.zeroTrust.access.applications.policies.delete(appId, p.id, { account_id: accountId });
        }
      }
      await client.zeroTrust.access.serviceTokens.delete(supersededTokenId, { account_id: accountId });
      ok("Removed superseded service token");
    } catch (e) {
      warn(`Could not delete old service token (${(e as Error).message}) — safe to remove manually in the Cloudflare dashboard`);
    }
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

  // Belt-and-suspenders: briefly snapshot the existing config so a crash
  // mid-write can't leave it truncated. Removed on successful write.
  const bak = `${CLAUDE_CFG_PATH}.bak`;
  if (exists) {
    fs.copyFileSync(CLAUDE_CFG_PATH, bak);
  } else {
    fs.mkdirSync(path.dirname(CLAUDE_CFG_PATH), { recursive: true });
  }

  fs.writeFileSync(CLAUDE_CFG_PATH, JSON.stringify(config, null, 2) + "\n");
  if (exists && fs.existsSync(bak)) fs.unlinkSync(bak);
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
  banner("oura-mcp-server — Bootstrap", [
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
    console.log("  Cancelled. Run again any time with `pnpm bootstrap`.");
    return;
  }

  // 1. Auth
  const { client, apiToken } = await ensureApiToken();

  // 2. Account
  const account = await pickAccount(client);

  // 3. workers.dev subdomain
  const subdomain = await ensureWorkersSubdomain(client, account.id, account.name);
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

  // 10. Zero Trust
  const { clientId, clientSecret } = await setupZeroTrust(client, account.id, account.name, workerDomain);

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
