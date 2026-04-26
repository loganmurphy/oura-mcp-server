import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

export function loadDevVars(filePath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return vars;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

export function saveDevVars(filePath: string, vars: Record<string, string>): void {
  const existing = loadDevVars(filePath);
  const merged = { ...existing, ...vars };
  const content = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  fs.writeFileSync(filePath, content);
}

/** Open a URL in the default browser (best-effort, silent on failure). */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32"  ? "cmd" :
    "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", url] : [url];
  spawnSync(cmd, args, { stdio: "ignore" });
}

/**
 * Returns an error string if the password is too weak, or null if it passes.
 * Rules: at least 12 characters, one number, one special character.
 */
export function validatePassword(pw: string): string | null {
  if (pw.length < 12)          return "Password must be at least 12 characters.";
  if (!/[0-9]/.test(pw))       return "Password must contain at least one number.";
  if (!/[^a-zA-Z0-9]/.test(pw)) return "Password must contain at least one special character.";
  return null;
}

/** Copy text to the system clipboard (best-effort, silent on failure). */
export function copyToClipboard(text: string): boolean {
  const cmd =
    process.platform === "darwin" ? "pbcopy" :
    process.platform === "win32"  ? "clip"   :
    "xclip";
  const args = process.platform === "linux" ? ["-selection", "clipboard"] : [];
  const result = spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
  return result.status === 0;
}

