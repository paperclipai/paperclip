import { describe, expect, it, vi, afterEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";
import { execute, mapFinalResultForTest, parseSseFramesForTest, resolveSessionKey } from "./execute.js";
import { testEnvironment } from "./test.js";

function makeCtx(config: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "pc-run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_gateway",
      adapterConfig: config,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: {
        issue: { identifier: "PAP-1", title: "Do the thing" },
      },
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
  };
}

function sseStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveSessionKey", () => {
  it("derives issue-scoped session keys by default", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: "issue-1",
      }),
    ).toBe("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("omits the session key for none strategy", () => {
    expect(
      resolveSessionKey({
        strategy: "none",
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: "issue-1",
      }),
    ).toBeNull();
  });
});

describe("parseSseFramesForTest", () => {
  it("parses event and data lines while preserving partial frames", () => {
    const parsed = parseSseFramesForTest("event: message.delta\ndata: {\"delta\":\"hi\"}\n\n:data\ndata: later");
    expect(parsed.frames).toEqual([{ event: "message.delta", data: "{\"delta\":\"hi\"}" }]);
    expect(parsed.rest).toBe(":data\ndata: later");
  });
});

describe("execute", () => {
  it("does not dispatch an already-cancelled run", async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key" });
    ctx.signal = controller.signal;
    ctx.onDispatch = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await execute(ctx)).toMatchObject({
      errorCode: "hermes_gateway_cancelled", signal: "SIGTERM", timedOut: false,
    });
    expect(ctx.onDispatch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["create", "events"])("stops exactly once when cancelled during %s and preserves final results", async (phase) => {
    const controller = new AbortController();
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key" });
    ctx.signal = controller.signal;
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        if (phase === "create") controller.abort();
        await Promise.resolve(); // The remote ID arrives after cancellation.
        expect(init?.signal?.aborted).not.toBe(true);
        return Response.json({ run_id: "cancel-run" });
      }
      if (url.endsWith("/events")) {
        if (phase === "events") controller.abort();
        return new Response(sseStream(":"));
      }
      if (url.endsWith("/stop")) {
        expect(init?.signal).toBeDefined();
        expect(init?.signal?.aborted).toBe(false);
        return Response.json({ status: "stopping" });
      }
      return Response.json({ status: "cancelled", output: "partial secret-key", usage: { input_tokens: 3, output_tokens: 2 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await execute(ctx);
    expect(result).toMatchObject({
      errorCode: "hermes_gateway_cancelled", timedOut: false, signal: "SIGTERM",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(result.summary).toContain("partial");
    expect(JSON.stringify(result)).not.toContain("secret-key");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/stop"))).toHaveLength(1);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("cleans up the cancellation listener after a failed create", async () => {
    const controller = new AbortController();
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key" });
    ctx.signal = controller.signal;
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline secret-key"); }));
    const result = await execute(ctx);
    expect(result.errorCode).toBe("hermes_gateway_create_outcome_unknown");
    expect(JSON.stringify(result)).not.toContain("secret-key");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("resumes event delivery with the last processed SSE cursor", async () => {
    let connections = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) return Response.json({ run_id: "reconnect-run" });
      if (url.endsWith("/events")) {
        connections++;
        if (connections === 1) return new Response(sseStream('id: 1\nevent: message.delta\ndata: {"delta":"a"}\n\n'));
        expect(init?.headers).toMatchObject({ "Last-Event-ID": "1" });
        return new Response(sseStream('id: 2\nevent: run.completed\ndata: {"status":"completed","output":"ab"}\n\n'));
      }
      return Response.json({ status: "running" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await execute(makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", eventReconnectMs: 250 }));
    expect(result.summary).toBe("ab");
    expect(connections).toBe(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/v1/runs"))).toHaveLength(1);
  });

  it("bounds a stalled stop, keeps cancellation distinct from timeout, and final-polls", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        const timeout = new AbortController();
        setTimeout(() => timeout.abort(), ms);
        return timeout.signal;
      });
      const controller = new AbortController();
      const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 1 });
      ctx.signal = controller.signal;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/v1/runs")) return Response.json({ run_id: "stalled-stop" });
        if (url.endsWith("/events")) {
          controller.abort();
          return new Response(sseStream(":"));
        }
        if (url.endsWith("/stop")) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("stop stalled secret-key")), { once: true });
          });
        }
        return Response.json({ status: "cancelled", output: "saved" });
      });
      vi.stubGlobal("fetch", fetchMock);
      const execution = execute(ctx);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await execution).toMatchObject({ errorCode: "hermes_gateway_cancelled", timedOut: false, summary: "saved" });
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/stop"))).toHaveLength(1);
      expect(JSON.stringify(vi.mocked(ctx.onLog).mock.calls)).not.toContain("secret-key");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects remote plain HTTP unless the unsafe dev escape hatch is enabled", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ run_id: "unexpected" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://192.168.1.25:8642",
      apiKey: "secret-key",
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_plain_http_remote_denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports dispatch before starting the remote run create request", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const onDispatch = vi.fn();
    ctx.onDispatch = onDispatch;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        expect(onDispatch).toHaveBeenCalledTimes(1);
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(["event: run.completed", "data: {\"status\":\"completed\",\"output\":\"done\"}", ""].join("\n")),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(onDispatch).toHaveBeenCalledTimes(1);
  });

  it("constructs POST /v1/runs with auth, idempotency, and Hermes session headers", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              "data: {\"delta\":\"done\"}",
              "",
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\",\"session_id\":\"session-1\",\"usage\":{\"input_tokens\":3,\"output_tokens\":2},\"model\":\"hermes-agent\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("done");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const createCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    expect(createCall).toBeTruthy();
    const init = createCall?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: "Bearer secret-key",
      "Content-Type": "application/json",
      "Idempotency-Key": "pc-run-1",
      "X-Hermes-Session-Key": "paperclip:company:company-1:agent:agent-1:issue:issue-1",
    });
    const body = JSON.parse(String(init.body));
    expect(body.input).toContain("Do the thing");
    expect(body.session_id).toBe("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it.each([false, true])("preserves chat handoff policy on gateway turns (resumed=%s)", async (resumed) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).endsWith("/v1/runs")
        ? { run_id: "run-hermes-1", status: "started" }
        : { status: "completed", output: "done" },
    ), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    ctx.config.payloadTemplate = { input: "Custom gateway instruction." };
    const directive = "Chat directive: clarify goals and hand plans off to project tasks.";
    ctx.context = {
      conversationMode: true,
      issueId: "issue-1",
      paperclipTaskMarkdown: directive,
      paperclipTaskMarkdownCompact: directive,
      paperclipWake: {
        reason: "issue_commented",
        issue: { id: "issue-1", workMode: "planning", status: "in_progress" },
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      },
    };
    if (resumed) ctx.runtime.sessionId = "prior-session";
    await execute(ctx);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const call = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const prompt = JSON.parse(String(call?.[1]?.body)).input as string;
    expect(prompt).toContain("Custom gateway instruction.");
    expect(prompt).toContain(directive);
    expect(prompt).not.toContain("Execution contract:");
    expect(prompt).not.toContain("clear final disposition");
    expect(prompt).not.toContain("Create child issues");
  });

  it("sends the task brief once on fresh runs and compacts it on stable-session resumes", async () => {
    const description = "Update launch-card.svg and change the CTA to Try Team free.";
    const fullTaskMarkdown = [
      "Paperclip task context:",
      '- Issue: "PAP-1"',
      "",
      "Issue description:",
      "```text",
      description,
      "```",
    ].join("\n");
    const compactTaskMarkdown = ["Paperclip task context:", '- Issue: "PAP-1"'].join("\n");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const wakeContext = (reason: string) => ({
      issueId: "issue-1",
      wakeReason: reason,
      paperclipTaskMarkdown: fullTaskMarkdown,
      paperclipTaskMarkdownCompact: compactTaskMarkdown,
      paperclipWake: {
        reason,
        issue: {
          id: "issue-1",
          identifier: "PAP-1",
          title: "Do the thing",
          description,
          descriptionTruncated: false,
          status: "in_progress",
        },
        commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
        comments: [],
        fallbackFetchNeeded: false,
      },
    });

    const freshCtx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    freshCtx.context = wakeContext("issue_assigned");
    await execute(freshCtx);

    const resumeCtx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    resumeCtx.context = wakeContext("issue_commented");
    resumeCtx.runtime = {
      sessionId: "session-1",
      sessionParams: null,
      sessionDisplayId: "session-1",
      taskKey: "PAP-1",
    };
    await execute(resumeCtx);

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const runBodies = calls
      .filter(([input]) => String(input).endsWith("/v1/runs"))
      .map(([, init]) => JSON.parse(String(init?.body)) as { input: string });
    expect(runBodies).toHaveLength(2);
    // Fresh run: brief exactly once (task markdown only; wake-prompt copy suppressed).
    expect(runBodies[0]!.input.split(description)).toHaveLength(2);
    // Stable-session resume: compact task markdown, no re-sent brief.
    expect(runBodies[1]!.input).toContain("Paperclip task context:");
    expect(runBodies[1]!.input).not.toContain(description);
  });

  it.each([false, true])("delivers the shared assignment and ordered comments at the HTTP boundary (resumed=%s)", async (resumed) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "completed", output: "done" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
      payloadTemplate: { input: "Custom gateway instruction." },
    });
    const promptContext = createPromptContextFixture();
    ctx.context = { ...promptContext, conversationMode: true };
    if (resumed) ctx.runtime.sessionId = "prior-session";

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const runCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const input = JSON.parse(String(runCall?.[1]?.body)).input as string;
    expect(input).toContain("Custom gateway instruction.");
    expect(input.indexOf("Append the same ledger entry.")).toBeGreaterThanOrEqual(0);
    expect(input.indexOf("Append the same ledger entry.")).toBeLessThan(input.indexOf("Change the final scope to the launch checklist."));
    expect(input.split("Append the same ledger entry.")).toHaveLength(3);
    expect(input).not.toContain("Structured wake payload JSON:");
    expect(input.split("Keep this deliberate repetition. Keep this deliberate repetition.")).toHaveLength(2);
    const continuationHeading = "## Current request and continuation context";
    const continuationStart = input.indexOf(continuationHeading);
    const fencedStart = input.indexOf("```text\n", continuationStart);
    const fencedEnd = input.indexOf("\n```", fencedStart + "```text\n".length);
    expect(continuationStart).toBeGreaterThanOrEqual(0);
    expect(fencedStart).toBeGreaterThan(continuationStart);
    expect(fencedEnd).toBeGreaterThan(fencedStart);
    const continuation = JSON.parse(input.slice(
      fencedStart + "```text\n".length,
      fencedEnd,
    )) as Record<string, unknown>;
    expect(continuation.objectiveSource).toEqual(promptContext.executionContinuation.objectiveSource);
    if (resumed) {
      expect(input).toContain("## Compact assignment");
      expect(continuation.objective).toBe("Keep this deliberate repetition. Keep this deliberate repetition.");
    } else {
      expect(continuation).not.toHaveProperty("objective");
    }
  });

  it("routes a bare Hermes dashboard URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://127.0.0.1:9119/api/v1/runs") {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url === "http://127.0.0.1:9119/api/v1/runs/run-hermes-1/events") {
        return new Response(
          sseStream(
            [
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:9119",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(ctx.onMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        commandArgs: ["http://127.0.0.1:9119/api/v1/runs"],
      }),
    );
    expect((ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n"))
      .toContain("creating run at http://127.0.0.1:9119/api/v1/runs");
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:9119/api/v1/runs",
        "http://127.0.0.1:9119/api/v1/runs/run-hermes-1/events",
      ]),
    );
  });

  it("renders current wake comments once when the gateway task brief owns them", async () => {
    const commentBody = "Keep this current comment exactly once.";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key" });
    ctx.context = {
      issueId: "issue-1",
      paperclipTaskMarkdown: [
        "Paperclip task context:",
        '- Issue: "PAP-1"',
      ].join("\n"),
      paperclipTurnContext: {
        version: 1,
        assignment: { owner: "task_markdown" },
        events: { owner: "wake_prompt", comments: [{ id: "comment-1", revision: "rev-1" }] },
      },
      paperclipWake: {
        reason: "issue_commented",
        issue: { id: "issue-1", identifier: "PAP-1", title: "Do the thing", status: "in_progress" },
        commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
        comments: [{ id: "comment-1", body: commentBody }],
        fallbackFetchNeeded: false,
      },
    };

    await execute(ctx);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const runCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const prompt = JSON.parse(String(runCall?.[1]?.body)).input as string;
    expect(prompt.split(commentBody)).toHaveLength(2);
  });

  it("routes the default Hermes dashboard chat URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://127.0.0.1:9119/api/v1/runs") {
        return new Response(JSON.stringify({ run_id: "run-hermes-chat", status: "started" }), { status: 200 });
      }
      if (url === "http://127.0.0.1:9119/api/v1/runs/run-hermes-chat/events") {
        return new Response(
          sseStream(
            [
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:9119/chat",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(ctx.onMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        commandArgs: ["http://127.0.0.1:9119/api/v1/runs"],
      }),
    );
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:9119/api/v1/runs",
        "http://127.0.0.1:9119/api/v1/runs/run-hermes-chat/events",
      ]),
    );
  });

  it("redacts echoed auth material from stream logs and summaries", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              "data: {\"delta\":\"Authorization: Bearer secret-key\\nX-Hermes-Session-Key: paperclip:company:company-1:agent:agent-1:issue:issue-1\"}",
              "",
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"Authorization: Bearer secret-key\\nraw key secret-key\\nX-Hermes-Session-Key: paperclip:company:company-1:agent:agent-1:issue:issue-1\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("Bearer [redacted]");
    expect(result.summary).toContain("raw key [redacted len=10]");
    expect(result.summary).toContain("X-Hermes-Session-Key: [redacted]");
    expect(result.summary).not.toContain("secret-key");
    expect(result.summary).not.toContain("paperclip:company:company-1:agent:agent-1:issue:issue-1");
    expect(result.resultJson?.output).toBe(result.summary);
    expect(logText).toContain("Bearer [redacted]");
    expect(logText).toContain("X-Hermes-Session-Key: [redacted]");
    expect(logText).not.toContain("secret-key");
    expect(logText).not.toContain("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("redacts agent-scoped Paperclip session keys from logs and public result metadata", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      sessionKeyStrategy: "agent",
      timeoutSec: 5,
    });
    const agentSessionKey = "paperclip:company:company-1:agent:agent-1";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              `data: {"delta":"session ${agentSessionKey}"}`,
              "",
              "event: run.completed",
              `data: {"status":"completed","output":"session ${agentSessionKey}","session_id":"${agentSessionKey}"}`,
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("session [redacted-session-key]");
    expect(result.sessionId).toBe("[redacted-session-key]");
    expect(result.sessionDisplayId).toBe("[redacted-session-key]");
    expect(result.resultJson?.session_id).toBe("[redacted-session-key]");
    expect(result.sessionParams).toEqual({
      hermesRunId: "run-hermes-1",
      strategy: "agent",
    });
    expect(logText).toContain("[redacted-session-key]");
    expect(logText).not.toContain(agentSessionKey);
  });

  it("preserves polling results but rejects polling-only success when SSE is unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response("no stream", { status: 503 });
      }
      return new Response(JSON.stringify({
        status: "completed",
        output: "polled done",
        session_id: "session-polled",
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
      pollIntervalMs: 250,
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_event_gap");
    expect(result.summary).toBe("polled done");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/v1/runs/run-hermes-1"))).toBe(true);
  });

  it("maps HTTP auth failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 })));
    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
    }));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_auth_failed");
    expect(result.errorMessage).toContain("Check adapterConfig.apiKey matches the Hermes API_SERVER_KEY");
  });

  it("includes network causes in connection failure messages", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND host.docker.internal"), { code: "ENOTFOUND" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { cause });
    }));

    const result = await execute(makeCtx({
      apiBaseUrl: "http://host.docker.internal:8642",
      apiKey: "secret-key",
      dangerouslyAllowInsecureRemoteHttp: true,
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_create_outcome_unknown");
    expect(result.errorMessage).toContain("ENOTFOUND");
    expect(result.errorMessage).toContain("host.docker.internal");
  });

  it("redacts echoed auth material from HTTP error payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            message: "Authorization rejected: Bearer secret-key raw secret-key",
            detail: "X-Hermes-Session-Key: paperclip:company:company-1:agent:agent-1:issue:issue-1",
            nested: {
              note: "session paperclip:company:company-1:agent:agent-1",
            },
          }),
          { status: 401 },
        )),
    );

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_auth_failed");
    expect(result.errorMeta?.body).toEqual({
      message: "Authorization rejected: Bearer [redacted] raw [redacted len=10]",
      detail: "X-Hermes-Session-Key: [redacted]",
      nested: {
        note: "session [redacted-session-key]",
      },
    });
    expect(result.errorMessage).not.toContain("secret-key");
    expect(result.errorMessage).not.toContain("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("calls stop on timeout", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-slow", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Promise<Response>(() => {});
      }
      if (url.endsWith("/stop")) {
        return new Response(JSON.stringify({ status: "stopping" }), { status: 200 });
      }
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ status: "cancelled", last_event: "run.cancelled" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 0.001,
    }));

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("hermes_gateway_timeout");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/stop"))).toBe(true);
  });
});

