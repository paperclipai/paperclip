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
  const workspace = record(context.paperclipWorkspace);
  const local = record(realization.local);
  // Old CLI codecs persisted the host checkout path even when the provider
  // conversation lived in the sandbox. Translate only the exact path and
  // workspace recorded by the successful host run; never accept another path.
  const savedHostCwd = typeof params.cwd === "string" && params.cwd.length > 0
    && (params.cwd === workspace.cwd || workspace.cwd === target.remoteCwd)
    && params.cwd === local.path
    && typeof params.workspaceId === "string" && params.workspaceId.length > 0
    && params.workspaceId === workspace.workspaceId
    && params.workspaceId === local.projectWorkspaceId;
  if (previous.status !== "succeeded"
    || previous.companyId !== input.companyId || previous.agentId !== input.agentId
    || previous.responsibleUserId !== input.responsibleUserId
    || !params.sessionId || previous.sessionIdAfter !== params.sessionId
    || context.taskId !== input.taskId
    || !input.executionWorkspaceId || context.executionWorkspaceId !== input.executionWorkspaceId
    || environment.driver !== "sandbox" || environment.id !== target.environmentId
    || realization.provider !== target.providerKey
    || realization.providerLeaseId !== target.sandboxLeaseAcquisition.providerLeaseId
    || environment.remoteCwd !== target.remoteCwd
    || (params.cwd !== target.remoteCwd && !savedHostCwd)
    || (params.remoteExecution != null && (
      saved.leaseId !== environment.leaseId || saved.environmentId !== environment.id
      || saved.providerKey !== target.providerKey || saved.remoteCwd !== params.cwd
    ))) return params;
  return {
    ...params, cwd: target.remoteCwd, remoteExecution: adapterExecutionTargetSessionIdentity(target),
    ...(input.adapterType === "claude_local" && !params.mcpServerIdentity
      ? { legacyPlatformMcpSession: true } : {}),
  };
}

/** Restore only the historical run-scoped gateway identity omitted by old codecs. */
export function recoverLegacyClaudeMcpIdentity(input: {
  params: Record<string, unknown>;
  previousRunId: string;
  companyId: string;
  agentId: string;
  taskId: string;
  paperclipApiUrl: string;
  invocations: Array<{ payload: unknown }>;
  gateways: Array<{
    companyId: string; subjectType: string; subjectId: string | null; createdByAgentId: string | null;
    gatewayCompanyId: string; gatewayPublicId: string; metadata: unknown;
  }>;
}): Record<string, unknown> {
  const { params } = input;
  if (params.mcpServerIdentity || params.legacyPlatformMcpSession !== true) return params;
  // Target continuity proves a sandbox identity, not its historical tool set.
  // A failed reconstruction must never bless missing/purged external grants.
  const rejected = { ...params, legacyPlatformMcpSession: false };
  if (input.invocations.length !== 1 || input.gateways.length !== 1) return rejected;
  const invocation = record(input.invocations[0].payload);
  const context = record(invocation.context);
  const env = record(invocation.env);
  // The API variable may name a per-run localhost bridge. The host-authored
  // broker URL records the real origin; absence is not evidence of equivalence.
  if (invocation.adapterType !== "claude_local" || context.taskId !== input.taskId
    || typeof env.PAPERCLIP_GITHUB_BROKER_URL !== "string") return rejected;
  let origin: string;
  try {
    const current = new URL(input.paperclipApiUrl);
    const previous = new URL(env.PAPERCLIP_GITHUB_BROKER_URL);
    if (!["http:", "https:"].includes(current.protocol) || current.origin !== previous.origin
      || current.username || current.password || previous.username || previous.password
      || current.pathname !== "/" || previous.pathname !== "/"
      || current.search || current.hash || previous.search || previous.hash) return rejected;
    origin = current.origin;
  } catch { return rejected; }
  const notes = Array.isArray(invocation.commandNotes) ? invocation.commandNotes : [];
  // This historical implementation supplied exactly one platform server and
  // one assignment gateway. Do not reconstruct an unknown/custom server set.
  if (!notes.some((note) => typeof note === "string" && /^Using 2 Paperclip-managed MCP server\(s\) from strict config /.test(note))) return rejected;
  const gateway = input.gateways[0];
  const metadata = record(gateway.metadata);
  if (gateway.companyId !== input.companyId || gateway.gatewayCompanyId !== input.companyId
    || gateway.subjectType !== "heartbeat_run" || gateway.subjectId !== input.previousRunId
    || gateway.createdByAgentId !== input.agentId || metadata.agentId !== input.agentId
    || !/^gw_[a-f0-9]{32}$/.test(gateway.gatewayPublicId)
    || typeof metadata.nativeRuntimeAssignmentDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(metadata.nativeRuntimeAssignmentDigest)) return rejected;
  return { ...rejected, mcpServerIdentity: JSON.stringify([
    { name: "Paperclip connections", url: `${origin}/mcp/runtime-tools`, connectionId: "paperclip-runtime-tools" },
    { name: "paperclip-assigned", url: `${origin}/mcp/gateways/${gateway.gatewayPublicId}`, connectionId: `assignment:${metadata.nativeRuntimeAssignmentDigest}` },
  ]) };
}
