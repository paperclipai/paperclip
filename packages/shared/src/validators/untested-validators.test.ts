import { describe, it, expect } from "vitest";

// work-product.ts
import {
  issueWorkProductTypeSchema,
  issueWorkProductStatusSchema,
  issueWorkProductReviewStateSchema,
  createIssueWorkProductSchema,
  updateIssueWorkProductSchema,
} from "./work-product.js";

// approval.ts
import {
  createApprovalSchema,
  resolveApprovalSchema,
  requestApprovalRevisionSchema,
  resubmitApprovalSchema,
  addApprovalCommentSchema,
  requestIssueApprovalSchema,
} from "./approval.js";

// asset.ts
import { createAssetImageMetadataSchema } from "./asset.js";

// instance.ts
import {
  backupRetentionPolicySchema,
  instanceGeneralSettingsSchema,
  patchInstanceGeneralSettingsSchema,
  instanceExperimentalSettingsSchema,
  patchInstanceExperimentalSettingsSchema,
} from "./instance.js";

// access.ts
import {
  createCompanyInviteSchema,
  createOpenClawInvitePromptSchema,
  acceptInviteSchema,
  listJoinRequestsQuerySchema,
  claimJoinRequestApiKeySchema,
  createCliAuthChallengeSchema,
  resolveCliAuthChallengeSchema,
  updateMemberPermissionsSchema,
  updateUserCompanyAccessSchema,
} from "./access.js";

// finance.ts
import { createFinanceEventSchema } from "./finance.js";

// ============================================================================
// work-product.ts — issueWorkProductTypeSchema
// ============================================================================

describe("issueWorkProductTypeSchema", () => {
  it("accepts all valid work product types", () => {
    const types = [
      "preview_url", "runtime_service", "pull_request", "branch",
      "commit", "artifact", "document",
    ] as const;
    for (const t of types) {
      expect(issueWorkProductTypeSchema.safeParse(t).success).toBe(true);
    }
  });

  it("rejects unknown type", () => {
    expect(issueWorkProductTypeSchema.safeParse("issue").success).toBe(false);
  });
});

// ============================================================================
// work-product.ts — issueWorkProductStatusSchema
// ============================================================================

describe("issueWorkProductStatusSchema", () => {
  it("accepts all valid work product statuses", () => {
    const statuses = [
      "active", "ready_for_review", "approved", "changes_requested",
      "merged", "closed", "failed", "archived", "draft",
    ] as const;
    for (const s of statuses) {
      expect(issueWorkProductStatusSchema.safeParse(s).success).toBe(true);
    }
  });

  it("rejects unknown status", () => {
    expect(issueWorkProductStatusSchema.safeParse("pending").success).toBe(false);
  });
});

// ============================================================================
// work-product.ts — issueWorkProductReviewStateSchema
// ============================================================================

describe("issueWorkProductReviewStateSchema", () => {
  it("accepts all valid review states", () => {
    for (const s of ["none", "needs_board_review", "approved", "changes_requested"] as const) {
      expect(issueWorkProductReviewStateSchema.safeParse(s).success).toBe(true);
    }
  });

  it("rejects unknown review state", () => {
    expect(issueWorkProductReviewStateSchema.safeParse("in_review").success).toBe(false);
  });
});

// ============================================================================
// work-product.ts — createIssueWorkProductSchema
// ============================================================================

