import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type {
  CapabilityFixtureApproval,
  CapabilityFixtureSeed,
  CapabilityJsonValue,
  CapabilitySemanticToolRuntimeSnapshot,
} from "../mock-core/capability-control-plane-types.js";
import {
  CapabilityMockControlPlaneAdapter,
  type CapabilitySemanticToolRuntimeStore,
} from "../mock-core/capability-mock-control-plane-adapter.js";
import {
  CAPABILITY_OPTIONAL_TOOL_CATALOGS,
  CAPABILITY_SEMANTIC_TOOL_CATALOG,
  capabilitySemanticTool,
} from "./capability-semantic-tool-catalog.js";
import { CapabilitySemanticToolRuntime, validateJsonSchema } from "./capability-semantic-tool-runtime.js";
import { CapabilityCodexToolBinding, CapabilityFakeAgentToolBinding } from "./capability-tool-bindings.js";
import {
  CAPABILITY_CONTROL_PLANE_OWNED_OPERATION_IDS,
  type CapabilityModelToolSuccess,
  type CapabilityToolSuccess,
} from "./capability-semantic-tool-types.js";

const OPEN = {
  identity: {
    runId: "run-tools",
    sessionId: "session-tools",
    companyId: "company-1",
    issueId: "task-1",
    agentId: "actor-1",
  },
  backendKind: "mock" as const,
  sourceInstanceId: "capability-tools-test",
};

async function runtimeFor(options: {
  workMode?: "standard" | "ask" | "planning" | "skill_test";
  role?: string;
  actorGrants?: string[];
  scenarioGrants?: string[];
  policy?: ConstructorParameters<typeof CapabilitySemanticToolRuntime>[0]["policy"];
  seed?: CapabilityFixtureSeed;
  resolveSecretValue?: (name: string) => string | null;
  semanticToolRuntimeStore?: CapabilitySemanticToolRuntimeStore;
  now?: () => number;
} = {}) {
  const actor = {
    id: "actor-1",
    companyId: "company-1",
    name: "Fixture Actor",
    role: options.role ?? "engineer",
    status: "active" as const,
    budgetId: "budget-actor-1",
    capabilityGrants: options.actorGrants ?? [],
  };
  const adapter = new CapabilityMockControlPlaneAdapter(
    {
      ...options.seed,
      actors: [actor],
      tasks: options.seed?.tasks ?? [{
        id: "task-1",
        companyId: "company-1",
        identifier: "MCK-1",
        title: "Tool boundary fixture",
        description: "Protected task details",
        status: "todo",
        priority: "high",
        workMode: options.workMode ?? "standard",
        parentId: null,
        assigneeActorId: "actor-1",
        checkoutRunId: null,
        executionRunId: null,
        startedAt: null,
        completedAt: null,
      }],
    },
    { semanticToolRuntimeStore: options.semanticToolRuntimeStore },
  );
  await adapter.start();
  await adapter.openFixtureRun(OPEN);
  return {
    adapter,
    runtime: new CapabilitySemanticToolRuntime({
      adapter,
      runId: OPEN.identity.runId,
      scenarioGrants: options.scenarioGrants,
      policy: options.policy,
      resolveSecretValue: options.resolveSecretValue,
      now: options.now,
    }),
  };
}

describe("Capability semantic tool catalog", () => {
  it("defines a unique versioned provider-neutral catalog and every optional group", () => {
    const operationIds = CAPABILITY_SEMANTIC_TOOL_CATALOG.map((tool) => tool.operationId);
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(CAPABILITY_SEMANTIC_TOOL_CATALOG.every((tool) => tool.version === 1)).toBe(true);
    expect(CAPABILITY_SEMANTIC_TOOL_CATALOG.every((tool) => tool.inputSchema.type === "object")).toBe(true);
    expect(CAPABILITY_SEMANTIC_TOOL_CATALOG.every((tool) => tool.outputSchema.type === "object")).toBe(true);
    expect(CAPABILITY_SEMANTIC_TOOL_CATALOG.every((tool) => tool.mockCommandMapping !== undefined)).toBe(true);

    expect(Object.keys(CAPABILITY_OPTIONAL_TOOL_CATALOGS).sort()).toEqual([
      "cases",
      "company_skills",
      "delegation_dependencies",
      "discovery",
      "governance",
      "portability_admin",
      "routines",
      "secrets",
      "test_escape_hatch",
      "workspace_runtime",
    ]);
    expect(Object.values(CAPABILITY_OPTIONAL_TOOL_CATALOGS).every((tools) => tools.length > 0)).toBe(true);
    expect([
      "get_task_context",
      "get_task_history",
      "list_documents",
      "read_document",
      "list_document_revisions",
      "report_progress",
      "answer_status_question",
      "finish_task",
      "block_task",
      "request_review",
      "write_document",
      "request_human_input",
      "register_deliverable",
      "inspect_operation_result",
    ].every((id) => capabilitySemanticTool(id)?.disposition === "always_agent_tool")).toBe(true);
  });

  it("keeps control-plane operations absent and binds identical fake-agent and Codex surfaces", async () => {
    const { runtime } = await runtimeFor();
    const visible = runtime.visibleTools();
    const fake = new CapabilityFakeAgentToolBinding().bind(visible);
    const codex = new CapabilityCodexToolBinding().bind(visible);
    expect(fake.map((tool) => tool.operationId)).toEqual(codex.map((tool) => tool.name));
    expect(codex.every((tool) => tool.type === "function" && tool.strict)).toBe(true);
    for (const operationId of CAPABILITY_CONTROL_PLANE_OWNED_OPERATION_IDS) {
      expect(visible.tools.some((tool) => tool.operationId === operationId)).toBe(false);
    }
    expect(JSON.stringify({ fake, codex })).not.toContain("Bearer ");
  });
});

