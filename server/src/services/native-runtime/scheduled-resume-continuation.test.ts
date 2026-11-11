import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  decideScheduledResumeContinuation,
  sameRunResumeClaimEntry,
  scheduledResumeContinuationAllowed,
  type ScheduledResumeContinuationEvidence,
} from "./scheduled-resume-continuation.js";

const proven: ScheduledResumeContinuationEvidence = {
  restartRecovery: false,
  targetKind: "local",
  coordinatorPhase: "retryable_failure",
  failureDetail: {
    recoveryMode: "exact_checkpoint_resume",
    recoverable: true,
    providerSessionEstablished: true,
    checkpointExists: true,
    originalFailureCode: "native_session_recovery_failed",
  },
  admittedAttempt: 2,
  localStop: { processPid: 81495 },
};

describe("same-run scheduled resume continuation of a turn lost on restore", () => {
  it("allows the continuation when the stop, the admitted attempt and the exact checkpoint are all recorded", () => {
    expect(decideScheduledResumeContinuation(proven)).toEqual({ allowed: true });
    expect(decideScheduledResumeContinuation({ ...proven, admittedAttempt: 3 })).toEqual({ allowed: true });
  });

  const detail = (patch: Record<string, unknown>) => ({ ...proven, failureDetail: { ...proven.failureDetail, ...patch } });
  it.each<[string, ScheduledResumeContinuationEvidence, string]>([
    ["a restart recovery claim owns its own rule", { ...proven, restartRecovery: true }, "restart_recovery_claim"],
    ["the run executes on a remote target", { ...proven, targetKind: "remote" }, "remote_target"],
    ["the coordinator is not a settled same-run retry", { ...proven, coordinatorPhase: "observed" }, "not_a_scheduled_same_run_resume"],
    ["a fresh run has no coordinator phase", { ...proven, coordinatorPhase: null }, "not_a_scheduled_same_run_resume"],
    ["the retry is a bootstrap retry", detail({ recoveryMode: "bootstrap_retry" }), "not_an_exact_checkpoint_resume"],
    ["the state is ambiguous", detail({ recoveryMode: "ambiguous_state" }), "not_an_exact_checkpoint_resume"],
    ["no failure detail was saved", { ...proven, failureDetail: null }, "not_an_exact_checkpoint_resume"],
    ["the failure is not recoverable", detail({ recoverable: false }), "failure_not_recoverable"],
    ["no provider session was established", detail({ providerSessionEstablished: false }), "provider_session_not_established"],
    ["no checkpoint exists", detail({ checkpointExists: false }), "checkpoint_missing"],
    ["a replacement run was created", detail({ successorRunId: "run-2" }), "replacement_recorded"],
    ["a replacement was denied", detail({ replacementDenied: "uncertain_provider_action" }), "replacement_recorded"],
    ["the attempt exceeds the budget", { ...proven, admittedAttempt: 4 }, "attempt_not_admitted"],
    ["no attempt was admitted", { ...proven, admittedAttempt: 0 }, "attempt_not_admitted"],
    ["the previous runner has no stop receipt", { ...proven, localStop: null }, "local_stop_unverified"],
  ])("refuses when %s", (_name, evidence, reason) => {
    expect(decideScheduledResumeContinuation(evidence)).toEqual({ allowed: false, reason });
  });

  const resumeClaim = (patch: Record<string, unknown> = {}, detail: Record<string, unknown> = {}) =>
    ({ ...sameRunResumeClaimEntry({ at: new Date(), controllerBootId: "boot-1", providerAttempt: 1,
      failureDetail: { ...proven.failureDetail, ...detail } }), ...patch });
  const claimed = (claim: Record<string, unknown> | null, patch: Partial<ScheduledResumeContinuationEvidence> = {}) =>
    ({ ...proven, coordinatorPhase: "observed", failureDetail: null, resumeClaim: claim, controllerBootId: "boot-1", ...patch });

  it("reads the evidence the resume reconciler recorded when it claimed the run", () => {
    expect(decideScheduledResumeContinuation(claimed(resumeClaim()))).toEqual({ allowed: true });
  });

  it.each<[string, ScheduledResumeContinuationEvidence, string]>([
    ["the last history entry is not the resume claim", claimed(resumeClaim({ disposition: "retryable_failure" })), "not_a_scheduled_same_run_resume"],
    ["no history entry exists", claimed(null), "not_a_scheduled_same_run_resume"],
    ["another boot recorded the resume claim", claimed(resumeClaim(), { controllerBootId: "boot-2" }), "not_a_scheduled_same_run_resume"],
    ["the claimed failure was a bootstrap retry", claimed(resumeClaim({}, { recoveryMode: "bootstrap_retry" })), "not_an_exact_checkpoint_resume"],
    ["the claimed failure had no checkpoint", claimed(resumeClaim({}, { checkpointExists: false })), "checkpoint_missing"],
    ["the claimed failure recorded a replacement", claimed(resumeClaim({}, { successorRunId: "run-2" })), "replacement_recorded"],
  ])("refuses a reconciler-claimed resume when %s", (_name, evidence, reason) => {
    expect(decideScheduledResumeContinuation(evidence)).toEqual({ allowed: false, reason });
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("the durable stop receipt behind a scheduled resume continuation", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDatabase: (() => Promise<void>) | undefined;
  let companyId!: string;
  let agentId!: string;
  let deadPid!: number;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-scheduled-resume-continuation-");
    stopDatabase = started.cleanup;
    db = createDb(started.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Resume", issuePrefix: "SRC",
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Runner", role: "engineer", status: "active",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex" }, runtimeConfig: {}, permissions: {} });
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(child, "exit");
    deadPid = child.pid!;
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await stopDatabase?.();
  });

  async function seedRun(events: Array<{ eventType: string; payload: Record<string, unknown> }>) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "failed", runtimeMode: "native",
      invocationSource: "assignment", triggerDetail: "system", contextSnapshot: {} });
    let seq = 0;
    for (const event of events) {
      seq += 1;
      await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq, eventType: event.eventType,
        stream: "system", level: "info", payload: event.payload });
    }
    return runId;
  }

  const identity = () => ({ processPid: deadPid, processGroupId: deadPid, processStartedAt: "2026-11-10T18:56:54.000Z" });
  const decide = (runId: string, patch: Partial<ScheduledResumeContinuationEvidence> = {}) => {
    const { localStop: _localStop, ...evidence } = { ...proven, ...patch };
    return scheduledResumeContinuationAllowed(db, { companyId, runId, ...evidence });
  };

  it("allows the continuation after the previous runner's verified stop", async () => {
    const runId = await seedRun([
      { eventType: "native.process_start_requested", payload: { providerAttempt: 1 } },
      { eventType: "native.process_identity_recorded", payload: identity() },
      { eventType: "native.local_process_stopped", payload: identity() },
    ]);
    expect(await decide(runId)).toEqual({ allowed: true });
  });

  it.each<[string, () => Array<{ eventType: string; payload: Record<string, unknown> }>]>([
    ["no stop was recorded", () => [
      { eventType: "native.process_identity_recorded", payload: identity() },
    ]],
    ["a newer launch follows the stop", () => [
      { eventType: "native.process_identity_recorded", payload: identity() },
      { eventType: "native.local_process_stopped", payload: identity() },
      { eventType: "native.process_start_requested", payload: { providerAttempt: 2 } },
    ]],
    ["the stopped process is still alive", () => [
      { eventType: "native.local_process_stopped",
        payload: { ...identity(), processPid: process.pid, processGroupId: process.pid } },
    ]],
    ["the run never had a process", () => []],
  ])("refuses when %s", async (_name, events) => {
    const runId = await seedRun(events());
    expect(await decide(runId)).toEqual({ allowed: false, reason: "local_stop_unverified" });
  });

  it("never reads a stop receipt for a restart claim or a remote target", async () => {
    const runId = await seedRun([{ eventType: "native.local_process_stopped", payload: identity() }]);
    expect(await decide(runId, { restartRecovery: true })).toEqual({ allowed: false, reason: "restart_recovery_claim" });
    expect(await decide(runId, { targetKind: "remote" })).toEqual({ allowed: false, reason: "remote_target" });
  });
});