describe("createIssueWorkProductSchema", () => {
  const base = {
    type: "pull_request" as const,
    provider: "github",
    title: "My PR",
  };

  it("accepts a minimal work product", () => {
    expect(createIssueWorkProductSchema.safeParse(base).success).toBe(true);
  });

  it("defaults status to active", () => {
    const result = createIssueWorkProductSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("active");
    }
  });

  it("defaults reviewState to none", () => {
    const result = createIssueWorkProductSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reviewState).toBe("none");
    }
  });

  it("defaults isPrimary to false", () => {
    const result = createIssueWorkProductSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isPrimary).toBe(false);
    }
  });

  it("defaults healthStatus to unknown", () => {
    const result = createIssueWorkProductSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.healthStatus).toBe("unknown");
    }
  });

  it("rejects empty provider", () => {
    expect(createIssueWorkProductSchema.safeParse({ ...base, provider: "" }).success).toBe(false);
  });

  it("rejects empty title", () => {
    expect(createIssueWorkProductSchema.safeParse({ ...base, title: "" }).success).toBe(false);
  });

  it("accepts url as valid URL", () => {
    const result = createIssueWorkProductSchema.safeParse({
      ...base,
      url: "https://github.com/example/repo/pull/1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects url as non-URL", () => {
    expect(createIssueWorkProductSchema.safeParse({ ...base, url: "not-a-url" }).success).toBe(false);
  });

  it("accepts null url", () => {
    expect(createIssueWorkProductSchema.safeParse({ ...base, url: null }).success).toBe(true);
  });

  it("accepts projectId as UUID", () => {
    expect(
      createIssueWorkProductSchema.safeParse({
        ...base,
        projectId: "00000000-0000-0000-0000-000000000001",
      }).success
    ).toBe(true);
  });

  it("rejects projectId as non-UUID", () => {
    expect(createIssueWorkProductSchema.safeParse({ ...base, projectId: "bad" }).success).toBe(false);
  });

  it("accepts all healthStatus values", () => {
    for (const s of ["unknown", "healthy", "unhealthy"] as const) {
      expect(createIssueWorkProductSchema.safeParse({ ...base, healthStatus: s }).success).toBe(true);
    }
  });
});

// ============================================================================
// work-product.ts — updateIssueWorkProductSchema
// ============================================================================

describe("updateIssueWorkProductSchema", () => {
  it("accepts empty object", () => {
    expect(updateIssueWorkProductSchema.safeParse({}).success).toBe(true);
  });

  it("accepts status-only update", () => {
    expect(updateIssueWorkProductSchema.safeParse({ status: "merged" }).success).toBe(true);
  });
});

// ============================================================================
// approval.ts — createApprovalSchema
// ============================================================================

describe("createApprovalSchema", () => {
  const base = {
    type: "request_board_approval" as const,
    payload: { title: "Approve spend" },
  };

  it("accepts a minimal approval request", () => {
    expect(createApprovalSchema.safeParse(base).success).toBe(true);
  });

  it("accepts all valid approval types", () => {
    for (const type of ["hire_agent", "approve_ceo_strategy", "budget_override_required", "request_board_approval"] as const) {
      expect(createApprovalSchema.safeParse({ ...base, type }).success).toBe(true);
    }
  });

  it("rejects invalid approval type", () => {
    expect(createApprovalSchema.safeParse({ ...base, type: "unknown" }).success).toBe(false);
  });

  it("accepts issueIds array of UUIDs", () => {
    expect(
      createApprovalSchema.safeParse({
        ...base,
        issueIds: ["00000000-0000-0000-0000-000000000001"],
      }).success
    ).toBe(true);
  });

  it("rejects issueIds with non-UUID entries", () => {
    expect(
      createApprovalSchema.safeParse({ ...base, issueIds: ["not-uuid"] }).success
    ).toBe(false);
  });

  it("accepts requestedByAgentId as UUID", () => {
    expect(
      createApprovalSchema.safeParse({
        ...base,
        requestedByAgentId: "00000000-0000-0000-0000-000000000001",
      }).success
    ).toBe(true);
  });

  it("rejects requestedByAgentId as non-UUID", () => {
    expect(createApprovalSchema.safeParse({ ...base, requestedByAgentId: "bad" }).success).toBe(false);
  });

  it("rejects missing payload", () => {
    expect(createApprovalSchema.safeParse({ type: "request_board_approval" }).success).toBe(false);
  });
});

// ============================================================================
// approval.ts — resolveApprovalSchema
// ============================================================================

describe("resolveApprovalSchema", () => {
  it("accepts empty object (all optional)", () => {
    expect(resolveApprovalSchema.safeParse({}).success).toBe(true);
  });

  it("defaults decidedByUserId to board", () => {
    const result = resolveApprovalSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.decidedByUserId).toBe("board");
    }
  });

  it("accepts optional decisionNote", () => {
    expect(resolveApprovalSchema.safeParse({ decisionNote: "Approved." }).success).toBe(true);
  });

  it("accepts null decisionNote", () => {
    expect(resolveApprovalSchema.safeParse({ decisionNote: null }).success).toBe(true);
  });
});