describe("Capability exposure and authorization", () => {
  it("computes exposure before invocation from task mode, claims, role, and policy", async () => {
    const baseline = await runtimeFor();
    const baselineIds = baseline.runtime.visibleTools().tools.map((tool) => tool.operationId);
    expect(baselineIds).toContain("finish_task");
    expect(baselineIds).not.toContain("search_tasks");

    const ask = await runtimeFor({ workMode: "ask" });
    const askIds = ask.runtime.visibleTools().tools.map((tool) => tool.operationId);
    expect(askIds).toContain("answer_status_question");
    expect(askIds).not.toContain("finish_task");
    expect(askIds).not.toContain("write_document");

    const granted = await runtimeFor({
      scenarioGrants: ["discovery:tasks:read", "governance:approvals:decide"],
      role: "approver",
      policy: { deniedOperationIds: ["search_tasks"] },
    });
    const grantedIds = granted.runtime.visibleTools().tools.map((tool) => tool.operationId);
    expect(grantedIds).not.toContain("search_tasks");
    expect(grantedIds).toContain("decide_approval");
    expect(granted.runtime.authorizationRecords().some(
      (record) => record.operationId === "search_tasks" && record.reason === "operation_denied_by_policy",
    )).toBe(true);
  });

  it("keeps always tools active-task scoped and returns typed denials without protected state", async () => {
    const protectedValue = "protected-approval-payload";
    const approval: CapabilityFixtureApproval = {
      id: "approval-protected",
      companyId: "company-1",
      taskIds: ["task-1"],
      type: "request_board_approval",
      status: "pending",
      requestedByActorId: null,
      payload: { private: protectedValue },
      decisionNote: null,
      comments: [],
      createdAt: "2026-08-09T00:00:00.000Z",
      decidedAt: null,
    };
    const { adapter, runtime } = await runtimeFor({ seed: { approvals: [approval] } });
    const revision = adapter.snapshot().revision;
    const scoped = await runtime.invoke({
      operationId: "get_task_context",
      input: { taskId: "task-other" },
    });
    expect(scoped).toMatchObject({ ok: false, error: { code: "input_invalid" } });
    expect(adapter.snapshot().revision).toBe(revision);

    const denied = await runtime.invoke({
      operationId: "decide_approval",
      input: { approvalId: "approval-protected", decision: "approved", note: "approve" },
      idempotencyKey: "decision-1",
    });
    expect(denied).toMatchObject({ ok: false, error: { code: "policy_denied" } });
    expect(JSON.stringify(denied)).not.toContain(protectedValue);

    const absent = await runtime.invoke({ operationId: "checkout_task", input: {} });
    expect(absent).toMatchObject({
      ok: false,
      error: { code: "operation_absent", reason: "control_plane_owned_operation" },
    });
    expect(JSON.stringify(absent)).not.toContain("Protected task details");
  });

  it("emits authorization records with decision reasons and resulting state changes", async () => {
    const { adapter, runtime } = await runtimeFor();
    const beforeRevision = adapter.snapshot().revision;
    const result = await runtime.invoke({
      operationId: "report_progress",
      input: { body: "Semantic progress." },
      idempotencyKey: "progress-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.authorization).toMatchObject({
      outcome: "allowed",
      reason: "task_scoped_always_tool",
      resultingStateChange: {
        beforeRevision,
        afterRevision: adapter.snapshot().revision,
      },
    });
    expect(result.authorization.resultingStateChange?.entityRefs).toEqual(
      expect.arrayContaining(["task:task-1"]),
    );
    expect(adapter.snapshot().comments.at(-1)?.body).toBe("Semantic progress.");
    expect(validateJsonSchema(
      capabilitySemanticTool("report_progress")!.outputSchema,
      structuredClone(result) as unknown as CapabilityJsonValue,
    )).toEqual([]);
  });

  it("executes the minimum always-tool workflow through the mock command contract", async () => {
    const { adapter, runtime } = await runtimeFor();
    const written = await runtime.invoke({
      operationId: "write_document",
      input: {
        key: "plan",
        title: "Plan",
        body: "# Semantic plan",
        baseRevisionId: null,
      },
      idempotencyKey: "write-plan-1",
    });
    expect(written.ok).toBe(true);
    const revisionId = written.ok
      ? written.commandResult?.entityRefs.find((ref) => ref.startsWith("revision:"))?.slice(9)
      : undefined;
    expect(revisionId).toBeTruthy();

    const read = await runtime.invoke({ operationId: "read_document", input: { key: "plan" } });
    expect(read).toMatchObject({ ok: true, value: { key: "plan", latestRevisionId: revisionId } });
    const revisions = await runtime.invoke({
      operationId: "list_document_revisions",
      input: { key: "plan" },
    });
    expect(revisions).toMatchObject({ ok: true, value: [{ id: revisionId, revision: 1 }] });

    expect(await runtime.invoke({
      operationId: "register_deliverable",
      input: {
        filename: "report.json",
        contentType: "application/json",
        byteSize: 42,
        sha256: "fixture-sha256",
        contentRef: "fixture://report.json",
        title: "Semantic report",
      },
      idempotencyKey: "deliverable-1",
    })).toMatchObject({ ok: true });
    expect(await runtime.invoke({
      operationId: "request_review",
      input: { summary: "Ready for semantic review." },
      idempotencyKey: "review-1",
    })).toMatchObject({ ok: true });
    expect(await runtime.invoke({
      operationId: "request_human_input",
      input: {
        interactionKind: "confirmation",
        title: "Confirm plan",
        prompt: "Accept this plan?",
        targetRevisionId: revisionId!,
        continuationPolicy: "wake_assignee",
      },
      idempotencyKey: "confirm-plan-1",
    })).toMatchObject({ ok: true });

    expect(adapter.snapshot()).toMatchObject({
      tasks: [{ status: "in_review" }],
      documents: [{ key: "plan", revisions: [{ body: "# Semantic plan" }] }],
      interactions: [{ kind: "confirmation", status: "pending" }],
      artifacts: [{ filename: "report.json" }],
      workProducts: [{ type: "artifact" }],
    });
  });

  it("keeps a pending human-input handoff in review instead of weakening the lifecycle", async () => {
    const { adapter, runtime } = await runtimeFor();
    expect(await runtime.invoke({
      operationId: "request_human_input",
      input: {
        interactionKind: "confirmation",
        title: "Confirm plan",
        prompt: "Accept this plan?",
        continuationPolicy: "wake_assignee",
      },
      idempotencyKey: "confirm-plan-first",
    })).toMatchObject({ ok: true });

    expect(await runtime.invoke({
      operationId: "request_review",
      input: { summary: "A duplicate review transition must fail closed." },
      idempotencyKey: "duplicate-review",
    })).toMatchObject({
      ok: false,
      error: { code: "operation_unsupported", reason: "mock_operation_rejected" },
    });
    expect(adapter.snapshot()).toMatchObject({
      tasks: [{ status: "in_review" }],
      interactions: [{ status: "pending" }],
      comments: [],
    });
  });

  it.each([
    ["sync_company_skills", "company_skills:write", {}, { synced: true }, "engineer"],
    ["manage_routine", "routines:write", {}, { managed: true }, "engineer"],
    ["upsert_case", "cases:write", { key: "case-1", body: "Case body" }, {
      key: "case-1",
      body: "Case body",
      upserted: true,
    }, "engineer"],
    ["administer_company", "company:admin", { action: "refresh" }, {
      action: "refresh",
      applied: true,
    }, "admin"],
  ] as const)(
    "executes the advertised %s scenario extension",
    async (operationId, grant, input, value, role) => {
      const { runtime } = await runtimeFor({ scenarioGrants: [grant], role });
      await expect(runtime.invoke({
        operationId,
        input,
        idempotencyKey: `extension-${operationId}`,
      })).resolves.toMatchObject({ ok: true, operationId, value });
    },
  );

  it("replays required-idempotency extensions without executing a second result", async () => {
    const { adapter, runtime } = await runtimeFor({ scenarioGrants: ["cases:write"] });
    const invocation = {
      operationId: "upsert_case",
      input: { key: "case-1", body: "Case body" },
      idempotencyKey: "upsert-case-1",
    } as const;

    const first = await runtime.invoke(invocation);
    const restoredAdapter = CapabilityMockControlPlaneAdapter.restore(
      adapter.serialize(),
    );
    const recreated = new CapabilitySemanticToolRuntime({
      adapter: restoredAdapter,
      runId: OPEN.identity.runId,
      scenarioGrants: ["cases:write"],
    });
    const replay = await recreated.invoke(invocation);
    expect(first).toMatchObject({ ok: true, value: { upserted: true } });
    expect(replay).toMatchObject({ ok: true, value: { upserted: true } });
    if (!first.ok || !replay.ok) throw new Error("expected extension success");
    expect(replay.operationResultId).toBe(first.operationResultId);

    await expect(recreated.invoke({
      operationId: "inspect_operation_result",
      input: { operationResultId: first.operationResultId },
    })).resolves.toMatchObject({
      ok: true,
      value: { key: "case-1", body: "Case body", upserted: true },
    });

    const next = await recreated.invoke({
      ...invocation,
      idempotencyKey: "upsert-case-2",
    });
    expect(next).toMatchObject({ ok: true });
    if (!next.ok) throw new Error("expected extension success");
    expect(next.operationResultId).not.toBe(first.operationResultId);

    await expect(recreated.invoke({
      ...invocation,
      input: { key: "case-1", body: "Different body" },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "input_invalid", reason: "idempotency_key_conflict" },
    });
  });

  it("persists extension completion with its inspectable result atomically", async () => {
    const { adapter, runtime } = await runtimeFor({
      scenarioGrants: ["cases:write"],
    });
    const compareAndSwapRuntime = vi.spyOn(
      adapter,
      "compareAndSwapSemanticToolRuntime",
    );

    const result = await runtime.invoke({
      operationId: "upsert_case",
      input: { key: "case-atomic", body: "Case body" },
      idempotencyKey: "upsert-case-atomic",
    });

    expect(result).toMatchObject({ ok: true });
    expect(compareAndSwapRuntime).toHaveBeenCalledTimes(3);
    expect(compareAndSwapRuntime.mock.calls[0]![2].extensions).toEqual([
      expect.objectContaining({ status: "pending", phase: "reserved" }),
    ]);
    expect(compareAndSwapRuntime.mock.calls[1]![2].extensions).toEqual([
      expect.objectContaining({ status: "pending", phase: "executing" }),
    ]);
    const snapshot = compareAndSwapRuntime.mock.calls[2]![2];
    expect(snapshot.extensions).toHaveLength(1);
    const [extension] = snapshot.extensions;
    expect(extension).toMatchObject({ status: "completed" });
    if (extension?.status !== "completed") {
      throw new Error("expected completed extension receipt");
    }
    expect(snapshot.operationResults[extension.resultId]).toEqual(
      extension.execution.value,
    );
  });

  it("retries the completion merge after a concurrent lease heartbeat", async () => {
    let durableSnapshot: CapabilitySemanticToolRuntimeSnapshot | null = null;
    let injectedHeartbeats = 0;
    let completionAttempts = 0;
    const durableStore: CapabilitySemanticToolRuntimeStore = {
      load: () => durableSnapshot === null ? null : structuredClone(durableSnapshot),
      save: (_runId, snapshot) => {
        durableSnapshot = structuredClone(snapshot);
      },
      compareAndSwap: (_runId, expected, snapshot) => {
        if (JSON.stringify(durableSnapshot) !== JSON.stringify(expected)) return false;
        const completing = snapshot.extensions.some((extension) => extension.status === "completed");
        if (completing) completionAttempts += 1;
        if (completing && injectedHeartbeats < 12 && durableSnapshot !== null) {
          injectedHeartbeats += 1;
          const heartbeat = structuredClone(durableSnapshot) as CapabilitySemanticToolRuntimeSnapshot;
          heartbeat.extensions = heartbeat.extensions.map((extension) =>
            extension.status === "pending"
              ? { ...extension, leaseExpiresAtMs: (extension.leaseExpiresAtMs ?? 0) + 1_000 }
              : extension,
          );
          durableSnapshot = heartbeat;
          return false;
        }
        durableSnapshot = structuredClone(snapshot);
        return true;
      },
    };
    const { runtime } = await runtimeFor({
      scenarioGrants: ["cases:write"],
      semanticToolRuntimeStore: durableStore,
    });

    await expect(runtime.invoke({
      operationId: "upsert_case",
      input: { key: "case-raced", body: "Case body" },
      idempotencyKey: "upsert-case-raced",
    })).resolves.toMatchObject({ ok: true, value: { upserted: true } });

    expect(injectedHeartbeats).toBe(12);
    expect(completionAttempts).toBe(13);
    expect(durableSnapshot?.extensions).toEqual([
      expect.objectContaining({ status: "completed", resultId: "tool-result-1" }),
    ]);
    expect(durableSnapshot?.operationResults["tool-result-1"]).toEqual({
      key: "case-raced",
      body: "Case body",
      upserted: true,
    });
  });

  it("bounds completion contention and retries the fulfilled execution without rerunning it", async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      let durableSnapshot: CapabilitySemanticToolRuntimeSnapshot | null = null;
      let rejectCompletion = true;
      let completionAttempts = 0;
      const durableStore: CapabilitySemanticToolRuntimeStore = {
        load: () => durableSnapshot === null ? null : structuredClone(durableSnapshot),
        save: (_runId, snapshot) => {
          durableSnapshot = structuredClone(snapshot);
        },
        compareAndSwap: (_runId, expected, snapshot) => {
          if (JSON.stringify(durableSnapshot) !== JSON.stringify(expected)) return false;
          const completing = snapshot.extensions.some(
            (extension) => extension.status === "completed",
          );
          if (completing) completionAttempts += 1;
          if (completing && rejectCompletion) return false;
          durableSnapshot = structuredClone(snapshot);
          return true;
        },
      };
      const { adapter, runtime } = await runtimeFor({
        scenarioGrants: ["cases:write"],
        semanticToolRuntimeStore: durableStore,
        now: Date.now,
      });
      const invocation = {
        operationId: "upsert_case",
        input: { key: "case-bounded-contention", body: "Case body" },
        idempotencyKey: "upsert-case-bounded-contention",
      } as const;

      const contended = runtime.invoke(invocation);
      for (let yieldIndex = 0; yieldIndex < 8; yieldIndex += 1) {
        await vi.advanceTimersToNextTimerAsync();
      }
      await expect(contended).resolves.toMatchObject({
        ok: false,
        error: { code: "operation_unsupported" },
      });
      expect(completionAttempts).toBe(64);
      expect(durableSnapshot?.extensions).toEqual([
        expect.objectContaining({ status: "pending" }),
      ]);

      await vi.advanceTimersByTimeAsync(30_000);
      const pending = durableSnapshot?.extensions[0];
      expect(pending?.status).toBe("pending");
      if (pending?.status !== "pending") throw new Error("expected a pending extension");
      expect(pending.leaseExpiresAtMs).toBeGreaterThan(Date.now());

      const followerAdapter = CapabilityMockControlPlaneAdapter.restore(
        adapter.serialize(),
        { semanticToolRuntimeStore: durableStore },
      );
      const follower = new CapabilitySemanticToolRuntime({
        adapter: followerAdapter,
        runId: OPEN.identity.runId,
        scenarioGrants: ["cases:write"],
        now: Date.now,
      });
      await expect(follower.invoke(invocation)).resolves.toMatchObject({
        ok: false,
        error: { reason: "idempotency_recovery_in_flight" },
      });

      rejectCompletion = false;
      await expect(runtime.invoke(invocation)).resolves.toMatchObject({
        ok: true,
        operationResultId: "tool-result-1",
        value: { key: "case-bounded-contention", upserted: true },
      });
      expect(completionAttempts).toBe(65);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reclaims an expired executing marker after its owner terminates", async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      let now = 0;
      let durableSnapshot: CapabilitySemanticToolRuntimeSnapshot | null = null;
      let rejectCompletion = true;
      const durableStore: CapabilitySemanticToolRuntimeStore = {
        load: () => durableSnapshot === null ? null : structuredClone(durableSnapshot),
        save: (_runId, snapshot) => {
          durableSnapshot = structuredClone(snapshot);
        },
        compareAndSwap: (_runId, expected, snapshot) => {
          if (JSON.stringify(durableSnapshot) !== JSON.stringify(expected)) return false;
          if (rejectCompletion &&
            snapshot.extensions.some((extension) => extension.status === "completed")) {
            return false;
          }
          durableSnapshot = structuredClone(snapshot);
          return true;
        },
      };
      const first = await runtimeFor({
        scenarioGrants: ["cases:write"],
        semanticToolRuntimeStore: durableStore,
        now: () => now,
      });
      const invocation = {
        operationId: "upsert_case",
        input: { key: "case-ambiguous-effect", body: "Case body" },
        idempotencyKey: "upsert-case-ambiguous-effect",
      } as const;

      const contended = first.runtime.invoke(invocation);
      for (let yieldIndex = 0; yieldIndex < 8; yieldIndex += 1) {
        await vi.advanceTimersToNextTimerAsync();
      }
      await expect(contended).resolves.toMatchObject({
        ok: false,
        error: { code: "operation_unsupported" },
      });
      expect(durableSnapshot?.extensions).toEqual([
        expect.objectContaining({ status: "pending", phase: "executing" }),
      ]);

      // Model termination of the first process: its heartbeat no longer owns
      // the lease, and the durable store is available to the replacement.
      vi.clearAllTimers();
      rejectCompletion = false;
      now = 60_000;
      const followerAdapter = CapabilityMockControlPlaneAdapter.restore(
        first.adapter.serialize(),
        { semanticToolRuntimeStore: durableStore },
      );
      const follower = new CapabilitySemanticToolRuntime({
        adapter: followerAdapter,
        runId: OPEN.identity.runId,
        scenarioGrants: ["cases:write"],
        now: () => now,
        resolveExpiredExtensionReceipt: async () => ({
          value: {
            key: "case-ambiguous-effect",
            body: "Case body",
            upserted: true,
          },
        }),
      });
      await expect(follower.invoke(invocation)).resolves.toMatchObject({
        ok: true,
        operationResultId: "tool-result-1",
        value: { key: "case-ambiguous-effect", upserted: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries rejected-execution cleanup through snapshot contention", async () => {
    let durableSnapshot: CapabilitySemanticToolRuntimeSnapshot | null = null;
    let rejectExecutionAllocation = true;
    let injectedCleanupContention = false;
    const durableStore: CapabilitySemanticToolRuntimeStore = {
      load: () => {
        if (
          rejectExecutionAllocation &&
          durableSnapshot?.extensions.some((extension) => extension.status === "pending")
        ) {
          rejectExecutionAllocation = false;
          throw new Error("injected extension result allocation failure");
        }
        return durableSnapshot === null ? null : structuredClone(durableSnapshot);
      },
      save: (_runId, snapshot) => {
        durableSnapshot = structuredClone(snapshot);
      },
      compareAndSwap: (_runId, expected, snapshot) => {
        if (JSON.stringify(durableSnapshot) !== JSON.stringify(expected)) return false;
        const removingFailedLease =
          durableSnapshot?.extensions.some((extension) => extension.status === "pending") &&
          snapshot.extensions.length === 0;
        if (removingFailedLease && !injectedCleanupContention && durableSnapshot !== null) {
          injectedCleanupContention = true;
          durableSnapshot = {
            ...structuredClone(durableSnapshot),
            resultSequence: durableSnapshot.resultSequence + 1,
          };
          return false;
        }
        durableSnapshot = structuredClone(snapshot);
        return true;
      },
    };
    const { runtime } = await runtimeFor({
      scenarioGrants: ["cases:write"],
      semanticToolRuntimeStore: durableStore,
    });
    const invocation = {
      operationId: "upsert_case",
      input: { key: "case-cleanup-raced", body: "Case body" },
      idempotencyKey: "upsert-case-cleanup-raced",
    } as const;

    await expect(runtime.invoke(invocation)).resolves.toMatchObject({ ok: false });
    await vi.waitFor(() => expect(durableSnapshot?.extensions).toEqual([]));
    expect(injectedCleanupContention).toBe(true);
    await expect(runtime.invoke(invocation)).resolves.toMatchObject({
      ok: true,
      operationResultId: "tool-result-2",
      value: { key: "case-cleanup-raced", upserted: true },
    });
  });

  it("retains a failed lease until cleanup contention clears", async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      let durableSnapshot: CapabilitySemanticToolRuntimeSnapshot | null = null;
      let failExecutionAllocation = true;
      let cleanupAttempts = 0;
      const durableStore: CapabilitySemanticToolRuntimeStore = {
        load: () => {
          if (
            failExecutionAllocation &&
            durableSnapshot?.extensions.some((extension) => extension.status === "pending")
          ) {
            failExecutionAllocation = false;
            throw new Error("injected result allocation failure");
          }
          return durableSnapshot === null ? null : structuredClone(durableSnapshot);
        },
        save: (_runId, snapshot) => {
          durableSnapshot = structuredClone(snapshot);
        },
        compareAndSwap: (_runId, expected, snapshot) => {
          if (JSON.stringify(durableSnapshot) !== JSON.stringify(expected)) return false;
          const removingFailedLease =
            durableSnapshot?.extensions.some((extension) => extension.status === "pending") &&
            snapshot.extensions.length === 0;
          if (removingFailedLease) {
            cleanupAttempts += 1;
            if (cleanupAttempts <= 8) return false;
          }
          durableSnapshot = structuredClone(snapshot);
          return true;
        },
      };
      const { runtime } = await runtimeFor({
        scenarioGrants: ["cases:write"],
        semanticToolRuntimeStore: durableStore,
        now: Date.now,
      });
      const invocation = {
        operationId: "upsert_case",
        input: { key: "case-cleanup-exhausted", body: "Case body" },
        idempotencyKey: "upsert-case-cleanup-exhausted",
      } as const;

      await expect(runtime.invoke(invocation)).resolves.toMatchObject({ ok: false });
      expect(cleanupAttempts).toBe(8);
      expect(durableSnapshot?.extensions).toEqual([
        expect.objectContaining({ status: "pending" }),
      ]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(cleanupAttempts).toBe(9);
      expect(durableSnapshot?.extensions).toEqual([]);
      await expect(runtime.invoke(invocation)).resolves.toMatchObject({
        ok: true,
        value: { key: "case-cleanup-exhausted", upserted: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("allocates read result ids from the latest shared durable sequence", async () => {
    let durableSnapshot: CapabilitySemanticToolRuntimeSnapshot | null = null;
    const durableStore: CapabilitySemanticToolRuntimeStore = {
      load: () => durableSnapshot === null ? null : structuredClone(durableSnapshot),
      save: (_runId, snapshot) => {
        durableSnapshot = structuredClone(snapshot);
      },
      compareAndSwap: (_runId, expected, snapshot) => {
        if (JSON.stringify(durableSnapshot) !== JSON.stringify(expected)) return false;
        durableSnapshot = structuredClone(snapshot);
        return true;
      },
    };
    const first = await runtimeFor({ semanticToolRuntimeStore: durableStore });
    await expect(first.runtime.invoke({ operationId: "get_task_context", input: {} }))
      .resolves.toMatchObject({ ok: true, operationResultId: "tool-result-1" });
    const followerAdapter = CapabilityMockControlPlaneAdapter.restore(
      first.adapter.serialize(),
      { semanticToolRuntimeStore: durableStore },
    );
    const follower = new CapabilitySemanticToolRuntime({
      adapter: followerAdapter,
      runId: OPEN.identity.runId,
    });

    await expect(follower.invoke({ operationId: "get_task_context", input: {} }))
      .resolves.toMatchObject({ ok: true, operationResultId: "tool-result-2" });
    await expect(first.runtime.invoke({ operationId: "get_task_context", input: {} }))
      .resolves.toMatchObject({ ok: true, operationResultId: "tool-result-3" });
    expect(Object.keys(durableSnapshot?.operationResults ?? {})).toEqual([
      "tool-result-1",
      "tool-result-2",
      "tool-result-3",
    ]);
  });

  it("retries extension acquisition after an unrelated snapshot update", async () => {
    let durableSnapshot: CapabilitySemanticToolRuntimeSnapshot | null = null;
    let injectedContention = false;
    const durableStore: CapabilitySemanticToolRuntimeStore = {
      load: () => durableSnapshot === null ? null : structuredClone(durableSnapshot),
      save: (_runId, snapshot) => {
        durableSnapshot = structuredClone(snapshot);
      },
      compareAndSwap: (_runId, expected, snapshot) => {
        if (JSON.stringify(durableSnapshot) !== JSON.stringify(expected)) return false;
        const acquiring = snapshot.extensions.some((extension) => extension.status === "pending");
        if (acquiring && !injectedContention) {
          injectedContention = true;
          durableSnapshot = {
            schema: "paperclip.capability.semantic-tool-runtime.v1",
            resultSequence: 1,
            operationResults: {},
            extensions: [],
          };
          return false;
        }
        durableSnapshot = structuredClone(snapshot);
        return true;
      },
    };
    const { runtime } = await runtimeFor({
      scenarioGrants: ["cases:write"],
      semanticToolRuntimeStore: durableStore,
    });

    await expect(runtime.invoke({
      operationId: "upsert_case",
      input: { key: "case-acquire-raced", body: "Case body" },
      idempotencyKey: "upsert-case-acquire-raced",
    })).resolves.toMatchObject({ ok: true, value: { upserted: true } });
    expect(injectedContention).toBe(true);
    expect(durableSnapshot?.resultSequence).toBe(2);
    expect(durableSnapshot?.extensions).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
  });

  it("fails closed while a restored extension is in flight and reconciles its durable receipt", async () => {
    let durableSnapshot: CapabilitySemanticToolRuntimeSnapshot | null = null;
    const durableStore: CapabilitySemanticToolRuntimeStore = {
      load: () =>
        durableSnapshot === null ? null : structuredClone(durableSnapshot),
      save: (_runId, snapshot) => {
        durableSnapshot = structuredClone(snapshot);
      },
      compareAndSwap: (_runId, expected, snapshot) => {
        if (JSON.stringify(durableSnapshot) !== JSON.stringify(expected)) {
          return false;
        }
        durableSnapshot = structuredClone(snapshot);
        return true;
      },
    };
    const { adapter, runtime } = await runtimeFor({
      scenarioGrants: ["cases:write"],
      semanticToolRuntimeStore: durableStore,
    });
    const invocation = {
      operationId: "upsert_case",
      input: { key: "case-pending", body: "Case body" },
      idempotencyKey: "upsert-case-pending",
    } as const;

    const inFlight = runtime.invoke(invocation);
    const serializedWhileInFlight = adapter.serialize();
    expect(() =>
      CapabilityMockControlPlaneAdapter.restore(serializedWhileInFlight),
    ).toThrow(
      "restoring pending semantic extensions requires a process-independent runtime store",
    );
    const restoredAdapter = CapabilityMockControlPlaneAdapter.restore(
      serializedWhileInFlight,
      { semanticToolRuntimeStore: durableStore },
    );
    const restored = new CapabilitySemanticToolRuntime({
      adapter: restoredAdapter,
      runId: OPEN.identity.runId,
      scenarioGrants: ["cases:write"],
    });

    await expect(restored.invoke(invocation)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "operation_unsupported",
        reason: "idempotency_recovery_in_flight",
      },
    });
    const completed = await inFlight;
    expect(completed).toMatchObject({ ok: true });

    const recovered = await restored.invoke(invocation);
    expect(recovered).toMatchObject({
      ok: true,
      operationResultId: completed.ok ? completed.operationResultId : undefined,
      value: { key: "case-pending", body: "Case body", upserted: true },
    });
  });

  it("does not revive a serialized pending extension when the durable store is empty", async () => {
    let durableSnapshot: CapabilitySemanticToolRuntimeSnapshot | null = null;
    const durableStore: CapabilitySemanticToolRuntimeStore = {
      load: () => durableSnapshot === null ? null : structuredClone(durableSnapshot),
      save: (_runId, snapshot) => {
        durableSnapshot = structuredClone(snapshot);
      },
      compareAndSwap: (_runId, expected, snapshot) => {
        if (JSON.stringify(durableSnapshot) !== JSON.stringify(expected)) return false;
        durableSnapshot = structuredClone(snapshot);
        return true;
      },
    };
    const first = await runtimeFor({
      scenarioGrants: ["cases:write"],
      semanticToolRuntimeStore: durableStore,
    });
    const invocation = {
      operationId: "upsert_case",
      input: { key: "case-empty-store-pending", body: "Case body" },
      idempotencyKey: "empty-store-pending",
    } as const;

    const inFlight = first.runtime.invoke(invocation);
    const serializedWhilePending = first.adapter.serialize();
    await expect(inFlight).resolves.toMatchObject({ ok: true });
    durableSnapshot = null;

    const restoredAdapter = CapabilityMockControlPlaneAdapter.restore(
      serializedWhilePending,
      { semanticToolRuntimeStore: durableStore },
    );
    const restored = new CapabilitySemanticToolRuntime({
      adapter: restoredAdapter,
      runId: OPEN.identity.runId,
      scenarioGrants: ["cases:write"],
    });
    await expect(restored.invoke(invocation)).resolves.toMatchObject({
      ok: true,
      value: { key: "case-empty-store-pending", upserted: true },
    });
    expect(durableSnapshot?.extensions).toEqual([
      expect.objectContaining({
        key: "run-tools:upsert_case:empty-store-pending",
        status: "completed",
      }),
    ]);
  });

  it("does not revive serialized completed extensions when the durable store is empty", async () => {
    let durableSnapshot: CapabilitySemanticToolRuntimeSnapshot | null = null;
    const durableStore: CapabilitySemanticToolRuntimeStore = {
      load: () => durableSnapshot === null ? null : structuredClone(durableSnapshot),
      save: (_runId, snapshot) => {
        durableSnapshot = structuredClone(snapshot);
      },
      compareAndSwap: (_runId, expected, snapshot) => {
        if (JSON.stringify(durableSnapshot) !== JSON.stringify(expected)) return false;
        durableSnapshot = structuredClone(snapshot);
        return true;
      },
    };
    const first = await runtimeFor({
      scenarioGrants: ["cases:write"],
      semanticToolRuntimeStore: durableStore,
    });
    await expect(first.runtime.invoke({
      operationId: "upsert_case",
      input: { key: "case-stale-completed", body: "Stale body" },
      idempotencyKey: "stale-completed",
    })).resolves.toMatchObject({ ok: true });
    const serializedWithCompleted = first.adapter.serialize();
    durableSnapshot = null;

    const restoredAdapter = CapabilityMockControlPlaneAdapter.restore(
      serializedWithCompleted,
      { semanticToolRuntimeStore: durableStore },
    );
    const restored = new CapabilitySemanticToolRuntime({
      adapter: restoredAdapter,
      runId: OPEN.identity.runId,
      scenarioGrants: ["cases:write"],
    });
    await expect(restored.invoke({
      operationId: "upsert_case",
      input: { key: "case-after-empty-store", body: "Fresh body" },
      idempotencyKey: "fresh-after-empty-store",
    })).resolves.toMatchObject({
      ok: true,
      value: { key: "case-after-empty-store", upserted: true },
    });
    expect(durableSnapshot?.extensions).toEqual([
      expect.objectContaining({
        key: "run-tools:upsert_case:fresh-after-empty-store",
        status: "completed",
      }),
    ]);
  });

  it("renews a live extension lease before another runtime can reclaim it", async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      let durableSnapshot: CapabilitySemanticToolRuntimeSnapshot | null = null;
      const durableStore: CapabilitySemanticToolRuntimeStore = {
        load: () =>
          durableSnapshot === null ? null : structuredClone(durableSnapshot),
        save: (_runId, snapshot) => {
          durableSnapshot = structuredClone(snapshot);
        },
        compareAndSwap: (_runId, expected, snapshot) => {
          if (JSON.stringify(durableSnapshot) !== JSON.stringify(expected)) {
            return false;
          }
          durableSnapshot = structuredClone(snapshot);
          return true;
        },
      };
      const { adapter, runtime } = await runtimeFor({
        scenarioGrants: ["cases:write"],
        semanticToolRuntimeStore: durableStore,
      });
      const invocation = {
        operationId: "upsert_case",
        input: { key: "case-live", body: "Case body" },
        idempotencyKey: "live-case",
      } as const;

      const inFlight = runtime.invoke(invocation);
      expect(durableSnapshot?.extensions[0]).toMatchObject({
        status: "pending",
        leaseExpiresAtMs: 30_000,
      });
      vi.advanceTimersByTime(10_000);
      expect(durableSnapshot?.extensions[0]).toMatchObject({
        status: "pending",
        leaseExpiresAtMs: 40_000,
      });

      const restoredAdapter = CapabilityMockControlPlaneAdapter.restore(
        adapter.serialize(),
        { semanticToolRuntimeStore: durableStore },
      );
      const restored = new CapabilitySemanticToolRuntime({
        adapter: restoredAdapter,
        runId: OPEN.identity.runId,
        scenarioGrants: ["cases:write"],
        now: () => 30_001,
      });
      await expect(restored.invoke(invocation)).resolves.toMatchObject({
        ok: false,
        error: {
          code: "operation_unsupported",
          reason: "idempotency_recovery_in_flight",
        },
      });
      await expect(inFlight).resolves.toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a lease heartbeat after a transient durable-store failure", async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      let durableSnapshot: CapabilitySemanticToolRuntimeSnapshot | null = null;
      let failNextLoad = false;
      const durableStore: CapabilitySemanticToolRuntimeStore = {
        load: () => {
          if (failNextLoad) {
            failNextLoad = false;
            throw new Error("transient store read failure");
          }
          return durableSnapshot === null ? null : structuredClone(durableSnapshot);
        },
        save: (_runId, snapshot) => {
          durableSnapshot = structuredClone(snapshot);
        },
        compareAndSwap: (_runId, expected, snapshot) => {
          if (JSON.stringify(durableSnapshot) !== JSON.stringify(expected)) {
            return false;
          }
          durableSnapshot = structuredClone(snapshot);
          return true;
        },
      };
      const { runtime } = await runtimeFor({
        scenarioGrants: ["cases:write"],
        semanticToolRuntimeStore: durableStore,
      });
      const inFlight = runtime.invoke({
        operationId: "upsert_case",
        input: { key: "case-heartbeat-retry", body: "Case body" },
        idempotencyKey: "heartbeat-retry",
      });

      failNextLoad = true;
      expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
      expect(durableSnapshot?.extensions[0]?.leaseExpiresAtMs).toBe(30_000);
      vi.advanceTimersByTime(10_000);
      expect(durableSnapshot?.extensions[0]?.leaseExpiresAtMs).toBe(50_000);
      await expect(inFlight).resolves.toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a prepared extension after repeated heartbeat failures", async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      let durableSnapshot: CapabilitySemanticToolRuntimeSnapshot | null = null;
      let failHeartbeatLoads = false;
      const durableStore: CapabilitySemanticToolRuntimeStore = {
        load: () => {
          if (failHeartbeatLoads) throw new Error("persistent store read failure");
          return durableSnapshot === null ? null : structuredClone(durableSnapshot);
        },
        save: (_runId, snapshot) => { durableSnapshot = structuredClone(snapshot); },
        compareAndSwap: (_runId, expected, snapshot) => {
          if (JSON.stringify(durableSnapshot) !== JSON.stringify(expected)) return false;
          durableSnapshot = structuredClone(snapshot);
          return true;
        },
      };
      const { adapter, runtime } = await runtimeFor({
        scenarioGrants: ["cases:write"],
        semanticToolRuntimeStore: durableStore,
        now: () => Date.now(),
      });
      const invocation = {
        operationId: "upsert_case",
        input: { key: "case-heartbeat-loss", body: "Case body" },
        idempotencyKey: "heartbeat-loss",
      } as const;

      const inFlight = runtime.invoke(invocation);
      failHeartbeatLoads = true;
      vi.advanceTimersByTime(40_000);
      failHeartbeatLoads = false;
      expect(durableSnapshot?.extensions[0]).toMatchObject({
        status: "pending",
        phase: "executing",
        leaseExpiresAtMs: 30_000,
      });

      const restoredAdapter = CapabilityMockControlPlaneAdapter.restore(
        adapter.serialize(),
        { semanticToolRuntimeStore: durableStore },
      );
      const resolveExpiredExtensionReceipt = vi.fn(() => ({
        value: {
          key: "case-heartbeat-loss",
          body: "Conflicting recovered body",
          upserted: true,
        },
      }));
      const restored = new CapabilitySemanticToolRuntime({
        adapter: restoredAdapter,
        runId: OPEN.identity.runId,
        scenarioGrants: ["cases:write"],
        now: () => Date.now(),
        resolveExpiredExtensionReceipt,
      });
      const recovered = await restored.invoke(invocation);
      const original = await inFlight;
      expect(recovered).toMatchObject({ ok: true });
      expect(original).toMatchObject({ ok: true });
      if (!recovered.ok || !original.ok) throw new Error("expected recovered execution");
      expect(recovered.operationResultId).toBe(original.operationResultId);
      expect(recovered.value).toEqual({
        key: "case-heartbeat-loss",
        body: "Case body",
        upserted: true,
      });
      expect(original.value).toEqual(recovered.value);
      expect(resolveExpiredExtensionReceipt).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries initial acquisition after a transient durable-store failure", async () => {
    let durableSnapshot: CapabilitySemanticToolRuntimeSnapshot | null = null;
    let failNextLoad = false;
    const durableStore: CapabilitySemanticToolRuntimeStore = {
      load: () => {
        if (failNextLoad) {
          failNextLoad = false;
          throw new Error("transient store read failure");
        }
        return durableSnapshot === null ? null : structuredClone(durableSnapshot);
      },
      save: (_runId, snapshot) => {
        durableSnapshot = structuredClone(snapshot);
      },
      compareAndSwap: (_runId, expected, snapshot) => {
        if (JSON.stringify(durableSnapshot) !== JSON.stringify(expected)) {
          return false;
        }
        durableSnapshot = structuredClone(snapshot);
        return true;
      },
    };
    const { runtime } = await runtimeFor({
      scenarioGrants: ["cases:write"],
      semanticToolRuntimeStore: durableStore,
    });
    const invocation = {
      operationId: "upsert_case",
      input: { key: "case-acquisition-retry", body: "Case body" },
      idempotencyKey: "acquisition-retry",
    };

    failNextLoad = true;
    await expect(runtime.invoke(invocation)).resolves.toMatchObject({
      ok: false,
      error: { reason: "mock_operation_rejected" },
    });
    await expect(runtime.invoke(invocation)).resolves.toMatchObject({
      ok: true,
      value: { key: "case-acquisition-retry", upserted: true },
    });
  });

  it("reconstructs a legacy expired built-in receipt after executor loss", async () => {
    let durableSnapshot: CapabilitySemanticToolRuntimeSnapshot = {
      schema: "paperclip.capability.semantic-tool-runtime.v1",
      resultSequence: 0,
      operationResults: {},
      extensions: [{
        key: `${OPEN.identity.runId}:upsert_case:expired-case`,
        input: '{"body":"Case body","key":"case-expired"}',
        status: "pending",
        ownerId: "terminated-executor",
        leaseExpiresAtMs: 1_000,
        phase: "executing",
      }],
    };
    const durableStore: CapabilitySemanticToolRuntimeStore = {
      load: () => structuredClone(durableSnapshot),
      save: (_runId, snapshot) => {
        durableSnapshot = structuredClone(snapshot);
      },
      compareAndSwap: (_runId, expected, snapshot) => {
        if (JSON.stringify(durableSnapshot) !== JSON.stringify(expected)) {
          return false;
        }
        durableSnapshot = structuredClone(snapshot);
        return true;
      },
    };
    const base = await runtimeFor({ scenarioGrants: ["cases:write"] });
    const restoredAdapter = CapabilityMockControlPlaneAdapter.restore(
      base.adapter.serialize(),
      { semanticToolRuntimeStore: durableStore },
    );
    const restored = new CapabilitySemanticToolRuntime({
      adapter: restoredAdapter,
      runId: OPEN.identity.runId,
      scenarioGrants: ["cases:write"],
      now: () => 1_001,
    });

    await expect(restored.invoke({
      operationId: "upsert_case",
      input: { key: "case-expired", body: "Case body" },
      idempotencyKey: "expired-case",
    })).resolves.toMatchObject({
      ok: true,
      operationResultId: "tool-result-1",
      value: { key: "case-expired", body: "Case body", upserted: true },
    });
    expect(durableSnapshot.extensions[0]).toMatchObject({
      status: "completed",
      resultId: "tool-result-1",
      execution: {
        value: { key: "case-expired", body: "Case body", upserted: true },
      },
    });
    expect(durableSnapshot.operationResults).toEqual({
      "tool-result-1": { key: "case-expired", body: "Case body", upserted: true },
    });
  });

  it("recovers an expired built-in extension from its prepared receipt", async () => {
    const observedExport = {
      schema: "paperclip.capability.mock-export.v1",
      company: { id: "company-1", name: "Previously Exported Company" },
      taskCount: 1,
      actorCount: 1,
    };
    let durableSnapshot: CapabilitySemanticToolRuntimeSnapshot = {
      schema: "paperclip.capability.semantic-tool-runtime.v1",
      resultSequence: 0,
      operationResults: {},
      extensions: [{
        key: `${OPEN.identity.runId}:export_company:prepared-export`,
        input: "{}",
        status: "pending",
        ownerId: "terminated-exporter",
        leaseExpiresAtMs: 1_000,
        phase: "executing",
        preparedExecution: {
          value: observedExport,
          commandResult: null,
          entityRefs: [],
        },
      }],
    };
    const durableStore: CapabilitySemanticToolRuntimeStore = {
      load: () => structuredClone(durableSnapshot),
      save: (_runId, snapshot) => { durableSnapshot = structuredClone(snapshot); },
      compareAndSwap: (_runId, expected, snapshot) => {
        if (JSON.stringify(durableSnapshot) !== JSON.stringify(expected)) return false;
        durableSnapshot = structuredClone(snapshot);
        return true;
      },
    };
    const base = await runtimeFor({ scenarioGrants: ["portability:export"] });
    const restoredAdapter = CapabilityMockControlPlaneAdapter.restore(
      base.adapter.serialize(),
      { semanticToolRuntimeStore: durableStore },
    );
    const resolveExpiredExtensionReceipt = vi.fn(async () => ({
      value: {
        ...observedExport,
        company: { id: "company-1", name: "Conflicting Resolver Company" },
      },
    }));
    const restored = new CapabilitySemanticToolRuntime({
      adapter: restoredAdapter,
      runId: OPEN.identity.runId,
      scenarioGrants: ["portability:export"],
      resolveExpiredExtensionReceipt,
      now: () => 1_001,
    });

    await expect(restored.invoke({
      operationId: "export_company",
      input: {},
      idempotencyKey: "prepared-export",
    })).resolves.toMatchObject({
      ok: true,
      operationResultId: "tool-result-1",
      value: observedExport,
    });
    expect(durableSnapshot.extensions[0]).toMatchObject({
      status: "completed",
      resultId: "tool-result-1",
      execution: { value: observedExport },
    });
    expect(resolveExpiredExtensionReceipt).not.toHaveBeenCalled();
  });

  it("terminally marks a legacy export without an exact receipt", async () => {
    let durableSnapshot: CapabilitySemanticToolRuntimeSnapshot = {
      schema: "paperclip.capability.semantic-tool-runtime.v1",
      resultSequence: 0,
      operationResults: {},
      extensions: [{
        key: `${OPEN.identity.runId}:export_company:expired-export`,
        input: "{}",
        status: "pending",
        ownerId: "terminated-exporter",
        leaseExpiresAtMs: 1_000,
        phase: "executing",
      }],
    };
    const durableStore: CapabilitySemanticToolRuntimeStore = {
      load: () => structuredClone(durableSnapshot),
      save: (_runId, snapshot) => {
        durableSnapshot = structuredClone(snapshot);
      },
      compareAndSwap: (_runId, expected, snapshot) => {
        if (JSON.stringify(durableSnapshot) !== JSON.stringify(expected)) {
          return false;
        }
        durableSnapshot = structuredClone(snapshot);
        return true;
      },
    };
    const base = await runtimeFor({
      scenarioGrants: ["portability:export"],
      seed: { company: { name: "Company State Changed After Execution" } },
    });
    const restoredAdapter = CapabilityMockControlPlaneAdapter.restore(
      base.adapter.serialize(),
      { semanticToolRuntimeStore: durableStore },
    );
    const restored = new CapabilitySemanticToolRuntime({
      adapter: restoredAdapter,
      runId: OPEN.identity.runId,
      scenarioGrants: ["portability:export"],
      now: () => 1_001,
    });

    await expect(restored.invoke({
      operationId: "export_company",
      input: {},
      idempotencyKey: "expired-export",
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "operation_unsupported",
        reason: "idempotency_receipt_unavailable",
      },
    });
    expect(durableSnapshot.extensions).toEqual([{
      key: `${OPEN.identity.runId}:export_company:expired-export`,
      input: "{}",
      status: "indeterminate",
      reason: "idempotency_receipt_unavailable",
    }]);
    expect(durableSnapshot.operationResults).toEqual({});

    const retriedAdapter = CapabilityMockControlPlaneAdapter.restore(
      base.adapter.serialize(),
      { semanticToolRuntimeStore: durableStore },
    );
    const retried = new CapabilitySemanticToolRuntime({
      adapter: retriedAdapter,
      runId: OPEN.identity.runId,
      scenarioGrants: ["portability:export"],
      now: () => 2_001,
    });
    await expect(retried.invoke({
      operationId: "export_company",
      input: {},
      idempotencyKey: "expired-export",
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "operation_unsupported",
        reason: "idempotency_receipt_unavailable",
      },
    });
    expect(durableSnapshot.operationResults).toEqual({});

    const authoritativeExport = {
      schema: "paperclip.capability.mock-export.v1",
      company: { id: "company-1", name: "Originally Exported Company" },
      taskCount: 1,
      actorCount: 1,
    };
    const resolvingAdapter = CapabilityMockControlPlaneAdapter.restore(
      base.adapter.serialize(),
      { semanticToolRuntimeStore: durableStore },
    );
    const resolving = new CapabilitySemanticToolRuntime({
      adapter: resolvingAdapter,
      runId: OPEN.identity.runId,
      scenarioGrants: ["portability:export"],
      resolveExpiredExtensionReceipt: async () => ({ value: authoritativeExport }),
      now: () => 3_001,
    });
    await expect(resolving.invoke({
      operationId: "export_company",
      input: {},
      idempotencyKey: "expired-export",
    })).resolves.toMatchObject({
      ok: true,
      operationResultId: "tool-result-1",
      value: authoritativeExport,
    });
    expect(durableSnapshot.extensions[0]).toMatchObject({
      status: "completed",
      resultId: "tool-result-1",
    });
  });

  it("adopts an authoritative completion that wins the recovery publication race", async () => {
    const authoritative = {
      key: "case-publication-race",
      body: "Original executor body",
      upserted: true,
    };
    let durableSnapshot: CapabilitySemanticToolRuntimeSnapshot = {
      schema: "paperclip.capability.semantic-tool-runtime.v1",
      resultSequence: 1,
      operationResults: { "tool-result-1": authoritative },
      extensions: [{
        key: `${OPEN.identity.runId}:upsert_case:publication-race`,
        input: '{"body":"Case body","key":"case-publication-race"}',
        status: "completed",
        resultId: "tool-result-1",
        execution: {
          value: authoritative,
          commandResult: null,
          entityRefs: ["case:case-publication-race"],
        },
      }],
    };
    const durableStore: CapabilitySemanticToolRuntimeStore = {
      load: () => structuredClone(durableSnapshot),
      save: (_runId, snapshot) => { durableSnapshot = structuredClone(snapshot); },
      compareAndSwap: (_runId, expected, snapshot) => {
        if (JSON.stringify(durableSnapshot) !== JSON.stringify(expected)) return false;
        durableSnapshot = structuredClone(snapshot);
        return true;
      },
    };
    const base = await runtimeFor({ scenarioGrants: ["cases:write"] });
    const restoredAdapter = CapabilityMockControlPlaneAdapter.restore(
      base.adapter.serialize(),
      { semanticToolRuntimeStore: durableStore },
    );
    const restored = new CapabilitySemanticToolRuntime({
      adapter: restoredAdapter,
      runId: OPEN.identity.runId,
      scenarioGrants: ["cases:write"],
    });

    expect(restored.reconcileExpiredExtensionReceipt({
      operationId: "upsert_case",
      input: { key: "case-publication-race", body: "Case body" },
      idempotencyKey: "publication-race",
      value: {
        key: "case-publication-race",
        body: "Stale recovery observation",
        upserted: true,
      },
      entityRefs: ["case:stale-observation"],
    })).toEqual({ resultId: "tool-result-1" });
    await expect(restored.invoke({
      operationId: "upsert_case",
      input: { key: "case-publication-race", body: "Case body" },
      idempotencyKey: "publication-race",
    })).resolves.toMatchObject({
      ok: true,
      operationResultId: "tool-result-1",
      value: authoritative,
    });
    expect(durableSnapshot.operationResults).toEqual({
      "tool-result-1": authoritative,
    });
  });

  it("resolves an expired mutable export receipt during a restored retry", async () => {
    const observedExport = {
      schema: "paperclip.capability.mock-export.v1",
      company: { id: "company-1", name: "Previously Exported Company" },
      taskCount: 1,
      actorCount: 1,
    };
    let durableSnapshot: CapabilitySemanticToolRuntimeSnapshot = {
      schema: "paperclip.capability.semantic-tool-runtime.v1",
      resultSequence: 0,
      operationResults: {},
      extensions: [{
        key: `${OPEN.identity.runId}:export_company:recovered-export`,
        input: "{}",
        status: "pending",
        ownerId: "terminated-exporter",
        leaseExpiresAtMs: 1_000,
        phase: "executing",
      }],
    };
    const durableStore: CapabilitySemanticToolRuntimeStore = {
      load: () => structuredClone(durableSnapshot),
      save: (_runId, snapshot) => { durableSnapshot = structuredClone(snapshot); },
      compareAndSwap: (_runId, expected, snapshot) => {
        if (JSON.stringify(durableSnapshot) !== JSON.stringify(expected)) return false;
        durableSnapshot = structuredClone(snapshot);
        return true;
      },
    };
    const base = await runtimeFor({ scenarioGrants: ["portability:export"] });
    const restoredAdapter = CapabilityMockControlPlaneAdapter.restore(
      base.adapter.serialize(),
      { semanticToolRuntimeStore: durableStore },
    );
    const resolveExpiredExtensionReceipt = vi.fn(async () => ({ value: observedExport }));
    const restored = new CapabilitySemanticToolRuntime({
      adapter: restoredAdapter,
      runId: OPEN.identity.runId,
      scenarioGrants: ["portability:export"],
      now: () => 1_001,
      resolveExpiredExtensionReceipt,
    });

    await expect(restored.invoke({
      operationId: "export_company",
      input: {},
      idempotencyKey: "recovered-export",
    })).resolves.toMatchObject({
      ok: true,
      operationResultId: "tool-result-1",
      value: observedExport,
    });
    expect(resolveExpiredExtensionReceipt).toHaveBeenCalledOnce();
    expect(durableSnapshot.extensions[0]).toMatchObject({
      status: "completed",
      resultId: "tool-result-1",
    });

    await restored.invoke({
      operationId: "export_company",
      input: {},
      idempotencyKey: "recovered-export",
    });
    expect(resolveExpiredExtensionReceipt).toHaveBeenCalledOnce();
  });

  it("allows only one restored runtime to reclaim an expired extension lease", async () => {
    let durableSnapshot: CapabilitySemanticToolRuntimeSnapshot = {
      schema: "paperclip.capability.semantic-tool-runtime.v1",
      resultSequence: 0,
      operationResults: {},
      extensions: [{
        key: `${OPEN.identity.runId}:upsert_case:contended-case`,
        input: '{"body":"Case body","key":"case-contended"}',
        status: "pending",
        ownerId: "terminated-executor",
        leaseExpiresAtMs: 1_000,
      }],
    };
    let successfulClaims = 0;
    const durableStore: CapabilitySemanticToolRuntimeStore = {
      load: () => structuredClone(durableSnapshot),
      save: (_runId, snapshot) => {
        durableSnapshot = structuredClone(snapshot);
      },
      compareAndSwap: (_runId, expected, snapshot) => {
        if (JSON.stringify(durableSnapshot) !== JSON.stringify(expected)) {
          return false;
        }
        if (snapshot.extensions.some((extension) =>
          extension.status === "pending" &&
          extension.ownerId !== "terminated-executor" &&
          extension.phase === "reserved"
        )) successfulClaims += 1;
        durableSnapshot = structuredClone(snapshot);
        return true;
      },
    };
    const base = await runtimeFor({ scenarioGrants: ["cases:write"] });
    const serialized = base.adapter.serialize();
    const runtimes = [0, 1].map(() => {
      const adapter = CapabilityMockControlPlaneAdapter.restore(serialized, {
        semanticToolRuntimeStore: durableStore,
      });
      return new CapabilitySemanticToolRuntime({
        adapter,
        runId: OPEN.identity.runId,
        scenarioGrants: ["cases:write"],
        now: () => 1_001,
      });
    });
    const invocation = {
      operationId: "upsert_case",
      input: { key: "case-contended", body: "Case body" },
      idempotencyKey: "contended-case",
    } as const;

    const results = await Promise.all(
      runtimes.map((runtime) => runtime.invoke(invocation)),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          code: "operation_unsupported",
          reason: "idempotency_recovery_in_flight",
        }),
      }),
    ]);
    expect(successfulClaims).toBe(1);
  });

  it("preserves a durable extension lease when a stale runtime saves another result", async () => {
    let durableSnapshot: CapabilitySemanticToolRuntimeSnapshot | null = null;
    const durableStore: CapabilitySemanticToolRuntimeStore = {
      load: () =>
        durableSnapshot === null ? null : structuredClone(durableSnapshot),
      save: (_runId, snapshot) => {
        durableSnapshot = structuredClone(snapshot);
      },
      compareAndSwap: (_runId, expected, snapshot) => {
        if (JSON.stringify(durableSnapshot) !== JSON.stringify(expected)) {
          return false;
        }
        durableSnapshot = structuredClone(snapshot);
        return true;
      },
    };
    const base = await runtimeFor({ semanticToolRuntimeStore: durableStore });
    const staleAdapter = CapabilityMockControlPlaneAdapter.restore(
      base.adapter.serialize(),
      { semanticToolRuntimeStore: durableStore },
    );
    const staleRuntime = new CapabilitySemanticToolRuntime({
      adapter: staleAdapter,
      runId: OPEN.identity.runId,
    });
    const pendingKey = `${OPEN.identity.runId}:upsert_case:owned-elsewhere`;
    durableSnapshot = {
      schema: "paperclip.capability.semantic-tool-runtime.v1",
      resultSequence: 0,
      operationResults: {},
      extensions: [{
        key: pendingKey,
        input: '{"body":"Case body","key":"case-owned"}',
        status: "pending",
        ownerId: "other-runtime",
        leaseExpiresAtMs: 30_000,
      }],
    };

    await expect(staleRuntime.invoke({
      operationId: "get_task_context",
      input: {},
    })).resolves.toMatchObject({ ok: true });

    expect(durableSnapshot.extensions).toEqual([
      expect.objectContaining({
        key: pendingKey,
        status: "pending",
        ownerId: "other-runtime",
      }),
    ]);
  });

  it("rejects incomplete or malformed restored extension executions", async () => {
    const { adapter, runtime } = await runtimeFor({
      scenarioGrants: ["cases:write"],
    });
    await runtime.invoke({
      operationId: "upsert_case",
      input: { key: "case-1", body: "Case body" },
      idempotencyKey: "upsert-case-1",
    });

    for (const mutate of [
      (execution: Record<string, unknown>) => delete execution.value,
      (execution: Record<string, unknown>) => {
        execution.commandResult = { disposition: "applied" };
      },
    ]) {
      const snapshot = JSON.parse(adapter.serialize()) as {
        semanticToolRuntimes: Record<
          string,
          { extensions: Array<{ execution: Record<string, unknown> }> }
        >;
      };
      const execution =
        snapshot.semanticToolRuntimes[OPEN.identity.runId]!.extensions[0]!
          .execution;
      mutate(execution);
      expect(() =>
        CapabilityMockControlPlaneAdapter.restore(JSON.stringify(snapshot)),
      ).toThrow("semantic tool runtime for run-tools is invalid");
    }
  });

  it("rejects restored extension receipts that disagree with inspection", async () => {
    const { adapter, runtime } = await runtimeFor({
      scenarioGrants: ["cases:write"],
    });
    const result = await runtime.invoke({
      operationId: "upsert_case",
      input: { key: "case-1", body: "Case body" },
      idempotencyKey: "upsert-case-1",
    });
    if (!result.ok) throw new Error("expected extension success");

    const snapshot = JSON.parse(adapter.serialize()) as {
      semanticToolRuntimes: Record<
        string,
        { operationResults: Record<string, unknown> }
      >;
    };
    snapshot.semanticToolRuntimes[OPEN.identity.runId]!
      .operationResults[result.operationResultId] = { upserted: false };

    expect(() =>
      CapabilityMockControlPlaneAdapter.restore(JSON.stringify(snapshot)),
    ).toThrow("semantic tool runtime for run-tools is invalid");
  });

  it("rejects a restored result sequence that can reuse a prior result id", async () => {
    const { adapter, runtime } = await runtimeFor({
      scenarioGrants: ["cases:write"],
    });
    const result = await runtime.invoke({
      operationId: "upsert_case",
      input: { key: "case-1", body: "Case body" },
      idempotencyKey: "upsert-case-1",
    });
    expect(result).toMatchObject({ operationResultId: "tool-result-1" });

    const snapshot = JSON.parse(adapter.serialize()) as {
      semanticToolRuntimes: Record<string, { resultSequence: number }>;
    };
    snapshot.semanticToolRuntimes[OPEN.identity.runId]!.resultSequence = 0;
    expect(() =>
      CapabilityMockControlPlaneAdapter.restore(JSON.stringify(snapshot)),
    ).toThrow("semantic tool runtime for run-tools is invalid");
  });

  it("serializes concurrent retries for required-idempotency extensions", async () => {
    const { runtime } = await runtimeFor({ scenarioGrants: ["cases:write"] });
    const invocation = {
      operationId: "upsert_case",
      input: { key: "case-concurrent", body: "Case body" },
      idempotencyKey: "upsert-case-concurrent",
    } as const;

    const [first, replay] = await Promise.all([
      runtime.invoke(invocation),
      runtime.invoke(invocation),
    ]);
    expect(first).toMatchObject({ ok: true });
    expect(replay).toMatchObject({ ok: true });
    if (!first.ok || !replay.ok) throw new Error("expected extension success");
    expect(replay.operationResultId).toBe(first.operationResultId);

    const [accepted, conflicting] = await Promise.all([
      runtime.invoke({ ...invocation, idempotencyKey: "shared-key" }),
      runtime.invoke({
        ...invocation,
        input: { key: "case-concurrent", body: "Different body" },
        idempotencyKey: "shared-key",
      }),
    ]);
    expect(accepted).toMatchObject({ ok: true });
    expect(conflicting).toMatchObject({
      ok: false,
      error: { code: "input_invalid", reason: "idempotency_key_conflict" },
    });
  });
});

