/**
 * Wire Claude Desktop to the local dev server (http://localhost:8787).
 * No Cloudflare account needed — just run `pnpm dev` alongside.
 *
 * Also handles first-time local setup:
 *   • Prompts for OURA_API_TOKEN and MCP_AUTH_PASSWORD if not in .dev.vars
 *   • Detects a stale wrangler.jsonc missing the OAUTH_KV binding and patches it
 *   • Applies the D1 schema to the local Miniflare store
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { banner, c, ok, warn, info, closePrompts, promptHidden } from "./prompts";
import { claudeCfgPath, loadDevVars, saveDevVars } from "./utils";

const DEV_VARS_PATH       = path.resolve(process.cwd(), ".dev.vars");
const WRANGLER_JSONC_PATH = path.resolve(process.cwd(), "wrangler.jsonc");
const SCHEMA_PATH         = path.resolve(process.cwd(), "migrations/001_init.sql");
const CLAUDE_CFG_PATH     = claudeCfgPath();
const OURA_PAT_URL        = "https://cloud.ouraring.com/personal-access-tokens";

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

async function main() {
  banner("Connect Claude Desktop → local dev server", [
    `Points oura-sleep and oura-activity at ${c.cyan(BASE_URL)}`,
    "No Cloudflare account needed — just keep `pnpm dev` running.",
  ]);

  // ── Step 1: Secrets ─────────────────────────────────────────────────────────

  const vars = loadDevVars(DEV_VARS_PATH);

  let ouraToken = vars["OURA_API_TOKEN"] ?? "";
  if (!ouraToken) {
    console.log(`  ${c.bold("Oura Personal Access Token")} — get one at ${c.cyan(OURA_PAT_URL)}`);
    ouraToken = await promptHidden("Paste your Oura token (hidden)");
    if (!ouraToken) throw new Error("Oura token cannot be empty");
    saveDevVars(DEV_VARS_PATH, { OURA_API_TOKEN: ouraToken });
    ok("OURA_API_TOKEN saved to .dev.vars");
  } else {
    ok("OURA_API_TOKEN already in .dev.vars");
  }

  let mcpPassword = vars["MCP_AUTH_PASSWORD"] ?? "";
  if (!mcpPassword) {
    console.log(`\n  ${c.bold("MCP server password")} — you'll enter this once in the browser login prompt.`);
    mcpPassword = await promptHidden("Choose a password (hidden)");
    if (!mcpPassword) throw new Error("Password cannot be empty");
    saveDevVars(DEV_VARS_PATH, { MCP_AUTH_PASSWORD: mcpPassword });
    ok("MCP_AUTH_PASSWORD saved to .dev.vars");
  } else {
    ok("MCP_AUTH_PASSWORD already in .dev.vars");
  }

  // ── Step 2: wrangler.jsonc — ensure OAUTH_KV binding exists ─────────────────

  if (!fs.existsSync(WRANGLER_JSONC_PATH)) {
    const example = path.resolve(process.cwd(), "wrangler.example.jsonc");
    if (!fs.existsSync(example)) {
      throw new Error("wrangler.jsonc not found and wrangler.example.jsonc is missing");
    }
    fs.copyFileSync(example, WRANGLER_JSONC_PATH);
    ok("Created wrangler.jsonc from example");
  } else {
    const jsonc = fs.readFileSync(WRANGLER_JSONC_PATH, "utf8");
    if (!jsonc.includes('"OAUTH_KV"')) {
      // Stale config from before the OAuth migration — inject the KV binding.
      warn("wrangler.jsonc is missing the OAUTH_KV binding (pre-OAuth config detected)");
      const patched = jsonc.replace(
        /"d1_databases"/,
        `"kv_namespaces": [\n    { "binding": "OAUTH_KV", "id": "local-dev-kv" }\n  ],\n\n  "d1_databases"`,
      );
      if (patched === jsonc) {
        warn('Could not auto-patch wrangler.jsonc. Add this manually:\n  "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "YOUR_KV_NAMESPACE_ID" }]');
      } else {
        fs.writeFileSync(WRANGLER_JSONC_PATH, patched);
        ok("Patched wrangler.jsonc — added OAUTH_KV binding (bootstrap sets the real ID for production)");
      }
    } else {
      ok("wrangler.jsonc looks good");
    }
  }

  // ── Step 3: Local D1 schema ──────────────────────────────────────────────────

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

  // ── Step 4: Claude Desktop config ───────────────────────────────────────────

  let config: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  if (fs.existsSync(CLAUDE_CFG_PATH)) {
    try {
      const raw = fs.readFileSync(CLAUDE_CFG_PATH, "utf8");
      if (raw.trim()) config = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Couldn't parse existing config at ${CLAUDE_CFG_PATH}: ${e instanceof Error ? e.message : String(e)}`);
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

  // ── Done ────────────────────────────────────────────────────────────────────

  console.log(`
  ${c.bold("Next steps:")}
    1. ${c.cyan("pnpm dev")}          keep this running in another terminal
    2. Quit Claude Desktop fully ${c.dim("(Cmd+Q)")} and relaunch
    3. Ask: ${c.cyan('"What was my sleep score last night?"')}
       A browser window will open for the password prompt on first connection.

  ${c.dim('Run `pnpm bootstrap` when you\'re ready to deploy to Cloudflare.')}
`);
}

main()
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n${c.red("✗")} ${msg}`);
    process.exit(1);
  })
  .finally(() => closePrompts());
