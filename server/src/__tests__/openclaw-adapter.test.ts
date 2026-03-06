import { afterEach, describe, expect, it, vi } from "vitest";
import { execute, testEnvironment, onHireApproved } from "@paperclipai/adapter-openclaw/server";
import { parseOpenClawStdoutLine } from "@paperclipai/adapter-openclaw/ui";
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

describe("openclaw ui stdout parser", () => {
  it("parses SSE deltas into assistant streaming entries", () => {
    const ts = "2026-03-05T23:07:16.296Z";
    const line =
      '[openclaw:sse] event=response.output_text.delta data={"type":"response.output_text.delta","delta":"hello"}';

    expect(parseOpenClawStdoutLine(line, ts)).toEqual([
      {
        kind: "assistant",
        ts,
        text: "hello",
        delta: true,
      },
    ]);
  });

  it("parses stdout-prefixed SSE deltas and preserves spacing", () => {
    const ts = "2026-03-05T23:07:16.296Z";
    const line =
      'stdout[openclaw:sse] event=response.output_text.delta data={"type":"response.output_text.delta","delta":" can"}';

    expect(parseOpenClawStdoutLine(line, ts)).toEqual([
      {
        kind: "assistant",
        ts,
        text: " can",
        delta: true,
      },
    ]);
  });

  it("parses response.completed into usage-aware result entries", () => {
    const ts = "2026-03-05T23:07:20.269Z";
    const line = JSON.stringify({
      type: "response.completed",
      response: {
        status: "completed",
        usage: {
          input_tokens: 12,
          output_tokens: 34,
          cached_input_tokens: 5,
        },
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "All done",
              },
            ],
          },
        ],
      },
    });

    expect(parseOpenClawStdoutLine(`[openclaw:sse] event=response.completed data=${line}`, ts)).toEqual([
      {
        kind: "result",
        ts,
        text: "All done",
        inputTokens: 12,
        outputTokens: 34,
        cachedTokens: 5,
        costUsd: 0,
        subtype: "completed",
        isError: false,
        errors: [],
      },
    ]);
  });

  it("maps SSE errors to stderr entries", () => {
    const ts = "2026-03-05T23:07:20.269Z";
    const line =
      '[openclaw:sse] event=response.failed data={"type":"response.failed","error":"timeout"}';

    expect(parseOpenClawStdoutLine(line, ts)).toEqual([
      {
        kind: "stderr",
        ts,
        text: "timeout",
      },
    ]);
  });

  it("maps stderr-prefixed lines to stderr transcript entries", () => {
    const ts = "2026-03-05T23:07:20.269Z";
    const line = "stderr OpenClaw transport error";

    expect(parseOpenClawStdoutLine(line, ts)).toEqual([
      {
        kind: "stderr",
        ts,
        text: "OpenClaw transport error",
      },
    ]);
  });
});

