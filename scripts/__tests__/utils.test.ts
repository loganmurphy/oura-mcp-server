import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadDevVars, saveDevVars, slugify, claudeCfgPath } from "../utils";

// ── loadDevVars / saveDevVars ─────────────────────────────────────────────────

describe("loadDevVars", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `dev-vars-${Date.now()}`);
  });

  afterEach(() => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it("returns empty object when file does not exist", () => {
    expect(loadDevVars("/nonexistent/path/.dev.vars")).toEqual({});
  });

  it("parses KEY=VALUE pairs", () => {
    fs.writeFileSync(tmpFile, "FOO=bar\nBAZ=qux\n");
    expect(loadDevVars(tmpFile)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips blank lines and comments", () => {
    fs.writeFileSync(tmpFile, "\n# comment\nFOO=bar\n\n");
    expect(loadDevVars(tmpFile)).toEqual({ FOO: "bar" });
  });

  it("skips lines without an equals sign", () => {
    fs.writeFileSync(tmpFile, "INVALID\nFOO=bar\n");
    expect(loadDevVars(tmpFile)).toEqual({ FOO: "bar" });
  });

  it("preserves values that contain equals signs", () => {
    fs.writeFileSync(tmpFile, "TOKEN=abc=def=ghi\n");
    expect(loadDevVars(tmpFile)).toEqual({ TOKEN: "abc=def=ghi" });
  });
});

describe("saveDevVars", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `dev-vars-${Date.now()}`);
  });

  afterEach(() => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it("creates the file with the given vars", () => {
    saveDevVars(tmpFile, { FOO: "bar" });
    expect(loadDevVars(tmpFile)).toEqual({ FOO: "bar" });
  });

  it("merges new vars with existing ones", () => {
    fs.writeFileSync(tmpFile, "EXISTING=value\n");
    saveDevVars(tmpFile, { NEW_KEY: "new_value" });
    expect(loadDevVars(tmpFile)).toEqual({ EXISTING: "value", NEW_KEY: "new_value" });
  });

  it("overwrites existing keys", () => {
    fs.writeFileSync(tmpFile, "FOO=old\n");
    saveDevVars(tmpFile, { FOO: "new" });
    expect(loadDevVars(tmpFile)).toEqual({ FOO: "new" });
  });
});

// ── slugify ───────────────────────────────────────────────────────────────────

describe("slugify", () => {
  it("lowercases and replaces non-alphanumeric runs with hyphens", () => {
    expect(slugify("My Cool Account")).toBe("my-cool-account");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("  hello  ")).toBe("hello");
  });

  it("collapses multiple separators into one hyphen", () => {
    expect(slugify("hello---world")).toBe("hello-world");
  });

  it("truncates to 63 characters", () => {
    const long = "a".repeat(70);
    expect(slugify(long).length).toBe(63);
  });

  it("returns the fallback when the slug is shorter than 3 chars", () => {
    expect(slugify("ab")).toBe("oura-mcp");
    expect(slugify("!@")).toBe("oura-mcp");
  });

  it("accepts a custom fallback", () => {
    expect(slugify("!!", "my-fallback")).toBe("my-fallback");
  });
});

// ── claudeCfgPath ─────────────────────────────────────────────────────────────

function withPlatform(platform: string, fn: () => void) {
  const desc = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", desc);
  }
}

describe("claudeCfgPath", () => {
  it("returns a string ending in claude_desktop_config.json", () => {
    expect(claudeCfgPath()).toMatch(/claude_desktop_config\.json$/i);
  });

  it("contains a Claude directory segment", () => {
    expect(claudeCfgPath()).toMatch(/Claude/);
  });

  it("win32 — returns path under APPDATA when set", () => {
    const origAppdata = process.env["APPDATA"];
    process.env["APPDATA"] = "C:\\Users\\Test\\AppData\\Roaming";
    withPlatform("win32", () => {
      expect(claudeCfgPath()).toContain("Claude");
      expect(claudeCfgPath()).toContain("claude_desktop_config.json");
    });
    if (origAppdata === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = origAppdata;
  });

  it("win32 — falls back to homedir when APPDATA is unset", () => {
    const origAppdata = process.env["APPDATA"];
    delete process.env["APPDATA"];
    withPlatform("win32", () => {
      expect(claudeCfgPath()).toContain("Claude");
    });
    if (origAppdata !== undefined) process.env["APPDATA"] = origAppdata;
  });

  it("linux (default) — returns path under XDG_CONFIG_HOME when set", () => {
    const origXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = "/custom/config";
    withPlatform("linux", () => {
      expect(claudeCfgPath()).toContain("Claude");
      expect(claudeCfgPath()).toContain("claude_desktop_config.json");
    });
    if (origXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = origXdg;
  });

  it("linux (default) — falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    const origXdg = process.env["XDG_CONFIG_HOME"];
    delete process.env["XDG_CONFIG_HOME"];
    withPlatform("linux", () => {
      expect(claudeCfgPath()).toContain(".config");
    });
    if (origXdg !== undefined) process.env["XDG_CONFIG_HOME"] = origXdg;
  });
});
