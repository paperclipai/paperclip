import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { agentLifecycleCompanyDeletion } from "../modules/agent-lifecycle/company-deletion.js";
import { createAgentLifecycle, configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyPendingMigrations,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  chatEndpoints,
  chatConversations,
  chatPublications,
  chatDiscordCommandOwners,
  toolApplications,
  toolConnections,
  activityLog,
  agentApiKeys,
  agents,
  companies,
  companySkills,
  createDb,
  documents,
  documentRevisions,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueExecutionDecisions,
  issueReadStates,
  issues,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import { companyService } from "../services/companies.ts";
import { deleteCompany } from "../services/company-deletion.js";
import { createDurableRunLogStore } from "../services/run-log-store.js";

const cleanupWorkers = vi.hoisted(() => ({ enabled: false, active: 0, peak: 0, completed: 0 }));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const run = promisify(original.execFile);
  const execFile = Object.assign((...args: Parameters<typeof original.execFile>) => original.execFile(...args), {
    [promisify.custom]: async (...args: Parameters<typeof run>) => {
      if (!cleanupWorkers.enabled) return run(...args);
      cleanupWorkers.active++;
      cleanupWorkers.peak = Math.max(cleanupWorkers.peak, cleanupWorkers.active);
      try {
        return await run(...args);
      } finally {
        cleanupWorkers.active--;
        cleanupWorkers.completed++;
      }
    },
  });
  return { ...original, execFile };
});

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_CLEANUP_TEST_DATABASE_URL");
const embeddedPostgresSupport = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping cleanup removal service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("cleanup removal services", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!external) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cleanup-removal-");
    if (external) await applyPendingMigrations(external);
    db = createDb(external ?? tempDb!.connectionString);
    configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: async () => "complete" });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(agentApiKeys);
    vi.restoreAllMocks();
    await db.delete(chatEndpoints);
    await db.delete(chatDiscordCommandOwners);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(issueReadStates);
    await db.delete(issueComments);
    await db.delete(issueExecutionDecisions);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(companySkills);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
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

    await db.update(agents).set({ status: "terminated", lifecycleState: "terminated" }).where(eq(agents.id, agentId));
    const removed = await agentService(db).remove(agentId);

    expect(removed?.id).toBe(agentId);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("removes issue read states and activity rows before deleting the company", async () => {
    const { companyId, issueId, runId } = await seedFixture();
    const documentId = randomUUID();
    const revisionId = randomUUID();

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

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Run summary",
      latestBody: "body",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: null,
      createdByUserId: "user-1",
      updatedByAgentId: null,
      updatedByUserId: "user-1",
    });

    await db.insert(issueDocuments).values({
      id: randomUUID(),
      companyId,
      issueId,
      documentId,
      key: "summary",
    });

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Run summary",
      format: "markdown",
      body: "body",
      createdByAgentId: null,
      createdByUserId: "user-1",
      createdByRunId: runId,
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(companySkills).where(eq(companySkills.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(documents).where(eq(documents.id, documentId))).resolves.toHaveLength(0);
    await expect(db.select().from(documentRevisions).where(eq(documentRevisions.id, revisionId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueReadStates).where(eq(issueReadStates.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("removes heartbeat events by run id before deleting company-owned runs", async () => {
    const { agentId, companyId, runId } = await seedFixture();
    const otherCompanyId = randomUUID();

    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Company",
      issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(heartbeatRunEvents).values({
      companyId: otherCompanyId,
      runId,
      agentId,
      seq: 1,
      eventType: "output",
      message: "event with mismatched company scope",
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(companies).where(eq(companies.id, otherCompanyId))).resolves.toHaveLength(1);
  });

  it("removes routines before deleting company agents", async () => {
    const { agentId, companyId } = await seedFixture();
    const routineId = randomUUID();

    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Daily cleanup",
      assigneeAgentId: agentId,
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(routines).where(eq(routines.id, routineId))).resolves.toHaveLength(0);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
  });

  it("deletes managed files only when explicitly requested", async () => {
    const { companyId } = await seedFixture();
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
    const removeManagedFiles = vi.fn().mockResolvedValue(undefined);

    const removed = await companyService(db, { removeManagedFiles }).remove(companyId, {
      deleteFiles: true,
    });

    expect(removeManagedFiles).toHaveBeenCalledWith(companyId, [expect.any(String)]);
    expect(removed?.fileCleanup).toBe("succeeded");
  });

  it("drains only the archived company's runs before deleting managed files", async () => {
    const { companyId, runId } = await seedFixture();
    const other = await seedFixture();
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, other.runId));
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
    const order: string[] = [];
    const waitForRunExecutionDrain = vi.fn(async () => {
      order.push("drain");
    });
    const removeManagedFiles = vi.fn(async () => {
      order.push("cleanup");
    });

    const removed = await companyService(db, {
      removeManagedFiles,
      waitForRunExecutionDrain,
    }).remove(companyId, { deleteFiles: true });

    expect(waitForRunExecutionDrain).toHaveBeenCalledOnce();
    expect(waitForRunExecutionDrain).toHaveBeenCalledWith(runId);
    expect(order).toEqual(["drain", "cleanup"]);
    expect(removed?.fileCleanup).toBe("succeeded");
    const [otherRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, other.runId));
    expect(otherRun.status).toBe("running");
  });

  it("requires the company to be archived before deleting managed files", async () => {
    const { companyId } = await seedFixture();
    const removeManagedFiles = vi.fn().mockResolvedValue(undefined);

    await expect(
      companyService(db, { removeManagedFiles }).remove(companyId, { deleteFiles: true }),
    ).rejects.toThrow("Archive the company");

    expect(removeManagedFiles).not.toHaveBeenCalled();
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(1);
  });

  it("preserves company and agent state when draining fails", async () => {
    const { companyId, agentId } = await seedFixture();
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
    const before = await db.select().from(agents).where(eq(agents.id, agentId));
    const removeManagedFiles = vi.fn();
    const waitForRunExecutionDrain = vi.fn().mockRejectedValue(new Error("drain timeout"));

    await expect(
      companyService(db, { removeManagedFiles, waitForRunExecutionDrain })
        .remove(companyId, { deleteFiles: true }),
    ).rejects.toThrow("drain timeout");

    expect(removeManagedFiles).not.toHaveBeenCalled();
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(1);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toEqual(before);
  });

  it("rechecks archive status after draining before terminating agents", async () => {
    const { companyId, agentId } = await seedFixture();
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
    const before = await db.select().from(agents).where(eq(agents.id, agentId));
    const removeManagedFiles = vi.fn();
    const waitForRunExecutionDrain = vi.fn(async () => {
      await db.update(companies).set({ status: "active" }).where(eq(companies.id, companyId));
    });

    await expect(
      companyService(db, { removeManagedFiles, waitForRunExecutionDrain })
        .remove(companyId, { deleteFiles: true }),
    ).rejects.toThrow("Archive the company");

    expect(removeManagedFiles).not.toHaveBeenCalled();
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toEqual(before);
  });

  it("preserves agents and API keys when the locked deletion check rejects", async () => {
    const { companyId, agentId } = await seedFixture();
    await db.insert(agentApiKeys).values({ companyId, agentId, keyHash: randomUUID(), name: "Deletion test" });
    const before = await db.select().from(agents).where(eq(agents.id, agentId));
    const keysBefore = await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, agentId));

    await expect(deleteCompany(db, companyId, async () => {
      throw new Error("Deletion rejected");
    })).rejects.toThrow("Deletion rejected");

    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toEqual(before);
    await expect(db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, agentId))).resolves.toEqual(keysBefore);
  });

  it("serializes unarchive with deletion on a one-connection pool without blocking another company", async () => {
    const { companyId } = await seedFixture();
    const other = await seedFixture();
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
    let stopping!: () => void;
    const stopStarted = new Promise<void>((resolve) => { stopping = resolve; });
    let release!: () => void;
    const continueDeletion = new Promise<void>((resolve) => { release = resolve; });
    const singleConnectionDb = createDb(external ?? tempDb!.connectionString, { maxConnections: 1 });
    configureAgentLifecycle(singleConnectionDb, {
      requiredPluginIds: async () => [],
      runPlugin: async () => "complete",
      runHost: async (agent) => {
        if (agent.companyId === companyId) {
          stopping();
          await continueDeletion;
        }
        return "complete";
      },
    });
    const deletion = companyService(singleConnectionDb, { removeManagedFiles: async () => {} })
      .remove(companyId, { deleteFiles: true });
    await stopStarted;
    let reactivated = false;
    const reactivation = companyService(singleConnectionDb).update(companyId, { status: "active" }).then((result) => {
      reactivated = true;
      return result;
    });
    try {
      await expect(companyService(singleConnectionDb).update(other.companyId, { status: "paused" }))
        .resolves.toMatchObject({ status: "paused" });
      expect(reactivated).toBe(false);
    } finally {
      release();
    }
    await expect(deletion).resolves.toMatchObject({ id: companyId, fileCleanup: "succeeded" });
    await expect(reactivation).resolves.toBeNull();
    await singleConnectionDb.$client.end({ timeout: 1 });
  });

  it("deletes safely when the application pool has only one connection", async () => {
    const { companyId } = await seedFixture();
    const singleConnectionDb = createDb(external ?? tempDb!.connectionString, { maxConnections: 1 });
    configureAgentLifecycle(singleConnectionDb, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: async () => "complete" });
    try {
      await expect(companyService(singleConnectionDb).remove(companyId))
        .resolves.toMatchObject({ id: companyId });
    } finally {
      await singleConnectionDb.$client.end();
    }
  });

  it.each(["companies", "projects", "skills", "workspaces", "data", "custom-logs", "custom-storage"])(
    "rejects a symlinked %s cleanup directory and preserves external files",
    async (kind) => {
      const { companyId, agentId } = await seedFixture();
      const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-cleanup-symlink-"));
      vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
      vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
      vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(root, "custom-storage"));
      if (kind === "custom-logs") vi.stubEnv("RUN_LOG_BASE_PATH", path.join(root, kind));
      const instance = resolvePaperclipInstanceRoot();
      const outside = path.join(root, "outside");
      const id = kind === "workspaces" ? agentId : companyId;
      const protectedDir = path.join(outside, kind === "data" ? "run-logs" : "", id);
      try {
        await mkdir(protectedDir, { recursive: true });
        await writeFile(path.join(protectedDir, "sentinel"), "keep");
        const link = kind.startsWith("custom-") ? path.join(root, kind) : path.join(instance, kind);
        await mkdir(path.dirname(link), { recursive: true });
        await symlink(outside, link, "dir");
        await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));

        await expect(companyService(db).remove(companyId, { deleteFiles: true }))
          .resolves.toMatchObject({ fileCleanup: "failed" });
        expect(await readFile(path.join(protectedDir, "sentinel"), "utf8")).toBe("keep");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["before", "after"])("keeps cleanup safe when a parent is replaced %s traversal", async (timing) => {
    const { companyId } = await seedFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-cleanup-swap-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    const parent = path.join(resolvePaperclipInstanceRoot(), "projects");
    const moved = path.join(root, "moved-projects");
    const outside = path.join(root, "outside");
    const preload = path.join(root, "swap.cjs");
    try {
      await mkdir(path.join(parent, companyId), { recursive: true });
      await mkdir(path.join(outside, companyId), { recursive: true });
      await writeFile(path.join(outside, companyId, "sentinel"), "keep");
      await writeFile(preload, `const fs = require("node:fs");
const original = process.chdir.bind(process);
process.chdir = (directory) => {
  if (${JSON.stringify(timing)} === "after") original(directory);
  if (directory === "projects") {
    fs.renameSync(${JSON.stringify(parent)}, ${JSON.stringify(moved)});
    fs.symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(parent)}, "dir");
  }
  if (${JSON.stringify(timing)} === "before") original(directory);
};`);
      vi.stubEnv("NODE_OPTIONS", `${process.env.NODE_OPTIONS ?? ""} --require=${preload}`);
      await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
      await expect(companyService(db).remove(companyId, { deleteFiles: true }))
        .resolves.toMatchObject({ fileCleanup: timing === "before" ? "failed" : "succeeded" });
      expect(await readFile(path.join(outside, companyId, "sentinel"), "utf8")).toBe("keep");
      if (timing === "after") {
        await expect(access(path.join(moved, companyId))).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(access(path.join(moved, companyId))).resolves.toBeUndefined();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unlinks a managed leaf symlink without deleting its external contents", async () => {
    const { companyId } = await seedFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-cleanup-leaf-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    const outside = path.join(root, "outside");
    const parent = path.join(resolvePaperclipInstanceRoot(), "projects");
    try {
      await mkdir(outside, { recursive: true });
      await writeFile(path.join(outside, "sentinel"), "keep");
      await mkdir(parent, { recursive: true });
      await symlink(outside, path.join(parent, companyId), "dir");
      await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
      await expect(companyService(db).remove(companyId, { deleteFiles: true }))
        .resolves.toMatchObject({ fileCleanup: "succeeded" });
      expect(await readFile(path.join(outside, "sentinel"), "utf8")).toBe("keep");
      await expect(access(path.join(parent, companyId))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes the actual custom run logs and preserves another company's logs", async () => {
    const { companyId, agentId, runId } = await seedFixture();
    const other = await seedFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-cleanup-files-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("RUN_LOG_BASE_PATH", path.join(root, "custom-logs"));
    try {
      const workspace = resolveDefaultAgentWorkspaceDir(agentId);
      const otherWorkspace = resolveDefaultAgentWorkspaceDir(other.agentId);
      await mkdir(workspace, { recursive: true });
      await mkdir(otherWorkspace, { recursive: true });
      const store = createDurableRunLogStore({ basePath: path.join(root, "custom-logs") });
      const log = await store.begin({ companyId, agentId, runId });
      await store.append(log, { stream: "stdout", chunk: "test", ts: new Date().toISOString() });
      await store.finalize(log);
      const otherLog = await store.begin({ companyId: other.companyId, agentId: other.agentId, runId: other.runId });
      await store.finalize(otherLog);
      await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));

      await expect(companyService(db).remove(companyId, { deleteFiles: true }))
        .resolves.toMatchObject({ fileCleanup: "succeeded" });

      await expect(access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(otherWorkspace)).resolves.toBeUndefined();
      await expect(access(path.join(root, "custom-logs", companyId))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(path.join(root, "custom-logs", other.companyId))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects managed-file deletion while archived company runs are active", async () => {
    const { companyId, runId } = await seedFixture();
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, runId));
    const removeManagedFiles = vi.fn().mockResolvedValue(undefined);

    await expect(
      companyService(db, { removeManagedFiles }).remove(companyId, { deleteFiles: true }),
    ).rejects.toThrow("Wait for company runs");

    expect(removeManagedFiles).not.toHaveBeenCalled();
  });

  it("rejects managed-file deletion while an archived company retry is scheduled", async () => {
    const { companyId, runId } = await seedFixture();
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
    await db
      .update(heartbeatRuns)
      .set({ status: "scheduled_retry", scheduledRetryAt: new Date(Date.now() + 60_000) })
      .where(eq(heartbeatRuns.id, runId));
    const removeManagedFiles = vi.fn().mockResolvedValue(undefined);

    await expect(
      companyService(db, { removeManagedFiles }).remove(companyId, { deleteFiles: true }),
    ).rejects.toThrow("Wait for company runs");

    expect(removeManagedFiles).not.toHaveBeenCalled();
  });

  it("does not delete managed files by default", async () => {
    const { companyId } = await seedFixture();
    const removeManagedFiles = vi.fn().mockResolvedValue(undefined);

    const removed = await companyService(db, { removeManagedFiles }).remove(companyId);

    expect(removeManagedFiles).not.toHaveBeenCalled();
    expect(removed?.fileCleanup).toBe("not_requested");
  });

  it.each([false, true])("bounds real cleanup workers and finishes remaining targets after failure=%s", async (fail) => {
    const { companyId, agentId } = await seedFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-cleanup-workers-"));
    vi.stubEnv("PAPERCLIP_HOME", root);
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(root, "storage"));
    const extraAgentIds = Array.from({ length: 12 }, () => randomUUID());
    await db.insert(agents).values(extraAgentIds.map((id) => ({
      id, companyId, name: id, role: "engineer", status: "active", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: {}, permissions: {},
    })));
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
    const workspaces = [agentId, ...extraAgentIds].map(resolveDefaultAgentWorkspaceDir);
    try {
      for (const workspace of workspaces) await mkdir(workspace, { recursive: true });
      if (fail) {
        const outside = path.join(root, "outside");
        await mkdir(outside);
        await writeFile(path.join(outside, "sentinel"), "keep");
        await rm(path.dirname(workspaces[0]), { recursive: true, force: true });
        await symlink(outside, path.dirname(workspaces[0]), "dir");
      }
      Object.assign(cleanupWorkers, { enabled: true, active: 0, peak: 0, completed: 0 });
      const removed = await companyService(db).remove(companyId, { deleteFiles: true });
      expect(removed?.fileCleanup).toBe(fail ? "failed" : "succeeded");
      expect(cleanupWorkers.peak).toBeGreaterThan(1);
      expect(cleanupWorkers.peak).toBeLessThanOrEqual(4);
      expect(cleanupWorkers.active).toBe(0);
      expect(cleanupWorkers.completed).toBe(workspaces.length + 5);
      if (fail) expect(await readFile(path.join(root, "outside", "sentinel"), "utf8")).toBe("keep");
      else for (const workspace of workspaces) await expect(access(workspace)).rejects.toThrow();
    } finally {
      cleanupWorkers.enabled = false;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports cleanup failure after completing database deletion", async () => {
    const { companyId } = await seedFixture();
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
    const removeManagedFiles = vi.fn().mockRejectedValue(new Error("permission denied"));

    const removed = await companyService(db, { removeManagedFiles }).remove(companyId, {
      deleteFiles: true,
    });

    expect(removed?.fileCleanup).toBe("failed");
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
  });
  async function seedEndpoint(companyId: string, agentId: string, issueId: string) {
    const [app] = await db.insert(toolApplications).values({ companyId, name: "Discord", type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId, applicationId: app.id, uid: randomUUID(), name: "Discord", transport: "chat_sdk", connectionPurpose: "channel",
    }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({
      companyId, connectionId: connection.id, provider: "discord", publicId: randomUUID(), assignedAgentId: agentId,
    }).returning();
    const [conversation] = await db.insert(chatConversations).values({
      companyId, endpointId: endpoint.id, issueId, externalConversationId: randomUUID(), externalLabel: "Saved chat",
    }).returning();
    await db.insert(chatPublications).values({
      companyId, endpointId: endpoint.id, conversationId: conversation.id, issueId,
      idempotencyKey: randomUUID(), payload: { text: "Saved response" }, state: "published",
    });
    return endpoint;
  }

  it("deletes company endpoints before their agents while preserving other companies and ownership tombstones", async () => {
    const first = await seedFixture(), second = await seedFixture();
    const endpoint = await seedEndpoint(first.companyId, first.agentId, first.issueId);
    const other = await seedEndpoint(second.companyId, second.agentId, second.issueId);
    const [owner] = await db.insert(chatDiscordCommandOwners).values({
      applicationId: String(1_400_000_000_000_000_000n + BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 12))),
      companyId: first.companyId, endpointId: endpoint.id, actionId: randomUUID(),
    }).returning();
    await companyService(db).remove(first.companyId);
    expect(await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id))).toEqual([]);
    expect(await db.select().from(chatConversations).where(eq(chatConversations.companyId, first.companyId))).toEqual([]);
    expect(await db.select().from(chatPublications).where(eq(chatPublications.companyId, first.companyId))).toEqual([]);
    expect(await db.select().from(agents).where(eq(agents.companyId, first.companyId))).toEqual([]);
    expect(await db.select().from(companies).where(eq(companies.id, first.companyId))).toEqual([]);
    expect(await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, other.id))).toEqual([other]);
    expect(await db.select().from(chatDiscordCommandOwners).where(eq(chatDiscordCommandOwners.applicationId, owner.applicationId))).toEqual([owner]);
  });

  it("rolls back endpoint cleanup when the later agent deletion fails", async () => {
    const f = await seedFixture();
    const endpoint = await seedEndpoint(f.companyId, f.agentId, f.issueId);
    vi.spyOn(agentLifecycleCompanyDeletion, "deleteCompanyData").mockImplementationOnce(async tx => {
      expect(await tx.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id))).toEqual([]);
      throw new Error("agent deletion failed");
    });
    await expect(companyService(db).remove(f.companyId)).rejects.toThrow("agent deletion failed");
    expect(await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id))).toEqual([endpoint]);
    expect(await db.select().from(chatConversations).where(eq(chatConversations.endpointId, endpoint.id))).toHaveLength(1);
    expect(await db.select().from(chatPublications).where(eq(chatPublications.endpointId, endpoint.id))).toHaveLength(1);
    expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(1);
    expect(await db.select().from(agents).where(eq(agents.id, f.agentId))).toHaveLength(1);
  });

});
