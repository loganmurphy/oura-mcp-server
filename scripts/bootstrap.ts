import Cloudflare from "cloudflare";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";

import {
  banner, c, confirm, closePrompts, info, ok, pick,
  prompt, promptHidden, pressEnter, step, warn,
} from "./prompts";
import { claudeCfgPath, loadDevVars, saveDevVars, slugify } from "./utils";

const WORKER_NAME = "oura-mcp-server";
const D1_NAME     = "oura-cache";
const KV_NAME     = "oura-oauth";
const OURA_PAT_URL = "https://cloud.ouraring.com/personal-access-tokens";
const OURA_SECRET_NAME = "OURA_API_TOKEN";
const AUTH_SECRET_NAME = "MCP_AUTH_PASSWORD";

const CF_SIGNUP_URL    = "https://dash.cloudflare.com/sign-up";
const CF_API_TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

const CLAUDE_CFG_PATH     = claudeCfgPath();
const DEV_VARS_PATH       = path.resolve(process.cwd(), ".dev.vars");
const WRANGLER_JSONC_PATH = path.resolve(process.cwd(), "wrangler.jsonc");
const WRANGLER_EXAMPLE_PATH = path.resolve(process.cwd(), "wrangler.example.jsonc");
const SCHEMA_PATH         = path.resolve(process.cwd(), "migrations/001_init.sql");

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? `open "${url}"` :
    process.platform === "win32"  ? `start "" "${url}"` :
    `xdg-open "${url}"`;
  try { execSync(cmd, { stdio: "ignore" }); } catch { /* non-fatal */ }
}

const REQUIRED_SCOPES: ReadonlyArray<[string, string]> = [
  ["Account → Account Settings → Read",    "list accounts, detect the workers.dev subdomain"],
  ["Account → Workers Scripts → Edit",     "deploy the Worker and set its secrets"],
  ["Account → Workers KV Storage → Edit",  "create the OAuth token storage namespace"],
  ["Account → D1 → Edit",                  "create the cache database and apply migrations"],
  ["User → User Details → Read",           "verify the token itself hasn't been revoked"],
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

  const saved = loadDevVars(DEV_VARS_PATH)["CLOUDFLARE_API_TOKEN"] ?? process.env["CLOUDFLARE_API_TOKEN"];
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
      const current = loadDevVars(DEV_VARS_PATH);
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
  saveDevVars(DEV_VARS_PATH, { CLOUDFLARE_API_TOKEN: apiToken });
  return { client, apiToken };
}

