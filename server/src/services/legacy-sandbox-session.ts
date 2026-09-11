import {
  adapterExecutionTargetSessionIdentity,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Recover metadata discarded by old CLI codecs only from host-owned run evidence. */
export function recoverLegacySandboxSession(input: {
  adapterType: string;
  params: Record<string, unknown> | null;
  target: AdapterExecutionTarget | null;
  companyId: string;
  agentId: string;
  taskId: string;
  responsibleUserId: string | null;
  executionWorkspaceId: string | null;
  previousRun: {
    companyId: string;
    agentId: string;
    responsibleUserId: string | null;
    status: string;
    sessionIdAfter: string | null;
    contextSnapshot: unknown;
  } | null;
}): Record<string, unknown> | null {
  const { params, target, previousRun: previous } = input;
  if (!params || !previous || !["codex_local", "claude_local"].includes(input.adapterType)
    || target?.kind !== "remote" || target.transport !== "sandbox"
    || target.sandboxLeaseAcquisition?.outcome !== "resumed") return params;
  const saved = record(params.remoteExecution);
  if (saved.providerLeaseId || (params.remoteExecution != null && saved.transport !== "sandbox")) return params;
  const context = record(previous.contextSnapshot);
  const environment = record(context.paperclipEnvironment);
  const realization = record(environment.workspaceRealization);
  if (previous.status !== "succeeded"
    || previous.companyId !== input.companyId || previous.agentId !== input.agentId
    || previous.responsibleUserId !== input.responsibleUserId
    || !params.sessionId || previous.sessionIdAfter !== params.sessionId
    || context.taskId !== input.taskId
    || !input.executionWorkspaceId || context.executionWorkspaceId !== input.executionWorkspaceId
    || environment.driver !== "sandbox" || environment.id !== target.environmentId
    || realization.provider !== target.providerKey
    || realization.providerLeaseId !== target.sandboxLeaseAcquisition.providerLeaseId
    || params.cwd !== target.remoteCwd || environment.remoteCwd !== params.cwd
    || (params.remoteExecution != null && (
      saved.leaseId !== environment.leaseId || saved.environmentId !== environment.id
      || saved.providerKey !== target.providerKey || saved.remoteCwd !== params.cwd
    ))) return params;
  return {
    ...params, remoteExecution: adapterExecutionTargetSessionIdentity(target),
    ...(input.adapterType === "claude_local" && !params.mcpServerIdentity
      ? { legacyPlatformMcpSession: true } : {}),
  };
}
