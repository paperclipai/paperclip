import { describe, it, expect } from "vitest";
import {
  issueExecutionStagePrincipalSchema,
  issueExecutionStageParticipantSchema,
  issueExecutionStageSchema,
  issueExecutionPolicySchema,
  createIssueSchema,
  createIssueLabelSchema,
  checkoutIssueSchema,
  addIssueCommentSchema,
  issueDocumentKeySchema,
  upsertIssueDocumentSchema,
} from "./issue.js";

// ============================================================================
// issueExecutionStagePrincipalSchema — cross-field superRefine
// ============================================================================

describe("issueExecutionStagePrincipalSchema", () => {
  const agentId = "00000000-0000-0000-0000-000000000001";

  it("parses a valid agent principal", () => {
    const result = issueExecutionStagePrincipalSchema.parse({ type: "agent", agentId });
    expect(result.type).toBe("agent");
    expect(result.agentId).toBe(agentId);
  });

  it("rejects an agent principal without agentId", () => {
    expect(() =>
      issueExecutionStagePrincipalSchema.parse({ type: "agent" })
    ).toThrow(/agentId/i);
  });

  it("rejects an agent principal that has userId", () => {
    expect(() =>
      issueExecutionStagePrincipalSchema.parse({ type: "agent", agentId, userId: "user-1" })
    ).toThrow(/userId/i);
  });

  it("parses a valid user principal", () => {
    const result = issueExecutionStagePrincipalSchema.parse({ type: "user", userId: "user-1" });
    expect(result.type).toBe("user");
    expect(result.userId).toBe("user-1");
  });

  it("rejects a user principal without userId", () => {
    expect(() =>
      issueExecutionStagePrincipalSchema.parse({ type: "user" })
    ).toThrow(/userId/i);
  });

  it("rejects a user principal that has agentId", () => {
    expect(() =>
      issueExecutionStagePrincipalSchema.parse({ type: "user", userId: "u", agentId })
    ).toThrow(/agentId/i);
  });
});

// ============================================================================
// issueExecutionStageParticipantSchema
// ============================================================================

describe("issueExecutionStageParticipantSchema", () => {
  const agentId = "00000000-0000-0000-0000-000000000002";

  it("parses a valid agent participant", () => {
    const result = issueExecutionStageParticipantSchema.parse({ type: "agent", agentId });
    expect(result.type).toBe("agent");
  });

  it("accepts an optional participant id", () => {
    const id = "00000000-0000-0000-0000-000000000003";
    const result = issueExecutionStageParticipantSchema.parse({ type: "agent", agentId, id });
    expect(result.id).toBe(id);
  });

  it("rejects agent participant without agentId", () => {
    expect(() =>
      issueExecutionStageParticipantSchema.parse({ type: "agent" })
    ).toThrow(/agentId/i);
  });
});

// ============================================================================
// issueExecutionStageSchema
// ============================================================================

describe("issueExecutionStageSchema", () => {
  it("parses a stage with defaults", () => {
    const result = issueExecutionStageSchema.parse({ type: "review" });
    expect(result.approvalsNeeded).toBe(1);
    expect(result.participants).toEqual([]);
  });

  it("rejects invalid stage type", () => {
    expect(() => issueExecutionStageSchema.parse({ type: "approve" })).toThrow();
  });

  it("accepts participants array", () => {
    const agentId = "00000000-0000-0000-0000-000000000004";
    const result = issueExecutionStageSchema.parse({
      type: "review",
      participants: [{ type: "agent", agentId }],
    });
    expect(result.participants).toHaveLength(1);
  });
});

// ============================================================================
// issueExecutionPolicySchema
// ============================================================================

describe("issueExecutionPolicySchema", () => {
  it("parses with defaults", () => {
    const result = issueExecutionPolicySchema.parse({});
    expect(result.mode).toBe("normal");
    expect(result.commentRequired).toBe(true);
    expect(result.stages).toEqual([]);
  });

  it("accepts custom mode", () => {
    const result = issueExecutionPolicySchema.parse({ mode: "auto" });
    expect(result.mode).toBe("auto");
  });

  it("rejects invalid mode", () => {
    expect(() => issueExecutionPolicySchema.parse({ mode: "manual" })).toThrow();
  });
});

// ============================================================================
// createIssueSchema
// ============================================================================

describe("createIssueSchema", () => {
  it("parses a minimal issue", () => {
    const result = createIssueSchema.parse({ title: "Fix login bug" });
    expect(result.title).toBe("Fix login bug");
    expect(result.status).toBe("backlog");
    expect(result.priority).toBe("medium");
    expect(result.requestDepth).toBe(0);
  });

  it("rejects empty title", () => {
    expect(() => createIssueSchema.parse({ title: "" })).toThrow();
  });

  it("accepts valid status", () => {
    const result = createIssueSchema.parse({ title: "t", status: "in_progress" });
    expect(result.status).toBe("in_progress");
  });

  it("rejects invalid status", () => {
    expect(() => createIssueSchema.parse({ title: "t", status: "deleted" })).toThrow();
  });

  it("accepts valid priority", () => {
    const result = createIssueSchema.parse({ title: "t", priority: "critical" });
    expect(result.priority).toBe("critical");
  });

  it("rejects non-UUID assigneeAgentId", () => {
    expect(() =>
      createIssueSchema.parse({ title: "t", assigneeAgentId: "not-uuid" })
    ).toThrow();
  });

  it("accepts optional labelIds array of UUIDs", () => {
    const id = "00000000-0000-0000-0000-000000000005";
    const result = createIssueSchema.parse({ title: "t", labelIds: [id] });
    expect(result.labelIds).toEqual([id]);
  });
});

