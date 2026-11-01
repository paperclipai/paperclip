import { describe, expect, it } from "vitest";
import { rejectPluginIssueActorClaims, stripPluginIssueUpdateOverrides } from "../services/plugin-issue-actor-boundary.js";

describe("plugin issue actor boundary helper", () => {
  it("rejects worker attribution and internal overrides", () => {
    for (const operation of ["create", "update"] as const) {
      for (const key of ["actorAgentId", "actorUserId", "actorRunId", "actorRunStopId", "actorPrincipalType", "actorResponsibleUserId", "responsibleUserId", "trustExplicitResponsibleUserId", "createdByAgentId", "createdByUserId", "originRunId", "watchdogActorRunId", "checkoutRunId", "executionRunId", "originIdentityContextId", "continuationIdentityContextId"]) {
        expect(() => rejectPluginIssueActorClaims({ [key]: "forged" }, operation)).toThrow("not authenticated");
      }
      for (const key of ["authorizationActor", "bindRuntimeSharedWorkspace", "options", "workspaceSelectionActor", "workspaceSelection", "workspaceSelectionSource", "conversationHandoff", "caseHandoffId"]) {
        expect(() => rejectPluginIssueActorClaims({ [key]: { authorizationActor: { type: "user", userId: "forged" } } }, operation)).toThrow("not authenticated");
      }
    }
    for (const key of ["companyId", "companyGuard", "expectedExecutionPolicy", "expectedStatusVersion"]) {
      expect(() => rejectPluginIssueActorClaims({ [key]: "forged" }, "update")).toThrow("not authenticated");
    }
  });

  it("preserves ordinary fields and strips null update overrides", () => {
    const patch = { title: "ordinary", assigneeUserId: "assignee", actorUserId: null, actorRunId: undefined, companyId: null, originRunId: null, responsibleUserId: null, authorizationActor: null };
    expect(() => rejectPluginIssueActorClaims(patch, "update")).not.toThrow();
    expect(stripPluginIssueUpdateOverrides(patch)).toEqual({ title: "ordinary", assigneeUserId: "assignee" });
    expect(() => rejectPluginIssueActorClaims({ companyId: "tenant", title: "ordinary", assigneeUserId: "assignee" }, "create")).not.toThrow();
  });
});