describe("Capability security policy", () => {
  it("separates model-only secret delivery from every observable result boundary", async () => {
    expectTypeOf<CapabilityModelToolSuccess>().not.toMatchTypeOf<CapabilityToolSuccess>();

    const secret = "CAPABILITY_SECRET_SENTINEL_f42d4fbc";
    const { adapter, runtime } = await runtimeFor({
      scenarioGrants: ["secrets:values:read"],
      policy: { allowSecretValueAccess: true },
      resolveSecretValue: (name) => name === "DEPLOY_TOKEN" ? secret : null,
    });
    expect(runtime.visibleTools().tools.map((tool) => tool.operationId)).toContain("read_secret_value");
    const result = await runtime.invoke({
      operationId: "read_secret_value",
      input: { name: "DEPLOY_TOKEN" },
    });
    expect(result).toMatchObject({
      ok: true,
      value: { name: "DEPLOY_TOKEN", value: "[SECRET_VALUE]" },
    });
    if (!result.ok) throw new Error("expected secret read success");
    expect(result.authorization.redactions).toEqual([
      { path: "$.value", replacement: "[SECRET_VALUE]" },
    ]);
    expect(adapter.loadSemanticToolRuntime(OPEN.identity.runId)?.extensions)
      .toEqual([]);

    const inspected = await runtime.invoke({
      operationId: "inspect_operation_result",
      input: { operationResultId: result.operationResultId },
    });
    expect(inspected).toMatchObject({ ok: true, value: { value: "[SECRET_VALUE]" } });

    const modelDelivery = await runtime.invokeForModel({
      operationId: "read_secret_value",
      input: { name: "DEPLOY_TOKEN" },
    });
    expect(modelDelivery.readModelResult()).toMatchObject({
      schema: "paperclip.capability.model-tool-result.v1",
      ok: true,
      value: { name: "DEPLOY_TOKEN", value: secret },
    });
    expect(modelDelivery.observableResult).toMatchObject({
      schema: "paperclip.capability.tool-result.v1",
      ok: true,
      value: { name: "DEPLOY_TOKEN", value: "[SECRET_VALUE]" },
    });

    const observablePayloads = {
      publicInvocation: result,
      trace: { toolResult: modelDelivery },
      snapshot: structuredClone(modelDelivery),
      browser: { toolResult: modelDelivery.observableResult },
      authorization: runtime.authorizationRecords(),
    };
    expect(JSON.stringify(observablePayloads)).not.toContain(secret);

    const failing = await runtimeFor({
      scenarioGrants: ["secrets:values:read"],
      policy: { allowSecretValueAccess: true },
      resolveSecretValue: () => {
        throw new Error(`resolver rejected ${secret}`);
      },
    });
    const failedDelivery = await failing.runtime.invokeForModel({
      operationId: "read_secret_value",
      input: { name: "DEPLOY_TOKEN" },
    });
    expect(failedDelivery.observableResult).toMatchObject({
      ok: false,
      error: { code: "operation_unsupported", reason: "mock_operation_rejected" },
    });
    expect(JSON.stringify({
      error: failedDelivery,
      authorization: failing.runtime.authorizationRecords(),
    })).not.toContain(secret);

    let unclaimedResolverCalls = 0;
    const ungranted = await runtimeFor({
      scenarioGrants: ["secrets:values:read"],
      resolveSecretValue: () => {
        unclaimedResolverCalls += 1;
        return secret;
      },
    });
    expect(ungranted.runtime.visibleTools().tools.map((tool) => tool.operationId)).not.toContain("read_secret_value");
    const unclaimedDelivery = await ungranted.runtime.invokeForModel({
      operationId: "read_secret_value",
      input: { name: "DEPLOY_TOKEN" },
    });
    expect(unclaimedDelivery.readModelResult()).toMatchObject({
      ok: false,
      error: { code: "policy_denied", reason: "secret_value_access_disabled" },
    });
    expect(unclaimedResolverCalls).toBe(0);
    expect(JSON.stringify(unclaimedDelivery)).not.toContain(secret);
  });

  it("prohibits self approval even with the role and explicit decision claim", async () => {
    const approval: CapabilityFixtureApproval = {
      id: "approval-self",
      companyId: "company-1",
      taskIds: ["task-1"],
      type: "request_board_approval",
      status: "pending",
      requestedByActorId: "actor-1",
      payload: { summary: "self requested" },
      decisionNote: null,
      comments: [],
      createdAt: "2026-08-09T00:00:00.000Z",
      decidedAt: null,
    };
    const { adapter, runtime } = await runtimeFor({
      role: "approver",
      scenarioGrants: ["governance:approvals:decide"],
      seed: { approvals: [approval] },
    });
    const result = await runtime.invoke({
      operationId: "decide_approval",
      input: { approvalId: "approval-self", decision: "approved", note: "self approve" },
      idempotencyKey: "self-decision",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "policy_denied", reason: "self_approval_conflict" },
    });
    expect(adapter.snapshot().approvals[0]?.status).toBe("pending");
  });

  it("keeps the generic escape hatch test-only, explicitly granted, and allowlisted", async () => {
    const denied = await runtimeFor({ workMode: "skill_test", scenarioGrants: ["test:generic_api_request"] });
    expect(denied.runtime.visibleTools().tools.map((tool) => tool.operationId)).not.toContain("generic_api_request");

    const { runtime } = await runtimeFor({
      workMode: "skill_test",
      scenarioGrants: ["test:generic_api_request"],
      policy: {
        allowGenericEscapeHatch: true,
        genericEscapeHatchAllowlist: [{ method: "GET", path: "/mock/health" }],
      },
    });
    expect(runtime.visibleTools().tools.map((tool) => tool.operationId)).toContain("generic_api_request");
    const allowed = await runtime.invoke({
      operationId: "generic_api_request",
      input: { method: "GET", path: "/mock/health", headers: { authorization: "Bearer not-forwarded" } },
      idempotencyKey: "escape-1",
    });
    expect(allowed).toMatchObject({ ok: true, value: { status: 200, body: null } });
    expect(JSON.stringify(allowed)).not.toContain("not-forwarded");

    const blocked = await runtime.invoke({
      operationId: "generic_api_request",
      input: { method: "POST", path: "/api/companies" },
      idempotencyKey: "escape-2",
    });
    expect(blocked).toMatchObject({
      ok: false,
      error: { code: "policy_denied", reason: "generic_escape_hatch_target_denied" },
    });
  });
});
