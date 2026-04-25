import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import {
  banner, c, confirm, closePrompts, info, ok, pick,
  promptHidden, pressEnter, step, warn,
} from "./prompts";
import { copyToClipboard, loadDevVars, openBrowser, saveDevVars } from "./utils";

const WORKER_NAME      = "oura-mcp-server";
const D1_NAME          = "oura-cache";
const KV_NAME          = "oura-oauth";
const OURA_PAT_URL     = "https://cloud.ouraring.com/personal-access-tokens";
const OURA_SECRET_NAME = "OURA_API_TOKEN";
const AUTH_SECRET_NAME = "MCP_AUTH_PASSWORD";

const DEV_VARS_PATH         = path.resolve(process.cwd(), ".dev.vars");
// Script-only state (CF account ID) lives here rather than .dev.vars
// so wrangler never picks it up as Worker bindings and generates spurious types.
const BOOTSTRAP_STATE_PATH  = path.resolve(process.cwd(), ".bootstrap-state");
const WRANGLER_JSONC_PATH   = path.resolve(process.cwd(), "wrangler.jsonc");
const WRANGLER_EXAMPLE_PATH = path.resolve(process.cwd(), "wrangler.example.jsonc");
const SCHEMA_PATH           = path.resolve(process.cwd(), "migrations/001_init.sql");

// ── Cloudflare auth + account selection via wrangler CLI ─────────────────────
//
// All Cloudflare operations go through wrangler — no separate SDK client.
// `wrangler login` handles the OAuth browser flow and caches credentials.
// We run `wrangler whoami` to verify auth and parse the account table for IDs.