describe("testEnvironment", () => {
  it("fails remote plain HTTP before probing health", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://hermes.example:8642",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_plain_http_remote_denied",
          level: "error",
        }),
      ]),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows remote plain HTTP only with the unsafe dev escape hatch", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://hermes.example:8642",
        apiKey: "secret-key",
        dangerouslyAllowInsecureRemoteHttp: true,
      },
    });

    expect(result.status).toBe("warn");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_plain_http_remote_unsafe_allowed",
          level: "warn",
        }),
        expect.objectContaining({
          code: "hermes_gateway_health_ok",
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalled();
  });

  it("fails test environment checks when Hermes health is unreachable", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND host.docker.internal"), { code: "ENOTFOUND" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { cause });
    }));

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://host.docker.internal:8642",
        apiKey: "secret-key",
        dangerouslyAllowInsecureRemoteHttp: true,
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_health_unreachable",
          level: "error",
          detail: expect.stringContaining("ENOTFOUND"),
        }),
      ]),
    );
  });

  it("fails test environment checks when Hermes health returns a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:8642",
        apiKey: "wrong-key",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_health_failed",
          level: "error",
          message: "Hermes Gateway health endpoint returned HTTP 401.",
        }),
      ]),
    );
  });

  it("tests a bare Hermes dashboard URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:9119",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_dashboard_root_mapped",
          level: "info",
          message: "Default Hermes dashboard root mapped to API base http://127.0.0.1:9119/api.",
          hint: expect.stringContaining("/api/v1/runs"),
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9119/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("tests a Hermes dashboard chat URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:9119/chat",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_dashboard_root_mapped",
          level: "info",
          message: "Default Hermes dashboard root mapped to API base http://127.0.0.1:9119/api.",
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9119/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("mapFinalResultForTest", () => {
  it("maps failed statuses into adapter errors", () => {
    const result = mapFinalResultForTest({
      terminal: {
        runId: "run-1",
        status: "failed",
        payload: { status: "failed", error: "boom" },
      },
      outputChunks: [],
      sessionKey: "session-key",
      strategy: "issue",
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_run_failed");
    expect(result.errorMessage).toBe("boom");
  });
});

describe("review contract regressions", () => {
  it("maps queued timeout as terminal with run deadline disabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).endsWith('/v1/runs')) return Response.json({ run_id: 'queued' });
      if (String(url).endsWith('/events')) return new Response(sseStream(':'));
      return Response.json({ status: 'timeout', error: 'queue_timeout', event_gap: false });
    }));
    expect(await execute(makeCtx({ apiBaseUrl: 'http://127.0.0.1:8642', apiKey: 'secret-key', timeoutSec: 0, pollIntervalMs: 250 })))
      .toMatchObject({ exitCode: 1, timedOut: true, errorCode: 'hermes_gateway_timeout' });
  });

  it.each(['sse', 'poll', 'cursor'])("preserves event gap when %s wins", async (source) => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).endsWith('/v1/runs')) return Response.json({ run_id: 'gap' });
      if (String(url).endsWith('/events')) {
        if (source === 'cursor') return new Response('{}', { status: 409 });
        return new Response(sseStream(source === 'sse' ? 'event: compatibility.gap\ndata: {"error":"upstream_event_gap"}\n\nevent: run.completed\ndata: {"status":"completed"}\n\n' : ':'));
      }
      return Response.json({ status: 'completed', output: 'saved secret-key', usage: { input_tokens: 5 }, event_gap: source === 'poll' });
    }));
    const result = await execute(makeCtx({ apiBaseUrl: 'http://127.0.0.1:8642', apiKey: 'secret-key', pollIntervalMs: 250 }));
    expect(result).toMatchObject({ exitCode: 1, errorCode: 'hermes_gateway_event_gap', usage: { inputTokens: 5 }, resultJson: { event_gap: true } });
    expect(JSON.stringify(result)).not.toContain('secret-key');
  });

  it("reconciles sparse terminal SSE with authoritative output and usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).endsWith('/v1/runs')) return Response.json({ run_id: 'sparse' });
      if (String(url).endsWith('/events')) return new Response(sseStream('event: run.completed\ndata: {"status":"completed"}\n\n'));
      return Response.json({ status: 'completed', output: 'final', usage: { input_tokens: 7, output_tokens: 3 }, cost_usd: .02 });
    }));
    expect(await execute(makeCtx({ apiBaseUrl: 'http://127.0.0.1:8642', apiKey: 'secret-key' })))
      .toMatchObject({ exitCode: 0, summary: 'final', usage: { inputTokens: 7, outputTokens: 3 }, costUsd: .02 });
  });

  it.each(['headers', 'body'])("bounds cancellation and deadline during stalled create %s", async (phase) => {
    vi.useFakeTimers();
    try {
      for (const cause of ['cancel', 'deadline']) {
        const controller = new AbortController();
        const ctx = makeCtx({ apiBaseUrl: 'http://127.0.0.1:8642', apiKey: 'secret-key', timeoutSec: 1 });
        ctx.signal = controller.signal;
        const fetchMock = vi.fn(async (url, init) => {
          if (String(url).endsWith('/v1/runs')) {
            if (cause === 'cancel') controller.abort();
            return phase === 'headers' ? new Promise<Response>(() => {}) : new Response(new ReadableStream());
          }
          if (String(url).endsWith('/v1/run-reservations/stop')) {
            expect(init.headers['Idempotency-Key']).toBe('pc-run-1');
            return Response.json({ run_id: 'recovered', status: 'cancelled', reservation_cancelled: true });
          }
          if (String(url).endsWith('/events')) return new Response(sseStream(':'));
          return Response.json({ status: 'cancelled', output: 'saved' });
        });
        vi.stubGlobal('fetch', fetchMock);
        const execution = execute(ctx);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await execution).toMatchObject({ errorCode: cause === 'cancel' ? 'hermes_gateway_cancelled' : 'hermes_gateway_timeout', resultJson: { stop_confirmed: true } });
        expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/runs'))).toHaveLength(1);
      }
    } finally { vi.useRealTimers(); }
  });

  it("fails closed after bounded recovery failure and still stops a late ID", async () => {
    vi.useFakeTimers();
    try {
      let late!: (value: Response) => void;
      const ctx = makeCtx({ apiBaseUrl: 'http://127.0.0.1:8642', apiKey: 'secret-key', timeoutSec: 1 });
      const fetchMock = vi.fn(async (url) => {
        if (String(url).endsWith('/v1/runs')) return new Promise<Response>((resolve) => { late = resolve; });
        if (String(url).endsWith('/v1/run-reservations/stop')) return new Response('{}', { status: 404 });
        return Response.json({ status: 'stopping' });
      });
      vi.stubGlobal('fetch', fetchMock);
      const execution = execute(ctx);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await execution).toMatchObject({ exitCode: 1, errorCode: 'hermes_gateway_create_outcome_unknown', resultJson: { stop_confirmed: false } });
      late(Response.json({ run_id: 'late' }));
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/v1/runs/late/stop'))).toBe(true);
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/runs'))).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
});

