import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
} from "@paperclipai/db";
import type {
  PrpEvent,
  PrpStructuredRunResult,
  PrpTerminalState,
} from "@paperclipai/paperclip-runner";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  runnerPrpWebSocketInternals,
  setupRunnerPrpWebSocketServer,
} from "../../realtime/runner-prp-ws.js";
import { NativeRunCoordinatorStore } from "./native-run-coordinator-store.js";
import { runnerPrpCoordinator } from "./runner-prp-coordinator.js";
import { PaperclipRunnerSemanticAuthority } from "./runner-semantic-authority.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping runner coordinator tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

interface SeededNativeRun {
  companyId: string;
  issueId: string;
  agentId: string;
  runId: string;
  runnerInstanceId: string;
  sessionId: string;
  completionContractId: string;
  completionContractSha256: string;
}

const result: PrpStructuredRunResult = {
  schema: "paperclip.run_result.v1",
  reportedWorkDisposition: "done",
  summary: "The hidden runner completed the bounded task.",
  completionClaim: {
    contractRevision: "1",
    objectiveSatisfied: true,
    criteria: [],
    remainingWork: [],
  },
  evidence: [],
  verification: [{ commandOrCheck: "coordinator test", status: "passed" }],
  attentionRequests: [],
  artifacts: [],
};

const terminal: PrpTerminalState = {
  schema: "paperclip.prp.terminal.v1",
  turnTerminalState: "completed",
  runTerminalState: "succeeded",
  reportedWorkDisposition: "done",
};

function runnerEvent(seed: SeededNativeRun, sourceSeq = 1): PrpEvent {
  return {
    schema: "paperclip.prp.event.v1",
    sourceEventId: `event-${sourceSeq}`,
    sourceSeq,
    sourceInstanceId: seed.runnerInstanceId,
    sourceKind: "runner",
    runId: seed.runId,
    normalizedSessionId: seed.sessionId,
    turnId: "turn-1",
    itemId: "item-1",
    eventType: "turn.started",
    schemaVersion: 1,
    priority: 1,
    emittedAt: "2026-08-25T18:00:00.000Z",
    payload: {},
  };
}

