/**
 * Interactive terminal prompts for the bootstrap wizard.
 * Uses raw stdin for hidden input, readline for everything else.
 */

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

// ── Colors / formatting ───────────────────────────────────────────────────────
export const c = {
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue:   (s: string) => `\x1b[34m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
};

export const ok = (msg: string)    => console.log(`  ${c.green("✓")} ${msg}`);
export const info = (msg: string)  => console.log(`  ${c.dim("•")} ${c.dim(msg)}`);
export const warn = (msg: string)  => console.log(`  ${c.yellow("!")} ${msg}`);
export const fail = (msg: string)  => console.log(`  ${c.red("✗")} ${msg}`);

// Strip ANSI escape codes for visual-length calculations.
const ANSI_RE = /\u001b\[[0-9;]*m/g;
const visualLen = (s: string) => s.replace(ANSI_RE, "").length;
const padVisual = (s: string, width: number) =>
  s + " ".repeat(Math.max(0, width - visualLen(s)));

export function banner(title: string, lines: string[]) {
  const width = Math.max(visualLen(title), ...lines.map(visualLen)) + 4;
  const bar = "─".repeat(width);
  console.log(`\n┌${bar}┐`);
  console.log(`│  ${padVisual(c.bold(title), width - 2)}│`);
  console.log(`├${bar}┤`);
  for (const l of lines) console.log(`│  ${padVisual(l, width - 2)}│`);
  console.log(`└${bar}┘\n`);
}

export function step(n: number, title: string) {
  console.log(`\n${c.bold(c.cyan(`── Step ${n} ──`))}  ${c.bold(title)}`);
}

// ── Input helpers ────────────────────────────────────────────────────────────

let rl: readline.Interface | null = null;

function getRl(): readline.Interface {
  if (!rl) rl = readline.createInterface({ input: stdin, output: stdout });
  return rl;
}

export function closePrompts() {
  if (rl) { rl.close(); rl = null; }
}

/** Plain text prompt. Returns trimmed input, or `fallback` if blank. */
export async function prompt(question: string, fallback = ""): Promise<string> {
  const suffix = fallback ? c.dim(` [${fallback}]`) : "";
  const answer = (await getRl().question(`  ${question}${suffix}: `)).trim();
  return answer || fallback;
}

/** Yes/no. Returns boolean. */
export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const raw = (await getRl().question(`  ${question} ${c.dim(`[${hint}]`)}: `)).trim().toLowerCase();
  if (!raw) return defaultYes;
  return raw === "y" || raw === "yes";
}

/** Pick from a list (1-indexed). Returns the index of the choice. */
export async function pick<T>(
  question: string,
  items: T[],
  formatter: (t: T) => string,
  defaultIdx = 0,
): Promise<number> {
  console.log(`  ${question}`);
  items.forEach((item, i) => {
    const marker = i === defaultIdx ? c.cyan("●") : c.dim("○");
    console.log(`    ${marker} ${c.dim(`[${i + 1}]`)} ${formatter(item)}`);
  });
  while (true) {
    const raw = (await getRl().question(`  Choice ${c.dim(`[${defaultIdx + 1}]`)}: `)).trim();
    if (!raw) return defaultIdx;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return n - 1;
    warn(`Please enter 1-${items.length}`);
  }
}

/**
 * Hidden-input prompt (masks with asterisks). Uses raw stdin mode.
 * We pause readline while this runs and resume after.
 */
export async function promptHidden(question: string): Promise<string> {
  if (rl) { rl.close(); rl = null; }

  return new Promise<string>((resolve) => {
    stdout.write(`  ${question}: `);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let input = "";

    const onData = (key: string) => {
      for (const ch of key) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          stdout.write("\n");
          resolve(input);
          return;
        } else if (ch === "\u0003") {
          // Ctrl+C
          stdin.setRawMode(false);
          stdout.write("\n");
          process.exit(130);
        } else if (ch === "\u007f" || ch === "\b") {
          if (input.length > 0) {
            input = input.slice(0, -1);
            stdout.write("\b \b");
          }
        } else if (ch >= " ") {
          input += ch;
          stdout.write("*");
        }
      }
    };

    stdin.on("data", onData);
  });
}

/** Wait for the user to press Enter. */
export async function pressEnter(message = "Press Enter to continue..."): Promise<void> {
  await getRl().question(`  ${c.dim(message)}`);
}
