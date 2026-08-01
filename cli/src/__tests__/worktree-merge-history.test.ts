import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  assets,
  companies,
  createDb,
  documentRevisions,
  documents,
  issueAttachments,
  issueComments,
  issueDocuments,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  buildWorktreeMergePlan,
  parseWorktreeMergeScopes,
} from "../commands/worktree-merge-history-lib.js";
import { applyMergePlan } from "../commands/worktree.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const itEmbeddedPostgres = embeddedPostgresSupport.supported ? it : it.skip;

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

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    companyId: "company-1",
    goalId: null,
    name: "Project",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: "#22c55e",
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    archivedAt: null,
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

function makeProjectWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    name: "Workspace",
    sourceType: "local_path",
    cwd: "/tmp/project",
    repoUrl: "https://github.com/example/project.git",
    repoRef: "main",
    defaultRef: "main",
    visibility: "default",
    setupCommand: null,
    cleanupCommand: null,
    remoteProvider: null,
    remoteWorkspaceRef: null,
    sharedWorkspaceKey: null,
    metadata: null,
    isPrimary: true,
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

function queryParameterValues(value: unknown, seen = new Set<unknown>()): string[] {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (
    value.constructor?.name === "Param" &&
    "value" in value &&
    typeof value.value === "string"
  ) {
    return [value.value];
  }
  return Object.values(value).flatMap((nested) =>
    queryParameterValues(nested, seen));
}

function instrumentedMergeHarness({
  companyId,
  expectedParentIds,
  previousLinkParentId,
  failStorage = false,
}: {
  companyId: string;
  expectedParentIds: string[];
  previousLinkParentId: string;
  failStorage?: boolean;
}) {
  const events: string[] = [];
  let lockedIds: string[] = [];
  let committed = false;
  let rolledBack = false;

  class Query {
    table: unknown;
    selection: Record<string, unknown> | undefined;
    kind: "select" | "insert" | "update";
    whereValues: string[] = [];
    ordered = false;
    lock: string | null = null;
    executed = false;

    constructor(
      kind: "select" | "insert" | "update",
      table?: unknown,
      selection?: Record<string, unknown>,
    ) {
      this.kind = kind;
      this.table = table;
      this.selection = selection;
    }

    from(table: unknown) {
      this.table = table;
      return this;
    }

    where(condition: unknown) {
      this.whereValues = queryParameterValues(condition);
      return this;
    }

    orderBy(..._values: unknown[]) {
      this.ordered = true;
      return this;
    }

    for(lock: string) {
      this.lock = lock;
      return this;
    }

    values(_values: unknown) {
      return this;
    }

    set(_values: unknown) {
      return this;
    }

    returning(_selection?: unknown) {
      return this;
    }

    async execute() {
      if (this.executed) return [];
      this.executed = true;
      const fields = Object.keys(this.selection ?? {}).sort().join(",");

      if (this.kind === "select") {
        if (this.table === projects || this.table === projectWorkspaces) return [];
        if (this.table === issueComments || this.table === issueAttachments) return [];
        if (this.table === issues && this.lock === "update") {
          events.push("parent-lock");
          lockedIds = this.whereValues.filter((value) => value !== companyId);
          expect(this.ordered).toBe(true);
          return expectedParentIds.map((id) => ({ id }));
        }
        if (this.table === issues) return [{ id: expectedParentIds[0] }];
        if (this.table === issueDocuments && fields === "documentId,issueId") {
          events.push(this.lock === "update" ? "link-revalidate" : "link-prefetch");
          return [{ documentId: "document-1", issueId: previousLinkParentId }];
        }
        if (this.table === issueDocuments && fields === "documentId") {
          return [{ documentId: "document-1" }];
        }
        if (this.table === issueDocuments && fields === "id,issueId") {
          return [{ id: "link-1", issueId: previousLinkParentId }];
        }
        if (this.table === documents) return [{ id: "document-1" }];
        if (this.table === documentRevisions) return [];
        return [];
      }

      const tableName =
        this.table === issueComments ? "comments"
          : this.table === issueDocuments ? "links"
            : this.table === documents ? "documents"
              : this.table === documentRevisions ? "revisions"
                : this.table === assets ? "assets"
                  : this.table === issueAttachments ? "attachments"
                    : this.table === issues ? "issues"
                      : "other";
      if (this.table === issues && this.kind === "update") {
        events.push("parent-version-update");
      } else {
        events.push(`child-${this.kind}:${tableName}`);
      }
      return [];
    }

    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return this.execute().then(onfulfilled, onrejected);
    }
  }

  const tx = {
    select: (selection?: Record<string, unknown>) =>
      new Query("select", undefined, selection),
    insert: (table: unknown) => new Query("insert", table),
    update: (table: unknown) => new Query("update", table),
  };
  const targetDb = {
    transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      try {
        const result = await callback(tx);
        committed = true;
        return result;
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    },
  };
  const sourceStorage = {
    getObject: vi.fn(async () => Buffer.from("image")),
    putObject: vi.fn(async () => undefined),
  };
  const targetStorage = {
    getObject: vi.fn(async () => Buffer.alloc(0)),
    putObject: vi.fn(async () => {
      events.push("storage-put");
      if (failStorage) throw new Error("storage unavailable");
    }),
  };
  return {
    events,
    get lockedIds() {
      return lockedIds;
    },
    get committed() {
      return committed;
    },
    get rolledBack() {
      return rolledBack;
    },
    sourceStorage,
    targetDb: targetDb as any,
    targetStorage,
  };
}

