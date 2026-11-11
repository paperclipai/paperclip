import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, applyPendingMigrations, companies, createDb, environmentLeases, heartbeatRuns, issues, issueRecoveryActions, nativeRunFinalizations } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { getExecutionBlocker } from "../execution-blocker.js";
import { NON_RETRYABLE_PREFLIGHT_FAILURE_CODES } from "../heartbeat/run-lifecycle.js";
import { nativeRunNeverLaunched } from "../native-local-process-stop.js";
import { instanceSettingsService } from "../instance-settings.js";
import { requestTaskRetry } from "../task-retry.js";
import { heartbeatService } from "../heartbeat.js";
import { recoverQuiescentRunnerdState, scopedRunnerdStateRoot } from "./native-session-executor.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_UNSTARTED_ATTACHMENT_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("automatic recovery of an unstarted local attachment", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (external) { await applyPendingMigrations(external); database = { connectionString: external, cleanup: async () => {} }; }
    else database = await startEmbeddedPostgresTestDatabase("unstarted-attachment-");
    db = createDb(database.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true });
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  async function deadChild() {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const pid = child.pid!; await once(child, "exit"); return pid;
  }
  it.each(["archived", "canonical", "logical_lease", "turn_issued", "live_provider", "foreign_host", "unreleased", "foreign_issue",
    "new_launch", "authenticated_thread", "unknown_event", "active_goal", "unsettled_runner", "unknown_entry", "ambiguous_archive", "ambiguous_turn",
    "unsafe_quarantine", "runner_group", "pending_cleanup", "active_released", "retry_after_stop"])(
    "reconciles the actual admission boundary (%s)", async mode => {
      const base = await mkdtemp(join(tmpdir(), "pc-attach-recovery-")), previous = process.env.PAPERCLIP_RUNNER_STATE_DIR;
      process.env.PAPERCLIP_RUNNER_STATE_DIR = base;
      let groupChild: ReturnType<typeof spawn> | undefined;
      try {
        const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sourceId = randomUUID(), currentId = randomUUID();
        const sessionId = randomUUID(), runnerInstanceId = randomUUID(), leaseId = randomUUID(), birth = new Date();
        const runnerPid = await deadChild();
        if (mode === "runner_group") groupChild = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { detached: true, stdio: "ignore", windowsHide: true });
        if (mode === "retry_after_stop") groupChild = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore", windowsHide: true });
        const providerPid = mode === "live_provider" ? process.pid : mode === "retry_after_stop" ? groupChild!.pid! : await deadChild();
        const execution = parseNativeExecutionInput({ schema: "paperclip.native-execution-input.v1", provider: { kind: "codex", model: null },
          binding: { companyId, agentId, issueId, runId: sourceId, executionWorkspaceId: issueId },
          task: { identifier: "TEST", title: "Continue preserved work", description: null, prompt: "Continue preserved work", workMode: "standard" },
          workspace: { cwd: base, repoUrl: null, repoRef: null, branchName: null },
          session: { normalizedSessionId: sessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
          completionContract: { id: "contract", sha256: "sha", schemaVersion: "paperclip.completion-contract.v1",
            contract: { revision: "1", objective: "Continue preserved work", criteria: [{ id: "done", requirement: "Save findings" }] } },
          interactionResponses: [], credentialBindings: [] });
        await db.insert(companies).values({ id: companyId, name: "Unstarted attachment", issuePrefix: `A${companyId.replaceAll("-", "")}`, defaultResponsibleUserId: "board" });
        await db.insert(agents).values({ id: agentId, companyId, name: "Reader", adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
        await db.insert(issues).values({ id: issueId, companyId, title: "Continue preserved work", status: "blocked", assigneeAgentId: agentId });
        await db.insert(heartbeatRuns).values({ id: sourceId, companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native",
          status: "failed", nativeSessionId: sessionId, runnerInstanceId, finishedAt: new Date(),
          runnerProfileJson: { nativeExecutionInput: execution }, contextSnapshot: { issueId } });
        await db.insert(nativeRunFinalizations).values({ runId: sourceId, companyId, issueId, phase: "terminal_failure", recoveryState: "blocked" });
        await db.insert(environmentLeases).values({ id: mode === "logical_lease" ? randomUUID() : leaseId, companyId, heartbeatRunId: sourceId, provider: "local", status: "failed",
          releasedAt: mode === "unreleased" ? null : new Date(), ...(mode === "pending_cleanup" ? { metadata: { pendingCleanupInFlight: true } } : {}),
          ...(mode === "active_released" ? { status: "active" } : {}) });
        await appendHeartbeatRunEvent(db, { companyId, runId: sourceId, agentId, eventType: "native.process_identity_recorded",
          payload: { processPid: runnerPid, processGroupId: mode === "runner_group" ? groupChild!.pid : process.platform === "win32" ? null : runnerPid,
            processStartedAt: birth.toISOString(), hostname: mode === "foreign_host" ? "other-host" : hostname(), targetKind: "local" } });
        if (mode === "new_launch") await appendHeartbeatRunEvent(db, { companyId, runId: sourceId, agentId,
          eventType: "native.process_start_requested", payload: { hostname: hostname() } });
        const next = { ...execution, binding: { ...execution.binding, runId: currentId } };
        await db.insert(heartbeatRuns).values({ id: currentId, companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native",
          status: "running", nativeSessionId: sessionId, runnerInstanceId, runnerProfileJson: { nativeExecutionInput: next }, contextSnapshot: { issueId } });
        await db.insert(nativeRunFinalizations).values({ runId: currentId, companyId, issueId, phase: "observed" });
        if (mode === "foreign_issue") next.binding.issueId = randomUUID();
        const scoped = scopedRunnerdStateRoot(next), quarantine = join(base, "quarantine", `${scoped.split(/[\\/]/).at(-1)}.identity_indeterminate.123.test`);
        const root = mode === "canonical" ? quarantine : join(quarantine, "continuity-breaks", "123-archive");
        const identity = { runId: sourceId, runnerInstanceId, normalizedSessionId: sessionId, environmentLeaseId: leaseId,
          turnId: `turn-${sourceId}`, itemId: `item-${sourceId}` };
        const command = { commandId: "command-1", controllerSeq: 1, type: "run.attach", status: "pending" };
        const startup = { schema: "paperclip.provider_startup.v1", launchId: randomUUID(), phase: "spawned", origin: identity,
          command: { commandId: command.commandId, controllerSeq: 1, commandType: "run.attach" },
          processId: providerPid, processGroupId: providerPid, authenticatedThreadId: mode === "authenticated_thread" ? "unexpected" : null };
        const files: Record<string, any> = {
          "control-plane/control-plane-state.json": { schema: "paperclip.runner.durable.control-plane-state.v2", identity, connectionCount: 1,
            ackedSourceSeq: 0, committedEvents: [], commands: [command], bootstrapHistory: { adopted: false, originIdentity: identity } },
          "runner/runner-state.json": { schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "ready", nextSourceSeq: 1,
            ackedSourceSeq: 0, outbox: [], pendingTerminalDelivery: null, processedCommands: { "command-1": { ...command, commandType: "run.attach" } } },
          "runner/codex-provider-state.json": { schema: "paperclip.runner.codex-provider-state.v1", lifecycle: "prepared", startupAttempt: startup,
            activeProviderTurnId: null, ambiguousTurnStartPending: mode === "ambiguous_turn", goal: mode === "active_goal" ? { status: "active" } : null,
            pendingEvents: [{ eventType: "harness.diagnostic", payload: { code: "provider_startup_ownership", startup } }], queuedEvents: [] },
        };
        if (mode === "turn_issued") files["control-plane/control-plane-state.json"].commands.push({ type: "turn.start", status: "pending" });
        if (mode === "unknown_event") files["runner/codex-provider-state.json"].pendingEvents.push({ eventType: "tool.execution.started" });
        if (mode === "unsettled_runner") files["runner/runner-state.json"].outbox.push({ eventType: "item.started" });
        for (const [name, value] of Object.entries(files)) { await mkdir(join(root, name, ".."), { recursive: true }); await writeFile(join(root, name), JSON.stringify(value)); }
        await mkdir(join(quarantine, "codex-home"), { recursive: true }); await writeFile(join(quarantine, "codex-home", "saved.txt"), "Preserved session history");
        await writeFile(join(base, "work.txt"), "Preserved workspace");
        if (mode === "unknown_entry") await writeFile(join(quarantine, "unknown-authority"), "{}");
        if (mode === "ambiguous_archive") { await mkdir(join(quarantine, "continuity-breaks", "other", "runner"), { recursive: true }); }
        if (mode === "unsafe_quarantine") {
          const target = join(base, "unsafe-target"); await rename(quarantine, target);
          await symlink(target, quarantine, process.platform === "win32" ? "junction" : "dir");
        }
        const start = () => recoverQuiescentRunnerdState({ db, execution: next, scoped });
        if (["archived", "canonical", "logical_lease"].includes(mode)) { await expect(start()).resolves.toBeUndefined(); await expect(start()).resolves.toBeUndefined(); }
        else {
          await expect(start()).rejects.toMatchObject({ details: { code: "native_session_continuity_unverified" } });
          if (mode !== "foreign_issue") {
            expect(await getExecutionBlocker(db, companyId, issueId)).not.toBeNull();
            await expect(start()).rejects.toThrow("quarantine_owner_unverified");
            const actions = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId)));
            expect(actions).toHaveLength(1);
            expect(NON_RETRYABLE_PREFLIGHT_FAILURE_CODES.has("native_session_continuity_unverified")).toBe(true);
            if (mode === "retry_after_stop") {
              await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), errorCode: "native_session_continuity_unverified" }).where(eq(heartbeatRuns.id, currentId));
              const [refused] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, currentId));
              expect(await nativeRunNeverLaunched(db, refused)).toBe(true);
              await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" });
              const receipt = await requestTaskRetry({ db, companyId, issueId, actorId: "board", actorSource: "local_implicit",
                observedRunId: currentId, idempotencyKey: randomUUID() });
              const heartbeat = heartbeatService(db);
              await heartbeat.resumeTaskRetry(companyId, receipt.requestId!);
              expect(await getExecutionBlocker(db, companyId, issueId)).not.toBeNull();
              expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued")))).toHaveLength(0);
              groupChild!.kill(); await once(groupChild!, "exit"); groupChild = undefined;
              await Promise.all([heartbeat.resumeTaskRetry(companyId, receipt.requestId!), heartbeat.resumeTaskRetry(companyId, receipt.requestId!)]);
              const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued")));
              expect(successors).toHaveLength(1);
              expect(successors[0].contextSnapshot?.forceFreshSession).toBe(true);
            }
          }
        }
        expect(existsSync(scoped)).toBe(false);
        expect(await readFile(join(base, "work.txt"), "utf8")).toBe("Preserved workspace");
        expect(await readFile(join(quarantine, "codex-home", "saved.txt"), "utf8")).toBe("Preserved session history");
        for (const [name, value] of Object.entries(files)) expect(await readFile(join(root, name), "utf8")).toBe(JSON.stringify(value));
      } finally {
        if (groupChild && groupChild.exitCode === null && groupChild.signalCode === null) { groupChild.kill(); await once(groupChild, "exit"); }
        if (previous === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR; else process.env.PAPERCLIP_RUNNER_STATE_DIR = previous;
        await rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }, 30_000);
});
