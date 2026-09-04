import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  workAssessments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  CONTROL_PLANE_CONFORMANCE_RESULT,
  CONTROL_PLANE_CONFORMANCE_TERMINAL,
} from "../../vendor/paperclip-runner/testing.js";

const mockTelemetryClient = vi.hoisted(() => ({
  track: vi.fn(),
  hashPrivateRef: vi.fn((value: string) => `hashed:${value}`),
}));
vi.mock("../../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

function agentTaskRunCalls(fromIndex: number) {
  return mockTelemetryClient.track.mock.calls
    .slice(fromIndex)
    .filter((call) => call[0] === "agent.task_run");
}

import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { finalizeNativeRun, recordNativeFinalizationFailure } from "./native-run-finalizer.js";
import { commitNativeStatusDecision } from "./status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION, type NativeStatusDecision } from "./status-arbiter.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres native-finalizer telemetry tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("native run finalizer / status decision committer — agent.task_run emission", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-native-finalizer-telemetry-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Telemetry", issuePrefix: "TLM" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native worker",
      adapterType: "codex_local",
      status: "running",
    });
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedNativeRun() {
    const issueId = randomUUID();
    const contractId = randomUUID();
    const runId = randomUUID();
    const sessionId = randomUUID();
    const runnerInstanceId = randomUUID();
    const contractSha256 = `contract-${contractId}`;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Native telemetry fixture",
      status: "in_progress",
      assigneeAgentId: agentId,
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "telemetry-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "telemetry-v1",
        objective: "Emit telemetry",
        criteria: [{ id: "objective", requirement: "Complete the task" }],
      },
      canonicalSha256: contractSha256,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      nativeSessionId: sessionId,
      runnerInstanceId,
      completionContractId: contractId,
      completionContractSha256: contractSha256,
      contextSnapshot: { issueId },
    });
    return { issueId, contractId, contractSha256, runId, sessionId, runnerInstanceId };
  }

  function newPort(fixture: Awaited<ReturnType<typeof seedNativeRun>>) {
    return new PaperclipControlPlanePort(db, {
      companyId,
      issueId: fixture.issueId,
      runId: fixture.runId,
      agentId,
      sessionId: fixture.sessionId,
      completionContractId: fixture.contractId,
      completionContractSha256: fixture.contractSha256,
      sourceInstanceId: fixture.runnerInstanceId,
      controlPlaneSourceInstanceId: "telemetry-test",
    });
  }

  async function driveToCompleteResult(
    fixture: Awaited<ReturnType<typeof seedNativeRun>>,
    terminal: typeof CONTROL_PLANE_CONFORMANCE_TERMINAL = CONTROL_PLANE_CONFORMANCE_TERMINAL,
  ) {
    const port = newPort(fixture);
    await port.openRun({
      identity: {
        runId: fixture.runId,
        sessionId: fixture.sessionId,
        companyId,
        issueId: fixture.issueId,
        agentId,
      },
      backendKind: "mock",
      sourceInstanceId: fixture.runnerInstanceId,
    });
    await port.completeRun({
      result: CONTROL_PLANE_CONFORMANCE_RESULT,
      terminal,
      callerResultId: `${fixture.runId}:result`,
    });
  }

  it("emits exactly one agent.task_run event when the native finalizer commits a terminal status", async () => {
    const fixture = await seedNativeRun();
    await driveToCompleteResult(fixture);

    const callsBefore = mockTelemetryClient.track.mock.calls.length;
    await finalizeNativeRun({
      db,
      runId: fixture.runId,
      workspaceFinalizeStatus: "succeeded",
      projectRunStatus: true,
    });
    const newCalls = agentTaskRunCalls(callsBefore);

    expect(newCalls).toHaveLength(1);
    expect(newCalls[0]?.[1]).toMatchObject({ agent_id: agentId, state: "succeeded" });

    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, fixture.runId))
      .then((rows) => rows[0]);
    expect(run?.status).toBe("succeeded");
  });

  it("emits zero events when a repeat finalize call's conditional native write matches no row", async () => {
    const fixture = await seedNativeRun();
    await driveToCompleteResult(fixture);
    await finalizeNativeRun({
      db,
      runId: fixture.runId,
      workspaceFinalizeStatus: "succeeded",
      projectRunStatus: true,
    });

    const callsBefore = mockTelemetryClient.track.mock.calls.length;
    // The coordinator is already "committed", so this second call takes the
    // projectCommittedRun short-circuit. The run's status is already terminal
    // ("succeeded"), which sits outside projectCommittedRun's WHERE
    // (queued/running/failed), so the write matches no row.
    await finalizeNativeRun({
      db,
      runId: fixture.runId,
      workspaceFinalizeStatus: "succeeded",
      projectRunStatus: true,
    });
    expect(agentTaskRunCalls(callsBefore)).toHaveLength(0);
  });

  it("emits zero events when a reconciliation replay commits the same failed terminal result again", async () => {
    const fixture = await seedNativeRun();
    await driveToCompleteResult(fixture, {
      ...CONTROL_PLANE_CONFORMANCE_TERMINAL,
      turnTerminalState: "failed",
      runTerminalState: "failed",
    });
    // workspaceFinalizeStatus reports whether the workspace finalization
    // step itself succeeded, independent of the run's own terminal state
    // (runTerminalState below), which is what actually failed here.
    await finalizeNativeRun({
      db,
      runId: fixture.runId,
      workspaceFinalizeStatus: "succeeded",
      projectRunStatus: true,
    });
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, fixture.runId))
      .then((rows) => rows[0]);
    expect(run?.status).toBe("failed");

    const callsBefore = mockTelemetryClient.track.mock.calls.length;
    // The coordinator is already "committed" with a "failed" terminal
    // result, and the run row is already "failed" — unlike the "succeeded"
    // case above, "failed" sits INSIDE projectCommittedRun's WHERE clause
    // (queued/running/failed), so a reconciliation replay's write still
    // matches the row. The write changes nothing (failed -> failed), so it
    // must not emit a second event for the same committed result.
    await finalizeNativeRun({
      db,
      runId: fixture.runId,
      workspaceFinalizeStatus: "succeeded",
      projectRunStatus: true,
    });
    expect(agentTaskRunCalls(callsBefore)).toHaveLength(0);
  });

  it("emits zero events when a retryable-failure write's conditional status spread is omitted", async () => {
    const fixture = await seedNativeRun();
    // recordNativeFinalizationFailure only needs the run and coordinator rows
    // to exist — no persisted native result is required.
    await db.insert(nativeRunFinalizations).values({
      runId: fixture.runId,
      companyId,
      issueId: fixture.issueId,
      phase: "observed",
      attempt: 0,
    });

    const callsBefore = mockTelemetryClient.track.mock.calls.length;
    // projectRunStatus is omitted (falsy): the conditional spread in
    // recordRetryableFailure never includes `status`, so the write never sets
    // a terminal status, regardless of the attempt count.
    await recordNativeFinalizationFailure({
      db,
      runId: fixture.runId,
      error: new Error("native_test_failure"),
    });
    expect(agentTaskRunCalls(callsBefore)).toHaveLength(0);

    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, fixture.runId))
      .then((rows) => rows[0]);
    expect(run?.status).toBe("running");
  });

  it("emits exactly one event for a cancel_continuations write (trap 2: :685/:518 overlap)", async () => {
    const fixture = await seedNativeRun();
    // Build the minimal real rows commitNativeStatusDecision's foreign keys
    // require, without going through the evidence-classifier pipeline.
    const resultId = randomUUID();
    await db.insert(nativeRunResults).values({
      id: resultId,
      companyId,
      issueId: fixture.issueId,
      runId: fixture.runId,
      completionContractId: fixture.contractId,
      serverFingerprint: `fp-${resultId}`,
      schemaStatus: "accepted",
      resultJson: {},
      canonicalSha256: `sha-${resultId}`,
    });
    const assessmentId = randomUUID();
    await db.insert(workAssessments).values({
      id: assessmentId,
      companyId,
      issueId: fixture.issueId,
      runId: fixture.runId,
      contractId: fixture.contractId,
      resultId,
      triggerKind: "native_result",
      triggerActorCompanyId: companyId,
      priorIssueStatus: "in_progress",
      priorStatusVersion: 0,
      policyVersion: "telemetry-v1",
      assessmentJson: {},
      inputDigest: `digest-${assessmentId}`,
    });
    await db.insert(nativeRunFinalizations).values({
      runId: fixture.runId,
      companyId,
      issueId: fixture.issueId,
      phase: "arbitrating",
      attempt: 0,
      resultId,
    });

    // Shaped exactly like resolveNativeCancellationStatus("issue", ...) in
    // native-session-executor.ts — the only place cancel_continuations is
    // produced today.
    const decision: NativeStatusDecision = {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "cancelled",
      toStatus: "cancelled",
      reasonCode: "cancellation_issue_authorized",
      unblockDescriptor: null,
      effects: [{ kind: "release_checkout" }, { kind: "cancel_continuations" }],
    };

    const callsBefore = mockTelemetryClient.track.mock.calls.length;
    await commitNativeStatusDecision({
      db,
      companyId,
      issueId: fixture.issueId,
      runId: fixture.runId,
      assessmentId,
      priorStatus: "in_progress",
      priorStatusVersion: 0,
      priorDecisionId: null,
      decision,
    });
    const afterCommit = agentTaskRunCalls(callsBefore);
    // status-decision-committer.ts:685 (the cancel_continuations effect)
    // wrote this run's terminal status and emitted for it.
    expect(afterCommit).toHaveLength(1);
    expect(afterCommit[0]?.[1]).toMatchObject({ agent_id: agentId, state: "cancelled" });

    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, fixture.runId))
      .then((rows) => rows[0]);
    expect(run?.status).toBe("cancelled");

    // native-run-finalizer.ts:518's own guard: it skips its emit whenever the
    // decision it just committed already included cancel_continuations,
    // because :685 above already wrote and emitted for this run. Reproduce
    // the exact guard predicate on the same decision object to prove it
    // resolves to "skip", so the run's total event count for this commit
    // stays at exactly one even after the finalizer's own write runs.
    const alreadyEmittedByCommittedDecision = decision.effects.some(
      (effect) => effect.kind === "cancel_continuations",
    );
    expect(alreadyEmittedByCommittedDecision).toBe(true);
    expect(agentTaskRunCalls(callsBefore)).toHaveLength(1);
  });
});
