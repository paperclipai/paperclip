import { windowsNativeOrphan } from "../../__tests__/helpers/windows-native-orphan.js";
import { stopReadOnlyWindowsOrphans } from "./native-windows-orphan-stop.js";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, applyPendingMigrations, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns,
  issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import * as runner from "../../vendor/paperclip-runner/index.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { instanceSettingsService } from "../instance-settings.js";
import { requestTaskRetry } from "../task-retry.js";
import { heartbeatService } from "../heartbeat.js";
import { reconcileSafeNativeReplacements } from "./native-safe-replacement.js";
import { scopedRunnerdStateRoot, verifyStoppedNativeSessionForAutomaticReplacement,
  verifyStoppedNativeSessionForContinuation } from "./native-session-executor.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_WINDOWS_RECOVERY_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Windows stopped read-only native recovery", () => {
  const createdCompanies: string[] = [];
  afterEach(async () => {
    if (createdCompanies.length) await db.delete(nativeRunFinalizations).where(inArray(nativeRunFinalizations.companyId, createdCompanies.splice(0)));
  });
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (external) { await applyPendingMigrations(external); database = { connectionString: external, cleanup: async () => {} }; }
    else database = await startEmbeddedPostgresTestDatabase("windows-native-read-");
    db = createDb(database.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true });
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function stoppedChild() {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const pid = child.pid!; await once(child, "exit"); return pid;
  }
  async function seed(base: string) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), id = randomUUID();
    createdCompanies.push(companyId);
    const nativeSessionId = randomUUID(), runnerInstanceId = randomUUID();
    const pid = await stoppedChild(), providerPid = await stoppedChild(), startedAt = new Date();
    const execution = runner.parseNativeExecutionInput({ schema: "paperclip.native-execution-input.v1",
      provider: { kind: "codex", model: null }, binding: { companyId, agentId, issueId, runId: id, executionWorkspaceId: id },
      task: { identifier: "TEST", title: "Read saved material", description: null, prompt: "Read saved material", workMode: "standard" },
      workspace: { cwd: base, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: nativeSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: "contract", sha256: "sha", schemaVersion: "paperclip.completion-contract.v1",
        contract: { revision: "1", objective: "Read saved material", criteria: [{ id: "done", requirement: "Save findings" }] } },
      interactionResponses: [], credentialBindings: [] });
    await db.insert(companies).values({ id: companyId, name: "Windows read recovery", issuePrefix: `W${companyId.replaceAll("-", "")}`,
      defaultResponsibleUserId: "board" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reader", adapterType: "paperclip_runner", status: "idle",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Read saved material", status: "blocked", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id, companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native",
      nativeSessionId, runnerInstanceId, status: "failed", finishedAt: new Date(),
      errorCode: "native_session_cleanup_quarantined", processPid: null, processGroupId: null, processStartedAt: null,
      runnerProfileJson: { recoveryEventInventoryVersion: 1, nativeExecutionInput: execution },
      contextSnapshot: { issueId }, resultJson: { savedMaterial: "Original evidence" } });
    await db.insert(nativeRunFinalizations).values({ runId: id, companyId, issueId, phase: "terminal_failure",
      failureCode: "native_session_cleanup_quarantined", failureDetail: { originalFailureCode: "native_session_interrupted",
        recoveryMode: "exact_checkpoint_resume", providerSessionEstablished: true, providerEventsExist: true, checkpointExists: true } });
    await db.insert(environmentLeases).values({ companyId, heartbeatRunId: id, provider: "local", status: "failed", releasedAt: new Date() });
    const launch = { processPid: pid, processGroupId: null, processStartedAt: startedAt.toISOString(), targetKind: "local", hostname: hostname() };
    await appendHeartbeatRunEvent(db, { companyId, runId: id, agentId, eventType: "native.process_identity_recorded", payload: launch });
    await appendHeartbeatRunEvent(db, { companyId, runId: id, agentId, eventType: "native.local_process_stopped", payload: launch });
    const identity = { runId: id, runnerInstanceId, normalizedSessionId: nativeSessionId, environmentLeaseId: id,
      turnId: `turn-${id}`, itemId: `item-${id}` };
    const threadId = randomUUID(), providerTurnId = randomUUID();
    const event = { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", sourceSeq: 5,
      sourceEventId: "provider-open", sourceInstanceId: runnerInstanceId, runId: id, normalizedSessionId: nativeSessionId,
      turnId: identity.turnId, itemId: identity.itemId, priority: 0, emittedAt: startedAt.toISOString(), eventType: "session.started",
      payload: { providerSessionId: threadId, processId: providerPid } };
    const normalized = { ...event, sourceSeq: 1, sourceEventId: `${runnerInstanceId}:${id}:1`, turnId: undefined, itemId: undefined,
      payload: { providerSessionId: threadId, driverSessionId: threadId } };
    await appendHeartbeatRunEvent(db, { companyId, runId: id, agentId, eventType: event.eventType, payload: { prpEvent: normalized },
      nativeSource: { sourceInstanceId: runnerInstanceId, sourceSeq: 1, sourceEventId: normalized.sourceEventId,
        protocolSchemaVersion: 1, canonicalPayload: normalized } });
    const root = scopedRunnerdStateRoot(execution);
    const files: Record<string, unknown> = {
      "control-plane/control-plane-state.json": { schema: "paperclip.runner.durable.control-plane-state.v1", identity,
        committedEvents: [{ envelope: { payload: event } }] },
      "runner/runner-state.json": { schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "ready", outbox: [] },
      "runner/codex-provider-state.json": { schema: "paperclip.runner.codex-provider-state.v1", lifecycle: "turn_active",
        startupAttempt: null, threadId, activeProviderTurnId: providerTurnId, pendingEvents: [], queuedEvents: [] },
    };
    for (const [name, value] of Object.entries(files)) { await mkdir(join(root, name, ".."), { recursive: true }); await writeFile(join(root, name), JSON.stringify(value)); }
    await writeFile(join(base, "saved-work.txt"), "Original saved work");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
    const thread = { id: threadId, cwd: base, turns: [{ id: providerTurnId, status: "interrupted",
      items: [{ type: "dynamicToolCall", tool: "get_task_context", status: "failed" }] }] };
    return { run, root, files, thread, event, launch, companyId, issueId, agentId, id };
  }

  it.runIf(process.platform === "win32").each(["verified", "live_provider", "new_launch", "foreign_host", "remote", "unreleased",
    "native_tool", "mutation", "source_changed", "active_turn", "workspace_junction", "foreign_workspace"])("proves the real admission boundary (%s)", async mode => {
    const base = await mkdtemp(join(tmpdir(), "pc-win-recovery-")), old = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = base;
    const reader = vi.spyOn(runner, "readStoppedCodexThread");
    try {
      const f = await seed(base);
      if (mode === "live_provider") {
        const control = f.files["control-plane/control-plane-state.json"] as any;
        control.committedEvents[0].envelope.payload.payload.processId = process.pid;
        await writeFile(join(f.root, "control-plane/control-plane-state.json"), JSON.stringify(control));
      }
      if (mode === "new_launch") await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.id, agentId: f.agentId,
        eventType: "native.process_start_requested", payload: { hostname: hostname() } });
      if (mode === "foreign_host") await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.id, agentId: f.agentId,
        eventType: "native.process_identity_recorded", payload: { ...f.launch, hostname: "other-host" } });
      if (mode === "remote" || mode === "unreleased") await db.update(environmentLeases).set(mode === "remote"
        ? { provider: "ssh" } : { releasedAt: null }).where(eq(environmentLeases.heartbeatRunId, f.id));
      if (mode === "workspace_junction") {
        const alias = join(base, "old-home-workspace");
        await symlink(base, alias, "junction");
        f.thread.cwd = alias;
      }
      if (mode === "foreign_workspace") { f.thread.cwd = join(base, "other"); await mkdir(f.thread.cwd); }
      if (mode === "native_tool") f.thread.turns[0].items = [{ type: "commandExecution" } as any];
      if (mode === "mutation") f.thread.turns[0].items[0].tool = "write_document";
      if (mode === "active_turn") f.thread.turns[0].status = "inProgress";
      let current = true;
      reader.mockResolvedValue({ thread: f.thread, runtimeCommand: process.execPath, sourceFiles: [], sourceIsCurrent: () => current });
      const proof = await verifyStoppedNativeSessionForContinuation(db, f.run);
      if (["verified", "source_changed", "workspace_junction"].includes(mode)) {
        expect(proof).not.toBeNull();
        if (mode === "source_changed") current = false;
        expect(proof!.retire()).toBe(mode !== "source_changed");
      } else expect(proof).toBeNull();
      for (const [name, value] of Object.entries(f.files)) expect(await readFile(join(f.root, name), "utf8")).toBe(JSON.stringify(value));
      expect(await readFile(join(base, "saved-work.txt"), "utf8")).toBe("Original saved work");
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.id)))[0].resultJson).toEqual({ savedMaterial: "Original evidence" });
    } finally {
      reader.mockRestore();
      if (old === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR; else process.env.PAPERCLIP_RUNNER_STATE_DIR = old;
      await rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it.runIf(process.platform === "win32").each(["automatic", "automatic_orphan", "retry"])("continues once through the real %s path", async mode => {
    const base = await mkdtemp(join(tmpdir(), "pc-win-continue-")), old = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = base;
    const reader = vi.spyOn(runner, "readStoppedCodexThread");
    let orphan: Awaited<ReturnType<typeof windowsNativeOrphan>> | undefined;
    try {
      const f = await seed(base);
      if (mode === "automatic_orphan") {
        orphan = await windowsNativeOrphan(join(f.root, "codex-home"));
        const launch = { ...f.launch, processPid: orphan.parentPid, processStartedAt: orphan.notBefore };
        for (const eventType of ["native.process_identity_recorded", "native.local_process_stopped"])
          await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.id, agentId: f.agentId, eventType, payload: launch });
        f.run.finishedAt = new Date(orphan.notAfter);
        await db.update(heartbeatRuns).set({ finishedAt: f.run.finishedAt }).where(eq(heartbeatRuns.id, f.id));
        (f.files["control-plane/control-plane-state.json"] as any).committedEvents[0].envelope.payload.payload.processId = orphan.pids[0];
        (f.files["runner/codex-provider-state.json"] as any).config = { command: process.execPath };
        for (const [name,value] of Object.entries(f.files)) await writeFile(join(f.root,name),JSON.stringify(value));
      }
      reader.mockResolvedValue({ thread: f.thread, runtimeCommand: process.execPath, sourceFiles: [], sourceIsCurrent: () => true });
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
      const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
        kind: "active_run_watchdog", cause: "native_session_cleanup_quarantined", fingerprint: f.id,
        ownerType: "board", returnOwnerAgentId: f.agentId, status: "resolved", outcome: "blocked",
        evidence: { runId: f.id, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" },
          nativeFailureBlock: { runId: f.id, statusVersion: task.statusVersion } }, nextAction: "Verify the stopped execution." });
      if (mode.startsWith("automatic")) {
        const options = { verifyStoppedSession: (run: typeof heartbeatRuns.$inferSelect) => verifyStoppedNativeSessionForAutomaticReplacement(db, run) };
        await reconcileSafeNativeReplacements(db, new Date(), options);
        await reconcileSafeNativeReplacements(db, new Date(), options);
      } else {
        const input = { db, companyId: f.companyId, issueId: f.issueId, actorId: "board", actorSource: "local_implicit" as const,
          observedRunId: f.id, idempotencyKey: randomUUID() };
        const receipt = await requestTaskRetry(input), duplicate = await requestTaskRetry({ ...input, idempotencyKey: randomUUID() });
        expect(duplicate.requestId).toBe(receipt.requestId);
        const heartbeat = heartbeatService(db);
        await Promise.all([heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!), heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!)]);
      }
      if (orphan) expect(() => process.kill(orphan!.pids[0], 0)).toThrow();
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        mode.startsWith("automatic") ? eq(heartbeatRuns.retryOfRunId, f.id) : eq(heartbeatRuns.status, "queued")));
      expect(successors).toHaveLength(1);
      expect(successors[0].status).not.toBe("running");
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.id)))[0].resultJson).toEqual({ savedMaterial: "Original evidence" });
      expect(await readFile(join(base, "saved-work.txt"), "utf8")).toBe("Original saved work");
      for (const [name, value] of Object.entries(f.files)) expect(await readFile(join(f.root, name), "utf8")).toBe(JSON.stringify(value));
    } finally {
      reader.mockRestore();
      if (orphan) await stopReadOnlyWindowsOrphans(orphan);
      if (old === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR; else process.env.PAPERCLIP_RUNNER_STATE_DIR = old;
      await rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 60_000);
});
