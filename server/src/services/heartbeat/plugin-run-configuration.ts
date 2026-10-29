import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { heartbeatRuns, pluginCompanySettings, plugins, type Db } from "@paperclipai/db";
import {
  PLUGIN_RUN_ADAPTER_CONFIG_KEYS, PLUGIN_RUN_CONFIGURATION_CAPABILITY, pickPluginRunAdapterConfig, pluginPrepareAgentRunResultSchema,
  type PluginPrepareAgentRunRequest, type PluginRunAdapterConfig,
} from "@paperclipai/shared";
import { parseObject } from "../../adapters/utils.js";
import { logger } from "../../middleware/logger.js";
import type { parseIssueAssigneeAdapterOverrides } from "../execution-workspace-policy.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import type { createHeartbeatLifecycle } from "./run-lifecycle.js";

type ParsedIssueAssigneeAdapterOverrides = ReturnType<typeof parseIssueAssigneeAdapterOverrides>;

export const PLUGIN_RUN_CONFIGURATION_TIMEOUT_MS = 1500;
const ISSUE_DESCRIPTION_MAX_CHARS = 16_000;

export interface PluginRunConfigurator {
  id: string;
  pluginKey: string;
  capabilities: readonly string[];
}

export interface PluginRunConfigurationDecision {
  pluginKey: string;
  adapterConfig: PluginRunAdapterConfig;
  reason?: string;
}

export interface PluginRunConfiguration {
  runId: string;
  adapterConfig: PluginRunAdapterConfig;
  decisions: PluginRunConfigurationDecision[];
}

export interface PluginRunConfigurationInput {
  run: typeof heartbeatRuns.$inferSelect;
  agent: { id: string; companyId: string; adapterType: string };
  config: Record<string, unknown>;
  issue: { id: string; identifier: string | null; title: string; description: string | null } | null;
  issueOverrides: ParsedIssueAssigneeAdapterOverrides;
  context: Record<string, unknown>;
}

export async function listPluginRunConfigurators(db: Db, companyId: string): Promise<PluginRunConfigurator[]> {
  const rows = await db.select({ id: plugins.id, pluginKey: plugins.pluginKey, manifestJson: plugins.manifestJson })
    .from(plugins)
    .leftJoin(pluginCompanySettings, and(eq(pluginCompanySettings.pluginId, plugins.id), eq(pluginCompanySettings.companyId, companyId)))
    .where(and(
      eq(plugins.status, "ready"),
      sql`${plugins.manifestJson} -> 'capabilities' @> ${JSON.stringify([PLUGIN_RUN_CONFIGURATION_CAPABILITY])}::jsonb`,
      or(isNull(pluginCompanySettings.enabled), eq(pluginCompanySettings.enabled, true)),
    ))
    .orderBy(asc(plugins.installOrder), asc(plugins.id));
  return rows.map((row) => ({ id: row.id, pluginKey: row.pluginKey, capabilities: row.manifestJson.capabilities }));
}

export async function requestPluginRunConfiguration(
  workerManager: Pick<PluginWorkerManager, "isRunning" | "getWorker" | "call">,
  configurators: readonly PluginRunConfigurator[],
  request: PluginPrepareAgentRunRequest,
): Promise<PluginRunConfigurationDecision[]> {
  const callable = configurators.filter((plugin) => plugin.capabilities.includes(PLUGIN_RUN_CONFIGURATION_CAPABILITY)
    && workerManager.isRunning(plugin.id)
    && (workerManager.getWorker(plugin.id)?.supportedMethods ?? []).includes("prepareAgentRun"));
  const results = await Promise.all(callable.map(async (plugin) => {
    const pluginRequest = plugin.capabilities.includes("issues.read") ? request : { ...request, issue: null };
    try {
      const raw = await workerManager.call(plugin.id, "prepareAgentRun", pluginRequest, PLUGIN_RUN_CONFIGURATION_TIMEOUT_MS);
      const parsed = pluginPrepareAgentRunResultSchema.safeParse(raw ?? null);
      if (!parsed.success) {
        logger.warn({ pluginId: plugin.id, pluginKey: plugin.pluginKey, runId: request.runId, issues: parsed.error.issues },
          "plugin run configuration result rejected");
        return null;
      }
      const adapterConfig = pickPluginRunAdapterConfig(parsed.data?.adapterConfig ?? null);
      if (Object.keys(adapterConfig).length === 0) return null;
      return { pluginKey: plugin.pluginKey, adapterConfig, ...(parsed.data?.reason ? { reason: parsed.data.reason } : {}) };
    } catch (err) {
      logger.warn({ err, pluginId: plugin.id, pluginKey: plugin.pluginKey, runId: request.runId }, "plugin run configuration failed");
      return null;
    }
  }));
  return results.filter((decision): decision is PluginRunConfigurationDecision => decision !== null);
}