// ============================================================================
// approval.ts — requestApprovalRevisionSchema
// ============================================================================

describe("requestApprovalRevisionSchema", () => {
  it("accepts empty object", () => {
    expect(requestApprovalRevisionSchema.safeParse({}).success).toBe(true);
  });

  it("defaults decidedByUserId to board", () => {
    const result = requestApprovalRevisionSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.decidedByUserId).toBe("board");
    }
  });
});

// ============================================================================
// approval.ts — resubmitApprovalSchema
// ============================================================================

describe("resubmitApprovalSchema", () => {
  it("accepts empty object", () => {
    expect(resubmitApprovalSchema.safeParse({}).success).toBe(true);
  });

  it("accepts payload as record", () => {
    expect(resubmitApprovalSchema.safeParse({ payload: { key: "value" } }).success).toBe(true);
  });
});

// ============================================================================
// approval.ts — addApprovalCommentSchema
// ============================================================================

describe("addApprovalCommentSchema", () => {
  it("accepts a non-empty body", () => {
    expect(addApprovalCommentSchema.safeParse({ body: "LGTM" }).success).toBe(true);
  });

  it("rejects empty body", () => {
    expect(addApprovalCommentSchema.safeParse({ body: "" }).success).toBe(false);
  });

  it("rejects missing body", () => {
    expect(addApprovalCommentSchema.safeParse({}).success).toBe(false);
  });
});

// ============================================================================
// approval.ts — requestIssueApprovalSchema
// ============================================================================

describe("requestIssueApprovalSchema", () => {
  const base = {
    type: "request_board_approval" as const,
    payload: { title: "Approve" },
    comment: "Please approve this action.",
  };

  it("accepts a valid issue approval request", () => {
    expect(requestIssueApprovalSchema.safeParse(base).success).toBe(true);
  });

  it("rejects empty comment", () => {
    expect(requestIssueApprovalSchema.safeParse({ ...base, comment: "" }).success).toBe(false);
  });

  it("rejects missing comment", () => {
    const { comment: _, ...rest } = base;
    expect(requestIssueApprovalSchema.safeParse(rest).success).toBe(false);
  });
});

// ============================================================================
// asset.ts — createAssetImageMetadataSchema
// ============================================================================

describe("createAssetImageMetadataSchema", () => {
  it("accepts empty object (namespace is optional)", () => {
    expect(createAssetImageMetadataSchema.safeParse({}).success).toBe(true);
  });

  it("accepts valid namespace", () => {
    expect(createAssetImageMetadataSchema.safeParse({ namespace: "avatars/users" }).success).toBe(true);
  });

  it("accepts namespace with alphanumeric chars, slashes, dashes, underscores", () => {
    expect(createAssetImageMetadataSchema.safeParse({ namespace: "team_icons/v2-beta" }).success).toBe(true);
  });

  it("rejects empty namespace", () => {
    expect(createAssetImageMetadataSchema.safeParse({ namespace: "" }).success).toBe(false);
  });

  it("rejects namespace with spaces", () => {
    expect(createAssetImageMetadataSchema.safeParse({ namespace: "my namespace" }).success).toBe(false);
  });

  it("rejects namespace with special chars", () => {
    expect(createAssetImageMetadataSchema.safeParse({ namespace: "bad@char" }).success).toBe(false);
  });

  it("rejects namespace longer than 120 chars", () => {
    expect(
      createAssetImageMetadataSchema.safeParse({ namespace: "a".repeat(121) }).success
    ).toBe(false);
  });

  it("accepts namespace at exactly 120 chars", () => {
    expect(
      createAssetImageMetadataSchema.safeParse({ namespace: "a".repeat(120) }).success
    ).toBe(true);
  });
});

// ============================================================================
// instance.ts — backupRetentionPolicySchema
// ============================================================================

