import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  environments,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueInboxArchives,
  issueDocuments,
  issuePlanDecompositions,
  issueRelations,
  issueThreadInteractions,
  issues,
  projectWorkspaces,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.ts";
import {
  clampIssueListLimit,
  deriveIssueCommentRunLogAttribution,
  ISSUE_LIST_MAX_LIMIT,
  issueService,
} from "../services/issues.ts";
import { buildAgentMentionHref, buildProjectMentionHref, MAX_ISSUE_REQUEST_DEPTH } from "@paperclipai/shared";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("issue list limit helpers", () => {
  it("clamps untrusted issue-list limits to the server maximum", () => {
    expect(clampIssueListLimit(0)).toBe(1);
    expect(clampIssueListLimit(25.9)).toBe(25);
    expect(clampIssueListLimit(ISSUE_LIST_MAX_LIMIT + 10)).toBe(ISSUE_LIST_MAX_LIMIT);
  });
});

describe("deriveIssueCommentRunLogAttribution", () => {
  it("recovers agent attribution from run logs that printed the posted comment id", () => {
    const commentId = randomUUID();
    const runId = randomUUID();
    const agentId = randomUUID();

    const derived = deriveIssueCommentRunLogAttribution(
      [
        {
          id: commentId,
          authorAgentId: null,
          authorUserId: "user-1",
          createdByRunId: null,
          createdAt: new Date("2026-05-11T18:55:40.090Z"),
        },
      ],
      [
        {
          runId,
          agentId,
          createdAt: new Date("2026-05-11T18:51:56.246Z"),
          startedAt: new Date("2026-05-11T18:51:56.257Z"),
          finishedAt: new Date("2026-05-11T18:55:45.600Z"),
          logContent: `comment id: ${commentId}\n`,
        },
      ],
    );

    expect(derived.get(commentId)).toEqual({
      derivedAuthorAgentId: agentId,
      derivedCreatedByRunId: runId,
      derivedAuthorSource: "run_log_comment_post",
    });
  });

  it("does not rewrite comments without exact run-log proof", () => {
    const commentId = randomUUID();
    const derived = deriveIssueCommentRunLogAttribution(
      [
        {
          id: commentId,
          authorAgentId: null,
          authorUserId: "user-1",
          createdByRunId: null,
          createdAt: new Date("2026-05-11T18:55:40.090Z"),
        },
      ],
      [
        {
          runId: randomUUID(),
          agentId: randomUUID(),
          createdAt: new Date("2026-05-11T18:51:56.246Z"),
          startedAt: new Date("2026-05-11T18:51:56.257Z"),
          finishedAt: new Date("2026-05-11T18:55:45.600Z"),
          logContent: "posted results without echoing the comment id",
        },
      ],
    );

    expect(derived.has(commentId)).toBe(false);
  });
});

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.list participantAgentId", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-service-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueDocuments);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(documents);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAssignableAgentCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  function agentRow(companyId: string, input: {
    id: string;
    name: string;
    status?: string;
    reportsTo?: string | null;
  }) {
    return {
      id: input.id,
      companyId,
      name: input.name,
      role: "engineer",
      status: input.status ?? "active",
      reportsTo: input.reportsTo ?? null,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    };
  }

  it("rejects direct terminated assignees with structured conflict details", async () => {
    const companyId = await seedAssignableAgentCompany();
    const terminatedAgentId = randomUUID();
    await db.insert(agents).values(agentRow(companyId, {
      id: terminatedAgentId,
      name: "TerminatedCoder",
      status: "terminated",
    }));

    await expect(svc.create(companyId, {
      title: "Do not assign this",
      description: null,
      status: "todo",
      priority: "medium",
      assigneeAgentId: terminatedAgentId,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "agent_not_assignable",
        reason: "assignee_terminated",
        assigneeAgentId: terminatedAgentId,
      },
    });
  });

  it("rejects invalid ancestor-chain assignees and preserves the existing assignment", async () => {
    const companyId = await seedAssignableAgentCompany();
    const activeAgentId = randomUUID();
    const terminatedManagerId = randomUUID();
    const blockedAgentId = randomUUID();
    await db.insert(agents).values([
      agentRow(companyId, { id: activeAgentId, name: "ActiveCoder" }),
      agentRow(companyId, {
        id: terminatedManagerId,
        name: "TerminatedManager",
        status: "terminated",
      }),
      agentRow(companyId, {
        id: blockedAgentId,
        name: "BlockedCoder",
        reportsTo: terminatedManagerId,
      }),
    ]);
    const issue = await svc.create(companyId, {
      title: "Keep current assignment",
      description: null,
      status: "todo",
      priority: "medium",
      assigneeAgentId: activeAgentId,
    });

    await expect(svc.update(issue.id, {
      assigneeAgentId: blockedAgentId,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "agent_not_assignable",
        reason: "ancestor_terminated",
        assigneeAgentId: blockedAgentId,
        invalidAncestorAgentId: terminatedManagerId,
      },
    });

    const persisted = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issue.id))
      .then((rows) => rows[0] ?? null);
    expect(persisted?.assigneeAgentId).toBe(activeAgentId);
  });

  it("rejects checkout by a terminated agent before assigning the issue", async () => {
    const companyId = await seedAssignableAgentCompany();
    const terminatedAgentId = randomUUID();
    await db.insert(agents).values(agentRow(companyId, {
      id: terminatedAgentId,
      name: "TerminatedCheckoutCoder",
      status: "terminated",
    }));
    const issue = await svc.create(companyId, {
      title: "Checkout must stay unassigned",
      description: null,
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
    });

    await expect(svc.checkout(issue.id, terminatedAgentId, ["todo"], randomUUID()))
      .rejects.toMatchObject({
        status: 409,
        details: {
          code: "agent_not_assignable",
          reason: "assignee_terminated",
          assigneeAgentId: terminatedAgentId,
        },
      });

    const persisted = await db
      .select({ assigneeAgentId: issues.assigneeAgentId, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issue.id))
      .then((rows) => rows[0] ?? null);
    expect(persisted).toMatchObject({
      assigneeAgentId: null,
      status: "todo",
    });
  });

  it("rejects moving an existing terminated assignment into progress without clearing it", async () => {
    const companyId = await seedAssignableAgentCompany();
    const assigneeAgentId = randomUUID();
    await db.insert(agents).values(agentRow(companyId, {
      id: assigneeAgentId,
      name: "SoonTerminatedCoder",
    }));
    const issue = await svc.create(companyId, {
      title: "Do not restart after termination",
      description: null,
      status: "todo",
      priority: "medium",
      assigneeAgentId,
    });
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, assigneeAgentId));

    await expect(svc.update(issue.id, {
      status: "in_progress",
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "agent_not_assignable",
        reason: "assignee_terminated",
        assigneeAgentId,
      },
    });

    const persisted = await db
      .select({ assigneeAgentId: issues.assigneeAgentId, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issue.id))
      .then((rows) => rows[0] ?? null);
    expect(persisted).toMatchObject({
      assigneeAgentId,
      status: "todo",
    });
  });

  it("resolves only structured same-company agent mentions", async () => {
    const companyId = await seedAssignableAgentCompany();
    const otherCompanyId = await seedAssignableAgentCompany();
    const localAgentId = randomUUID();
    const foreignAgentId = randomUUID();

    await db.insert(agents).values([
      agentRow(companyId, { id: localAgentId, name: "LocalAgent" }),
      agentRow(otherCompanyId, { id: foreignAgentId, name: "ForeignAgent" }),
    ]);

    const mentions = await svc.findMentionedAgents(
      companyId,
      [
        `hello [@LocalAgent](${buildAgentMentionHref(localAgentId)})`,
        `and [@ForeignAgent](${buildAgentMentionHref(foreignAgentId)})`,
      ].join(" "),
    );

    expect(mentions).toEqual([localAgentId]);
  });

  it("does not wake agents from raw @name text without a structured mention", async () => {
    const companyId = await seedAssignableAgentCompany();
    const localAgentId = randomUUID();

    await db.insert(agents).values([
      agentRow(companyId, { id: localAgentId, name: "LocalAgent" }),
    ]);

    await expect(svc.findMentionedAgents(companyId, "@LocalAgent please inspect this"))
      .resolves.toEqual([]);
  });

  it("returns issues an agent participated in across the supported signals", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "OtherAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const assignedIssueId = randomUUID();
    const createdIssueId = randomUUID();
    const commentedIssueId = randomUUID();
    const activityIssueId = randomUUID();
    const excludedIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        createdByAgentId: otherAgentId,
      },
      {
        id: createdIssueId,
        companyId,
        title: "Created issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
      {
        id: commentedIssueId,
        companyId,
        title: "Commented issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
      },
      {
        id: activityIssueId,
        companyId,
        title: "Activity issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
      },
      {
        id: excludedIssueId,
        companyId,
        title: "Excluded issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
        assigneeAgentId: otherAgentId,
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentedIssueId,
      authorAgentId: agentId,
      body: "Investigating this issue.",
    });

    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: activityIssueId,
      agentId,
      details: { changed: true },
    });

    const result = await svc.list(companyId, { participantAgentId: agentId });
    const resultIds = new Set(result.map((issue) => issue.id));

    expect(resultIds).toEqual(new Set([
      assignedIssueId,
      createdIssueId,
      commentedIssueId,
      activityIssueId,
    ]));
    expect(resultIds.has(excludedIssueId)).toBe(false);
  });

  it("combines participation filtering with search", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const matchedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: matchedIssueId,
        companyId,
        title: "Invoice reconciliation",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Weekly planning",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
    ]);

    const result = await svc.list(companyId, {
      participantAgentId: agentId,
      q: "invoice",
    });

    expect(result.map((issue) => issue.id)).toEqual([matchedIssueId]);
  });

  it("treats assigneeAgentId='null' as an explicit unassigned filter", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const assignedIssueId = randomUUID();
    const unassignedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: unassignedIssueId,
        companyId,
        title: "Unassigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: null,
      },
    ]);

    const result = await svc.list(companyId, { assigneeAgentId: "null" });
    expect(result.map((issue) => issue.id)).toEqual([unassignedIssueId]);
  });

  it("keeps UUID assignee filtering behavior unchanged", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const assignedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: assigneeAgentId,
        companyId,
        name: "Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Other issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: otherAgentId,
      },
    ]);

    const result = await svc.list(companyId, { assigneeAgentId });
    expect(result.map((issue) => issue.id)).toEqual([assignedIssueId]);
  });

  it("rejects malformed assigneeAgentId filter values", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Any issue",
      status: "todo",
      priority: "medium",
    });

    await expect(
      svc.list(companyId, { assigneeAgentId: "not-a-uuid" }),
    ).rejects.toThrow(/assigneeAgentId/i);
  });

  it("counts only unassigned issues for assigneeAgentId='null'", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const assignedIssueId = randomUUID();
    const unassignedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: unassignedIssueId,
        companyId,
        title: "Unassigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: null,
      },
    ]);

    await expect(svc.count(companyId, { assigneeAgentId: "null" })).resolves.toBe(1);
  });

  it("counts UUID-assigned issues with assigneeAgentId", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const assignedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Other issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    await expect(svc.count(companyId, { assigneeAgentId })).resolves.toBe(1);
  });

  it("rejects malformed assigneeAgentId filter values in count", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(
      svc.count(companyId, { assigneeAgentId: "not-a-uuid" }),
    ).rejects.toThrow(/assigneeAgentId/i);
  });

  it("applies result limits to issue search", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const exactIdentifierId = randomUUID();
    const titleMatchId = randomUUID();
    const descriptionMatchId = randomUUID();

    await db.insert(issues).values([
      {
        id: exactIdentifierId,
        companyId,
        issueNumber: 42,
        identifier: "PAP-42",
        title: "Completely unrelated",
        status: "todo",
        priority: "medium",
      },
      {
        id: titleMatchId,
        companyId,
        title: "Search ranking issue",
        status: "todo",
        priority: "medium",
      },
      {
        id: descriptionMatchId,
        companyId,
        title: "Another item",
        description: "Contains the search keyword",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, {
      q: "search",
      limit: 2,
    });

    expect(result.map((issue) => issue.id)).toEqual([titleMatchId, descriptionMatchId]);
  });

  it("filters issues by whether they have a plan document", async () => {
    const companyId = randomUUID();
    const withPlanId = randomUUID();
    const withoutPlanId = randomUUID();
    const otherDocumentId = randomUUID();
    const planDocumentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: withPlanId,
        companyId,
        title: "Issue with plan",
        status: "todo",
        priority: "medium",
      },
      {
        id: withoutPlanId,
        companyId,
        title: "Issue without plan",
        status: "todo",
        priority: "medium",
      },
    ]);

    await db.insert(documents).values([
      {
        id: planDocumentId,
        companyId,
        title: null,
        format: "markdown",
        latestBody: "# Plan",
      },
      {
        id: otherDocumentId,
        companyId,
        title: "Notes",
        format: "markdown",
        latestBody: "# Notes",
      },
    ]);

    await db.insert(issueDocuments).values([
      {
        companyId,
        issueId: withPlanId,
        documentId: planDocumentId,
        key: "plan",
      },
      {
        companyId,
        issueId: withoutPlanId,
        documentId: otherDocumentId,
        key: "notes",
      },
    ]);

    const withPlan = await svc.list(companyId, { hasPlanDocument: true });
    const withoutPlan = await svc.list(companyId, { hasPlanDocument: false });

    expect(withPlan.map((issue) => issue.id)).toEqual([withPlanId]);
    expect(withoutPlan.map((issue) => issue.id)).toEqual([withoutPlanId]);
  });

  it("can page issues by most recently updated before priority", async () => {
    const companyId = randomUUID();
    const oldCriticalIssueId = randomUUID();
    const recentMediumIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: oldCriticalIssueId,
        companyId,
        title: "Old critical issue",
        status: "todo",
        priority: "critical",
        updatedAt: new Date("2026-05-01T10:00:00.000Z"),
      },
      {
        id: recentMediumIssueId,
        companyId,
        title: "Recent medium issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-05-17T21:12:29.993Z"),
      },
    ]);

    const result = await svc.list(companyId, {
      limit: 1,
      sortField: "updated",
      sortDir: "desc",
    });

    expect(result.map((issue) => issue.id)).toEqual([recentMediumIssueId]);
  });

  it("ranks comment matches ahead of description-only matches", async () => {
    const companyId = randomUUID();
    const commentMatchId = randomUUID();
    const descriptionMatchId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: commentMatchId,
        companyId,
        title: "Comment match",
        status: "todo",
        priority: "medium",
      },
      {
        id: descriptionMatchId,
        companyId,
        title: "Description match",
        description: "Contains pull/3303 in the description",
        status: "todo",
        priority: "medium",
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentMatchId,
      body: "Reference: https://github.com/paperclipai/paperclip/pull/3303",
    });

    const result = await svc.list(companyId, {
      q: "pull/3303",
      limit: 2,
      includeRoutineExecutions: true,
    });

    expect(result.map((issue) => issue.id)).toEqual([commentMatchId, descriptionMatchId]);
  });

  it("filters issue lists to the full descendant tree for a root issue", async () => {
    const companyId = randomUUID();
    const rootId = randomUUID();
    const childId = randomUUID();
    const grandchildId = randomUUID();
    const siblingId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: rootId,
        companyId,
        title: "Root",
        status: "todo",
        priority: "medium",
      },
      {
        id: childId,
        companyId,
        parentId: rootId,
        title: "Child",
        status: "todo",
        priority: "medium",
      },
      {
        id: grandchildId,
        companyId,
        parentId: childId,
        title: "Grandchild",
        status: "todo",
        priority: "medium",
      },
      {
        id: siblingId,
        companyId,
        title: "Sibling",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, { descendantOf: rootId });

    expect(new Set(result.map((issue) => issue.id))).toEqual(new Set([childId, grandchildId]));
  });

  it("combines descendant filtering with search", async () => {
    const companyId = randomUUID();
    const rootId = randomUUID();
    const childId = randomUUID();
    const grandchildId = randomUUID();
    const outsideMatchId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: rootId,
        companyId,
        title: "Root",
        status: "todo",
        priority: "medium",
      },
      {
        id: childId,
        companyId,
        parentId: rootId,
        title: "Relevant parent",
        status: "todo",
        priority: "medium",
      },
      {
        id: grandchildId,
        companyId,
        parentId: childId,
        title: "Needle grandchild",
        status: "todo",
        priority: "medium",
      },
      {
        id: outsideMatchId,
        companyId,
        title: "Needle outside",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, { descendantOf: rootId, q: "needle" });

    expect(result.map((issue) => issue.id)).toEqual([grandchildId]);
  });

  it("accepts issue identifiers with alphanumeric prefixes through getById", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PC1A2",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1064,
      identifier: "PC1A2-1064",
      title: "Feedback votes error",
      status: "todo",
      priority: "medium",
      createdByUserId: "user-1",
    });

    const issue = await svc.getById("pc1a2-1064");

    expect(issue).toEqual(
      expect.objectContaining({
        id: issueId,
        identifier: "PC1A2-1064",
      }),
    );
  });

  it("returns null instead of throwing for malformed non-uuid issue refs", async () => {
    await expect(svc.getById("not-a-uuid")).resolves.toBeNull();
  });
  it("filters issues by execution workspace id", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const targetWorkspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const linkedIssueId = randomUUID();
    const otherLinkedIssueId = randomUUID();
    const unlinkedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(executionWorkspaces).values([
      {
        id: targetWorkspaceId,
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Target workspace",
        status: "active",
        providerType: "local_fs",
      },
      {
        id: otherWorkspaceId,
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Other workspace",
        status: "active",
        providerType: "local_fs",
      },
    ]);

    await db.insert(issues).values([
      {
        id: linkedIssueId,
        companyId,
        projectId,
        title: "Linked issue",
        status: "todo",
        priority: "medium",
        executionWorkspaceId: targetWorkspaceId,
      },
      {
        id: otherLinkedIssueId,
        companyId,
        projectId,
        title: "Other linked issue",
        status: "todo",
        priority: "medium",
        executionWorkspaceId: otherWorkspaceId,
      },
      {
        id: unlinkedIssueId,
        companyId,
        projectId,
        title: "Unlinked issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, { executionWorkspaceId: targetWorkspaceId });

    expect(result.map((issue) => issue.id)).toEqual([linkedIssueId]);
  });

  it("filters issues by generic workspace id across execution and project workspace links", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const executionLinkedIssueId = randomUUID();
    const projectLinkedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Feature workspace",
      sourceType: "local_path",
      visibility: "default",
      isPrimary: false,
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Execution workspace",
      status: "active",
      providerType: "git_worktree",
    });

    await db.insert(issues).values([
      {
        id: executionLinkedIssueId,
        companyId,
        projectId,
        projectWorkspaceId,
        title: "Execution linked issue",
        status: "done",
        priority: "medium",
        executionWorkspaceId,
      },
      {
        id: projectLinkedIssueId,
        companyId,
        projectId,
        projectWorkspaceId,
        title: "Project linked issue",
        status: "todo",
        priority: "medium",
      },
      {
        id: otherIssueId,
        companyId,
        projectId,
        title: "Other issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    const executionResult = await svc.list(companyId, { workspaceId: executionWorkspaceId });
    const projectResult = await svc.list(companyId, { workspaceId: projectWorkspaceId });

    expect(executionResult.map((issue) => issue.id)).toEqual([executionLinkedIssueId]);
    expect(projectResult.map((issue) => issue.id).sort()).toEqual([executionLinkedIssueId, projectLinkedIssueId].sort());
  });

  it("hides plugin operation issues from default lists and inbox-style filters while preserving explicit retrieval", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const normalIssueId = randomUUID();
    const pluginVisibleIssueId = randomUUID();
    const operationIssueId = randomUUID();
    const typedOperationIssueId = randomUUID();
    const legacyContentMachineOperationIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Plugin Runner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Plugin operations",
      status: "in_progress",
    });
    await db.insert(issues).values([
      {
        id: normalIssueId,
        companyId,
        title: "Normal issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: pluginVisibleIssueId,
        companyId,
        title: "Plugin-visible issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        originKind: "plugin:paperclip.missions:feature",
      },
      {
        id: operationIssueId,
        companyId,
        projectId,
        title: "Plugin operation issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        originKind: "plugin:paperclip.missions:operation",
        originId: "mission-alpha:operation-1",
      },
      {
        id: typedOperationIssueId,
        companyId,
        projectId,
        title: "Typed plugin operation issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        originKind: "plugin:paperclip.missions:operation:evaluation",
        originId: "mission-alpha:operation-2",
      },
      {
        id: legacyContentMachineOperationIssueId,
        companyId,
        projectId,
        title: "Legacy Content Machine operation issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        originKind: "plugin:paperclipai.content-machine:evaluation",
        originId: "content-machine-operation-1",
      },
    ]);

    const defaultIssueIds = (await svc.list(companyId)).map((issue) => issue.id);
    expect(defaultIssueIds).toContain(normalIssueId);
    expect(defaultIssueIds).toContain(pluginVisibleIssueId);
    expect(defaultIssueIds).not.toContain(operationIssueId);
    expect(defaultIssueIds).not.toContain(typedOperationIssueId);
    expect(defaultIssueIds).not.toContain(legacyContentMachineOperationIssueId);

    const inboxIssueIds = (await svc.list(companyId, {
      assigneeAgentId: agentId,
      status: "todo,in_progress,blocked",
      includeRoutineExecutions: true,
    })).map((issue) => issue.id);
    expect(inboxIssueIds).toContain(normalIssueId);
    expect(inboxIssueIds).not.toContain(operationIssueId);
    expect(inboxIssueIds).not.toContain(typedOperationIssueId);
    expect(inboxIssueIds).not.toContain(legacyContentMachineOperationIssueId);

    await expect(svc.list(companyId, { originKind: "plugin:paperclip.missions:operation" }))
      .resolves.toEqual([expect.objectContaining({ id: operationIssueId })]);
    await expect(svc.list(companyId, { originId: "mission-alpha:operation-1" }))
      .resolves.toEqual([expect.objectContaining({ id: operationIssueId })]);
    await expect(svc.list(companyId, { originKindPrefix: "plugin:paperclip.missions:operation" }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: operationIssueId }),
        expect.objectContaining({ id: typedOperationIssueId }),
      ]));

    const projectIssueIds = (await svc.list(companyId, { projectId })).map((issue) => issue.id);
    expect(projectIssueIds).toContain(operationIssueId);
    expect(projectIssueIds).toContain(typedOperationIssueId);
    expect(projectIssueIds).toContain(legacyContentMachineOperationIssueId);

    const advancedIssueIds = (await svc.list(companyId, { includePluginOperations: true })).map((issue) => issue.id);
    expect(advancedIssueIds).toContain(operationIssueId);
    expect(advancedIssueIds).toContain(typedOperationIssueId);
    expect(advancedIssueIds).toContain(legacyContentMachineOperationIssueId);
  });

  it("excludes plugin operation issues from unread inbox counts", async () => {
    const companyId = randomUUID();
    const userId = "board-user";
    const otherUserId = "other-user";
    const normalIssueId = randomUUID();
    const operationIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      {
        id: normalIssueId,
        companyId,
        title: "Normal touched issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
      },
      {
        id: operationIssueId,
        companyId,
        title: "Plugin operation touched issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        originKind: "plugin:paperclip.missions:operation",
      },
    ]);
    await db.insert(issueComments).values([
      {
        companyId,
        issueId: normalIssueId,
        authorUserId: otherUserId,
        body: "Unread normal update.",
      },
      {
        companyId,
        issueId: operationIssueId,
        authorUserId: otherUserId,
        body: "Unread operation update.",
      },
    ]);

    await expect(svc.countUnreadTouchedByUser(companyId, userId, "todo")).resolves.toBe(1);
    await expect(svc.countUnreadTouchedByUser(companyId, userId, ["todo", "in_progress"])).resolves.toBe(1);
  });

  it("accepts array-form status filters in list and count", async () => {
    const companyId = randomUUID();
    const todoIssueId = randomUUID();
    const inProgressIssueId = randomUUID();
    const doneIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      {
        id: todoIssueId,
        companyId,
        title: "Todo issue",
        status: "todo",
        priority: "medium",
      },
      {
        id: inProgressIssueId,
        companyId,
        title: "In-progress issue",
        status: "in_progress",
        priority: "medium",
      },
      {
        id: doneIssueId,
        companyId,
        title: "Done issue",
        status: "done",
        priority: "medium",
      },
    ]);

    const resultIds = (await svc.list(companyId, { status: ["todo", "in_progress"] }))
      .map((issue) => issue.id);

    expect(resultIds).toEqual(expect.arrayContaining([todoIssueId, inProgressIssueId]));
    expect(resultIds).not.toContain(doneIssueId);
    await expect(svc.count(companyId, { status: ["todo", "in_progress"] })).resolves.toBe(2);
  });

  it("hides archived inbox issues until new external activity arrives", async () => {
    const companyId = randomUUID();
    const userId = "user-1";
    const otherUserId = "user-2";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const visibleIssueId = randomUUID();
    const archivedIssueId = randomUUID();
    const resurfacedIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: visibleIssueId,
        companyId,
        title: "Visible issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T10:00:00.000Z"),
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: archivedIssueId,
        companyId,
        title: "Archived issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T11:00:00.000Z"),
        updatedAt: new Date("2026-03-26T11:00:00.000Z"),
      },
      {
        id: resurfacedIssueId,
        companyId,
        title: "Resurfaced issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T12:00:00.000Z"),
      },
    ]);

    await svc.archiveInbox(companyId, archivedIssueId, userId, new Date("2026-03-26T12:30:00.000Z"));
    await svc.archiveInbox(companyId, resurfacedIssueId, userId, new Date("2026-03-26T13:00:00.000Z"));

    await db.insert(issueComments).values({
      companyId,
      issueId: resurfacedIssueId,
      authorUserId: otherUserId,
      body: "This should bring the issue back into Mine.",
      createdAt: new Date("2026-03-26T13:30:00.000Z"),
      updatedAt: new Date("2026-03-26T13:30:00.000Z"),
    });

    const archivedFiltered = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });

    expect(archivedFiltered.map((issue) => issue.id)).toEqual([
      resurfacedIssueId,
      visibleIssueId,
    ]);

    await svc.unarchiveInbox(companyId, archivedIssueId, userId);

    const afterUnarchive = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });

    expect(new Set(afterUnarchive.map((issue) => issue.id))).toEqual(new Set([
      visibleIssueId,
      archivedIssueId,
      resurfacedIssueId,
    ]));
  });

  it("resurfaces archived issue when status/updatedAt changes after archiving", async () => {
    const companyId = randomUUID();
    const userId = "user-1";
    const otherUserId = "user-2";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue with old comment then status change",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
      createdAt: new Date("2026-03-26T10:00:00.000Z"),
      updatedAt: new Date("2026-03-26T10:00:00.000Z"),
    });

    // Old external comment before archiving
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorUserId: otherUserId,
      body: "Old comment before archive",
      createdAt: new Date("2026-03-26T11:00:00.000Z"),
      updatedAt: new Date("2026-03-26T11:00:00.000Z"),
    });

    // Archive after seeing the comment
    await svc.archiveInbox(
      companyId,
      issueId,
      userId,
      new Date("2026-03-26T12:00:00.000Z"),
    );

    // Verify it's archived
    const afterArchive = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });
    expect(afterArchive.map((i) => i.id)).not.toContain(issueId);

    // Status/work update changes updatedAt (no new comment)
    await db
      .update(issues)
      .set({
        status: "in_progress",
        updatedAt: new Date("2026-03-26T13:00:00.000Z"),
      })
      .where(eq(issues.id, issueId));

    // Should resurface because updatedAt > archivedAt
    const afterUpdate = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });
    expect(afterUpdate.map((i) => i.id)).toContain(issueId);
  });

  it("sorts and exposes last activity from comments and non-local issue activity logs", async () => {
    const companyId = randomUUID();
    const olderIssueId = randomUUID();
    const commentIssueId = randomUUID();
    const activityIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: olderIssueId,
        companyId,
        title: "Older issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: commentIssueId,
        companyId,
        title: "Comment activity issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: activityIssueId,
        companyId,
        title: "Logged activity issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentIssueId,
      body: "New comment without touching issue.updatedAt",
      createdAt: new Date("2026-03-26T11:00:00.000Z"),
      updatedAt: new Date("2026-03-26T11:00:00.000Z"),
    });

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.document_updated",
        entityType: "issue",
        entityId: activityIssueId,
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
      },
      {
        companyId,
        actorType: "user",
        actorId: "user-1",
        action: "issue.read_marked",
        entityType: "issue",
        entityId: olderIssueId,
        createdAt: new Date("2026-03-26T13:00:00.000Z"),
      },
    ]);

    const result = await svc.list(companyId, {});

    expect(result.map((issue) => issue.id)).toEqual([
      activityIssueId,
      commentIssueId,
      olderIssueId,
    ]);
    expect(result.find((issue) => issue.id === activityIssueId)?.lastActivityAt?.toISOString()).toBe(
      "2026-03-26T12:00:00.000Z",
    );
    expect(result.find((issue) => issue.id === commentIssueId)?.lastActivityAt?.toISOString()).toBe(
      "2026-03-26T11:00:00.000Z",
    );
    expect(result.find((issue) => issue.id === olderIssueId)?.lastActivityAt?.toISOString()).toBe(
      "2026-03-26T10:00:00.000Z",
    );
  });

  it("paginates earlier comments in descending order from an anchor comment", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const firstCommentId = randomUUID();
    const anchorCommentId = randomUUID();
    const latestCommentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Paged comments issue",
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values([
      {
        id: firstCommentId,
        companyId,
        issueId,
        body: "First comment",
        createdAt: new Date("2026-03-26T10:00:00.000Z"),
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: anchorCommentId,
        companyId,
        issueId,
        body: "Anchor comment",
        createdAt: new Date("2026-03-26T11:00:00.000Z"),
        updatedAt: new Date("2026-03-26T11:00:00.000Z"),
      },
      {
        id: latestCommentId,
        companyId,
        issueId,
        body: "Latest comment",
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T12:00:00.000Z"),
      },
    ]);

    const comments = await svc.listComments(issueId, {
      afterCommentId: anchorCommentId,
      order: "desc",
      limit: 50,
    });

    expect(comments.map((comment) => comment.id)).toEqual([firstCommentId]);
  });

  it("paginates later comments in ascending order from an anchor comment", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const firstCommentId = randomUUID();
    const anchorCommentId = randomUUID();
    const latestCommentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Paged comments issue",
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values([
      {
        id: firstCommentId,
        companyId,
        issueId,
        body: "First comment",
        createdAt: new Date("2026-03-26T10:00:00.000Z"),
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: anchorCommentId,
        companyId,
        issueId,
        body: "Anchor comment",
        createdAt: new Date("2026-03-26T11:00:00.000Z"),
        updatedAt: new Date("2026-03-26T11:00:00.000Z"),
      },
      {
        id: latestCommentId,
        companyId,
        issueId,
        body: "Latest comment",
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T12:00:00.000Z"),
      },
    ]);

    const comments = await svc.listComments(issueId, {
      afterCommentId: anchorCommentId,
      order: "asc",
      limit: 50,
    });

    expect(comments.map((comment) => comment.id)).toEqual([latestCommentId]);
  });

  it("lists user comments when derived run attribution scans a timestamp window", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const commentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Comments issue",
      status: "todo",
      priority: "medium",
    });

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      contextSnapshot: { issueId },
      createdAt: new Date("2026-05-12T22:58:00.000Z"),
      startedAt: new Date("2026-05-12T22:58:00.000Z"),
      finishedAt: new Date("2026-05-12T23:14:00.000Z"),
    });

    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: "user-1",
      body: "Comment should be visible",
      createdAt: new Date("2026-05-12T23:00:00.000Z"),
      updatedAt: new Date("2026-05-12T23:00:00.000Z"),
    });

    const comments = await svc.listComments(issueId, {
      order: "desc",
      limit: 50,
    });

    expect(comments.map((comment) => comment.id)).toEqual([commentId]);
    expect(comments[0]?.body).toBe("Comment should be visible");
  });

  it("lists user comments when a candidate attribution run log is missing", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const commentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Comments issue with missing run log",
      status: "todo",
      priority: "medium",
    });

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      contextSnapshot: { issueId },
      createdAt: new Date("2026-05-12T22:58:00.000Z"),
      startedAt: new Date("2026-05-12T22:58:00.000Z"),
      finishedAt: new Date("2026-05-12T23:14:00.000Z"),
      logStore: "local_file",
      logRef: "missing/run-log.ndjson",
      logBytes: 128,
    });

    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: "user-1",
      body: "Comment should still be visible",
      createdAt: new Date("2026-05-12T23:00:00.000Z"),
      updatedAt: new Date("2026-05-12T23:00:00.000Z"),
    });

    const comments = await svc.listComments(issueId, {
      order: "desc",
      limit: 50,
    });

    expect(comments.map((comment) => comment.id)).toEqual([commentId]);
    expect(comments[0]?.body).toBe("Comment should still be visible");
    expect(comments[0]?.metadata).toBeNull();
  });

  it("includes blockedBy summaries on list rows in one batched pass", async () => {
    const companyId = randomUUID();
    const blockerId = randomUUID();
    const blockedId = randomUUID();
    const unblockedId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Blocker issue",
        status: "todo",
        priority: "high",
      },
      {
        id: blockedId,
        companyId,
        title: "Blocked issue",
        status: "blocked",
        priority: "medium",
      },
      {
        id: unblockedId,
        companyId,
        title: "Unblocked issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
    });

    const defaultResult = await svc.list(companyId);
    expect(defaultResult.find((issue) => issue.id === blockedId)?.blockedBy).toBeUndefined();

    const result = await svc.list(companyId, { includeBlockedBy: true });
    const byId = new Map(result.map((issue) => [issue.id, issue]));

    expect(byId.get(blockedId)?.blockedBy).toEqual([
      expect.objectContaining({
        id: blockerId,
        identifier: null,
        title: "Blocker issue",
        status: "todo",
        priority: "high",
      }),
    ]);
    expect(byId.get(blockerId)?.blockedBy).toEqual([]);
    expect(byId.get(unblockedId)?.blockedBy).toEqual([]);
  });

  it("trims list payload fields that can grow large on issue index routes", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const longDescription = "x".repeat(5_000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Large issue",
      description: longDescription,
      status: "todo",
      priority: "medium",
      executionPolicy: { stages: Array.from({ length: 20 }, (_, index) => ({ index, kind: "review", notes: "y".repeat(400) })) },
      executionState: { history: Array.from({ length: 20 }, (_, index) => ({ index, body: "z".repeat(400) })) },
      executionWorkspaceSettings: { notes: "w".repeat(2_000) },
    });

    const [result] = await svc.list(companyId);

    expect(result).toBeTruthy();
    expect(result?.description).toHaveLength(1200);
    expect(result?.executionPolicy).toBeNull();
    expect(result?.executionState).toBeNull();
    expect(result?.executionWorkspaceSettings).toBeNull();
  });

  it("does not let description preview truncation split multibyte characters", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const description = `${"x".repeat(1199)}— still valid after truncation`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Multibyte boundary issue",
      description,
      status: "todo",
      priority: "medium",
    });

    const [result] = await svc.list(companyId);

    expect(result?.description).toHaveLength(1200);
    expect(result?.description?.endsWith("—")).toBe(true);
  });

  it("strips ASCII control characters from description previews so list JSON parses with strict parsers", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    // Embed terminal-capture-style bytes: BEL, BS, ESC, FS, US, DEL.
    // Preserve TAB / LF / CR which are normal whitespace.
    const description = "before\x07\x08\x1b[31mred\x1b[0m\x1c\x1f\x7fkeep\there\nand\rcr-after";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Control char issue",
      description,
      status: "todo",
      priority: "medium",
    });

    const [result] = await svc.list(companyId);

    expect(result?.description).toBe("before[31mred[0mkeep\there\nand\rcr-after");
    // No raw ASCII control bytes 0x00-0x1F (except TAB/LF/CR) or 0x7F.
    expect(result?.description).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/);

    // Round-trip through strict JSON parsers — re-parse must succeed and
    // the serialized form must contain no raw control bytes (RFC 8259 §7).
    const serialized = JSON.stringify(result);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(serialized).not.toMatch(/[\x00-\x1F]/);
  });

  it("strips control bytes before truncation so the preview fills the visible budget", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    // 400 stripped control bytes followed by 1300 visible chars. With strip-then-truncate
    // the preview is the first 1200 visible chars; with truncate-then-strip it would be
    // ~800 visible chars (control bytes wasted budget).
    const description = "\x07".repeat(400) + "v".repeat(1300);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Budget-fill issue",
      description,
      status: "todo",
      priority: "medium",
    });

    const [result] = await svc.list(companyId);

    expect(result?.description).toHaveLength(1200);
    expect(result?.description).toBe("v".repeat(1200));
  });
});

