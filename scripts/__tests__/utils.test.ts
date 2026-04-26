import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadDevVars, saveDevVars } from "../utils";

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

