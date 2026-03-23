import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

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
    }
  }
  return env;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Build Kiro adapter config from form values.
 */
export function buildAdapterConfig(values: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  if (values.cwd && values.cwd.trim()) {
    config.cwd = values.cwd.trim();
  }
  if (values.instructionsFilePath && values.instructionsFilePath.trim()) {
    config.instructionsFilePath = values.instructionsFilePath.trim();
  }
  if (values.promptTemplate) {
    config.promptTemplate = values.promptTemplate;
  }
  if (values.bootstrapPrompt) {
    config.bootstrapPromptTemplate = values.bootstrapPrompt;
  }
  if (values.model && values.model.trim()) {
    config.model = values.model.trim();
  }
  config.timeoutSec = 0;
  config.graceSec = 15;

  // Structured env bindings + legacy env vars
  const env = parseEnvBindings(values.envBindings);
  const legacy = parseEnvVars(values.envVars ?? "");
  for (const [key, value] of Object.entries(legacy)) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      env[key] = { type: "plain", value };
    }
  }
  if (Object.keys(env).length > 0) config.env = env;

  // Workspace strategy
  if (values.workspaceStrategyType === "git_worktree") {
    config.workspaceStrategy = {
      type: "git_worktree",
      ...(values.workspaceBaseRef ? { baseRef: values.workspaceBaseRef } : {}),
      ...(values.workspaceBranchTemplate ? { branchTemplate: values.workspaceBranchTemplate } : {}),
      ...(values.worktreeParentDir ? { worktreeParentDir: values.worktreeParentDir } : {}),
    };
  }

  // Runtime services
  const runtimeServices = parseJsonObject(values.runtimeServicesJson ?? "");
  if (runtimeServices && Array.isArray(runtimeServices.services)) {
    config.workspaceRuntime = runtimeServices;
  }

  if (values.command && values.command.trim()) {
    config.command = values.command.trim();
  }
  if (values.extraArgs && values.extraArgs.trim()) {
    config.extraArgs = parseCommaArgs(values.extraArgs);
  }

  return config;
}