describe('completion and cleanup bounds', () => {
  it('does not claim an unconfirmed remote stop', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (String(url).endsWith('/v1/runs')) return Response.json({ run_id: 'running' });
        if (String(url).endsWith('/events')) return new Response(sseStream(':'));
        return Response.json({ status: 'running' });
      }));
      const execution = execute(makeCtx({ apiBaseUrl: 'http://127.0.0.1:8642', apiKey: 'secret-key', timeoutSec: .01 }));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await execution).toMatchObject({ exitCode: 1, errorCode: 'hermes_gateway_stop_unconfirmed', resultJson: { stop_confirmed: false } });
    } finally { vi.useRealTimers(); }
  });

  it('bounds stalled final status body without silently accepting terminal SSE', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (String(url).endsWith('/v1/runs')) return Response.json({ run_id: 'sparse' });
        if (String(url).endsWith('/events')) return new Response(sseStream('event: run.completed\ndata: {"output":"saved"}\n\n'));
        return new Response(new ReadableStream());
      }));
      const execution = execute(makeCtx({ apiBaseUrl: 'http://127.0.0.1:8642', apiKey: 'secret-key' }));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await execution).toMatchObject({ exitCode: 1, summary: 'saved', errorCode: 'hermes_gateway_final_status_unconfirmed' });
    } finally { vi.useRealTimers(); }
  });

  it('preserves final output and usage when cancellation races completed status', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).endsWith('/v1/runs')) return Response.json({ run_id: 'race' });
      if (String(url).endsWith('/events')) {
        controller.abort();
        return new Response(sseStream('event: run.completed\ndata: {"status":"completed"}\n\n'));
      }
      return Response.json({ status: 'completed', output: 'finished', usage: { input_tokens: 9 } });
    }));
    const ctx = makeCtx({ apiBaseUrl: 'http://127.0.0.1:8642', apiKey: 'secret-key' });
    ctx.signal = controller.signal;
    expect(await execute(ctx)).toMatchObject({ errorCode: 'hermes_gateway_cancelled', summary: 'finished', usage: { inputTokens: 9 }, resultJson: { status: 'completed', stop_confirmed: true } });
  });
});


