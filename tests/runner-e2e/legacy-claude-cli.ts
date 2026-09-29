import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

// 2.1.19 predates --add-dir skill discovery. Keep local/CI qualification
// reproducible without replacing a developer's globally installed CLI.
export const LEGACY_CLAUDE_CLI_VERSION = "2.1.277";
const execute = promisify(execFile);
export function qualifiedLegacyClaudeVersion(output: string) {
  return output.trim() === `${LEGACY_CLAUDE_CLI_VERSION} (Claude Code)`;
}

export async function createLegacyClaudeLauncher(prefix: string) {
  const bin = path.join(prefix, "qualified-bin");
  const wrapper = path.join(prefix, "node_modules", "@anthropic-ai", "claude-code", "cli-wrapper.cjs");
  await mkdir(bin, { recursive: true });
  // The package ships this launcher specifically for --ignore-scripts installs.
  await writeFile(path.join(bin, "claude"), `#!/usr/bin/env node\nrequire(${JSON.stringify(wrapper)});\n`, { mode: 0o755 });
  return bin;
}

export async function qualifyLegacyClaudeCli(temporaryRoot: string, environment: NodeJS.ProcessEnv) {
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TEMP", "SystemRoot"]
    .flatMap(key => environment[key] ? [[key, environment[key]!]] : []));
  try {
    const result = await execute("claude", ["--version"], { env, timeout: 15_000 });
    if (qualifiedLegacyClaudeVersion(result.stdout)) return environment.PATH ?? "";
  } catch { /* Install the exact fixture version in the attempt's private root. */ }
  const prefix = path.join(temporaryRoot, "legacy-claude-cli");
  await execute("npm", ["install", "--prefix", prefix, "--no-save", "--no-package-lock", "--no-audit", "--no-fund", "--ignore-scripts",
    `@anthropic-ai/claude-code@${LEGACY_CLAUDE_CLI_VERSION}`], { env, timeout: 120_000, maxBuffer: 1024 * 1024 });
  const bin = await createLegacyClaudeLauncher(prefix);
  const result = await execute(path.join(bin, "claude"), ["--version"], { env, timeout: 15_000 });
  if (!qualifiedLegacyClaudeVersion(result.stdout)) throw new Error("Legacy Claude CLI version qualification failed");
  return `${bin}${path.delimiter}${environment.PATH ?? ""}`;
}
