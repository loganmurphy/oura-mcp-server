import * as fs from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"

import { banner, c, ok, warn, info, closePrompts, promptHidden, confirm } from "./prompts"
import { loadDevVars, saveDevVars, validatePassword } from "./utils"

const DEV_VARS_PATH = path.resolve(process.cwd(), ".dev.vars")
const WRANGLER_JSONC_PATH = path.resolve(process.cwd(), "wrangler.jsonc")
const SCHEMA_PATH = path.resolve(process.cwd(), "migrations/001_init.sql")
const OURA_PAT_URL = "https://cloud.ouraring.com/personal-access-tokens"
const CONNECTORS_URL = "https://claude.ai/customize/connectors"

async function main() {
  banner("oura-mcp-server — Local setup", [
    "Sets up local credentials and D1 schema.",
    "No Cloudflare account needed — just keep `pnpm dev` running.",
  ])

  const vars = loadDevVars(DEV_VARS_PATH)

  let ouraToken = vars["OURA_API_TOKEN"] ?? ""
  if (!ouraToken) {
    console.log(`  ${c.bold("Oura Personal Access Token")} — get one at ${c.cyan(OURA_PAT_URL)}`)
    ouraToken = await promptHidden("Paste your Oura token (hidden)")
    if (!ouraToken) throw new Error("Oura token cannot be empty")
    saveDevVars(DEV_VARS_PATH, { OURA_API_TOKEN: ouraToken })
    ok("OURA_API_TOKEN saved to .dev.vars")
  } else {
    ok("OURA_API_TOKEN already in .dev.vars")
  }

  let mcpPassword = vars["MCP_AUTH_PASSWORD"] ?? ""
  if (!mcpPassword) {
    console.log(
      `\n  ${c.bold("MCP server password")} — you'll enter this once in the browser login prompt.`,
    )
    console.log(`  ${c.dim("Min 12 characters, one number, one special character.")}`)
    while (true) {
      mcpPassword = await promptHidden("Choose a password (hidden)")
      if (!mcpPassword) throw new Error("Password cannot be empty")
      const err = validatePassword(mcpPassword)
      if (err) {
        warn(err)
        continue
      }
      break
    }
    saveDevVars(DEV_VARS_PATH, { MCP_AUTH_PASSWORD: mcpPassword })
    ok("MCP_AUTH_PASSWORD saved to .dev.vars")
  } else {
    ok("MCP_AUTH_PASSWORD already in .dev.vars")
  }

  if (!fs.existsSync(WRANGLER_JSONC_PATH)) {
    const example = path.resolve(process.cwd(), "wrangler.example.jsonc")
    if (!fs.existsSync(example))
      throw new Error("wrangler.jsonc not found and wrangler.example.jsonc is missing")
    fs.copyFileSync(example, WRANGLER_JSONC_PATH)
    ok("Created wrangler.jsonc from example")
  } else {
    // Patch stale configs missing the OAUTH_KV binding from before the OAuth migration.
    const jsonc = fs.readFileSync(WRANGLER_JSONC_PATH, "utf8")
    if (!jsonc.includes('"OAUTH_KV"')) {
      warn("wrangler.jsonc is missing the OAUTH_KV binding — patching...")
      const patched = jsonc.replace(
        /"d1_databases"/,
        `"kv_namespaces": [\n    { "binding": "OAUTH_KV", "id": "local-dev-kv" }\n  ],\n\n  "d1_databases"`,
      )
      if (patched === jsonc) {
        warn(
          'Could not auto-patch. Add manually: "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "local-dev-kv" }]',
        )
      } else {
        fs.writeFileSync(WRANGLER_JSONC_PATH, patched)
        ok("Patched wrangler.jsonc — added OAUTH_KV binding")
      }
    } else {
      ok("wrangler.jsonc looks good")
    }
  }

  info("Regenerating Worker types...")
  const typegen = spawnSync("npx", ["wrangler", "types"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  })
  if (typegen.status !== 0) warn("Type generation failed — run `pnpm cf-typegen` manually")
  else ok("worker-configuration.d.ts updated")

  info("Applying schema to local D1...")
  const migration = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", "oura-cache", "--local", "--file", SCHEMA_PATH],
    { stdio: ["ignore", "inherit", "inherit"] },
  )
  if (migration.status !== 0) {
    warn(
      `Schema migration failed — run manually: npx wrangler d1 execute oura-cache --local --file=${SCHEMA_PATH}`,
    )
  } else {
    ok("Local D1 schema ready")
  }

  const vars2 = loadDevVars(DEV_VARS_PATH)
  const alreadyWomens = vars2["ENABLE_WOMENS_HEALTH"]
  if (alreadyWomens) {
    ok(
      `Women's health tools: ${alreadyWomens === "true" ? "enabled" : "disabled"} (already configured)`,
    )
  } else {
    console.log()
    console.log(
      `  ${c.dim("Oura offers dedicated cycle insights, reproductive health, and perimenopause")}`,
    )
    console.log(
      `  ${c.dim("tracking endpoints. These are opt-in and require the feature to be enabled")}`,
    )
    console.log(`  ${c.dim("in the Oura app — the tools return empty data if not configured.")}`)
    console.log()
    const enableWomens = await confirm("Enable women's health tools?", false)
    saveDevVars(DEV_VARS_PATH, { ENABLE_WOMENS_HEALTH: enableWomens ? "true" : "false" })
    if (enableWomens) {
      ok("Women's health tools enabled — ENABLE_WOMENS_HEALTH saved to .dev.vars")
    } else {
      ok("Women's health tools skipped — edit .dev.vars to enable later")
    }
  }

  console.log()
  ok("Local setup complete!")
  console.log()
  console.log(`  ${c.bold("Next steps:")}`)
  console.log(`  ${c.dim("1.")} Run ${c.cyan("pnpm dev")} in one terminal`)
  console.log(
    `  ${c.dim("2.")} Run ${c.cyan("ngrok http 8787")} in another → copy the ${c.cyan("https://")} URL`,
  )
  console.log(
    `  ${c.dim("3.")} Add ${c.cyan("<ngrok-url>/mcp")} as a custom connector at ${c.cyan(CONNECTORS_URL)}`,
  )
  console.log()
}

main()
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`\n${c.red("✗")} ${msg}`)
    process.exit(1)
  })
  .finally(() => closePrompts())