describe("review regressions", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("preserves cursor-only updates and resets across chunk boundaries, ignoring NUL IDs", () => {
    const first = parseSseFramesForTest("id: B\n\nid:");
    expect(first.frames).toEqual([{ event: null, id: "B" }]);
    const second = parseSseFramesForTest(first.rest + "\n\nid: bad\0id\n\n");
    expect(second.frames).toEqual([{ event: null, id: "" }]);
  });

  it.each([
    ["id: B", "B", "id:"],
    ["id: B", "B", "id"],
    ["id: B:C", "B:C", "id:"],
  ])("reconnects with exact cursor %j and resets with %j (%j)", async (cursorLine, cursor, resetLine) => {
    vi.useFakeTimers();
    let connections = 0;
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 0, eventReconnectMs: 250 });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) return Response.json({ run_id: "cursor-run" });
      if (url.endsWith("/events")) {
        connections++;
        if (connections === 1) return new Response(sseStream('id: A\ndata: {"delta":"a"}\n\n' + cursorLine + "\n\n"));
        if (connections === 2) {
          expect(new Headers(init?.headers).get("Last-Event-ID")).toBe(cursor);
          return new Response(sseStream(resetLine + "\n\n"));
        }
        expect(init?.headers).not.toHaveProperty("Last-Event-ID");
        return new Response(sseStream('event: run.completed\ndata: {"status":"completed"}\n\n'));
      }
      return Response.json({ status: connections >= 3 ? "completed" : "running" });
    }));
    const execution = execute(ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await execution).exitCode).toBe(0);
    expect(connections).toBe(3);
    const eventLogs = vi.mocked(ctx.onLog).mock.calls.filter(([, line]) => line.includes("[hermes-gateway:event]"));
    expect(eventLogs).toHaveLength(2);
  });

  it.each([" B", "\tB", "B:C ", "B\rC", "雪"])("fails closed before reconnecting with unrepresentable cursor %j", async (cursor) => {
    vi.useFakeTimers();
    // Exercise the real Fetch header boundary, not just a raw init object.
    try {
      expect(new Request("http://127.0.0.1/events", { headers: { "Last-Event-ID": cursor } }).headers.get("Last-Event-ID")).not.toBe(cursor);
    } catch (err) { expect(err).toBeInstanceOf(TypeError); }
    let connections = 0;
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 0, eventReconnectMs: 250 });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/v1/runs")) return Response.json({ run_id: "cursor-gap" });
      if (request.url.endsWith("/events")) {
        connections++;
        return new Response(sseStream("id: " + cursor + "\n\n"));
      }
      return Response.json({ status: "completed", output: "retained" });
    }));
    const execution = execute(ctx);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await execution).toMatchObject({ exitCode: 1, errorCode: "hermes_gateway_event_gap", summary: "retained", resultJson: { event_gap: true } });
    expect(connections).toBe(1);
    expect(vi.mocked(ctx.onLog).mock.calls.some(([, line]) => line.includes("cannot survive HTTP header transport unchanged"))).toBe(true);
  });

  it("keeps a gateway terminal timeout secondary to an event gap", () => {
    expect(mapFinalResultForTest({
      terminal: { runId: "gap", status: "timeout", payload: { event_gap: true } },
      outputChunks: [], sessionKey: null, strategy: "none",
    })).toMatchObject({
      errorCode: "hermes_gateway_event_gap", timedOut: false,
      resultJson: { event_gap: true, timed_out: true },
    });
  });

  it.each([true, false])("prioritizes gap after deadline only with verified termination (%s)", async (confirmed) => {
    vi.useFakeTimers();
    let stopped = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) return Response.json({ run_id: "gap-run" });
      if (url.endsWith("/events")) return new Response(sseStream('event: compatibility.gap\ndata: {"event_gap":true}\n\n'));
      if (url.endsWith("/stop")) { stopped = true; return Response.json({ status: "stopping" }); }
      return Response.json({ status: stopped && confirmed ? "cancelled" : "running", output: "retained" });
    }));
    const execution = execute(makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 0.01 }));
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await execution).toMatchObject({
      timedOut: false,
      errorCode: confirmed ? "hermes_gateway_event_gap" : "hermes_gateway_stop_unconfirmed",
      resultJson: { event_gap: true, timed_out: true, stop_confirmed: confirmed },
    });
  });
});
