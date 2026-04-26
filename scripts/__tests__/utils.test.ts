import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadDevVars, saveDevVars, openBrowser, copyToClipboard } from "../utils";

// Mock node:child_process so spawnSync never actually runs system commands.
vi.mock("node:child_process", () => ({ spawnSync: vi.fn(() => ({ status: 0 })) }));
import { spawnSync } from "node:child_process";
const mockSpawn = vi.mocked(spawnSync);

// ── Platform helpers ──────────────────────────────────────────────────────────

function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const desc = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try { fn(); } finally { Object.defineProperty(process, "platform", desc); }
}

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

// ── openBrowser ───────────────────────────────────────────────────────────────

describe("openBrowser", () => {
  beforeEach(() => mockSpawn.mockClear());

  it("darwin — calls 'open' with the URL", () => {
    withPlatform("darwin", () => openBrowser("https://example.com"));
    expect(mockSpawn).toHaveBeenCalledWith("open", ["https://example.com"], { stdio: "ignore" });
  });

  it("win32 — calls 'cmd /c start'", () => {
    withPlatform("win32", () => openBrowser("https://example.com"));
    expect(mockSpawn).toHaveBeenCalledWith("cmd", ["/c", "start", "https://example.com"], { stdio: "ignore" });
  });

  it("linux — calls 'xdg-open'", () => {
    withPlatform("linux", () => openBrowser("https://example.com"));
    expect(mockSpawn).toHaveBeenCalledWith("xdg-open", ["https://example.com"], { stdio: "ignore" });
  });
});

// ── copyToClipboard ───────────────────────────────────────────────────────────

describe("copyToClipboard", () => {
  beforeEach(() => mockSpawn.mockClear());

  it("darwin — calls 'pbcopy' and returns true on success", () => {
    mockSpawn.mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>);
    let result!: boolean;
    withPlatform("darwin", () => { result = copyToClipboard("hello"); });
    expect(mockSpawn).toHaveBeenCalledWith("pbcopy", [], expect.objectContaining({ input: "hello" }));
    expect(result).toBe(true);
  });

  it("win32 — calls 'clip'", () => {
    withPlatform("win32", () => copyToClipboard("hello"));
    expect(mockSpawn).toHaveBeenCalledWith("clip", [], expect.objectContaining({ input: "hello" }));
  });

  it("linux — calls 'xclip' with -selection clipboard", () => {
    withPlatform("linux", () => copyToClipboard("hello"));
    expect(mockSpawn).toHaveBeenCalledWith("xclip", ["-selection", "clipboard"], expect.objectContaining({ input: "hello" }));
  });

  it("returns false when the command fails", () => {
    mockSpawn.mockReturnValueOnce({ status: 1 } as ReturnType<typeof spawnSync>);
    expect(copyToClipboard("hello")).toBe(false);
  });
});

