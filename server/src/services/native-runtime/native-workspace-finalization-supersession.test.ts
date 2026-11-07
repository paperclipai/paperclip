import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  workspaceOperations,
} from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { withNativeWorkspaceFinalizationOwnership } from "./native-workspace-finalization-ownership.js";
import { resumeNativeWorkspaceFinalization } from "./native-workspace-finalizer.js";

// RC-64: a crash loop killed the controller after it recorded a workspace
// finalize attempt as `running`. A later owner finalized the same run, and the
// orphaned attempt stayed `running` forever.
describe("superseded native workspace finalization attempts", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let workspaceRoot: string;
  let priorLogRoot: string | undefined;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-finalize-supersession-"));
    priorLogRoot = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = path.join(workspaceRoot, "operation-logs");
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_WORKSPACE_FINALIZER_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("paperclip-finalize-supersession-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6 });
    await db.insert(companies).values({ id: companyId, name: "Finalize supersession", issuePrefix: "FSS" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Finalize agent",
      adapterType: "paperclip_runner", status: "running" });
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    if (priorLogRoot === undefined) delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    else process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = priorLogRoot;
  });

  /** A succeeded native run with an accepted result and a dead controller's running finalize. */
  async function seedOrphanedFinalize(options: { cwdExists?: boolean; metadata?: Record<string, unknown> } = {}) {
    const issueId = randomUUID();
    const contractId = randomUUID();
    const runId = randomUUID();
    const resultId = randomUUID();
    const cwd = path.join(workspaceRoot, `orphan-${randomUUID()}`);
    if (options.cwdExists !== false) await fs.mkdir(cwd);
    await db.insert(issues).values({ id: issueId, companyId, title: "Crash-loop finalize", status: "in_progress",
      workMode: "standard", assigneeAgentId: agentId });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "finalize-supersession-test-v1",
      risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { objective: "finalize" }, canonicalSha256: `contract-${contractId}`,
      createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", runtimeMode: "native",
      nativeIssueId: issueId, completionContractId: contractId,
      runnerProfileJson: { nativeExecutionInput: { binding: { executionWorkspaceId: randomUUID() } } } });
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId, completionContractId: contractId,
      serverFingerprint: `result-${resultId}`, schemaStatus: "accepted", resultJson: {}, canonicalSha256: `result-${resultId}` });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "result_accepted", resultId });
    const startedAt = new Date(Date.now() - 60_000);
    const [orphan] = await db.insert(workspaceOperations).values({ companyId, heartbeatRunId: runId, issueId,
      phase: "workspace_finalize", status: "running", cwd, startedAt, createdAt: startedAt, updatedAt: startedAt,
      metadata: { owningService: "native_workspace_finalizer", observation: "workspace_directory",
        resumedFromOperationId: null, ...options.metadata },
    }).returning();
    return { issueId, runId, orphan };
  }

  const read = async (id: string) =>
    (await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, id)))[0]!;

  it("settles the orphan once a resumed attempt succeeds", async () => {
    const seeded = await seedOrphanedFinalize();
    const operation = await resumeNativeWorkspaceFinalization({ db, runId: seeded.runId });
    expect(operation).toMatchObject({ status: "succeeded",
      metadata: expect.objectContaining({ resumedFromOperationId: seeded.orphan.id }) });
    const orphan = await read(seeded.orphan.id);
    expect(orphan).toMatchObject({ status: "failed", finishedAt: expect.any(Date) });
    expect(orphan.metadata).toMatchObject({ owningService: "native_workspace_finalizer",
      supersededFinalization: { reason: "superseded_workspace_finalization", supersedingOperationId: operation!.id,
        supersedingStatus: "succeeded", previousStatus: "running" } });
    expect(await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, seeded.runId),
      eq(workspaceOperations.status, "running")))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, seeded.orphan.id),
      eq(activityLog.action, "workspace_operation.reconciled")))).toHaveLength(1);
  });

  it("settles the orphan when the resumed attempt itself fails", async () => {
    const seeded = await seedOrphanedFinalize({ cwdExists: false });
    const operation = await resumeNativeWorkspaceFinalization({ db, runId: seeded.runId });
    expect(operation?.status).toBe("failed");
    const orphan = await read(seeded.orphan.id);
    expect(orphan.status).toBe("failed");
    expect(orphan.metadata).toMatchObject({ supersededFinalization: {
      supersedingOperationId: operation!.id, supersedingStatus: "failed" } });
  });

  it("settles an orphan older than an already succeeded attempt", async () => {
    const seeded = await seedOrphanedFinalize();
    const [success] = await db.insert(workspaceOperations).values({ companyId, heartbeatRunId: seeded.runId,
      issueId: seeded.issueId, phase: "workspace_finalize", status: "succeeded", finishedAt: new Date(),
      metadata: { owningService: "native_workspace_finalizer", resumedFromOperationId: seeded.orphan.id } }).returning();
    const operation = await resumeNativeWorkspaceFinalization({ db, runId: seeded.runId });
    expect(operation?.id).toBe(success.id);
    const orphan = await read(seeded.orphan.id);
    expect(orphan.status).toBe("failed");
    expect(orphan.metadata).toMatchObject({ supersededFinalization: { supersedingOperationId: success.id } });
  });

  it("leaves a running attempt alone while another controller owns the run", async () => {
    const seeded = await seedOrphanedFinalize();
    const result = await withNativeWorkspaceFinalizationOwnership({ db, companyId, runId: seeded.runId },
      () => resumeNativeWorkspaceFinalization({ db, runId: seeded.runId }));
    expect(result).toEqual({ acquired: true, value: null });
    expect((await read(seeded.orphan.id)).status).toBe("running");
  });

  it("does not settle a running finalize recorded by another service", async () => {
    const seeded = await seedOrphanedFinalize({ metadata: { owningService: "heartbeat" } });
    expect((await resumeNativeWorkspaceFinalization({ db, runId: seeded.runId }))?.status).toBe("succeeded");
    expect((await read(seeded.orphan.id)).status).toBe("running");
  });

  it.each([
    ["saveWork", { saveWork: { requested: true } }],
    ["uncertain", { uncertain: true }],
  ])("keeps an attempt with an independent %s obligation running", async (_name, metadata) => {
    const seeded = await seedOrphanedFinalize({ metadata });
    expect((await resumeNativeWorkspaceFinalization({ db, runId: seeded.runId }))?.status).toBe("succeeded");
    expect((await read(seeded.orphan.id)).status).toBe("running");
  });
});
