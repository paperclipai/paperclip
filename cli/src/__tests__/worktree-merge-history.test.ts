import { describe, expect, it } from "vitest";
import { buildWorktreeMergePlan, parseWorktreeMergeScopes } from "../commands/worktree-merge-history-lib.js";

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: "goal-1",
    parentId: null,
    title: "Issue",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    issueNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

function makeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: "comment-1",
    companyId: "company-1",
    issueId: "issue-1",
    authorAgentId: null,
    authorUserId: "local-board",
    body: "hello",
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

function makeIssueDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-document-1",
    companyId: "company-1",
    issueId: "issue-1",
    documentId: "document-1",
    key: "plan",
    linkCreatedAt: new Date("2026-03-20T00:00:00.000Z"),
    linkUpdatedAt: new Date("2026-03-20T00:00:00.000Z"),
    title: "Plan",
    format: "markdown",
    latestBody: "# Plan",
    latestRevisionId: "revision-1",
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: "local-board",
    updatedByAgentId: null,
    updatedByUserId: "local-board",
    documentCreatedAt: new Date("2026-03-20T00:00:00.000Z"),
    documentUpdatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

function makeDocumentRevision(overrides: Record<string, unknown> = {}) {
  return {
    id: "revision-1",
    companyId: "company-1",
    documentId: "document-1",
    revisionNumber: 1,
    body: "# Plan",
    changeSummary: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

function makeAttachment(overrides: Record<string, unknown> = {}) {
  return {
    id: "attachment-1",
    companyId: "company-1",
    issueId: "issue-1",
    issueCommentId: null,
    assetId: "asset-1",
    provider: "local_disk",
    objectKey: "company-1/issues/issue-1/2026/03/20/asset.png",
    contentType: "image/png",
    byteSize: 12,
    sha256: "deadbeef",
    originalFilename: "asset.png",
    createdByAgentId: null,
    createdByUserId: "local-board",
    assetCreatedAt: new Date("2026-03-20T00:00:00.000Z"),
    assetUpdatedAt: new Date("2026-03-20T00:00:00.000Z"),
    attachmentCreatedAt: new Date("2026-03-20T00:00:00.000Z"),
    attachmentUpdatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

describe("worktree merge history planner", () => {
  it("parses default scopes", () => {
    expect(parseWorktreeMergeScopes(undefined)).toEqual(["issues", "comments"]);
    expect(parseWorktreeMergeScopes("issues")).toEqual(["issues"]);
  });

  it("dedupes nested worktree issues by preserved source uuid", () => {
    const sharedIssue = makeIssue({ id: "issue-a", identifier: "PAP-10", title: "Shared" });
    const branchOneIssue = makeIssue({
      id: "issue-b",
      identifier: "PAP-22",
      title: "Branch one issue",
      createdAt: new Date("2026-03-20T01:00:00.000Z"),
    });
    const branchTwoIssue = makeIssue({
      id: "issue-c",
      identifier: "PAP-23",
      title: "Branch two issue",
      createdAt: new Date("2026-03-20T02:00:00.000Z"),
    });

    const plan = buildWorktreeMergePlan({
      companyId: "company-1",
      companyName: "Paperclip",
      issuePrefix: "PAP",
      previewIssueCounterStart: 500,
      scopes: ["issues", "comments"],
      sourceIssues: [sharedIssue, branchOneIssue, branchTwoIssue],
      targetIssues: [sharedIssue, branchOneIssue],
      sourceComments: [],
      targetComments: [],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [{ id: "goal-1" }] as any,
    });

    expect(plan.counts.issuesToInsert).toBe(1);
    expect(plan.issuePlans.filter((item) => item.action === "insert").map((item) => item.source.id)).toEqual(["issue-c"]);
    expect(plan.issuePlans.find((item) => item.source.id === "issue-c" && item.action === "insert")).toMatchObject({
      previewIdentifier: "PAP-501",
    });
  });

  it("clears missing references and coerces in_progress without an assignee", () => {
    const plan = buildWorktreeMergePlan({
      companyId: "company-1",
      companyName: "Paperclip",
      issuePrefix: "PAP",
      previewIssueCounterStart: 10,
      scopes: ["issues"],
      sourceIssues: [
        makeIssue({
          id: "issue-x",
          identifier: "PAP-99",
          status: "in_progress",
          assigneeAgentId: "agent-missing",
          projectId: "project-missing",
          projectWorkspaceId: "workspace-missing",
          goalId: "goal-missing",
        }),
      ],
      targetIssues: [],
      sourceComments: [],
      targetComments: [],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [],
    });

    const insert = plan.issuePlans[0] as any;
    expect(insert.targetStatus).toBe("todo");
    expect(insert.targetAssigneeAgentId).toBeNull();
    expect(insert.targetProjectId).toBeNull();
    expect(insert.targetProjectWorkspaceId).toBeNull();
    expect(insert.targetGoalId).toBeNull();
    expect(insert.adjustments).toEqual([
      "clear_assignee_agent",
      "clear_project",
      "clear_project_workspace",
      "clear_goal",
      "coerce_in_progress_to_todo",
    ]);
  });

  it("applies an explicit project mapping override instead of clearing the project", () => {
    const plan = buildWorktreeMergePlan({
      companyId: "company-1",
      companyName: "Paperclip",
      issuePrefix: "PAP",
      previewIssueCounterStart: 10,
      scopes: ["issues"],
      sourceIssues: [
        makeIssue({
          id: "issue-project-map",
          identifier: "PAP-77",
          projectId: "source-project-1",
          projectWorkspaceId: "source-workspace-1",
        }),
      ],
      targetIssues: [],
      sourceComments: [],
      targetComments: [],
      targetAgents: [],
      targetProjects: [{ id: "target-project-1", name: "Mapped project", status: "in_progress" }] as any,
      targetProjectWorkspaces: [],
      targetGoals: [{ id: "goal-1" }] as any,
      projectIdOverrides: {
        "source-project-1": "target-project-1",
      },
    });

    const insert = plan.issuePlans[0] as any;
    expect(insert.targetProjectId).toBe("target-project-1");
    expect(insert.projectResolution).toBe("mapped");
    expect(insert.mappedProjectName).toBe("Mapped project");
    expect(insert.targetProjectWorkspaceId).toBeNull();
    expect(insert.adjustments).toEqual(["clear_project_workspace"]);
  });

  it("imports comments onto shared or newly imported issues while skipping existing comments", () => {
    const sharedIssue = makeIssue({ id: "issue-a", identifier: "PAP-10" });
    const newIssue = makeIssue({
      id: "issue-b",
      identifier: "PAP-11",
      createdAt: new Date("2026-03-20T01:00:00.000Z"),
    });
    const existingComment = makeComment({ id: "comment-existing", issueId: "issue-a" });
    const sharedIssueComment = makeComment({ id: "comment-shared", issueId: "issue-a" });
    const newIssueComment = makeComment({
      id: "comment-new-issue",
      issueId: "issue-b",
      authorAgentId: "missing-agent",
      createdAt: new Date("2026-03-20T01:05:00.000Z"),
    });

    const plan = buildWorktreeMergePlan({
      companyId: "company-1",
      companyName: "Paperclip",
      issuePrefix: "PAP",
      previewIssueCounterStart: 10,
      scopes: ["issues", "comments"],
      sourceIssues: [sharedIssue, newIssue],
      targetIssues: [sharedIssue],
      sourceComments: [existingComment, sharedIssueComment, newIssueComment],
      targetComments: [existingComment],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [{ id: "goal-1" }] as any,
    });

    expect(plan.counts.commentsToInsert).toBe(2);
    expect(plan.counts.commentsExisting).toBe(1);
    expect(plan.commentPlans.filter((item) => item.action === "insert").map((item) => item.source.id)).toEqual([
      "comment-shared",
      "comment-new-issue",
    ]);
    expect(plan.adjustments.clear_author_agent).toBe(1);
  });

  it("merges document revisions onto an existing shared document and renumbers conflicts", () => {
    const sharedIssue = makeIssue({ id: "issue-a", identifier: "PAP-10" });
    const sourceDocument = makeIssueDocument({
      issueId: "issue-a",
      documentId: "document-a",
      latestBody: "# Branch plan",
      latestRevisionId: "revision-branch-2",
      latestRevisionNumber: 2,
      documentUpdatedAt: new Date("2026-03-20T02:00:00.000Z"),
      linkUpdatedAt: new Date("2026-03-20T02:00:00.000Z"),
    });
    const targetDocument = makeIssueDocument({
      issueId: "issue-a",
      documentId: "document-a",
      latestBody: "# Main plan",
      latestRevisionId: "revision-main-2",
      latestRevisionNumber: 2,
      documentUpdatedAt: new Date("2026-03-20T01:00:00.000Z"),
      linkUpdatedAt: new Date("2026-03-20T01:00:00.000Z"),
    });
    const sourceRevisionOne = makeDocumentRevision({ documentId: "document-a", id: "revision-1" });
    const sourceRevisionTwo = makeDocumentRevision({
      documentId: "document-a",
      id: "revision-branch-2",
      revisionNumber: 2,
      body: "# Branch plan",
      createdAt: new Date("2026-03-20T02:00:00.000Z"),
    });
    const targetRevisionOne = makeDocumentRevision({ documentId: "document-a", id: "revision-1" });
    const targetRevisionTwo = makeDocumentRevision({
      documentId: "document-a",
      id: "revision-main-2",
      revisionNumber: 2,
      body: "# Main plan",
      createdAt: new Date("2026-03-20T01:00:00.000Z"),
    });

    const plan = buildWorktreeMergePlan({
      companyId: "company-1",
      companyName: "Paperclip",
      issuePrefix: "PAP",
      previewIssueCounterStart: 10,
      scopes: ["issues", "comments"],
      sourceIssues: [sharedIssue],
      targetIssues: [sharedIssue],
      sourceComments: [],
      targetComments: [],
      sourceDocuments: [sourceDocument],
      targetDocuments: [targetDocument],
      sourceDocumentRevisions: [sourceRevisionOne, sourceRevisionTwo],
      targetDocumentRevisions: [targetRevisionOne, targetRevisionTwo],
      sourceAttachments: [],
      targetAttachments: [],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [{ id: "goal-1" }] as any,
    });

    expect(plan.counts.documentsToMerge).toBe(1);
    expect(plan.counts.documentRevisionsToInsert).toBe(1);
    expect(plan.documentPlans[0]).toMatchObject({
      action: "merge_existing",
      latestRevisionId: "revision-branch-2",
      latestRevisionNumber: 3,
    });
    const mergePlan = plan.documentPlans[0] as any;
    expect(mergePlan.revisionsToInsert).toHaveLength(1);
    expect(mergePlan.revisionsToInsert[0]).toMatchObject({
      source: { id: "revision-branch-2" },
      targetRevisionNumber: 3,
    });
  });

  it("imports attachments while clearing missing comment and author references", () => {
    const sharedIssue = makeIssue({ id: "issue-a", identifier: "PAP-10" });
    const attachment = makeAttachment({
      issueId: "issue-a",
      issueCommentId: "comment-missing",
      createdByAgentId: "agent-missing",
    });

    const plan = buildWorktreeMergePlan({
      companyId: "company-1",
      companyName: "Paperclip",
      issuePrefix: "PAP",
      previewIssueCounterStart: 10,
      scopes: ["issues"],
      sourceIssues: [sharedIssue],
      targetIssues: [sharedIssue],
      sourceComments: [],
      targetComments: [],
      sourceDocuments: [],
      targetDocuments: [],
      sourceDocumentRevisions: [],
      targetDocumentRevisions: [],
      sourceAttachments: [attachment],
      targetAttachments: [],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [{ id: "goal-1" }] as any,
    });

    expect(plan.counts.attachmentsToInsert).toBe(1);
    expect(plan.adjustments.clear_attachment_agent).toBe(1);
    expect(plan.attachmentPlans[0]).toMatchObject({
      action: "insert",
      targetIssueCommentId: null,
      targetCreatedByAgentId: null,
    });
  });
});
