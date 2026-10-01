import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
  heartbeatRuns,
  agentWakeupRequests,
  statusDecisions,
  issueComments,
  issueThreadInteractions,
} from "@paperclipai/db";
import {
  startEmbeddedPostgresTestDatabase,
  getEmbeddedPostgresTestSupport,
} from "../src/__tests__/helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "../src/__tests__/helpers/drain-heartbeat-runs.js";
import type {
  NativeExecutionInput,
  NativeSessionBackend,
  NativeSession,
} from "@paperclipai/paperclip-runner";
import {
  CONTROL_PLANE_CONFORMANCE_RESULT,
  CONTROL_PLANE_CONFORMANCE_TERMINAL,
} from "../src/vendor/paperclip-runner/testing.js";
import { observe } from "../../tests/lifecycle-baseline/observe.js";
import { PaperclipRunnerToolAuthority } from "../src/services/native-runtime/paperclip-runner-tool-authority.js";
import { issueThreadInteractionService } from "../src/services/issue-thread-interactions.js";
import { questionResponseDeliveryService } from "../src/services/question-response-delivery.js";
const execute = vi.hoisted(() => vi.fn());
vi.mock("../src/adapters/index.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute }),
}));
vi.mock("../src/telemetry.js", () => ({
  getTelemetryClient: () => ({
    track: vi.fn(),
    trackDynamic: vi.fn(),
    hashPrivateRef: (value: string) => value,
  }),
}));
import {
  heartbeatService,
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS,
} from "../src/services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported)
  throw new Error(
    `BASELINE_PREREQUISITE: embedded Postgres unavailable: ${support.reason}`,
  );

