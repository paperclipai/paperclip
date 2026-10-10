import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { nativeSha256 } from "./canonical.js";
import { resumeNativeWorkspaceAfterOwnerStop } from "./native-workspace-owner-recovery.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readProcessStartedAt } from "../hot-restart.js";
import { withNativeWorkspaceFinalizationOwnership } from "./native-workspace-finalization-ownership.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  completionContracts,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  issueRecoveryActions,
  issueThreadInteractions,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resumeNativeWorkspaceFinalization } from "./native-workspace-finalizer.js";
import { reconcileNativeFinalizations } from "./native-finalization-reconciler.js";

describe("native workspace finalization recovery", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let workspaceRoot: string;
  let priorLogRoot: string | undefined;

  const companyId = randomUUID();
  const foreignCompanyId = randomUUID();
  const agentId = randomUUID();
  const projectId = randomUUID();
  const foreignProjectId = randomUUID();

  async function seedRun(input: {
    executionWorkspaceId: string;
    title: string;
  }) {
    const issueId = randomUUID();
    const contractId = randomUUID();
    const runId = randomUUID();
    const resultId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: input.title,
      status: "in_progress",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "native-workspace-finalizer-test-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { objective: input.title },
      canonicalSha256: `contract-${contractId}`,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      runtimeMode: "native",
      nativeIssueId: issueId,
      completionContractId: contractId,
      runnerProfileJson: {
        nativeExecutionInput: {
          binding: { executionWorkspaceId: input.executionWorkspaceId },
        },
      },
    });
    await db.insert(nativeRunResults).values({
      id: resultId,
      companyId,
      issueId,
      runId,
      completionContractId: contractId,
      serverFingerprint: `result-${resultId}`,
      schemaStatus: "accepted",
      resultJson: {},
      canonicalSha256: `result-${resultId}`,
    });
    await db.insert(nativeRunFinalizations).values({
      companyId,
      issueId,
      runId,
      phase: "result_accepted",
      resultId,
    });
    return { issueId, runId };
  }

  beforeAll(async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-native-workspace-finalizer-"),
    );
    priorLogRoot = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = path.join(
      workspaceRoot,
      "operation-logs",
    );
    temporary = await startEmbeddedPostgresTestDatabase(
      "paperclip-native-workspace-finalizer-",
    );
    db = createDb(temporary.connectionString);

    await db.insert(companies).values([
      { id: companyId, name: "Native workspace owner", issuePrefix: "NWO" },
      {
        id: foreignCompanyId,
        name: "Foreign workspace owner",
        issuePrefix: "FWX",
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native workspace agent",
      adapterType: "paperclip_runner",
      status: "running",
    });
    await db.insert(projects).values([
      {
        id: projectId,
        companyId,
        name: "Native workspace project",
        status: "active",
      },
      {
        id: foreignProjectId,
        companyId: foreignCompanyId,
        name: "Foreign workspace project",
        status: "active",
      },
    ]);
  }, 30_000);

  afterAll(async () => {
    await temporary.cleanup();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    if (priorLogRoot === undefined) {
      delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    } else {
      process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = priorLogRoot;
    }
  });

  async function seedAbandonedCopyback() {
    const seeded = await seedRun({ executionWorkspaceId: randomUUID(), title: "Accepted yield, abandoned copyback" });
    const owner = { token: randomUUID(), hostname: "replaced-controller", pid: 2,
      processStartedAt: "2026-10-10T00:02:55.560Z", controllerBootId: randomUUID() };
    await db.update(heartbeatRuns).set({ status: "running", nativePhase: "workspace_finalizing",
      runnerProfileJson: { nativeWorkspaceFinalizationOwner: owner, preserved: "workspace descriptor" },
    }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(issues).set({ executionRunId: seeded.runId }).where(eq(issues.id, seeded.issueId));
    await db.update(nativeRunFinalizations).set({ phase: "workspace_finalizing" }).where(eq(nativeRunFinalizations.runId, seeded.runId));
    const recovery = issueRecoveryActionService(db);
    const hold = { companyId, sourceIssueId: seeded.issueId, kind: "active_run_watchdog" as const,
      ownerType: "board" as const, cause: "native_workspace_finalization_owner_unverified",
      fingerprint: nativeSha256({ runId: seeded.runId, owner }), evidence: { runId: seeded.runId, owner }, maxAttempts: 1,
      nextAction: "Verify the previous controller and its workspace-copyback processes have stopped. Resume workspace finalization without another provider turn." };
    const action = await recovery.upsertSourceScoped(hold);
    await recovery.upsertSourceScoped(hold);
    return { ...seeded, owner, actionId: action.id, companyId, db, ownerToken: owner.token,
      actorId: "operator", controllerAndCopybackStopped: true as const,
      stopEvidence: "Deployment platform confirms the exact old container and all its processes exited." };
  }

  it("retains copyback-specific instructions after repeated recovery sweeps", async () => {
    const seed = await seedAbandonedCopyback();
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seed.actionId));
    expect(action.status).toBe("escalated");
    expect(action.nextAction).toContain("workspace-copyback processes have stopped");
    expect(action.nextAction).not.toContain("replacement run");
    await db.update(issueRecoveryActions).set({ nextAction: "Start a replacement run" }).where(eq(issueRecoveryActions.id, seed.actionId));
    await withNativeWorkspaceFinalizationOwnership(seed, async () => "unexpected");
    const [repaired] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seed.actionId));
    expect(repaired.nextAction).toContain("workspace-copyback processes have stopped");
    expect(repaired.attemptCount).toBe(action.attemptCount);
    expect(repaired.evidence?.recoveryBudget).toEqual(action.evidence?.recoveryBudget);
  });

  it("releases only the verified owner and resumes the saved result without changing its disposition", async () => {
    const seed = await seedAbandonedCopyback();
    const [before] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, seed.runId));
    expect(await withNativeWorkspaceFinalizationOwnership(seed, async () => "unexpected")).toEqual({ acquired: false });
    const receipt = await resumeNativeWorkspaceAfterOwnerStop(seed);
    expect(receipt).toEqual({ runId: seed.runId, resultId: before.resultId, status: "queued" });
    const [after] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, seed.runId));
    expect(after).toEqual(before);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId));
    expect(run.runnerProfileJson).toEqual({ preserved: "workspace descriptor" });
    expect(run.status).toBe("running");
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seed.actionId));
    expect(action.evidence?.workspaceOwnerStop).toMatchObject({ owner: seed.owner, actorId: "operator", resultId: before.resultId, stopEvidence: seed.stopEvidence });
    expect(action.status).toBe("escalated"); // Only commitment resolves the hold.
    expect(action.wakePolicy).toBeNull();
    expect(await db.select().from(activityLog).where(eq(activityLog.runId, seed.runId))).toHaveLength(1);
    const file = path.join(workspaceRoot, seed.runId);
    expect(await withNativeWorkspaceFinalizationOwnership(seed, async () => {
      await fs.writeFile(file, "accepted work");
      return "resumed";
    })).toEqual({ acquired: true, value: "resumed" });
    expect(await fs.readFile(file, "utf8")).toBe("accepted work");
    // A duplicate confirmation neither clears a newer owner nor writes another audit.
    await expect(resumeNativeWorkspaceAfterOwnerStop(seed)).resolves.toEqual(receipt);
    expect(await db.select().from(activityLog).where(eq(activityLog.runId, seed.runId))).toHaveLength(1);
  });

  it.each(["monitor", "approval"] as const)("commits the saved yield through reconciliation while preserving its %s wait", async wait => {
    const seed = await seedAbandonedCopyback();
    const workspaceId = randomUUID();
    const cwd = path.join(workspaceRoot, seed.runId);
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "saved.txt"), "accepted work");
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId,
      mode: "local", strategyType: "local_directory", name: "Retained workspace", cwd });
    const nextCheckAt = new Date(Date.now() - 60_000); // Already due, like the staging runs.
    const policy = { monitor: { nextCheckAt: nextCheckAt.toISOString(), notes: "Check the existing PR." } };
    await db.update(issues).set({ executionWorkspaceId: workspaceId,
      ...(wait === "monitor" ? { executionPolicy: policy, monitorNextCheckAt: nextCheckAt } : {}),
    }).where(eq(issues.id, seed.issueId));
    const interactionId = randomUUID();
    if (wait === "approval") await db.insert(issueThreadInteractions).values({
      id: interactionId, companyId, issueId: seed.issueId, sourceRunId: seed.runId,
      createdByAgentId: agentId, kind: "request_confirmation", status: "pending",
      payload: { version: 1, prompt: "Approve the plan?", target: { type: "issue_document",
        issueId: seed.issueId, key: "plan", revisionId: randomUUID() } },
    });
    const resultJson = {
      result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded",
        summary: "Wait for the existing continuation.",
        completionClaim: { contractRevision: "test", objectiveSatisfied: false, criteria: [],
          remainingWork: [{ description: "Wait for the check or plan confirmation.", blocksCompletion: true }] },
        continuation: { kind: wait === "monitor" ? "monitor" : "response_wake",
          summary: "Wait for the existing continuation.", idempotencyKey: "saved-wait" },
        evidence: [], verification: [], attentionRequests: [], artifacts: [] },
      terminal: { schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed",
        runTerminalState: "succeeded", reportedWorkDisposition: "yielded" },
    };
    await db.update(nativeRunResults).set({ resultJson }).where(eq(nativeRunResults.runId, seed.runId));
    const [accepted] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, seed.runId));

    // The real reconciler must remain fenced before operator confirmation.
    await reconcileNativeFinalizations(db, [seed.runId]);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, seed.runId)))[0].phase).toBe("workspace_finalizing");
    await resumeNativeWorkspaceAfterOwnerStop(seed);
    await reconcileNativeFinalizations(db, [seed.runId]);

    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, seed.runId)))[0]).toMatchObject({ phase: "committed", resultId: accepted.id });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId)))[0]).toMatchObject({ status: "succeeded", nativePhase: "committed" });
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, seed.runId))).toEqual([accepted]);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seed.actionId)))[0].status).toBe("resolved");
    const [issue] = await db.select().from(issues).where(eq(issues.id, seed.issueId));
    expect(issue.status).toBe(wait === "monitor" ? "in_progress" : "in_review");
    if (wait === "monitor") {
      expect(issue.monitorNextCheckAt).toEqual(nextCheckAt);
      expect(issue.executionPolicy).toEqual(policy);
    } else {
      expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId)))[0].status).toBe("pending");
    }
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, seed.issueId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(sql`${agentWakeupRequests.payload}->>'issueId' = ${seed.issueId}`)).toHaveLength(0);
    expect(await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, seed.runId),
      eq(workspaceOperations.phase, "workspace_finalize"), eq(workspaceOperations.status, "succeeded")))).toHaveLength(1);
    expect(await fs.readFile(path.join(cwd, "saved.txt"), "utf8")).toBe("accepted work");
  });

  it.each(["token", "company", "result", "newer owner", "missing confirmation", "malformed owner"])("rejects stale or unverified copyback recovery: %s", async changed => {
    const seed = await seedAbandonedCopyback();
    if (changed === "malformed owner") {
      const owner = { token: seed.ownerToken };
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: owner } }).where(eq(heartbeatRuns.id, seed.runId));
      await db.update(issueRecoveryActions).set({ evidence: { runId: seed.runId, owner } }).where(eq(issueRecoveryActions.id, seed.actionId));
    }
    if (changed === "token") seed.ownerToken = randomUUID();
    if (changed === "company") seed.companyId = foreignCompanyId;
    if (changed === "result") await db.update(nativeRunFinalizations).set({ resultId: null }).where(eq(nativeRunFinalizations.runId, seed.runId));
    if (changed === "newer owner") await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: { ...seed.owner, token: randomUUID() } } }).where(eq(heartbeatRuns.id, seed.runId));
    if (changed === "missing confirmation") Object.assign(seed, { controllerAndCopybackStopped: false });
    await expect(resumeNativeWorkspaceAfterOwnerStop(seed)).rejects.toThrow();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId));
    expect(run.runnerProfileJson?.nativeWorkspaceFinalizationOwner).toBeDefined();
    expect(await db.select().from(activityLog).where(eq(activityLog.runId, seed.runId))).toHaveLength(0);
  });

  it("rejects a locally live owner even after its advisory connection is gone", async () => {
    const seed = await seedAbandonedCopyback();
    const identity = await currentNativeControllerIdentity();
    const owner = { ...seed.owner, hostname: os.hostname(), pid: identity.pid,
      processStartedAt: identity.processStartedAt.toISOString(), controllerBootId: identity.bootId };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: owner } }).where(eq(heartbeatRuns.id, seed.runId));
    await db.update(issueRecoveryActions).set({ evidence: { runId: seed.runId, owner } }).where(eq(issueRecoveryActions.id, seed.actionId));
    await expect(resumeNativeWorkspaceAfterOwnerStop(seed)).rejects.toThrow("still active");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.runId));
    expect(run.runnerProfileJson?.nativeWorkspaceFinalizationOwner).toEqual(owner);
  });

  it("does not reopen an old result after a newer task execution exists", async () => {
    const seed = await seedAbandonedCopyback();
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "queued", nativeIssueId: seed.issueId });
    await expect(resumeNativeWorkspaceAfterOwnerStop(seed)).rejects.toThrow("no longer current");
  });

  it("rejects stop confirmation while another controller holds the physical lock", async () => {
    const seed = await seedAbandonedCopyback();
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`native-workspace-finalization:${companyId}:${seed.runId}`}, 0))`);
      await expect(resumeNativeWorkspaceAfterOwnerStop(seed)).rejects.toThrow("still active");
    });
  });

  it("reuses a successful export even if an old controller wrote a later failed barrier", async () => {
    const seeded = await seedRun({ executionWorkspaceId: randomUUID(), title: "Late failed barrier" });
    const [success] = await db.insert(workspaceOperations).values({ companyId, heartbeatRunId: seeded.runId,
      issueId: seeded.issueId, phase: "workspace_finalize", status: "succeeded" }).returning();
    await db.insert(workspaceOperations).values({ companyId, heartbeatRunId: seeded.runId,
      issueId: seeded.issueId, phase: "workspace_finalize", status: "failed", createdAt: new Date(Date.now() + 1000) });
    const operation = await resumeNativeWorkspaceFinalization({ db, runId: seeded.runId });
    expect(operation?.id).toBe(success.id);
    expect(await db.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId, seeded.runId))).toHaveLength(2);
  });

  it.each(["terminal_failure", "retryable_failure"] as const)(
    "rechecks %s admission before a delayed recovery starts another export",
    async (phase) => {
      const seeded = await seedRun({ executionWorkspaceId: randomUUID(), title: "Delayed recovery admission" });
      await db.insert(workspaceOperations).values({ companyId, heartbeatRunId: seeded.runId,
        issueId: seeded.issueId, phase: "workspace_finalize", status: "failed",
        stderrExcerpt: "workspace_sync_out_unsafe_archive\n" });
      // A sweep can select its run before live copyback publishes this outcome,
      // then enter the export path only after the live owner releases its lock.
      await db.update(nativeRunFinalizations).set({ phase,
        failureCode: "native_workspace_sync_out_unsafe_archive",
        failureDetail: { workspaceFinalizeAttempt: 1, recoveryOwner: { kind: "board" } },
        nextAttemptAt: phase === "retryable_failure" ? new Date(Date.now() + 60_000) : null,
      }).where(eq(nativeRunFinalizations.runId, seeded.runId));
      const [before] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, seeded.runId));
      expect(await resumeNativeWorkspaceFinalization({ db, runId: seeded.runId })).toBeNull();
      expect(await db.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId, seeded.runId))).toHaveLength(1);
      const [after] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, seeded.runId));
      expect(after).toEqual(before);
    },
  );

  it("keeps ordinary progress writable even when the application pool has one connection", async () => {
    const seeded = await seedRun({ executionWorkspaceId: randomUUID(), title: "Small application pool" });
    const smallPool = createDb(temporary.connectionString, { maxConnections: 1 });
    const result = await withNativeWorkspaceFinalizationOwnership({ db: smallPool, companyId, runId: seeded.runId }, async (ownership) => {
      await ownership.assertHeld();
      await smallPool.update(heartbeatRuns).set({ updatedAt: new Date() }).where(eq(heartbeatRuns.id, seeded.runId));
      return "progress saved";
    });
    expect(result).toEqual({ acquired: true, value: "progress saved" });
  });

  it("skips recovery while the live heartbeat owns slow copyback", async () => {
    const seeded = await seedRun({ executionWorkspaceId: randomUUID(), title: "Live copyback" });
    const live = await withNativeWorkspaceFinalizationOwnership({ db, companyId, runId: seeded.runId }, async (ownership) => {
      await ownership.assertHeld();
      expect(await resumeNativeWorkspaceFinalization({ db: createDb(temporary.connectionString), runId: seeded.runId })).toBeNull();
      expect(await db.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId, seeded.runId))).toEqual([]);
      return "copied";
    });
    expect(live).toEqual({ acquired: true, value: "copied" });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    expect(run.runnerProfileJson).not.toHaveProperty("nativeWorkspaceFinalizationOwner");
  });

  it("keeps the physical owner fenced after its lock connection dies until copyback joins", async () => {
    const seeded = await seedRun({ executionWorkspaceId: randomUUID(), title: "Disconnected copyback" });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    let published = false;
    const first = withNativeWorkspaceFinalizationOwnership({ db, companyId, runId: seeded.runId }, async (ownership) => {
      enter(); await finished; await ownership.assertHeld(); published = true;
    });
    // Observe rejection immediately, while retaining the promise until its callback joins.
    const outcome = first.then(() => null, (error: unknown) => error);
    try {
      await entered;
      await db.execute(sql`select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database()) and pid <> pg_backend_pid()`);
      const second = await withNativeWorkspaceFinalizationOwnership({ db: createDb(temporary.connectionString), companyId, runId: seeded.runId }, async () => "must not run");
      expect(second).toEqual({ acquired: false });
      const [held] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
      expect(held.runnerProfileJson?.nativeWorkspaceFinalizationOwner).toBeTruthy();
    } finally { finish(); }
    expect(await outcome).toBeTruthy();
    expect(published).toBe(false);
    expect(await withNativeWorkspaceFinalizationOwnership({ db, companyId, runId: seeded.runId }, async () => "recovered"))
      .toEqual({ acquired: true, value: "recovered" });
  });

  it("recovers its own joined copyback receipt after the application pool disconnects during cleanup", async () => {
    const seeded = await seedRun({ executionWorkspaceId: randomUUID(), title: "Reconnect joined copyback" });
    const interruptedDb = createDb(temporary.connectionString);
    let joined = false;
    await expect(withNativeWorkspaceFinalizationOwnership({ db: interruptedDb, companyId, runId: seeded.runId }, async () => {
      await fs.writeFile(path.join(workspaceRoot, "joined-copyback.txt"), "durable work");
      joined = true;
      await interruptedDb.$client.end({ timeout: 1 });
    })).rejects.toThrow();
    expect(joined).toBe(true);
    const [beforeReconnect] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    const receipt = beforeReconnect.runnerProfileJson?.nativeWorkspaceFinalizationOwner as Record<string, unknown>;
    expect(receipt).toBeTruthy();
    for (const unknown of [{ ...receipt, controllerBootId: randomUUID() }, { ...receipt, token: randomUUID() }]) {
      await db.update(heartbeatRuns).set({ runnerProfileJson: { ...beforeReconnect.runnerProfileJson, nativeWorkspaceFinalizationOwner: unknown } })
        .where(eq(heartbeatRuns.id, seeded.runId));
      expect(await withNativeWorkspaceFinalizationOwnership({ db, companyId, runId: seeded.runId }, async () => "must not run"))
        .toEqual({ acquired: false });
    }
    await db.update(heartbeatRuns).set({ runnerProfileJson: beforeReconnect.runnerProfileJson }).where(eq(heartbeatRuns.id, seeded.runId));
    expect(await withNativeWorkspaceFinalizationOwnership({ db: createDb(temporary.connectionString), companyId, runId: seeded.runId }, async () => "resumed"))
      .toEqual({ acquired: true, value: "resumed" });
  });

  it("never steals pending copyback from an orphan child after its controller is killed", async () => {
    const seeded = await seedRun({ executionWorkspaceId: randomUUID(), title: "Orphan copyback child" });
    const output = path.join(workspaceRoot, "orphan-copyback.txt");
    const childScript = `const fs = require('node:fs'); setInterval(() => fs.appendFileSync(${JSON.stringify(output)}, 'copying\\n'), 25);`;
    const parentScript = `const {spawn} = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {detached:true, stdio:'ignore'}); console.log(child.pid); child.unref(); setInterval(() => {}, 1000);`;
    const parent = spawn(process.execPath, ["-e", parentScript], { stdio: ["ignore", "pipe", "ignore"] });
    const [chunk] = await once(parent.stdout!, "data");
    const childPid = Number(String(chunk).trim());
    expect(childPid).toBeGreaterThan(0);
    try {
      const startedAt = await readProcessStartedAt(parent.pid!);
      const exited = once(parent, "close");
      parent.kill("SIGKILL"); await exited;
      process.kill(childPid, 0); // The copyback child outlived the exact controller.
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: {
        token: randomUUID(), hostname: os.hostname(), pid: parent.pid, processStartedAt: startedAt,
      } } }).where(eq(heartbeatRuns.id, seeded.runId));
      const work = vi.fn(async () => "second physical writer");
      expect(await withNativeWorkspaceFinalizationOwnership({ db, companyId, runId: seeded.runId }, work)).toEqual({ acquired: false });
      expect(work).not.toHaveBeenCalled();
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, seeded.issueId));
      expect(action).toMatchObject({ ownerType: "board", cause: "native_workspace_finalization_owner_unverified", wakePolicy: null });
    } finally {
      parent.kill("SIGKILL");
      try { process.kill(-childPid, "SIGKILL"); } catch { /* fixture already exited */ }
    }
  });

  it("recovers completed copyback after the exact controller process on this host exited", async () => {
    const seeded = await seedRun({ executionWorkspaceId: randomUUID(), title: "Dead copyback controller" });
    await db.insert(workspaceOperations).values({ companyId, heartbeatRunId: seeded.runId,
      issueId: seeded.issueId, phase: "workspace_finalize", status: "succeeded" });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(child, "spawn");
    const startedAt = await readProcessStartedAt(child.pid!);
    expect(startedAt).toBeTruthy();
    const exited = once(child, "close");
    child.kill("SIGTERM"); await exited;
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: {
      token: randomUUID(), hostname: os.hostname(), pid: child.pid, processStartedAt: startedAt,
    } } }).where(eq(heartbeatRuns.id, seeded.runId));
    expect(await withNativeWorkspaceFinalizationOwnership({ db, companyId, runId: seeded.runId }, async () => "recovered"))
      .toEqual({ acquired: true, value: "recovered" });
  });

  it("surfaces an unverifiable foreign controller as board recovery without physical writes", async () => {
    const seeded = await seedRun({ executionWorkspaceId: randomUUID(), title: "Foreign copyback controller" });
    const owner = { token: randomUUID(), hostname: "other-controller.invalid", pid: 42, processStartedAt: new Date().toISOString() };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceFinalizationOwner: owner } }).where(eq(heartbeatRuns.id, seeded.runId));
    const work = vi.fn();
    expect(await withNativeWorkspaceFinalizationOwnership({ db, companyId, runId: seeded.runId }, work)).toEqual({ acquired: false });
    expect(work).not.toHaveBeenCalled();
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, seeded.issueId));
    expect(action).toMatchObject({ ownerType: "board", cause: "native_workspace_finalization_owner_unverified", wakePolicy: null, evidence: { runId: seeded.runId, owner } });
    expect(action.nextAction).toContain("previous controller");
    await expect(withNativeWorkspaceFinalizationOwnership({ db, companyId: foreignCompanyId, runId: seeded.runId }, work))
      .rejects.toThrow("native_workspace_finalization_binding_missing");
    const [held] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    expect(held.runnerProfileJson?.nativeWorkspaceFinalizationOwner).toEqual(owner);
  });

  it("does not start another recovery while workspace finalization is still running", async () => {
    const cwd = path.join(workspaceRoot, "slow-workspace");
    await fs.mkdir(cwd);
    const seeded = await seedRun({ executionWorkspaceId: randomUUID(), title: "Slow workspace export" });
    await db.insert(workspaceOperations).values({
      companyId, heartbeatRunId: seeded.runId, issueId: seeded.issueId,
      phase: "workspace_finalize", cwd, status: "failed",
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const stat = fs.stat.bind(fs);
    let calls = 0;
    const spy = vi.spyOn(fs, "stat").mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      if (args[0] === cwd) { calls += 1; entered(); await held; }
      return stat(...args);
    });
    const first = resumeNativeWorkspaceFinalization({ db, runId: seeded.runId });
    try {
      await started;
      const second = resumeNativeWorkspaceFinalization({ db, runId: seeded.runId });
      // A second invocation must return busy without waiting for or executing the slow I/O.
      const outcome = await Promise.race([second, new Promise((resolve) => setTimeout(() => resolve("still-running"), 1_000))]);
      release();
      await Promise.all([first, second]);
      expect(outcome).toBeNull();
      expect(calls).toBe(1);
      const operations = await db.select().from(workspaceOperations).where(and(
        eq(workspaceOperations.heartbeatRunId, seeded.runId), eq(workspaceOperations.status, "succeeded"),
      ));
      expect(operations).toHaveLength(1);
    } finally { release(); await first; spy.mockRestore(); }
  });

  it("records directory-only recovery without inventing an execution-workspace foreign key", async () => {
    const cwd = path.join(workspaceRoot, "directory-only");
    await fs.mkdir(cwd);
    const seeded = await seedRun({
      executionWorkspaceId: randomUUID(),
      title: "Recover a directory-only workspace",
    });

    // Use the run id as the directory-only containment token, matching the native binding
    // that exposed the production FK failure.
    await db
      .update(heartbeatRuns)
      .set({
        runnerProfileJson: {
          nativeExecutionInput: {
            binding: { executionWorkspaceId: seeded.runId },
          },
        },
      })
      .where(eq(heartbeatRuns.id, seeded.runId));
    await db.insert(workspaceOperations).values({
      companyId,
      heartbeatRunId: seeded.runId,
      issueId: seeded.issueId,
      phase: "workspace_finalize",
      cwd,
      status: "failed",
    });

    const operation = await resumeNativeWorkspaceFinalization({
      db,
      runId: seeded.runId,
    });

    expect(operation).toMatchObject({
      heartbeatRunId: seeded.runId,
      issueId: seeded.issueId,
      executionWorkspaceId: null,
      cwd,
      status: "succeeded",
    });
    expect(operation?.metadata).toMatchObject({
      owningService: "native_workspace_finalizer",
      observation: "workspace_directory",
    });
  });

  it("retains a real company-owned execution workspace on the resumed operation", async () => {
    const cwd = path.join(workspaceRoot, "owned-workspace");
    await fs.mkdir(cwd);
    const executionWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "local",
      strategyType: "local_directory",
      name: "Owned workspace",
      cwd,
    });
    const seeded = await seedRun({
      executionWorkspaceId,
      title: "Recover an owned execution workspace",
    });

    const operation = await resumeNativeWorkspaceFinalization({
      db,
      runId: seeded.runId,
    });

    expect(operation).toMatchObject({
      heartbeatRunId: seeded.runId,
      issueId: seeded.issueId,
      executionWorkspaceId,
      cwd,
      status: "succeeded",
    });
  });

  it("does not attach a foreign-company workspace while retaining the bound prior operation cwd", async () => {
    const authorizedCwd = path.join(
      workspaceRoot,
      "authorized-prior-operation",
    );
    const foreignCwd = path.join(workspaceRoot, "foreign-workspace");
    const mismatchedCwd = path.join(
      workspaceRoot,
      "mismatched-issue-operation",
    );
    await Promise.all([
      fs.mkdir(authorizedCwd),
      fs.mkdir(foreignCwd),
      fs.mkdir(mismatchedCwd),
    ]);
    const foreignWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: foreignWorkspaceId,
      companyId: foreignCompanyId,
      projectId: foreignProjectId,
      mode: "local",
      strategyType: "local_directory",
      name: "Foreign workspace",
      cwd: foreignCwd,
    });
    const seeded = await seedRun({
      executionWorkspaceId: foreignWorkspaceId,
      title: "Reject a foreign execution workspace",
    });
    await db.insert(workspaceOperations).values({
      companyId,
      heartbeatRunId: seeded.runId,
      issueId: seeded.issueId,
      phase: "workspace_finalize",
      cwd: authorizedCwd,
      status: "failed",
    });
    const mismatchedIssueId = randomUUID();
    await db.insert(issues).values({
      id: mismatchedIssueId,
      companyId,
      title: "Unrelated workspace operation",
      status: "in_progress",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    await db.insert(workspaceOperations).values({
      companyId,
      heartbeatRunId: seeded.runId,
      issueId: mismatchedIssueId,
      phase: "workspace_finalize",
      cwd: mismatchedCwd,
      status: "failed",
      createdAt: new Date(Date.now() + 1_000),
    });

    const operation = await resumeNativeWorkspaceFinalization({
      db,
      runId: seeded.runId,
    });

    expect(operation).toMatchObject({
      heartbeatRunId: seeded.runId,
      issueId: seeded.issueId,
      executionWorkspaceId: null,
      cwd: authorizedCwd,
      status: "succeeded",
    });
    expect(operation!.cwd).not.toBe(foreignCwd);
    expect(operation!.cwd).not.toBe(mismatchedCwd);

    const persisted = await db
      .select()
      .from(workspaceOperations)
      .where(
        and(
          eq(workspaceOperations.id, operation!.id),
          eq(workspaceOperations.companyId, companyId),
          eq(workspaceOperations.issueId, seeded.issueId),
        ),
      )
      .orderBy(desc(workspaceOperations.createdAt))
      .limit(1);
    expect(persisted).toEqual([
      expect.objectContaining({
        executionWorkspaceId: null,
        cwd: authorizedCwd,
      }),
    ]);
  });
});