describeEmbeddedPostgres("issueService.create workspace inheritance", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-create-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("inherits the parent issue workspace linkage when child workspace fields are omitted", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "workspace-key",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
      providerRef: `/tmp/${executionWorkspaceId}`,
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        workspaceRuntime: { profile: "agent" },
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
    });

    expect(child.parentId).toBe(parentIssueId);
    expect(child.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "isolated_workspace",
      workspaceRuntime: { profile: "agent" },
    });
  });

  it("captures the assignee default environment when neither issue nor project specifies one", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const assigneeEnvironmentId = randomUUID();
    const assigneeAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(environments).values([
      {
        id: assigneeEnvironmentId,
        companyId,
        name: "QA E2B",
        driver: "sandbox",
        status: "active",
        config: { provider: "e2b" },
      },
    ]);

    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "QA E2B Codex",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      defaultEnvironmentId: assigneeEnvironmentId,
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "shared_workspace",
        allowIssueOverride: true,
        defaultProjectWorkspaceId: projectWorkspaceId,
      },
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });

    const issue = await svc.create(companyId, {
      projectId,
      assigneeAgentId,
      title: "Environment matrix: e2b / codex_local",
      status: "todo",
      priority: "medium",
    });

    expect(issue.executionWorkspaceSettings).toEqual({
      mode: "shared_workspace",
      environmentId: assigneeEnvironmentId,
    });
  });

  it("does not promote the assignee default environment when the project policy already specifies one", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const projectEnvironmentId = randomUUID();
    const assigneeEnvironmentId = randomUUID();
    const assigneeAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(environments).values([
      {
        id: projectEnvironmentId,
        companyId,
        name: "QA SSH",
        driver: "ssh",
        status: "active",
        config: {},
      },
      {
        id: assigneeEnvironmentId,
        companyId,
        name: "QA E2B",
        driver: "sandbox",
        status: "active",
        config: { provider: "e2b" },
      },
    ]);

    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "QA E2B Codex",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      defaultEnvironmentId: assigneeEnvironmentId,
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "shared_workspace",
        allowIssueOverride: true,
        defaultProjectWorkspaceId: projectWorkspaceId,
        environmentId: projectEnvironmentId,
      },
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });

    const issue = await svc.create(companyId, {
      projectId,
      assigneeAgentId,
      title: "Environment matrix: e2b / codex_local",
      status: "todo",
      priority: "medium",
    });

    // Project policy's environmentId must win over the assignee's default;
    // executionWorkspaceSettings should not bake in an environmentId in this case
    // so resolveExecutionWorkspaceEnvironmentId can fall through to the project
    // policy's value at run time.
    expect(issue.executionWorkspaceSettings).toEqual({ mode: "shared_workspace" });
  });

  it("captures the new assignee's default environment on reassignment", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const firstEnvironmentId = randomUUID();
    const secondEnvironmentId = randomUUID();
    const firstAgentId = randomUUID();
    const secondAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(environments).values([
      {
        id: firstEnvironmentId,
        companyId,
        name: "QA SSH",
        driver: "ssh",
        status: "active",
        config: {},
      },
      {
        id: secondEnvironmentId,
        companyId,
        name: "QA E2B",
        driver: "sandbox",
        status: "active",
        config: { provider: "e2b" },
      },
    ]);

    await db.insert(agents).values([
      {
        id: firstAgentId,
        companyId,
        name: "QA SSH Codex",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        defaultEnvironmentId: firstEnvironmentId,
        permissions: {},
      },
      {
        id: secondAgentId,
        companyId,
        name: "QA E2B Codex",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        defaultEnvironmentId: secondEnvironmentId,
        permissions: {},
      },
    ]);

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "shared_workspace",
        allowIssueOverride: true,
        defaultProjectWorkspaceId: projectWorkspaceId,
      },
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });

    const created = await svc.create(companyId, {
      projectId,
      assigneeAgentId: firstAgentId,
      title: "Environment matrix: ssh / codex_local",
      status: "todo",
      priority: "medium",
    });

    expect(created.executionWorkspaceSettings).toMatchObject({
      environmentId: firstEnvironmentId,
    });

    const reassigned = await svc.update(created.id, {
      assigneeAgentId: secondAgentId,
    });

    expect(reassigned).not.toBeNull();
    expect(reassigned!.executionWorkspaceSettings).toMatchObject({
      environmentId: secondEnvironmentId,
    });
  });

  it("preserves an operator-set environmentId across reassignment", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const firstEnvironmentId = randomUUID();
    const secondEnvironmentId = randomUUID();
    const operatorEnvironmentId = randomUUID();
    const firstAgentId = randomUUID();
    const secondAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(environments).values([
      { id: firstEnvironmentId, companyId, name: "Env 1", driver: "ssh", status: "active", config: {} },
      { id: secondEnvironmentId, companyId, name: "Env 2", driver: "sandbox", status: "active", config: { provider: "e2b" } },
      { id: operatorEnvironmentId, companyId, name: "Operator pick", driver: "ssh", status: "active", config: {} },
    ]);

    await db.insert(agents).values([
      {
        id: firstAgentId, companyId, name: "First agent", role: "engineer", status: "active",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {},
        defaultEnvironmentId: firstEnvironmentId, permissions: {},
      },
      {
        id: secondAgentId, companyId, name: "Second agent", role: "engineer", status: "active",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {},
        defaultEnvironmentId: secondEnvironmentId, permissions: {},
      },
    ]);

    await db.insert(projects).values({
      id: projectId, companyId, name: "Workspace project", status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "shared_workspace",
        allowIssueOverride: true,
        defaultProjectWorkspaceId: projectWorkspaceId,
      },
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId, companyId, projectId, name: "Primary workspace", isPrimary: true,
    });

    const created = await svc.create(companyId, {
      projectId,
      assigneeAgentId: firstAgentId,
      title: "Operator overrides env then reassigns",
      status: "todo",
      priority: "medium",
    });

    // Operator explicitly overrides the environmentId in a separate update.
    const overridden = await svc.update(created.id, {
      executionWorkspaceSettings: {
        mode: "shared_workspace",
        environmentId: operatorEnvironmentId,
      },
    });
    expect(overridden!.executionWorkspaceSettings).toMatchObject({
      environmentId: operatorEnvironmentId,
    });

    // A subsequent reassignment-only update must NOT overwrite the operator's
    // explicit choice with the new assignee's default.
    const reassigned = await svc.update(created.id, {
      assigneeAgentId: secondAgentId,
    });
    expect(reassigned!.executionWorkspaceSettings).toMatchObject({
      environmentId: operatorEnvironmentId,
    });
  });

  it("keeps explicit workspace fields instead of inheriting the parent linkage", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const parentProjectWorkspaceId = randomUUID();
    const parentExecutionWorkspaceId = randomUUID();
    const explicitProjectWorkspaceId = randomUUID();
    const explicitExecutionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values([
      {
        id: parentProjectWorkspaceId,
        companyId,
        projectId,
        name: "Parent workspace",
      },
      {
        id: explicitProjectWorkspaceId,
        companyId,
        projectId,
        name: "Explicit workspace",
      },
    ]);

    await db.insert(executionWorkspaces).values([
      {
        id: parentExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: parentProjectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Parent worktree",
        status: "active",
        providerType: "git_worktree",
      },
      {
        id: explicitExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: explicitProjectWorkspaceId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Explicit shared workspace",
        status: "active",
        providerType: "local_fs",
      },
    ]);

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId: parentProjectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId: parentExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
      projectWorkspaceId: explicitProjectWorkspaceId,
      executionWorkspaceId: explicitExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "shared_workspace",
      },
    });

    expect(child.projectWorkspaceId).toBe(explicitProjectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(explicitExecutionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "shared_workspace",
    });
  });

  it("inherits workspace linkage from an explicit source issue without creating a parent-child relationship", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const sourceIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "operator_branch",
      strategyType: "git_worktree",
      name: "Operator branch",
      status: "active",
      providerType: "git_worktree",
    });

    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Source issue",
      status: "todo",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "operator_branch",
      },
    });

    const followUp = await svc.create(companyId, {
      projectId,
      title: "Follow-up issue",
      inheritExecutionWorkspaceFromIssueId: sourceIssueId,
    });

    expect(followUp.parentId).toBeNull();
    expect(followUp.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(followUp.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(followUp.executionWorkspacePreference).toBe("reuse_existing");
    expect(followUp.executionWorkspaceSettings).toEqual({
      mode: "operator_branch",
    });
  });

  it("createChild applies parent defaults, acceptance criteria, workspace inheritance, and optional parent blocker chaining", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const goalId = randomUUID();
    const parentIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Ship child helpers",
      level: "task",
      status: "active",
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      goalId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
      providerRef: `/tmp/${executionWorkspaceId}`,
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      requestDepth: 1,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
    });

    const { issue: child, parentBlockerAdded } = await svc.createChild(parentIssueId, {
      title: "Child helper",
      status: "todo",
      description: "Implement the helper.",
      acceptanceCriteria: ["Uses the parent issue as parentId", "Reuses the parent execution workspace"],
      blockParentUntilDone: true,
    });

    expect(parentBlockerAdded).toBe(true);
    expect(child.parentId).toBe(parentIssueId);
    expect(child.projectId).toBe(projectId);
    expect(child.goalId).toBe(goalId);
    expect(child.requestDepth).toBe(2);
    expect(child.description).toContain("## Acceptance Criteria");
    expect(child.description).toContain("- Uses the parent issue as parentId");
    expect(child.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");

    const parentRelations = await svc.getRelationSummaries(parentIssueId);
    expect(parentRelations.blockedBy).toEqual([
      expect.objectContaining({
        id: child.id,
        title: "Child helper",
      }),
    ]);
  });

  it("clamps helper-created child requestDepth to the safe maximum", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const goalId = randomUUID();
    const parentIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Ship child helpers",
      level: "task",
      status: "active",
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      goalId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      requestDepth: MAX_ISSUE_REQUEST_DEPTH,
    });

    const { issue: child } = await svc.createChild(parentIssueId, {
      title: "Child helper",
      status: "todo",
      requestDepth: MAX_ISSUE_REQUEST_DEPTH + 100,
    });

    expect(child.requestDepth).toBe(MAX_ISSUE_REQUEST_DEPTH);
  });
});

