import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { mapPaperclipExecutionToHermesRequest } from "./autonomous-contract.js";
import { execute } from "./execute.js";

function context(overrides: Record<string, unknown> = {}): AdapterExecutionContext {
  return {
    runId: "run-activation-1",
    agent: {
      id: "worker-activation-1",
      companyId: "tenant-activation-1",
      name: "Hermes",
      adapterType: "hermes_gateway",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: "task-activation-1",
    },
    config: {
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "activation-test-key",
    },
    context: {
      taskId: "task-activation-1",
      issueId: "issue-activation-1",
      projectId: "project-activation-1",
      boardId: "board-activation-1",
      autonomous: overrides,
    },
    onLog: async () => undefined,
  };
}

describe("Hermes gateway production activation seam", () => {
  it("builds deterministic state, action, and effect identity when heartbeat context is absent", () => {
    const first = mapPaperclipExecutionToHermesRequest(context());
    const second = mapPaperclipExecutionToHermesRequest(context());

    expect(first.body.autonomous).toMatchObject({
      schemaVersion: 1,
      executionId: "run-activation-1",
      taskId: "task-activation-1",
      attempt: 1,
      actionId: "autonomous-action/run-activation-1/task-activation-1/1/WAKEUP",
      idempotencyKey: "autonomous-idempotency/run-activation-1/task-activation-1/1/WAKEUP",
      risk: "LOW",
      stateEnvelope: {
        schemaVersion: 1,
        executionId: "run-activation-1",
        taskId: "task-activation-1",
        state: "PENDING",
        attempt: 1,
      },
    });
    expect(first.body.autonomous.effectFingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(first.body.autonomous.effectKey).toMatch(
      /^autonomous-effect\/autonomous-idempotency\/run-activation-1\/task-activation-1\/1\/WAKEUP\/[0-9a-f]{8}$/,
    );
    expect(first.body.autonomous.effectKey).toBe(second.body.autonomous.effectKey);
    expect(first.body.autonomous.effectFingerprint).toBe(second.body.autonomous.effectFingerprint);
  });

  it("keeps effect identity stable when only the heartbeat run id changes", () => {
    const make = (runId: string) => mapPaperclipExecutionToHermesRequest({
      ...context(),
      runId,
      context: {
        ...context().context,
        autonomous: {
          executionId: "stable-execution",
          taskId: "task-activation-1",
          actionId: "stable-action",
          idempotencyKey: "stable-idempotency",
        },
      },
    });
    const first = make("heartbeat-run-1");
    const second = make("heartbeat-run-2");
    expect(first.body.autonomous.effectFingerprint).toBe(second.body.autonomous.effectFingerprint);
    expect(first.body.autonomous.effectKey).toBe(second.body.autonomous.effectKey);
  });

  it("denies a non-low-risk execution without a passing gate before transport mapping", () => {
    expect(() => mapPaperclipExecutionToHermesRequest(context({
      risk: "HIGH",
      approval: "GRANTED",
      gates: [],
    }))).toThrowError(expect.objectContaining({ code: "hermes_gateway_risk_decision_required" }));
  });

  it("denies an explicitly failed or skipped gate before transport mapping", () => {
    expect(() => mapPaperclipExecutionToHermesRequest(context({
      gates: [{ gateId: "scope", decision: "SKIP" }],
    }))).toThrowError(expect.objectContaining({ code: "hermes_gateway_gate_denied" }));
  });

  it("propagates the activation envelope and effect identity through the remote run seam", async () => {
    const ctx = context();
    ctx.onMeta = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "remote-activation-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: run.completed\ndata: {\"status\":\"completed\",\"output\":\"done\"}\n\n"));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(ctx.onMeta).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        autonomous: expect.objectContaining({
          actionId: "autonomous-action/run-activation-1/task-activation-1/1/WAKEUP",
          idempotencyKey: "autonomous-idempotency/run-activation-1/task-activation-1/1/WAKEUP",
          state: "PENDING",
        }),
      }),
    }));
    const createCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const body = JSON.parse(String(createCall?.[1]?.body)) as {
      autonomous: {
        stateEnvelope: Record<string, unknown>;
        actionId: string;
        effectKey: string;
        effectFingerprint: string;
      };
    };
    expect(body.autonomous.stateEnvelope).toMatchObject({ executionId: "run-activation-1", state: "PENDING" });
    expect((result.resultJson?.autonomous as { telemetry?: Record<string, unknown> }).telemetry).toMatchObject({
      actionId: body.autonomous.actionId,
      effectKey: body.autonomous.effectKey,
      effectFingerprint: body.autonomous.effectFingerprint,
    });
  });
});
