import Cloudflare from "cloudflare";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import {
  banner, c, confirm, closePrompts, info, ok, pick,
  prompt, promptHidden, pressEnter, step, warn,
} from "./prompts";
import { claudeCfgPath, loadDevVars, saveDevVars, slugify } from "./utils";

const WORKER_NAME      = "oura-mcp-server";
const D1_NAME          = "oura-cache";
const KV_NAME          = "oura-oauth";
const OURA_PAT_URL     = "https://cloud.ouraring.com/personal-access-tokens";
const OURA_SECRET_NAME = "OURA_API_TOKEN";
const AUTH_SECRET_NAME = "MCP_AUTH_PASSWORD";

const CLAUDE_CFG_PATH       = claudeCfgPath();
const DEV_VARS_PATH         = path.resolve(process.cwd(), ".dev.vars");
const WRANGLER_JSONC_PATH   = path.resolve(process.cwd(), "wrangler.jsonc");
const WRANGLER_EXAMPLE_PATH = path.resolve(process.cwd(), "wrangler.example.jsonc");
const SCHEMA_PATH           = path.resolve(process.cwd(), "migrations/001_init.sql");

// ── Cloudflare auth via wrangler OAuth ────────────────────────────────────────
//
// `wrangler login` runs a standard CF OAuth browser flow and caches the
// resulting token at ~/.wrangler/config/default.toml. We read it from
// there so we can also drive the CF SDK (for resource listing/creation),
// which wrangler's CLI doesn't expose for every operation we need.
//
// Priority: CLOUDFLARE_API_TOKEN env var → wrangler config file.
// The env var fallback keeps CI and manual-token users working unchanged.

function extractWranglerToken(): string | undefined {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;

  const configPath = path.join(os.homedir(), ".wrangler", "config", "default.toml");
  if (!fs.existsSync(configPath)) return undefined;
  try {
    const toml = fs.readFileSync(configPath, "utf8");
    // `wrangler login`      → writes oauth_token
    // `wrangler login --api-key` → writes api_token
    return (
      toml.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1] ??
      toml.match(/^api_token\s*=\s*"([^"]+)"/m)?.[1]
    );
  } catch {
    return undefined;
  }
}

async function ensureWranglerAuth(): Promise<{ client: Cloudflare }> {
  step(1, "Connect to Cloudflare");

  // Fast path: already logged in (or CLOUDFLARE_API_TOKEN is set in env)
  const existingToken = extractWranglerToken();
  if (existingToken) {
    const client = new Cloudflare({ apiToken: existingToken });
    try {
      const me = await client.user.get();
      const email = (me as { email?: string }).email ?? "unknown";
      ok(`Already signed in as ${c.cyan(email)}`);
      return { client };
    } catch {
      // Token stale — fall through to login
      warn("Saved credentials are no longer valid — signing in again...");
    }
  }

  // Trigger browser-based OAuth flow
  info("Opening Cloudflare sign-in in your browser...");
  console.log(`  ${c.dim("No account yet? You can create a free one during this step.")}`);
  const login = spawnSync("npx", ["wrangler", "login"], { stdio: "inherit" });
  if (login.status !== 0) throw new Error("`wrangler login` was cancelled or failed");

  const token = extractWranglerToken();
  if (!token) {
    throw new Error(
      "Could not read auth token from wrangler config after login.\n" +
      `  Fallback: set ${c.cyan("CLOUDFLARE_API_TOKEN")} in your environment and re-run.`,
    );
  }

  const client = new Cloudflare({ apiToken: token });
  try {
    const me = await client.user.get();
    const email = (me as { email?: string }).email ?? "unknown";
    ok(`Signed in as ${c.cyan(email)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not verify Cloudflare credentials: ${msg}`);
  }

  return { client };
}

