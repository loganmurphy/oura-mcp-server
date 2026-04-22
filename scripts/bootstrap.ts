import Cloudflare from "cloudflare";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";

import {
  banner, c, confirm, closePrompts, info, ok, pick,
  prompt, promptHidden, pressEnter, step, warn,
} from "./prompts";

const WORKER_NAME = "oura-mcp-server";
const D1_NAME = "oura-cache";
const ACCESS_APP_NAME = "oura-mcp-server";
const SERVICE_TOKEN_NAME = "oura-mcp-server-claude";
const OURA_PAT_URL = "https://cloud.ouraring.com/personal-access-tokens";
const OURA_SECRET_NAME = "OURA_API_TOKEN";

const CF_SIGNUP_URL = "https://dash.cloudflare.com/sign-up";
const CF_API_TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

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

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? `open "${url}"` :
    process.platform === "win32"  ? `start "" "${url}"` :
    `xdg-open "${url}"`;
  try { execSync(cmd, { stdio: "ignore" }); } catch { /* non-fatal */ }
}

// Wrangler's public OAuth client doesn't grant the Access scopes we need and
// can't mint scoped tokens from its session, so we ask for a manually-created
// API token once and reuse it for both SDK calls and the wrangler CLI.
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

  try {
    const res = await client.workers.subdomains.get({ account_id: accountId });
    const sub = (res as { subdomain?: string }).subdomain;
    if (sub) {
      ok(`workers.dev subdomain: ${c.cyan(`${sub}.workers.dev`)}`);
      saveDevVars({ WORKER_SUBDOMAIN: sub });
      return sub;
    }
  } catch (e) {
    // 10007 = "subdomain not registered" → fall through to creation.
    if (!(e as Error).message?.includes("10007")) throw e;
  }

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
  // workers.dev subdomain rules: 3-63 chars, a-z / 0-9 / -, no leading/trailing -.
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return slug.length >= 3 ? slug : fallback;
}

async function ensureAccessEnabled(client: Cloudflare, accountId: string): Promise<void> {
  // Fresh accounts need a Zero Trust organization before Access APIs work.
  // Probe first — if it's already there we're done.
  const probe = async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.zeroTrust.access.applications.list({ account_id: accountId })) break;
      return true;
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (!msg.includes("9999") && !msg.includes("not enabled")) throw e;
      return false;
    }
  };

  if (await probe()) return;

  // Zero Trust enrollment can't be automated — the user has to sign up for
  // the Free plan in the dashboard. It requires a credit card but CF never
  // bills the Free tier. Takes a couple of minutes.
  const dashUrl = `https://dash.cloudflare.com/${accountId}/one/`;
  info("Cloudflare Zero Trust isn't enabled yet — you'll need to sign up for the Free plan.");
  console.log(`  ${c.dim("It's free for up to 50 users. Requires a credit card for signup but is never billed.")}`);
  console.log(`  ${c.dim("Takes ~2 min: pick a team name → choose Free plan → add billing info → Finish.")}`);
  openBrowser(dashUrl);

  for (let attempt = 0; attempt < 3; attempt++) {
    await pressEnter("Press Enter once you've completed the Zero Trust signup...");
    if (await probe()) { ok("Zero Trust enabled"); return; }
    warn(`Zero Trust still not enabled (attempt ${attempt + 1}/3). Finish the wizard at ${c.cyan(dashUrl)}.`);
  }
  throw new Error(`Zero Trust still not enabled after 3 checks. Complete signup at ${dashUrl}, then re-run pnpm bootstrap.`);
}

async function setupZeroTrust(
  client: Cloudflare, accountId: string, workerDomain: string,
): Promise<{ clientId: string; clientSecret: string }> {
  step(10, "Cloudflare Access (Zero Trust) security");

  await ensureAccessEnabled(client, accountId);

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

  // client_secret is only returned on create — so reuse requires both the saved
  // secret locally and a matching token still present on Cloudflare.
  const saved = loadDevVars();
  const savedClientId = saved["CF_ACCESS_CLIENT_ID"];
  const savedClientSecret = saved["CF_ACCESS_CLIENT_SECRET"];

  let svcId: string | undefined;
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  // Set when we need to replace a token (near-expiry rotation or stale same-named
  // token whose secret we've lost). Deleted only after the replacement is in place.
  let supersededTokenId: string | undefined;

  // `client_id` is the public header value; the Access policy references the
  // token by its internal `id` instead. Mixing them up yields error 12130.
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
    // CF service tokens default to a 1-year expiry; we accept it. Re-running
    // bootstrap within 14 days of expiry auto-rotates.
    info(`Service token will use Cloudflare's ${c.bold("1-year")} default expiry — re-run ${c.cyan("pnpm bootstrap")} before then to auto-rotate.`);

    // Stale same-named token from a past run whose secret we've lost — mark for
    // deletion so we can create a fresh one.
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
    // Save before deleting the old token so a delete failure still leaves us with
    // a working replacement in .dev.vars. The actual delete happens after the
    // policy block swaps to the new token — CF refuses (error 12139) otherwise.
    saveDevVars({ CF_ACCESS_CLIENT_ID: clientId, CF_ACCESS_CLIENT_SECRET: clientSecret });
  }

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
    // SDK type defs are incomplete for policy create, so cast.
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

  // Unhook any policies still referencing the old token before deleting it
  // (error 12139 otherwise).
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

  // Secrets live in `env` (mcp-remote expands ${VAR} in --header values) rather
  // than inline in `args`, so they don't show up in `ps` output.
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

  // Snapshot so a crash mid-write can't truncate the existing config.
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

  const { client, apiToken } = await ensureApiToken();
  const account = await pickAccount(client);
  const subdomain = await ensureWorkersSubdomain(client, account.id, account.name);
  const workerDomain = `${WORKER_NAME}.${subdomain}.workers.dev`;

  // Everything above is read-only (or already prompted). Show the concrete plan
  // before we start creating resources, deploying, or editing the Claude config.
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

  const dbId = await ensureD1(client, account.id);
  writeWranglerConfig(dbId);
  await applyD1Schema(client, account.id, dbId);
  const ouraToken = await ensureOuraToken();
  deployWorker(apiToken, account.id);
  await setWorkerSecret(client, account.id, ouraToken);
  const { clientId, clientSecret } = await setupZeroTrust(client, account.id, workerDomain);
  const configUpdated = mergeClaudeDesktopConfig(workerDomain, clientId, clientSecret);

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