function orderingMergePlan(parentIds: {
  comment: string;
  document: string;
  attachment: string;
}) {
  return {
    projectImports: [],
    issuePlans: [],
    commentPlans: [
      {
        action: "insert",
        source: makeComment({
          id: "comment-ordering",
          issueId: parentIds.comment,
        }),
        targetAuthorAgentId: null,
      },
    ],
    documentPlans: [
      {
        action: "merge_existing",
        source: makeIssueDocument({
          id: "link-1",
          issueId: parentIds.document,
          documentId: "document-1",
          latestRevisionId: "revision-2",
          latestRevisionNumber: 2,
        }),
        targetCreatedByAgentId: null,
        targetUpdatedByAgentId: null,
        latestRevisionId: "revision-2",
        latestRevisionNumber: 2,
        revisionsToInsert: [
          {
            source: makeDocumentRevision({
              id: "revision-2",
              documentId: "document-1",
              revisionNumber: 2,
            }),
            targetRevisionNumber: 2,
            targetCreatedByAgentId: null,
          },
        ],
      },
    ],
    attachmentPlans: [
      {
        action: "insert",
        source: makeAttachment({
          id: "attachment-ordering",
          issueId: parentIds.attachment,
        }),
        targetIssueCommentId: null,
        targetCreatedByAgentId: null,
      },
    ],
  } as any;
}

