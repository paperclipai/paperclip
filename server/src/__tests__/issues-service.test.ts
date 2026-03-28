import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { issueService, type IssueFilters } from "../services/issues.ts";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-issues-service-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();

  const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "paperclip");
  const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("issueService.list participantAgentId", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    svc = issueService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
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

  it("adopts stale execution locks when same-assignee checkout lock is missing", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const staleRunId = randomUUID();
    const actorRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ReleaseLead",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values([
      {
        id: staleRunId,
        companyId,
        agentId,
        invocationSource: "scheduler",
        status: "failed",
      },
      {
        id: actorRunId,
        companyId,
        agentId,
        invocationSource: "scheduler",
        status: "running",
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Adopt stale execution lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: staleRunId,
    });

    const updated = await svc.checkout(issueId, agentId, ["todo", "backlog", "blocked"], actorRunId);
    expect(updated?.id).toBe(issueId);
    expect(updated?.status).toBe("in_progress");
    expect(updated?.checkoutRunId).toBe(actorRunId);
    expect(updated?.executionRunId).toBe(actorRunId);
  });

  it("rejects checkout calls with no valid expected statuses", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ReleaseLead",
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
      title: "Status validation",
      status: "todo",
      priority: "medium",
    });

    await expect(
      svc.checkout(issueId, agentId, [] as string[], null),
    ).rejects.toMatchObject({
      status: 422,
      message: "expectedStatuses must include at least one valid issue status",
    });
  });

  it("returns not found for malformed issue ids on checkout", async () => {
    await expect(
      svc.checkout("not-a-uuid", randomUUID(), ["todo"], null),
    ).rejects.toMatchObject({
      status: 404,
      message: "Issue not found",
    });
  });

  it("returns unprocessable for malformed agent ids on checkout", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Malformed agent id checkout",
      status: "todo",
      priority: "medium",
    });

    await expect(
      svc.checkout(issueId, "not-a-uuid", ["todo"], null),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid agentId",
    });
  });

  it("returns unprocessable for malformed checkout run ids", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
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
      name: "CheckoutAgent",
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
      title: "Malformed run id checkout",
      status: "todo",
      priority: "medium",
    });

    await expect(
      svc.checkout(issueId, agentId, ["todo"], "not-a-uuid"),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid checkoutRunId",
    });
  });

  it("returns an empty page for malformed non-uuid comment cursors", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cursor validation",
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values({
      issueId,
      companyId,
      body: "first comment",
    });

    const comments = await svc.listComments(issueId, {
      afterCommentId: "not-a-uuid",
      order: "asc",
    });

    expect(comments).toEqual([]);
  });

  it("returns an empty comment page when issueId is malformed", async () => {
    const comments = await svc.listComments("not-a-uuid", {
      order: "asc",
      limit: 10,
    });
    expect(comments).toEqual([]);
  });

  it("returns null for malformed non-uuid comment ids", async () => {
    await expect(svc.getComment("not-a-uuid")).resolves.toBeNull();
  });

  it("returns an empty cursor payload for malformed non-uuid issue ids", async () => {
    await expect(svc.getCommentCursor("not-a-uuid")).resolves.toEqual({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
  });

  it("ignores malformed non-string list filters instead of throwing", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Malformed filter safety",
      status: "todo",
      priority: "medium",
    });

    const result = await svc.list(companyId, {
      status: { bad: true } as unknown as string,
      q: ["broken"] as unknown as string,
      assigneeAgentId: 123 as unknown as string,
    });

    expect(result.map((issue) => issue.id)).toContain(issueId);
  });

  it("returns an empty list for malformed uuid string list filters", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Malformed uuid filter safety",
      status: "todo",
      priority: "medium",
    });

    const uuidFilterKeys: Array<keyof Pick<
      IssueFilters,
      "assigneeAgentId" | "participantAgentId" | "projectId" | "parentId" | "labelId"
    >> = [
      "assigneeAgentId",
      "participantAgentId",
      "projectId",
      "parentId",
      "labelId",
    ];

    for (const key of uuidFilterKeys) {
      const result = await svc.list(companyId, { [key]: "not-a-uuid" } as Pick<IssueFilters, typeof key>);
      expect(result).toEqual([]);
    }
  });

  it("returns an empty list when companyId is malformed for list", async () => {
    await expect(svc.list("not-a-uuid", {})).resolves.toEqual([]);
  });

  it("ignores malformed non-string unread status filters instead of throwing", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const userId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Unread malformed status filter safety",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
    });

    await db.insert(issueComments).values({
      issueId,
      companyId,
      body: "new external comment",
      authorAgentId: null,
      authorUserId: null,
    });

    const unreadCount = await svc.countUnreadTouchedByUser(
      companyId,
      userId,
      { bad: true } as unknown as string,
    );

    expect(unreadCount).toBe(1);
  });

  it("returns zero unread count when companyId is malformed", async () => {
    const unreadCount = await svc.countUnreadTouchedByUser("not-a-uuid", randomUUID(), "todo");
    expect(unreadCount).toBe(0);
  });

  it("returns not found for malformed non-uuid issue ids on createAttachment", async () => {
    await expect(
      svc.createAttachment({
        issueId: "not-a-uuid",
        provider: "local",
        objectKey: "issues/not-a-uuid/file.txt",
        contentType: "text/plain",
        byteSize: 10,
        sha256: "abc123",
      }),
    ).rejects.toMatchObject({
      status: 404,
      message: "Issue not found",
    });
  });

  it("returns not found for malformed non-uuid issueCommentId on createAttachment", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Attachment comment id validation",
      status: "todo",
      priority: "medium",
    });

    await expect(
      svc.createAttachment({
        issueId,
        issueCommentId: "not-a-uuid",
        provider: "local",
        objectKey: `issues/${issueId}/file.txt`,
        contentType: "text/plain",
        byteSize: 10,
        sha256: "abc123",
      }),
    ).rejects.toMatchObject({
      status: 404,
      message: "Issue comment not found",
    });
  });

  it("returns an empty attachment list for malformed issue ids", async () => {
    await expect(svc.listAttachments("not-a-uuid")).resolves.toEqual([]);
  });

  it("returns null for malformed attachment ids on getAttachmentById", async () => {
    await expect(svc.getAttachmentById("not-a-uuid")).resolves.toBeNull();
  });

  it("returns null for malformed attachment ids on removeAttachment", async () => {
    await expect(svc.removeAttachment("not-a-uuid")).resolves.toBeNull();
  });

  it("returns not found for malformed issue ids on addComment", async () => {
    await expect(
      svc.addComment("not-a-uuid", "hello", {}),
    ).rejects.toMatchObject({
      status: 404,
      message: "Issue not found",
    });
  });

  it("returns not found for malformed issue ids on markRead", async () => {
    await expect(
      svc.markRead(randomUUID(), "not-a-uuid", "user-1", new Date()),
    ).rejects.toMatchObject({
      status: 404,
      message: "Issue not found",
    });
  });

  it("returns null for malformed issue ids on getById", async () => {
    await expect(svc.getById("not-a-uuid")).resolves.toBeNull();
  });

  it("returns null for malformed issue ids on update", async () => {
    await expect(
      svc.update("not-a-uuid", { title: "ignored" }),
    ).resolves.toBeNull();
  });

  it("returns not found for malformed issue ids on assertCheckoutOwner", async () => {
    await expect(
      svc.assertCheckoutOwner("not-a-uuid", randomUUID(), null),
    ).rejects.toMatchObject({
      status: 404,
      message: "Issue not found",
    });
  });

  it("returns null for malformed issue ids on remove", async () => {
    await expect(svc.remove("not-a-uuid")).resolves.toBeNull();
  });

  it("returns null for malformed label ids on getLabelById", async () => {
    await expect(svc.getLabelById("not-a-uuid")).resolves.toBeNull();
  });

  it("returns null for malformed label ids on deleteLabel", async () => {
    await expect(svc.deleteLabel("not-a-uuid")).resolves.toBeNull();
  });

  it("returns an empty label list when companyId is malformed", async () => {
    await expect(svc.listLabels("not-a-uuid")).resolves.toEqual([]);
  });

  it("returns unprocessable for malformed company ids on createLabel", async () => {
    await expect(
      svc.createLabel("not-a-uuid", { name: "Bug", color: "#FF0000" }),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid companyId",
    });
  });

  it("returns an empty list for malformed issue ids on findMentionedProjectIds", async () => {
    await expect(svc.findMentionedProjectIds("not-a-uuid")).resolves.toEqual([]);
  });

  it("ignores malformed project mention ids instead of throwing", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Mention parser safety [bad](project://not-a-uuid)",
      description: "Also malformed [project](project://still-not-a-uuid)",
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values({
      issueId,
      companyId,
      body: "comment malformed mention [oops](project://definitely-not-a-uuid)",
    });

    await expect(svc.findMentionedProjectIds(issueId)).resolves.toEqual([]);
  });

  it("ignores malformed agent mention ids while keeping valid mentions", async () => {
    const companyId = randomUUID();
    const mentionedByNameId = randomUUID();
    const explicitValidMentionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: mentionedByNameId,
      companyId,
      name: "WakeAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const result = await svc.findMentionedAgents(
      companyId,
      [
        "[bad](agent://not-a-uuid)",
        `[good](agent://${explicitValidMentionId})`,
        "@WakeAgent",
      ].join(" "),
    );

    expect(result.sort()).toEqual([explicitValidMentionId, mentionedByNameId].sort());
  });

  it("returns an empty list for malformed issue ids on getAncestors", async () => {
    await expect(svc.getAncestors("not-a-uuid")).resolves.toEqual([]);
  });

  it("returns null for malformed issue ids on release", async () => {
    await expect(svc.release("not-a-uuid")).resolves.toBeNull();
  });

  it("returns unprocessable for malformed assigneeAgentId on create", async () => {
    await expect(
      svc.create(randomUUID(), {
        title: "Invalid assignee guard",
        assigneeAgentId: "not-a-uuid",
      } as any),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid assigneeAgentId",
    });
  });

  it("returns not found for non-existent company ids on create", async () => {
    await expect(
      svc.create(randomUUID(), {
        title: "Missing company guard",
      } as any),
    ).rejects.toMatchObject({
      status: 404,
      message: "Company not found",
    });
  });

  it("returns unprocessable for malformed workspace ids on create", async () => {
    await expect(
      svc.create(randomUUID(), {
        title: "Invalid workspace guard",
        projectWorkspaceId: "not-a-uuid",
      } as any),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid projectWorkspaceId",
    });

    await expect(
      svc.create(randomUUID(), {
        title: "Invalid execution workspace guard",
        executionWorkspaceId: "not-a-uuid",
      } as any),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid executionWorkspaceId",
    });
  });

  it("returns unprocessable for malformed label ids on create", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(
      svc.create(companyId, {
        title: "Malformed labels guard",
        labelIds: ["not-a-uuid"],
      } as any),
    ).rejects.toMatchObject({
      status: 422,
      message: "One or more labels must be valid UUIDs",
    });
  });

  it("returns unprocessable for malformed project/parent/goal ids on create", async () => {
    await expect(
      svc.create(randomUUID(), {
        title: "Invalid project id guard",
        projectId: "not-a-uuid",
      } as any),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid projectId",
    });

    await expect(
      svc.create(randomUUID(), {
        title: "Invalid parent id guard",
        parentId: "not-a-uuid",
      } as any),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid parentId",
    });

    await expect(
      svc.create(randomUUID(), {
        title: "Invalid goal id guard",
        goalId: "not-a-uuid",
      } as any),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid goalId",
    });
  });

  it("returns unprocessable for malformed project/parent/goal ids on update", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Update malformed ids guard",
      status: "todo",
      priority: "medium",
    });

    await expect(
      svc.update(issueId, { projectId: "not-a-uuid" } as any),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid projectId",
    });

    await expect(
      svc.update(issueId, { parentId: "not-a-uuid" } as any),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid parentId",
    });

    await expect(
      svc.update(issueId, { goalId: "not-a-uuid" } as any),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid goalId",
    });
  });
});
