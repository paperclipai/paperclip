import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  issueComments,
  issueLabels,
  issueReadStates,
  issues,
  labels,
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
    await db.delete(issueReadStates);
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

  it("normalizes checkout expected statuses for non-route callers", async () => {
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
      name: "NormalizeCheckoutStatuses",
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
      title: "Checkout expected status normalization",
      status: "todo",
      priority: "medium",
    });

    const updated = await svc.checkout(issueId, agentId, [" TODO "], null);
    expect(updated?.id).toBe(issueId);
    expect(updated?.status).toBe("in_progress");
    expect(updated?.assigneeAgentId).toBe(agentId);
  });

  it("normalizes checkout UUID inputs for non-route callers", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const checkoutRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "NormalizeCheckoutUuids",
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
      title: "Checkout uuid normalization",
      status: "todo",
      priority: "medium",
    });

    await db.insert(heartbeatRuns).values({
      id: checkoutRunId,
      companyId,
      agentId,
      invocationSource: "scheduler",
      status: "running",
    });

    const updated = await svc.checkout(
      ` ${issueId.toUpperCase()} `,
      ` ${agentId.toUpperCase()} `,
      ["todo"],
      ` ${checkoutRunId.toUpperCase()} `,
    );

    expect(updated?.id).toBe(issueId);
    expect(updated?.status).toBe("in_progress");
    expect(updated?.assigneeAgentId).toBe(agentId);
    expect(updated?.checkoutRunId).toBe(checkoutRunId);
    expect(updated?.executionRunId).toBe(checkoutRunId);
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

  it("normalizes comment order filters for non-route callers", async () => {
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
      title: "Order normalization",
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values([
      {
        issueId,
        companyId,
        body: "older",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        issueId,
        companyId,
        body: "newer",
        createdAt: new Date("2026-01-01T00:00:01.000Z"),
      },
    ]);

    const comments = await svc.listComments(issueId, {
      order: "ASC" as any,
    });
    expect(comments.map((comment) => comment.body)).toEqual(["older", "newer"]);
  });

  it("accepts numeric-string comment limits for non-route callers", async () => {
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
      title: "String limit normalization",
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values([
      {
        issueId,
        companyId,
        body: "older",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        issueId,
        companyId,
        body: "newer",
        createdAt: new Date("2026-01-01T00:00:01.000Z"),
      },
    ]);

    const comments = await svc.listComments(issueId, {
      order: "asc",
      limit: "1" as any,
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe("older");
  });

  it("normalizes comment cursor case for non-route callers", async () => {
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
      title: "Cursor case normalization",
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values([
      {
        issueId,
        companyId,
        body: "first",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        issueId,
        companyId,
        body: "second",
        createdAt: new Date("2026-01-01T00:00:01.000Z"),
      },
    ]);
    const firstCommentId = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id))
      .then((rows) => rows[0]?.id ?? null);
    expect(firstCommentId).toBeTruthy();

    const comments = await svc.listComments(issueId, {
      order: "asc",
      afterCommentId: firstCommentId!.toUpperCase(),
    });
    expect(comments.map((comment) => comment.body)).toEqual(["second"]);
  });

  it("normalizes issue/comment ids for non-route comment fetch callers", async () => {
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
      title: "Comment id normalization",
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values({
      issueId,
      companyId,
      body: "normalized comment",
    });

    const insertedCommentId = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .then((rows) => rows[0]?.id ?? null);
    expect(insertedCommentId).toBeTruthy();

    const paddedIssueId = ` ${issueId.toUpperCase()} `;
    const paddedCommentId = ` ${insertedCommentId!.toUpperCase()} `;

    const comments = await svc.listComments(paddedIssueId, { order: "asc" });
    expect(comments).toHaveLength(1);

    await expect(svc.getCommentCursor(paddedIssueId)).resolves.toEqual(
      expect.objectContaining({
        totalComments: 1,
        latestCommentId: insertedCommentId,
      }),
    );

    await expect(svc.getComment(paddedCommentId)).resolves.toEqual(
      expect.objectContaining({
        id: insertedCommentId,
        issueId,
      }),
    );
  });

  it("ignores malformed non-string comment cursors instead of throwing", async () => {
    const comments = await svc.listComments(randomUUID(), {
      afterCommentId: { bad: true } as any,
      order: "asc",
    });
    expect(comments).toEqual([]);
  });

  it("ignores malformed non-number comment limits instead of throwing", async () => {
    const comments = await svc.listComments(randomUUID(), {
      limit: Symbol("bad") as any,
      order: "asc",
    });
    expect(comments).toEqual([]);
  });

  it("caps malformed explicit comment limits for non-route callers", async () => {
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
      title: "Malformed comment limit safety",
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values(
      Array.from({ length: 505 }, (_, index) => ({
        issueId,
        companyId,
        body: `comment-${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)),
      })),
    );

    const comments = await svc.listComments(issueId, {
      order: "asc",
      limit: "not-a-number" as any,
    });
    expect(comments).toHaveLength(500);
    expect(comments[0]?.body).toBe("comment-0");
    expect(comments[499]?.body).toBe("comment-499");
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

  it("normalizes uuid list filters for non-route callers", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const parentId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    const labelId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "FilterNormalizeAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        title: "Parent issue",
        status: "todo",
        priority: "medium",
      },
      {
        id: issueId,
        companyId,
        title: "Target issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        parentId,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Other issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    await db.insert(labels).values({
      id: labelId,
      companyId,
      name: "urgent",
      color: "#FF0000",
    });
    await db.insert(issueLabels).values({
      issueId,
      labelId,
      companyId,
    });

    const assigneeResult = await svc.list(companyId, { assigneeAgentId: ` ${agentId.toUpperCase()} ` });
    expect(assigneeResult.map((issue) => issue.id)).toContain(issueId);

    const participantResult = await svc.list(companyId, { participantAgentId: ` ${agentId.toUpperCase()} ` });
    expect(participantResult.map((issue) => issue.id)).toContain(issueId);

    const parentResult = await svc.list(companyId, { parentId: ` ${parentId.toUpperCase()} ` });
    expect(parentResult.map((issue) => issue.id)).toContain(issueId);

    const labelResult = await svc.list(companyId, { labelId: ` ${labelId.toUpperCase()} ` });
    expect(labelResult.map((issue) => issue.id)).toContain(issueId);
  });

  it("normalizes status and originKind filters for non-route callers", async () => {
    const companyId = randomUUID();
    const routineIssueId = randomUUID();
    const manualIssueId = randomUUID();
    const routineOriginId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: routineIssueId,
        companyId,
        title: "Routine issue",
        status: "todo",
        priority: "medium",
        originKind: "routine_execution",
        originId: routineOriginId,
      },
      {
        id: manualIssueId,
        companyId,
        title: "Manual issue",
        status: "todo",
        priority: "medium",
        originKind: "manual",
      },
    ]);

    const statusResult = await svc.list(companyId, { status: " TODO " });
    expect(statusResult.map((issue) => issue.id)).toContain(manualIssueId);

    const originResult = await svc.list(companyId, { originKind: " ROUTINE_EXECUTION " });
    expect(originResult.map((issue) => issue.id)).toContain(routineIssueId);

    const originByIdResult = await svc.list(companyId, {
      originKind: "routine_execution",
      originId: routineOriginId.toUpperCase(),
    });
    expect(originByIdResult.map((issue) => issue.id)).toContain(routineIssueId);
  });

  it("keeps routine_execution issues excluded by default for malformed non-route origin/include filters", async () => {
    const companyId = randomUUID();
    const routineIssueId = randomUUID();
    const manualIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: routineIssueId,
        companyId,
        title: "Routine execution issue",
        status: "todo",
        priority: "medium",
        originKind: "routine_execution",
        originId: randomUUID(),
      },
      {
        id: manualIssueId,
        companyId,
        title: "Manual issue",
        status: "todo",
        priority: "medium",
        originKind: "manual",
      },
    ]);

    const defaultLikeResult = await svc.list(companyId, {
      includeRoutineExecutions: "false" as unknown as boolean,
      originKind: { bad: true } as unknown as string,
      originId: { bad: true } as unknown as string,
    });
    expect(defaultLikeResult.map((issue) => issue.id)).toEqual([manualIssueId]);

    const explicitIncludeResult = await svc.list(companyId, {
      includeRoutineExecutions: "true" as unknown as boolean,
    });
    expect(new Set(explicitIncludeResult.map((issue) => issue.id))).toEqual(
      new Set([manualIssueId, routineIssueId]),
    );
  });

  it("returns an empty list when companyId is malformed for list", async () => {
    await expect(svc.list("not-a-uuid", {})).resolves.toEqual([]);
  });

  it("normalizes companyId casing/whitespace for non-route list callers", async () => {
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
      title: "Company id normalization",
      status: "todo",
      priority: "medium",
      originKind: "manual",
    });

    const normalized = await svc.list(` ${companyId.toUpperCase()} `, {});
    expect(normalized.map((issue) => issue.id)).toContain(issueId);
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

  it("normalizes unread status filters for non-route callers", async () => {
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
      title: "Unread status normalization",
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

    const unreadCount = await svc.countUnreadTouchedByUser(companyId, userId, " TODO ");
    expect(unreadCount).toBe(1);
  });

  it("trims unread user ids for non-route callers", async () => {
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
      title: "Unread userId trim normalization",
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

    const unreadCount = await svc.countUnreadTouchedByUser(companyId, ` ${userId} `, "todo");
    expect(unreadCount).toBe(1);
  });

  it("normalizes unread count company ids for non-route callers", async () => {
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
      title: "Unread company id normalization",
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

    const unreadCount = await svc.countUnreadTouchedByUser(` ${companyId.toUpperCase()} `, userId, "todo");
    expect(unreadCount).toBe(1);
  });

  it("returns zero unread count when companyId is malformed", async () => {
    const unreadCount = await svc.countUnreadTouchedByUser("not-a-uuid", randomUUID(), "todo");
    expect(unreadCount).toBe(0);
  });

  it("returns zero unread count for malformed non-string user ids", async () => {
    const unreadCount = await svc.countUnreadTouchedByUser(randomUUID(), { bad: true } as any, "todo");
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

  it("returns unprocessable for malformed createdByAgentId on createAttachment", async () => {
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
      title: "Attachment createdByAgentId validation",
      status: "todo",
      priority: "medium",
    });

    await expect(
      svc.createAttachment({
        issueId,
        provider: "local",
        objectKey: `issues/${issueId}/file.txt`,
        contentType: "text/plain",
        byteSize: 10,
        sha256: "abc123",
        createdByAgentId: "not-a-uuid",
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid createdByAgentId",
    });
  });

  it("returns unprocessable for unknown createdByAgentId on createAttachment", async () => {
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
      title: "Attachment createdByAgentId existence validation",
      status: "todo",
      priority: "medium",
    });

    await expect(
      svc.createAttachment({
        issueId,
        provider: "local",
        objectKey: `issues/${issueId}/file.txt`,
        contentType: "text/plain",
        byteSize: 10,
        sha256: "abc123",
        createdByAgentId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid createdByAgentId",
    });
  });

  it("returns unprocessable for malformed createdByUserId on createAttachment", async () => {
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
      title: "Attachment createdByUserId validation",
      status: "todo",
      priority: "medium",
    });

    await expect(
      svc.createAttachment({
        issueId,
        provider: "local",
        objectKey: `issues/${issueId}/file.txt`,
        contentType: "text/plain",
        byteSize: 10,
        sha256: "abc123",
        createdByUserId: { bad: true } as any,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid createdByUserId",
    });
  });

  it("returns unprocessable for malformed required attachment fields on createAttachment", async () => {
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
      title: "Attachment required field validation",
      status: "todo",
      priority: "medium",
    });

    await expect(
      svc.createAttachment({
        issueId,
        provider: "local",
        objectKey: `issues/${issueId}/file.txt`,
        contentType: "text/plain",
        byteSize: -1,
        sha256: "abc123",
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid byteSize",
    });

    await expect(
      svc.createAttachment({
        issueId,
        provider: " ",
        objectKey: `issues/${issueId}/file.txt`,
        contentType: "text/plain",
        byteSize: 10,
        sha256: "abc123",
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid provider",
    });
  });

  it("normalizes attachment issue/attachment uuid inputs for non-route callers", async () => {
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
      title: "Attachment uuid normalization",
      status: "todo",
      priority: "medium",
    });

    const created = await svc.createAttachment({
      issueId: ` ${issueId.toUpperCase()} `,
      provider: "local",
      objectKey: `issues/${issueId}/file.txt`,
      contentType: "text/plain",
      byteSize: 10,
      sha256: "abc123",
    });
    expect(created.issueId).toBe(issueId);

    const listed = await svc.listAttachments(` ${issueId.toUpperCase()} `);
    expect(listed.map((attachment) => attachment.id)).toContain(created.id);

    await expect(svc.getAttachmentById(` ${created.id.toUpperCase()} `)).resolves.toEqual(
      expect.objectContaining({ id: created.id }),
    );

    await expect(svc.removeAttachment(` ${created.id.toUpperCase()} `)).resolves.toEqual(
      expect.objectContaining({ id: created.id }),
    );
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

  it("returns unprocessable for malformed non-string comment bodies on addComment", async () => {
    await expect(
      svc.addComment(randomUUID(), { bad: true } as any, {}),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid comment body",
    });
  });

  it("returns unprocessable for malformed author agent ids on addComment", async () => {
    await expect(
      svc.addComment(randomUUID(), "hello", { agentId: "not-a-uuid" }),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid authorAgentId",
    });
  });

  it("returns unprocessable for unknown author agent ids on addComment", async () => {
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
      title: "addComment author agent existence validation",
      status: "todo",
      priority: "medium",
    });

    await expect(
      svc.addComment(issueId, "hello", { agentId: randomUUID() }),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid authorAgentId",
    });
  });

  it("returns unprocessable for malformed author user ids on addComment", async () => {
    await expect(
      svc.addComment(randomUUID(), "hello", { userId: { bad: true } as any }),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid authorUserId",
    });
  });

  it("normalizes addComment issue uuid inputs for non-route callers", async () => {
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
      title: "addComment uuid normalization",
      status: "todo",
      priority: "medium",
    });

    const created = await svc.addComment(` ${issueId.toUpperCase()} `, "hello", {
      userId: "operator-1",
    });

    expect(created.issueId).toBe(issueId);
    expect(created.authorUserId).toBe("operator-1");
  });

  it("returns not found for malformed issue ids on markRead", async () => {
    await expect(
      svc.markRead(randomUUID(), "not-a-uuid", "user-1", new Date()),
    ).rejects.toMatchObject({
      status: 404,
      message: "Issue not found",
    });
  });

  it("returns unprocessable for malformed company ids on markRead", async () => {
    await expect(
      svc.markRead("not-a-uuid", randomUUID(), "user-1", new Date()),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid companyId",
    });
  });

  it("returns not found for unknown issue ids on markRead", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(
      svc.markRead(companyId, randomUUID(), "user-1", new Date()),
    ).rejects.toMatchObject({
      status: 404,
      message: "Issue not found",
    });
  });

  it("returns not found when markRead company/issue do not match", async () => {
    const issueCompanyId = randomUUID();
    const otherCompanyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values([
      {
        id: issueCompanyId,
        name: "Paperclip Issue Company",
        issuePrefix: `T${issueCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Paperclip Other Company",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId: issueCompanyId,
      title: "markRead company mismatch",
      status: "todo",
      priority: "medium",
    });

    await expect(
      svc.markRead(otherCompanyId, issueId, "user-1", new Date()),
    ).rejects.toMatchObject({
      status: 404,
      message: "Issue not found",
    });
  });

  it("returns unprocessable for malformed user ids on markRead", async () => {
    await expect(
      svc.markRead(randomUUID(), randomUUID(), { bad: true } as any, new Date()),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid userId",
    });
  });

  it("trims markRead user ids for non-route callers", async () => {
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
      title: "markRead userId trim normalization",
      status: "todo",
      priority: "medium",
    });

    const readAt = new Date("2026-02-01T00:00:00.000Z");
    const row = await svc.markRead(companyId, issueId, ` ${userId} `, readAt);
    expect(row.userId).toBe(userId);
    expect(new Date(row.lastReadAt).toISOString()).toBe(readAt.toISOString());
  });

  it("normalizes markRead company/issue uuid inputs for non-route callers", async () => {
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
      title: "markRead uuid normalization",
      status: "todo",
      priority: "medium",
    });

    const row = await svc.markRead(` ${companyId.toUpperCase()} `, ` ${issueId.toUpperCase()} `, userId, new Date());
    expect(row.companyId).toBe(companyId);
    expect(row.issueId).toBe(issueId);
  });

  it("returns unprocessable for malformed readAt values on markRead", async () => {
    await expect(
      svc.markRead(randomUUID(), randomUUID(), "user-1", "not-a-date" as any),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid readAt",
    });
  });

  it("returns null for malformed issue ids on getById", async () => {
    await expect(svc.getById("not-a-uuid")).resolves.toBeNull();
  });

  it("normalizes getById uuid casing/whitespace for non-route callers", async () => {
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
      title: "getById uuid normalization",
      status: "todo",
      priority: "medium",
    });

    await expect(svc.getById(` ${issueId.toUpperCase()} `)).resolves.toEqual(
      expect.objectContaining({ id: issueId }),
    );
  });

  it("returns null for malformed non-string issue identifiers on getByIdentifier", async () => {
    await expect(svc.getByIdentifier({ bad: true } as any)).resolves.toBeNull();
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

  it("normalizes assertCheckoutOwner uuid inputs for non-route callers", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const checkoutRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CheckoutOwnerAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: checkoutRunId,
      companyId,
      agentId,
      invocationSource: "scheduler",
      status: "running",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "assertCheckoutOwner normalization",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId,
      executionRunId: checkoutRunId,
    });

    const owner = await svc.assertCheckoutOwner(
      ` ${issueId.toUpperCase()} `,
      ` ${agentId.toUpperCase()} `,
      ` ${checkoutRunId.toUpperCase()} `,
    );
    expect(owner).toEqual(expect.objectContaining({ id: issueId, assigneeAgentId: agentId, adoptedFromRunId: null }));
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

  it("normalizes label company and id uuid inputs for non-route callers", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const created = await svc.createLabel(` ${companyId.toUpperCase()} `, { name: "Ops", color: "#00AAFF" });
    expect(created.companyId).toBe(companyId);

    const listed = await svc.listLabels(` ${companyId.toUpperCase()} `);
    expect(listed.map((label) => label.id)).toContain(created.id);

    const fetched = await svc.getLabelById(` ${created.id.toUpperCase()} `);
    expect(fetched?.id).toBe(created.id);

    const removed = await svc.deleteLabel(` ${created.id.toUpperCase()} `);
    expect(removed?.id).toBe(created.id);
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

  it("accepts uppercase checkout run ids when releasing as assignee", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const checkoutRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ReleaseAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: checkoutRunId,
      companyId,
      agentId,
      invocationSource: "scheduler",
      status: "running",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Release run id normalization",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId,
      executionRunId: checkoutRunId,
    });

    const released = await svc.release(issueId, agentId, checkoutRunId.toUpperCase());
    expect(released?.id).toBe(issueId);
    expect(released?.status).toBe("todo");
    expect(released?.assigneeAgentId).toBeNull();
    expect(released?.checkoutRunId).toBeNull();
  });

  it("normalizes release issue and assignee uuid inputs for non-route callers", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const checkoutRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ReleaseNormalizeAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: checkoutRunId,
      companyId,
      agentId,
      invocationSource: "scheduler",
      status: "running",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Release issue/assignee normalization",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId,
      executionRunId: checkoutRunId,
    });

    const released = await svc.release(
      ` ${issueId.toUpperCase()} `,
      ` ${agentId.toUpperCase()} `,
      ` ${checkoutRunId.toUpperCase()} `,
    );
    expect(released?.id).toBe(issueId);
    expect(released?.status).toBe("todo");
    expect(released?.assigneeAgentId).toBeNull();
    expect(released?.checkoutRunId).toBeNull();
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

  it("returns unprocessable for malformed company ids on create", async () => {
    await expect(
      svc.create("not-a-uuid", {
        title: "Invalid company guard",
      } as any),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid companyId",
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
