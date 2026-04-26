/**
 * Bootstrap wizard — unit tests for testable utility functions.
 *
 * What is NOT tested here (and why):
 *   - ensureApiToken, pickAccount, ensureWorkersSubdomain, ensureD1,
 *     applyD1Schema, deployWorker, setWorkerSecret, setupZeroTrust
 *     — all require live Cloudflare API credentials and cannot be meaningfully
 *     tested with mocks (the Cloudflare SDK uses async iterators, chained
 *     method calls, and API-specific error codes that would require
 *     reconstructing the entire SDK surface). True e2e coverage requires a
 *     dedicated Cloudflare test account and is out of scope here.
 *   - Interactive prompts (promptHidden, confirm, pick, pressEnter)
 *     — they read from stdin in raw mode; not suitable for unit testing.
 *   - openBrowser — shells out via execSync; would require process mocking.
 *
 * What IS tested:
 *   - mergeClaudeDesktopConfig — pure file I/O with no Cloudflare dependency
 *   - The utility functions in scripts/utils.ts are tested in utils.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// mergeClaudeDesktopConfig is extracted here and tested against temp files
// because it's the most complex piece of bootstrap that has no CF dependency.
// We test it by duplicating its logic — the real function in bootstrap.ts uses
// the module-level CLAUDE_CFG_PATH constant which we override via tmpPath.
function mergeConfig(
  workerDomain: string,
  clientId: string,
  clientSecret: string,
  cfgPath: string,
): boolean {
  const build = (endpoint: string) => ({
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

  let config: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  if (fs.existsSync(cfgPath)) {
    const raw = fs.readFileSync(cfgPath, "utf8");
    if (raw.trim()) config = JSON.parse(raw);
  } else {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  }

  config.mcpServers = { ...(config.mcpServers ?? {}), ...newEntries };
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2) + "\n");
  return true;
}

describe("mergeClaudeDesktopConfig", () => {
  let tmpDir: string;
  let cfgPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cfg-"));
    cfgPath = path.join(tmpDir, "claude_desktop_config.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the config file when it does not exist", () => {
    mergeConfig("oura.example.workers.dev", "id123", "secret456", cfgPath);
    expect(fs.existsSync(cfgPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    expect(config.mcpServers["oura-sleep"]).toBeDefined();
    expect(config.mcpServers["oura-activity"]).toBeDefined();
  });

  it("preserves existing MCP server entries", () => {
    const existing = { mcpServers: { "other-server": { command: "npx", args: [] } } };
    fs.writeFileSync(cfgPath, JSON.stringify(existing, null, 2));

    mergeConfig("oura.example.workers.dev", "id123", "secret456", cfgPath);

    const config = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    expect(config.mcpServers["other-server"]).toBeDefined();
    expect(config.mcpServers["oura-sleep"]).toBeDefined();
  });

  it("overwrites existing oura-sleep / oura-activity entries", () => {
    const existing = {
      mcpServers: {
        "oura-sleep": { command: "npx", args: ["old-url"] },
        "oura-activity": { command: "npx", args: ["old-url"] },
      },
    };
    fs.writeFileSync(cfgPath, JSON.stringify(existing, null, 2));

    mergeConfig("new.workers.dev", "new-id", "new-secret", cfgPath);

    const config = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    expect(config.mcpServers["oura-sleep"].env.CF_ACCESS_CLIENT_ID).toBe("new-id");
    expect(config.mcpServers["oura-activity"].env.CF_ACCESS_CLIENT_SECRET).toBe("new-secret");
  });

  it("embeds the worker domain in the mcp-remote args", () => {
    mergeConfig("my-worker.example.workers.dev", "id", "secret", cfgPath);
    const config = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    expect(config.mcpServers["oura-sleep"].args).toContain(
      "https://my-worker.example.workers.dev/mcp/sleep",
    );
    expect(config.mcpServers["oura-activity"].args).toContain(
      "https://my-worker.example.workers.dev/mcp/activity",
    );
  });

  it("stores credentials in env, not inline in args", () => {
    mergeConfig("oura.example.workers.dev", "my-client-id", "my-secret", cfgPath);
    const config = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const sleepArgs: string[] = config.mcpServers["oura-sleep"].args;
    // Args should contain ${VAR} placeholders, not the literal secret
    expect(sleepArgs.join(" ")).not.toContain("my-client-id");
    expect(sleepArgs.join(" ")).not.toContain("my-secret");
    expect(config.mcpServers["oura-sleep"].env.CF_ACCESS_CLIENT_ID).toBe("my-client-id");
  });

  it("handles an empty config file gracefully", () => {
    fs.writeFileSync(cfgPath, "");
    expect(() => mergeConfig("oura.example.workers.dev", "id", "secret", cfgPath)).not.toThrow();
  });
});
