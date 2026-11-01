const common = [
  "actorAgentId", "actorUserId", "actorRunId", "actorRunStopId",
  "actorPrincipalType", "actorResponsibleUserId", "responsibleUserId", "trustExplicitResponsibleUserId",
  "createdByAgentId", "createdByUserId", "originRunId", "watchdogActorRunId",
  "checkoutRunId", "executionRunId", "originIdentityContextId", "continuationIdentityContextId",
  "authorizationActor", "bindRuntimeSharedWorkspace", "options",
  "workspaceSelectionActor", "workspaceSelection", "workspaceSelectionSource", "conversationHandoff", "caseHandoffId",
] as const;

export function rejectPluginIssueActorClaims(
  input: Record<string, unknown>,
  operation: "create" | "update",
): void {
  const forbidden: readonly string[] = operation === "update"
    ? [...common, "companyId", "companyGuard", "expectedExecutionPolicy", "expectedStatusVersion"]
    : common;
  for (const key of forbidden) {
    if (input[key] !== undefined && input[key] !== null) {
      throw new Error(`Plugin-supplied ${key} is not authenticated; trusted delegation is unavailable`);
    }
  }
}

export function stripPluginIssueUpdateOverrides(input: Record<string, unknown>): Record<string, unknown> {
  const result = { ...input };
  for (const key of [...common, "companyId", "companyGuard", "expectedExecutionPolicy", "expectedStatusVersion"]) delete result[key];
  return result;
}
