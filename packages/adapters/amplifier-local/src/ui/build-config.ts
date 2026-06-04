/**
 * Convert the agent-creation UI's `CreateConfigValues` form into the
 * `adapterConfig` JSON blob persisted on the agent record.
 *
 * Mirrors codex-local's `buildCodexLocalConfig`: required fields get sensible
 * defaults, optional fields are only emitted when set. The result is what
 * the server's `execute.ts` parses on every run.
 */

import type { CreateConfigValues } from "@paperclipai/adapter-utils";

import { DEFAULT_AMPLIFIER_LOCAL_MODEL } from "../index.js";

interface EnvBinding {
  type: "plain" | "secret_ref";
  value: string;
}

function parseEnvBindings(
  raw: Record<string, { type?: string; value?: string }> | undefined,
): Record<string, EnvBinding> {
  if (!raw) return {};
  const out: Record<string, EnvBinding> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v === "object" && typeof v.value === "string") {
      out[k] = {
        type: v.type === "secret_ref" ? "secret_ref" : "plain",
        value: v.value,
      };
    }
  }
  return out;
}

function parseEnvVarsText(text: string | undefined): Record<string, string> {
  if (!text) return {};
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function parseCommaArgs(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function buildAmplifierLocalConfig(
  v: CreateConfigValues,
): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  ac.model = v.model || DEFAULT_AMPLIFIER_LOCAL_MODEL;

  // Operational defaults — match codex-local conventions.
  ac.timeoutSec = 0;
  ac.graceSec = 15;

  // env bindings (structured secret_ref aware) + legacy text-block env vars
  const envBindings = parseEnvBindings(
    v.envBindings as Record<string, { type?: string; value?: string }> | undefined,
  );
  const legacyEnv = parseEnvVarsText(v.envVars as string | undefined);
  for (const [k, plainValue] of Object.entries(legacyEnv)) {
    if (!Object.prototype.hasOwnProperty.call(envBindings, k)) {
      envBindings[k] = { type: "plain", value: plainValue };
    }
  }
  if (Object.keys(envBindings).length > 0) {
    ac.env = envBindings;
  }

  if (v.command) ac.command = v.command;
  if (v.extraArgs) ac.extraArgs = parseCommaArgs(v.extraArgs as string);

  // workspace strategy (matches codex-local's git_worktree handling)
  const vRec = v as unknown as Record<string, unknown>;
  if (vRec.workspaceStrategyType === "git_worktree") {
    const baseRef = typeof vRec.workspaceBaseRef === "string" ? vRec.workspaceBaseRef : "";
    const branchTemplate =
      typeof vRec.workspaceBranchTemplate === "string" ? vRec.workspaceBranchTemplate : "";
    const worktreeParentDir =
      typeof vRec.worktreeParentDir === "string" ? vRec.worktreeParentDir : "";
    ac.workspaceStrategy = {
      type: "git_worktree",
      ...(baseRef ? { baseRef } : {}),
      ...(branchTemplate ? { branchTemplate } : {}),
      ...(worktreeParentDir ? { worktreeParentDir } : {}),
    };
  }

  return ac;
}
