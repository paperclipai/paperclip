import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { S3Client, CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { agents, authUsers, companies, companyMemberships, createDb, closeRegisteredClients, environmentLeases,
  environments, executionWorkspaces, heartbeatRuns, agentWakeupRequests, issues, issueWorkProducts, nativeRunResults } from "@paperclipai/db";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { NativeExecutionInput, NativeSession, NativeSessionBackend, PrpEvent } from "@paperclipai/paperclip-runner";
import type { EnvironmentLease } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createIsolatedTestHome } from "./helpers/isolated-test-home.js";
import { heartbeatService, startTaskDrain, stopTaskDrain } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import * as environmentTarget from "../services/environment-execution-target.js";
import { migrateEphemeralServerData } from "../maintenance/ephemeral-migration-data.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { materializeInstructionBytes } from "../services/agent-instruction-files.js";
import { flushInFlightRunLogMirrors } from "../services/run-log-store.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";

vi.mock("@paperclipai/adapter-utils/execution-target", async importOriginal => ({
  ...await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>(),
  // The scripted session makes no sandbox-to-host API calls.
  startAdapterExecutionTargetPaperclipBridge: async () => null,
}));

// Real database, migration, object storage, queue claim, workspace restoration,
// instruction materialization and result settlement. Only the sandbox transport
// and provider session are scripted; neither can read the deleted predecessor.
describe.skipIf(!process.env.PAPERCLIP_TEST_S3_ENDPOINT)("queued turn after preserving offline enrollment", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>, root: string, bucket: string, s3: S3Client;
  let home: ReturnType<typeof createIsolatedTestHome>;
  let replacement: ReturnType<typeof heartbeatService> | undefined;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("queued-enrollment-");
    db = createDb(database.connectionString);
    home = createIsolatedTestHome(); root = await fs.realpath(home.home);
    bucket = `queued-enrollment-${randomUUID()}`;
    s3 = new S3Client({ endpoint: process.env.PAPERCLIP_TEST_S3_ENDPOINT, region: "us-east-1", forcePathStyle: true });
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    vi.stubEnv("DATABASE_URL", database.connectionString);
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "predecessor"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "74".repeat(32));
    vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
    vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "false");
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "s3");
    vi.stubEnv("PAPERCLIP_STORAGE_S3_BUCKET", bucket);
    vi.stubEnv("PAPERCLIP_STORAGE_S3_REGION", "us-east-1");
    vi.stubEnv("PAPERCLIP_STORAGE_S3_ENDPOINT", process.env.PAPERCLIP_TEST_S3_ENDPOINT!);
    vi.stubEnv("PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE", "true");
  }, 90_000);
  afterAll(async () => {
    stopTaskDrain();
    await replacement?.drainActiveRunExecutions();
    await flushInFlightRunLogMirrors();
    vi.restoreAllMocks();
    if (database) await closeRegisteredClients(database.connectionString, { scope: "database" });
    await database?.cleanup();
    if (s3) {
      for (;;) {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
        if (!page.Contents?.length) break;
        await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: page.Contents.map(row => ({ Key: row.Key! })) } }));
      }
      await s3.send(new DeleteBucketCommand({ Bucket: bucket })); s3.destroy();
    }
    home?.cleanup();
    vi.unstubAllEnvs();
  });

  it("admits the original queued run once and reads its saved workspace and instructions without the old disk", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
    const workProductId = randomUUID(), evidenceRef = `work_product:${workProductId}`;
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true, enableIsolatedWorkspaces: true });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Queued enrollment", issuePrefix: "QEM", defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    const [environment] = await db.insert(environments).values({ name: `Scripted sandbox ${companyId}`, driver: "sandbox",
      status: "active", config: { provider: "daytona" } }).returning();
    const instructions = "Preserved instructions: read saved.txt before completing this turn.";
    const instructionsRoot = resolveManagedInstructionsRoot({ id: agentId, companyId, name: "Queued worker", adapterConfig: {} });
    await materializeInstructionBytes(instructionsRoot, "AGENTS.md", Buffer.from(instructions));
    await db.insert(agents).values({ id: agentId, companyId, name: "Queued worker", adapterType: "paperclip_runner", status: "idle",
      defaultEnvironmentId: environment.id, adapterConfig: { provider: "codex", instructionsBundleMode: "managed", instructionsRootPath: instructionsRoot },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue saved work", issueNumber: 1, identifier: "QEM-1",
      status: "todo", assigneeAgentId: agentId, responsibleUserId: userId, executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" } });
    const oldHome = process.env.PAPERCLIP_HOME!, cwd = path.join(oldHome, "task");
    await fs.mkdir(cwd, { recursive: true }); await fs.writeFile(path.join(cwd, "saved.txt"), "unfinished work before migration");
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, sourceIssueId: issueId, name: "Saved task",
      mode: "isolated_workspace", strategyType: "project_primary", providerType: "local_fs", cwd }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, issueId));
    await db.insert(issueWorkProducts).values({ id: workProductId, companyId, issueId, type: "artifact", provider: "paperclip",
      title: "Migration fixture evidence", status: "ready_for_review", reviewState: "approved" });
    const predecessor = heartbeatService(db);
    startTaskDrain({});
    await predecessor.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
      requestedByActorType: "user", requestedByActorId: userId, payload: { issueId }, contextSnapshot: { issueId, skipIssueComment: true } });
    await predecessor.drainActiveRunExecutions();
    const [queued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(queued).toMatchObject({ status: "queued", startedAt: null, wakeupRequestId: wake.id });
    expect(wake.status).toBe("queued");
    expect(await migrateEphemeralServerData(db, { signal: AbortSignal.timeout(60_000), phase: () => {} }))
      .toMatchObject({ eligibility: { eligible: true }, counts: { workspaces: 1 } });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id)))[0]).toEqual(queued);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0]).toEqual(wake);
    await fs.rm(oldHome, { recursive: true });
    await expect(fs.stat(oldHome)).rejects.toMatchObject({ code: "ENOENT" });
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "replacement"));
    vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "false");

    const remoteCwd = path.join(root, "independent-sandbox"); await fs.mkdir(remoteCwd);
    const exec = promisify(execFile);
    const transfer: NonNullable<CommandManagedRuntimeRunner["syncIn"]> = async operations => {
      const results = [];
      for (const operation of operations) {
        for (const file of operation.files) {
          await fs.mkdir(path.dirname(file.targetPath), { recursive: true });
          await fs.cp(file.sourcePath, file.targetPath, { recursive: file.kind === "directory" });
        }
        results.push({ operationId: operation.operationId, filesTransferred: operation.files.length, bytesTransferred: 0 });
      }
      return { operations: results };
    };
    const runner: CommandManagedRuntimeRunner = { syncIn: transfer, syncOut: transfer, execute: async input => {
      const command = exec(input.command, input.args ?? [], { cwd: input.cwd ?? remoteCwd, env: { ...process.env, ...input.env },
        timeout: input.timeoutMs, maxBuffer: 4 * 1024 * 1024 });
      command.child.stdin?.end(input.stdin ?? "");
      const result = await command;
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, signal: null, timedOut: false, pid: process.pid, startedAt: new Date().toISOString() };
    } };
    vi.spyOn(environmentTarget, "resolveEnvironmentExecutionTarget").mockImplementation(async input => ({
      kind: "remote", transport: "sandbox", remoteCwd: typeof input.leaseMetadata?.remoteCwd === "string" ? input.leaseMetadata.remoteCwd : remoteCwd,
      runner, provider: "daytona", leaseId: input.leaseId, sandboxId: `fixture-${queued.id}`, timeoutMs: 60_000,
    }) as AdapterExecutionTarget);
    const runtime = environmentRuntimeService(db);
    vi.spyOn(runtime, "acquireRunLease").mockImplementation(async input => {
      const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId: environment.id, heartbeatRunId: input.heartbeatRunId,
        issueId, executionWorkspaceId: workspace.id, provider: "daytona", providerLeaseId: `fixture-${queued.id}`, status: "active", metadata: { remoteCwd } }).returning();
      return { environment: input.environment, lease: lease as EnvironmentLease,
        leaseContext: { executionWorkspaceId: workspace.id, executionWorkspaceMode: "isolated_workspace" } };
    });
    // The scripted provider owns no external allocation. Retain its directory
    // until after the normal native workspace finalizer has completed.
    vi.spyOn(runtime, "releaseRunLeases").mockResolvedValue([]);
    const startTurn = vi.fn();
    const backendFactory = (execution: NativeExecutionInput): NativeSessionBackend => {
      const turnId = `turn-${queued.id}`;
      const identity = { companyId, agentId, issueId, runId: queued.id, sessionId: execution.session.normalizedSessionId! };
      const result = structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT);
      result.completionClaim.contractRevision = execution.completionContract.contract.revision;
      result.completionClaim.criteria = execution.completionContract.contract.criteria.map(criterion => ({
        ...result.completionClaim.criteria[0]!, criterionId: criterion.id, evidenceRefs: [evidenceRef],
      }));
      result.evidence = [{ kind: "work_product", ref: evidenceRef }]; result.verification[0]!.artifactRef = evidenceRef;
      let started!: () => void;
      const turnStarted = new Promise<void>(resolve => { started = resolve; });
      const session: NativeSession = {
        identity: () => identity,
        async capabilities() { return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true }; },
        async *events() {
          await turnStarted;
          const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id));
          yield { schema: "paperclip.prp.event.v1", sourceEventId: `${queued.id}:terminal`, sourceSeq: 1, sourceInstanceId: run.runnerInstanceId!,
            sourceKind: "runner", runId: queued.id, normalizedSessionId: identity.sessionId, turnId, eventType: "turn.completed",
            schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), payload: {} } satisfies PrpEvent;
        },
        async startTurn(input) {
          expect(execution.binding.runId).toBe(queued.id);
          expect(execution.workspace.cwd).toBeTruthy();
          expect(await fs.readFile(path.join(execution.workspace.cwd!, "saved.txt"), "utf8")).toBe("unfinished work before migration");
          if (!("runtimeContext" in execution)) throw new Error("Expected native runtime context");
          const bundle = execution.runtimeContext.instructions;
          const instructionPath = path.join(bundle.bundle.rootPath, bundle.entryPath);
          expect(instructionPath.startsWith(`${oldHome}/`)).toBe(false);
          expect(await fs.readFile(instructionPath, "utf8")).toBe(instructions);
          await expect(fs.stat(path.join(cwd, "saved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
          startTurn(input); started(); return { turnId };
        },
        async result() { await turnStarted; return { result, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, turnId }; },
        async snapshot() { return { backendKind: "mock", sessionId: "queued-migration", identity, providerSessionId: "queued-migration",
          activeTurnId: null, pendingRuntimeRequests: [], lineage: [], cursor: "1" }; },
        async close() {},
      };
      return { async descriptor() { return { kind: "mock", name: "queued-migration", version: "1",
        capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }; },
      async openSession() { return session; } };
    };
    replacement = heartbeatService(db, { environmentRuntime: runtime, nativeSessionBackendFactory: backendFactory });
    stopTaskDrain();
    await replacement.resumeQueuedRunsAfterDrain(); await replacement.drainActiveRunExecutions();
    const finished = await replacement.getRun(queued.id);
    expect(finished?.status, JSON.stringify({ errorCode: finished?.errorCode, error: finished?.error, result: finished?.resultJson })).toBe("succeeded");
    expect(finished?.wakeupRequestId).toBe(wake.id);
    await replacement.resumeQueuedRunsAfterDrain(); await replacement.drainActiveRunExecutions();
    expect(startTurn).toHaveBeenCalledOnce();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, queued.id))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)))
      .toEqual([expect.objectContaining({ id: wake.id, status: "completed", runId: queued.id,
        claimedAt: expect.any(Date), finishedAt: expect.any(Date), payload: wake.payload })]);
  }, 120_000);
});
