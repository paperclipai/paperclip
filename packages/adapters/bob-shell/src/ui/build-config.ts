/**
 * Build adapter configuration from UI form values for IBM Bob Shell.
 */

import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_TIMEOUT_SEC, DEFAULT_MAX_TURNS } from "../shared/constants.js";

function parseEnvVars(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = value;
  }
  return env;
}

function parseEnvBindings(bindings: unknown): Record<string, unknown> {
  if (typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) return {};
  const env: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(bindings)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (typeof raw === "string") {
      env[key] = { type: "plain", value: raw };
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    if (rec.type === "plain" && typeof rec.value === "string") {
      env[key] = { type: "plain", value: rec.value };
      continue;
    }
    if (rec.type === "secret_ref" && typeof rec.secretId === "string") {
      env[key] = {
        type: "secret_ref",
        secretId: rec.secretId,
        ...(typeof rec.version === "number" || rec.version === "latest"
          ? { version: rec.version }
          : {}),
      };
      continue;
    }
    if (rec.type === "user_secret_ref" && typeof rec.secretId === "string") {
      env[key] = {
        type: "user_secret_ref",
        secretId: rec.secretId,
        ...(typeof rec.version === "number" || rec.version === "latest"
          ? { version: rec.version }
          : {}),
      };
    }
  }
  return env;
}

/**
 * Build a Bob Shell adapter config from Paperclip UI form values.
 */
export function buildBobShellConfig(
  v: CreateConfigValues,
): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  // Working directory for the bob run process
  if (v.cwd) {
    ac.cwd = v.cwd;
  }

  // Custom bob binary path
  if (v.command) {
    ac.bobCommand = v.command;
  }

  // Execution timeout
  ac.timeoutSec = DEFAULT_TIMEOUT_SEC;

  // Max turns limit
  if (v.maxTurnsPerRun > 0) {
    ac.maxTurns = v.maxTurnsPerRun;
    // Scale timeout generously: ~20s per turn as minimum headroom
    ac.timeoutSec = Math.max(DEFAULT_TIMEOUT_SEC, v.maxTurnsPerRun * 20);
  } else {
    ac.maxTurns = DEFAULT_MAX_TURNS;
  }

  // Prompt template
  if (v.promptTemplate) {
    ac.promptTemplate = v.promptTemplate;
  }

  // Extra CLI arguments
  if (v.extraArgs) {
    ac.extraArgs = v.extraArgs.split(/\s+/).filter(Boolean);
  }

  // Environment variables (plain text KEY=VALUE and secret bindings)
  const env = parseEnvBindings(v.envBindings);
  const legacy = parseEnvVars(v.envVars);
  for (const [key, value] of Object.entries(legacy)) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      env[key] = { type: "plain", value };
    }
  }
  if (Object.keys(env).length > 0) ac.env = env;

  return ac;
}