describe("LCA full heartbeat observation", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let workspace: string;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("lifecycle-baseline-");
    db = createDb(temporary.connectionString);
    workspace = await mkdtemp(join(tmpdir(), "lifecycle-provider-fixture-"));
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  async function run(
    mode: "native" | "legacy",
    summary: string,
    complete: boolean,
    requiredTurns = 2,
    taskInput: { title?: string; description?: string; workMode?: "standard" | "planning" } = {},
  ) {
    const companyId = randomUUID(),
      agentId = randomUUID(),
      issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Lifecycle fixture",
      issuePrefix: `L${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: "fixture-owner",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Fixture worker",
      role: "engineer",
      status: "idle",
      adapterType: mode === "native" ? "paperclip_runner" : "codex_local",
      adapterConfig: { cwd: workspace, provider: "codex" },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Implement export",
      ...taskInput,
      status: "in_progress",
      assigneeAgentId: agentId,
      responsibleUserId: "fixture-owner",
    });
    let operations = 0;
    let providerTurns = 0;
    execute.mockImplementation(async () => {
      providerTurns++;
      if (complete || providerTurns >= requiredTurns) {
        operations++;
        await db
          .update(issues)
          .set({ status: "done" })
          .where(eq(issues.id, issueId));
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary,
        resultJson: { summary },
        provider: "fixture",
        model: "fixture",
      };
    });
    const backendFactory = (
      input: NativeExecutionInput,
    ): NativeSessionBackend => {
      const capabilities = {
        resume: true,
        typedEvents: true,
        steering: false,
        interruption: true,
        structuredResult: true,
      };
      let start!: () => void;
      const started = new Promise<void>((resolve) => {
        start = resolve;
      });
      const turnId = `turn:${input.binding.runId}`;
      const sessionId = input.session.normalizedSessionId;
      if (!sessionId)
        throw new Error("Fixture requires server-bound session identity");
      const identity = { ...input.binding, sessionId };
      const result = structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT);
      result.summary = summary;
      const contract = input.completionContract.contract;
      result.completionClaim.contractRevision = contract.revision;
      result.completionClaim.criteria = contract.criteria.map((c) => ({
        criterionId: c.id,
        status: "satisfied",
        evidenceRefs: [],
      }));
      result.evidence = [];
      result.verification = [];
      if (!complete && providerTurns < requiredTurns - 1) {
        result.reportedWorkDisposition = "yielded";
        result.completionClaim.objectiveSatisfied = false;
        result.completionClaim.criteria = contract.criteria.map((c) => ({
          criterionId: c.id,
          status: "not_satisfied",
          evidenceRefs: [],
        }));
        result.completionClaim.remainingWork = [
          {
            description: "Perform the second fixture step",
            blocksCompletion: true,
          },
        ];
        result.continuation = {
          kind: "response_wake",
          summary: "Perform the second fixture step",
          idempotencyKey: `step:${issueId}:${providerTurns + 1}`,
        };
      }
      const session: NativeSession = {
        identity: () => identity,
        capabilities: async () => capabilities,
        async startTurn() {
          providerTurns++;
          operations++;
          if (result.reportedWorkDisposition === "yielded") {
            await new PaperclipRunnerToolAuthority(db, input.binding).execute({
              tool: "request_human_input", callId: `step-${providerTurns}`,
              arguments: {
                interactionKind: "questions", idempotencyKey: `step-${providerTurns}`,
                title: `Input for step ${providerTurns + 1}`, prompt: "Choose the next step",
                continuationPolicy: "wake_assignee",
                payload: { version: 1, questions: [{
                  id: "next", prompt: "Choose the next step", selectionMode: "single", required: true,
                  options: [{ id: "continue", label: "Continue" }, { id: "revise", label: "Revise" }],
                }] },
              },
            });
          }
          start();
          return { turnId };
        },
        async *events() {
          await started;
          const [row] = await db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, input.binding.runId));
          yield {
            schema: "paperclip.prp.event.v1",
            sourceEventId: `${row.runnerInstanceId}:terminal`,
            sourceSeq: 1,
            sourceInstanceId: row.runnerInstanceId!,
            sourceKind: "runner",
            runId: input.binding.runId,
            normalizedSessionId: identity.sessionId,
            turnId,
            eventType: "turn.completed",
            schemaVersion: 1,
            priority: 0,
            emittedAt: new Date().toISOString(),
            payload: {},
          };
        },
        result: async () => ({
          result,
          terminal: {
            ...CONTROL_PLANE_CONFORMANCE_TERMINAL,
            reportedWorkDisposition: result.reportedWorkDisposition,
          },
          turnId,
        }),
        snapshot: async () => ({
          backendKind: "mock",
          sessionId: identity.sessionId,
          identity,
          providerSessionId: "fixture",
          cursor: "1",
          activeTurnId: null,
          pendingRuntimeRequests: [],
          lineage: [],
        }),
        async close() {},
      };
      return {
        descriptor: async () => ({
          kind: "mock",
          name: "lifecycle-fixture",
          version: "1",
          capabilities,
          runtimeContextCapabilities: {
            instructions: "native",
            skills: "native",
            mcp: "native",
          },
        }),
        openSession: async () => session,
        recoverSession: async () => ({ recovered: true, session }),
      };
    };
    const heartbeat = heartbeatService(db, {
      nativeSessionBackendFactory: backendFactory,
    });
    try {
      await heartbeat.invoke(
        agentId,
        "on_demand",
        { issueId, skipIssueComment: true },
        "manual",
      );
      await heartbeat.drainActiveRunExecutions();
      const collect = async () => {
        const [issue] = await db
          .select()
          .from(issues)
          .where(eq(issues.id, issueId));
        const runs = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.companyId, companyId));
        const wakes = await db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.companyId, companyId));
        const decisions = await db
          .select()
          .from(statusDecisions)
          .where(eq(statusDecisions.companyId, companyId));
        return {
          issue: { status: issue.status, locked: !!issue.executionRunId },
          workMode: issue.workMode,
          runs: runs.map((r) => ({
            status: r.status,
            runtimeMode: r.runtimeMode,
            errorCode: r.errorCode,
            livenessState: r.livenessState,
            repairAttempt: r.contextSnapshot?.dispositionRepairAttempt ?? null,
            repairMaxAttempts: r.contextSnapshot?.dispositionRepairMaxAttempts ?? null,
            repairInstruction: r.contextSnapshot?.dispositionRepairInstruction ?? null,
          })),
          wakes: wakes
            .map((w) => ({ reason: w.reason, status: w.status }))
            .sort((a, b) => String(a.reason).localeCompare(String(b.reason))),
          decisionCount: decisions.length,
          operations,
          providerTurns,
        };
      };
      const first = await collect();
      if (mode === "native" && !complete) {
        for (let step = 1; step < requiredTurns; step++) {
          const pending = (await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId)))
            .filter(interaction => interaction.status === "pending");
          expect(pending).toHaveLength(1);
          expect(providerTurns).toBe(step);
          // A real persisted response, not summary text, owns the next run.
          await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
          await heartbeat.drainActiveRunExecutions();
          expect(providerTurns).toBe(step);
          await issueThreadInteractionService(db).answerQuestions({ id: issueId, companyId }, pending[0].id,
            { answers: [{ questionId: "next", optionIds: ["continue"] }] }, { userId: "fixture-owner" });
          const delivery = questionResponseDeliveryService(db, { heartbeat });
          const delivered = await delivery.deliver(pending[0].id);
          await heartbeat.drainActiveRunExecutions();
          // Replayed delivery cannot create a duplicate successor.
          await delivery.deliver(pending[0].id);
          await heartbeat.drainActiveRunExecutions();
          expect(providerTurns, JSON.stringify({ delivered, state: await collect() })).toBe(step + 1);
        }
      }
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      const settled = await collect();
      observe(complete ? "LCA-01" : "LCA-02", `${mode}:${summary}`, {
        first,
        settled,
      });
      expect(settled.runs.length, JSON.stringify(settled)).toBeGreaterThan(0);
      expect(
        settled.runs.every((r) => r.runtimeMode === mode),
        JSON.stringify(settled),
      ).toBe(true);
      expect(
        settled.runs.every((r) => r.status === "succeeded"),
        JSON.stringify(settled),
      ).toBe(true);
      return settled;
    } finally {
      // Observations and assertions above precede cleanup cancellation.
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
    }
  }
  it.each(["native", "legacy"] as const)(
    "LCA-01 %s completed work has no extra execution regardless of summary",
    async (mode) => {
      const neutral = await run(mode, "Completed requested work.", true);
      const misleading = await run(
        mode,
        "No approval required. I will inspect optional next steps.",
        true,
      );
      for (const observed of [neutral, misleading]) {
        expect(observed.issue).toEqual({ status: "done", locked: false });
        expect(observed.operations).toBe(1);
        expect(observed.providerTurns).toBe(1);
      }
      expect(misleading.wakes).toEqual(neutral.wakes);
    },
  );
  it("LCA-02 native answered-question continuation survives misleading approval prose", async () => {
    const neutral = await run("native", "First step recorded.", false);
    const misleading = await run(
      "native",
      "No approval required. I will inspect optional next steps.",
      false,
    );
    for (const observed of [neutral, misleading]) {
      expect(observed.issue).toEqual({ status: "done", locked: false });
      expect(observed.providerTurns).toBe(2);
      expect(observed.operations).toBe(2);
    }
    expect(misleading.wakes).toEqual(neutral.wakes);
  });
  it("LCA-02 legacy incomplete work schedules the same follow-up regardless of approval wording", async () => {
    const neutral = await run(
      "legacy",
      "I will inspect the repository and run tests.",
      false,
    );
    const misleading = await run(
      "legacy",
      "No approval required. I will inspect the repository and run tests.",
      false,
    );
    expect(neutral.providerTurns).toBe(2);
    expect(neutral.issue).toEqual({ status: "done", locked: false });
    expect(misleading.providerTurns).toBe(2);
    expect(misleading.wakes).toEqual(neutral.wakes);
    expect(misleading.issue).toEqual(neutral.issue);
    const repairs = (observed: typeof neutral) => observed.runs.filter(r => r.repairAttempt !== null)
      .map(({ repairAttempt, repairMaxAttempts, repairInstruction }) => ({ repairAttempt, repairMaxAttempts, repairInstruction }));
    expect(repairs(neutral)).toMatchObject([{ repairAttempt: 1, repairMaxAttempts: 2 }]);
    expect(repairs(misleading)).toEqual(repairs(neutral));
  });
  it.each(["standard", "planning"] as const)("LCA-05 legacy %s mode survives wording changes through heartbeat and repair", async (workMode) => {
    const summary = "I will inspect the repository next.";
    const neutral = await run("legacy", summary, false, 2, { workMode, title: "Inspect exporter", description: "Describe the changes." });
    const challenge = await run("legacy", summary, false, 2, { workMode, title: "Making a plan", description: "Create a research report and plan." });
    for (const observed of [neutral, challenge]) {
      expect(observed.providerTurns).toBe(2);
      expect(observed.issue).toEqual({ status: "done", locked: false });
      expect(observed.workMode).toBe(workMode);
    }
    expect(challenge.wakes).toEqual(neutral.wakes);
    // A successor can finish before its predecessor's diagnostic projection.
    // Compare the durable continuation effects, not that asynchronous view.
    const effects = (observed: typeof neutral) => observed.runs
      .map(({ livenessState: _diagnostic, ...effect }) => effect)
      .sort((a, b) => Number(a.repairAttempt) - Number(b.repairAttempt));
    expect(effects(challenge)).toEqual(effects(neutral));
  });
  it("LCA-02 native answered-question workflow continues beyond the failure retry allowance", async () => {
    const steps = BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length + 2;
    const observed = await run(
      "native",
      "Step recorded; continue.",
      false,
      steps,
    );
    expect(observed.issue).toEqual({ status: "done", locked: false });
    expect(observed.providerTurns).toBe(steps);
    expect(observed.operations).toBe(steps);
  });
  it.each([
    ["native", "paused"],
    ["legacy", "paused"],
    ["native", "budget"],
    ["legacy", "budget"],
  ] as const)(
    "LCA-04 LCA-10 %s accepted approval preserves the %s admission gate",
    async (mode, gate) => {
      const companyId = randomUUID(),
        agentId = randomUUID(),
        issueId = randomUUID(),
        interactionId = randomUUID();
      await db
        .insert(companies)
        .values({
          id: companyId,
          name: "Approval gate fixture",
          issuePrefix: `G${companyId.slice(0, 6)}`,
        });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Fixture worker",
        role: "engineer",
        status: gate === "paused" ? "paused" : "idle",
        adapterType: mode === "native" ? "paperclip_runner" : "codex_local",
        adapterConfig: { cwd: workspace, provider: "codex" },
        runtimeConfig: {
          heartbeat: {
            enabled: false,
            wakeOnDemand: true,
            ...(gate === "budget" ? { maxDailyCostCents: 0 } : {}),
          },
        },
      });
      await db
        .insert(issues)
        .values({
          id: issueId,
          companyId,
          title: "Approved work",
          status: "in_review",
          assigneeAgentId: agentId,
        });
      const resolvedAt = new Date();
      await db.insert(issueThreadInteractions).values({
        id: interactionId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee",
        payload: { version: 1, prompt: "Proceed with the scoped work?" },
        result: { version: 1, outcome: "accepted" },
        createdByAgentId: agentId,
        resolvedByUserId: "fixture-owner",
        resolvedAt,
      });
      const heartbeat = heartbeatService(db);
      execute.mockClear();
      try {
        const run = await heartbeat
          .wakeup(agentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_commented",
            requestedByActorType: "user",
            requestedByActorId: "fixture-owner",
            payload: {
              issueId,
              interactionId,
              interactionKind: "request_confirmation",
              interactionStatus: "accepted",
              mutation: "interaction",
            },
            contextSnapshot: {
              issueId,
              taskId: issueId,
              interactionId,
              interactionKind: "request_confirmation",
              interactionStatus: "accepted",
              interactionResolvedAt: resolvedAt.toISOString(),
              mutation: "interaction",
              source: "request_confirmation.resolved",
            },
          })
          .catch((error: unknown) => {
            if (gate !== "paused") throw error;
            expect(error).toMatchObject({
              status: 409,
              message: "Agent is not invokable in its current state",
            });
            return null;
          });
        await heartbeat.drainActiveRunExecutions();
        const runs = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.companyId, companyId));
        observe("LCA-04", `${mode}:approved:${gate}`, {
          admitted: run !== null,
          runs: runs.map((r) => ({ status: r.status, errorCode: r.errorCode })),
          invocations: execute.mock.calls.length,
        });
        expect(run).toBeNull();
        expect(runs).toHaveLength(0);
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
      }
    },
  );
  it("LCA-09 exhausted recovery ignores commentary but admits a new user request", async () => {
    const companyId = randomUUID(),
      agentId = randomUUID(),
      issueId = randomUUID(),
      sourceRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Exhausted fixture",
      issuePrefix: `E${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: "fixture-owner",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Fixture worker",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { cwd: workspace },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Continue export",
      status: "in_progress",
      assigneeAgentId: agentId,
      responsibleUserId: "fixture-owner",
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "failed",
      error: "Transient fixture failure",
      errorCode: "adapter_failed",
      resultJson: {
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      },
      finishedAt: new Date(),
      scheduledRetryAttempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: { issueId, wakeReason: "transient_failure_retry" },
    });
    const heartbeat = heartbeatService(db);
    execute.mockClear();
    execute.mockImplementation(async () => {
      await db
        .update(issues)
        .set({ status: "done" })
        .where(eq(issues.id, issueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "New request completed.",
      };
    });
    try {
      const before = await heartbeat.scheduleBoundedRetry(sourceRunId, {
        now: new Date(),
        random: () => 0,
      });
      await db.insert(issueComments).values({
        id: randomUUID(),
        companyId,
        issueId,
        authorAgentId: agentId,
        body: "I will inspect the repository. No approval required.",
      });
      const afterComment = await heartbeat.scheduleBoundedRetry(sourceRunId, {
        now: new Date(),
        random: () => 0,
      });
      expect(before).toMatchObject({ outcome: "retry_exhausted" });
      expect(afterComment).toEqual(before);
      expect(execute).not.toHaveBeenCalled();
      const commentId = randomUUID();
      await db.insert(issueComments).values({
        id: commentId,
        companyId,
        issueId,
        authorUserId: "fixture-owner",
        body: "Please continue this task now.",
      });
      await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "issue_comment_created",
        requestedByActorType: "user",
        requestedByActorId: "fixture-owner",
        payload: { issueId, commentId },
        contextSnapshot: { issueId, taskId: issueId, wakeCommentId: commentId },
      });
      await heartbeat.drainActiveRunExecutions();
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, companyId));
      const fresh = runs.filter((r) => r.id !== sourceRunId);
      observe("LCA-09", "exhausted-comment-versus-user-request", {
        before,
        afterComment,
        runs: runs.map((r) => ({
          status: r.status,
          retryOfRunId: r.retryOfRunId,
          scheduledRetryAttempt: r.scheduledRetryAttempt,
        })),
        invocations: execute.mock.calls.length,
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(fresh).toHaveLength(1);
      expect(fresh[0]).toMatchObject({
        status: "succeeded",
        retryOfRunId: null,
      });
      expect(
        runs.find((r) => r.id === sourceRunId)?.scheduledRetryAttempt,
      ).toBe(BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length);
    } finally {
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
    }
  });
});