describeEmbeddedPostgres("issueService blockers and dependency wake readiness", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-blockers-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("persists blocked-by relations and exposes both blockedBy and blocks summaries", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Blocker",
        status: "todo",
        priority: "high",
      },
      {
        id: blockedId,
        companyId,
        title: "Blocked issue",
        status: "blocked",
        priority: "medium",
      },
    ]);

    await svc.update(blockedId, {
      blockedByIssueIds: [blockerId],
    });

    const blockerRelations = await svc.getRelationSummaries(blockerId);
    const blockedRelations = await svc.getRelationSummaries(blockedId);

    expect(blockerRelations.blocks.map((relation) => relation.id)).toEqual([blockedId]);
    expect(blockedRelations.blockedBy.map((relation) => relation.id)).toEqual([blockerId]);
  });

  it("adds terminal blockers to immediate blocked-by summaries", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issueA = randomUUID();
    const issueB = randomUUID();
    const issueC = randomUUID();
    const issueD = randomUUID();
    await db.insert(issues).values([
      { id: issueA, companyId, identifier: "PAP-1", title: "Issue A", status: "blocked", priority: "medium" },
      { id: issueB, companyId, identifier: "PAP-2", title: "Issue B", status: "blocked", priority: "medium" },
      { id: issueC, companyId, identifier: "PAP-3", title: "Issue C", status: "blocked", priority: "medium" },
      { id: issueD, companyId, identifier: "PAP-4", title: "Issue D", status: "todo", priority: "high" },
    ]);

    await svc.update(issueC, { blockedByIssueIds: [issueD] });
    await svc.update(issueB, { blockedByIssueIds: [issueC] });
    await svc.update(issueA, { blockedByIssueIds: [issueB] });

    const relations = await svc.getRelationSummaries(issueA);

    expect(relations.blockedBy).toHaveLength(1);
    expect(relations.blockedBy[0]).toMatchObject({
      id: issueB,
      identifier: "PAP-2",
      title: "Issue B",
      terminalBlockers: [
        expect.objectContaining({
          id: issueD,
          identifier: "PAP-4",
          title: "Issue D",
          status: "todo",
          priority: "high",
        }),
      ],
    });
  });

  it("rejects blocking cycles", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issueA = randomUUID();
    const issueB = randomUUID();
    await db.insert(issues).values([
      { id: issueA, companyId, title: "Issue A", status: "todo", priority: "medium" },
      { id: issueB, companyId, title: "Issue B", status: "todo", priority: "medium" },
    ]);

    await svc.update(issueA, { blockedByIssueIds: [issueB] });

    await expect(
      svc.update(issueB, { blockedByIssueIds: [issueA] }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("only returns dependents once every blocker is done", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const blockerA = randomUUID();
    const blockerB = randomUUID();
    const blockedIssueId = randomUUID();
    await db.insert(issues).values([
      { id: blockerA, companyId, title: "Blocker A", status: "done", priority: "medium" },
      { id: blockerB, companyId, title: "Blocker B", status: "todo", priority: "medium" },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked issue",
        status: "blocked",
        priority: "medium",
        assigneeAgentId,
      },
    ]);

    await svc.update(blockedIssueId, { blockedByIssueIds: [blockerA, blockerB] });

    expect(await svc.listWakeableBlockedDependents(blockerA)).toEqual([]);

    await svc.update(blockerB, { status: "done" });

    await expect(svc.listWakeableBlockedDependents(blockerA)).resolves.toEqual([
      expect.objectContaining({
        id: blockedIssueId,
        assigneeAgentId,
        blockerIssueIds: expect.arrayContaining([blockerA, blockerB]),
      }),
    ]);
  });

  it("gates dependents on the workspace-finalize barrier when a done blocker's execution workspace has not synced back", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "QA",
      role: "qa",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Shared workspace project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Shared workspace",
      sourceType: "local_path",
      visibility: "default",
      isPrimary: true,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Shared exec workspace",
      status: "active",
      providerType: "git_worktree",
    });

    const blockerId = randomUUID();
    const dependentId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        projectId,
        title: "Predecessor",
        status: "done",
        priority: "medium",
        executionWorkspaceId,
      },
      {
        id: dependentId,
        companyId,
        projectId,
        title: "Dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId,
      },
    ]);
    await svc.update(dependentId, { blockedByIssueIds: [blockerId] });

    // A run touched the workspace (prepare phase) but has not yet recorded
    // workspace_finalize — the dependent must NOT wake.
    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      phase: "worktree_prepare",
      status: "succeeded",
      startedAt: new Date("2026-05-23T22:00:00.000Z"),
    });

    expect(await svc.listWakeableBlockedDependents(blockerId)).toEqual([]);
    await expect(svc.getDependencyReadiness(dependentId)).resolves.toMatchObject({
      isDependencyReady: false,
      pendingFinalizeBlockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [blockerId],
    });

    // A failed finalize must keep the gate closed.
    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      phase: "workspace_finalize",
      status: "failed",
      startedAt: new Date("2026-05-23T22:05:00.000Z"),
    });
    expect(await svc.listWakeableBlockedDependents(blockerId)).toEqual([]);

    // Once a workspace_finalize succeeded row lands AFTER the failed one,
    // the gate opens and the dependent is wakeable.
    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      phase: "workspace_finalize",
      status: "succeeded",
      startedAt: new Date("2026-05-23T22:10:00.000Z"),
    });

    await expect(svc.listWakeableBlockedDependents(blockerId)).resolves.toEqual([
      expect.objectContaining({
        id: dependentId,
        assigneeAgentId,
        blockerIssueIds: [blockerId],
      }),
    ]);
    await expect(svc.getDependencyReadiness(dependentId)).resolves.toMatchObject({
      isDependencyReady: true,
      pendingFinalizeBlockerIssueIds: [],
    });
  });

  it("treats blockers with no executionWorkspaceId as not subject to the workspace-finalize barrier", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "QA",
      role: "qa",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const blockerId = randomUUID();
    const dependentId = randomUUID();
    await db.insert(issues).values([
      // Done blocker with no execution workspace ever attached (e.g. closed manually).
      { id: blockerId, companyId, title: "Manual done blocker", status: "done", priority: "medium" },
      {
        id: dependentId,
        companyId,
        title: "Dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId,
      },
    ]);
    await svc.update(dependentId, { blockedByIssueIds: [blockerId] });

    // No executionWorkspaceId → no barrier → dependent should be wakeable.
    await expect(svc.listWakeableBlockedDependents(blockerId)).resolves.toEqual([
      expect.objectContaining({
        id: dependentId,
        assigneeAgentId,
        blockerIssueIds: [blockerId],
      }),
    ]);
  });

  it("reports dependency readiness for blocked issue chains", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status: "todo", priority: "medium" },
      { id: blockedId, companyId, title: "Blocked", status: "todo", priority: "medium" },
    ]);
    await svc.update(blockedId, { blockedByIssueIds: [blockerId] });

    await expect(svc.getDependencyReadiness(blockedId)).resolves.toMatchObject({
      issueId: blockedId,
      blockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [blockerId],
      unresolvedBlockerCount: 1,
      allBlockersDone: false,
      isDependencyReady: false,
    });

    await svc.update(blockerId, { status: "done" });

    await expect(svc.getDependencyReadiness(blockedId)).resolves.toMatchObject({
      issueId: blockedId,
      blockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      allBlockersDone: true,
      isDependencyReady: true,
    });
  });

  it("unblocks a source issue when a liveness escalation recovery issue is marked done", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const sourceIssueId = randomUUID();
    const recoveryIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId,
        title: "Source issue",
        status: "blocked",
        priority: "medium",
      },
      {
        id: recoveryIssueId,
        companyId,
        title: "Liveness escalation issue",
        status: "in_progress",
        priority: "high",
        originKind: "harness_liveness_escalation",
        originId: `harness_liveness:${companyId}:${sourceIssueId}:invalid_review_participant:none`,
      },
    ]);

    await svc.update(sourceIssueId, {
      blockedByIssueIds: [recoveryIssueId],
    });
    await expect(svc.getRelationSummaries(sourceIssueId)).resolves.toMatchObject({
      blockedBy: [expect.objectContaining({ id: recoveryIssueId })],
    });

    await svc.update(recoveryIssueId, {
      status: "done",
    });

    await expect(svc.getRelationSummaries(sourceIssueId)).resolves.toMatchObject({
      blockedBy: [],
    });
  });

  it("rejects execution when unresolved blockers remain", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status: "todo", priority: "medium" },
      {
        id: blockedId,
        companyId,
        title: "Blocked",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
    ]);
    await svc.update(blockedId, { blockedByIssueIds: [blockerId] });

    await expect(
      svc.update(blockedId, { status: "in_progress" }),
    ).rejects.toMatchObject({ status: 422 });

    await expect(
      svc.checkout(blockedId, assigneeAgentId, ["todo", "blocked"], null),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("wakes parents only when all direct children are terminal", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const parentId = randomUUID();
    const childA = randomUUID();
    const childB = randomUUID();
    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        title: "Parent issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: childA,
        companyId,
        parentId,
        title: "Child A",
        status: "done",
        priority: "medium",
      },
      {
        id: childB,
        companyId,
        parentId,
        title: "Child B",
        status: "blocked",
        priority: "medium",
      },
    ]);

    expect(await svc.getWakeableParentAfterChildCompletion(parentId)).toBeNull();

    await svc.update(childB, { status: "cancelled" });

    expect(await svc.getWakeableParentAfterChildCompletion(parentId)).toMatchObject({
      id: parentId,
      assigneeAgentId,
      childIssueIds: [childA, childB],
      childIssueSummaries: [
        expect.objectContaining({ id: childA, title: "Child A", status: "done" }),
        expect.objectContaining({ id: childB, title: "Child B", status: "cancelled" }),
      ],
      childIssueSummaryTruncated: false,
    });
  });
});

