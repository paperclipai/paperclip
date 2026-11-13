import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { parseIssueAssigneeAdapterOverrides } from "../execution-workspace-policy.js";
import { projectPaperclipRunnerTaskConfig, resolvePaperclipRunnerProviderProfile } from "./provider-profile.js";

export const NATIVE_PROVIDER_MODEL_STILL_UNAVAILABLE = "native_provider_model_still_unavailable";

export type RejectedModelSetting = "agent_model" | "task_model_override";

export interface RejectedModelRetryRefusal {
  message: string;
  details: { code: typeof NATIVE_PROVIDER_MODEL_STILL_UNAVAILABLE; setting: RejectedModelSetting; rejectedModel: string; agentId: string; issueId: string | null };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function modelOf(value: unknown): string | null {
  const model = record(value).model;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

function effectiveModel(agentConfig: Record<string, unknown>, overrideConfig: Record<string, unknown>, companyId: string): string | null {
  const merged = { ...agentConfig, ...overrideConfig };
  try {
    const profile = resolvePaperclipRunnerProviderProfile(merged, { companyId });
    const config = profile.backend === "codex_app_server" || profile.backend === "opencode_server" || profile.backend === "acpx_runtime" || profile.backend === "cursor_cloud_api"
      ? projectPaperclipRunnerTaskConfig(profile.backend, agentConfig, overrideConfig) : merged;
    return modelOf({ model: resolvePaperclipRunnerProviderProfile(config, { companyId }).model });
  } catch {
    return modelOf(merged);
  }
}

export async function rejectedModelRetryRefusal(db: Pick<Db, "select">, input: {
  failedRun: { id: string; status: string; errorCode: string | null; runtimeMode?: string | null };
  agent: { id: string; companyId: string; name: string; adapterConfig: unknown };
  issue: { id: string; assigneeAgentId: string | null; assigneeAdapterOverrides: unknown } | null;
}): Promise<RejectedModelRetryRefusal | null> {
  const { agent, issue, failedRun } = input;
  if (failedRun.runtimeMode !== "native" || failedRun.status !== "failed" || failedRun.errorCode !== "native_provider_model_rejected") return null;
  const [failed] = await db.select({
    rejectedModel: sql<string | null>`${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'provider'->>'model'`,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.id, failedRun.id),
    eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "failed"),
    eq(heartbeatRuns.errorCode, "native_provider_model_rejected")));
  const rejectedModel = modelOf({ model: failed?.rejectedModel });
  if (!rejectedModel) return null;
  const overrideConfig = issue?.assigneeAgentId === agent.id ? parseIssueAssigneeAdapterOverrides(issue.assigneeAdapterOverrides)?.adapterConfig ?? null : null;
  const override = modelOf(overrideConfig);
  const configured = effectiveModel(record(agent.adapterConfig), record(overrideConfig), agent.companyId);
  if (configured !== rejectedModel) return null;
  const setting: RejectedModelSetting = override ? "task_model_override" : "agent_model";
  const change = setting === "task_model_override"
    ? "Change or clear this task's model override"
    : `Choose a supported model in ${agent.name}'s settings`;
  return {
    message: `The provider rejected the model "${rejectedModel}", and it is still selected. ${change}, then try again.`,
    details: { code: NATIVE_PROVIDER_MODEL_STILL_UNAVAILABLE, setting, rejectedModel, agentId: agent.id, issueId: issue?.id ?? null },
  };
}
