import { describe, expect, it } from "vitest";

import type { CapabilityFixtureSeed } from "../mock-core/capability-control-plane-types.js";
import { CapabilityMockControlPlaneAdapter } from "../mock-core/capability-mock-control-plane-adapter.js";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "./catalog.js";
import { CapabilitySemanticDispatcher } from "./dispatcher.js";
import { createCapabilityProviderNeutralBinding } from "./provider-neutral.js";

const OPEN = {
  identity: {
    runId: "run-semantic-1",
    sessionId: "session-semantic-1",
    companyId: "company-1",
    issueId: "task-1",
    agentId: "actor-1",
  },
  backendKind: "mock" as const,
  sourceInstanceId: "semantic-test",
};

async function running(
  claims: string[] = [],
  seed: CapabilityFixtureSeed = {},
) {
  const adapter = new CapabilityMockControlPlaneAdapter({
    ...seed,
    actors: seed.actors ?? [
      {
        id: "actor-1",
        companyId: "company-1",
        name: "Semantic Engineer",
        role: "engineer",
        status: "active",
        budgetId: "budget-actor-1",
        capabilityGrants: claims,
      },
    ],
  });
  await adapter.start();
  await adapter.openFixtureRun({ ...OPEN, capabilities: claims });
  return adapter;
}

