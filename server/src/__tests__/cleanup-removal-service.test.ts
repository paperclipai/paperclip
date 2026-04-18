import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySkills,
  createDb,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueReadStates,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { companyService } from "../services/companies.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping cleanup removal service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("cleanup removal services", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cleanup-removal-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;

    await db.delete(activityLog);
    await db.delete(issueReadStates);
    await db.delete(issueComments);
    await db.delete(issueExecutionDecisions);
    await db.delete(companySkills);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
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
      title: "Regression fixture",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: "user-1",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "completed",
      contextSnapshot: { issueId },
    });

    return { agentId, companyId, issueId, runId };
  }

  it("removes agent-owned issue comments and run-linked activity before deleting the agent", async () => {
    const { agentId, companyId, issueId, runId } = await seedFixture();

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "Agent-authored comment",
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "heartbeat.completed",
      entityType: "issue",
      entityId: issueId,
      runId,
      details: {},
    });

    await db.insert(issueExecutionDecisions).values({
      id: randomUUID(),
      companyId,
      issueId,
      stageId: randomUUID(),
      stageType: "review",
      actorAgentId: agentId,
      outcome: "approved",
      body: "Looks good",
      createdByRunId: runId,
    });

    const removed = await agentService(db).remove(agentId);

    expect(removed?.id).toBe(agentId);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("removes issue read states and activity rows before deleting the company", async () => {
    const { companyId, issueId, runId } = await seedFixture();

    await db.insert(issueReadStates).values({
      id: randomUUID(),
      companyId,
      issueId,
      userId: "user-1",
    });

    await db.insert(companySkills).values({
      id: randomUUID(),
      companyId,
      key: "paperclipai/paperclip/paperclip",
      slug: "paperclip",
      name: "Paperclip",
      markdown: "# Paperclip",
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "system",
      actorId: "system",
      action: "run.created",
      entityType: "run",
      entityId: runId,
      runId,
      details: {},
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    expect(removed?.companyHomeCleanup).toMatchObject({
      removed: false,
      status: "missing",
    });
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueReadStates).where(eq(issueReadStates.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("removes the deleted company's managed company-home directory only", async () => {
    const { companyId, issueId } = await seedFixture();
    const activeCompanyId = randomUUID();
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-company-home-cleanup-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "cleanup-test";

    const companiesRoot = path.join(paperclipHome, "instances", "cleanup-test", "companies");
    const deletedCompanyHome = path.join(companiesRoot, companyId);
    const activeCompanyHome = path.join(companiesRoot, activeCompanyId);
    await fs.mkdir(path.join(deletedCompanyHome, "codex-home", "sessions"), { recursive: true });
    await fs.mkdir(path.join(deletedCompanyHome, "agents", "agent-1", "instructions"), { recursive: true });
    await fs.writeFile(path.join(deletedCompanyHome, "codex-home", "sessions", "session.jsonl"), "{}\n", "utf8");
    await fs.writeFile(path.join(deletedCompanyHome, "agents", "agent-1", "instructions", "AGENTS.md"), "# Agent\n", "utf8");
    await fs.mkdir(activeCompanyHome, { recursive: true });
    await fs.writeFile(path.join(activeCompanyHome, "keep.txt"), "active\n", "utf8");

    try {
      const removed = await companyService(db).remove(companyId);

      expect(removed?.id).toBe(companyId);
      expect(removed?.companyHomeCleanup).toMatchObject({
        path: deletedCompanyHome,
        removed: true,
        status: "removed",
      });
      await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
      await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toHaveLength(0);
      await expect(fs.lstat(deletedCompanyHome)).rejects.toThrow();
      await expect(fs.readFile(path.join(activeCompanyHome, "keep.txt"), "utf8")).resolves.toBe("active\n");
    } finally {
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
  });

  it("keeps deletion idempotent when managed company-home cleanup fails", async () => {
    const { companyId, issueId } = await seedFixture();
    const activeCompanyId = randomUUID();
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-company-home-cleanup-failure-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "cleanup-test";

    const companiesRoot = path.join(paperclipHome, "instances", "cleanup-test", "companies");
    const deletedCompanyHome = path.join(companiesRoot, companyId);
    const activeCompanyHome = path.join(companiesRoot, activeCompanyId);
    await fs.mkdir(path.join(deletedCompanyHome, "codex-home"), { recursive: true });
    await fs.writeFile(path.join(deletedCompanyHome, "codex-home", "session.jsonl"), "{}\n", "utf8");
    await fs.mkdir(activeCompanyHome, { recursive: true });
    await fs.writeFile(path.join(activeCompanyHome, "keep.txt"), "active\n", "utf8");

    const originalRm = fs.rm.bind(fs);
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === deletedCompanyHome) {
        throw new Error("simulated cleanup failure");
      }
      return originalRm(target, options);
    });

    try {
      const removed = await companyService(db).remove(companyId);

      expect(removed?.id).toBe(companyId);
      expect(removed?.companyHomeCleanup).toMatchObject({
        path: deletedCompanyHome,
        removed: false,
        status: "failed",
        error: "simulated cleanup failure",
      });
      await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
      await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toHaveLength(0);
      await expect(fs.readFile(path.join(deletedCompanyHome, "codex-home", "session.jsonl"), "utf8")).resolves.toBe("{}\n");
      await expect(fs.readFile(path.join(activeCompanyHome, "keep.txt"), "utf8")).resolves.toBe("active\n");
    } finally {
      rmSpy.mockRestore();
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
  });
});
