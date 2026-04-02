import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { isOpenCodeUnknownSessionError, parseOpenCodeJsonl } from "@paperclipai/adapter-opencode-local/server";
import { parseOpenCodeStdoutLine } from "@paperclipai/adapter-opencode-local/ui";
import { printOpenCodeStreamEvent } from "@paperclipai/adapter-opencode-local/cli";
import {
  probeOllamaHealthcheck,
  resolveLocalFirstDecision,
} from "../../../packages/adapters/opencode-local/src/server/local-provider.ts";

describe("opencode_local parser", () => {
  it("extracts session, summary, usage, cost, and terminal error message", () => {
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "ses_123" }),
      JSON.stringify({ type: "text", part: { type: "text", text: "hello" } }),
      JSON.stringify({
        type: "step_finish",
        part: {
          reason: "tool-calls",
          cost: 0.001,
          tokens: {
            input: 100,
            output: 40,
            cache: { read: 20, write: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "step_finish",
        part: {
          reason: "stop",
          cost: 0.002,
          tokens: {
            input: 50,
            output: 25,
            cache: { read: 10, write: 0 },
          },
        },
      }),
      JSON.stringify({ type: "error", message: "model access denied" }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("ses_123");
    expect(parsed.summary).toBe("hello");
    expect(parsed.usage).toEqual({
      inputTokens: 150,
      cachedInputTokens: 30,
      outputTokens: 65,
    });
    expect(parsed.costUsd).toBeCloseTo(0.003, 6);
    expect(parsed.errorMessage).toBe("model access denied");
  });
});

describe("opencode_local local-first routing", () => {
  it("defers non-critical work when the primary local model is unavailable", () => {
    const decision = resolveLocalFirstDecision({
      primaryModel: "ollama/qwen3:14b",
      fallbackModel: "openai/gpt-5.4",
      fallbackPolicy: "critical_only",
      deferWhenPrimaryUnavailable: true,
      issuePriority: "medium",
      healthcheck: {
        ok: false,
        status: null,
        detail: "connect ECONNREFUSED",
        url: "http://100.64.0.10:11434/api/tags",
      },
    });

    expect(decision).toEqual({
      action: "defer",
      model: "ollama/qwen3:14b",
      reason: "primary_unavailable",
      detail: "connect ECONNREFUSED",
    });
  });

  it("falls back for critical work when policy allows it", () => {
    const decision = resolveLocalFirstDecision({
      primaryModel: "ollama/qwen3:14b",
      fallbackModel: "openai/gpt-5.4",
      fallbackPolicy: "critical_only",
      deferWhenPrimaryUnavailable: true,
      issuePriority: "critical",
      healthcheck: {
        ok: false,
        status: 503,
        detail: "healthcheck returned HTTP 503",
        url: "http://100.64.0.10:11434/api/tags",
      },
    });

    expect(decision).toEqual({
      action: "fallback",
      model: "openai/gpt-5.4",
      reason: "primary_unavailable",
      detail: "healthcheck returned HTTP 503",
    });
  });
});

describe("opencode_local Ollama healthcheck", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
    servers.length = 0;
  });

  it("verifies the expected local model is present", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "qwen3:14b" }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");

    const result = await probeOllamaHealthcheck({
      url: `http://127.0.0.1:${address.port}/api/tags`,
      expectedModel: "qwen3:14b",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      ok: true,
      status: 200,
      detail: null,
      url: `http://127.0.0.1:${address.port}/api/tags`,
    });
  });
});

describe("opencode_local stale session detection", () => {
  it("treats missing persisted session file as an unknown session error", () => {
    const stderr =
      "NotFoundError: Resource not found: /Users/test/.local/share/opencode/storage/session/project/ses_missing.json";

    expect(isOpenCodeUnknownSessionError("", stderr)).toBe(true);
  });
});

describe("opencode_local ui stdout parser", () => {
  it("parses assistant and tool lifecycle events", () => {
    const ts = "2026-03-04T00:00:00.000Z";

    expect(
      parseOpenCodeStdoutLine(
        JSON.stringify({
          type: "text",
          part: {
            type: "text",
            text: "I will run a command.",
          },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "assistant",
        ts,
        text: "I will run a command.",
      },
    ]);

    expect(
      parseOpenCodeStdoutLine(
        JSON.stringify({
          type: "tool_use",
          part: {
            id: "prt_tool_1",
            callID: "call_1",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "ls -1" },
              output: "AGENTS.md\nDockerfile\n",
              metadata: { exit: 0 },
            },
          },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "tool_call",
        ts,
        name: "bash",
        toolUseId: "call_1",
        input: { command: "ls -1" },
      },
      {
        kind: "tool_result",
        ts,
        toolUseId: "call_1",
        content: "status: completed\nexit: 0\n\nAGENTS.md\nDockerfile",
        isError: false,
      },
    ]);
  });

  it("parses finished steps into usage-aware results", () => {
    const ts = "2026-03-04T00:00:00.000Z";
    expect(
      parseOpenCodeStdoutLine(
        JSON.stringify({
          type: "step_finish",
          part: {
            reason: "stop",
            cost: 0.00042,
            tokens: {
              input: 10,
              output: 5,
              cache: { read: 2, write: 0 },
            },
          },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "result",
        ts,
        text: "stop",
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 2,
        costUsd: 0.00042,
        subtype: "stop",
        isError: false,
        errors: [],
      },
    ]);
  });
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("opencode_local cli formatter", () => {
  it("prints step, assistant, tool, and result events", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      printOpenCodeStreamEvent(
        JSON.stringify({ type: "step_start", sessionID: "ses_abc" }),
        false,
      );
      printOpenCodeStreamEvent(
        JSON.stringify({
          type: "text",
          part: { type: "text", text: "hello" },
        }),
        false,
      );
      printOpenCodeStreamEvent(
        JSON.stringify({
          type: "tool_use",
          part: {
            callID: "call_1",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "ls -1" },
              output: "AGENTS.md\n",
              metadata: { exit: 0 },
            },
          },
        }),
        false,
      );
      printOpenCodeStreamEvent(
        JSON.stringify({
          type: "step_finish",
          part: {
            reason: "stop",
            cost: 0.00042,
            tokens: {
              input: 10,
              output: 5,
              cache: { read: 2, write: 0 },
            },
          },
        }),
        false,
      );

      const lines = spy.mock.calls
        .map((call) => call.map((v) => String(v)).join(" "))
        .map(stripAnsi);

      expect(lines).toEqual(
        expect.arrayContaining([
          "step started (session: ses_abc)",
          "assistant: hello",
          "tool_call: bash (call_1)",
          "tool_result status=completed exit=0",
          "AGENTS.md",
          "step finished: reason=stop",
          "tokens: in=10 out=5 cached=2 cost=$0.000420",
        ]),
      );
    } finally {
      spy.mockRestore();
    }
  });
});
