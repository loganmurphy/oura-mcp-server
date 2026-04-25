import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

export function claudeCfgPath(): string {
  switch (process.platform) {
    case "darwin":
      return path.join(os.homedir(), "Library/Application Support/Claude/claude_desktop_config.json");
    case "win32":
      return path.join(
        process.env["APPDATA"] ?? path.join(os.homedir(), "AppData/Roaming"),
        "Claude", "claude_desktop_config.json",
      );
    default:
      return path.join(
        process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config"),
        "Claude", "claude_desktop_config.json",
      );
  }
}

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

export function slugify(name: string, fallback = "oura-mcp"): string {
  // workers.dev subdomain rules: 3-63 chars, a-z / 0-9 / -, no leading/trailing -.
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return slug.length >= 3 ? slug : fallback;
}