async function pickAccount(client: Cloudflare): Promise<{ id: string; name: string }> {
  step(2, "Select Cloudflare account");

  const accounts: { id: string; name: string }[] = [];
  for await (const a of client.accounts.list({})) {
    if (a.id && a.name) accounts.push({ id: a.id, name: a.name });
  }
  if (accounts.length === 0) throw new Error("No Cloudflare accounts found");

  const saved = loadDevVars(DEV_VARS_PATH)["CLOUDFLARE_ACCOUNT_ID"] ?? process.env["CLOUDFLARE_ACCOUNT_ID"];
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

  saveDevVars(DEV_VARS_PATH, { CLOUDFLARE_ACCOUNT_ID: selected.id });
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
      saveDevVars(DEV_VARS_PATH, { WORKER_SUBDOMAIN: sub });
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
      saveDevVars(DEV_VARS_PATH, { WORKER_SUBDOMAIN: sub });
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

async function ensureKvNamespace(client: Cloudflare, accountId: string): Promise<string> {
  step(5, "KV namespace for OAuth tokens");

  // The library requires a binding named OAUTH_KV — the namespace title is cosmetic.
  for await (const ns of client.kv.namespaces.list({ account_id: accountId })) {
    if ((ns as { title?: string }).title === KV_NAME && ns.id) {
      ok(`Found existing KV namespace ${c.cyan(KV_NAME)}`);
      return ns.id;
    }
  }

  info(`Creating KV namespace "${KV_NAME}"...`);
  const created = await client.kv.namespaces.create({ account_id: accountId, title: KV_NAME });
  const id = created.id;
  if (!id) throw new Error("KV create returned no id");
  ok(`Created KV namespace ${c.cyan(KV_NAME)} ${c.dim(`(${id})`)}`);
  return id;
}

function writeWranglerConfig(d1DatabaseId: string, kvNamespaceId: string): void {
  step(6, "Local Worker config (wrangler.jsonc)");

  if (!fs.existsSync(WRANGLER_EXAMPLE_PATH)) {
    throw new Error(`Missing ${WRANGLER_EXAMPLE_PATH}`);
  }
  const template = fs.readFileSync(WRANGLER_EXAMPLE_PATH, "utf8");
  const out = template
    .replace(/YOUR_DATABASE_ID/g, d1DatabaseId)
    .replace(/YOUR_KV_NAMESPACE_ID/g, kvNamespaceId);
  fs.writeFileSync(WRANGLER_JSONC_PATH, out);
  ok(`Wrote wrangler.jsonc with database_id ${c.dim(d1DatabaseId)} and kv_id ${c.dim(kvNamespaceId)}`);
}

function applyD1Schema(apiToken: string, accountId: string): void {
  step(7, "D1 schema migration");

  if (!fs.existsSync(SCHEMA_PATH)) throw new Error(`Missing schema file ${SCHEMA_PATH}`);
  info("Applying migrations/001_init.sql...");
  const result = spawnSync(
    "npx", ["wrangler", "d1", "execute", D1_NAME, "--remote", "--file", SCHEMA_PATH],
    {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, CLOUDFLARE_API_TOKEN: apiToken, CLOUDFLARE_ACCOUNT_ID: accountId },
    },
  );
  if (result.status !== 0) throw new Error("D1 schema migration failed");
  ok("Schema applied");
}

async function ensureOuraToken(): Promise<string> {
  step(8, "Oura Personal Access Token");

  const existing = loadDevVars(DEV_VARS_PATH)[OURA_SECRET_NAME];
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
  saveDevVars(DEV_VARS_PATH, { [OURA_SECRET_NAME]: token });
  ok("Token saved to .dev.vars");
  return token;
}

async function promptMcpPassword(): Promise<string> {
  step(9, "MCP server password");

  const existing = loadDevVars(DEV_VARS_PATH)[AUTH_SECRET_NAME];
  if (existing) {
    const reuse = await confirm("Found existing MCP password in .dev.vars — use it?", true);
    if (reuse) {
      ok("Reusing existing MCP password");
      return existing;
    }
  }

  console.log("  This password protects your MCP server from unauthorized access.");
  console.log("  Claude Desktop will prompt you to enter it once per auth session.");
  console.log(`  ${c.dim("(Stored as a Worker secret — never in the codebase or logs.)")}\n`);

  const password = await promptHidden("Choose a password (hidden)");
  if (!password) throw new Error("Password cannot be empty");
  saveDevVars(DEV_VARS_PATH, { [AUTH_SECRET_NAME]: password });
  ok("Password saved to .dev.vars");
  return password;
}