describeEmbeddedPostgres("issueService.create workspace inheritance", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-create-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("inherits the parent issue workspace linkage when child workspace fields are omitted", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "workspace-key",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
      providerRef: `/tmp/${executionWorkspaceId}`,
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        workspaceRuntime: { profile: "agent" },
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
    });

    expect(child.parentId).toBe(parentIssueId);
    expect(child.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "isolated_workspace",
      workspaceRuntime: { profile: "agent" },
    });
  });

  it("preserves the parent project when a generic child create inherits workspace linkage", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      title: "Generic child issue",
    });

    expect(child.parentId).toBe(parentIssueId);
    expect(child.projectId).toBe(projectId);
    expect(child.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(executionWorkspaceId);
  });

  it("keeps explicit workspace fields instead of inheriting the parent linkage", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const parentProjectWorkspaceId = randomUUID();
    const parentExecutionWorkspaceId = randomUUID();
    const explicitProjectWorkspaceId = randomUUID();
    const explicitExecutionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values([
      {
        id: parentProjectWorkspaceId,
        companyId,
        projectId,
        name: "Parent workspace",
      },
      {
        id: explicitProjectWorkspaceId,
        companyId,
        projectId,
        name: "Explicit workspace",
      },
    ]);

    await db.insert(executionWorkspaces).values([
      {
        id: parentExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: parentProjectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Parent worktree",
        status: "active",
        providerType: "git_worktree",
      },
      {
        id: explicitExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: explicitProjectWorkspaceId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Explicit shared workspace",
        status: "active",
        providerType: "local_fs",
      },
    ]);

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId: parentProjectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId: parentExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
      projectWorkspaceId: explicitProjectWorkspaceId,
      executionWorkspaceId: explicitExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "shared_workspace",
      },
    });

    expect(child.projectWorkspaceId).toBe(explicitProjectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(explicitExecutionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "shared_workspace",
    });
  });

  it("inherits workspace linkage from an explicit source issue without creating a parent-child relationship", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const sourceIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "operator_branch",
      strategyType: "git_worktree",
      name: "Operator branch",
      status: "active",
      providerType: "git_worktree",
    });

    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Source issue",
      status: "todo",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "operator_branch",
      },
    });

    const followUp = await svc.create(companyId, {
      title: "Follow-up issue",
      inheritExecutionWorkspaceFromIssueId: sourceIssueId,
    });

    expect(followUp.parentId).toBeNull();
    expect(followUp.projectId).toBe(projectId);
    expect(followUp.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(followUp.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(followUp.executionWorkspacePreference).toBe("reuse_existing");
    expect(followUp.executionWorkspaceSettings).toEqual({
      mode: "operator_branch",
    });
  });

  it("derives project identity when an update adds workspace linkage to a projectless issue", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Projectless issue",
      status: "todo",
      priority: "medium",
    });

    const updated = await svc.update(issueId, {
      projectWorkspaceId,
    });

    expect(updated?.projectId).toBe(projectId);
    expect(updated?.projectWorkspaceId).toBe(projectWorkspaceId);
  });

  it("syncs reused execution workspace config when issue workspace settings are updated", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
      metadata: {
        config: {
          environmentId: "env-old",
          provisionCommand: "bash ./scripts/provision-old.sh",
          teardownCommand: "bash ./scripts/teardown-old.sh",
          workspaceRuntime: { profile: "old" },
        },
      },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Recovery issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        environmentId: "env-old",
        workspaceStrategy: {
          type: "git_worktree",
          provisionCommand: "bash ./scripts/provision-old.sh",
          teardownCommand: "bash ./scripts/teardown-old.sh",
        },
        workspaceRuntime: { profile: "old" },
      },
    });

    await svc.update(issueId, {
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        environmentId: "env-new",
        workspaceStrategy: {
          type: "cloud_sandbox",
          provisionCommand: "bash ./scripts/provision-new.sh",
          teardownCommand: "bash ./scripts/teardown-new.sh",
        },
        workspaceRuntime: { profile: "new" },
      },
    });

    const workspace = await db
      .select({ metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId))
      .then((rows) => rows[0] ?? null);

    expect(workspace?.metadata).toEqual({
      config: {
        environmentId: "env-new",
        provisionCommand: "bash ./scripts/provision-new.sh",
        teardownCommand: "bash ./scripts/teardown-new.sh",
        cleanupCommand: null,
        workspaceRuntime: { profile: "new" },
        desiredState: null,
        serviceStates: null,
      },
    });
  });
});