describe("backupRetentionPolicySchema", () => {
  it("accepts valid preset values (7, 4, 1)", () => {
    const result = backupRetentionPolicySchema.safeParse({
      dailyDays: 7,
      weeklyWeeks: 4,
      monthlyMonths: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid preset values (3, 1, 3)", () => {
    expect(
      backupRetentionPolicySchema.safeParse({ dailyDays: 3, weeklyWeeks: 1, monthlyMonths: 3 }).success
    ).toBe(true);
  });

  it("accepts valid preset values (14, 2, 6)", () => {
    expect(
      backupRetentionPolicySchema.safeParse({ dailyDays: 14, weeklyWeeks: 2, monthlyMonths: 6 }).success
    ).toBe(true);
  });

  it("rejects dailyDays not in preset [3, 7, 14]", () => {
    expect(
      backupRetentionPolicySchema.safeParse({ dailyDays: 5, weeklyWeeks: 4, monthlyMonths: 1 }).success
    ).toBe(false);
  });

  it("rejects weeklyWeeks not in preset [1, 2, 4]", () => {
    expect(
      backupRetentionPolicySchema.safeParse({ dailyDays: 7, weeklyWeeks: 3, monthlyMonths: 1 }).success
    ).toBe(false);
  });

  it("rejects monthlyMonths not in preset [1, 3, 6]", () => {
    expect(
      backupRetentionPolicySchema.safeParse({ dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 2 }).success
    ).toBe(false);
  });

  it("defaults to DEFAULT_BACKUP_RETENTION when fields are missing", () => {
    const result = backupRetentionPolicySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dailyDays).toBe(7);
      expect(result.data.weeklyWeeks).toBe(4);
      expect(result.data.monthlyMonths).toBe(1);
    }
  });
});

// ============================================================================
// instance.ts — instanceGeneralSettingsSchema
// ============================================================================

describe("instanceGeneralSettingsSchema", () => {
  it("accepts empty object (all have defaults)", () => {
    const result = instanceGeneralSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("defaults censorUsernameInLogs to false", () => {
    const result = instanceGeneralSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.censorUsernameInLogs).toBe(false);
    }
  });

  it("defaults keyboardShortcuts to false", () => {
    const result = instanceGeneralSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.keyboardShortcuts).toBe(false);
    }
  });

  it("defaults feedbackDataSharingPreference to prompt", () => {
    const result = instanceGeneralSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.feedbackDataSharingPreference).toBe("prompt");
    }
  });

  it("accepts explicit censorUsernameInLogs: true", () => {
    expect(instanceGeneralSettingsSchema.safeParse({ censorUsernameInLogs: true }).success).toBe(true);
  });

  it("accepts feedbackDataSharingPreference: allowed", () => {
    expect(
      instanceGeneralSettingsSchema.safeParse({ feedbackDataSharingPreference: "allowed" }).success
    ).toBe(true);
  });

  it("rejects unknown extra fields (strict mode)", () => {
    expect(
      instanceGeneralSettingsSchema.safeParse({ unknownField: "value" }).success
    ).toBe(false);
  });
});

// ============================================================================
// instance.ts — patchInstanceGeneralSettingsSchema
// ============================================================================

describe("patchInstanceGeneralSettingsSchema", () => {
  it("accepts empty object (all optional)", () => {
    expect(patchInstanceGeneralSettingsSchema.safeParse({}).success).toBe(true);
  });

  it("accepts partial update", () => {
    expect(patchInstanceGeneralSettingsSchema.safeParse({ keyboardShortcuts: true }).success).toBe(true);
  });
});

// ============================================================================
// instance.ts — instanceExperimentalSettingsSchema
// ============================================================================

describe("instanceExperimentalSettingsSchema", () => {
  it("accepts empty object (all have defaults)", () => {
    expect(instanceExperimentalSettingsSchema.safeParse({}).success).toBe(true);
  });

  it("defaults enableIsolatedWorkspaces to false", () => {
    const result = instanceExperimentalSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enableIsolatedWorkspaces).toBe(false);
    }
  });

  it("defaults autoRestartDevServerWhenIdle to false", () => {
    const result = instanceExperimentalSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.autoRestartDevServerWhenIdle).toBe(false);
    }
  });

  it("accepts enableIsolatedWorkspaces: true", () => {
    expect(instanceExperimentalSettingsSchema.safeParse({ enableIsolatedWorkspaces: true }).success).toBe(true);
  });

  it("rejects extra unknown fields (strict mode)", () => {
    expect(
      instanceExperimentalSettingsSchema.safeParse({ unknownFeature: true }).success
    ).toBe(false);
  });
});