describe("worktree merge history planner", () => {
  it("parses default scopes", () => {
    expect(parseWorktreeMergeScopes(undefined)).toEqual(["issues", "comments"]);
    expect(parseWorktreeMergeScopes("issues")).toEqual(["issues"]);
  });

  itEmbeddedPostgres("increments an imported issue projection once per merge transaction", async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-worktree-merge-version-");
    const db = createDb(tempDb.connectionString);
    const companyId = randomUUID();
    const issueId = randomUUID();
    const firstCommentId = randomUUID();
    const secondCommentId = randomUUID();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const attachmentId = randomUUID();
    const assetId = randomUUID();

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: "MRG",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Existing target issue",
        status: "todo",
        priority: "medium",
        issueNumber: 1,
        identifier: "MRG-1",
      });
      const [targetIssue] = await db.select().from(issues).where(eq(issues.id, issueId));

      const plan = buildWorktreeMergePlan({
        companyId,
        companyName: "Paperclip",
        issuePrefix: "MRG",
        previewIssueCounterStart: 1,
        scopes: ["issues", "comments"],
        sourceIssues: [targetIssue],
        targetIssues: [targetIssue],
        sourceComments: [
          makeComment({ id: firstCommentId, companyId, issueId, body: "First imported comment" }),
          makeComment({ id: secondCommentId, companyId, issueId, body: "Second imported comment" }),
        ],
        targetComments: [],
        sourceDocuments: [
          makeIssueDocument({
            id: randomUUID(),
            companyId,
            issueId,
            documentId,
            latestRevisionId: revisionId,
          }),
        ],
        targetDocuments: [],
        sourceDocumentRevisions: [
          makeDocumentRevision({ id: revisionId, companyId, documentId }),
        ],
        targetDocumentRevisions: [],
        sourceAttachments: [
          makeAttachment({
            id: attachmentId,
            companyId,
            issueId,
            issueCommentId: firstCommentId,
            assetId,
            objectKey: `${companyId}/issues/${issueId}/asset.png`,
          }),
        ],
        targetAttachments: [],
        sourceProjects: [],
        sourceProjectWorkspaces: [],
        targetAgents: [],
        targetProjects: [],
        targetProjectWorkspaces: [],
        targetGoals: [],
      });
      const sourceStorage = {
        getObject: vi.fn(async () => Buffer.from("image")),
        putObject: vi.fn(async () => undefined),
      };
      const targetStorage = {
        getObject: vi.fn(async () => Buffer.alloc(0)),
        putObject: vi.fn(async () => undefined),
      };

      await applyMergePlan({
        sourceStorages: [sourceStorage],
        targetStorage,
        targetDb: db,
        company: { id: companyId, name: "Paperclip", issuePrefix: "MRG" },
        plan,
      });

      const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(updatedIssue.version).toBe(2);
      expect(targetStorage.putObject).toHaveBeenCalledOnce();
    } finally {
      await db.$client?.end?.({ timeout: 5 }).catch(() => undefined);
      await tempDb.cleanup();
    }
  }, 120_000);

  it("locks every planned and previous-link parent before child mutations", async () => {
    const companyId = "company-1";
    const parentIds = {
      comment: "issue-comment",
      document: "issue-document-new",
      attachment: "issue-attachment",
    };
    const previousLinkParentId = "issue-document-old";
    const expectedParentIds = [
      parentIds.attachment,
      parentIds.comment,
      parentIds.document,
      previousLinkParentId,
    ].sort();
    const harness = instrumentedMergeHarness({
      companyId,
      expectedParentIds,
      previousLinkParentId,
    });

    const result = await applyMergePlan({
      sourceStorages: [harness.sourceStorage],
      targetStorage: harness.targetStorage,
      targetDb: harness.targetDb,
      company: { id: companyId, name: "Paperclip", issuePrefix: "MRG" },
      plan: orderingMergePlan(parentIds),
    });

    expect(harness.lockedIds).toEqual(expectedParentIds);
    expect(harness.events.indexOf("parent-lock")).toBeGreaterThanOrEqual(0);
    expect(harness.events.indexOf("link-revalidate")).toBeGreaterThan(
      harness.events.indexOf("parent-lock"),
    );
    const firstChild = harness.events.findIndex((event) => event.startsWith("child-"));
    expect(firstChild).toBeGreaterThan(harness.events.indexOf("link-revalidate"));
    expect(result).toMatchObject({
      insertedComments: 1,
      mergedDocuments: 1,
      insertedDocumentRevisions: 1,
      insertedAttachments: 1,
    });
    expect(harness.committed).toBe(true);
  });

  it("defers object storage writes until after the parent version update", async () => {
    const companyId = "company-1";
    const parentIds = {
      comment: "issue-comment",
      document: "issue-document-new",
      attachment: "issue-attachment",
    };
    const harness = instrumentedMergeHarness({
      companyId,
      expectedParentIds: [
        parentIds.attachment,
        parentIds.comment,
        parentIds.document,
        "issue-document-old",
      ].sort(),
      previousLinkParentId: "issue-document-old",
    });

    await applyMergePlan({
      sourceStorages: [harness.sourceStorage],
      targetStorage: harness.targetStorage,
      targetDb: harness.targetDb,
      company: { id: companyId, name: "Paperclip", issuePrefix: "MRG" },
      plan: orderingMergePlan(parentIds),
    });

    expect(harness.events.indexOf("storage-put")).toBeGreaterThan(
      harness.events.indexOf("parent-version-update"),
    );
  });

  itEmbeddedPostgres("rolls back attachment metadata and version when storage fails", async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-worktree-storage-rollback-");
    const db = createDb(tempDb.connectionString);
    const companyId = randomUUID();
    const issueId = randomUUID();
    const attachmentId = randomUUID();
    const assetId = randomUUID();
    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: "MRG",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Existing target issue",
        status: "todo",
        priority: "medium",
        issueNumber: 1,
        identifier: "MRG-1",
      });
      const plan = {
        projectImports: [],
        issuePlans: [],
        commentPlans: [],
        documentPlans: [],
        attachmentPlans: [
          {
            action: "insert",
            source: makeAttachment({
              id: attachmentId,
              companyId,
              issueId,
              assetId,
              objectKey: `${companyId}/issues/${issueId}/asset.png`,
            }),
            targetIssueCommentId: null,
            targetCreatedByAgentId: null,
          },
        ],
      } as any;

      await expect(
        applyMergePlan({
          sourceStorages: [{
            getObject: vi.fn(async () => Buffer.from("image")),
            putObject: vi.fn(async () => undefined),
          }],
          targetStorage: {
            getObject: vi.fn(async () => Buffer.alloc(0)),
            putObject: vi.fn(async () => {
              throw new Error("storage unavailable");
            }),
          },
          targetDb: db,
          company: { id: companyId, name: "Paperclip", issuePrefix: "MRG" },
          plan,
        }),
      ).rejects.toThrow("storage unavailable");

      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      const storedAssets = await db.select().from(assets).where(eq(assets.id, assetId));
      const storedAttachments = await db
        .select()
        .from(issueAttachments)
        .where(eq(issueAttachments.id, attachmentId));
      expect(issue.version).toBe(1);
      expect(storedAssets).toEqual([]);
      expect(storedAttachments).toEqual([]);
    } finally {
      await db.$client?.end?.({ timeout: 5 }).catch(() => undefined);
      await tempDb.cleanup();
    }
  }, 120_000);

  itEmbeddedPostgres("avoids the issue-to-document-link lock inversion", async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-worktree-lock-order-");
    const db = createDb(tempDb.connectionString);
    const companyId = randomUUID();
    const issueId = randomUUID();
    const documentId = randomUUID();
    const linkId = randomUUID();
    const revisionId = randomUUID();
    let releaseDocumentMutation!: () => void;
    const mayLockLink = new Promise<void>((resolve) => {
      releaseDocumentMutation = resolve;
    });
    let reportParentLocked!: () => void;
    const parentLocked = new Promise<void>((resolve) => {
      reportParentLocked = resolve;
    });

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: "MRG",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Existing target issue",
        status: "todo",
        priority: "medium",
        issueNumber: 1,
        identifier: "MRG-1",
      });
      await db.insert(documents).values({
        id: documentId,
        companyId,
        title: "Plan",
        format: "markdown",
        latestBody: "# Old",
        latestRevisionId: null,
        latestRevisionNumber: 1,
      });
      await db.insert(issueDocuments).values({
        id: linkId,
        companyId,
        issueId,
        documentId,
        key: "plan",
      });

      const documentMutation = db.transaction(async (tx) => {
        await tx
          .select({ id: issues.id })
          .from(issues)
          .where(eq(issues.id, issueId))
          .for("update");
        reportParentLocked();
        await mayLockLink;
        await tx
          .update(issueDocuments)
          .set({ updatedAt: new Date("2026-03-21T00:00:00.000Z") })
          .where(eq(issueDocuments.documentId, documentId));
      });
      await parentLocked;

      const plan = {
        projectImports: [],
        issuePlans: [],
        commentPlans: [],
        attachmentPlans: [],
        documentPlans: [
          {
            action: "merge_existing",
            source: makeIssueDocument({
              id: linkId,
              companyId,
              issueId,
              documentId,
              latestBody: "# New",
              latestRevisionId: revisionId,
              latestRevisionNumber: 2,
            }),
            targetCreatedByAgentId: null,
            targetUpdatedByAgentId: null,
            latestRevisionId: revisionId,
            latestRevisionNumber: 2,
            revisionsToInsert: [
              {
                source: makeDocumentRevision({
                  id: revisionId,
                  companyId,
                  documentId,
                  revisionNumber: 2,
                  body: "# New",
                }),
                targetRevisionNumber: 2,
                targetCreatedByAgentId: null,
              },
            ],
          },
        ],
      } as any;
      const merge = applyMergePlan({
        sourceStorages: [],
        targetStorage: {
          getObject: vi.fn(async () => Buffer.alloc(0)),
          putObject: vi.fn(async () => undefined),
        },
        targetDb: db,
        company: { id: companyId, name: "Paperclip", issuePrefix: "MRG" },
        plan,
      });

      await new Promise((resolve) => setTimeout(resolve, 400));
      releaseDocumentMutation();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all([documentMutation, merge]),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("lock-order regression timed out")), 10_000);
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
    } finally {
      releaseDocumentMutation();
      await db.$client?.end?.({ timeout: 5 }).catch(() => undefined);
      await tempDb.cleanup();
    }
  }, 120_000);

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

  it("plans selected project imports and preserves project workspace links", () => {
    const sourceProject = makeProject({
      id: "source-project-1",
      name: "Paperclip Evals",
      goalId: "goal-1",
    });
    const sourceWorkspace = makeProjectWorkspace({
      id: "source-workspace-1",
      projectId: "source-project-1",
      cwd: "/Users/dotta/paperclip-evals",
      repoUrl: "https://github.com/paperclipai/paperclip-evals.git",
    });

    const plan = buildWorktreeMergePlan({
      companyId: "company-1",
      companyName: "Paperclip",
      issuePrefix: "PAP",
      previewIssueCounterStart: 10,
      scopes: ["issues"],
      sourceIssues: [
        makeIssue({
          id: "issue-project-import",
          identifier: "PAP-88",
          projectId: "source-project-1",
          projectWorkspaceId: "source-workspace-1",
        }),
      ],
      targetIssues: [],
      sourceComments: [],
      targetComments: [],
      sourceProjects: [sourceProject],
      sourceProjectWorkspaces: [sourceWorkspace],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [{ id: "goal-1" }] as any,
      importProjectIds: ["source-project-1"],
    });

    expect(plan.counts.projectsToImport).toBe(1);
    expect(plan.projectImports[0]).toMatchObject({
      source: { id: "source-project-1", name: "Paperclip Evals" },
      targetGoalId: "goal-1",
      workspaces: [{ id: "source-workspace-1" }],
    });

    const insert = plan.issuePlans[0] as any;
    expect(insert.targetProjectId).toBe("source-project-1");
    expect(insert.targetProjectWorkspaceId).toBe("source-workspace-1");
    expect(insert.projectResolution).toBe("imported");
    expect(insert.mappedProjectName).toBe("Paperclip Evals");
    expect(insert.adjustments).toEqual([]);
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
