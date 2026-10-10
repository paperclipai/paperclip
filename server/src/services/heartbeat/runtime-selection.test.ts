import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agents, companies, completionContracts, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { CHAT_CONTROL_RECOVERY_ADMISSION_KEY } from "../chat-control-recovery-stop.js";
import { buildNativeRuntimeContext } from "../native-runtime/runtime-context.js";
import { nativeRuntimeContextFixture } from "../native-runtime/runtime-context.test-fixture.js";
import { prepareNativeWorkspaceSync } from "../native-runtime/native-workspace-sync.js";
import { resolveHeartbeatNativeRuntimeMode } from "../native-runtime/runtime-mode.js";
import { canonicalNativeRuntimeContextDigest } from "../../vendor/paperclip-runner/index.js";
import { selectHeartbeatRuntime, type HeartbeatRuntimeSelectionInput } from "./runtime-selection.js";

// Keep the real contract, session, and runtime-selection transactions. Replace only
// filesystem materialization and sandbox synchronization at their external boundaries.
vi.mock("../native-runtime/runtime-context.js", async (original) => ({
  ...await original<typeof import("../native-runtime/runtime-context.js")>(),
  buildNativeRuntimeContext: vi.fn(async () => nativeRuntimeContextFixture()),
}));
vi.mock("../native-runtime/native-workspace-sync.js", async (original) => ({
  ...await original<typeof import("../native-runtime/native-workspace-sync.js")>(),
  prepareNativeWorkspaceSync: vi.fn(async () => null),
}));

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("heartbeat runtime selection boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let instructionRoot: string;
  beforeAll(async () => {
    instructionRoot = await mkdtemp(join(tmpdir(), "paperclip-selection-instructions-"));
    await writeFile(join(instructionRoot, "AGENTS.md"), "Complete the assigned task.\n");
    database = await startEmbeddedPostgresTestDatabase("paperclip-runtime-selection");
    db = createDb(database.connectionString);
    await db.execute(sql`set client_min_messages = warning`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); if (instructionRoot) await rm(instructionRoot, { recursive: true, force: true }); });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
    vi.clearAllMocks();
    vi.mocked(prepareNativeWorkspaceSync).mockResolvedValue(null);
    vi.mocked(buildNativeRuntimeContext).mockImplementation(async () => {
      const context = nativeRuntimeContextFixture();
      context.instructions.bundle.rootPath = instructionRoot;
      return { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) };
    });
  });

  async function fixture(adapterType = "paperclip_runner") {
    const [company] = await db.insert(companies).values({ name: "Runtime selection", issuePrefix: "SEL" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Selecting agent", status: "running", adapterType, adapterConfig: { provider: "codex", model: "gpt-5.6-luna" } }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Complete this task", description: "Preserve the requested work", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, scopeKind: "issue", status: "running" }).returning();
    const now = new Date();
    const input: HeartbeatRuntimeSelectionInput = {
      run, agent,
      nativeRuntimeResolution: resolveHeartbeatNativeRuntimeMode({ persisted: run, enabled: true, runtimeConfig: {}, adapterConfig: agent.adapterConfig, agent, issue, target: null, workspaceId: null }),
      task: { issueRef: issue, issueContext: null, context: { paperclipTaskMarkdown: "Complete this task" }, executionContinuation: null, safeWakeComments: [], safeWakeCommentContext: null, paperclipWakePayload: null, acceptedPlanContinuationWake: false },
      session: { persistedNativeExecutionInput: null, persistedRunnerProfile: {}, taskSessionCredentialCompatible: true, taskSessionDecodedParams: null, taskSessionForRun: null, isFailedChatRunRetry: false, getFreshSessionHandoff: vi.fn(async () => "Earlier context") },
      workspace: { persistedExecutionWorkspace: null, executionWorkspace: { cwd: "/tmp/paperclip-runtime-selection", repoUrl: null, repoRef: null, branchName: null }, executionTarget: null, isDotRun: false, projectRepositoryPaths: [],
        activeEnvironmentLease: { lease: { id: randomUUID(), companyId: company.id, environmentId: null, executionWorkspaceId: null, issueId: issue.id, heartbeatRunId: run.id, status: "active", leasePolicy: "ephemeral", provider: null, providerLeaseId: null, acquiredAt: now, lastUsedAt: now, expiresAt: null, releasedAt: null, failureReason: null, cleanupStatus: null, metadata: null, createdAt: now, updatedAt: now } },
      },
      config: { runtimeConfig: {}, runtimeSkillEntries: [], runScopedMentionedSkillKeys: [], instructionCopy: null, agentIdentity: undefined, issueAssigneeOverrides: null, resolvedConfig: {}, managedAiRuntime: undefined },
      recovery: {}, trace: { providerTraceRequested: false, providerTraceCapture: null },
      issuesSvc: { addComment: vi.fn() }, runtimeEnv: {}, onAdapterEvent: vi.fn(async () => {}),
      onNativeLifecycleSelected: vi.fn(), onProviderResourceDisposition: vi.fn(), onNativeOwnershipHeld: vi.fn(), stopControllerLease: vi.fn(),
    };
    return { input, issue, run, agent };
  }
  const read = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]!);
  const coordinators = (id: string) => db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, id));
  const sandbox = { kind: "remote" as const, transport: "sandbox" as const, remoteCwd: "/workspace", reusableLeaseConfigured: false };

  it("persists the native input, completion contract, and coordinator before transferring cleanup ownership", async () => {
    const { input, run } = await fixture();
    vi.mocked(prepareNativeWorkspaceSync).mockImplementationOnce(async args => {
      expect(await read(run.id)).toMatchObject({ runtimeMode: "native", nativeIssueId: input.task.issueRef!.id });
      expect(await coordinators(run.id)).toHaveLength(1);
      expect(input.stopControllerLease).toHaveBeenCalledOnce();
      expect(args).toMatchObject({ runId: run.id, workspaceId: run.id, workspaceLocalDir: input.workspace.executionWorkspace.cwd });
      return null;
    });
    const selected = await selectHeartbeatRuntime(db, input);
    expect(selected.selected).toBe(true);
    if (!selected.selected) throw new Error("Expected selection");
    const saved = await read(run.id);
    expect(saved).toMatchObject({ runtimeMode: "native", driverKind: "codex_app_server", nativePhase: "observed", nativeSessionId: expect.any(String), runnerInstanceId: selected.nativeRunnerInstanceId,
      runnerProfileJson: { nativeExecutionInput: selected.nativeExecution, recoveryEventInventoryVersion: 1 } });
    expect(await db.select().from(completionContracts)).toHaveLength(1);
    expect(selected.getNativeFreshSessionHandoff).toBe(input.session.getFreshSessionHandoff);
    expect(input.onNativeOwnershipHeld).not.toHaveBeenCalled();
  });

  it("persists configured GitHub instruction skills without admitting provider-mentioned skills", async () => {
    const { input, issue, run } = await fixture();
    input.config.runScopedMentionedSkillKeys = ["company/test/configured"];
    input.task.context.paperclipWake = {
      reason: "External chat message received", externalChatProvider: "github", checkedOutByHarness: true,
      issue: { id: issue.id, workMode: "standard" },
      comments: [{ id: "review-comment", body: "Please use /provider-mentioned" }],
      commentIds: ["review-comment"], latestCommentId: "review-comment",
      commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 }, fallbackFetchNeeded: false,
    };
    vi.mocked(buildNativeRuntimeContext).mockImplementationOnce(async () => {
      const context = nativeRuntimeContextFixture();
      context.instructions.bundle.rootPath = instructionRoot;
      context.skills = ["configured", "provider-mentioned"].map(name => ({
        key: `company/test/${name}`, runtimeName: name, versionId: null,
        bundle: { ...context.instructions.bundle },
      }));
      return { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) };
    });
    expect(await selectHeartbeatRuntime(db, input)).toMatchObject({
      selected: true, nativeExecution: { task: { description: "Configured GitHub instruction skills:\n/configured" } },
    });
    expect((await read(run.id)).runnerProfileJson).toMatchObject({
      nativeExecutionInput: { task: { description: "Configured GitHub instruction skills:\n/configured" } },
    });
  });

  it("restores the immutable admitted input and saved checkpoint when newer context arrives", async () => {
    const { input, run } = await fixture();
    const selected = await selectHeartbeatRuntime(db, input);
    if (!selected.selected || !selected.nativeExecution) throw new Error("Expected native selection");
    const saved = await read(run.id);
    const profile = { ...saved.runnerProfileJson, sessionCheckpoint: { retained: "checkpoint" } };
    await db.update(heartbeatRuns).set({ runnerProfileJson: profile }).where(eq(heartbeatRuns.id, run.id));
    input.run = await read(run.id);
    input.session.persistedRunnerProfile = profile;
    input.session.persistedNativeExecutionInput = selected.nativeExecution;
    input.task.context.paperclipTaskMarkdown = "A newer unrelated request";
    input.task.safeWakeComments = [{ id: randomUUID(), body: "New direction belongs to a separate wake" }];
    vi.mocked(buildNativeRuntimeContext).mockClear();
    const resumed = await selectHeartbeatRuntime(db, input);
    expect(resumed).toMatchObject({ selected: true, nativeExecution: selected.nativeExecution, nativeRunnerInstanceId: selected.nativeRunnerInstanceId });
    expect((await read(run.id)).runnerProfileJson).toMatchObject(profile);
    expect(await db.select().from(completionContracts)).toHaveLength(1);
    expect(await coordinators(run.id)).toHaveLength(1);
    expect(buildNativeRuntimeContext).not.toHaveBeenCalled();
  });

  it("rejects an admitted input bound to another run without replacing the saved runtime", async () => {
    const { input, run } = await fixture();
    const selected = await selectHeartbeatRuntime(db, input);
    if (!selected.selected || !selected.nativeExecution) throw new Error("Expected native selection");
    const saved = await read(run.id);
    input.run = saved;
    input.session.persistedNativeExecutionInput = { ...selected.nativeExecution, binding: { ...selected.nativeExecution.binding, runId: randomUUID() } };
    await expect(selectHeartbeatRuntime(db, input)).rejects.toThrow("native_execution_input_persisted_binding_mismatch");
    expect((await read(run.id)).runnerProfileJson).toEqual(saved.runnerProfileJson);
  });

  it.each(["cancelled", "startup_cancellation"])("does not create a native coordinator when %s wins preparation", async winner => {
    const { input, run } = await fixture();
    input.beforeNativeRuntimeSelection = async () => {
      await db.update(heartbeatRuns).set(winner === "cancelled" ? { status: "cancelled" } : { resultJson: { startupCancellation: { beforeNativeSelection: true } } }).where(eq(heartbeatRuns.id, run.id));
    };
    expect(await selectHeartbeatRuntime(db, input)).toEqual({ selected: false });
    expect(await read(run.id)).toMatchObject({ runtimeMode: "legacy", nativeSessionId: null, completionContractId: null });
    expect(await coordinators(run.id)).toHaveLength(0);
    expect(input.stopControllerLease).not.toHaveBeenCalled();
    expect(prepareNativeWorkspaceSync).not.toHaveBeenCalled();
  });

  it("reports a lost controller lease before returning without native selection", async () => {
    const { input, run } = await fixture();
    await db.update(heartbeatRuns).set({ controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, run.id));
    expect(await selectHeartbeatRuntime(db, input)).toEqual({ selected: false });
    expect(input.onNativeOwnershipHeld).toHaveBeenCalledOnce();
    expect(input.stopControllerLease).not.toHaveBeenCalled();
    expect(await coordinators(run.id)).toHaveLength(0);
  });

  it("rejects a competing persisted legacy selection atomically", async () => {
    const { input, run } = await fixture();
    input.beforeNativeRuntimeSelection = async () => {
      await db.update(heartbeatRuns).set({ runtimeModeResolvedAt: new Date(), runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, run.id));
    };
    await expect(selectHeartbeatRuntime(db, input)).rejects.toThrow("native_runtime_mode_conflict");
    expect((await read(run.id)).runtimeMode).toBe("legacy");
    expect(await coordinators(run.id)).toHaveLength(0);
    expect(input.stopControllerLease).not.toHaveBeenCalled();
  });

  it("reports sandbox teardown policy even when a later preparation step throws", async () => {
    const { input, run } = await fixture();
    input.workspace.executionTarget = sandbox;
    input.beforeNativeRuntimeSelection = async () => { throw new Error("selection interrupted"); };
    await expect(selectHeartbeatRuntime(db, input)).rejects.toThrow("selection interrupted");
    expect(input.onNativeLifecycleSelected).toHaveBeenCalledWith({ provider: "codex", harness: "codex_app_server", lifecycleMode: "per_turn", sandboxResource: "destroy_after_turn" });
    expect(input.onProviderResourceDisposition).toHaveBeenCalledWith("destroy");
    expect(input.stopControllerLease).not.toHaveBeenCalled();
    expect(await coordinators(run.id)).toHaveLength(0);
  });

  it("retains native admission and teardown state if workspace sync preparation fails", async () => {
    const { input, run } = await fixture();
    input.workspace.executionTarget = sandbox;
    vi.mocked(prepareNativeWorkspaceSync).mockRejectedValueOnce(new Error("sync preparation failed"));
    await expect(selectHeartbeatRuntime(db, input)).rejects.toThrow("sync preparation failed");
    expect(input.onProviderResourceDisposition).toHaveBeenCalledWith("destroy");
    expect(input.stopControllerLease).toHaveBeenCalledOnce();
    expect((await read(run.id)).runtimeMode).toBe("native");
    expect(await coordinators(run.id)).toHaveLength(1);
  });

  it("rejects a warm native sandbox that cannot reuse its lease", async () => {
    const { input, run } = await fixture();
    input.workspace.executionTarget = { ...sandbox, runnerLifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 } };
    await expect(selectHeartbeatRuntime(db, input)).rejects.toThrow("runner_warm_environment_requires_reusable_lease");
    expect(input.onNativeLifecycleSelected).not.toHaveBeenCalled();
    expect(await coordinators(run.id)).toHaveLength(0);
  });

  it("preserves only server-owned admission and dispatch evidence when recording legacy selection", async () => {
    const { input, run } = await fixture("process");
    const admission = { version: 1, kind: "fixture" }, dispatch = { entered: true };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { [CHAT_CONTROL_RECOVERY_ADMISSION_KEY]: admission, adapterDispatch: dispatch, unrelated: "drop" } }).where(eq(heartbeatRuns.id, run.id));
    input.trace = { providerTraceRequested: true, providerTraceCapture: { metadata: { id: "trace-id" } } };
    expect(await selectHeartbeatRuntime(db, input)).toMatchObject({ selected: true, nativeExecution: null, nativeWorkspaceSync: null });
    expect((await read(run.id)).runnerProfileJson).toEqual({ [CHAT_CONTROL_RECOVERY_ADMISSION_KEY]: admission, adapterDispatch: dispatch, providerTrace: { mode: "raw", traceId: "trace-id", maxBytes: 64 * 1024 * 1024 } });
    expect(await coordinators(run.id)).toHaveLength(0);
    expect(input.stopControllerLease).not.toHaveBeenCalled();
    expect(buildNativeRuntimeContext).not.toHaveBeenCalled();
  });
});
