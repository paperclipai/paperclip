import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveSharedClaudeConfigDir } from "./claude-config.js";

const execFileAsync = promisify(execFile);

const API_KEY_HELPER_TIMEOUT_MS = 5_000;

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Read the `apiKeyHelper` command string from the shared Claude settings.json.
 * Claude Code itself invokes this helper to resolve the API key; Paperclip
 * mirrors it for billing attribution and live model discovery without ever
 * placing the key into a child-process environment.
 */
export async function readClaudeApiKeyHelperCommand(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const configDir = resolveSharedClaudeConfigDir(env);
  let raw: string;
  try {
    raw = await fs.readFile(path.join(configDir, "settings.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const helper = (parsed as Record<string, unknown>)["apiKeyHelper"];
  return nonEmpty(typeof helper === "string" ? helper : null);
}

/**
 * Execute the `apiKeyHelper` command and return its trimmed stdout as the API
 * key. Never throws: any failure resolves to null so callers fall back safely.
 */
export async function runClaudeApiKeyHelper(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("/bin/sh", ["-c", command], {
      env: env as Record<string, string>,
      timeout: API_KEY_HELPER_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return nonEmpty(stdout);
  } catch {
    return null;
  }
}

/**
 * Resolve the API key Claude would use via `apiKeyHelper` (the settings.json
 * command), independent of the `ANTHROPIC_API_KEY` env var. Returns null when
 * no helper is configured or it fails. This is the post-cutover fallback for
 * billing/model discovery once `paperclip-run.sh` stops exporting the env var.
 */
export async function resolveClaudeApiKeyHelperKey(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const command = await readClaudeApiKeyHelperCommand(env);
  if (!command) return null;
  return runClaudeApiKeyHelper(command, env);
}