export function mergePluginRunDecisions(decisions: readonly PluginRunConfigurationDecision[]): PluginRunAdapterConfig {
  const merged: PluginRunAdapterConfig = {};
  for (const decision of decisions) {
    for (const key of PLUGIN_RUN_ADAPTER_CONFIG_KEYS) {
      const value = decision.adapterConfig[key];
      if (value !== undefined && merged[key] === undefined) merged[key] = value;
    }
  }
  return merged;
}

export function applyPluginRunAdapterConfig(
  overrides: ParsedIssueAssigneeAdapterOverrides,
  adapterConfig: PluginRunAdapterConfig,
): ParsedIssueAssigneeAdapterOverrides {
  if (Object.keys(adapterConfig).length === 0) return overrides;
  return {
    adapterConfig: { ...adapterConfig, ...(overrides?.adapterConfig ?? {}) },
    useProjectWorkspace: overrides?.useProjectWorkspace ?? null,
  };
}

function readPersistedPluginRunConfiguration(context: Record<string, unknown>, runId: string): PluginRunConfiguration | null {
  const stored = parseObject(context.pluginRunConfiguration);
  if (stored.runId !== runId) return null;
  return { runId, adapterConfig: pickPluginRunAdapterConfig(parseObject(stored.adapterConfig)),
    decisions: Array.isArray(stored.decisions) ? stored.decisions as PluginRunConfigurationDecision[] : [] };
}

export async function applyPluginRunConfiguration(
  db: Db,
  input: PluginRunConfigurationInput,
  services: {
    workerManager?: PluginWorkerManager;
    appendRunEvent: ReturnType<typeof createHeartbeatLifecycle>["appendRunEvent"];
  },
): Promise<ParsedIssueAssigneeAdapterOverrides> {
  const { run, agent, context } = input;
  const persisted = readPersistedPluginRunConfiguration(context, run.id);
  if (persisted) return applyPluginRunAdapterConfig(input.issueOverrides, persisted.adapterConfig);
  if (!services.workerManager) return input.issueOverrides;
  const configurators = await listPluginRunConfigurators(db, agent.companyId);
  if (configurators.length === 0) return input.issueOverrides;
  const issue = input.issue
    ? { ...input.issue, description: input.issue.description?.slice(0, ISSUE_DESCRIPTION_MAX_CHARS) ?? null }
    : null;
  const decisions = await requestPluginRunConfiguration(services.workerManager, configurators, {
    companyId: agent.companyId,
    agentId: agent.id,
    runId: run.id,
    adapterType: agent.adapterType,
    invocationSource: run.invocationSource,
    wakeReason: typeof context.wakeReason === "string" ? context.wakeReason : null,
    retryAttempt: run.scheduledRetryAttempt ?? 0,
    issueId: input.issue?.id ?? null,
    issue,
    adapterConfig: pickPluginRunAdapterConfig(input.config),
    issueOverrides: pickPluginRunAdapterConfig(input.issueOverrides?.adapterConfig ?? null),
  });
  const adapterConfig = mergePluginRunDecisions(decisions);
  if (Object.keys(adapterConfig).length === 0) return input.issueOverrides;
  const configuration: PluginRunConfiguration = { runId: run.id, adapterConfig, decisions };
  context.pluginRunConfiguration = configuration;
  await db.update(heartbeatRuns)
    .set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({ pluginRunConfiguration: configuration })}::jsonb` })
    .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, agent.companyId)));
  await services.appendRunEvent(run, {
    eventType: "plugin_run_configuration", stream: "system", level: "info",
    message: "Plugin set run configuration",
    payload: { adapterConfig, decisions, overriddenByIssue: Object.keys(pickPluginRunAdapterConfig(input.issueOverrides?.adapterConfig ?? null)) },
  });
  return applyPluginRunAdapterConfig(input.issueOverrides, adapterConfig);
}
