import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  instanceSettings,
  issueComments,
  issueInboxArchives,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
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
  let instance: EmbeddedPostgresInstance | null = null;
  try {
    const port = await getAvailablePort();
    const EmbeddedPostgres = await getEmbeddedPostgresCtor();
    instance = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "paperclip",
      password: "paperclip",
      port,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
      onLog: (msg) => {
        console.log(msg);
      },
      onError: (err) => {
        console.error(err);
      },
    });
    await instance.initialise();
    await instance.start();

    const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(connectionString);
    return { connectionString, dataDir, instance };
  } catch (err) {
    try {
      await instance?.stop();
    } catch {
      /* ignore stop errors during failed startup */
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
    throw err;
  }
}

const START_TEMP_DB_MAX_ATTEMPTS = 5;

async function startTempDatabaseWithRetries() {
  let lastError: unknown;
  let delayMs = 50;
  for (let attempt = 0; attempt < START_TEMP_DB_MAX_ATTEMPTS; attempt++) {
    try {
      return await startTempDatabase();
    } catch (err) {
      lastError = err;
      if (attempt < START_TEMP_DB_MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
        delayMs = Math.min(delayMs * 2, 800);
      }
    }
  }
  const msg =
    lastError instanceof Error
      ? lastError.message
      : String(lastError);
  throw new Error(
    `startTempDatabase failed after ${START_TEMP_DB_MAX_ATTEMPTS} attempts (getAvailablePort + embedded Postgres bind); last error: ${msg}`,
    { cause: lastError },
  );
}

describe("issueService.list participantAgentId", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    const started = await startTempDatabaseWithRetries();
    db = createDb(started.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
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
    let stopError: unknown;
    try {
      await instance?.stop();
    } catch (err) {
      stopError = err;
    } finally {
      if (dataDir) {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    }
    if (stopError !== undefined) {
      throw stopError;
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

  it("rejects creating an in_progress issue without checkout", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(
      svc.create(companyId, {
        title: "Bad direct in_progress create",
        status: "in_progress",
        priority: "medium",
      }),
    ).rejects.toThrow("Use POST /api/issues/:id/checkout to move an issue into in_progress.");
  });

  it("creates issue with workspace inheritance reference without throwing", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const parentIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace inheritance project",
      status: "planned",
    });

    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      sourceType: "local_path",
      isPrimary: true,
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId: workspaceId,
      title: "Parent issue",
      status: "todo",
      priority: "medium",
    });

    const created = await svc.create(companyId, {
      title: "Child with inherited workspace",
      status: "todo",
      priority: "medium",
      projectId,
      inheritExecutionWorkspaceFromIssueId: parentIssueId,
    });

    expect(created.projectWorkspaceId).toBe(workspaceId);
  });

  it("rejects moving an issue into in_progress without checkout", async () => {
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
      title: "Bad direct in_progress update",
      status: "todo",
      priority: "medium",
    });

    await expect(
      svc.update(issueId, { status: "in_progress" }),
    ).rejects.toThrow("Use POST /api/issues/:id/checkout to move an issue into in_progress.");
  });

  it("allows moving a claimed issue into in_progress", async () => {
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
      name: "Worker",
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
      title: "Claimed issue",
      status: "claimed",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const updated = await svc.update(issueId, { status: "in_progress" });
    expect(updated?.status).toBe("in_progress");
    expect(updated?.startedAt).toBeInstanceOf(Date);
  });

  it("rejects invalid review-state transitions", async () => {
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
      title: "Bad review transition",
      status: "technical_review",
      priority: "medium",
    });

    await expect(
      svc.update(issueId, { status: "done" }),
    ).rejects.toThrow("Invalid issue status transition: technical_review -> done");
  });

  it("rejects legacy in_review with an actionable migration hint", async () => {
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
      title: "Legacy review alias",
      status: "in_progress",
      priority: "medium",
    });

    await expect(
      svc.update(issueId, { status: "in_review" }),
    ).rejects.toThrow(
      "Unknown issue status: in_review. Legacy in_review was replaced by handoff_ready, technical_review, and human_review. Use handoff_ready to dispatch technical review.",
    );
  });

  it("rejects direct human_review moves with the staged review hint", async () => {
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
      name: "Worker",
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
      title: "Direct human review jump",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await expect(
      svc.update(issueId, { status: "human_review" }),
    ).rejects.toThrow(
      "Invalid issue status transition: in_progress -> human_review. Move the issue into handoff_ready first; Paperclip advances technical_review -> human_review after technical review is complete.",
    );
  });

  it("allows human_review issues to move back to technical_review", async () => {
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
      title: "Return from human review",
      status: "human_review",
      priority: "medium",
    });

    const updated = await svc.update(issueId, { status: "technical_review" });

    expect(updated?.status).toBe("technical_review");
  });

  it("allows reopening a cancelled issue back to todo", async () => {
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
      title: "Closed alert",
      status: "cancelled",
      priority: "medium",
      cancelledAt: new Date("2026-03-29T12:00:00.000Z"),
    });

    const reopened = await svc.update(issueId, { status: "todo" });

    expect(reopened?.status).toBe("todo");
    expect(reopened?.cancelledAt).toBeNull();
    expect(reopened?.completedAt).toBeNull();
  });

  it("surfaces the technical reviewer as current owner for handoff_ready issues", async () => {
    const companyId = randomUUID();
    const sourceAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const sourceIssueId = randomUUID();
    const reviewIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: sourceAgentId,
        companyId,
        name: "Executor",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerAgentId,
        companyId,
        name: "Revisor PR",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId,
        title: "Source issue",
        status: "handoff_ready",
        priority: "medium",
        assigneeAgentId: sourceAgentId,
      },
      {
        id: reviewIssueId,
        companyId,
        parentId: sourceIssueId,
        title: "Review issue",
        status: "technical_review",
        priority: "medium",
        assigneeAgentId: reviewerAgentId,
        originKind: "technical_review_dispatch",
      },
    ]);

    const issue = await svc.getById(sourceIssueId);

    expect(issue?.currentOwner).toEqual({
      actorType: "agent",
      role: "technical_reviewer",
      agentId: reviewerAgentId,
      userId: null,
      label: "Technical reviewer",
    });
  });

  it("surfaces board ownership for human_review issues without an explicit human assignee", async () => {
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
      title: "Awaiting human review",
      status: "human_review",
      priority: "medium",
    });

    const issue = await svc.getById(issueId);

    expect(issue?.currentOwner).toEqual({
      actorType: "board",
      role: "human_reviewer",
      agentId: null,
      userId: null,
      label: "Board",
    });
  });
});
