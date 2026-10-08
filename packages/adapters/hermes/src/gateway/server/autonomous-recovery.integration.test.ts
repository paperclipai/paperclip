import { randomUUID } from "node:crypto";

import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDisposableAutonomousFixture,
  type DisposableAutonomousFixture,
  type DisposableScope,
} from "@paperclipai/shared/testing/autonomous-disposable-fixture.js";
import { execute } from "./execute.js";
import { mapPaperclipExecutionToHermesRequest } from "./autonomous-contract.js";
import { sessionCodec } from "./index.js";

const fixtures: DisposableAutonomousFixture[] = [];

function id(label: string): string {
  return `d12-${label}-${randomUUID()}`;
}

function context(input: {
  runId: string;
  taskId: string;
  issueId: string;
  scope: DisposableScope;
  executionId: string;
  actionId: string;
  sessionId: string | null;
  sessionKey?: string | null;
  timeoutSec: number;
  envelope: Record<string, unknown>;
}): AdapterExecutionContext {
  return {
    runId: input.runId,
    agent: {
      id: input.scope.tenantId === "tenant" ? "worker" : input.scope.tenantId,
      companyId: input.scope.tenantId,
      name: "Hermes recovery fixture",
      adapterType: "hermes_gateway",
      adapterConfig: {},
    },
    runtime: {
      sessionId: input.sessionId,
      sessionParams: input.sessionId
        ? sessionCodec.serialize({
            hermesSessionId: input.sessionId,
            ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
            strategy: "issue",
          })
        : null,
      sessionDisplayId: input.sessionId,
      taskKey: input.taskId,
    },
    config: {
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "fixture-secret",
      sessionKeyStrategy: "issue",
      persistSession: true,
      timeoutSec: input.timeoutSec,
      eventReconnectMs: 250,
      pollIntervalMs: 250,
    },
    context: {
      taskId: input.taskId,
      issueId: input.issueId,
      projectId: input.scope.projectId,
      boardId: input.scope.boardId,
      autonomous: {
        executionId: input.executionId,
        taskId: input.taskId,
        parentExecutionId: null,
        attempt: 1,
        actionId: input.actionId,
        correlationId: `correlation-${input.runId}`,
        workerId: "worker",
        scope: {
          tenantId: input.scope.tenantId,
          projectId: input.scope.projectId,
          boardId: input.scope.boardId,
          taskId: input.taskId,
        },
        risk: "LOW",
        approval: "NOT_REQUIRED",
        gates: [],
        stateEnvelope: input.envelope,
      },
    },
    onLog: async () => undefined,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

describe("D12 Hermes gateway crash/restart integration", () => {
  it("rehydrates the durable Hermes session checkpoint with task identity, timeout, and redacted telemetry", async () => {
    const fixture = await createDisposableAutonomousFixture();
    fixtures.push(fixture);
    const scope: DisposableScope = {
      tenantId: id("tenant"),
      projectId: id("project"),
      boardId: id("board"),
    };
    const taskId = id("task");
    const issueId = id("issue");
    const workerId = "worker";
    fixture.addTask({ taskId, scope });
    expect(fixture.claim(taskId, workerId).outcome).toBe("CLAIMED");
    const envelope = fixture.getEnvelope(taskId);
    const executionId = envelope.executionId;
    const bodies: Record<string, unknown>[] = [];
    let remoteRun = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        remoteRun += 1;
        return new Response(JSON.stringify({ run_id: `hermes-run-${remoteRun}`, status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode([
              "event: run.completed",
              "data: {\"status\":\"completed\",\"session_id\":\"hermes-session-stable\",\"output\":\"Authorization: Bearer fixture-secret reasoning: hidden\"}",
              "",
            ].join("\n")));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ status: "completed", session_id: "hermes-session-stable" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = context({
      runId: id("run-one"),
      taskId,
      issueId,
      scope,
      executionId,
      actionId: id("action-one"),
      sessionId: null,
      timeoutSec: 37,
      envelope,
    });
    const firstMapped = mapPaperclipExecutionToHermesRequest(first);
    const firstResult = await execute(first);
    const firstSession = sessionCodec.deserialize(firstResult.sessionParams);
    expect(firstResult.exitCode).toBe(0);
    expect(firstSession).toMatchObject({
      hermesSessionId: "hermes-session-stable",
      strategy: "issue",
    });
    expect(sessionCodec.deserialize(sessionCodec.serialize({
      hermesSessionId: "hermes-session-stable",
      sessionKey: firstMapped.session.sessionKey,
      strategy: "issue",
    }))).toEqual({
      hermesSessionId: "hermes-session-stable",
      sessionKey: firstMapped.session.sessionKey,
      strategy: "issue",
    });
    fixture.persistSessionCheckpoint({
      runId: first.runId,
      taskId,
      issueId,
      sessionId: "hermes-session-stable",
      sessionKey: firstMapped.session.sessionKey!,
      timeoutSec: 37,
    });

    const restarted = await fixture.restartLike();
    fixtures.push(restarted);
    const checkpoint = restarted.getSessionCheckpoint(first.runId);
    const second = context({
      runId: id("run-two"),
      taskId,
      issueId,
      scope,
      executionId,
      actionId: id("action-two"),
      sessionId: checkpoint.sessionId,
      sessionKey: checkpoint.sessionKey,
      timeoutSec: checkpoint.timeoutSec,
      envelope: restarted.getEnvelope(taskId),
    });
    const secondMapped = mapPaperclipExecutionToHermesRequest(second);
    const secondResult = await execute(second);
    const secondSession = sessionCodec.deserialize(secondResult.sessionParams);
    const secondBody = bodies[1]!;

    expect(checkpoint).toEqual({
      runId: first.runId,
      taskId,
      issueId,
      sessionId: "hermes-session-stable",
      sessionKey: firstMapped.session.sessionKey,
      timeoutSec: 37,
    });
    expect(secondMapped.session).toEqual({
      strategy: "issue",
      sessionKey: firstMapped.session.sessionKey,
      priorSessionId: "hermes-session-stable",
      persistent: true,
    });
    expect(secondBody.run_context).toMatchObject({ executionId, timeoutSec: 37 });
    expect(secondBody.session_context).toMatchObject({
      sessionKey: firstMapped.session.sessionKey,
      priorSessionId: "hermes-session-stable",
      persistent: true,
    });
    expect(secondSession).toMatchObject({
      hermesSessionId: "hermes-session-stable",
      strategy: "issue",
    });
    expect(secondResult.resultJson).toMatchObject({
      autonomous: {
        telemetry: {
          provider: "hermes_gateway",
          runId: "hermes-run-2",
          actionId: secondMapped.envelope.actionId,
          correlationId: secondMapped.envelope.correlationId,
        },
      },
    });
    const evidence = JSON.stringify(secondResult.resultJson);
    const persisted = restarted.persistedRuntimeText();
    expect(evidence).not.toContain("fixture-secret");
    expect(evidence).not.toMatch(/reasoning|hidden|chain.of.thought/i);
    expect(JSON.stringify(secondBody)).not.toContain("fixture-secret");
    expect(persisted).not.toMatch(/fixture-secret|reasoning|hidden|chain.of.thought/i);
  });
});
