import { Command } from "commander";
import type { MasterRuntimeFailoverSettings } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

const DEFAULT_MASTER_RUNTIME_FAILOVER: MasterRuntimeFailoverSettings = {
  mode: "auto",
  claudeLimitedUntil: null,
  codexLimitedUntil: null,
  activeRuntime: null,
  reason: null,
  updatedAt: null,
};

type RuntimeOptions = BaseClientOptions & {
  clearLimits?: boolean;
};

type RuntimeMode = MasterRuntimeFailoverSettings["mode"];

function normalizeMasterRuntimeFailover(value: unknown): MasterRuntimeFailoverSettings {
  const record = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Partial<MasterRuntimeFailoverSettings>
    : {};
  return {
    mode: record.mode ?? DEFAULT_MASTER_RUNTIME_FAILOVER.mode,
    claudeLimitedUntil: record.claudeLimitedUntil ?? null,
    codexLimitedUntil: record.codexLimitedUntil ?? null,
    activeRuntime: record.activeRuntime ?? null,
    reason: record.reason ?? null,
    updatedAt: record.updatedAt ?? null,
  };
}

async function getExperimentalSettings(options: BaseClientOptions): Promise<Record<string, unknown>> {
  const { api } = resolveCommandContext(options);
  return await api.get<Record<string, unknown>>("/api/instance/settings/experimental") ?? {};
}

async function printRuntimeStatus(options: BaseClientOptions): Promise<void> {
  const experimental = await getExperimentalSettings(options);
  const masterRuntimeFailover = normalizeMasterRuntimeFailover(experimental.masterRuntimeFailover);
  printOutput({
    masterRuntimeFailover,
    commandHints: {
      forceCodex: "paperclipai runtime force-codex",
      rollback: "paperclipai runtime auto",
      clearLimits: "paperclipai runtime clear-limits",
    },
  }, { json: options.json, label: "Master runtime failover" });
}

function nextMasterRuntimeFailover(
  current: MasterRuntimeFailoverSettings,
  mode: RuntimeMode,
  options: RuntimeOptions,
): MasterRuntimeFailoverSettings {
  const clearLimits = options.clearLimits === true;
  return {
    ...current,
    mode,
    ...(clearLimits
      ? {
          claudeLimitedUntil: null,
          codexLimitedUntil: null,
        }
      : {}),
    activeRuntime: mode === "force_claude" ? "claude" : mode === "force_codex" ? "codex" : null,
    reason: mode === "auto"
      ? clearLimits ? "manual_auto_clear_limits" : "manual_auto"
      : mode === "force_codex"
        ? clearLimits ? "manual_force_codex_clear_limits" : "manual_force_codex"
        : clearLimits ? "manual_force_claude_clear_limits" : "manual_force_claude",
    updatedAt: new Date().toISOString(),
  };
}

async function setRuntimeMode(mode: RuntimeMode, options: RuntimeOptions): Promise<void> {
  const { api } = resolveCommandContext(options);
  const experimental = await api.get<Record<string, unknown>>("/api/instance/settings/experimental") ?? {};
  const current = normalizeMasterRuntimeFailover(experimental.masterRuntimeFailover);
  const masterRuntimeFailover = nextMasterRuntimeFailover(current, mode, options);
  const updated = await api.patch<Record<string, unknown>>(
    "/api/instance/settings/experimental",
    { masterRuntimeFailover },
  ) ?? {};
  printOutput({
    masterRuntimeFailover: normalizeMasterRuntimeFailover(updated.masterRuntimeFailover),
    effect: mode === "force_codex"
      ? "All claude_local and codex_local master-runtime executions now route through codex_local."
      : mode === "force_claude"
        ? "All claude_local and codex_local master-runtime executions now route through claude_local."
        : "Master-runtime routing is back in automatic failover mode.",
  }, { json: options.json, label: "Updated master runtime failover" });
}

async function clearRuntimeLimits(options: BaseClientOptions): Promise<void> {
  const { api } = resolveCommandContext(options);
  const experimental = await api.get<Record<string, unknown>>("/api/instance/settings/experimental") ?? {};
  const current = normalizeMasterRuntimeFailover(experimental.masterRuntimeFailover);
  const masterRuntimeFailover: MasterRuntimeFailoverSettings = {
    ...current,
    claudeLimitedUntil: null,
    codexLimitedUntil: null,
    activeRuntime: current.mode === "force_claude" ? "claude" : current.mode === "force_codex" ? "codex" : null,
    reason: "manual_clear_limits",
    updatedAt: new Date().toISOString(),
  };
  const updated = await api.patch<Record<string, unknown>>(
    "/api/instance/settings/experimental",
    { masterRuntimeFailover },
  ) ?? {};
  printOutput({
    masterRuntimeFailover: normalizeMasterRuntimeFailover(updated.masterRuntimeFailover),
    effect: "Cleared stored Claude/Codex cooldown windows without changing the selected routing mode.",
  }, { json: options.json, label: "Cleared master runtime limits" });
}

export function registerRuntimeCommands(program: Command): void {
  const runtime = program.command("runtime").description("Instance runtime failover controls");

  addCommonClientOptions(
    runtime
      .command("status")
      .description("Show master runtime failover mode and stored cooldown windows"),
  ).action(async (options: BaseClientOptions) => {
    try {
      await printRuntimeStatus(options);
    } catch (err) {
      handleCommandError(err);
    }
  });

  addCommonClientOptions(
    runtime
      .command("force-codex")
      .description("Route all Claude/Codex master-runtime executions through codex_local")
      .option("--clear-limits", "Clear stored Claude/Codex cooldown windows while switching", false),
  ).action(async (options: RuntimeOptions) => {
    try {
      await setRuntimeMode("force_codex", options);
    } catch (err) {
      handleCommandError(err);
    }
  });

  addCommonClientOptions(
    runtime
      .command("force-claude")
      .description("Route all Claude/Codex master-runtime executions through claude_local")
      .option("--clear-limits", "Clear stored Claude/Codex cooldown windows while switching", false),
  ).action(async (options: RuntimeOptions) => {
    try {
      await setRuntimeMode("force_claude", options);
    } catch (err) {
      handleCommandError(err);
    }
  });

  addCommonClientOptions(
    runtime
      .command("auto")
      .description("Return master-runtime routing to automatic Claude/Codex failover")
      .option("--clear-limits", "Clear stored Claude/Codex cooldown windows while switching", false),
  ).action(async (options: RuntimeOptions) => {
    try {
      await setRuntimeMode("auto", options);
    } catch (err) {
      handleCommandError(err);
    }
  });

  addCommonClientOptions(
    runtime
      .command("clear-limits")
      .description("Clear stored Claude/Codex cooldown windows without changing routing mode"),
  ).action(async (options: BaseClientOptions) => {
    try {
      await clearRuntimeLimits(options);
    } catch (err) {
      handleCommandError(err);
    }
  });
}