describeEmbeddedPostgres("issueService.findMentionedProjectIds", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-mentioned-projects-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("can skip comment-body scans for bounded issue detail reads", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const titleProjectId = randomUUID();
    const commentProjectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values([
      {
        id: titleProjectId,
        companyId,
        name: "Title project",
        status: "in_progress",
      },
      {
        id: commentProjectId,
        companyId,
        name: "Comment project",
        status: "in_progress",
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Link [Title](${buildProjectMentionHref(titleProjectId)})`,
      description: null,
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: `Comment link [Comment](${buildProjectMentionHref(commentProjectId)})`,
    });

    expect(await svc.findMentionedProjectIds(issueId, { includeCommentBodies: false })).toEqual([titleProjectId]);
    expect(await svc.findMentionedProjectIds(issueId)).toEqual([
      titleProjectId,
      commentProjectId,
    ]);
  });
});

describeEmbeddedPostgres("issueService.clearExecutionRunIfTerminal", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-execution-lock-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssueWithRun(status: string | null) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = status ? randomUUID() : null;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    if (runId) {
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status,
        invocationSource: "manual",
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Execution lock",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionAgentNameKey: runId ? "codexcoder" : null,
      executionLockedAt: runId ? new Date() : null,
    });

    return { issueId, runId };
  }

  it("clears execution locks owned by terminal runs", async () => {
    const { issueId } = await seedIssueWithRun("failed");

    await expect(svc.clearExecutionRunIfTerminal(issueId)).resolves.toBe(true);

    const row = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
  });

  it("does not clear execution locks owned by live runs", async () => {
    const { issueId, runId } = await seedIssueWithRun("running");

    await expect(svc.clearExecutionRunIfTerminal(issueId)).resolves.toBe(false);

    const row = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.executionRunId).toBe(runId);
    expect(row?.executionAgentNameKey).toBe("codexcoder");
    expect(row?.executionLockedAt).toBeInstanceOf(Date);
  });

  it("does not update issues without an execution lock", async () => {
    const { issueId } = await seedIssueWithRun(null);

    await expect(svc.clearExecutionRunIfTerminal(issueId)).resolves.toBe(false);

    const row = await db
      .select({ executionRunId: issues.executionRunId, executionLockedAt: issues.executionLockedAt })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ executionRunId: null, executionLockedAt: null });
  });

  it("does not clear checkout locks when a different execution run is live", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const failedRunId = randomUUID();
    const runningRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        invocationSource: "manual",
        finishedAt: new Date("2026-06-10T10:05:00.000Z"),
      },
      {
        id: runningRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date("2026-06-10T10:06:00.000Z"),
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Mixed execution lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: runningRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date("2026-06-10T10:06:00.000Z"),
    });

    await expect(svc.clearCheckoutRunIfTerminal(issueId)).resolves.toBe(false);

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.checkoutRunId).toBe(failedRunId);
    expect(row?.executionRunId).toBe(runningRunId);
    expect(row?.executionAgentNameKey).toBe("codexcoder");
    expect(row?.executionLockedAt).toBeInstanceOf(Date);
  });

  it("does not let stale release clobber a successor checkout lock", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const failedRunId = randomUUID();
    const releasingRunId = randomUUID();
    const successorRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        invocationSource: "manual",
        finishedAt: new Date("2026-06-10T10:05:00.000Z"),
      },
      {
        id: releasingRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date("2026-06-10T10:06:00.000Z"),
      },
      {
        id: successorRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date("2026-06-10T10:07:00.000Z"),
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Race stale release",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date("2026-06-10T10:00:00.000Z"),
    });

    const [releaseResult, checkoutResult] = await Promise.allSettled([
      svc.release(issueId, agentId, releasingRunId),
      svc.checkout(issueId, agentId, ["todo", "in_progress"], successorRunId),
    ]);

    expect(checkoutResult.status).toBe("fulfilled");
    if (releaseResult.status === "rejected") {
      expect(releaseResult.reason).toMatchObject({ status: 409 });
    }

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toMatchObject({
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: successorRunId,
      executionRunId: successorRunId,
    });
  });

  it("checkout refuses to promote a 'done' issue when 'done' is not in expectedStatuses, even with a lingering executionRunId pointer", async () => {
    // Regression for PR #2482 checkout-adoption review finding: the original
    // patch's stale-executionRunId adoption SQL set `status: 'in_progress'`
    // unconditionally, bypassing the caller's expectedStatuses guard. With the
    // guard restored, attempting to take over a 'done' issue with
    // expectedStatuses=['todo'] must fail and leave the row untouched.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const failedRunId = randomUUID();
    const successorRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        invocationSource: "manual",
        finishedAt: new Date("2026-06-10T10:05:00.000Z"),
      },
      {
        id: successorRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date("2026-06-10T10:07:00.000Z"),
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale lock on done issue",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date("2026-06-10T10:00:00.000Z"),
      completedAt: new Date("2026-06-10T10:01:00.000Z"),
    });

    await expect(svc.checkout(issueId, agentId, ["todo"], successorRunId))
      .rejects.toMatchObject({ status: 409 });

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toMatchObject({
      status: "done",
      assigneeAgentId: agentId,
      checkoutRunId: null,
    });
  });

  it("checkout adoption of a stale checkoutRunId preserves the issue's assigneeUserId", async () => {
    // Regression for PR #2482 checkout-adoption review finding: any adoption
    // helper that re-locks an existing in_progress issue (e.g. when the prior
    // checkout/execution run is terminal) must not strip the row's
    // assigneeUserId. We exercise this via the adoptStaleCheckoutRun path,
    // which fires when checkoutRunId points at a terminal run while
    // executionRunId still points at a different, non-terminal run.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = randomUUID();
    const issueId = randomUUID();
    const failedCheckoutRunId = randomUUID();
    const queuedExecutionRunId = randomUUID();
    const successorRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: failedCheckoutRunId,
        companyId,
        agentId,
        status: "failed",
        invocationSource: "manual",
        finishedAt: new Date("2026-06-10T10:05:00.000Z"),
      },
      {
        id: queuedExecutionRunId,
        companyId,
        agentId,
        status: "queued",
        invocationSource: "manual",
      },
      {
        id: successorRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date("2026-06-10T10:07:00.000Z"),
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale checkout lock with user co-assignee",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      assigneeUserId: userId,
      checkoutRunId: failedCheckoutRunId,
      executionRunId: queuedExecutionRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date("2026-06-10T10:00:00.000Z"),
    });

    const result = await svc.checkout(issueId, agentId, ["todo", "in_progress"], successorRunId);
    expect(result).toBeTruthy();

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toMatchObject({
      status: "in_progress",
      assigneeAgentId: agentId,
      assigneeUserId: userId,
      checkoutRunId: successorRunId,
      executionRunId: successorRunId,
    });
  });
});

describeEmbeddedPostgres("accepted plan decomposition", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-accepted-plan-decomposition-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issuePlanDecompositions);
    await db.delete(issueThreadInteractions);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAcceptedPlanContext() {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const assigneeAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Accepted plan decomposition",
      level: "task",
      status: "active",
    });

    return { companyId, goalId, assigneeAgentId };
  }

  async function seedAcceptedPlanIssue(args?: {
    companyId?: string;
    goalId?: string;
    assigneeAgentId?: string;
    sourceIssueId?: string;
    issueTitle?: string;
    workMode?: "planning" | "standard";
  }) {
    const companyId = args?.companyId ?? randomUUID();
    const goalId = args?.goalId ?? randomUUID();
    const assigneeAgentId = args?.assigneeAgentId ?? randomUUID();
    const sourceIssueId = args?.sourceIssueId ?? randomUUID();
    const planDocumentId = randomUUID();
    const acceptedPlanRevisionId = randomUUID();
    const acceptedInteractionId = randomUUID();

    if (!args?.companyId || !args?.goalId || !args?.assigneeAgentId) {
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
      await db.insert(agents).values({
        id: assigneeAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(goals).values({
        id: goalId,
        companyId,
        title: "Accepted plan decomposition",
        level: "task",
        status: "active",
      });
    }

    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      goalId,
      title: args?.issueTitle ?? "Planning issue",
      status: "in_progress",
      priority: "medium",
      workMode: args?.workMode ?? "planning",
      assigneeAgentId: assigneeAgentId,
    });
    await db.insert(documents).values({
      id: planDocumentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "Plan body",
      latestRevisionId: acceptedPlanRevisionId,
      latestRevisionNumber: 1,
      createdByAgentId: assigneeAgentId,
      updatedByAgentId: assigneeAgentId,
    });
    await db.insert(documentRevisions).values({
      id: acceptedPlanRevisionId,
      companyId,
      documentId: planDocumentId,
      revisionNumber: 1,
      title: "Plan",
      format: "markdown",
      body: "Plan body",
      createdByAgentId: assigneeAgentId,
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId: sourceIssueId,
      documentId: planDocumentId,
      key: "plan",
    });
    await db.insert(issueThreadInteractions).values({
      id: acceptedInteractionId,
      companyId,
      issueId: sourceIssueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Approve this plan?",
        target: {
          type: "issue_document",
          issueId: sourceIssueId,
          documentId: planDocumentId,
          key: "plan",
          revisionId: acceptedPlanRevisionId,
          revisionNumber: 1,
        },
      },
      result: {
        version: 1,
        outcome: "accepted",
      },
      resolvedAt: new Date(),
      createdByUserId: "local-board",
      resolvedByUserId: "local-board",
    });

    return { companyId, sourceIssueId, acceptedPlanRevisionId, assigneeAgentId };
  }

  async function getAcceptedPlanClaim(sourceIssueId: string) {
    return db
      .select()
      .from(issuePlanDecompositions)
      .where(eq(issuePlanDecompositions.sourceIssueId, sourceIssueId))
      .then((rows) => rows[0] ?? null);
  }

  it("reuses the same child issue set on repeat decomposition attempts for an accepted plan revision", async () => {
    const { companyId, sourceIssueId, acceptedPlanRevisionId, assigneeAgentId } = await seedAcceptedPlanIssue();

    const children = [
      {
        title: "Implement the claim table",
        status: "todo" as const,
        workMode: "standard" as const,
        priority: "medium" as const,
        assigneeAgentId,
      },
      {
        title: "Add decomposition route tests",
        status: "todo" as const,
        workMode: "standard" as const,
        priority: "medium" as const,
      },
    ];

    const first = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children,
      actorAgentId: assigneeAgentId,
    });

    expect(first.decomposition).not.toHaveProperty("requestedChildren");
    expect(first.childIssueIds).toHaveLength(2);
    expect(first.newlyCreatedIssues).toHaveLength(2);
    expect(first.decomposition.status).toBe("completed");

    const second = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children,
      actorAgentId: assigneeAgentId,
    });

    expect(second.childIssueIds).toEqual(first.childIssueIds);
    expect(second.newlyCreatedIssues).toHaveLength(0);
    expect(second.decomposition.status).toBe("completed");

    const persistedClaims = await db
      .select()
      .from(issuePlanDecompositions)
      .where(eq(issuePlanDecompositions.sourceIssueId, sourceIssueId));
    expect(persistedClaims).toHaveLength(1);
    expect(persistedClaims[0]?.requestedChildCount).toBe(2);
    expect(persistedClaims[0]?.childIssueIds).toEqual(first.childIssueIds);

    const childrenRows = await db
      .select({ id: issues.id, title: issues.title })
      .from(issues)
      .where(eq(issues.parentId, sourceIssueId));
    expect(childrenRows).toHaveLength(2);
    expect(childrenRows.map((row) => row.id).sort()).toEqual([...first.childIssueIds].sort());

    const companyIssues = await svc.list(companyId, { parentId: sourceIssueId });
    expect(companyIssues).toHaveLength(2);
  });

  it("rejects a different child set for the same accepted plan fingerprint", async () => {
    const { sourceIssueId, acceptedPlanRevisionId, assigneeAgentId } = await seedAcceptedPlanIssue();

    await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children: [
        {
          title: "Implement the claim table",
          status: "todo",
          workMode: "standard",
          priority: "medium",
        },
      ],
      actorAgentId: assigneeAgentId,
    });

    await expect(svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children: [
        {
          title: "Implement the claim table",
          status: "todo",
          workMode: "standard",
          priority: "medium",
        },
        {
          title: "This duplicate should be rejected",
          status: "todo",
          workMode: "standard",
          priority: "medium",
        },
      ],
      actorAgentId: assigneeAgentId,
    })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("allows accepted-plan decomposition on a standard-work issue with an accepted plan document", async () => {
    const { sourceIssueId, acceptedPlanRevisionId, assigneeAgentId } = await seedAcceptedPlanIssue({
      workMode: "standard",
      issueTitle: "Implement after planning",
    });

    const result = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children: [
        {
          title: "Implement the approved first slice",
          status: "todo",
          workMode: "standard",
          priority: "medium",
        },
      ],
      actorAgentId: assigneeAgentId,
    });

    expect(result.childIssueIds).toHaveLength(1);
    expect(result.newlyCreatedIssues).toHaveLength(1);
    expect(result.decomposition.status).toBe("completed");
  });

  it("serializes concurrent accepted-plan retries for the same parent issue without duplicate children", async () => {
    const { sourceIssueId, acceptedPlanRevisionId, assigneeAgentId } = await seedAcceptedPlanIssue();
    const children = [
      {
        title: "Persist exact-once decomposition claim",
        status: "todo" as const,
        workMode: "standard" as const,
        priority: "medium" as const,
      },
      {
        title: "Guard concurrent retry callers",
        status: "todo" as const,
        workMode: "standard" as const,
        priority: "medium" as const,
      },
    ];

    const initial = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children,
      actorAgentId: assigneeAgentId,
    });
    const claim = await getAcceptedPlanClaim(sourceIssueId);
    expect(claim).not.toBeNull();

    for (const childIssueId of initial.childIssueIds) {
      await db.delete(issues).where(eq(issues.id, childIssueId));
    }
    await db
      .update(issuePlanDecompositions)
      .set({
        status: "in_flight",
        childIssueIds: [],
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(issuePlanDecompositions.id, claim!.id));

    const svcA = issueService(db);
    const svcB = issueService(db);
    const [first, second] = await Promise.all([
      svcA.decomposeAcceptedPlan(sourceIssueId, {
        acceptedPlanRevisionId,
        children,
        actorAgentId: assigneeAgentId,
      }),
      svcB.decomposeAcceptedPlan(sourceIssueId, {
        acceptedPlanRevisionId,
        children,
        actorAgentId: assigneeAgentId,
      }),
    ]);

    expect(first.childIssueIds).toEqual(second.childIssueIds);
    expect(first.childIssueIds).toHaveLength(2);
    expect(first.newlyCreatedIssues.length + second.newlyCreatedIssues.length).toBe(2);

    const persistedClaim = await getAcceptedPlanClaim(sourceIssueId);
    expect(persistedClaim?.status).toBe("completed");
    expect(persistedClaim?.childIssueIds).toEqual(first.childIssueIds);

    const childrenRows = await db
      .select({ id: issues.id, title: issues.title })
      .from(issues)
      .where(eq(issues.parentId, sourceIssueId));
    expect(childrenRows).toHaveLength(2);
    expect(childrenRows.map((row) => row.id).sort()).toEqual([...first.childIssueIds].sort());
  });

  it("rejects another planning parent's accepted revision even when both issues share the assignee", async () => {
    const { companyId, goalId, assigneeAgentId } = await seedAcceptedPlanContext();
    const firstIssue = await seedAcceptedPlanIssue({
      companyId,
      goalId,
      assigneeAgentId,
      issueTitle: "Earlier accepted plan",
    });
    const secondIssue = await seedAcceptedPlanIssue({
      companyId,
      goalId,
      assigneeAgentId,
      issueTitle: "Later accepted plan",
    });

    await svc.decomposeAcceptedPlan(firstIssue.sourceIssueId, {
      acceptedPlanRevisionId: firstIssue.acceptedPlanRevisionId,
      children: [
        {
          title: "Decompose the first issue only",
          status: "todo",
          workMode: "standard",
          priority: "medium",
        },
      ],
      actorAgentId: assigneeAgentId,
    });

    await expect(svc.decomposeAcceptedPlan(secondIssue.sourceIssueId, {
      acceptedPlanRevisionId: firstIssue.acceptedPlanRevisionId,
      children: [
        {
          title: "This must not land on the second parent",
          status: "todo",
          workMode: "standard",
          priority: "medium",
        },
      ],
      actorAgentId: assigneeAgentId,
    })).rejects.toMatchObject({
      status: 422,
    });

    const secondIssueChildren = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.parentId, secondIssue.sourceIssueId));
    expect(secondIssueChildren).toHaveLength(0);
  });

  it("resumes partial child creation under the claimed fingerprint without duplicating completed children", async () => {
    const { sourceIssueId, acceptedPlanRevisionId, assigneeAgentId } = await seedAcceptedPlanIssue();
    const children = [
      {
        title: "Create the first child once",
        status: "todo" as const,
        workMode: "standard" as const,
        priority: "medium" as const,
      },
      {
        title: "Recreate only the missing tail child",
        status: "todo" as const,
        workMode: "standard" as const,
        priority: "medium" as const,
      },
    ];

    const initial = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children,
      actorAgentId: assigneeAgentId,
    });
    const claim = await getAcceptedPlanClaim(sourceIssueId);
    expect(claim).not.toBeNull();

    const [firstChildId, secondChildId] = initial.childIssueIds;
    expect(firstChildId).toBeTruthy();
    expect(secondChildId).toBeTruthy();

    await db.delete(issues).where(eq(issues.id, secondChildId!));
    await db
      .update(issuePlanDecompositions)
      .set({
        status: "in_flight",
        childIssueIds: [firstChildId!],
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(issuePlanDecompositions.id, claim!.id));

    const retried = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children,
      actorAgentId: assigneeAgentId,
    });

    expect(retried.decomposition.status).toBe("completed");
    expect(retried.childIssueIds[0]).toBe(firstChildId);
    expect(retried.newlyCreatedIssues).toHaveLength(1);
    expect(retried.newlyCreatedIssues[0]?.title).toBe("Recreate only the missing tail child");

    const childrenRows = await db
      .select({ id: issues.id, title: issues.title })
      .from(issues)
      .where(eq(issues.parentId, sourceIssueId));
    expect(childrenRows).toHaveLength(2);
    expect(childrenRows.some((row) => row.id === firstChildId)).toBe(true);
    expect(childrenRows.map((row) => row.title).sort()).toEqual(children.map((child) => child.title).sort());
  });

  it("resumes a partial decomposition after reassignment when only actor metadata changes", async () => {
    const { companyId, sourceIssueId, acceptedPlanRevisionId, assigneeAgentId } = await seedAcceptedPlanIssue();
    const reassignedAgentId = randomUUID();
    await db.insert(agents).values({
      id: reassignedAgentId,
      companyId,
      name: "SecondCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const children = [
      {
        title: "Keep the original child",
        status: "todo" as const,
        workMode: "standard" as const,
        priority: "medium" as const,
        createdByAgentId: assigneeAgentId,
        actorAgentId: assigneeAgentId,
      },
      {
        title: "Create only the missing child after reassignment",
        status: "todo" as const,
        workMode: "standard" as const,
        priority: "medium" as const,
        createdByAgentId: assigneeAgentId,
        actorAgentId: assigneeAgentId,
      },
    ];

    const initial = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children,
      actorAgentId: assigneeAgentId,
    });
    const claim = await getAcceptedPlanClaim(sourceIssueId);
    const [firstChildId, secondChildId] = initial.childIssueIds;

    expect(claim).not.toBeNull();
    expect(firstChildId).toBeTruthy();
    expect(secondChildId).toBeTruthy();

    await db.delete(issues).where(eq(issues.id, secondChildId!));
    await db
      .update(issues)
      .set({ assigneeAgentId: reassignedAgentId, updatedAt: new Date() })
      .where(eq(issues.id, sourceIssueId));
    await db
      .update(issuePlanDecompositions)
      .set({
        status: "in_flight",
        childIssueIds: [firstChildId!],
        completedAt: null,
        ownerAgentId: assigneeAgentId,
        updatedAt: new Date(),
      })
      .where(eq(issuePlanDecompositions.id, claim!.id));

    const retried = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children: children.map((child) => ({
        ...child,
        createdByAgentId: reassignedAgentId,
        actorAgentId: reassignedAgentId,
      })),
      actorAgentId: reassignedAgentId,
    });

    expect(retried.decomposition.status).toBe("completed");
    expect(retried.decomposition.ownerAgentId).toBe(reassignedAgentId);
    expect(retried.childIssueIds[0]).toBe(firstChildId);
    expect(retried.newlyCreatedIssues).toHaveLength(1);
    expect(retried.newlyCreatedIssues[0]?.title).toBe("Create only the missing child after reassignment");

    const childrenRows = await db
      .select({ id: issues.id, title: issues.title, createdByAgentId: issues.createdByAgentId })
      .from(issues)
      .where(eq(issues.parentId, sourceIssueId))
      .orderBy(asc(issues.createdAt), asc(issues.id));
    expect(childrenRows).toHaveLength(2);
    expect(childrenRows.map((row) => row.id).sort()).toEqual([...retried.childIssueIds].sort());
    expect(childrenRows.find((row) => row.id !== firstChildId)?.createdByAgentId).toBe(reassignedAgentId);
  });

  it("preserves the existing live claim owner when another actor resumes the same fingerprint", async () => {
    const { companyId, sourceIssueId, acceptedPlanRevisionId, assigneeAgentId } = await seedAcceptedPlanIssue();
    const competingAgentId = randomUUID();
    const liveOwnerRunId = randomUUID();
    const competingRunId = randomUUID();
    await db.insert(agents).values({
      id: competingAgentId,
      companyId,
      name: "SecondCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: liveOwnerRunId,
        companyId,
        agentId: assigneeAgentId,
        status: "running",
        invocationSource: "manual",
      },
      {
        id: competingRunId,
        companyId,
        agentId: competingAgentId,
        status: "running",
        invocationSource: "manual",
      },
    ]);

    const children = [
      {
        title: "Keep the first created child",
        status: "todo" as const,
        workMode: "standard" as const,
        priority: "medium" as const,
      },
      {
        title: "Create the missing second child",
        status: "todo" as const,
        workMode: "standard" as const,
        priority: "medium" as const,
      },
    ];

    const initial = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children,
      actorAgentId: assigneeAgentId,
      actorRunId: liveOwnerRunId,
    });
    const [firstChildId, secondChildId] = initial.childIssueIds;
    const claim = await getAcceptedPlanClaim(sourceIssueId);

    await db.delete(issues).where(eq(issues.id, secondChildId!));
    await db
      .update(issuePlanDecompositions)
      .set({
        status: "in_flight",
        childIssueIds: [firstChildId!],
        completedAt: null,
        ownerAgentId: assigneeAgentId,
        ownerRunId: liveOwnerRunId,
        updatedAt: new Date(),
      })
      .where(eq(issuePlanDecompositions.id, claim!.id));

    const retried = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children,
      actorAgentId: competingAgentId,
      actorRunId: competingRunId,
    });

    expect(retried.decomposition.status).toBe("completed");
    expect(retried.decomposition.ownerAgentId).toBe(assigneeAgentId);
    expect(retried.decomposition.ownerRunId).toBe(liveOwnerRunId);
  });

  it("lists persisted decompositions with child issue summaries", async () => {
    const { sourceIssueId, acceptedPlanRevisionId, assigneeAgentId } = await seedAcceptedPlanIssue();

    const initial = await svc.listAcceptedPlanDecompositions(sourceIssueId);
    expect(initial).toEqual([]);

    const result = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children: [
        {
          title: "Surface decomposition status in operator UI",
          status: "todo",
          workMode: "standard",
          priority: "medium",
        },
        {
          title: "Add regression coverage",
          status: "todo",
          workMode: "standard",
          priority: "medium",
        },
      ],
      actorAgentId: assigneeAgentId,
    });

    const decompositions = await svc.listAcceptedPlanDecompositions(sourceIssueId);
    expect(decompositions).toHaveLength(1);
    const [record] = decompositions;
    expect(record?.status).toBe("completed");
    expect(record?.acceptedPlanRevisionId).toBe(acceptedPlanRevisionId);
    expect(record?.acceptedPlanRevisionNumber).toBeTypeOf("number");
    expect(record?.childIssues.map((child) => child.id).sort()).toEqual(
      [...result.childIssueIds].sort(),
    );
    expect(record).not.toHaveProperty("requestedChildren");
    expect(record?.childIssues.every((child) => typeof child.title === "string")).toBe(true);
  });
});

describeEmbeddedPostgres("issueService.assertCheckoutOwner stale checkout adoption", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-checkout-owner-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedOwnershipIssue(params: {
    checkoutStatus: "running" | "failed" | "timed_out";
    actorRunStatus?: "running" | "failed" | "timed_out" | "succeeded";
    assigneeMatchesActor?: boolean;
  }) {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const actorAgentId = params.assigneeMatchesActor === false ? randomUUID() : assigneeAgentId;
    const staleRunId = randomUUID();
    const actorRunId = randomUUID();
    const issueId = randomUUID();
    const actorRunStatus = params.actorRunStatus ?? "running";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentRows = [
      {
        id: assigneeAgentId,
        companyId,
        name: "Assignee",
        role: "engineer" as const,
        status: "active" as const,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ];
    if (actorAgentId !== assigneeAgentId) {
      agentRows.push({
        id: actorAgentId,
        companyId,
        name: "Actor",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    await db.insert(agents).values(agentRows);
    await db.insert(heartbeatRuns).values([
      {
        id: staleRunId,
        companyId,
        agentId: assigneeAgentId,
        status: params.checkoutStatus,
        invocationSource: "manual",
        finishedAt: params.checkoutStatus === "running" ? null : new Date(),
      },
      {
        id: actorRunId,
        companyId,
        agentId: actorAgentId,
        status: actorRunStatus,
        invocationSource: "manual",
        startedAt: actorRunStatus === "running" ? new Date() : null,
        finishedAt: actorRunStatus === "running" ? null : new Date(),
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Checkout owner recovery",
      status: "in_progress",
      priority: "high",
      assigneeAgentId,
      checkoutRunId: staleRunId,
      executionRunId: staleRunId,
      executionLockedAt: new Date(),
      executionAgentNameKey: "assignee",
    });

    return { issueId, assigneeAgentId, actorAgentId, staleRunId, actorRunId };
  }

  it("lets the current assignee adopt a stale terminal checkout owner", async () => {
    const seeded = await seedOwnershipIssue({ checkoutStatus: "failed" });

    const ownership = await svc.assertCheckoutOwner(seeded.issueId, seeded.actorAgentId, seeded.actorRunId);

    expect(ownership.checkoutRunId).toBe(seeded.actorRunId);
    expect(ownership.executionRunId).toBe(seeded.actorRunId);
    expect(ownership.adoptedFromRunId).toBeNull();
  });

  it("treats timed_out checkout owners as stale and recoverable", async () => {
    const seeded = await seedOwnershipIssue({ checkoutStatus: "timed_out" });

    const ownership = await svc.assertCheckoutOwner(seeded.issueId, seeded.actorAgentId, seeded.actorRunId);

    expect(ownership.checkoutRunId).toBe(seeded.actorRunId);
    expect(ownership.adoptedFromRunId).toBeNull();
  });

  it("does not allow non-assignees to adopt stale checkout ownership", async () => {
    const seeded = await seedOwnershipIssue({ checkoutStatus: "failed", assigneeMatchesActor: false });

    await expect(
      svc.assertCheckoutOwner(seeded.issueId, seeded.actorAgentId, seeded.actorRunId),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("keeps live checkout owners protected with a 409 conflict", async () => {
    const seeded = await seedOwnershipIssue({ checkoutStatus: "running" });

    await expect(
      svc.assertCheckoutOwner(seeded.issueId, seeded.actorAgentId, seeded.actorRunId),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("does not let terminal actor runs adopt stale checkout ownership", async () => {
    const seeded = await seedOwnershipIssue({ checkoutStatus: "failed", actorRunStatus: "succeeded" });

    await expect(
      svc.assertCheckoutOwner(seeded.issueId, seeded.actorAgentId, seeded.actorRunId),
    ).rejects.toMatchObject({ status: 409 });

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      checkoutRunId: null,
      executionRunId: null,
    });
  });

  it("adopts unowned checkout after a concurrent stale-checkout clear wins the lock race", async () => {
    const seeded = await seedOwnershipIssue({ checkoutStatus: "failed" });
    await db
      .update(issues)
      .set({
        executionRunId: seeded.actorRunId,
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, seeded.issueId));

    const rowLocked = deferred<void>();
    const clearCanCommit = deferred<void>();

    const concurrentClear = db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${issues.id} from ${issues} where ${issues.id} = ${seeded.issueId} for update`,
      );
      rowLocked.resolve();
      await clearCanCommit.promise;
      await tx
        .update(issues)
        .set({
          checkoutRunId: null,
          executionRunId: seeded.actorRunId,
          executionLockedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(issues.id, seeded.issueId));
    });

    await rowLocked.promise;

    const ownershipPromise = svc.assertCheckoutOwner(seeded.issueId, seeded.actorAgentId, seeded.actorRunId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    clearCanCommit.resolve();
    await concurrentClear;

    const ownership = await ownershipPromise;
    expect(ownership.checkoutRunId).toBe(seeded.actorRunId);
    expect(ownership.executionRunId).toBe(seeded.actorRunId);
    expect(ownership.adoptedFromRunId).toBeNull();

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      checkoutRunId: seeded.actorRunId,
      executionRunId: seeded.actorRunId,
    });
  });

});
