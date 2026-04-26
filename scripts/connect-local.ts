import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { banner, c, ok, warn, info, closePrompts, pressEnter, promptHidden } from "./prompts";
import { copyToClipboard, loadDevVars, openBrowser, saveDevVars } from "./utils";

const DEV_VARS_PATH       = path.resolve(process.cwd(), ".dev.vars");
const WRANGLER_JSONC_PATH = path.resolve(process.cwd(), "wrangler.jsonc");
const SCHEMA_PATH         = path.resolve(process.cwd(), "migrations/001_init.sql");
const OURA_PAT_URL        = "https://cloud.ouraring.com/personal-access-tokens";

function isNgrokInstalled(): boolean {
  return spawnSync("ngrok", ["version"], { stdio: "ignore" }).status === 0;
}

async function getNgrokUrl(): Promise<string | null> {
  try {
    const res = await fetch("http://127.0.0.1:4040/api/tunnels");
    if (!res.ok) return null;
    const json = await res.json() as { tunnels: Array<{ public_url: string }> };
    return json.tunnels.find((t) => t.public_url.startsWith("https://"))?.public_url ?? null;
  } catch {
    return null;
  }
}

async function main() {
  banner("oura-mcp-server — Local setup", [
    "Sets up local credentials and D1 schema.",
    "No Cloudflare account needed — just keep `pnpm dev` running.",
  ]);

  // ── Secrets ──────────────────────────────────────────────────────────────────

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

  // ── wrangler.jsonc ────────────────────────────────────────────────────────────

  if (!fs.existsSync(WRANGLER_JSONC_PATH)) {
    const example = path.resolve(process.cwd(), "wrangler.example.jsonc");
    if (!fs.existsSync(example)) throw new Error("wrangler.jsonc not found and wrangler.example.jsonc is missing");
    fs.copyFileSync(example, WRANGLER_JSONC_PATH);
    ok("Created wrangler.jsonc from example");
  } else {
    // Patch stale configs missing the OAUTH_KV binding from before the OAuth migration.
    const jsonc = fs.readFileSync(WRANGLER_JSONC_PATH, "utf8");
    if (!jsonc.includes('"OAUTH_KV"')) {
      warn("wrangler.jsonc is missing the OAUTH_KV binding — patching...");
      const patched = jsonc.replace(
        /"d1_databases"/,
        `"kv_namespaces": [\n    { "binding": "OAUTH_KV", "id": "local-dev-kv" }\n  ],\n\n  "d1_databases"`,
      );
      if (patched === jsonc) {
        warn('Could not auto-patch. Add manually: "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "local-dev-kv" }]');
      } else {
        fs.writeFileSync(WRANGLER_JSONC_PATH, patched);
        ok("Patched wrangler.jsonc — added OAUTH_KV binding");
      }
    } else {
      ok("wrangler.jsonc looks good");
    }
  }

  // ── Worker types ──────────────────────────────────────────────────────────────

  info("Regenerating Worker types...");
  const typegen = spawnSync("npx", ["wrangler", "types"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (typegen.status !== 0) warn("Type generation failed — run `pnpm cf-typegen` manually");
  else ok("worker-configuration.d.ts updated");

  // ── Local D1 schema ───────────────────────────────────────────────────────────

  info("Applying schema to local D1...");
  const migration = spawnSync(
    "npx", ["wrangler", "d1", "execute", "oura-cache", "--local", "--file", SCHEMA_PATH],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (migration.status !== 0) {
    warn(`Schema migration failed — run manually: npx wrangler d1 execute oura-cache --local --file=${SCHEMA_PATH}`);
  } else {
    ok("Local D1 schema ready");
  }

  // ── Connect to Claude ─────────────────────────────────────────────────────────

  console.log();
  if (isNgrokInstalled()) {
    info("ngrok detected.");
    console.log(`  Start ${c.cyan("pnpm dev")} and ${c.cyan("ngrok http 8787")} in two other terminals.`);
    await pressEnter("Press Enter once both are running...");

    const tunnelUrl = await getNgrokUrl();
    if (tunnelUrl) {
      const mcpUrl = `${tunnelUrl}/mcp`;
      const clipped = copyToClipboard(mcpUrl);
      openBrowser("https://claude.ai/settings/connectors");
      console.log();
      ok(`Tunnel live: ${c.cyan(mcpUrl)}`);
      if (clipped) ok("MCP URL copied to clipboard — paste it into Add custom connector.");
      else info(`MCP URL: ${c.cyan(mcpUrl)}`);
      console.log(`  ${c.dim("Browser opened to claude.ai/settings/connectors.")}`);
    } else {
      warn("Could not reach ngrok API (http://127.0.0.1:4040). Is ngrok running?");
      console.log(`  Start ${c.cyan("ngrok http 8787")}, then add your tunnel URL at ${c.cyan("https://claude.ai/settings/connectors")}`);
    }
  } else {
    console.log(`  ${c.bold("To connect Claude, you'll need an HTTPS tunnel.")} ngrok is the easiest option.`);
    console.log(`  See the ${c.cyan("Local development")} section of the README for setup instructions.`);
  }

  console.log();
  console.log(`  ${c.dim("Run `pnpm bootstrap` when you're ready to deploy to Cloudflare.")}`);
}

main()
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n${c.red("✗")} ${msg}`);
    process.exit(1);
  })
  .finally(() => closePrompts());
