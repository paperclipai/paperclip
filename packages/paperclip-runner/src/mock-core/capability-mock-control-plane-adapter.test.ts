import { describe, expect, it, vi } from "vitest";

import {
  CONTROL_PLANE_CONFORMANCE_OPEN,
  runControlPlanePortConformance,
} from "../conformance/control-plane-port.js";
import type { CapabilityFixtureSeed } from "./capability-control-plane-types.js";
import {
  CapabilityMockControlPlaneAdapter,
  CapabilityMockControlPlaneError,
} from "./capability-mock-control-plane-adapter.js";

const OPEN = {
  identity: {
    runId: "run-1",
    sessionId: "session-1",
    companyId: "company-1",
    issueId: "task-1",
    agentId: "actor-1",
  },
  backendKind: "mock" as const,
  sourceInstanceId: "fixture-source",
};

function seeded(seed: CapabilityFixtureSeed = {}) {
  return new CapabilityMockControlPlaneAdapter({
    workspaceServices: [
      {
        id: "service-1",
        taskId: "task-1",
        name: "preview",
        status: "stopped",
        url: null,
        lastTransitionAt: "2026-08-09T00:00:00.000Z",
      },
    ],
    ...seed,
  });
}

describe("CapabilityMockControlPlaneAdapter", () => {
  it("produces deterministic immutable context and state across every fixture domain", async () => {
    const runScenario = async () => {
      const adapter = seeded();
      await adapter.start();
      const context = await adapter.openFixtureRun({
        ...OPEN,
        wake: {
          reason: "issue_commented",
          payload: {
            commentId: "comment-wake",
            apiKey: "must-not-be-visible",
            nested: { authorization: "Bearer must-not-be-visible" },
          },
        },
        capabilities: [
          "control_plane:wakes",
          "governance:approvals:comment",
          "governance:approvals:request",
          "workspace:control",
          "task:write",
          "task:write",
        ],
      });
      expect(context.capabilities).toEqual([
        "control_plane:wakes",
        "governance:approvals:comment",
        "governance:approvals:request",
        "task:write",
        "workspace:control",
      ]);
      expect(context.wake.payload).toEqual({
        commentId: "comment-wake",
        apiKey: "[REDACTED]",
        nested: { authorization: "[REDACTED]" },
      });

      await adapter.applyCommand({
        runId: "run-1",
        idempotencyKey: "progress-1",
        command: { kind: "report_progress", body: "Fixture work started." },
      });
      const documentResult = await adapter.applyCommand({
        runId: "run-1",
        idempotencyKey: "document-1",
        command: {
          kind: "write_document",
          key: "plan",
          title: "Plan",
          body: "# Deterministic plan",
          baseRevisionId: null,
        },
      });
      const revisionId = documentResult.entityRefs
        .find((ref) => ref.startsWith("revision:"))!
        .slice("revision:".length);
      await adapter.applyCommand({
        runId: "run-1",
        idempotencyKey: "interaction-1",
        command: {
          kind: "request_human_input",
          interactionKind: "confirmation",
          title: "Confirm plan",
          prompt: "Accept the deterministic plan?",
          targetRevisionId: revisionId,
          continuationPolicy: "wake_assignee",
        },
      });
      await adapter.applyCommand({
        runId: "run-1",
        idempotencyKey: "artifact-1",
        command: {
          kind: "register_deliverable",
          filename: "report.json",
          contentType: "application/json",
          byteSize: 42,
          sha256: "sha256-fixture",
          contentRef: "fixture://artifacts/report.json",
          title: "Fixture report",
        },
      });
      const approvalResult = await adapter.applyCommand({
        runId: "run-1",
        idempotencyKey: "approval-1",
        command: {
          kind: "request_approval",
          approvalType: "request_board_approval",
          payload: { summary: "Approve fixture action" },
        },
      });
      const approvalId = approvalResult.entityRefs
        .find((ref) => ref.startsWith("approval:"))!
        .slice("approval:".length);
      await adapter.applyCommand({
        runId: "run-1",
        idempotencyKey: "approval-comment-1",
        command: {
          kind: "comment_on_approval",
          approvalId,
          body: "Deterministic approval context.",
        },
      });
      await adapter.applyCommand({
        runId: "run-1",
        idempotencyKey: "workspace-1",
        command: {
          kind: "control_workspace_service",
          serviceId: "service-1",
          action: "start",
          url: "http://fixture.invalid",
        },
      });
      await adapter.applyCommand({
        runId: "run-1",
        idempotencyKey: "wake-1",
        command: {
          kind: "schedule_wake",
          reason: "scheduled_retry",
          payload: { attempt: 2 },
          delayTicks: 3,
        },
      });
      return { adapter, snapshot: adapter.snapshot() };
    };

    const left = await runScenario();
    const right = await runScenario();
    expect(left.adapter.serialize()).toBe(right.adapter.serialize());
    expect(left.snapshot).toMatchObject({
      schema: "paperclip.capability.mock-state.v1",
      comments: [{ body: "Fixture work started." }],
      documents: [{ key: "plan", revisions: [{ revision: 1 }] }],
      interactions: [{ kind: "confirmation", status: "pending" }],
      approvals: [{
        type: "request_board_approval",
        status: "pending",
        comments: [{ body: "Deterministic approval context." }],
      }],
      artifacts: [{ filename: "report.json" }],
      workProducts: [{ type: "artifact" }],
      workspaceServices: [{ id: "service-1", status: "running" }],
      wakes: [{ reason: "scheduled_retry", status: "scheduled" }],
    });
    expect(Object.isFrozen(left.snapshot)).toBe(true);
    expect(Object.isFrozen(left.snapshot.tasks)).toBe(true);
    expect(left.snapshot.audit.length).toBeGreaterThanOrEqual(7);
    expect(left.adapter.decisionRecords().every((decision) => Object.isFrozen(decision))).toBe(true);
  });

  it("commits a lost-ack command once and returns its stored result on retry", async () => {
    const adapter = seeded({
      faults: [
        {
          id: "lost-progress-ack",
          operation: "apply_command",
          commandKind: "report_progress",
          effect: "lost_ack",
          remaining: 1,
          code: "fixture_ack_lost",
        },
      ],
    });
    await adapter.start();
    await adapter.openFixtureRun(OPEN);
    const envelope = {
      runId: "run-1",
      idempotencyKey: "progress-retry",
      command: { kind: "report_progress" as const, body: "Exactly once." },
    };

    await expect(adapter.applyCommand(envelope)).rejects.toMatchObject({
      code: "fixture_ack_lost",
      retryable: true,
    });
    const replayed = await adapter.applyCommand(envelope);
    expect(replayed.disposition).toBe("duplicate");
    expect(adapter.snapshot().comments.filter((comment) => comment.body === "Exactly once.")).toHaveLength(1);
    expect(adapter.decisionRecords().map((decision) => decision.outcome)).toContain("faulted");
    expect(adapter.decisionRecords().map((decision) => decision.outcome)).toContain("duplicate");

    await expect(
      adapter.applyCommand({
        ...envelope,
        command: { kind: "report_progress", body: "Mutated retry." },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("serializes, restores, and replays gapped events without a live service", async () => {
    const adapter = seeded();
    await adapter.start();
    await adapter.openFixtureRun(OPEN);
    const event = (sourceSeq: number) => ({
      schema: "paperclip.prp.event.v1" as const,
      sourceEventId: `fixture-source:event:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: "fixture-source",
      sourceKind: "runner" as const,
      runId: "run-1",
      normalizedSessionId: "session-1",
      turnId: "turn-1",
      eventType: "session.started" as const,
      schemaVersion: 1 as const,
      priority: 1 as const,
      emittedAt: `2026-08-09T00:00:0${sourceSeq}.000Z`,
      payload: {},
    });
    expect((await adapter.appendEvent(event(2))).highestContiguousSourceSeq).toBe(0);
    expect((await adapter.appendEvent(event(1))).highestContiguousSourceSeq).toBe(2);

    const restored = CapabilityMockControlPlaneAdapter.restore(adapter.serialize());
    const replay = await restored.replayEvents({
      runId: "run-1",
      sourceInstanceId: "fixture-source",
      afterSourceSeq: 0,
      limit: 10,
    });
    expect(replay.events.map((entry) => entry.sourceSeq)).toEqual([1, 2]);
    expect(replay.highestContiguousSourceSeq).toBe(2);
    expect(restored.context("run-1")).toEqual(adapter.context("run-1"));
  });

  it("reconciles terminal state, releases locks, and schedules dependent wakes", async () => {
    const adapter = new CapabilityMockControlPlaneAdapter({
      tasks: [
        {
          id: "task-1",
          companyId: "company-1",
          identifier: "MCK-1",
          title: "Blocking task",
          description: null,
          status: "todo",
          priority: "high",
          workMode: "standard",
          parentId: null,
          assigneeActorId: "actor-1",
          checkoutRunId: null,
          executionRunId: null,
          startedAt: null,
          completedAt: null,
        },
        {
          id: "task-2",
          companyId: "company-1",
          identifier: "MCK-2",
          title: "Dependent task",
          description: null,
          status: "blocked",
          priority: "high",
          workMode: "standard",
          parentId: null,
          assigneeActorId: "actor-1",
          checkoutRunId: null,
          executionRunId: null,
          startedAt: null,
          completedAt: null,
        },
      ],
      blockers: [
        {
          id: "blocker-1",
          taskId: "task-2",
          blockedByTaskId: "task-1",
          createdAt: "2026-08-09T00:00:00.000Z",
        },
      ],
    });
    await adapter.start();
    await adapter.openFixtureRun(OPEN);
    await adapter.applyCommand({
      runId: "run-1",
      idempotencyKey: "finish-1",
      command: { kind: "finish_task", summary: "Blocking work completed." },
    });

    const terminal = {
      schema: "paperclip.prp.terminal.v1" as const,
      turnTerminalState: "completed" as const,
      runTerminalState: "succeeded" as const,
      reportedWorkDisposition: "done" as const,
    };
    const result = {
      schema: "paperclip.run_result.v1" as const,
      reportedWorkDisposition: "done" as const,
      summary: "Blocking work completed.",
      completionClaim: {
        contractRevision: "capability-v1",
        objectiveSatisfied: true,
        criteria: [{ criterionId: "objective", status: "satisfied" as const, evidenceRefs: [] }],
        remainingWork: [],
      },
      evidence: [],
      verification: [],
      attentionRequests: [],
      artifacts: [],
    };
    await adapter.appendEvent({
      schema: "paperclip.prp.event.v1",
      sourceEventId: "fixture-source:terminal:1",
      sourceSeq: 1,
      sourceInstanceId: "fixture-source",
      sourceKind: "runner",
      runId: "run-1",
      normalizedSessionId: "session-1",
      turnId: "turn-1",
      eventType: "run.terminal",
      schemaVersion: 1,
      priority: 0,
      emittedAt: "2026-08-09T00:00:10.000Z",
      payload: terminal,
    });
    await adapter.completeRun({ result, terminal });

    const snapshot = adapter.snapshot();
    expect(snapshot.tasks.find((task) => task.id === "task-1")).toMatchObject({
      status: "done",
      checkoutRunId: null,
      executionRunId: null,
    });
    expect(snapshot.tasks.find((task) => task.id === "task-2")?.status).toBe("todo");
    expect(snapshot.blockers).toEqual([]);
    expect(snapshot.wakes).toMatchObject([
      { taskId: "task-2", reason: "blockers_resolved", status: "scheduled" },
    ]);
    expect(snapshot.runs[0]?.status).toBe("succeeded");
  });

  it("enforces budget hard stops and releases run authority", async () => {
    const adapter = seeded({
      budgets: [
        {
          id: "budget-company-1",
          scope: "company",
          scopeId: "company-1",
          limitCents: 100,
          spentCents: 90,
          hardStop: true,
        },
        {
          id: "budget-actor-1",
          scope: "actor",
          scopeId: "actor-1",
          limitCents: 100,
          spentCents: 90,
          hardStop: true,
        },
      ],
    });
    await adapter.start();
    await adapter.openFixtureRun({ ...OPEN, capabilities: ["control_plane:budget"] });
    await adapter.applyCommand({
      runId: "run-1",
      idempotencyKey: "usage-1",
      command: { kind: "record_budget_usage", cents: 10 },
    });
    const snapshot = adapter.snapshot();
    expect(snapshot.actors[0]?.status).toBe("paused");
    expect(snapshot.runs[0]?.status).toBe("budget_stopped");
    expect(snapshot.tasks[0]).toMatchObject({
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
    });
    await expect(
      adapter.applyCommand({
        runId: "run-1",
        idempotencyKey: "after-budget-stop",
        command: { kind: "report_progress", body: "Should not be accepted." },
      }),
    ).rejects.toMatchObject({ code: "budget_hard_stop" });
  });

  it("returns typed denials when a command claim is missing", async () => {
    const adapter = seeded();
    await adapter.start();
    await adapter.openFixtureRun(OPEN);

    const outcome = await adapter.tryApplyCommand({
      runId: "run-1",
      idempotencyKey: "workspace-without-claim",
      command: {
        kind: "control_workspace_service",
        serviceId: "service-1",
        action: "start",
      },
    });

    expect(outcome).toEqual({
      ok: false,
      commandKind: "control_workspace_service",
      stateRevision: 2,
      error: {
        code: "operation_not_authorized",
        message: "the fixture run does not hold the required command claim",
        retryable: false,
      },
    });
    expect(adapter.snapshot().workspaceServices[0]?.status).toBe("stopped");
    expect(adapter.decisionRecords().at(-1)).toMatchObject({
      operation: "control_workspace_service",
      outcome: "denied",
      reason: "required_claim_missing",
    });
  });

  it("enforces active-task ownership and legal transitions", async () => {
    const adapter = seeded({
      tasks: [
        {
          id: "task-1",
          companyId: "company-1",
          identifier: "MCK-1",
          title: "Active task",
          description: null,
          status: "todo",
          priority: "high",
          workMode: "standard",
          parentId: null,
          assigneeActorId: "actor-1",
          checkoutRunId: null,
          executionRunId: null,
          startedAt: null,
          completedAt: null,
        },
        {
          id: "task-2",
          companyId: "company-1",
          identifier: "MCK-2",
          title: "Other task",
          description: null,
          status: "todo",
          priority: "low",
          workMode: "standard",
          parentId: null,
          assigneeActorId: "actor-1",
          checkoutRunId: null,
          executionRunId: null,
          startedAt: null,
          completedAt: null,
        },
      ],
    });
    await adapter.start();
    await adapter.openFixtureRun(OPEN);

    await expect(adapter.tryApplyCommand({
      runId: "run-1",
      idempotencyKey: "cross-task-write",
      command: { kind: "report_progress", taskId: "task-2", body: "Not allowed." },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "task_scope_violation" },
    });

    await adapter.applyCommand({
      runId: "run-1",
      idempotencyKey: "review-once",
      command: { kind: "request_review", summary: "Ready for review." },
    });
    await expect(adapter.tryApplyCommand({
      runId: "run-1",
      idempotencyKey: "review-twice",
      command: { kind: "request_review", summary: "Still ready." },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "task_transition_illegal" },
    });
    expect(adapter.snapshot().comments.map((comment) => comment.body)).toEqual([
      "Ready for review.",
    ]);
  });

  it("rejects stale interaction targets and invalid interaction outcomes", async () => {
    const adapter = seeded();
    await adapter.start();
    await adapter.openFixtureRun({
      ...OPEN,
      capabilities: ["control_plane:interactions"],
    });
    const first = await adapter.applyCommand({
      runId: "run-1",
      idempotencyKey: "plan-v1",
      command: {
        kind: "write_document",
        key: "plan",
        title: "Plan",
        body: "Version one",
        baseRevisionId: null,
      },
    });
    const firstRevisionId = first.entityRefs.find((ref) => ref.startsWith("revision:"))!.slice(9);
    const second = await adapter.applyCommand({
      runId: "run-1",
      idempotencyKey: "plan-v2",
      command: {
        kind: "write_document",
        key: "plan",
        title: "Plan",
        body: "Version two",
        baseRevisionId: firstRevisionId,
      },
    });
    const secondRevisionId = second.entityRefs.find((ref) => ref.startsWith("revision:"))!.slice(9);

    await expect(adapter.tryApplyCommand({
      runId: "run-1",
      idempotencyKey: "stale-confirmation",
      command: {
        kind: "request_human_input",
        interactionKind: "confirmation",
        title: "Confirm",
        prompt: "Accept?",
        targetRevisionId: firstRevisionId,
        continuationPolicy: "wake_assignee",
      },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "interaction_target_stale" },
    });

    const interaction = await adapter.applyCommand({
      runId: "run-1",
      idempotencyKey: "current-confirmation",
      command: {
        kind: "request_human_input",
        interactionKind: "confirmation",
        title: "Confirm",
        prompt: "Accept?",
        targetRevisionId: secondRevisionId,
        continuationPolicy: "wake_assignee",
      },
    });
    const interactionId = interaction.entityRefs.find((ref) => ref.startsWith("interaction:"))!.slice(12);
    await expect(adapter.tryApplyCommand({
      runId: "run-1",
      idempotencyKey: "invalid-confirmation-answer",
      command: {
        kind: "resolve_human_input",
        interactionId,
        outcome: "answered",
        result: { answer: "yes" },
      },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "interaction_outcome_invalid" },
    });
  });

  it("performs complete mock operations without any Paperclip network request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("network access is forbidden in the mock control plane"),
    );
    try {
      const adapter = seeded();
      await adapter.start();
      await adapter.openFixtureRun(OPEN);
      await adapter.applyCommand({
        runId: "run-1",
        idempotencyKey: "offline-progress",
        command: { kind: "report_progress", body: "Committed offline." },
      });
      const restored = CapabilityMockControlPlaneAdapter.restore(adapter.serialize());
      expect(restored.snapshot().comments).toMatchObject([{ body: "Committed offline." }]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("implements the existing ControlPlanePort conformance contract", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const adapter = new CapabilityMockControlPlaneAdapter({
      company: {
        id: identity.companyId,
        name: "Conformance Company",
        issuePrefix: "CNF",
        status: "active",
        budgetId: "budget-company-conformance",
      },
      actors: [
        {
          id: identity.agentId,
          companyId: identity.companyId,
          name: "Conformance Actor",
          role: "engineer",
          status: "active",
          budgetId: "budget-actor-conformance",
          capabilityGrants: [],
        },
      ],
      tasks: [
        {
          id: identity.issueId,
          companyId: identity.companyId,
          identifier: "CNF-1",
          title: "Conformance task",
          description: null,
          status: "todo",
          priority: "medium",
          workMode: "standard",
          parentId: null,
          assigneeActorId: identity.agentId,
          checkoutRunId: null,
          executionRunId: null,
          startedAt: null,
          completedAt: null,
        },
      ],
      budgets: [
        {
          id: "budget-company-conformance",
          scope: "company",
          scopeId: identity.companyId,
          limitCents: 100,
          spentCents: 0,
          hardStop: true,
        },
        {
          id: "budget-actor-conformance",
          scope: "actor",
          scopeId: identity.agentId,
          limitCents: 100,
          spentCents: 0,
          hardStop: true,
        },
      ],
    });
    await expect(runControlPlanePortConformance({ port: adapter, start: () => adapter.start() }))
      .resolves.toMatchObject({
        eventCount: 3,
        terminalReplayIdempotent: true,
        openBindingRejected: true,
        eventIdMutationRejected: true,
        eventSequenceMutationRejected: true,
        replayBindingRejected: true,
        resultMutationRejected: true,
      });
  });

  it("uses stable typed errors for retryable scripted failures", async () => {
    const adapter = seeded({
      faults: [
        {
          id: "retry-open",
          operation: "open_run",
          effect: "retryable_error",
          remaining: 1,
          code: "fixture_transient",
        },
      ],
    });
    await adapter.start();
    const error = await adapter.openFixtureRun(OPEN).catch((caught) => caught);
    expect(error).toBeInstanceOf(CapabilityMockControlPlaneError);
    expect(error).toMatchObject({ code: "fixture_transient", retryable: true });
    await expect(adapter.openFixtureRun(OPEN)).resolves.toMatchObject({
      activeTask: { id: "task-1", status: "in_progress" },
    });
  });
});
