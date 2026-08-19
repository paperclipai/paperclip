import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  CapabilityFixtureApproval,
  CapabilityFixtureSeed,
  CapabilityJsonValue,
} from "../mock-core/capability-control-plane-types.js";
import { CapabilityMockControlPlaneAdapter } from "../mock-core/capability-mock-control-plane-adapter.js";
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
  const adapter = new CapabilityMockControlPlaneAdapter({
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
  });
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
});

describe("Capability security policy", () => {
  it("separates model-only secret delivery from every observable result boundary", async () => {
    expectTypeOf<CapabilityModelToolSuccess>().not.toMatchTypeOf<CapabilityToolSuccess>();

    const secret = "CAPABILITY_SECRET_SENTINEL_f42d4fbc";
    const { runtime } = await runtimeFor({
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
