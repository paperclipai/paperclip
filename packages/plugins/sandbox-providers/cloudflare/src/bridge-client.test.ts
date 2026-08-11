import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudflareDriverConfig } from "./types.js";
import { createCloudflareBridgeClient, resolveRequestTimeoutMs } from "./bridge-client.js";

const baseConfig: CloudflareDriverConfig = {
  bridgeBaseUrl: "https://bridge.example.workers.dev",
  bridgeAuthToken: "secret-ref://bridge-token",
  reuseLease: false,
  keepAlive: false,
  sleepAfter: "10m",
  normalizeId: true,
  requestedCwd: "/workspace/paperclip",
  sessionStrategy: "named",
  sessionId: "paperclip",
  timeoutMs: 300_000,
  bridgeRequestTimeoutMs: 30_000,
  previewHostname: null,
};

describe("Cloudflare bridge client timeouts", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the configured timeout for non-exec requests", () => {
    expect(resolveRequestTimeoutMs(baseConfig, "/api/paperclip-sandbox/v1/probe", {
      method: "POST",
      body: JSON.stringify({ timeoutMs: 270_000 }),
    })).toBe(30_000);
  });

  it("extends exec requests to the command timeout when needed", () => {
    expect(resolveRequestTimeoutMs(baseConfig, "/api/paperclip-sandbox/v1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "opencode", timeoutMs: 270_000 }),
    })).toBe(270_000);
  });

  it("falls back to the configured timeout when exec timeout is missing or smaller", () => {
    expect(resolveRequestTimeoutMs(baseConfig, "/api/paperclip-sandbox/v1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "pwd" }),
    })).toBe(30_000);
    expect(resolveRequestTimeoutMs(baseConfig, "/api/paperclip-sandbox/v1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "pwd", timeoutMs: 5_000 }),
    })).toBe(30_000);
  });

  it("consumes streamed exec output and returns the final result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      [
        'event: stdout',
        'data: {"data":"hello\\n"}',
        "",
        'event: complete',
        'data: {"exitCode":0,"signal":null,"timedOut":false,"stdout":"hello\\n","stderr":""}',
        "",
      ].join("\n"),
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const client = createCloudflareBridgeClient({ config: baseConfig });
    const onOutput = vi.fn();

    const result = await client.execute(
      {
        providerLeaseId: "lease-1",
        command: "echo",
        args: ["hello"],
        sessionStrategy: "named",
        sessionId: "paperclip",
      },
      {},
      { onOutput },
    );

    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "hello\n",
      stderr: "",
    });
    expect(onOutput).toHaveBeenCalledWith("stdout", "hello\n");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ streamOutput: true });
  });
});