// ============================================================================
// instance.ts — patchInstanceExperimentalSettingsSchema
// ============================================================================

describe("patchInstanceExperimentalSettingsSchema", () => {
  it("accepts empty object", () => {
    expect(patchInstanceExperimentalSettingsSchema.safeParse({}).success).toBe(true);
  });

  it("accepts partial update", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.safeParse({ enableIsolatedWorkspaces: true }).success
    ).toBe(true);
  });
});

// ============================================================================
// access.ts — createCompanyInviteSchema
// ============================================================================

describe("createCompanyInviteSchema", () => {
  it("accepts empty object (all optional)", () => {
    expect(createCompanyInviteSchema.safeParse({}).success).toBe(true);
  });

  it("defaults allowedJoinTypes to both", () => {
    const result = createCompanyInviteSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowedJoinTypes).toBe("both");
    }
  });

  it("accepts allowedJoinTypes: agent", () => {
    expect(createCompanyInviteSchema.safeParse({ allowedJoinTypes: "agent" }).success).toBe(true);
  });

  it("accepts allowedJoinTypes: human", () => {
    expect(createCompanyInviteSchema.safeParse({ allowedJoinTypes: "human" }).success).toBe(true);
  });

  it("rejects invalid allowedJoinTypes", () => {
    expect(createCompanyInviteSchema.safeParse({ allowedJoinTypes: "team" }).success).toBe(false);
  });

  it("accepts agentMessage up to 4000 chars", () => {
    expect(createCompanyInviteSchema.safeParse({ agentMessage: "x".repeat(4000) }).success).toBe(true);
  });

  it("rejects agentMessage longer than 4000 chars", () => {
    expect(createCompanyInviteSchema.safeParse({ agentMessage: "x".repeat(4001) }).success).toBe(false);
  });
});

// ============================================================================
// access.ts — createOpenClawInvitePromptSchema
// ============================================================================

describe("createOpenClawInvitePromptSchema", () => {
  it("accepts empty object", () => {
    expect(createOpenClawInvitePromptSchema.safeParse({}).success).toBe(true);
  });

  it("accepts optional agentMessage", () => {
    expect(createOpenClawInvitePromptSchema.safeParse({ agentMessage: "Hello" }).success).toBe(true);
  });

  it("rejects agentMessage over 4000 chars", () => {
    expect(createOpenClawInvitePromptSchema.safeParse({ agentMessage: "x".repeat(4001) }).success).toBe(false);
  });
});

// ============================================================================
// access.ts — acceptInviteSchema
// ============================================================================

describe("acceptInviteSchema", () => {
  it("accepts minimal agent invite", () => {
    expect(
      acceptInviteSchema.safeParse({ requestType: "agent", agentName: "MyBot" }).success
    ).toBe(true);
  });

  it("accepts human requestType", () => {
    expect(acceptInviteSchema.safeParse({ requestType: "human" }).success).toBe(true);
  });

  it("rejects invalid requestType", () => {
    expect(acceptInviteSchema.safeParse({ requestType: "board" }).success).toBe(false);
  });

  it("rejects agentName exceeding 120 chars", () => {
    expect(
      acceptInviteSchema.safeParse({ requestType: "agent", agentName: "a".repeat(121) }).success
    ).toBe(false);
  });

  it("accepts adapterType as non-empty string", () => {
    expect(
      acceptInviteSchema.safeParse({ requestType: "agent", adapterType: "process" }).success
    ).toBe(true);
  });

  it("rejects adapterType as empty string", () => {
    expect(
      acceptInviteSchema.safeParse({ requestType: "agent", adapterType: "" }).success
    ).toBe(false);
  });
});

// ============================================================================
// access.ts — listJoinRequestsQuerySchema
// ============================================================================