function wranglerWhoami(): { email: string; accounts: { id: string; name: string }[] } | null {
  const result = spawnSync("npx", ["wrangler", "whoami"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  const out = (result.stdout ?? "") + (result.stderr ?? "");
  if (result.status !== 0 || out.includes("not authenticated")) return null;

  const email = out.match(/associated with the email\s+(\S+)/)?.[1] ?? "unknown";
  // Parse table rows: │ Account Name │ Account ID (32 hex chars) │
  const accounts: { id: string; name: string }[] = [];
  for (const m of out.matchAll(/│\s+(.+?)\s+│\s+([0-9a-f]{32})\s+│/g)) {
    accounts.push({ name: m[1]!.trim(), id: m[2]!.trim() });
  }
  return { email, accounts };
}

async function ensureWranglerAuth(): Promise<{ accountId: string; accountName: string }> {
  step(1, "Connect to Cloudflare");

  // Fast path: already logged in
  let whoami = wranglerWhoami();
  if (whoami) {
    ok(`Already signed in as ${c.cyan(whoami.email)}`);
  } else {
    info("Opening Cloudflare sign-in in your browser...");
    console.log(`  ${c.dim("No account yet? You can create a free one during this step.")}`);
    const login = spawnSync("npx", ["wrangler", "login"], { stdio: "inherit" });
    if (login.status !== 0) throw new Error("`wrangler login` was cancelled or failed");

    whoami = wranglerWhoami();
    if (!whoami) throw new Error(
      "Could not verify Cloudflare credentials after login.\n" +
      `  Fallback: set ${c.cyan("CLOUDFLARE_API_TOKEN")} in your environment and re-run.`,
    );
    ok(`Signed in as ${c.cyan(whoami.email)}`);
  }

  return pickAccount(whoami.accounts);
}

async function pickAccount(
  accounts: { id: string; name: string }[],
): Promise<{ accountId: string; accountName: string }> {
  step(2, "Select Cloudflare account");

  if (accounts.length === 0) throw new Error("No Cloudflare accounts found — try `wrangler login` again");

  const saved = loadDevVars(BOOTSTRAP_STATE_PATH)["CLOUDFLARE_ACCOUNT_ID"] ?? process.env["CLOUDFLARE_ACCOUNT_ID"];
  if (saved) {
    const match = accounts.find((a) => a.id === saved);
    if (match) {
      info(`Using saved account — ${c.cyan(match.name)}`);
      console.log(`  ${c.dim("(Run `pnpm reset` to clear saved state and switch accounts.)")}`);
      return { accountId: match.id, accountName: match.name };
    }
    warn("Saved account ID not found — prompting below.");
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

  saveDevVars(BOOTSTRAP_STATE_PATH, { CLOUDFLARE_ACCOUNT_ID: selected.id });
  return { accountId: selected.id, accountName: selected.name };
}

// ── Resources ─────────────────────────────────────────────────────────────────

function ensureD1(accountId: string): string {
  step(4, "D1 cache database");

  // Check for existing database
  const listResult = spawnSync("npx", ["wrangler", "d1", "list", "--json"], {
    stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  });
  if (listResult.status === 0 && listResult.stdout?.trim()) {
    const dbs = JSON.parse(listResult.stdout) as { uuid: string; name: string }[];
    const existing = dbs.find((db) => db.name === D1_NAME);
    if (existing?.uuid) {
      ok(`Found existing D1 database ${c.cyan(D1_NAME)}`);
      return existing.uuid;
    }
  }

  info(`Creating D1 database "${D1_NAME}"...`);
  const createResult = spawnSync("npx", ["wrangler", "d1", "create", D1_NAME], {
    stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  });
  if (createResult.status !== 0) throw new Error(`D1 create failed: ${createResult.stderr?.trim()}`);

  const uuid = JSON.parse(createResult.stdout.match(/\{[\s\S]*\}/)?.[0] ?? "{}").uuid as string | undefined;
  if (!uuid) throw new Error("D1 create succeeded but couldn't parse the database UUID");
  ok(`Created D1 database ${c.cyan(D1_NAME)} ${c.dim(`(${uuid})`)}`);
  return uuid;
}

function ensureKvNamespace(accountId: string): string {
  step(5, "KV namespace for OAuth tokens");

  // Check for existing namespace
  const listResult = spawnSync("npx", ["wrangler", "kv", "namespace", "list"], {
    stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  });
  if (listResult.status === 0 && listResult.stdout?.trim()) {
    const namespaces = JSON.parse(listResult.stdout) as { id: string; title: string }[];
    const existing = namespaces.find((ns) => ns.title === KV_NAME);
    if (existing?.id) {
      ok(`Found existing KV namespace ${c.cyan(KV_NAME)}`);
      return existing.id;
    }
  }

  info(`Creating KV namespace "${KV_NAME}"...`);
  const createResult = spawnSync("npx", ["wrangler", "kv", "namespace", "create", KV_NAME], {
    stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  });
  if (createResult.status !== 0) throw new Error(`KV create failed: ${createResult.stderr?.trim()}`);

  // Output contains a JSON fragment: { "binding": "...", "id": "..." }
  const id = createResult.stdout.match(/"id":\s*"([^"]+)"/)?.[1];
  if (!id) throw new Error("KV create succeeded but couldn't parse the namespace ID");
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
    openBrowser(OURA_PAT_URL);
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
  console.log("  You'll enter it once when connecting Claude; the token lasts 30 days.");
  console.log(`  ${c.dim("Stored as a Worker secret — never in code or logs.")}\n`);

  const password = await promptHidden("Choose a password (hidden)");
  if (!password) throw new Error("Password cannot be empty");
  saveDevVars(DEV_VARS_PATH, { [AUTH_SECRET_NAME]: password });
  ok("Password saved to .dev.vars");
  return password;
}

// ── Deployment ────────────────────────────────────────────────────────────────

function deployWorker(accountId: string): string {
  step(10, "Deploy Worker to Cloudflare");

  info("Running `wrangler deploy`... (first deploy takes ~20s)");
  // Capture stdout so we can parse the workers.dev URL; stream stderr live.
  const result = spawnSync("npx", ["wrangler", "deploy"], {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  });

  // Stream captured stdout to the terminal so users see deploy progress.
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0) throw new Error(`wrangler deploy failed (exit ${result.status})`);

  // wrangler deploy prints the workers.dev URL after "Deployed ... triggers:"
  const match = result.stdout?.match(/https:\/\/[\w-]+\.[\w-]+\.workers\.dev/);
  if (!match) throw new Error("Deploy succeeded but couldn't parse the Worker URL from output.");

  ok(`Worker deployed → ${c.cyan(match[0])}`);
  return match[0];
}

function setWorkerSecrets(
  accountId: string,
  ouraToken: string, mcpPassword: string,
): void {
  step(11, "Set Worker secrets");

  for (const [name, value] of [
    [OURA_SECRET_NAME, ouraToken],
    [AUTH_SECRET_NAME, mcpPassword],
  ] as const) {
    const result = spawnSync(
      "npx", ["wrangler", "secret", "put", name],
      { input: value, stdio: ["pipe", "ignore", "inherit"], encoding: "utf8",
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId } },
    );
    if (result.status !== 0) throw new Error(`Failed to set secret ${name}`);
    ok(`Secret ${c.cyan(name)} set`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner("oura-mcp-server — Bootstrap", [
    "This will set up everything needed to chat with",
    "your Oura Ring data in Claude.",
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

  const { accountId, accountName: _ } = await ensureWranglerAuth();

  // Read-only checks — show plan before touching anything.
  const d1List = spawnSync("npx", ["wrangler", "d1", "list", "--json"], {
    stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  });
  const kvList = spawnSync("npx", ["wrangler", "kv", "namespace", "list"], {
    stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  });
  const dbs = d1List.status === 0 && d1List.stdout?.trim()
    ? (JSON.parse(d1List.stdout) as { name: string }[])
    : [];
  const kvs = kvList.status === 0 && kvList.stdout?.trim()
    ? (JSON.parse(kvList.stdout) as { title: string }[])
    : [];
  const existingD1 = dbs.some((db) => db.name === D1_NAME);
  const existingKv = kvs.some((ns) => ns.title === KV_NAME);

  console.log();
  banner("Ready to provision", [
    `Cloudflare account:  ${c.cyan(accountId)}`,
    "",
    `${c.bold("The following will happen:")}`,
    `  • D1 database "${D1_NAME}" — ${existingD1 ? c.dim("reuse existing") : c.green("create new")}`,
    `  • KV namespace "${KV_NAME}" — ${existingKv ? c.dim("reuse existing") : c.green("create new")}`,
    `  • Apply D1 schema (idempotent)`,
    `  • Deploy Worker "${WORKER_NAME}" (create on first run, update otherwise)`,
    `  • Set OURA_API_TOKEN + MCP_AUTH_PASSWORD secrets`,
  ]);
  if (!(await confirm("Proceed?", true))) {
    console.log("  Cancelled — no changes were made.");
    return;
  }

  const dbId        = ensureD1(accountId);
  const kvId        = ensureKvNamespace(accountId);
  writeWranglerConfig(dbId, kvId);

  step(6.5, "Regenerate Worker types");
  info("Running `wrangler types`...");
  const typegen = spawnSync("npx", ["wrangler", "types"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  });
  if (typegen.status !== 0) warn("Type generation failed — run `pnpm cf-typegen` manually");
  else ok("worker-configuration.d.ts updated");

  applyD1Schema(accountId);
  const ouraToken   = await ensureOuraToken();
  const mcpPassword = await promptMcpPassword();
  const workerUrl   = deployWorker(accountId);
  setWorkerSecrets(accountId, ouraToken, mcpPassword);

  const mcpUrl = `${workerUrl}/mcp`;
  const clipped = copyToClipboard(mcpUrl);
  openBrowser("https://claude.ai/settings/connectors");

  console.log();
  banner("✅  Setup complete!", [
    `Worker:  ${c.cyan(workerUrl)}`,
    "",
    `${c.bold("Connect Claude:")} ${clipped ? "MCP URL copied to clipboard —" : "paste this URL:"}`,
    `  ${c.cyan(mcpUrl)}`,
    `  ${c.dim("(browser opened to claude.ai/settings/connectors)")}`,
    "",
    `${c.dim("First connection opens a browser for your MCP password.")}`,
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
