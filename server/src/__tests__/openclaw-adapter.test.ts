import { afterEach, describe, expect, it, vi } from "vitest";
import { execute, testEnvironment } from "@paperclipai/adapter-openclaw/server";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

function buildContext(
  config: Record<string, unknown>,
  overrides?: Partial<AdapterExecutionContext>,
): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: {
      id: "agent-123",
      companyId: "company-123",
      name: "OpenClaw Agent",
      adapterType: "openclaw",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {
      taskId: "task-123",
      issueId: "issue-123",
      wakeReason: "issue_assigned",
      issueIds: ["issue-123"],
    },
    onLog: async () => {},
    ...overrides,
  };
}

function sseResponse(lines: string[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    statusText: "OK",
    headers: {
      "content-type": "text/event-stream",
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("openclaw adapter execute", () => {
  it("uses SSE by default and streams into one run", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'event: response.delta\n',
        'data: {"type":"response.delta","delta":"hi"}\n\n',
        'event: response.completed\n',
        'data: {"type":"response.completed","status":"completed"}\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const onLog = vi.fn<AdapterExecutionContext["onLog"]>().mockResolvedValue(undefined);

    const result = await execute(
      buildContext(
        {
          url: "https://agent.example/gateway",
          method: "POST",
          payloadTemplate: { foo: "bar" },
        },
        { onLog },
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as Record<string, unknown>;
    expect(body.foo).toBe("bar");
    expect(body.stream).toBe(true);
    expect(body.sessionKey).toBe("paperclip");
    expect((body.paperclip as Record<string, unknown>).runId).toBe("run-123");
    expect((body.paperclip as Record<string, unknown>).sessionKey).toBe("paperclip");
    expect((body.paperclip as Record<string, unknown>).streamTransport).toBe("sse");
    expect(onLog).toHaveBeenCalled();
  });

  it("derives issue session keys when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'event: done\n',
        'data: [DONE]\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(
      buildContext({
        url: "https://agent.example/gateway",
        method: "POST",
        sessionKeyStrategy: "issue",
      }),
    );

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as Record<string, unknown>;
    expect(body.sessionKey).toBe("paperclip:issue:issue-123");
    expect((body.paperclip as Record<string, unknown>).sessionKey).toBe("paperclip:issue:issue-123");
  });

  it("fails when SSE endpoint does not return text/event-stream", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        statusText: "OK",
        headers: {
          "content-type": "application/json",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(
      buildContext({
        url: "https://agent.example/gateway",
        method: "POST",
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("openclaw_sse_expected_event_stream");
  });

  it("uses wake text payload for /hooks/wake endpoints in webhook mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, statusText: "OK" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(
      buildContext({
        url: "https://agent.example/hooks/wake",
        method: "POST",
        streamTransport: "webhook",
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as Record<string, unknown>;
    expect(body.mode).toBe("now");
    expect(typeof body.text).toBe("string");
    expect(body.paperclip).toBeUndefined();
  });

  it("retries with wake text payload when endpoint reports text required in webhook mode", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: "text required" }), {
          status: 400,
          statusText: "Bad Request",
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200, statusText: "OK" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(
      buildContext({
        url: "https://agent.example/hooks/paperclip",
        method: "POST",
        streamTransport: "webhook",
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as Record<string, unknown>;
    expect(firstBody.paperclip).toBeTypeOf("object");

    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? "{}")) as Record<string, unknown>;
    expect(secondBody.mode).toBe("now");
    expect(typeof secondBody.text).toBe("string");
    expect(result.resultJson?.compatibilityMode).toBe("wake_text");
  });
});

describe("openclaw adapter environment checks", () => {
  it("reports compatibility mode info for /hooks/wake endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 405, statusText: "Method Not Allowed" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-123",
      adapterType: "openclaw",
      config: {
        url: "https://agent.example/hooks/wake",
      },
      deployment: {
        mode: "authenticated",
        exposure: "private",
        bindHost: "paperclip.internal",
        allowedHostnames: ["paperclip.internal"],
      },
    });

    const compatibilityCheck = result.checks.find(
      (check) => check.code === "openclaw_wake_endpoint_compat_mode",
    );
    expect(compatibilityCheck?.level).toBe("info");
  });
});