describeEmbeddedPostgres("hidden runner PRP coordinator", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  const scratchDirectories: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-runner-coordinator-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    runnerPrpWebSocketInternals.resetForTests();
    await db.delete(nativeRunFinalizations);
    await db.delete(nativeRunResults);
    await db.delete(heartbeatRunEvents);
    await db.update(issues).set({ executionRunId: null });
    await db.delete(heartbeatRuns);
    await db.delete(completionContracts);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    for (const directory of scratchDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedNativeRun(): Promise<SeededNativeRun> {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const runnerInstanceId = randomUUID();
    const sessionId = randomUUID();
    const completionContractId = randomUUID();
    const completionContractSha256 = `sha256:${"c".repeat(64)}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Runner Test Company",
      issuePrefix: `R${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Codex runner",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `RUN-${runId.slice(0, 8)}`,
      title: "Exercise the hidden native coordinator",
      description: "Verify transport and durable server boundaries.",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    await db.insert(completionContracts).values({
      id: completionContractId,
      companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "policy-v1",
      risk: "low",
      completionAuthority: "runner",
      incompleteCriteriaPolicy: "fail_closed",
      contractJson: { criteria: [] },
      canonicalSha256: completionContractSha256,
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
      runnerInstanceId,
      nativeSessionId: sessionId,
      driverKind: "codex",
      driverVersion: "0.3.0",
      completionContractId,
      completionContractSha256,
      nativePhase: "observed",
    });
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));
    return {
      companyId,
      issueId,
      agentId,
      runId,
      runnerInstanceId,
      sessionId,
      completionContractId,
      completionContractSha256,
    };
  }

  function store(seed: SeededNativeRun): NativeRunCoordinatorStore {
    return new NativeRunCoordinatorStore(db, {
      companyId: seed.companyId,
      issueId: seed.issueId,
      runId: seed.runId,
      agentId: seed.agentId,
      normalizedSessionId: seed.sessionId,
      runnerSourceInstanceId: seed.runnerInstanceId,
      completionContractId: seed.completionContractId,
      completionContractSha256: seed.completionContractSha256,
      completionContractRevision: "1",
      completionContractCriterionIds: [],
    });
  }

  it("registers only an exact Codex native binding and exposes read-only tools", async () => {
    const seed = await seedNativeRun();
    const server = createServer();
    setupRunnerPrpWebSocketServer(server, { apiUrl: "http://127.0.0.1:3213" });
    const stateRoot = mkdtempSync(resolve(tmpdir(), "paperclip-runner-state-"));
    scratchDirectories.push(stateRoot);
    const coordinator = runnerPrpCoordinator(db, { stateRoot });
    await expect(
      coordinator.prepare({
        ...seed,
        companyId: randomUUID(),
        normalizedSessionId: seed.sessionId,
        environmentLeaseId: "environment-lease-1",
        turnId: "turn-1",
        itemId: "item-1",
        runnerVersion: "0.3.0",
        runnerDigest: `sha256:${"a".repeat(64)}`,
      }),
    ).rejects.toThrow("runner_prp_run_not_authorized");
    const prepared = await coordinator.prepare({
      ...seed,
      normalizedSessionId: seed.sessionId,
      environmentLeaseId: "environment-lease-1",
      turnId: "turn-1",
      itemId: "item-1",
      runnerVersion: "0.3.0",
      runnerDigest: `sha256:${"a".repeat(64)}`,
    });

    expect(prepared.connectUrl).toBe(
      `ws://127.0.0.1:3213/api/runner/v1/connect/${seed.runId}`,
    );
    expect(prepared.bootstrapTicket).toMatch(/^bootstrap_/);
    expect(prepared.semanticTools.map((tool) => tool.name)).toEqual([
      "get_task_context",
      "get_task_history",
      "list_documents",
      "read_document",
      "list_document_revisions",
    ]);
    expect(
      runnerPrpWebSocketInternals.activeRegistration({
        companyId: seed.companyId,
        runId: seed.runId,
      }),
    ).toBe(true);
    await expect(
      coordinator.prepare({
        ...seed,
        normalizedSessionId: seed.sessionId,
        environmentLeaseId: "environment-lease-1",
        turnId: "turn-1",
        itemId: "item-1",
        runnerVersion: "0.3.0",
        runnerDigest: `sha256:${"a".repeat(64)}`,
      }),
    ).rejects.toThrow("runner_prp_authority_already_registered");
    await prepared.release();
    expect(
      runnerPrpWebSocketInternals.activeRegistration({
        companyId: seed.companyId,
        runId: seed.runId,
      }),
    ).toBe(false);
    server.close();
  });

  it("rechecks task ownership and returns semantic receipts", async () => {
    const seed = await seedNativeRun();
    const authority = new PaperclipRunnerSemanticAuthority(db, {
      companyId: seed.companyId,
      issueId: seed.issueId,
      runId: seed.runId,
      agentId: seed.agentId,
    });
    const call = {
      callId: "call-1",
      operationId: "get_task_context",
      correlation: {
        runId: seed.runId,
        normalizedSessionId: seed.sessionId,
        turnId: "turn-1",
        itemId: "item-1",
      },
      input: {},
    };
    const allowed = await authority.dispatch(call);
    expect(allowed).toMatchObject({
      ok: true,
      operationId: "get_task_context",
      value: { activeTask: { id: seed.issueId }, run: { id: seed.runId } },
      inputReceipt: { phase: "input" },
      resultReceipt: { phase: "result" },
    });

    await db
      .update(issues)
      .set({ assigneeAgentId: null })
      .where(eq(issues.id, seed.issueId));
    const denied = await authority.dispatch({ ...call, callId: "call-2" });
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "task_ownership_denied", retryable: false },
      resultReceipt: { phase: "result" },
    });
  });

  it("persists events and results idempotently and leases finalization", async () => {
    const seed = await seedNativeRun();
    const nativeStore = store(seed);
    await expect(nativeStore.completeRun({
      result: {
        ...result,
        completionClaim: { ...result.completionClaim, contractRevision: "2" },
      },
      terminal,
    })).rejects.toThrow("native_result_completion_contract_mismatch");
    await expect(nativeStore.completeRun({
      result: {
        ...result,
        completionClaim: {
          ...result.completionClaim,
          criteria: [{
            criterionId: "not-bound",
            status: "satisfied",
            evidenceRefs: [],
          }],
        },
      },
      terminal,
    })).rejects.toThrow("native_result_completion_contract_mismatch");
    const event = runnerEvent(seed);
    await expect(nativeStore.appendEvent(event)).resolves.toMatchObject({
      disposition: "committed",
      cursor: 1,
      highestContiguousSourceSeq: 1,
    });
    await expect(nativeStore.appendEvent(event)).resolves.toMatchObject({
      disposition: "duplicate",
      cursor: 1,
    });
    await expect(
      nativeStore.appendEvent({ ...event, priority: 2 }),
    ).rejects.toThrow("native_event_replay_conflict");
    await expect(nativeStore.appendEvent(runnerEvent(seed, 3))).rejects.toThrow(
      "native_event_source_gap",
    );

    const resultEvent = {
      ...runnerEvent(seed, 2),
      eventType: "run.result.proposed",
      payload: result,
    } as PrpEvent;
    const terminalEvent = {
      ...runnerEvent(seed, 3),
      eventType: "run.terminal",
      payload: terminal,
    } as PrpEvent;
    await nativeStore.appendEvent(resultEvent);
    await nativeStore.appendEvent(terminalEvent);
    const firstResult = await nativeStore.reconcileTerminalEvent(terminalEvent);
    if (!firstResult)
      throw new Error("terminal reconciliation returned no result");
    expect(firstResult.disposition).toBe("committed");
    await expect(nativeStore.appendEvent(event)).resolves.toMatchObject({
      disposition: "duplicate",
      highestContiguousSourceSeq: 3,
    });
    await expect(
      nativeStore.completeRun({
        result,
        terminal,
        turnId: "turn-1",
        callerDedupeKey: "result-1",
      }),
    ).resolves.toEqual({ ...firstResult, disposition: "duplicate" });
    await expect(
      nativeStore.completeRun({
        result: { ...result, summary: "Conflicting retry" },
        terminal,
        turnId: "turn-1",
        callerDedupeKey: "result-1",
      }),
    ).rejects.toThrow("native_result_replay_conflict");

    await expect(
      nativeStore.claimFinalization({ leaseOwner: "server-1" }),
    ).resolves.toMatchObject({ attempt: 1, resultId: firstResult.resultId });
    await expect(
      nativeStore.claimFinalization({ leaseOwner: "server-1" }),
    ).resolves.toMatchObject({ attempt: 1, resultId: firstResult.resultId });
    await expect(
      nativeStore.claimFinalization({ leaseOwner: "server-2" }),
    ).rejects.toThrow("native_finalization_lease_conflict");
    await nativeStore.markFinalizationRetry({
      leaseOwner: "server-1",
      failureCode: "workspace_busy",
      retryAfterMs: 1_000,
    });
    await expect(
      nativeStore.claimFinalization({ leaseOwner: "server-2" }),
    ).rejects.toThrow("native_finalization_retry_not_due");
    await db
      .update(nativeRunFinalizations)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(nativeRunFinalizations.runId, seed.runId));
    await expect(
      nativeStore.claimFinalization({ leaseOwner: "server-2" }),
    ).resolves.toMatchObject({ attempt: 2, resultId: firstResult.resultId });
  });
});