describe("Capability semantic catalog and authorization", () => {
  it("publishes a stable narrow catalog without credentials or control-plane-owned tools", () => {
    const names = CAPABILITY_SEMANTIC_TOOL_CATALOG.map((tool) => tool.operationId);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(28);
    expect(names).toContain("get_task_context");
    expect(names).toContain("finish_task");
    expect(names).not.toContain("checkout_task");
    expect(names).not.toContain("record_budget_usage");
    expect(names).not.toContain("resolve_human_input");
    expect(CAPABILITY_SEMANTIC_TOOL_CATALOG.find((tool) => tool.operationId === "generic_api_request"))
      .toMatchObject({ exposure: "optional", disabledByDefault: true });
    const schemaKeys = CAPABILITY_SEMANTIC_TOOL_CATALOG.flatMap((tool) =>
      Object.keys(tool.inputSchema.properties ?? {}),
    );
    expect(schemaKeys.join(" ")).not.toMatch(
      /authorization|password|credential|api.?key|access.?token|secret/i,
    );
  });

  it("exposes always tools while optional tools require actor, scenario, and explicit run claims", async () => {
    const adapter = await running();
    const dispatcher = new CapabilitySemanticDispatcher(adapter);
    const names = dispatcher.listTools(OPEN.identity.runId).map((tool) => tool.name);
    expect(names).toContain("get_task_context");
    expect(names).toContain("report_progress");
    expect(names).not.toContain("set_dependencies");
    expect(names).not.toContain("generic_api_request");

    const before = adapter.snapshot().revision;
    const denied = await dispatcher.dispatch({
      runId: OPEN.identity.runId,
      callId: "denied-dependencies",
      operationId: "set_dependencies",
      input: { idempotencyKey: "deps-1", blockedByTaskIds: [] },
    });
    expect(denied).toMatchObject({
      ok: false,
      denial: { code: "required_claim_missing", retryable: false },
    });
    expect(adapter.snapshot().revision).toBe(before);
  });

  it("executes a granted optional operation through the mock port", async () => {
    const claim = "dependencies:write";
    const adapter = await running([claim], {
      tasks: [
        {
          id: "task-1",
          companyId: "company-1",
          identifier: "MCK-1",
          title: "Active task",
          description: null,
          status: "todo",
          priority: "medium",
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
          title: "Blocking task",
          description: null,
          status: "todo",
          priority: "high",
          workMode: "standard",
          parentId: null,
          assigneeActorId: null,
          checkoutRunId: null,
          executionRunId: null,
          startedAt: null,
          completedAt: null,
        },
      ],
    });
    const dispatcher = new CapabilitySemanticDispatcher(adapter, {
      scenario: { id: "dependency-manager", claims: [claim] },
      explicitClaims: [claim],
    });
    expect(dispatcher.listTools(OPEN.identity.runId).map((tool) => tool.name))
      .toContain("set_dependencies");
    const result = await dispatcher.dispatch({
      runId: OPEN.identity.runId,
      callId: "set-dependencies",
      operationId: "set_dependencies",
      input: { idempotencyKey: "deps-1", blockedByTaskIds: ["task-2"] },
    });
    expect(result).toMatchObject({ ok: true, result: { disposition: "applied" } });
    expect(adapter.snapshot().blockers).toEqual([
      expect.objectContaining({ taskId: "task-1", blockedByTaskId: "task-2" }),
    ]);
  });

  it("rechecks policy immediately before every operation", async () => {
    const claim = "dependencies:write";
    const adapter = await running([claim]);
    let exposeClaim = true;
    const port = {
      snapshot: () => adapter.snapshot(),
      tryApplyCommand: adapter.tryApplyCommand.bind(adapter),
      context: (runId: string) => {
        const context = structuredClone(adapter.context(runId));
        context.capabilities = exposeClaim ? [claim] : [];
        return context;
      },
    };
    const dispatcher = new CapabilitySemanticDispatcher(port, {
      scenario: { id: "revocation", claims: [claim] },
      explicitClaims: [claim],
    });
    expect(dispatcher.listTools(OPEN.identity.runId).map((tool) => tool.name))
      .toContain("set_dependencies");
    exposeClaim = false;
    const before = adapter.snapshot().revision;
    const result = await dispatcher.dispatch({
      runId: OPEN.identity.runId,
      callId: "revoked-call",
      operationId: "set_dependencies",
      input: { idempotencyKey: "revoked-1", blockedByTaskIds: [] },
    });
    expect(result).toMatchObject({ ok: false, denial: { code: "required_claim_missing" } });
    expect(adapter.snapshot().revision).toBe(before);
  });

  it("returns typed denials for absent, mode-denied, and generic escape-hatch tools", async () => {
    const adapter = await running([], {
      tasks: [{
        id: "task-1",
        companyId: "company-1",
        identifier: "MCK-1",
        title: "Ask-only task",
        description: null,
        status: "todo",
        priority: "medium",
        workMode: "ask",
        parentId: null,
        assigneeActorId: "actor-1",
        checkoutRunId: null,
        executionRunId: null,
        startedAt: null,
        completedAt: null,
      }],
    });
    const dispatcher = new CapabilitySemanticDispatcher(adapter);
    const names = dispatcher.listTools(OPEN.identity.runId).map((tool) => tool.name);
    expect(names).not.toContain("write_document");
    expect(names).not.toContain("finish_task");
    await expect(dispatcher.dispatch({
      runId: OPEN.identity.runId,
      callId: "unknown",
      operationId: "paperclipApiRequest",
      input: {},
    })).resolves.toMatchObject({ ok: false, denial: { code: "tool_not_exposed" } });
    await expect(dispatcher.dispatch({
      runId: OPEN.identity.runId,
      callId: "mode-denied",
      operationId: "write_document",
      input: {},
    })).resolves.toMatchObject({ ok: false, denial: { code: "task_mode_denied" } });
  });

  it("rejects protected inputs before mutation and redacts authorization records", async () => {
    const claim = "governance:approvals:request";
    const adapter = await running([claim]);
    const dispatcher = new CapabilitySemanticDispatcher(adapter, {
      scenario: { id: "approval", claims: [claim] },
      explicitClaims: [claim],
    });
    const secret = "Bearer secret-value-123456";
    const before = adapter.snapshot().revision;
    const result = await dispatcher.dispatch({
      runId: OPEN.identity.runId,
      callId: "protected-approval",
      operationId: "request_approval",
      input: {
        idempotencyKey: "approval-secret",
        approvalType: "request_board_approval",
        payload: { authorization: secret },
      },
    });
    expect(result).toMatchObject({ ok: false, denial: { code: "protected_data_denied" } });
    expect(adapter.snapshot().revision).toBe(before);
    const serialized = JSON.stringify(dispatcher.authorizationRecords());
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts protected mock state from read results", async () => {
    const secret = "Bearer mock-secret-123456";
    const adapter = await running([], {
      comments: [{
        id: "comment-secret",
        taskId: "task-1",
        authorActorId: "actor-1",
        body: `diagnostic ${secret}`,
        createdAt: "2026-08-09T00:00:00.000Z",
      }],
    });
    const dispatcher = new CapabilitySemanticDispatcher(adapter);
    const result = await dispatcher.dispatch({
      runId: OPEN.identity.runId,
      callId: "history",
      operationId: "get_task_history",
      input: {},
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("applies always-tool commands and records authorization for every invocation", async () => {
    const adapter = await running();
    const dispatcher = new CapabilitySemanticDispatcher(adapter);
    const progress = await dispatcher.dispatch({
      runId: OPEN.identity.runId,
      callId: "progress",
      operationId: "report_progress",
      input: { idempotencyKey: "progress-1", body: "Semantic catalog is active." },
    });
    expect(progress).toMatchObject({ ok: true });
    expect(adapter.snapshot().comments).toEqual([
      expect.objectContaining({ body: "Semantic catalog is active." }),
    ]);
    const records = dispatcher.authorizationRecords().filter((record) => record.phase === "invocation");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ allowed: true, operationId: "report_progress", callId: "progress" });
  });

  it("keeps generated contracts identical across fake and live Codex bindings", () => {
    const fake = createCapabilityProviderNeutralBinding("fake");
    const live = createCapabilityProviderNeutralBinding("live_codex");
    expect(fake.bindingKind).toBe("fake");
    expect(live.bindingKind).toBe("live_codex");
    expect(live.contracts).toEqual(fake.contracts);
    expect(live.contracts.map((tool) => tool.name)).toEqual(
      CAPABILITY_SEMANTIC_TOOL_CATALOG.map((tool) => tool.operationId),
    );
  });
});