describe("openclaw adapter execute", () => {
  it("uses strict SSE and includes canonical PAPERCLIP context in text payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        "event: response.completed\n",
        'data: {"type":"response.completed","status":"completed"}\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(
      buildContext({
        url: "https://agent.example/sse",
        method: "POST",
        payloadTemplate: { foo: "bar", text: "OpenClaw task prompt" },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as Record<string, unknown>;
    expect(body.foo).toBe("bar");
    expect(body.stream).toBe(true);
    expect(body.sessionKey).toBe("paperclip");
    expect((body.paperclip as Record<string, unknown>).streamTransport).toBe("sse");
    expect((body.paperclip as Record<string, unknown>).runId).toBe("run-123");
    expect((body.paperclip as Record<string, unknown>).sessionKey).toBe("paperclip");
    expect(
      ((body.paperclip as Record<string, unknown>).env as Record<string, unknown>).PAPERCLIP_RUN_ID,
    ).toBe("run-123");
    const text = String(body.text ?? "");
    expect(text).toContain("OpenClaw task prompt");
    expect(text).toContain("PAPERCLIP_RUN_ID=run-123");
    expect(text).toContain("PAPERCLIP_AGENT_ID=agent-123");
    expect(text).toContain("PAPERCLIP_COMPANY_ID=company-123");
    expect(text).toContain("PAPERCLIP_TASK_ID=task-123");
    expect(text).toContain("PAPERCLIP_WAKE_REASON=issue_assigned");
    expect(text).toContain("PAPERCLIP_LINKED_ISSUE_IDS=issue-123");
  });

  it("uses paperclipApiUrl override when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        "event: response.completed\n",
        'data: {"type":"response.completed","status":"completed"}\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(
      buildContext({
        url: "https://agent.example/sse",
        method: "POST",
        paperclipApiUrl: "http://dotta-macbook-pro:3100",
      }),
    );

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as Record<string, unknown>;
    const paperclip = body.paperclip as Record<string, unknown>;
    const env = paperclip.env as Record<string, unknown>;
    expect(env.PAPERCLIP_API_URL).toBe("http://dotta-macbook-pro:3100/");
    expect(String(body.text ?? "")).toContain("PAPERCLIP_API_URL=http://dotta-macbook-pro:3100/");
  });

  it("logs outbound header keys for auth debugging", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        "event: response.completed\n",
        'data: {"type":"response.completed","status":"completed"}\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const logs: string[] = [];
    const result = await execute(
      buildContext(
        {
          url: "https://agent.example/sse",
          method: "POST",
          headers: {
            "x-openclaw-auth": "gateway-token",
          },
        },
        {
          onLog: async (_stream, chunk) => {
            logs.push(chunk);
          },
        },
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(
      logs.some((line) => line.includes("[openclaw] outbound header keys:") && line.includes("x-openclaw-auth")),
    ).toBe(true);
  });

  it("derives Authorization header from x-openclaw-auth when webhookAuthHeader is unset", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        "event: response.completed\n",
        'data: {"type":"response.completed","status":"completed"}\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(
      buildContext({
        url: "https://agent.example/sse",
        method: "POST",
        headers: {
          "x-openclaw-auth": "gateway-token",
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers["x-openclaw-auth"]).toBe("gateway-token");
    expect(headers.authorization).toBe("Bearer gateway-token");
  });

  it("derives issue session keys when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        "event: done\n",
        "data: [DONE]\n\n",
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(
      buildContext({
        url: "https://agent.example/sse",
        method: "POST",
        sessionKeyStrategy: "issue",
      }),
    );

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as Record<string, unknown>;
    expect(body.sessionKey).toBe("paperclip:issue:issue-123");
    expect((body.paperclip as Record<string, unknown>).sessionKey).toBe("paperclip:issue:issue-123");
  });

  it("maps requests to OpenResponses schema for /v1/responses endpoints", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        "event: response.completed\n",
        'data: {"type":"response.completed","status":"completed"}\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(
      buildContext({
        url: "https://agent.example/v1/responses",
        method: "POST",
        payloadTemplate: {
          model: "openclaw",
          user: "paperclip",
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.model).toBe("openclaw");
    expect(typeof body.input).toBe("string");
    expect(String(body.input)).toContain("PAPERCLIP_RUN_ID=run-123");
    expect(body.metadata).toBeTypeOf("object");
    expect((body.metadata as Record<string, unknown>).PAPERCLIP_RUN_ID).toBe("run-123");
    expect(body.text).toBeUndefined();
    expect(body.paperclip).toBeUndefined();
    expect(body.sessionKey).toBeUndefined();

    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers["x-openclaw-session-key"]).toBe("paperclip");
  });

  it("appends wake text when OpenResponses input is provided as a message object", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        "event: response.completed\n",
        'data: {"type":"response.completed","status":"completed"}\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(
      buildContext({
        url: "https://agent.example/v1/responses",
        method: "POST",
        payloadTemplate: {
          model: "openclaw",
          input: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "start with this context",
              },
            ],
          },
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as Record<string, unknown>;
    const input = body.input as Record<string, unknown>;
    expect(input.type).toBe("message");
    expect(input.role).toBe("user");
    expect(Array.isArray(input.content)).toBe(true);

    const content = input.content as Record<string, unknown>[];
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({
      type: "input_text",
      text: "start with this context",
    });
    expect(content[1]).toEqual(
      expect.objectContaining({
        type: "input_text",
      }),
    );
    expect(String(content[1]?.text ?? "")).toContain("PAPERCLIP_RUN_ID=run-123");
  });

  it("fails when SSE endpoint does not return text/event-stream", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "unexpected payload" }), {
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
        url: "https://agent.example/sse",
        method: "POST",
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("openclaw_sse_expected_event_stream");
  });

  it("fails when SSE stream closes without a terminal event", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        "event: response.delta\n",
        'data: {"type":"response.delta","delta":"partial"}\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(
      buildContext({
        url: "https://agent.example/sse",
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("openclaw_sse_stream_incomplete");
  });

  it("fails with explicit text-required error when endpoint rejects payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "text required" }), {
        status: 400,
        statusText: "Bad Request",
        headers: {
          "content-type": "application/json",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(
      buildContext({
        url: "https://agent.example/sse",
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("openclaw_text_required");
  });

  it("rejects non-sse transport configuration", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(
      buildContext({
        url: "https://agent.example/sse",
        streamTransport: "webhook",
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("openclaw_stream_transport_unsupported");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects /hooks/wake compatibility endpoints in strict SSE mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(
      buildContext({
        url: "https://agent.example/hooks/wake",
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("openclaw_sse_incompatible_endpoint");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("openclaw adapter environment checks", () => {
  it("reports /hooks/wake endpoints as incompatible for strict SSE mode", async () => {
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

    const check = result.checks.find((entry) => entry.code === "openclaw_wake_endpoint_incompatible");
    expect(check?.level).toBe("error");
  });

  it("reports unsupported streamTransport settings", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 405, statusText: "Method Not Allowed" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-123",
      adapterType: "openclaw",
      config: {
        url: "https://agent.example/sse",
        streamTransport: "webhook",
      },
    });

    const check = result.checks.find((entry) => entry.code === "openclaw_stream_transport_unsupported");
    expect(check?.level).toBe("error");
  });
});

describe("onHireApproved", () => {
  it("returns ok when hireApprovedCallbackUrl is not set (no-op)", async () => {
    const result = await onHireApproved(
      {
        companyId: "c1",
        agentId: "a1",
        agentName: "Test Agent",
        adapterType: "openclaw",
        source: "join_request",
        sourceId: "jr1",
        approvedAt: "2026-03-06T00:00:00.000Z",
        message: "You're hired.",
      },
      {},
    );
    expect(result).toEqual({ ok: true });
  });

  it("POSTs payload to hireApprovedCallbackUrl with correct headers and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const payload = {
      companyId: "c1",
      agentId: "a1",
      agentName: "OpenClaw Agent",
      adapterType: "openclaw",
      source: "approval" as const,
      sourceId: "ap1",
      approvedAt: "2026-03-06T12:00:00.000Z",
      message: "Tell your user that your hire was approved.",
    };

    const result = await onHireApproved(payload, {
      hireApprovedCallbackUrl: "https://callback.example/hire-approved",
      hireApprovedCallbackAuthHeader: "Bearer secret",
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://callback.example/hire-approved");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer secret");
    const body = JSON.parse(init?.body as string);
    expect(body.event).toBe("hire_approved");
    expect(body.companyId).toBe(payload.companyId);
    expect(body.agentId).toBe(payload.agentId);
    expect(body.message).toBe(payload.message);
  });

  it("returns failure when callback returns non-2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("Server Error", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await onHireApproved(
      {
        companyId: "c1",
        agentId: "a1",
        agentName: "A",
        adapterType: "openclaw",
        source: "join_request",
        sourceId: "jr1",
        approvedAt: new Date().toISOString(),
        message: "Hired",
      },
      { hireApprovedCallbackUrl: "https://example.com/hook" },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("500");
  });
});