// ============================================================================
// createIssueLabelSchema
// ============================================================================

describe("createIssueLabelSchema", () => {
  it("parses a valid label", () => {
    const result = createIssueLabelSchema.parse({ name: "bug", color: "#ff0000" });
    expect(result.name).toBe("bug");
    expect(result.color).toBe("#ff0000");
  });

  it("rejects empty name", () => {
    expect(() => createIssueLabelSchema.parse({ name: "", color: "#000000" })).toThrow();
  });

  it("rejects name over 48 chars", () => {
    expect(() =>
      createIssueLabelSchema.parse({ name: "a".repeat(49), color: "#000000" })
    ).toThrow();
  });

  it("rejects invalid hex color", () => {
    expect(() => createIssueLabelSchema.parse({ name: "bug", color: "red" })).toThrow();
    expect(() => createIssueLabelSchema.parse({ name: "bug", color: "#fff" })).toThrow();
    expect(() => createIssueLabelSchema.parse({ name: "bug", color: "#gggggg" })).toThrow();
  });

  it("accepts 6-digit hex with uppercase", () => {
    const result = createIssueLabelSchema.parse({ name: "bug", color: "#AABBCC" });
    expect(result.color).toBe("#AABBCC");
  });

  it("trims whitespace from name", () => {
    const result = createIssueLabelSchema.parse({ name: "  bug  ", color: "#ff0000" });
    expect(result.name).toBe("bug");
  });
});

// ============================================================================
// checkoutIssueSchema
// ============================================================================

describe("checkoutIssueSchema", () => {
  const agentId = "00000000-0000-0000-0000-000000000006";

  it("parses a valid checkout", () => {
    const result = checkoutIssueSchema.parse({
      agentId,
      expectedStatuses: ["backlog", "in_progress"],
    });
    expect(result.agentId).toBe(agentId);
    expect(result.expectedStatuses).toHaveLength(2);
  });

  it("rejects empty expectedStatuses array", () => {
    expect(() =>
      checkoutIssueSchema.parse({ agentId, expectedStatuses: [] })
    ).toThrow();
  });

  it("rejects invalid agentId", () => {
    expect(() =>
      checkoutIssueSchema.parse({ agentId: "bad", expectedStatuses: ["backlog"] })
    ).toThrow();
  });

  it("rejects invalid status values", () => {
    expect(() =>
      checkoutIssueSchema.parse({ agentId, expectedStatuses: ["deleted"] })
    ).toThrow();
  });
});

// ============================================================================
// addIssueCommentSchema
// ============================================================================

describe("addIssueCommentSchema", () => {
  it("parses a minimal comment", () => {
    const result = addIssueCommentSchema.parse({ body: "Looks good!" });
    expect(result.body).toBe("Looks good!");
  });

  it("rejects empty body", () => {
    expect(() => addIssueCommentSchema.parse({ body: "" })).toThrow();
  });

  it("accepts optional reopen and interrupt flags", () => {
    const result = addIssueCommentSchema.parse({ body: "done", reopen: true, interrupt: false });
    expect(result.reopen).toBe(true);
    expect(result.interrupt).toBe(false);
  });
});

// ============================================================================
// issueDocumentKeySchema
// ============================================================================

describe("issueDocumentKeySchema", () => {
  it("accepts a valid lowercase key", () => {
    const result = issueDocumentKeySchema.parse("my-doc_v2");
    expect(result).toBe("my-doc_v2");
  });

  it("trims whitespace", () => {
    const result = issueDocumentKeySchema.parse("  doc  ");
    expect(result).toBe("doc");
  });

  it("rejects keys starting with a dash", () => {
    expect(() => issueDocumentKeySchema.parse("-bad")).toThrow();
  });

  it("rejects keys with uppercase letters", () => {
    expect(() => issueDocumentKeySchema.parse("MyDoc")).toThrow();
  });

  it("rejects keys with spaces", () => {
    expect(() => issueDocumentKeySchema.parse("my doc")).toThrow();
  });

  it("rejects empty key", () => {
    expect(() => issueDocumentKeySchema.parse("")).toThrow();
  });

  it("rejects keys over 64 chars", () => {
    expect(() => issueDocumentKeySchema.parse("a".repeat(65))).toThrow();
  });
});

// ============================================================================
// upsertIssueDocumentSchema
// ============================================================================

describe("upsertIssueDocumentSchema", () => {
  it("parses a valid document upsert", () => {
    const result = upsertIssueDocumentSchema.parse({
      format: "markdown",
      body: "# Hello",
    });
    expect(result.format).toBe("markdown");
    expect(result.body).toBe("# Hello");
  });

  it("rejects invalid format", () => {
    expect(() =>
      upsertIssueDocumentSchema.parse({ format: "html", body: "<h1>x</h1>" })
    ).toThrow();
  });

  it("rejects body over 524288 chars", () => {
    expect(() =>
      upsertIssueDocumentSchema.parse({ format: "markdown", body: "x".repeat(524289) })
    ).toThrow();
  });

  it("accepts an optional changeSummary", () => {
    const result = upsertIssueDocumentSchema.parse({
      format: "markdown",
      body: "content",
      changeSummary: "Added intro",
    });
    expect(result.changeSummary).toBe("Added intro");
  });

  it("rejects changeSummary over 500 chars", () => {
    expect(() =>
      upsertIssueDocumentSchema.parse({
        format: "markdown",
        body: "content",
        changeSummary: "x".repeat(501),
      })
    ).toThrow();
  });
});