describe("listJoinRequestsQuerySchema", () => {
  it("accepts empty object (all optional)", () => {
    expect(listJoinRequestsQuerySchema.safeParse({}).success).toBe(true);
  });

  it("accepts status: pending_approval", () => {
    expect(listJoinRequestsQuerySchema.safeParse({ status: "pending_approval" }).success).toBe(true);
  });

  it("accepts all valid statuses", () => {
    for (const status of ["pending_approval", "approved", "rejected"] as const) {
      expect(listJoinRequestsQuerySchema.safeParse({ status }).success).toBe(true);
    }
  });

  it("rejects invalid status", () => {
    expect(listJoinRequestsQuerySchema.safeParse({ status: "unknown" }).success).toBe(false);
  });

  it("accepts all valid requestTypes", () => {
    for (const requestType of ["human", "agent"] as const) {
      expect(listJoinRequestsQuerySchema.safeParse({ requestType }).success).toBe(true);
    }
  });
});

// ============================================================================
// access.ts — claimJoinRequestApiKeySchema
// ============================================================================

describe("claimJoinRequestApiKeySchema", () => {
  it("accepts claimSecret at minimum length 16", () => {
    expect(claimJoinRequestApiKeySchema.safeParse({ claimSecret: "a".repeat(16) }).success).toBe(true);
  });

  it("accepts claimSecret at maximum length 256", () => {
    expect(claimJoinRequestApiKeySchema.safeParse({ claimSecret: "a".repeat(256) }).success).toBe(true);
  });

  it("rejects claimSecret shorter than 16 chars", () => {
    expect(claimJoinRequestApiKeySchema.safeParse({ claimSecret: "a".repeat(15) }).success).toBe(false);
  });

  it("rejects claimSecret longer than 256 chars", () => {
    expect(claimJoinRequestApiKeySchema.safeParse({ claimSecret: "a".repeat(257) }).success).toBe(false);
  });
});

// ============================================================================
// access.ts — createCliAuthChallengeSchema
// ============================================================================

describe("createCliAuthChallengeSchema", () => {
  it("accepts a valid challenge", () => {
    expect(
      createCliAuthChallengeSchema.safeParse({ command: "install skill" }).success
    ).toBe(true);
  });

  it("defaults requestedAccess to board", () => {
    const result = createCliAuthChallengeSchema.safeParse({ command: "install skill" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requestedAccess).toBe("board");
    }
  });

  it("accepts instance_admin_required access level", () => {
    expect(
      createCliAuthChallengeSchema.safeParse({
        command: "admin command",
        requestedAccess: "instance_admin_required",
      }).success
    ).toBe(true);
  });

  it("rejects empty command", () => {
    expect(createCliAuthChallengeSchema.safeParse({ command: "" }).success).toBe(false);
  });

  it("rejects command exceeding 240 chars", () => {
    expect(
      createCliAuthChallengeSchema.safeParse({ command: "x".repeat(241) }).success
    ).toBe(false);
  });

  it("rejects clientName exceeding 120 chars", () => {
    expect(
      createCliAuthChallengeSchema.safeParse({
        command: "x",
        clientName: "n".repeat(121),
      }).success
    ).toBe(false);
  });
});

// ============================================================================
// access.ts — resolveCliAuthChallengeSchema
// ============================================================================

describe("resolveCliAuthChallengeSchema", () => {
  it("accepts token at minimum length 16", () => {
    expect(resolveCliAuthChallengeSchema.safeParse({ token: "t".repeat(16) }).success).toBe(true);
  });

  it("accepts token at maximum length 256", () => {
    expect(resolveCliAuthChallengeSchema.safeParse({ token: "t".repeat(256) }).success).toBe(true);
  });

  it("rejects token shorter than 16 chars", () => {
    expect(resolveCliAuthChallengeSchema.safeParse({ token: "t".repeat(15) }).success).toBe(false);
  });

  it("rejects missing token", () => {
    expect(resolveCliAuthChallengeSchema.safeParse({}).success).toBe(false);
  });
});

// ============================================================================
// access.ts — updateMemberPermissionsSchema
// ============================================================================

describe("updateMemberPermissionsSchema", () => {
  it("accepts empty grants array", () => {
    expect(updateMemberPermissionsSchema.safeParse({ grants: [] }).success).toBe(true);
  });

  it("accepts valid grant with permissionKey", () => {
    expect(
      updateMemberPermissionsSchema.safeParse({
        grants: [{ permissionKey: "agents:create" }],
      }).success
    ).toBe(true);
  });

  it("accepts grant with scope", () => {
    expect(
      updateMemberPermissionsSchema.safeParse({
        grants: [{ permissionKey: "tasks:assign", scope: { projectId: "abc" } }],
      }).success
    ).toBe(true);
  });

  it("rejects invalid permissionKey", () => {
    expect(
      updateMemberPermissionsSchema.safeParse({
        grants: [{ permissionKey: "unknown:action" }],
      }).success
    ).toBe(false);
  });

  it("rejects missing grants", () => {
    expect(updateMemberPermissionsSchema.safeParse({}).success).toBe(false);
  });
});

