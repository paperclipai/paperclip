import { describe, expect, it } from "vitest";
import {
  projectAgentAdapterConfig,
  projectAgentPermissions,
  projectAgentRuntimeConfig,
} from "../serializers/agent-response.js";
import { projectApprovalResponse } from "../serializers/approval-response.js";

const SECRET = "response-projection-secret";

describe("response projection review blockers", () => {
  it("preserves supported public adapter arrays, objects, controls, and instruction configuration", () => {
    expect(projectAgentAdapterConfig({
      provider: "openai-codex",
      model: "gpt-5",
      modelReasoningEffort: "high",
      variant: "review",
      effort: "medium",
      fastMode: true,
      search: true,
      toolsets: ["terminal", "web"],
      extraArgs: ["--safe", "yes"],
      permissionMode: "approve-reads",
      nonInteractivePermissions: "deny",
      dangerouslyBypassApprovalsAndSandbox: false,
      instructionsFilePath: "/workspace/AGENTS.md",
      workspaceStrategy: { type: "git_worktree", baseRef: "main", secret: SECRET },
      env: { TOKEN: SECRET },
      headers: { authorization: SECRET },
      apiKey: SECRET,
      secretRef: { id: SECRET },
      metadata: { secret: SECRET },
      unknownPluginField: SECRET,
    })).toEqual({
      provider: "openai-codex",
      model: "gpt-5",
      modelReasoningEffort: "high",
      variant: "review",
      effort: "medium",
      fastMode: true,
      search: true,
      toolsets: ["terminal", "web"],
      extraArgs: ["--safe", "yes"],
      permissionMode: "approve-reads",
      nonInteractivePermissions: "deny",
      dangerouslyBypassApprovalsAndSandbox: false,
      instructionsFilePath: "/workspace/AGENTS.md",
      workspaceStrategy: { type: "git_worktree", baseRef: "main" },
    });
  });

  it("projects runtime heartbeat/profile config and authorization policy deeply", () => {
    expect(projectAgentRuntimeConfig({
      heartbeat: {
        enabled: true,
        intervalSec: 300,
        wakeOnDemand: true,
        cooldownSec: 10,
        maxConcurrentRuns: 2,
        maxTurnContinuation: { enabled: true, maxAttempts: 2, delayMs: 1000, secret: SECRET },
        runtimeToken: SECRET,
      },
      modelProfiles: {
        cheap: { enabled: true, label: "Cheap", adapterConfig: { model: "gpt-5-mini", fastMode: true, env: { TOKEN: SECRET } } },
      },
      internalRuntime: { token: SECRET },
    })).toEqual({
      heartbeat: {
        enabled: true,
        intervalSec: 300,
        wakeOnDemand: true,
        cooldownSec: 10,
        maxConcurrentRuns: 2,
        maxTurnContinuation: { enabled: true, maxAttempts: 2, delayMs: 1000 },
      },
      modelProfiles: {
        cheap: { enabled: true, label: "Cheap", adapterConfig: { model: "gpt-5-mini", fastMode: true } },
      },
    });

    expect(projectAgentPermissions({
      canCreateAgents: false,
      canCreateSkills: true,
      trustPreset: "low_trust_review",
      authorizationPolicy: {
        trustPreset: "low_trust_review",
        reviewPreset: { id: "low_trust_review", version: 1, rawOutputDisposition: "quarantine", secret: SECRET },
        trustBoundary: {
          mode: "low_trust_review",
          companyId: "company-1",
          projectIds: ["project-1"],
          allowedToolClasses: ["git.read"],
          outputPromotionTarget: { type: "issue", issueId: "issue-1", secret: SECRET },
          secret: SECRET,
        },
        secret: SECRET,
      },
      internalGrantMetadata: { secret: SECRET },
    })).toEqual({
      canCreateAgents: false,
      canCreateSkills: true,
      trustPreset: "low_trust_review",
      authorizationPolicy: {
        trustPreset: "low_trust_review",
        reviewPreset: { id: "low_trust_review", version: 1, rawOutputDisposition: "quarantine" },
        trustBoundary: {
          mode: "low_trust_review",
          companyId: "company-1",
          projectIds: ["project-1"],
          allowedToolClasses: ["git.read"],
          outputPromotionTarget: { type: "issue", issueId: "issue-1" },
        },
      },
    });
  });

  it.each([
    ["approve_ceo_strategy", { title: "Q3 strategy", plan: "Grow safely", unknown: SECRET }, { title: "Q3 strategy", plan: "Grow safely" }],
    ["budget_override_required", { scopeType: "agent", scopeId: "agent-1", budgetAmount: 100, observedAmount: 125, guidance: "Review", unknown: SECRET }, { scopeType: "agent", scopeId: "agent-1", budgetAmount: 100, observedAmount: 125, guidance: "Review" }],
    ["request_board_approval", { title: "Approve action", summary: "Safe summary", risks: ["External side effect"], recommendedAction: "Review", unknown: SECRET }, { title: "Approve action", summary: "Safe summary", risks: ["External side effect"], recommendedAction: "Review" }],
  ] as const)("projects %s approval payloads without unknown pass-through", (type, payload, expected) => {
    const result = projectApprovalResponse({ id: "a", companyId: "company-1", type, status: "pending", payload, unknownRow: SECRET });
    expect(result.payload).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("deeply projects hire snapshots and excludes unknown fields", () => {
    const result = projectApprovalResponse({
      id: "a",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {
        name: "Reviewer",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5", fastMode: true, env: { TOKEN: SECRET } },
        runtimeConfig: { heartbeat: { enabled: true, runtimeToken: SECRET } },
        requestedConfigurationSnapshot: {
          adapterType: "codex_local",
          adapterConfig: { model: "gpt-5", env: { TOKEN: SECRET } },
          runtimeConfig: { heartbeat: { intervalSec: 60, token: SECRET } },
          desiredSkills: ["review"],
          unknown: SECRET,
        },
        unknownPayload: SECRET,
      },
      unknownRow: SECRET,
    });
    expect(result.payload).toEqual({
      name: "Reviewer",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5", fastMode: true },
      runtimeConfig: { heartbeat: { enabled: true } },
      requestedConfigurationSnapshot: {
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5" },
        runtimeConfig: { heartbeat: { intervalSec: 60 } },
        desiredSkills: ["review"],
      },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
