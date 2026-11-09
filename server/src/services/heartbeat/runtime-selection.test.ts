import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityLog, agents, authUsers, companyMemberships, companySkillRepositorySnapshots, principalPermissionGrants, environments, environmentLeases, companies, completionContracts, costEvents, createDb, applyPendingMigrations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations, workspaceOperations, type Db } from "@paperclipai/db";
import { accountRunCost } from "../run-cost-accounting.js";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { CHAT_CONTROL_RECOVERY_ADMISSION_KEY } from "../chat-control-recovery-stop.js";
import { buildNativeRuntimeContext, materializeSelectedSkills, rehydratePinnedSkillAssets } from "../native-runtime/runtime-context.js";
import { applyConnectorSkills } from "../connector-runtime.js";
import * as storageModule from "../../storage/index.js";
import { createStorageService } from "../../storage/service.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { readRuntimeSkillPreservation } from "../native-runtime/runtime-skill-preservation-reference.js";
import { hasLocalRuntimeSkillObligations } from "../native-runtime/runtime-skill-preservation.js";
import * as runtimeSkillPreservation from "../native-runtime/runtime-skill-preservation.js";
import { removeRuntimeAssetTree } from "../native-runtime/runtime-asset-retention.js";
import { nativeRuntimeContextFixture } from "../native-runtime/runtime-context.test-fixture.js";
import { prepareNativeWorkspaceSync } from "../native-runtime/native-workspace-sync.js";
import { resolveHeartbeatNativeRuntimeMode } from "../native-runtime/runtime-mode.js";
import { claimNativeRestartRecoveries } from "../native-runtime/native-restart-recovery.js";
import { buildNativeModelEnvelope, canonicalNativeRuntimeContextDigest } from "../../vendor/paperclip-runner/index.js";
import { prepareAndSelectHeartbeatRuntime, selectHeartbeatRuntime, type HeartbeatRuntimeSelectionInput } from "./runtime-selection.js";
import { reserveRunBudget } from "../budget-reservations.js";
import { legacyControllerClaim } from "../legacy-controller-lease.js";
import { agentInstructionWorkingCopyService } from "../agent-instruction-working-copies.js";
import { createHeartbeatInstructionWorkingCopy } from "./instruction-working-copy.js";
import { environmentService } from "../environments.js";

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

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RUNTIME_SELECTION_TEST_DATABASE_URL");
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("heartbeat runtime selection boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let instructionRoot: string;
  beforeAll(async () => {
    instructionRoot = await mkdtemp(join(tmpdir(), "paperclip-selection-instructions-"));
    await writeFile(join(instructionRoot, "AGENTS.md"), "Complete the assigned task.\n");
    if (externalDatabaseUrl) await applyPendingMigrations(externalDatabaseUrl);
    database = externalDatabaseUrl ? { connectionString: externalDatabaseUrl, cleanup: async () => {} }
      : await startEmbeddedPostgresTestDatabase("paperclip-runtime-selection");
    db = createDb(database.connectionString);
    await db.execute(sql`set client_min_messages = warning`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); if (instructionRoot) await rm(instructionRoot, { recursive: true, force: true }); });
  afterEach(() => vi.unstubAllEnvs());
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

  it("rejects invalid local Runner configuration before native authority and retains the preparation owner", async () => {
    const f = await fixture();
    await claimPreparation(f);
    vi.stubEnv("PAPERCLIP_RUNNER_BINARY", "relative-invalid-dot-retry-controller");
    f.input.runtimeEnv = { PAPERCLIP_RUNNER_BINARY: join(tmpdir(), "ignored-injected-runnerd") };
    const before = await read(f.run.id);
    await expect(selectHeartbeatRuntime(db, f.input)).rejects.toThrow("PAPERCLIP_RUNNER_BINARY must be an absolute path");
    expect(await read(f.run.id)).toEqual(before);
    expect(await coordinators(f.run.id)).toEqual([]);
    expect(await db.select().from(completionContracts)).toHaveLength(0);
    expect(f.input.stopControllerLease).not.toHaveBeenCalled();
    expect(buildNativeRuntimeContext).not.toHaveBeenCalled();
  });

  it("ignores an injected runtime Runner value that the local backend does not consume", async () => {
    const f = await fixture();
    vi.stubEnv("PAPERCLIP_RUNNER_BINARY", join(tmpdir(), "configuration-only-controller-runnerd"));
    f.input.runtimeEnv = { PAPERCLIP_RUNNER_BINARY: "relative-ignored-injected-runnerd" };
    expect((await selectHeartbeatRuntime(db, f.input)).selected).toBe(true);
    expect((await read(f.run.id)).runtimeMode).toBe("native");
    expect(await coordinators(f.run.id)).toHaveLength(1);
  });

  it("does not apply local Runner configuration to remote native selection", async () => {
    const f = await fixture();
    vi.stubEnv("PAPERCLIP_RUNNER_BINARY", "relative-unused-remote-controller");
    f.input.workspace.executionTarget = sandbox;
    expect((await selectHeartbeatRuntime(db, f.input)).selected).toBe(true);
    expect((await read(f.run.id)).runtimeMode).toBe("native");
    expect(await coordinators(f.run.id)).toHaveLength(1);
  });

  it("preserves immutable native recovery when current local Runner configuration is invalid", async () => {
    const f = await fixture();
    const selected = await selectHeartbeatRuntime(db, f.input);
    if (!selected.selected || !selected.nativeExecution) throw new Error("Expected native selection");
    const saved = await read(f.run.id);
    f.input.run = saved;
    f.input.session.persistedRunnerProfile = saved.runnerProfileJson ?? {};
    f.input.session.persistedNativeExecutionInput = selected.nativeExecution;
    vi.stubEnv("PAPERCLIP_RUNNER_BINARY", "relative-unused-recovery-controller");
    const resumed = await selectHeartbeatRuntime(db, f.input);
    expect(resumed).toMatchObject({ selected: true, nativeExecution: selected.nativeExecution, nativeRunnerInstanceId: selected.nativeRunnerInstanceId });
    expect((await read(f.run.id)).runnerProfileJson).toEqual(saved.runnerProfileJson);
    expect(await coordinators(f.run.id)).toHaveLength(1);
  });

  async function connectorFixture(durable = true) {
    const f = await fixture(), { input } = f;
    const home = await mkdtemp(join(tmpdir(), "selection-connector-assets-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    const config = await applyConnectorSkills({}, [], [{ key: "slack", label: "Slack", skillKey: "paperclipai/paperclip/slack",
      resources: [{ id: "synthetic-channel", label: "Fixture channel", connectionId: randomUUID() }],
      tools: [{ name: "fixture_read", description: "Read synthetic messages", inputSchema: { type: "object" } }] }]);
    input.config.runtimeConfig = config;
    input.config.runtimeSkillEntries = config.paperclipRuntimeSkills;
    vi.mocked(buildNativeRuntimeContext).mockImplementation(async () => {
      const context = nativeRuntimeContextFixture();
      context.instructions.bundle.rootPath = instructionRoot;
      context.skills = await materializeSelectedSkills(config, config.paperclipRuntimeSkills, true);
      return { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) };
    });
    const provider = createLocalDiskStorageProvider(join(home, "objects"));
    const storage = createStorageService(durable ? { ...provider, id: "s3" } : provider);
    const storageSpy = vi.spyOn(storageModule, "getStorageService").mockReturnValue(storage);
    return { ...f, home, storage, cleanup: async () => { storageSpy.mockRestore(); await removeRuntimeAssetTree(home); } };
  }

  it("publishes a dynamic connector skill receipt with admission and rehydrates its exact bytes on a cold host", async () => {
    const { input, run, agent, home, storage, cleanup } = await connectorFixture();
    let admitting = true;
    const getObject = storage.getObject.bind(storage);
    const readback = vi.spyOn(storage, "getObject").mockImplementation(async (...args) => {
      if (admitting) {
        expect((await read(run.id)).runnerProfileJson ?? {}).not.toHaveProperty("nativeExecutionInput");
        expect(await coordinators(run.id)).toEqual([]);
      }
      return getObject(...args);
    });
    try {
      const selected = await selectHeartbeatRuntime(db, input);
      admitting = false;
      if (!selected.selected || !selected.nativeExecution || !("runtimeContext" in selected.nativeExecution)) throw new Error("Expected native selection");
      const saved = await read(run.id);
      expect(readRuntimeSkillPreservation(saved)).not.toBeNull();
      expect(await hasLocalRuntimeSkillObligations(db)).toBe(false);
      const original = selected.nativeExecution.runtimeContext.skills[0]!;
      expect(original.versionId).toBeNull();
      const files = await Promise.all(["SKILL.md", "TOOLS.json"].map(async name => ({ name, bytes: await readFile(join(original.bundle.rootPath, name)) })));
      vi.stubEnv("PAPERCLIP_HOME", join(home, "cold"));
      const recovered = await rehydratePinnedSkillAssets(db, { companyId: agent.companyId, agentId: agent.id, runId: run.id }, selected.nativeExecution.runtimeContext);
      expect(recovered.skills[0]!.versionId).toBeNull();
      expect(recovered.skills[0]!.bundle.digest).toBe(original.bundle.digest);
      expect(recovered.skills[0]!.bundle.rootPath).not.toBe(original.bundle.rootPath);
      for (const file of files) {
        expect(await readFile(join(recovered.skills[0]!.bundle.rootPath, file.name))).toEqual(file.bytes);
        expect((await stat(join(recovered.skills[0]!.bundle.rootPath, file.name))).mode & 0o777).toBe(0o444);
      }
      readback.mockRestore();
      await removeRuntimeAssetTree(original.bundle.rootPath);
      const outage = vi.spyOn(storage, "getObject").mockRejectedValue(new Error("Synthetic storage outage"));
      try {
        const staged = await runtimeSkillPreservation.stageNativeRuntimeSkillAssets(db, { companyId: agent.companyId, agentId: agent.id,
          runId: run.id, issueId: selected.nativeExecution.binding.issueId, execution: selected.nativeExecution }, storage);
        expect(staged?.receipt).toEqual(readRuntimeSkillPreservation(saved));
        expect(outage).not.toHaveBeenCalled();
      } finally { outage.mockRestore(); }
      expect(await coordinators(run.id)).toMatchObject([{ phase: "observed", leaseOwner: null }]);
    } finally { readback.mockRestore(); await cleanup(); }
  });

  it.each(["storage failure", "cancelled", "changed binding", "retired package"])("keeps dynamic skill admission unpublished after %s", async failure => {
    const { input, run, agent, storage, cleanup } = await connectorFixture();
    const stage = vi.spyOn(runtimeSkillPreservation, "stageNativeRuntimeSkillAssets");
    const putFile = storage.putFile.bind(storage);
    const put = ["storage failure", "cancelled"].includes(failure) ? vi.spyOn(storage, "putFile").mockImplementation(async data => {
      const result = await putFile(data);
      if (failure === "storage failure") throw new Error("Synthetic storage failure");
      await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, run.id));
      return result;
    }) : null;
    input.beforeNativeRuntimeSelection = async () => {
      if (failure === "changed binding") {
        const execution = structuredClone(stage.mock.calls[0]![1].execution);
        execution.binding.agentId = randomUUID();
        await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, run.id));
      }
      if (failure === "retired package") await db.update(companySkillRepositorySnapshots).set({ storage: null })
        .where(eq(companySkillRepositorySnapshots.companyId, agent.companyId));
    };
    try {
      if (failure === "cancelled") expect(await selectHeartbeatRuntime(db, input)).toEqual({ selected: false });
      else await expect(selectHeartbeatRuntime(db, input)).rejects.toThrow(failure === "storage failure" ? "Synthetic storage failure"
        : failure === "changed binding" ? "binding_changed" : "package_not_durable");
      const saved = await read(run.id);
      expect(saved.runnerProfileJson ?? {}).not.toHaveProperty("nativeRuntimeSkillPreservation");
      if (failure !== "changed binding") expect(saved.runnerProfileJson ?? {}).not.toHaveProperty("nativeExecutionInput");
      else expect((saved.runnerProfileJson!.nativeExecutionInput as { binding: { agentId: string } }).binding.agentId).not.toBe(agent.id);
      expect(await coordinators(run.id)).toEqual([]);
      expect(prepareNativeWorkspaceSync).not.toHaveBeenCalled();
    } finally { put?.mockRestore(); stage.mockRestore(); await cleanup(); }
  });

  it("keeps volume-backed local connector admission independent of object storage", async () => {
    const { input, run, storage, cleanup } = await connectorFixture(false);
    const put = vi.spyOn(storage, "putFile").mockRejectedValue(new Error("Local mode must not upload"));
    try {
      expect((await selectHeartbeatRuntime(db, input)).selected).toBe(true);
      expect((await read(run.id)).runnerProfileJson).not.toHaveProperty("nativeRuntimeSkillPreservation");
      expect(put).not.toHaveBeenCalled();
      expect(await hasLocalRuntimeSkillObligations(db)).toBe(true);
    } finally { put.mockRestore(); await cleanup(); }
  });

  it("preserves preparation failure and skips runtime selection", async () => {
    const { input, run } = await fixture();
    const initiating = new Error("Synthetic preparation failure");
    const phases: string[] = [];
    await expect(prepareAndSelectHeartbeatRuntime(db, input, {
      measure: async (phase, work) => { phases.push(phase); return work(); },
      prepareInstructions: async () => { throw initiating; },
    })).rejects.toBe(initiating);
    expect(phases).toEqual(["instructions"]);
    expect(await coordinators(run.id)).toEqual([]);
    expect(buildNativeRuntimeContext).not.toHaveBeenCalled();
  });

  it.each([false, true])("checkpoints the real instruction copy under the selected agent-default warm policy (changed: %s)", async changed => {
    const { input, issue, agent, run } = await fixture();
    const userId = randomUUID(), environmentId = randomUUID(), leaseId = randomUUID();
    vi.stubEnv("PAPERCLIP_HOME", instructionRoot);
    const { resolveManagedInstructionsRoot } = await import("../agent-instructions.js");
    const canonical = resolveManagedInstructionsRoot(agent), remoteCwd = join(instructionRoot, randomUUID(), "task");
    await mkdir(canonical, { recursive: true }); await mkdir(remoteCwd, { recursive: true });
    await writeFile(join(canonical, "AGENTS.md"), "Synthetic instructions for this local fixture only.\n");
    const execute = promisify(execFileCallback);
    await execute("git", ["init", remoteCwd]);
    const target = { kind: "remote" as const, transport: "sandbox" as const, environmentId, leaseId, remoteCwd,
      runnerLifecyclePolicy: null, reusableLeaseConfigured: true, effectiveCapabilities: { reusableLeases: true } as never,
      runner: { execute: async (command: { command: string; args?: string[]; cwd?: string; env?: Record<string,string>; stdin?: string; timeoutMs?: number }) => {
        const args = [...(command.args ?? [])], env = { PATH: process.env.PATH, ...command.env };
        if (command.stdin != null && (args[0] === "-c" || args[0] === "-lc")) {
          Object.assign(env, { PAPERCLIP_TEST_STDIN: command.stdin });
          args[1] = `printf '%s' "$PAPERCLIP_TEST_STDIN" | (${args[1]})`;
        }
        const result = await execute(command.command, args, { cwd: command.cwd, env, timeout: command.timeoutMs, maxBuffer: 32 * 1024 * 1024 });
        return { exitCode: 0, signal: null, timedOut: false, ...result, pid: null, startedAt: new Date().toISOString() };
      } } };
    await db.insert(authUsers).values({ id: userId, name: "Fixture editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values([{ companyId: agent.companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId: agent.companyId, principalType: "agent", principalId: agent.id, membershipRole: "member" }]);
    await db.insert(principalPermissionGrants).values({ companyId: agent.companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agent.id] } });
    await db.insert(environments).values({ id: environmentId, name: `Loopback sandbox ${environmentId}`, driver: "sandbox" });
    const [lease] = await db.insert(environmentLeases).values({ id: leaseId, companyId: agent.companyId, environmentId, heartbeatRunId: run.id,
      provider: "fixture", providerLeaseId: "local-loopback", leasePolicy: "reuse_by_environment" }).returning();
    input.agent = { ...agent, adapterConfig: { ...agent.adapterConfig, lifecycleMode: "warm", idleTimeoutMs: 900_000,
      instructionsBundleMode: "managed", instructionsRootPath: canonical, instructionsEntryFile: "AGENTS.md" } };
    await db.update(agents).set({ adapterConfig: input.agent.adapterConfig }).where(eq(agents.id, agent.id));
    await db.update(heartbeatRuns).set({ responsibleUserId: userId }).where(eq(heartbeatRuns.id, run.id));
    input.run = await read(run.id);
    input.workspace.executionTarget = target;
    input.workspace.executionWorkspace.cwd = remoteCwd;
    input.workspace.activeEnvironmentLease = { lease: (await environmentService(db).getLeaseById(lease.id))! };
    input.nativeRuntimeResolution = resolveHeartbeatNativeRuntimeMode({ persisted: input.run, enabled: true, runtimeConfig: {}, adapterConfig: input.agent.adapterConfig,
      agent: input.agent, issue, target, workspaceId: null });
    expect(input.nativeRuntimeResolution.kind).toBe("native");
    const { agentInstructionsBundleMode } = await import("../agent-instructions.js");
    expect(agentInstructionsBundleMode(input.agent)).toBe("managed");
    const copies = agentInstructionWorkingCopyService(db);
    const instructionEvents = vi.fn(async () => {});
    const controller = createHeartbeatInstructionWorkingCopy({ db, instructionCopies: copies, readRun: () => input.run, agent: input.agent,
      context: input.task.context, session: { taskSession: null, taskSessionForRun: null, sessionConfigMetadata: {} as never },
      workspace: input.workspace, appendRunEvent: instructionEvents });
    const phases: string[] = [];
    const selected = await prepareAndSelectHeartbeatRuntime(db, input, {
      measure: async (phase, work) => { phases.push(phase); return work(); },
      prepareInstructions: async nativeLifecyclePolicy => {
        const runtimeConfig = await controller.prepare({ runtimeConfig: {}, nativeRuntimeResolution: input.nativeRuntimeResolution, hasInstructionFilesystem: true, nativeLifecyclePolicy });
        return { runtimeConfig, instructionCopy: controller.instructionCopy };
      },
    });
    expect(phases).toEqual(["instructions", "runtime_selection"]);
    expect(instructionEvents.mock.calls).toEqual([]);
    expect(controller.instructionCopy).not.toBeNull();
    if (!selected.selected || !selected.nativeExecution) throw new Error("Expected native selection");
    expect(selected.nativeExecution.session.lifecyclePolicy).toEqual({ mode: "warm", idleTimeoutMs: 900_000 });
    expect((await copies.get(agent.companyId, run.id))?.receipt?.warm).toBe(true);
    if (changed) await writeFile(join(controller.instructionCopy!.executionRoot, "memory.txt"), "Synthetic changed memory.\n");
    expect(await controller.nativeInstructionWorkingCopy()!.checkpointWarm!()).toBe(true);
    expect((await copies.get(agent.companyId, run.id))?.state).toBe("warm_saved");
    expect(instructionEvents).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "instruction_save",
      payload: expect.objectContaining({ state: changed ? "saved" : "unchanged", contract: "agent_files", errorCode: null }) }));
    if (changed) expect(await readFile(join(canonical, "memory.txt"), "utf8")).toBe("Synthetic changed memory.\n");
  }, 45_000);

  it.each([true, false])("records which earlier run a follow-up's process identity came from (prior identity: %s)", async priorIdentity => {
    const { input, run, agent, issue } = await fixture();
    const sessionId = randomUUID();
    const prior = await selectHeartbeatRuntime(db, input);
    if (!prior.selected || !prior.nativeExecution) throw new Error("Expected prior native selection");
    const priorInput = { ...prior.nativeExecution, session: { ...prior.nativeExecution.session, normalizedSessionId: sessionId } };
    const priorProfile = (await read(run.id)).runnerProfileJson;
    const processStartedAt = new Date(Date.now() - 60_000);
    await db.update(heartbeatRuns).set({ status: "succeeded", nativeSessionId: sessionId,
      ...(priorIdentity ? { processPid: 11_356, processGroupId: 11_356, processStartedAt } : {}),
      runnerProfileJson: { ...priorProfile, nativeExecutionInput: priorInput, sessionCheckpoint: {
        backendKind: "runner", driverKind: "codex_app_server", sessionId: "retained-provider-thread",
        providerSessionId: "retained-provider-thread", identity: { ...priorInput.binding, sessionId },
      } },
    }).where(eq(heartbeatRuns.id, run.id));
    const [nextRun] = await db.insert(heartbeatRuns).values({ companyId: agent.companyId, agentId: agent.id,
      issueId: issue.id, scopeKind: "issue", status: "running", nativeSessionId: sessionId,
      createdAt: new Date(run.createdAt.getTime() + 1000),
    }).returning();
    input.run = nextRun!;
    const selected = await selectHeartbeatRuntime(db, input);
    if (!selected.selected) throw new Error("Expected follow-up native selection");
    const saved = await read(nextRun!.id);
    if (priorIdentity) {
      expect(saved).toMatchObject({ processPid: 11_356, processGroupId: 11_356 });
      expect(saved.runnerProfileJson?.inheritedProcessIdentityRunId).toBe(run.id);
      // Settled-process cleanup clears the predecessor before the follow-up's
      // accounting runs; the follow-up was refused before it launched.
      await db.update(heartbeatRuns).set({ processPid: null, processGroupId: null, processStartedAt: null })
        .where(eq(heartbeatRuns.id, run.id));
      const sourceId = randomUUID();
      await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), costAccountingPending: true,
        errorCode: "native_session_cleanup_quarantined",
        usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0, accountingReceiptReady: false,
          accountingReceiptUnavailable: true, accountingReceiptSourceFences: {},
          ledgerScope: { issueId: issue.id, projectId: null, billingCode: null } } })
        .where(eq(heartbeatRuns.id, nextRun!.id));
      await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: "native_session_cleanup_quarantined" })
        .where(eq(nativeRunFinalizations.runId, nextRun!.id));
      expect(await accountRunCost(db, nextRun!.id)).toBe(true);
      expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, nextRun!.id))).toEqual([]);
    } else {
      expect(saved.processPid).toBeNull();
      expect(saved.runnerProfileJson?.inheritedProcessIdentityRunId).toBeUndefined();
    }
  });

  it.each(["matching", "different-session", "absent"])("persists the migrated logical cwd only for the receipt's exact session: %s", async receipt => {
    const sameSession = receipt === "matching";
    const { input, run, agent, issue } = await fixture();
    const sessionId = randomUUID(), operationId = randomUUID();
    const logicalCwd = "/paperclip/legacy/task-workspace";
    const marker = { schema: "paperclip.native-workspace-migration.v1", operationId };
    const [workspace] = await db.insert(executionWorkspaces).values({
      companyId: agent.companyId, sourceIssueId: issue.id, name: "Migrated workspace",
      mode: "shared_workspace", strategyType: "project_primary", cwd: "/tmp/ephemeral/task-workspace",
      providerType: "cloud_sandbox", metadata: receipt === "absent" ? {} : { nativeWorkspaceMigration: marker },
    }).returning();
    await db.insert(workspaceOperations).values({
      id: operationId, companyId: agent.companyId, executionWorkspaceId: workspace!.id,
      phase: "remote_workspace_migration", status: "succeeded", metadata: {
        schema: "paperclip.remote-workspace-migration.v1", snapshotId: randomUUID(),
        nativeSessionContinuity: { schema: marker.schema, remoteCwd: sandbox.remoteCwd, sessions: [{
          sourceRunId: randomUUID(), agentId: agent.id, issueId: issue.id,
          sessionId: sameSession ? sessionId : randomUUID(), logicalCwd,
        }] },
      },
    });
    input.workspace.persistedExecutionWorkspace = workspace!;
    input.workspace.executionWorkspace.cwd = logicalCwd;
    input.workspace.executionTarget = sandbox;
    const prior = await selectHeartbeatRuntime(db, input);
    if (!prior.selected || !prior.nativeExecution) throw new Error("Expected prior native selection");
    const priorInput = { ...prior.nativeExecution, session: { ...prior.nativeExecution.session, normalizedSessionId: sessionId } };
    const priorProfile = (await read(run.id)).runnerProfileJson;
    await db.update(heartbeatRuns).set({ status: "succeeded", nativeSessionId: sessionId,
      runnerProfileJson: { ...priorProfile, nativeExecutionInput: priorInput, sessionCheckpoint: {
        backendKind: "runner", driverKind: "codex_app_server", sessionId: "retained-provider-thread",
        providerSessionId: "retained-provider-thread", identity: { ...priorInput.binding, sessionId },
      } },
    }).where(eq(heartbeatRuns.id, run.id));
    const [nextRun] = await db.insert(heartbeatRuns).values({ companyId: agent.companyId, agentId: agent.id,
      issueId: issue.id, scopeKind: "issue", status: "running", nativeSessionId: sessionId,
      createdAt: new Date(run.createdAt.getTime() + 1000),
    }).returning();
    input.run = nextRun!;
    input.workspace.executionWorkspace.cwd = workspace!.cwd!;
    const selected = await selectHeartbeatRuntime(db, input);
    if (!selected.selected || !selected.nativeExecution) throw new Error("Expected migrated native selection");
    expect(selected.nativeExecution.session.normalizedSessionId).toBe(sessionId);
    expect(selected.nativeExecution.workspace.cwd).toBe(sameSession ? logicalCwd : workspace!.cwd);
    expect((await read(nextRun!.id)).runnerProfileJson?.nativeExecutionInput).toEqual(selected.nativeExecution);
    expect((await read(nextRun!.id)).nativeSessionId).toBe(selected.nativeExecution.session.normalizedSessionId);
  });

  it.each([false, true])("persists the Cursor provider API placement and completion authority without a Computer lease (ephemeral: %s)", async ephemeral => {
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", String(ephemeral));
    const { input, run, issue } = await fixture();
    vi.stubEnv("PAPERCLIP_RUNNER_BINARY", "relative-unused-api-controller");
    input.agent = { ...input.agent, adapterConfig: { provider: "cursor_cloud", model: "caller-model", repoUrl: "https://github.com/example/qualification" } };
    await db.update(agents).set({ adapterConfig: input.agent.adapterConfig }).where(eq(agents.id, input.agent.id));
    input.workspace.activeEnvironmentLease = null;
    input.nativeRuntimeResolution = resolveHeartbeatNativeRuntimeMode({ persisted: run, enabled: true, runtimeConfig: {}, adapterConfig: input.agent.adapterConfig,
      agent: input.agent, issue, target: null, workspaceId: null });
    const result = await selectHeartbeatRuntime(db, input);
    expect(result.selected).toBe(true);
    if (!result.selected) throw new Error("Expected native Cursor selection");
    expect(result.nativeExecution?.provider).toMatchObject({ kind: "cursor_cloud", model: "caller-model" });
    expect(await read(run.id)).toMatchObject({ runtimeMode: "native", driverKind: "cursor_cloud_api", runnerProfileJson: {
      backend: "cursor_cloud_api", executionPlacement: { kind: "provider_api", provider: "cursor_cloud", controller: "paperclip" },
      nativeExecutionInput: result.nativeExecution,
    } });
    expect(await db.select().from(completionContracts)).toHaveLength(1);
    expect(await coordinators(run.id)).toHaveLength(1);
    expect(prepareNativeWorkspaceSync).not.toHaveBeenCalled();
    expect(input.stopControllerLease).toHaveBeenCalledOnce();
  });

  it.each(["cursor_cloud_api", null] as const)("restores a historical Cursor workspace binding without allocating a Computer (driver: %s)", async driverKind => {
    const { input, run, issue } = await fixture();
    input.agent = { ...input.agent, adapterConfig: { provider: "cursor_cloud", model: "caller-model", repoUrl: "https://github.com/example/qualification" } };
    await db.update(agents).set({ adapterConfig: input.agent.adapterConfig }).where(eq(agents.id, input.agent.id));
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: input.agent.companyId, sourceIssueId: issue.id,
      name: "Previously admitted Cursor workspace", mode: "shared_workspace", strategyType: "project_primary", cwd: "/previous-cursor-workspace" }).returning();
    input.workspace.persistedExecutionWorkspace = workspace;
    input.workspace.activeEnvironmentLease = null;
    input.nativeRuntimeResolution = resolveHeartbeatNativeRuntimeMode({ persisted: run, enabled: true, runtimeConfig: {}, adapterConfig: input.agent.adapterConfig,
      agent: input.agent, issue, target: null, workspaceId: workspace.id });
    const selected = await selectHeartbeatRuntime(db, input);
    if (!selected.selected || !selected.nativeExecution) throw new Error("Expected native Cursor selection");
    expect(selected.nativeExecution.binding.executionWorkspaceId).toBe(workspace.id);
    const saved = await read(run.id);
    const historicalProfile: Record<string, unknown> = { ...saved.runnerProfileJson, sessionCheckpoint: { retained: "Cursor provider checkpoint" } };
    delete historicalProfile.executionPlacement;
    await db.update(heartbeatRuns).set({ runnerProfileJson: historicalProfile, driverKind }).where(eq(heartbeatRuns.id, run.id));
    input.run = await read(run.id);
    input.nativeRuntimeResolution = resolveHeartbeatNativeRuntimeMode({ persisted: input.run, enabled: true, runtimeConfig: {}, adapterConfig: input.agent.adapterConfig,
      agent: input.agent, issue, target: null, workspaceId: null });
    input.session.persistedRunnerProfile = historicalProfile;
    input.session.persistedNativeExecutionInput = selected.nativeExecution;
    input.workspace.persistedExecutionWorkspace = null;
    input.workspace.executionWorkspace.cwd = "/private-cursor-controller";
    vi.mocked(buildNativeRuntimeContext).mockClear();
    const resumed = await selectHeartbeatRuntime(db, input);
    expect(resumed).toMatchObject({ selected: true, nativeExecution: selected.nativeExecution, nativeRunnerInstanceId: selected.nativeRunnerInstanceId });
    expect(await read(run.id)).toMatchObject({ driverKind: "cursor_cloud_api" });
    expect((await read(run.id)).runnerProfileJson).toMatchObject({ ...historicalProfile,
      executionPlacement: { kind: "provider_api", provider: "cursor_cloud", controller: "paperclip" } });
    expect(await db.select().from(executionWorkspaces)).toEqual([workspace]);
    expect(await db.select().from(completionContracts)).toHaveLength(1);
    expect(await coordinators(run.id)).toHaveLength(1);
    expect(prepareNativeWorkspaceSync).not.toHaveBeenCalled();
    expect(buildNativeRuntimeContext).not.toHaveBeenCalled();
  });

  it("persists and admits a standing-chat response contract without requiring the unavailable action", async () => {
    const { input, issue, agent, run } = await fixture();
    const [conversation] = await db.update(issues).set({ title: "Chat with CEO", description: null,
      conversationAgentId: agent.id, conversationUserId: "runtime-test-operator", conversationState: "active" })
      .where(eq(issues.id, issue.id)).returning();
    input.task.issueRef = conversation!;
    input.task.context.conversationMode = true;
    const request = "Restart this instance.";
    input.task.safeWakeComments = [{ id: randomUUID(), body: request }];
    const selected = await selectHeartbeatRuntime(db, input);
    if (!selected.selected || !selected.nativeExecution) throw new Error("Expected native selection");
    const contract = selected.nativeExecution.completionContract.contract;
    expect(contract.objective).toMatch(/current conversation response/i);
    expect(contract.criteria).toEqual([{ id: "objective", requirement: expect.stringContaining(request) }]);
    expect(contract.criteria[0]!.requirement).not.toBe(request);
    const [persisted] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issue.id));
    expect(persisted!.contractJson).toEqual(contract);
    expect(selected.nativeExecution.completionContract.sha256).toBe(persisted!.canonicalSha256);
    expect((await read(run.id)).runnerProfileJson?.nativeExecutionInput).toEqual(selected.nativeExecution);
    expect(buildNativeModelEnvelope(selected.nativeExecution).completionContract).toEqual(contract);
  });

  it("keeps recovery out of live preparation before the workspace descriptor exists", async () => {
    const { input, run, issue } = await fixture();
    input.workspace.executionTarget = sandbox;
    await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, issue.id));
    const liveRunExecutions = new Set([run.id]);
    const recoveryInput = { db, restartKind: "hard" as const, runIds: [run.id], liveRunExecutions };
    vi.mocked(prepareNativeWorkspaceSync).mockImplementationOnce(async () => {
      const saved = await read(run.id);
      expect(saved.runnerProfileJson).toHaveProperty("nativeExecutionInput");
      expect(saved.runnerProfileJson).not.toHaveProperty("nativeWorkspaceSync");
      const before = await coordinators(run.id);
      expect(await claimNativeRestartRecoveries(recoveryInput)).toEqual([
        { kind: "awaiting_evidence", runId: run.id, reason: "current_controller_preparing" },
      ]);
      expect(await coordinators(run.id)).toEqual(before);
      expect((await read(run.id)).status).toBe("running");
      return null;
    });
    expect((await selectHeartbeatRuntime(db, input)).selected).toBe(true);
    liveRunExecutions.delete(run.id);
    expect(await claimNativeRestartRecoveries(recoveryInput)).toEqual([
      expect.objectContaining({ kind: "bootstrap_incomplete", runId: run.id, controllerGeneration: 1 }),
    ]);
  });

  it("persists the native input, completion contract, and coordinator before transferring cleanup ownership", async () => {
    const { input, run } = await fixture();
    input.workspace.onCheckpoint = vi.fn(async () => {});
    input.workspace.onPhase = async (_name, work) => work();
    vi.mocked(prepareNativeWorkspaceSync).mockImplementationOnce(async args => {
      expect(await read(run.id)).toMatchObject({ runtimeMode: "native", nativeIssueId: input.task.issueRef!.id });
      expect(await coordinators(run.id)).toHaveLength(1);
      expect(input.stopControllerLease).toHaveBeenCalledOnce();
      expect(args).toMatchObject({ runId: run.id, workspaceId: run.id, workspaceLocalDir: input.workspace.executionWorkspace.cwd });
      expect(args.onCheckpoint).toBe(input.workspace.onCheckpoint);
      expect(args.onPhase).toBe(input.workspace.onPhase);
      return null;
    });
    const selected = await selectHeartbeatRuntime(db, input);
    expect(selected.selected).toBe(true);
    if (!selected.selected) throw new Error("Expected selection");
    const saved = await read(run.id);
    expect(saved).toMatchObject({ runtimeMode: "native", driverKind: "codex_app_server", nativePhase: "observed", nativeSessionId: expect.any(String), runnerInstanceId: selected.nativeRunnerInstanceId,
      runnerProfileJson: { nativeExecutionInput: selected.nativeExecution, recoveryEventInventoryVersion: 1, nativePreparationFencingVersion: 1 } });
    expect(await db.select().from(completionContracts)).toHaveLength(1);
    expect(selected.getNativeFreshSessionHandoff).toBe(input.session.getFreshSessionHandoff);
    expect(input.onNativeOwnershipHeld).not.toHaveBeenCalled();
  });

  it("persists the Copilot task model without accepting task provider or permission changes", async () => {
    const { input, run, issue } = await fixture();
    const adapterConfig = { provider: "acpx", acpxAgent: "copilot", model: "gpt-5.6-luna", acpxPermissionMode: "approve-reads" };
    input.agent = { ...input.agent, adapterConfig };
    await db.update(agents).set({ adapterConfig }).where(eq(agents.id, input.agent.id));
    input.nativeRuntimeResolution = resolveHeartbeatNativeRuntimeMode({
      persisted: input.run, enabled: true, runtimeConfig: {}, adapterConfig,
      agent: input.agent, issue, target: null, workspaceId: null,
    });
    input.config.issueAssigneeOverrides = { adapterConfig: {
      model: "gpt-6-luna", provider: "codex", acpxAgent: "pi", acpxPermissionMode: "approve-all",
    } };
    const selected = await selectHeartbeatRuntime(db, input);
    if (!selected.selected || !selected.nativeExecution) throw new Error("Expected native Copilot selection");
    const expected = { kind: "acpx", agent: "copilot", model: "gpt-6-luna", permissionMode: "approve-reads" };
    expect(selected.nativeExecution.provider).toMatchObject(expected);
    expect((await read(run.id)).runnerProfileJson).toMatchObject({ nativeExecutionInput: { provider: expected } });
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

  it("does not upgrade an older preparation from supplied runtime profile data", async () => {
    const { input, run } = await fixture();
    const selected = await selectHeartbeatRuntime(db, input);
    if (!selected.selected || !selected.nativeExecution || input.nativeRuntimeResolution.kind !== "native") {
      throw new Error("Expected native selection");
    }
    const saved = await read(run.id);
    const olderProfile = { ...saved.runnerProfileJson };
    delete olderProfile.nativePreparationFencingVersion;
    await db.update(heartbeatRuns).set({ runnerProfileJson: olderProfile }).where(eq(heartbeatRuns.id, run.id));
    input.run = await read(run.id);
    input.session.persistedNativeExecutionInput = selected.nativeExecution;
    input.session.persistedRunnerProfile = { ...olderProfile, nativePreparationFencingVersion: 1 };
    Object.assign(input.nativeRuntimeResolution.profile, { nativePreparationFencingVersion: 1 });
    expect((await selectHeartbeatRuntime(db, input)).selected).toBe(true);
    expect((await read(run.id)).runnerProfileJson).not.toHaveProperty("nativePreparationFencingVersion");
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

  it("rejects resume after skill access revocation without rewriting the admitted revision", async () => {
    const { input, run } = await fixture();
    const key = "company/test/private-skill", versionId = randomUUID();
    await db.update(heartbeatRuns).set({ contextSnapshot: { skillVersions: { [key]: versionId } } }).where(eq(heartbeatRuns.id, run.id));
    input.run = await read(run.id);
    vi.mocked(buildNativeRuntimeContext).mockImplementationOnce(async () => {
      const context = nativeRuntimeContextFixture();
      context.instructions.bundle.rootPath = instructionRoot;
      context.skills = [{ key, runtimeName: "private-skill", versionId, bundle: { ...context.instructions.bundle } }];
      return { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) };
    });
    const selected = await selectHeartbeatRuntime(db, input);
    if (!selected.selected || !selected.nativeExecution) throw new Error("Expected native selection");
    const saved = await read(run.id);
    input.run = saved;
    input.session.persistedNativeExecutionInput = selected.nativeExecution;
    input.config.runtimeSkillEntries = [];
    await expect(selectHeartbeatRuntime(db, input)).rejects.toThrow("Project skill access changed");
    expect((await read(run.id)).runnerProfileJson).toEqual(saved.runnerProfileJson);
    expect((await read(run.id)).contextSnapshot?.skillVersions).toEqual({ [key]: versionId });
  });

  it.each(["exact", "fresh", "bootstrap", "dead-runner", "expired", "foreign-owner", "missing-audit"] as const)(
    "admits only exact pending Stop cleanup at runtime selection (%s)", async mode => {
      const { input, run, issue } = await fixture();
      const initial = await selectHeartbeatRuntime(db, input);
      if (!initial.selected || !initial.nativeExecution) throw new Error("Expected original native selection");
      await reserveRunBudget(db, run.companyId, run.id, null);
      const saved = await read(run.id), leaseOwner = `stop:${randomUUID()}`, intentAuditId = randomUUID();
      input.run = saved;
      input.session.persistedNativeExecutionInput = initial.nativeExecution;
      input.session.persistedRunnerProfile = saved.runnerProfileJson ?? {};
      await db.insert(activityLog).values({ id: intentAuditId, companyId: run.companyId, actorType: "system", actorId: "native-session-cancellation",
        action: "native.cancellation_intent_recorded", entityType: "heartbeat_run", entityId: run.id, runId: run.id, agentId: run.agentId });
      await db.update(nativeRunFinalizations).set({ leaseOwner: mode === "foreign-owner" ? "another-owner" : leaseOwner,
        leaseExpiresAt: new Date(Date.now() + (mode === "expired" ? -1 : 60_000)), controllerGeneration: 2, attempt: 1,
        recoveryState: mode === "bootstrap" ? "bootstrap_incomplete" : mode === "dead-runner" ? "resuming_session" : "awaiting_runner_reattach",
        recoveryHistory: [{ disposition: "reattach_remote_runner", controllerGeneration: 2, providerAttempt: 1 }],
      }).where(eq(nativeRunFinalizations.runId, run.id));
      await db.update(heartbeatRuns).set({ resultJson: {
        startupCancellation: { beforeNativeSelection: false, errorCode: "cancelled", requestedAt: new Date().toISOString() },
        executionCancellation: { state: "requested" },
        nativeCancellation: { schema: "paperclip.native-cancellation.v1", companyId: run.companyId, runId: run.id, issueId: issue.id,
          scope: "run", reasonCode: "cancellation_run_only", intentId: `native-cancellation:${randomUUID()}`,
          intentAuditId: mode === "missing-audit" ? randomUUID() : intentAuditId, dispatchState: "pending", dispatched: false,
          effects: ["release_run_resources"] },
      } }).where(eq(heartbeatRuns.id, run.id));
      input.recovery = mode === "fresh" ? {} : { nativeLeaseOwner: leaseOwner, nativeRestartRecovery: {
        kind: "reattach_remote_runner", runId: run.id, leaseOwner, controllerGeneration: 2, providerAttempt: 1,
        restartKind: "hard", recoveryRequestId: null, remote: { providerLeaseId: "existing-sandbox", remoteCwd: "/workspace" },
      } };
      const selected = await selectHeartbeatRuntime(db, input);
      expect(selected.selected).toBe(mode === "exact");
      expect(await coordinators(run.id)).toHaveLength(1);
      expect((await read(run.id)).nativeSessionId).toBe(saved.nativeSessionId);
      expect((await read(run.id)).runnerProfileJson?.nativeExecutionInput).toEqual(initial.nativeExecution);
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

  it("rejects resolved legacy execution on an ephemeral server before runtime admission", async () => {
    const { input, run } = await fixture("process");
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
    expect(input.nativeRuntimeResolution.kind).toBe("legacy");
    await expect(selectHeartbeatRuntime(db, input)).rejects.toThrow("native Paperclip Runner");
    expect((await read(run.id)).runtimeMode).toBe("legacy");
    expect(await coordinators(run.id)).toHaveLength(0);
    expect(input.onNativeLifecycleSelected).not.toHaveBeenCalled();
    expect(prepareNativeWorkspaceSync).not.toHaveBeenCalled();
  });

  it.each(["warm", "per_turn"] as const)("preserves resolved %s policy on an ephemeral server", async mode => {
    const { input, run } = await fixture();
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
    // Deliberately disagree with the resolved provider policy in both cases.
    input.agent.adapterConfig = { ...input.agent.adapterConfig, ...(mode === "per_turn" ? { lifecycleMode: "warm" } : {}) };
    input.workspace.executionTarget = { ...sandbox, reusableLeaseConfigured: true,
      effectiveCapabilities: { reusableLeases: true } as never,
      runnerLifecyclePolicy: mode === "warm" ? { mode, idleTimeoutMs: 300_000 } : { mode, idleTimeoutMs: null } };
    const selected = await selectHeartbeatRuntime(db, input);
    expect(selected.selected && selected.nativeExecution?.session.lifecyclePolicy.mode).toBe(mode);
    expect((await read(run.id)).runnerProfileJson).toMatchObject({ nativeExecutionInput: { session: { lifecyclePolicy: { mode } } } });
    expect(await coordinators(run.id)).toHaveLength(1);
  });

  it.each([
    { provider: "acpx", acpxAgent: "claude", model: "claude-opus-5-5", credentialProvider: "anthropic" as const, method: "subscription" as const },
    { provider: "acpx", acpxAgent: "grok", model: "grok-4.7", credentialProvider: "xai" as const, method: "subscription" as const },
    { provider: "opencode", model: "openrouter/deepseek/deepseek-v4-flash-0731", credentialProvider: "openrouter" as const, method: "api_key" as const },
  ])("admits managed $provider/$acpxAgent on an ephemeral server without changing credential lifecycle", async profile => {
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
    const { input, run, issue } = await fixture();
    const { credentialProvider, method, ...providerConfig } = profile;
    const adapterConfig = { ...providerConfig, lifecycleMode: "warm" };
    input.agent = { ...input.agent, adapterConfig };
    await db.update(agents).set({ adapterConfig }).where(eq(agents.id, input.agent.id));
    input.workspace.executionTarget = { ...sandbox, reusableLeaseConfigured: true,
      effectiveCapabilities: { reusableLeases: true } as never, runnerLifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 } };
    input.nativeRuntimeResolution = resolveHeartbeatNativeRuntimeMode({ persisted: run, enabled: true, runtimeConfig: {}, adapterConfig,
      agent: input.agent, issue, target: input.workspace.executionTarget, workspaceId: null });
    expect(input.nativeRuntimeResolution.kind).toBe("native");
    const attribution = { connectionId: randomUUID(), grantId: randomUUID(), provider: credentialProvider, method,
      mode: "responsible_user" as const, responsibleUserId: "task-owner" };
    input.config.managedAiRuntime = { sessionIdentity: "account:epoch-1", identity: "account:generation-1",
      config: { env: {}, managedAiConnection: { ...attribution, identity: "account:generation-1", sessionIdentity: "account:epoch-1" } },
      attribution, accountName: "Saved account", accountOwnerUserId: "task-owner", home: instructionRoot, cleanup: async () => {} };
    const selected = await selectHeartbeatRuntime(db, input);
    if (!selected.selected || !selected.nativeExecution) throw new Error("Expected native selection");
    expect(selected.nativeExecution.provider.kind).toBe(profile.provider);
    expect(selected.nativeExecution.session.lifecyclePolicy).toEqual({ mode: "per_turn", idleTimeoutMs: null });
    expect((await read(run.id)).runnerProfileJson).toMatchObject({
      nativeExecutionInput: { session: { lifecyclePolicy: { mode: "per_turn" } } },
    });
    expect(await coordinators(run.id)).toHaveLength(1);
  });

  it.each([
    { provider: "github" as const, method: "api_key" as const, expected: "warm" },
    { provider: "github" as const, method: "subscription" as const, expected: "per_turn" },
    { provider: "openai" as const, method: "api_key" as const, expected: "per_turn" },
  ])("persists $expected Copilot lifecycle for a managed $provider/$method account", async ({ provider, method, expected }) => {
    const { input, run, issue } = await fixture();
    const adapterConfig = { provider: "acpx", acpxAgent: "copilot", model: "gpt-5.6-luna", lifecycleMode: "warm", idleTimeoutMs: 300_000 };
    input.agent = { ...input.agent, adapterConfig };
    await db.update(agents).set({ adapterConfig }).where(eq(agents.id, input.agent.id));
    input.nativeRuntimeResolution = resolveHeartbeatNativeRuntimeMode({
      persisted: input.run, enabled: true, runtimeConfig: {}, adapterConfig,
      agent: input.agent, issue, target: null, workspaceId: null,
    });
    const attribution = { connectionId: randomUUID(), grantId: randomUUID(), provider, method, mode: "responsible_user" as const, responsibleUserId: "task-owner" };
    input.config.managedAiRuntime = {
      sessionIdentity: "fixture-grant:task-owner:epoch-1",
      config: { env: {}, managedAiConnection: { ...attribution, identity: "fixture-grant:task-owner:generation-1", sessionIdentity: "fixture-grant:task-owner:epoch-1" } },
      attribution,
      accountName: "Saved account",
      accountOwnerUserId: "task-owner",
      identity: "fixture-grant:task-owner:generation-1",
      home: instructionRoot,
      cleanup: async () => {},
    };
    const selected = await selectHeartbeatRuntime(db, input);
    if (!selected.selected || !selected.nativeExecution) throw new Error("Expected native Copilot selection");
    expect(selected.nativeExecution.session.lifecyclePolicy.mode).toBe(expected);
    expect((await read(run.id)).runnerProfileJson).toMatchObject({
      nativeExecutionInput: { session: { lifecyclePolicy: { mode: expected } } },
    });
    expect(await coordinators(run.id)).toHaveLength(1);
  });

  it.each(["api_key", "subscription"] as const)("keeps managed Claude %s task execution warm", async method => {
    const { input, run, issue } = await fixture();
    const adapterConfig = { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-4-6", lifecycleMode: "warm" };
    input.agent = { ...input.agent, adapterConfig };
    await db.update(agents).set({ adapterConfig }).where(eq(agents.id, input.agent.id));
    input.nativeRuntimeResolution = resolveHeartbeatNativeRuntimeMode({ persisted: input.run, enabled: true, runtimeConfig: {}, adapterConfig,
      agent: input.agent, issue, target: null, workspaceId: null });
    input.workspace.executionTarget = { ...sandbox, runnerTask: vi.fn(), reusableLeaseConfigured: true,
      effectiveCapabilities: { reusableLeases: true } as never, runnerLifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 } };
    const attribution = { connectionId: randomUUID(), grantId: randomUUID(), provider: "anthropic" as const, method,
      mode: "responsible_user" as const, responsibleUserId: "task-owner" };
    input.config.managedAiRuntime = { sessionIdentity: "account:epoch-1", identity: "account:generation-1",
      config: { env: {}, managedAiConnection: { ...attribution, identity: "account:generation-1", sessionIdentity: "account:epoch-1" } },
      attribution, accountName: "Saved account", accountOwnerUserId: "task-owner", home: instructionRoot, cleanup: async () => {} };
    const selected = await selectHeartbeatRuntime(db, input);
    if (!selected.selected || !selected.nativeExecution) throw new Error("Expected native Claude selection");
    expect(selected.nativeExecution.session.lifecyclePolicy).toEqual({ mode: "warm", idleTimeoutMs: 300_000 });
    expect((await read(run.id)).runnerProfileJson).toMatchObject({
      nativeResourceDisposition: "keep_running",
      nativeExecutionInput: { session: { lifecyclePolicy: { mode: "warm" } } },
    });
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
  async function claimPreparation(f: Awaited<ReturnType<typeof fixture>>) {
    await db.update(heartbeatRuns).set(legacyControllerClaim("legacy")).where(eq(heartbeatRuns.id, f.run.id));
    f.input.run = await read(f.run.id);
    expect(f.input.run.controllerBootId).toBeTruthy();
    expect(f.input.run.controllerLeaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(f.input.run.executionStage).toBe("preparing");
  }

  it.each(["local", "remote"] as const)("retires actual preparation ownership atomically at native admission: %s", async target => {
    const f = await fixture();
    await claimPreparation(f);
    if (target === "remote") f.input.workspace.executionTarget = sandbox;
    vi.mocked(prepareNativeWorkspaceSync).mockImplementationOnce(async () => {
      const saved = await read(f.run.id);
      expect(saved).toMatchObject({ runtimeMode: "native", controllerBootId: null, controllerLeaseExpiresAt: null, executionStage: null });
      expect(await coordinators(f.run.id)).toHaveLength(1);
      expect(f.input.stopControllerLease).toHaveBeenCalledOnce();
      return null;
    });
    expect((await selectHeartbeatRuntime(db, f.input)).selected).toBe(true);
    expect(await read(f.run.id)).toMatchObject({ runtimeMode: "native", controllerBootId: null, controllerLeaseExpiresAt: null, executionStage: null });
  });

  it.each(["foreign_boot", "expired", "cancelled"] as const)("keeps preparation ownership when native admission is denied: %s", async denied => {
    const f = await fixture();
    await claimPreparation(f);
    const patch = denied === "foreign_boot" ? { controllerBootId: randomUUID() } : denied === "expired" ? { controllerLeaseExpiresAt: new Date(0) } : { status: "cancelled" as const };
    await db.update(heartbeatRuns).set(patch).where(eq(heartbeatRuns.id, f.run.id));
    const before = await read(f.run.id);
    expect(await selectHeartbeatRuntime(db, f.input)).toEqual({ selected: false });
    const after = await read(f.run.id);
    expect(after).toMatchObject({ runtimeMode: "legacy", controllerBootId: before.controllerBootId, controllerLeaseExpiresAt: before.controllerLeaseExpiresAt, executionStage: before.executionStage });
    expect(await coordinators(f.run.id)).toHaveLength(0);
    expect(f.input.stopControllerLease).not.toHaveBeenCalled();
    expect(prepareNativeWorkspaceSync).not.toHaveBeenCalled();
  });

  it("rolls the preparation handoff back if the native coordinator cannot commit", async () => {
    const f = await fixture();
    await claimPreparation(f);
    const before = await read(f.run.id);
    await db.execute(sql`CREATE FUNCTION reject_test_native_coordinator() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled_native_coordinator_rejected'; END $$`);
    await db.execute(sql`CREATE TRIGGER reject_test_native_coordinator BEFORE INSERT ON native_run_finalizations FOR EACH ROW EXECUTE FUNCTION reject_test_native_coordinator()`);
    try {
      await expect(selectHeartbeatRuntime(db, f.input)).rejects.toMatchObject({ cause: { code: "P0001", message: "controlled_native_coordinator_rejected" } });
      expect(await read(f.run.id)).toMatchObject({ runtimeMode: "legacy", controllerBootId: before.controllerBootId, controllerLeaseExpiresAt: before.controllerLeaseExpiresAt, executionStage: before.executionStage, nativeSessionId: null });
      expect(await coordinators(f.run.id)).toHaveLength(0);
      expect(f.input.stopControllerLease).not.toHaveBeenCalled();
      expect(prepareNativeWorkspaceSync).not.toHaveBeenCalled();
    } finally {
      await db.execute(sql`DROP TRIGGER reject_test_native_coordinator ON native_run_finalizations`);
      await db.execute(sql`DROP FUNCTION reject_test_native_coordinator()`);
    }
  });

  it("keeps committed native authority after a later workspace synchronization failure", async () => {
    const f = await fixture();
    await claimPreparation(f);
    f.input.workspace.executionTarget = sandbox;
    vi.mocked(prepareNativeWorkspaceSync).mockRejectedValueOnce(new Error("controlled_workspace_sync_failure"));
    await expect(selectHeartbeatRuntime(db, f.input)).rejects.toThrow("controlled_workspace_sync_failure");
    expect(await read(f.run.id)).toMatchObject({ runtimeMode: "native", controllerBootId: null, controllerLeaseExpiresAt: null, executionStage: null });
    expect(await coordinators(f.run.id)).toHaveLength(1);
    expect(f.input.stopControllerLease).toHaveBeenCalledOnce();
  });

});
