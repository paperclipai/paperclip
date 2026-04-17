import { describe, expect, it } from "vitest";
import {
  createIssueSchema,
  createIssueLabelSchema,
  updateIssueSchema,
  checkoutIssueSchema,
  addIssueCommentSchema,
  issueExecutionStagePrincipalSchema,
  issueExecutionStageSchema,
  issueExecutionPolicySchema,
  issueExecutionWorkspaceSettingsSchema,
  issueDocumentKeySchema,
  upsertIssueDocumentSchema,
  linkIssueApprovalSchema,
} from "./issue.js";

describe("issueExecutionStagePrincipalSchema", () => {
  it("accepts a valid agent principal", () => {
    const result = issueExecutionStagePrincipalSchema.safeParse({
      type: "agent",
      agentId: "00000000-0000-0000-0000-000000000001",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an agent principal without agentId", () => {
    const result = issueExecutionStagePrincipalSchema.safeParse({ type: "agent" });
    expect(result.success).toBe(false);
  });

  it("rejects an agent principal with userId set", () => {
    const result = issueExecutionStagePrincipalSchema.safeParse({
      type: "agent",
      agentId: "00000000-0000-0000-0000-000000000001",
      userId: "user-1",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid user principal", () => {
    const result = issueExecutionStagePrincipalSchema.safeParse({
      type: "user",
      userId: "user-1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a user principal without userId", () => {
    const result = issueExecutionStagePrincipalSchema.safeParse({ type: "user" });
    expect(result.success).toBe(false);
  });

  it("rejects a user principal with agentId set", () => {
    const result = issueExecutionStagePrincipalSchema.safeParse({
      type: "user",
      userId: "user-1",
      agentId: "00000000-0000-0000-0000-000000000001",
    });
    expect(result.success).toBe(false);
  });
});

describe("issueExecutionStageSchema", () => {
  it("accepts a valid review stage", () => {
    const result = issueExecutionStageSchema.safeParse({ type: "review" });
    expect(result.success).toBe(true);
  });

  it("accepts a valid approval stage with participants", () => {
    const result = issueExecutionStageSchema.safeParse({
      type: "approval",
      participants: [
        { type: "user", userId: "user-1" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid stage type", () => {
    expect(issueExecutionStageSchema.safeParse({ type: "sign_off" }).success).toBe(false);
  });

  it("defaults approvalsNeeded to 1", () => {
    const result = issueExecutionStageSchema.safeParse({ type: "review" });
    expect(result.success && result.data.approvalsNeeded).toBe(1);
  });
});

describe("issueExecutionPolicySchema", () => {
  it("accepts an empty object (all defaults)", () => {
    const result = issueExecutionPolicySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.success && result.data.mode).toBe("normal");
    expect(result.success && result.data.commentRequired).toBe(true);
  });

  it("accepts mode auto", () => {
    expect(issueExecutionPolicySchema.safeParse({ mode: "auto" }).success).toBe(true);
  });

  it("accepts stages array", () => {
    const result = issueExecutionPolicySchema.safeParse({
      stages: [{ type: "review" }],
    });
    expect(result.success).toBe(true);
  });
});

describe("createIssueSchema", () => {
  const minimal = { title: "Fix the bug" };

  it("accepts a minimal issue", () => {
    expect(createIssueSchema.safeParse(minimal).success).toBe(true);
  });

  it("rejects an empty title", () => {
    expect(createIssueSchema.safeParse({ title: "" }).success).toBe(false);
  });

  it("defaults status to backlog", () => {
    const result = createIssueSchema.safeParse(minimal);
    expect(result.success && result.data.status).toBe("backlog");
  });

  it("defaults priority to medium", () => {
    const result = createIssueSchema.safeParse(minimal);
    expect(result.success && result.data.priority).toBe("medium");
  });

  it("accepts valid status values", () => {
    for (const status of ["backlog", "todo", "in_progress", "in_review", "done"]) {
      expect(createIssueSchema.safeParse({ title: "T", status }).success).toBe(true);
    }
  });

  it("accepts valid priority values", () => {
    for (const priority of ["critical", "high", "medium", "low"]) {
      expect(createIssueSchema.safeParse({ title: "T", priority }).success).toBe(true);
    }
  });

  it("accepts optional UUID fields", () => {
    const result = createIssueSchema.safeParse({
      ...minimal,
      projectId: "00000000-0000-0000-0000-000000000001",
      goalId: "00000000-0000-0000-0000-000000000002",
      parentId: "00000000-0000-0000-0000-000000000003",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid UUID for projectId", () => {
    expect(createIssueSchema.safeParse({ title: "T", projectId: "not-uuid" }).success).toBe(false);
  });

  it("defaults requestDepth to 0", () => {
    const result = createIssueSchema.safeParse(minimal);
    expect(result.success && result.data.requestDepth).toBe(0);
  });

  it("accepts blockedByIssueIds array", () => {
    const result = createIssueSchema.safeParse({
      ...minimal,
      blockedByIssueIds: ["00000000-0000-0000-0000-000000000001"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts executionWorkspacePreference", () => {
    const result = createIssueSchema.safeParse({
      ...minimal,
      executionWorkspacePreference: "isolated_workspace",
    });
    expect(result.success).toBe(true);
  });
});

describe("createIssueLabelSchema", () => {
  it("accepts a valid label", () => {
    expect(createIssueLabelSchema.safeParse({ name: "bug", color: "#ff0000" }).success).toBe(true);
  });

  it("rejects a name over 48 characters", () => {
    expect(
      createIssueLabelSchema.safeParse({ name: "a".repeat(49), color: "#ff0000" }).success,
    ).toBe(false);
  });

  it("rejects an invalid color format", () => {
    expect(createIssueLabelSchema.safeParse({ name: "bug", color: "red" }).success).toBe(false);
    expect(createIssueLabelSchema.safeParse({ name: "bug", color: "#gg0000" }).success).toBe(false);
    expect(createIssueLabelSchema.safeParse({ name: "bug", color: "#fff" }).success).toBe(false);
  });

  it("accepts uppercase hex color", () => {
    expect(createIssueLabelSchema.safeParse({ name: "bug", color: "#AABBCC" }).success).toBe(true);
  });
});

describe("updateIssueSchema", () => {
  it("accepts an empty object", () => {
    expect(updateIssueSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a partial update", () => {
    expect(updateIssueSchema.safeParse({ title: "Updated", status: "in_progress" }).success).toBe(true);
  });

  it("accepts the reopen flag", () => {
    expect(updateIssueSchema.safeParse({ reopen: true }).success).toBe(true);
  });
});

describe("checkoutIssueSchema", () => {
  it("accepts a valid checkout", () => {
    const result = checkoutIssueSchema.safeParse({
      agentId: "00000000-0000-0000-0000-000000000001",
      expectedStatuses: ["backlog"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty expectedStatuses", () => {
    const result = checkoutIssueSchema.safeParse({
      agentId: "00000000-0000-0000-0000-000000000001",
      expectedStatuses: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-uuid agentId", () => {
    expect(
      checkoutIssueSchema.safeParse({
        agentId: "not-uuid",
        expectedStatuses: ["backlog"],
      }).success,
    ).toBe(false);
  });
});

describe("addIssueCommentSchema", () => {
  it("accepts a valid comment", () => {
    expect(addIssueCommentSchema.safeParse({ body: "Looks good!" }).success).toBe(true);
  });

  it("rejects an empty body", () => {
    expect(addIssueCommentSchema.safeParse({ body: "" }).success).toBe(false);
  });
});

describe("issueDocumentKeySchema", () => {
  it("accepts valid keys", () => {
    expect(issueDocumentKeySchema.safeParse("spec").success).toBe(true);
    expect(issueDocumentKeySchema.safeParse("tech-design").success).toBe(true);
    expect(issueDocumentKeySchema.safeParse("arch_notes").success).toBe(true);
    expect(issueDocumentKeySchema.safeParse("a1b2c3").success).toBe(true);
  });

  it("rejects keys that start with non-alphanumeric", () => {
    expect(issueDocumentKeySchema.safeParse("-start").success).toBe(false);
    expect(issueDocumentKeySchema.safeParse("_start").success).toBe(false);
  });

  it("rejects uppercase letters", () => {
    expect(issueDocumentKeySchema.safeParse("MyDoc").success).toBe(false);
  });

  it("rejects empty key", () => {
    expect(issueDocumentKeySchema.safeParse("").success).toBe(false);
  });

  it("rejects key over 64 characters", () => {
    expect(issueDocumentKeySchema.safeParse("a".repeat(65)).success).toBe(false);
  });
});

describe("upsertIssueDocumentSchema", () => {
  it("accepts a valid document upsert", () => {
    const result = upsertIssueDocumentSchema.safeParse({
      format: "markdown",
      body: "# Title\n\nContent here.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid format", () => {
    expect(upsertIssueDocumentSchema.safeParse({ format: "html", body: "<p>hi</p>" }).success).toBe(false);
  });

  it("rejects a body over 524288 characters", () => {
    expect(
      upsertIssueDocumentSchema.safeParse({ format: "markdown", body: "a".repeat(524289) }).success,
    ).toBe(false);
  });

  it("accepts optional changeSummary and baseRevisionId", () => {
    const result = upsertIssueDocumentSchema.safeParse({
      format: "markdown",
      body: "content",
      changeSummary: "Minor fix",
      baseRevisionId: "00000000-0000-0000-0000-000000000001",
    });
    expect(result.success).toBe(true);
  });
});

describe("issueExecutionWorkspaceSettingsSchema", () => {
  it("accepts an empty object", () => {
    expect(issueExecutionWorkspaceSettingsSchema.safeParse({}).success).toBe(true);
  });

  it("accepts valid mode values", () => {
    for (const mode of ["inherit", "shared_workspace", "isolated_workspace", "operator_branch"]) {
      expect(issueExecutionWorkspaceSettingsSchema.safeParse({ mode }).success).toBe(true);
    }
  });

  it("rejects unknown fields (strict schema)", () => {
    expect(issueExecutionWorkspaceSettingsSchema.safeParse({ unknownField: true }).success).toBe(false);
  });
});

describe("linkIssueApprovalSchema", () => {
  it("accepts a valid approvalId", () => {
    const result = linkIssueApprovalSchema.safeParse({
      approvalId: "00000000-0000-0000-0000-000000000001",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid approvalId", () => {
    expect(linkIssueApprovalSchema.safeParse({ approvalId: "not-uuid" }).success).toBe(false);
  });
});