function deployWorker(apiToken: string, accountId: string): void {
  step(10, "Deploy Worker to Cloudflare");

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

async function setWorkerSecrets(
  client: Cloudflare, accountId: string,
  ouraToken: string, mcpPassword: string,
): Promise<void> {
  step(11, "Set Worker secrets");

  await client.workers.scripts.secrets.update(WORKER_NAME, {
    account_id: accountId,
    name: OURA_SECRET_NAME,
    text: ouraToken,
    type: "secret_text",
  });
  ok(`Secret ${c.cyan(OURA_SECRET_NAME)} set`);

  await client.workers.scripts.secrets.update(WORKER_NAME, {
    account_id: accountId,
    name: AUTH_SECRET_NAME,
    text: mcpPassword,
    type: "secret_text",
  });
  ok(`Secret ${c.cyan(AUTH_SECRET_NAME)} set`);
}

interface McpRemoteEntry {
  command: string;
  args: string[];
}

async function mergeClaudeDesktopConfig(workerDomain: string): Promise<boolean> {
  step(12, "Claude Desktop config");

  const build = (endpoint: string): McpRemoteEntry => ({
    command: "npx",
    args: ["-y", "mcp-remote", `https://${workerDomain}/mcp/${endpoint}`],
  });

  const newEntries = {
    "oura-sleep":    build("sleep"),
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
      const proceed = await confirm("Skip this step? You can paste the snippet manually later.", true);
      if (proceed) {
        printManualSnippet(workerDomain);
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

function printManualSnippet(workerDomain: string): void {
  console.log(`
  Add these two entries under "mcpServers" in:
    ${c.cyan(CLAUDE_CFG_PATH)}

    "oura-sleep": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://${workerDomain}/mcp/sleep"]
    },
    "oura-activity": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://${workerDomain}/mcp/activity"]
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
    "  • A KV namespace for OAuth tokens",
    "  • A Worker that talks to the Oura API",
    "",
    "Access is protected by a password you choose —",
    "Claude Desktop will ask for it once per auth session.",
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
  let existingKv = false;
  for await (const ns of client.kv.namespaces.list({ account_id: account.id })) {
    if ((ns as { title?: string }).title === KV_NAME) { existingKv = true; break; }
  }
  const claudeCfgExists = fs.existsSync(CLAUDE_CFG_PATH);

  console.log();
  banner("Ready to provision", [
    `Cloudflare account:  ${c.cyan(account.name)} ${c.dim(`(${account.id})`)}`,
    `Worker URL:          ${c.cyan(`https://${workerDomain}`)}`,
    "",
    `${c.bold("The following will happen:")}`,
    `  • D1 database "${D1_NAME}" — ${existingD1 ? c.dim("reuse existing") : c.green("create new")}`,
    `  • KV namespace "${KV_NAME}" — ${existingKv ? c.dim("reuse existing") : c.green("create new")}`,
    `  • Apply D1 schema (idempotent)`,
    `  • Deploy Worker "${WORKER_NAME}" (create on first run, update otherwise)`,
    `  • Set OURA_API_TOKEN + MCP_AUTH_PASSWORD secrets on the Worker`,
    `  • ${claudeCfgExists ? "Update" : "Create"} ${c.cyan(CLAUDE_CFG_PATH)}`,
    `    ${c.dim("(other MCP servers in this file are preserved)")}`,
  ]);
  if (!(await confirm("Proceed?", true))) {
    console.log("  Cancelled — no changes were made.");
    return;
  }

  const dbId  = await ensureD1(client, account.id);
  const kvId  = await ensureKvNamespace(client, account.id);
  writeWranglerConfig(dbId, kvId);
  applyD1Schema(apiToken, account.id);
  const ouraToken = await ensureOuraToken();
  const mcpPassword = await promptMcpPassword();
  deployWorker(apiToken, account.id);
  await setWorkerSecrets(client, account.id, ouraToken, mcpPassword);
  const configUpdated = await mergeClaudeDesktopConfig(workerDomain);

  console.log();
  banner("✅  Setup complete!", [
    `Worker:    ${c.cyan(`https://${workerDomain}`)}`,
    "",
    configUpdated
      ? `${c.bold("Next:")} quit Claude Desktop fully (Cmd+Q) and reopen,`
      : `${c.bold("Next:")} add the snippet above to claude_desktop_config.json,`,
    "       then ask: \"What was my sleep score last night?\"",
    "",
    `${c.dim("First run: Claude Desktop will open a browser to enter your MCP password.")}`,
    `${c.dim("After that, the token lasts 30 days before re-auth.")}`,
  ]);
}

main()
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n${c.red("✗ Setup failed:")} ${msg}`);
    process.exit(1);
  })
  .finally(() => closePrompts());