// ── Account / subdomain ───────────────────────────────────────────────────────

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
      info(`Using saved account — ${c.cyan(match.name)}`);
      console.log(`  ${c.dim("(Run `pnpm reset` to clear saved state and switch accounts.)")}`);
      return match;
    }
    warn(`Saved account ID not found — prompting below.`);
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
    if (!(e as Error).message?.includes("10007")) throw e;
  }

  info("No workers.dev subdomain yet — creating one.");
  let chosen = slugify(accountName);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await client.workers.subdomains.update({ account_id: accountId, subdomain: chosen });
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

// ── Resources ─────────────────────────────────────────────────────────────────

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

  if (!fs.existsSync(WRANGLER_EXAMPLE_PATH)) throw new Error(`Missing ${WRANGLER_EXAMPLE_PATH}`);
  const out = fs.readFileSync(WRANGLER_EXAMPLE_PATH, "utf8")
    .replace(/YOUR_DATABASE_ID/g, d1DatabaseId)
    .replace(/YOUR_KV_NAMESPACE_ID/g, kvNamespaceId);
  fs.writeFileSync(WRANGLER_JSONC_PATH, out);
  ok(`Wrote wrangler.jsonc ${c.dim(`(D1: ${d1DatabaseId.slice(0, 8)}… KV: ${kvNamespaceId.slice(0, 8)}…)`)}`);
}

function applyD1Schema(accountId: string): void {
  step(7, "D1 schema migration");

  if (!fs.existsSync(SCHEMA_PATH)) throw new Error(`Missing schema file ${SCHEMA_PATH}`);
  info("Applying migrations/001_init.sql...");
  const result = spawnSync(
    "npx", ["wrangler", "d1", "execute", D1_NAME, "--remote", "--file", SCHEMA_PATH],
    { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId } },
  );
  if (result.status !== 0) throw new Error("D1 schema migration failed");
  ok("Schema applied");
}

// ── Secrets ───────────────────────────────────────────────────────────────────

async function ensureOuraToken(): Promise<string> {
  step(8, "Oura Personal Access Token");

  const existing = loadDevVars(DEV_VARS_PATH)[OURA_SECRET_NAME];
  if (existing) {
    if (await confirm("Found existing Oura token in .dev.vars — use it?", true)) {
      ok("Reusing existing Oura token");
      return existing;
    }
  }

  console.log("  This connects the server to your Oura Ring data.");
  console.log(`  Token page: ${c.cyan(OURA_PAT_URL)}\n`);

  if (!(await confirm("Do you already have an Oura Personal Access Token?", false))) {
    info("Opening the Oura token page in your browser...");
    const cmd = process.platform === "darwin" ? `open "${OURA_PAT_URL}"`
      : process.platform === "win32" ? `start "" "${OURA_PAT_URL}"`
      : `xdg-open "${OURA_PAT_URL}"`;
    try { require("child_process").execSync(cmd, { stdio: "ignore" }); } catch { /* non-fatal */ }
    console.log("  Click 'Create New Personal Access Token', name it, copy it.");
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
    if (await confirm("Found existing MCP password in .dev.vars — use it?", true)) {
      ok("Reusing existing MCP password");
      return existing;
    }
  }

  console.log("  This password protects your MCP server from unauthorized access.");
  console.log("  Claude Desktop prompts for it once; the token then lasts 30 days.");
  console.log(`  ${c.dim("Stored as a Worker secret — never in code or logs.")}\n`);

  const password = await promptHidden("Choose a password (hidden)");
  if (!password) throw new Error("Password cannot be empty");
  saveDevVars(DEV_VARS_PATH, { [AUTH_SECRET_NAME]: password });
  ok("Password saved to .dev.vars");
  return password;
}

// ── Deployment ────────────────────────────────────────────────────────────────

function deployWorker(accountId: string): void {
  step(10, "Deploy Worker to Cloudflare");

  info("Running `wrangler deploy`... (first deploy takes ~20s)");
  // wrangler uses its own cached OAuth token — no CLOUDFLARE_API_TOKEN needed.
  const result = spawnSync("npx", ["wrangler", "deploy"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  });
  if (result.status !== 0) throw new Error(`wrangler deploy failed (exit ${result.status})`);
  ok("Worker deployed");
}