// ============================================================================
// access.ts — updateUserCompanyAccessSchema
// ============================================================================

describe("updateUserCompanyAccessSchema", () => {
  it("defaults companyIds to empty array", () => {
    const result = updateUserCompanyAccessSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.companyIds).toEqual([]);
    }
  });

  it("accepts an array of UUIDs", () => {
    expect(
      updateUserCompanyAccessSchema.safeParse({
        companyIds: ["00000000-0000-0000-0000-000000000001"],
      }).success
    ).toBe(true);
  });

  it("rejects non-UUID in companyIds", () => {
    expect(updateUserCompanyAccessSchema.safeParse({ companyIds: ["bad"] }).success).toBe(false);
  });
});

// ============================================================================
// finance.ts — createFinanceEventSchema
// ============================================================================

describe("createFinanceEventSchema", () => {
  const base = {
    eventKind: "inference_charge" as const,
    biller: "anthropic",
    amountCents: 150,
    occurredAt: "2024-01-01T00:00:00Z",
  };

  it("accepts a minimal finance event", () => {
    expect(createFinanceEventSchema.safeParse(base).success).toBe(true);
  });

  it("defaults direction to debit", () => {
    const result = createFinanceEventSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.direction).toBe("debit");
    }
  });

  it("defaults currency to USD", () => {
    const result = createFinanceEventSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.currency).toBe("USD");
    }
  });

  it("uppercases currency via transform", () => {
    const result = createFinanceEventSchema.safeParse({ ...base, currency: "eur" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.currency).toBe("EUR");
    }
  });

  it("defaults estimated to false", () => {
    const result = createFinanceEventSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.estimated).toBe(false);
    }
  });

  it("rejects empty biller", () => {
    expect(createFinanceEventSchema.safeParse({ ...base, biller: "" }).success).toBe(false);
  });

  it("rejects negative amountCents", () => {
    expect(createFinanceEventSchema.safeParse({ ...base, amountCents: -1 }).success).toBe(false);
  });

  it("accepts amountCents of 0", () => {
    expect(createFinanceEventSchema.safeParse({ ...base, amountCents: 0 }).success).toBe(true);
  });

  it("rejects non-integer amountCents", () => {
    expect(createFinanceEventSchema.safeParse({ ...base, amountCents: 1.5 }).success).toBe(false);
  });

  it("accepts direction: credit", () => {
    expect(createFinanceEventSchema.safeParse({ ...base, direction: "credit" }).success).toBe(true);
  });

  it("rejects invalid direction", () => {
    expect(createFinanceEventSchema.safeParse({ ...base, direction: "charge" }).success).toBe(false);
  });

  it("rejects currency that is not 3 chars", () => {
    expect(createFinanceEventSchema.safeParse({ ...base, currency: "US" }).success).toBe(false);
    expect(createFinanceEventSchema.safeParse({ ...base, currency: "USDD" }).success).toBe(false);
  });

  it("rejects invalid occurredAt format", () => {
    expect(createFinanceEventSchema.safeParse({ ...base, occurredAt: "2024-01-01" }).success).toBe(false);
  });

  it("accepts agentId as UUID", () => {
    expect(
      createFinanceEventSchema.safeParse({
        ...base,
        agentId: "00000000-0000-0000-0000-000000000001",
      }).success
    ).toBe(true);
  });

  it("rejects non-integer quantity", () => {
    expect(createFinanceEventSchema.safeParse({ ...base, quantity: 1.5 }).success).toBe(false);
  });

  it("accepts all valid eventKind values", () => {
    for (const eventKind of ["inference_charge", "platform_fee", "credit_purchase", "credit_refund", "credit_expiry"] as const) {
      expect(createFinanceEventSchema.safeParse({ ...base, eventKind }).success).toBe(true);
    }
  });
});
