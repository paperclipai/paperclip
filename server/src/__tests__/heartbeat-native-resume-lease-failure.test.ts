import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, authUsers, companyMemberships, environments, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { beforeAll, expect, it, vi } from "vitest";
import { heartbeatService } from "../services/heartbeat.js";
import { classifyEnvironmentCapabilities, environmentRuntimeService } from "../services/environment-runtime.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "./helpers/native-restart.js";

describeEmbeddedPostgres("heartbeat native session resume environment failure", () => {
  const fixture = nativeRestartFixture();
  let companyId: string, agentId: string;
  beforeAll(() => { ({ companyId, agentId } = fixture.current); });

  it("releases the resume owner when the resumed run cannot acquire its environment lease", async () => {
    const label = `RESUME-LEASE-FAILURE-${randomUUID()}`;
    const f = await fixture.seedRun(label);
    const db = f.db, environmentId = randomUUID();
    const settings = instanceSettingsService(db), previous = await settings.getExperimental();
    let heartbeat: ReturnType<typeof heartbeatService> | undefined;
    try {
      const userId = randomUUID();
      await db.insert(authUsers).values({ id: userId, name: "Operator", email: `${userId}@example.invalid`,
        createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
      await db.insert(environments).values({ id: environmentId, name: "Managed computer", driver: "sandbox",
        config: { provider: "fake", image: "fixture:test" } });
      await db.update(agents).set({ defaultEnvironmentId: environmentId }).where(eq(agents.id, agentId));
      const execution = buildNativeExecutionInput({ companyId, agentId, runId: f.runId,
        issue: { id: f.issueId, identifier: `NRR-${label}`, title: "Resume after a sandbox failure",
          description: null, workMode: "standard" },
        taskPrompt: "Continue the original task.", provider: "codex",
        workspace: { id: f.runId, cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
        normalizedSessionId: f.native.normalizedSessionId, runtimeContext: nativeRuntimeContextFixture(),
        completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
          contract: { revision: "1", objective: "Resume", criteria: [{ id: "objective", requirement: "Resume the session" }] } } });
      const identity = { companyId, issueId: f.issueId, runId: f.runId, agentId, sessionId: f.native.normalizedSessionId };
      // An earlier provider failure left a retryable, result-less run for same-run resume.
      await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), errorCode: "native_session_interrupted",
        runnerProfileJson: { ...f.preparedProfile, nativeExecutionInput: execution,
          sessionCheckpoint: { identity, providerSessionId: "original-provider" } }, responsibleUserId: userId })
        .where(eq(heartbeatRuns.id, f.runId));
      await db.update(nativeRunFinalizations).set({ phase: "retryable_failure", attempt: 1, nextAttemptAt: new Date(0),
        recoveryState: "resuming_session", failureCode: "native_session_interrupted" })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      // The task already has an open incident, so releasing the issue lock does
      // not open another one and therefore never settles the coordinator.
      await issueRecoveryActionService(db).upsertSourceScoped({ companyId, sourceIssueId: f.issueId,
        kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: agentId, cause: "native_session_interrupted",
        fingerprint: `native-interruption:${f.runId}`, evidence: { runId: f.runId },
        nextAction: "Re-pair the computer connection.", maxAttempts: 3, wakePolicy: null, supersedeOnIdentityChange: true });

      const acquireRunLease = vi.fn(async () => { throw new Error("Sandbox creation has failed"); });
      const unexpected = async () => { throw new Error("A failed lease acquisition must not reach the sandbox"); };
      const runtime = environmentRuntimeService(db, { drivers: [{ driver: "sandbox", acquireRunLease,
        resumeRunLease: unexpected, releaseRunLease: async () => null, retryPendingSandboxTeardown: async () => undefined,
        realizeWorkspace: unexpected, execute: unexpected, syncIn: unexpected, syncOut: unexpected, supportsSync: () => true,
        resolveCapabilities: async () => classifyEnvironmentCapabilities({
          verifiedMethods: ["environmentSyncIn", "environmentSyncOut", "environmentExecute"], declared: null, narrowing: null }),
      }] });
      const backendFactory = vi.fn(() => { throw new Error("No provider backend may be created"); });
      await settings.updateExperimental({ enableNativeRunner: true });
      heartbeat = heartbeatService(db, { environmentRuntime: runtime, nativeSessionBackendFactory: backendFactory,
        runtimeEnv: { PAPERCLIP_INSTANCE_ID: "default" } });

      await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 });
      await heartbeat.drainActiveRunExecutions();

      expect(acquireRunLease).toHaveBeenCalledOnce();
      expect(backendFactory).not.toHaveBeenCalled();
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(run).toMatchObject({ status: "failed", errorCode: "setup_failed",
        error: expect.stringContaining('Failed to acquire lease for environment "Managed computer"') });
      const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(coordinator).toMatchObject({ phase: "terminal_failure", leaseOwner: null, leaseExpiresAt: null,
        recoveryState: "blocked", resultId: null, failureCode: "setup_failed",
        failureDetail: expect.objectContaining({ releasedOwner: expect.objectContaining({ reason: "unstarted_resume",
          leaseOwner: expect.stringContaining("default:resume:"), attempt: 1 }) }) });
      const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(task.executionRunId).toBeNull();
    } finally {
      try { await heartbeat?.drainActiveRunExecutions(); }
      finally { await settings.updateExperimental(previous); }
    }
  }, 60_000);
});