async function setWorkerSecrets(
  client: Cloudflare, accountId: string,
  ouraToken: string, mcpPassword: string,
): Promise<void> {
  step(11, "Set Worker secrets");

  for (const [name, value] of [
    [OURA_SECRET_NAME, ouraToken],
    [AUTH_SECRET_NAME, mcpPassword],
  ] as const) {
    await client.workers.scripts.secrets.update(WORKER_NAME, {
      account_id: accountId,
      name,
      text: value,
      type: "secret_text",
    });
    ok(`Secret ${c.cyan(name)} set`);
  }
}

// ── Claude Desktop config ─────────────────────────────────────────────────────

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
      if (await confirm("Skip this step? You can paste the snippet manually later.", true)) {
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
    console.log(`  Preserving ${otherServers.length} other MCP server(s): ${c.dim(otherServers.join(", "))}`);
  }
  if (existingServers["oura-sleep"] || existingServers["oura-activity"]) {
    console.log(`  ${c.dim("Existing oura-sleep / oura-activity entries will be updated.")}`);
  }

  config.mcpServers = { ...existingServers, ...newEntries };

  const bak = `${CLAUDE_CFG_PATH}.bak`;
  if (exists) fs.copyFileSync(CLAUDE_CFG_PATH, bak);
  else fs.mkdirSync(path.dirname(CLAUDE_CFG_PATH), { recursive: true });

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

// ── Main ──────────────────────────────────────────────────────────────────────

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
    "Access is protected by a password you choose.",
    "",
    `${c.bold("You'll need:")}`,
    `  • A ${c.cyan("Cloudflare account")} — free, sign up during the login step`,
    `  • An ${c.cyan("Oura Ring")} + Personal Access Token`,
    "",
    `Estimated time: ${c.bold("~2 minutes")}`,
  ]);

  if (!(await confirm("Ready to start?", true))) {
    console.log("  Cancelled. Run again any time with `pnpm bootstrap`.");
    return;
  }

  const { client } = await ensureWranglerAuth();
  const account    = await pickAccount(client);
  const subdomain  = await ensureWorkersSubdomain(client, account.id, account.name);
  const workerDomain = `${WORKER_NAME}.${subdomain}.workers.dev`;

  // Read-only checks done — show plan before touching anything.
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
    `  • Set OURA_API_TOKEN + MCP_AUTH_PASSWORD secrets`,
    `  • ${claudeCfgExists ? "Update" : "Create"} ${c.cyan(CLAUDE_CFG_PATH)}`,
    `    ${c.dim("(other MCP servers preserved)")}`,
  ]);
  if (!(await confirm("Proceed?", true))) {
    console.log("  Cancelled — no changes were made.");
    return;
  }

  const dbId        = await ensureD1(client, account.id);
  const kvId        = await ensureKvNamespace(client, account.id);
  writeWranglerConfig(dbId, kvId);
  applyD1Schema(account.id);
  const ouraToken   = await ensureOuraToken();
  const mcpPassword = await promptMcpPassword();
  deployWorker(account.id);
  await setWorkerSecrets(client, account.id, ouraToken, mcpPassword);
  const configUpdated = await mergeClaudeDesktopConfig(workerDomain);

  console.log();
  banner("✅  Setup complete!", [
    `Worker:  ${c.cyan(`https://${workerDomain}`)}`,
    "",
    configUpdated
      ? `${c.bold("Next:")} quit Claude Desktop fully (Cmd+Q) and reopen,`
      : `${c.bold("Next:")} add the snippet above to claude_desktop_config.json,`,
    "       then ask: \"What was my sleep score last night?\"",
    "",
    `${c.dim("First run: Claude Desktop opens a browser for your MCP password.")}`,
    `${c.dim("Token lasts 30 days — then a quick browser re-auth.")}`,
  ]);
}

main()
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n${c.red("✗ Setup failed:")} ${msg}`);
    process.exit(1);
  })
  .finally(() => closePrompts());
