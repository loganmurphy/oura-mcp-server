/**
 * Wire Claude Desktop to the local dev server (http://localhost:8787).
 * No Cloudflare account needed — just run `pnpm dev` alongside.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { banner, c, ok, warn, fail, info } from "./prompts";
import { claudeCfgPath, loadDevVars } from "./utils";

const DEV_VARS_PATH = path.resolve(process.cwd(), ".dev.vars");
const SCHEMA_PATH = path.resolve(process.cwd(), "migrations/001_init.sql");
const CLAUDE_CFG_PATH = claudeCfgPath();

const BASE_URL = "http://localhost:8787";

const entries = {
  "oura-sleep": {
    command: "npx",
    args: ["-y", "mcp-remote", `${BASE_URL}/mcp/sleep`],
  },
  "oura-activity": {
    command: "npx",
    args: ["-y", "mcp-remote", `${BASE_URL}/mcp/activity`],
  },
};

banner("Connect Claude Desktop → local dev server", [
  `Points oura-sleep and oura-activity at ${c.cyan(BASE_URL)}`,
  "No Cloudflare account needed — just keep `pnpm dev` running.",
]);

// Warn if OURA_API_TOKEN isn't in .dev.vars yet
const vars = loadDevVars(DEV_VARS_PATH);
if (!vars["OURA_API_TOKEN"]) {
  warn("OURA_API_TOKEN not found in .dev.vars");
  console.log(`  Add it before starting the dev server:`);
  console.log(`    ${c.cyan('echo "OURA_API_TOKEN=your_token_here" >> .dev.vars')}`);
  console.log(`  Get a token at: ${c.cyan("https://cloud.ouraring.com/personal-access-tokens")}\n`);
}

// Read existing config
let config: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
if (fs.existsSync(CLAUDE_CFG_PATH)) {
  try {
    const raw = fs.readFileSync(CLAUDE_CFG_PATH, "utf8");
    if (raw.trim()) config = JSON.parse(raw);
  } catch (e) {
    fail(`Couldn't parse existing config: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`  Fix the JSON at ${c.dim(CLAUDE_CFG_PATH)} and try again.`);
    process.exit(1);
  }
} else {
  fs.mkdirSync(path.dirname(CLAUDE_CFG_PATH), { recursive: true });
}

const existing = config.mcpServers ?? {};
const others = Object.keys(existing).filter((k) => k !== "oura-sleep" && k !== "oura-activity");
if (others.length > 0) {
  console.log(`  Preserving ${others.length} existing MCP server(s): ${c.dim(others.join(", "))}`);
}

config.mcpServers = { ...existing, ...entries };

const bak = `${CLAUDE_CFG_PATH}.bak`;
if (fs.existsSync(CLAUDE_CFG_PATH)) fs.copyFileSync(CLAUDE_CFG_PATH, bak);
fs.writeFileSync(CLAUDE_CFG_PATH, JSON.stringify(config, null, 2) + "\n");
if (fs.existsSync(bak)) fs.unlinkSync(bak);

ok(`Claude Desktop config updated — ${c.dim(CLAUDE_CFG_PATH)}`);

// Apply schema to the local Miniflare D1 so the cache table exists before first use.
// wrangler dev always uses local storage — this never touches the remote database.
info("Applying schema to local D1...");
const migration = spawnSync(
  "npx", ["wrangler", "d1", "execute", "oura-cache", "--local", "--file", SCHEMA_PATH],
  { stdio: ["ignore", "inherit", "inherit"] },
);
if (migration.status !== 0) {
  warn("Schema migration failed — run manually before starting dev:");
  console.log(`  ${c.cyan(`npx wrangler d1 execute oura-cache --local --file=${SCHEMA_PATH}`)}`);
} else {
  ok("Local D1 schema ready");
}

console.log(`
  ${c.bold("Next steps:")}
    1. ${c.cyan("pnpm dev")}          keep this running in another terminal
    2. Quit Claude Desktop fully ${c.dim("(Cmd+Q)")} and relaunch
    3. Ask: ${c.cyan('"What was my sleep score last night?"')}

  ${c.dim('Run `pnpm bootstrap` when you\'re ready to deploy to Cloudflare.')}
`);
