import * as path from "node:path"
import { spawnSync } from "node:child_process"

import { banner, c, confirm, closePrompts, info, ok, warn } from "./prompts"
import { loadDevVars } from "./utils"

const BOOTSTRAP_STATE_PATH = path.resolve(process.cwd(), ".bootstrap-state")

async function main(): Promise<void> {
  banner("oura-mcp-server — Revoke OAuth tokens", [
    "This invalidates all active Claude sessions.",
    "Claude will re-authenticate using your current password",
    "the next time it connects — no connectors page needed.",
  ])

  const state = loadDevVars(BOOTSTRAP_STATE_PATH)
  const accountId = state["CLOUDFLARE_ACCOUNT_ID"]
  const kvId = state["KV_NAMESPACE_ID"]

  if (!accountId || !kvId) {
    throw new Error(
      "No bootstrap state found — run `pnpm bootstrap` first.\n" +
        `  Expected: ${BOOTSTRAP_STATE_PATH}`,
    )
  }

  // List all keys in the OAuth KV namespace.
  info("Listing active sessions...")
  const listResult = spawnSync("npx", ["wrangler", "kv", "key", "list", "--namespace-id", kvId], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  })
  if (listResult.status !== 0) {
    throw new Error(`Failed to list KV keys: ${listResult.stderr?.trim()}`)
  }

  const keys = JSON.parse(listResult.stdout?.trim() || "[]") as { name: string }[]
  if (keys.length === 0) {
    ok("No active sessions found — nothing to revoke.")
    return
  }

  console.log(`  Found ${c.cyan(String(keys.length))} active session(s).\n`)
  if (
    !(await confirm("Revoke all OAuth tokens? Claude will re-authenticate on next use.", false))
  ) {
    console.log("  Cancelled — no tokens were revoked.")
    return
  }

  // Delete each key individually.
  let failed = 0
  for (const key of keys) {
    const result = spawnSync(
      "npx",
      ["wrangler", "kv", "key", "delete", "--namespace-id", kvId, key.name],
      {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
      },
    )
    if (result.status !== 0) {
      warn(`Failed to delete token ${c.dim(key.name)}`)
      failed++
    } else {
      ok(`Revoked ${c.dim(key.name)}`)
    }
  }

  console.log()
  if (failed > 0) {
    warn(
      `${failed} token(s) could not be deleted — try again or clear them in the Cloudflare dashboard.`,
    )
  } else {
    ok("All sessions revoked.")
    console.log(`  ${c.dim("Claude will open a browser for your password on next use.")}`)
  }
}

main()
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`\n${c.red("✗ Revoke failed:")} ${msg}`)
    process.exit(1)
  })
  .finally(() => closePrompts())
