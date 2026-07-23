import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterBillingType,
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { createAcpxEngineExecutor } from "@paperclipai/adapter-utils/acpx-engine/execute";
import {
  DEFAULT_ACP_ENGINE_MODE,
  DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS,
  DEFAULT_ACP_ENGINE_PERMISSION_MODE,
  DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
} from "@paperclipai/adapter-utils/acpx-engine/constants";
import {
  asNumber,
  asString,
  asStringArray,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRootDir = path.resolve(moduleDir, "../..");

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function resolveCopilotHome(config: Record<string, unknown>): string {
  const env = parseObject(config.env);
  return (
    asString(env.COPILOT_HOME, "").trim() ||
    process.env.COPILOT_HOME?.trim() ||
    path.join(os.homedir(), ".copilot")
  );
}

export function buildCopilotAcpCommand(config: Record<string, unknown>): string {
  const override = asString(config.agentCommand, "").trim();
  if (override) return override;

  const command = asString(config.command, "copilot").trim() || "copilot";
  const model = asString(config.model, "").trim();
  const reasoningEffort = firstNonEmptyString(config.reasoningEffort, config.modelReasoningEffort);
  const contextTier = asString(config.contextTier, "").trim();
  const args = [
    "--acp",
    "--stdio",
    "--no-auto-update",
    "--no-remote",
    "--no-remote-export",
    "--no-color",
    "--log-level",
    "error",
    "--secret-env-vars=COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN",
  ];
  if (model) args.push("--model", model);
  if (reasoningEffort) args.push("--effort", reasoningEffort);
  if (contextTier === "default" || contextTier === "long_context") {
    args.push("--context", contextTier);
  }
  args.push(...asStringArray(config.extraArgs));

  return [shellQuote(command), ...args.map(shellQuote)].join(" ");
}

export function buildCopilotAcpConfig(config: Record<string, unknown>): Record<string, unknown> {
  const env = parseObject(config.env);
  return {
    ...config,
    agent: "copilot",
    agentCommand: buildCopilotAcpCommand(config),
    mode: asString(config.mode, DEFAULT_ACP_ENGINE_MODE),
    permissionMode: asString(config.permissionMode, DEFAULT_ACP_ENGINE_PERMISSION_MODE),
    nonInteractivePermissions: asString(
      config.nonInteractivePermissions,
      DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS,
    ),
    warmHandleIdleMs: asNumber(
      config.warmHandleIdleMs,
      DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
    ),
    env: {
      ...env,
      COPILOT_AUTO_UPDATE: "false",
      COPILOT_HOME: resolveCopilotHome(config),
    },
  };
}

function resolveCopilotBillingIdentity(
  ctx: AdapterExecutionContext,
): { provider: string; biller: string; billingType: AdapterBillingType } {
  const envConfig = parseObject(parseObject(ctx.config).env);
  const mergedEnv = {
    ...process.env,
    ...Object.fromEntries(
      Object.entries(envConfig).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  };
  const providerBaseUrl = firstNonEmptyString(mergedEnv.COPILOT_PROVIDER_BASE_URL);
  if (providerBaseUrl) {
    return {
      provider: firstNonEmptyString(mergedEnv.COPILOT_PROVIDER_TYPE) ?? "openai",
      biller: "byok",
      billingType: "api",
    };
  }
  return {
    provider: "github_copilot",
    biller: "github",
    billingType: "subscription",
  };
}

const executeCopilotAcp = createAcpxEngineExecutor({
  adapterType: "copilot_local",
  moduleDir,
  packageRootDir,
  resolveBillingIdentity: resolveCopilotBillingIdentity,
});

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  if (ctx.executionTarget?.kind === "remote") {
    throw new Error("GitHub Copilot CLI is currently supported only on local execution targets.");
  }
  const config = buildCopilotAcpConfig(ctx.config);
  return executeCopilotAcp({
    ...ctx,
    config,
  });
}
