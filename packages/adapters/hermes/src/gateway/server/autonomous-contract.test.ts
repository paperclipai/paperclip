import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import {
  buildHermesGatewaySessionIdentity,
  mapPaperclipExecutionToHermesRequest,
  mapHermesGatewayHealthFailure,
  parseHermesGatewayConfig,
  projectHermesResponseEvidence,
} from "./autonomous-contract.js";
import { sessionCodec } from "./index.js";

const baseContext: AdapterExecutionContext = {
  runId: "run-1",
  agent: {
    id: "worker-1",
    companyId: "tenant-1",
    name: "Hermes",
    adapterType: "hermes_gateway",
    adapterConfig: {},
  },
  runtime: {
    sessionId: "hermes-session-1",
    sessionParams: null,
    sessionDisplayId: "hermes-session-1",
    taskKey: "task-1",
  },
  config: {
    apiBaseUrl: "http://127.0.0.1:8642",
    apiKey: "secret-key",
  },
  context: {},
  onLog: async () => undefined,
};

function autonomousContext(overrides: Record<string, unknown> = {}): AdapterExecutionContext {
  return {
    ...baseContext,
    config: { ...baseContext.config },
    context: {
      taskId: "task-1",
      issueId: "issue-1",
      autonomous: {
        executionId: "execution-1",
        taskId: "task-1",
        parentExecutionId: "parent-1",
        attempt: 2,
        actionId: "action-1",
        correlationId: "corr-1",
        workerId: "worker-1",
        scope: { tenantId: "tenant-1", projectId: "project-1", boardId: "board-1", taskId: "task-1" },
        risk: "HIGH",
        approval: "GRANTED",
        gates: [{ gateId: "scope", decision: "PASS" }],
        riskDecision: {
          decisionId: "autonomous-risk/action-1/HIGH/ALLOW/approval_and_rollback_present",
          actionId: "action-1",
          executionId: "execution-1",
          taskId: "task-1",
          risk: "HIGH",
          outcome: "ALLOW",
          reasonCode: "approval_and_rollback_present",
          disposable: false,
          requiresCheckpoint: false,
          requiresBackup: false,
          requiresApproval: true,
          requiresRollback: true,
          checkpointManifestId: null,
          backupManifestId: null,
          checkpointManifest: null,
          backupManifest: null,
          rollback: {
            manifestId: "rollback-1",
            actionId: "action-1",
            executionId: "execution-1",
            taskId: "task-1",
            createdAt: "2026-09-27T00:00:00.000Z",
            backupManifestId: "backup-1",
            command: {
              rollbackId: "rollback-command-1",
              manifestId: "backup-1",
              command: "paperclip restore",
              args: ["--manifest", "backup-1"],
              reason: "restore the prior backup",
            },
          },
        },
        ...overrides,
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hermes gateway autonomous boundary", () => {
  it("fails closed for unsupported or malformed gateway config", () => {
    expect(parseHermesGatewayConfig({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      sessionKeyStrategy: "unsupported",
    }).ok).toBe(false);
    expect(parseHermesGatewayConfig({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      headers: "{not-json}",
    }).ok).toBe(false);
  });

  it("maps persistent issue sessions deterministically and round-trips codec identity", () => {
    const identity = buildHermesGatewaySessionIdentity({
      strategy: "issue",
      companyId: "tenant-1",
      agentId: "worker-1",
      runId: "run-1",
      issueId: "issue-1",
      priorSessionId: "hermes-session-1",
      persistSession: true,
    });
    expect(identity).toEqual({
      strategy: "issue",
      sessionKey: "paperclip:company:tenant-1:agent:worker-1:issue:issue-1",
      priorSessionId: "hermes-session-1",
      persistent: true,
    });
    expect(sessionCodec.deserialize(sessionCodec.serialize({
      hermesSessionId: identity.priorSessionId,
      sessionKey: identity.sessionKey,
      strategy: identity.strategy,
    }))).toEqual({
      hermesSessionId: "hermes-session-1",
      sessionKey: "paperclip:company:tenant-1:agent:worker-1:issue:issue-1",
      strategy: "issue",
    });
  });

  it("denies a foreign tenant or task scope before transport mapping", () => {
    expect(() => mapPaperclipExecutionToHermesRequest(autonomousContext({
      scope: { tenantId: "foreign-tenant", projectId: "project-1", boardId: "board-1", taskId: "task-1" },
    }))).toThrowError(expect.objectContaining({ code: "hermes_gateway_scope_denied" }));
    expect(() => mapPaperclipExecutionToHermesRequest(autonomousContext({
      scope: { tenantId: "tenant-1", projectId: "project-1", boardId: "board-1", taskId: "foreign-task" },
    }))).toThrowError(expect.objectContaining({ code: "hermes_gateway_scope_denied" }));
  });

  it("fails closed when riskDecision risk diverges from the execution envelope", () => {
    expect(() => mapPaperclipExecutionToHermesRequest(autonomousContext({
      riskDecision: {
        decisionId: "autonomous-risk/action/MEDIUM/ALLOW/checkpoint_and_backup_present",
        actionId: "action-1",
        executionId: "execution-1",
        taskId: "task-1",
        risk: "MEDIUM",
        outcome: "ALLOW",
        reasonCode: "checkpoint_and_backup_present",
        disposable: false,
        requiresCheckpoint: true,
        requiresBackup: true,
        requiresApproval: false,
        requiresRollback: false,
        checkpointManifestId: "checkpoint-1",
        backupManifestId: "backup-1",
        checkpointManifest: null,
        backupManifest: null,
        rollback: null,
      },
    }))).toThrowError(expect.objectContaining({ code: "hermes_gateway_risk_decision_mismatch" }));
  });

  it("requires a serialized risk decision for every non-low-risk action", () => {
    expect(() => mapPaperclipExecutionToHermesRequest(autonomousContext({ riskDecision: undefined })))
      .toThrowError(expect.objectContaining({ code: "hermes_gateway_risk_decision_required" }));
  });

  it("rejects divergent top-level and nested parent execution lineage", () => {
    const ctx = autonomousContext();
    ctx.context.parentExecutionId = "top-level-parent";
    expect(() => mapPaperclipExecutionToHermesRequest(ctx)).toThrowError(
      expect.objectContaining({ code: "hermes_gateway_parent_execution_mismatch" }),
    );
  });

  it("requires canonical decision identifiers, reason codes, and serialized manifest bindings", () => {
    const ctx = autonomousContext();
    const autonomous = ctx.context.autonomous as Record<string, unknown>;
    const decision = autonomous.riskDecision as Record<string, unknown>;

    expect(() => mapPaperclipExecutionToHermesRequest(autonomousContext({
      riskDecision: { ...decision, decisionId: "tampered-decision" },
    }))).toThrowError(expect.objectContaining({ code: "hermes_gateway_risk_decision_denied" }));

    expect(() => mapPaperclipExecutionToHermesRequest(autonomousContext({
      riskDecision: {
        ...decision,
        decisionId: "autonomous-risk/action-1/HIGH/ALLOW/missing_rollback",
        reasonCode: "missing_rollback",
      },
    }))).toThrowError(expect.objectContaining({ code: "hermes_gateway_risk_decision_denied" }));

    expect(() => mapPaperclipExecutionToHermesRequest(autonomousContext({
      riskDecision: {
        ...decision,
        rollback: { ...(decision.rollback as Record<string, unknown>), taskId: "foreign-task" },
      },
    }))).toThrowError(expect.objectContaining({ code: "hermes_gateway_risk_decision_denied" }));
  });

  it("fails closed when nested and state-envelope parent lineage diverges", () => {
    const ctx = autonomousContext();
    const autonomous = ctx.context.autonomous as Record<string, unknown>;
    autonomous.stateEnvelope = {
      schemaVersion: 1,
      executionId: "execution-1",
      taskId: "task-1",
      parentExecutionId: "different-parent",
      risk: "HIGH",
      state: "PENDING",
      dependencies: [],
      workers: [],
      gates: [{ gateId: "scope", decision: "PASS" }],
      attempt: 2,
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
    };
    expect(() => mapPaperclipExecutionToHermesRequest(ctx)).toThrowError(
      expect.objectContaining({ code: "hermes_gateway_parent_execution_mismatch" }),
    );
  });

  it("maps the execution envelope into a redaction-safe Hermes request context", () => {
    const request = mapPaperclipExecutionToHermesRequest(autonomousContext());
    expect(request.body.autonomous).toMatchObject({
      executionId: "execution-1",
      taskId: "task-1",
      parentExecutionId: "parent-1",
      attempt: 2,
      actionId: "action-1",
      correlationId: "corr-1",
      workerId: "worker-1",
      risk: "HIGH",
      approval: "GRANTED",
    });
    expect(JSON.stringify(request)).not.toContain("secret");
    expect(JSON.stringify(request)).not.toMatch(/chain.of.thought|reasoning|raw.output/i);
  });

  it("fails execute closed on malformed config without invoking transport", async () => {
    const ctx = autonomousContext();
    ctx.config.sessionKeyStrategy = "not-supported";
    const fetchMock = vi.fn(async () => new Response("unexpected", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    expect(result.errorCode).toBe("hermes_gateway_config_unsupported_session_strategy");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("executes the mapped envelope through fake HTTP/SSE transport and returns redacted evidence", async () => {
    const ctx = autonomousContext();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "hermes-run-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode([
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"Authorization: Bearer secret-key; reasoning: hidden\"}",
              "",
            ].join("\n")));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    const createCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const requestBody = JSON.parse(String(createCall?.[1]?.body)) as Record<string, unknown>;
    const evidence = (result.resultJson?.autonomous ?? {}) as Record<string, unknown>;

    expect(result.exitCode).toBe(0);
    expect(requestBody.autonomous).toMatchObject({ actionId: "action-1", correlationId: "corr-1", attempt: 2 });
    expect(evidence).toHaveProperty("gateEvidence");
    expect(JSON.stringify(evidence)).not.toContain("secret-key");
    expect(JSON.stringify(evidence)).not.toMatch(/reasoning|hidden/i);
  });

  it("projects timeout and health failures into bounded activity evidence", () => {
    expect(mapHermesGatewayHealthFailure({ unreachable: true })).toEqual({
      errorCode: "hermes_gateway_health_unreachable",
      errorFamily: "transient_upstream",
    });
    expect(mapHermesGatewayHealthFailure({ status: 503 })).toEqual({
      errorCode: "hermes_gateway_health_failed",
      errorFamily: "transient_upstream",
    });
    const evidence = projectHermesResponseEvidence({
      envelope: mapPaperclipExecutionToHermesRequest(autonomousContext()).envelope,
      runId: "hermes-run-1",
      status: "timeout",
      exitCode: 1,
      summary: "Authorization: Bearer secret-key; reasoning: private chain of thought",
      errorCode: "hermes_gateway_timeout",
    });
    expect(evidence.gateEvidence[0]).toMatchObject({ decision: "FAIL", metadata: { exitCode: 1 } });
    expect(evidence.activity.summary).toContain("[REDACTED]");
    expect(JSON.stringify(evidence)).not.toContain("secret-key");
    expect(JSON.stringify(evidence)).not.toMatch(/private chain of thought|reasoning/i);
  });

  it("bounds evidence references independently of action id length", () => {
    const envelope = { ...mapPaperclipExecutionToHermesRequest(autonomousContext()).envelope, actionId: `action-${"x".repeat(240)}` };
    const evidence = projectHermesResponseEvidence({ envelope, runId: "run-1", status: "completed", exitCode: 0 });
    const evidenceRef = evidence.gateEvidence[0].evidenceRef;
    expect(evidenceRef.length).toBeLessThanOrEqual(512);
    expect(evidenceRef).not.toContain(envelope.actionId);
  });
});
