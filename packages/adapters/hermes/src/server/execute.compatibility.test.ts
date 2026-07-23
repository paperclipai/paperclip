import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@paperclipai/adapter-utils/server-utils")
    >();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      pid: 123,
      startedAt: "2026-07-15T00:00:00.000Z",
      stdout: "normal response\n\nsession_id: session-1\n",
      stderr: "",
    })),
  };
});

import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { getConfigSchema } from "./config-schema.js";
import { execute } from "./execute.js";

function makeCtx(config: Record<string, unknown> = {}) {
  return {
    runId: "test-run",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: { sessionParams: null },
    config: { command: "/usr/bin/hermes", cwd: "/tmp", ...config },
    context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  } as any;
}

function spawnedArgs(): string[] {
  return vi.mocked(runChildProcess).mock.calls.at(-1)?.[2] ?? [];
}

function spawnedOptions() {
  return vi.mocked(runChildProcess).mock.calls.at(-1)?.[3];
}

const PROVIDER_EXHAUSTION_OUTPUT = `
API call failed (attempt 1/3): provider request failed
Model 'auto' is not supported by the OpenAI Codex provider
Fallback provider openrouter failed: HTTP 401 Unauthorized
non-retryable client error; no providers remain
All fallback providers failed
Resume this session with: hermes chat --resume deadbeef
`;

const PROVIDER_EXHAUSTION_ERROR =
  "Provider fallback exhaustion prevented Hermes from completing the request.";

describe("hermes-local compatibility invocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runChildProcess).mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      pid: 123,
      startedAt: "2026-07-15T00:00:00.000Z",
      stdout: "normal response\n\nsession_id: session-1\n",
      stderr: "",
    });
  });

  it("keeps quiet schema and execution defaults aligned", async () => {
    const quietField = getConfigSchema().fields.find(
      (field) => field.key === "quiet",
    );
    expect(quietField?.default).toBe(true);

    await execute(makeCtx());
    expect(spawnedArgs()).toContain("-Q");
  });

  it("preserves the explicit quiet:false escape hatch", async () => {
    await execute(makeCtx({ quiet: false }));
    expect(spawnedArgs()).not.toContain("-Q");
  });

  it.each([{}, { model: "auto", provider: "auto" }])(
    "omits auto model and provider flags so Hermes can use its profile (%o)",
    async (config) => {
      const result = await execute(makeCtx(config));
      expect(spawnedArgs()).not.toContain("auto");
      expect(spawnedArgs()).not.toContain("-m");
      expect(spawnedArgs()).not.toContain("--provider");
      expect(result.model).toBe("auto");
      expect(result.provider).toBe("auto");
    },
  );

  it("forwards ctx.onSpawn to runChildProcess", async () => {
    const ctx = makeCtx();
    await execute(ctx);
    expect(spawnedOptions()?.onSpawn).toBe(ctx.onSpawn);
  });
});

describe("Hermes quiet-output parsing", () => {
  beforeEach(() => vi.clearAllMocks());

  function mockHermesOutput(
    stdout: string,
    options: { stderr?: string; exitCode?: number } = {},
  ) {
    vi.mocked(runChildProcess).mockResolvedValue({
      exitCode: options.exitCode ?? 0,
      signal: null,
      timedOut: false,
      pid: 123,
      startedAt: "2026-07-18T00:00:00.000Z",
      stdout,
      stderr: options.stderr ?? "",
    });
  }

  it("preserves a response emitted after the session metadata", async () => {
    mockHermesOutput(
      "\nsession_id: 20260718_200327_457d83\nROUTE_OK\n",
    );

    const result = await execute(makeCtx());

    expect(result.resultJson?.session_id).toBe("20260718_200327_457d83");
    expect(result.resultJson?.result).toBe("ROUTE_OK");
    expect(result.summary).toBe("ROUTE_OK");
  });

  it("preserves the existing response-before-session format", async () => {
    mockHermesOutput("ROUTE_OK\n\nsession_id: response-first-1\n");

    const result = await execute(makeCtx());

    expect(result.resultJson?.session_id).toBe("response-first-1");
    expect(result.resultJson?.result).toBe("ROUTE_OK");
  });

  it("normalizes CRLF while preserving response paragraphs", async () => {
    mockHermesOutput(
      "\r\nsession_id: crlf-1\r\nFirst paragraph\r\n\r\nSecond paragraph\r\n",
    );

    const result = await execute(makeCtx());

    expect(result.resultJson?.session_id).toBe("crlf-1");
    expect(result.resultJson?.result).toBe(
      "First paragraph\n\nSecond paragraph",
    );
  });

  it("keeps benign session-like response text", async () => {
    mockHermesOutput(
      [
        "The phrase session_id: example is part of this response.",
        "session_id: this is response text, not metadata",
        "session_id: actual-session-1",
        "Tail text",
      ].join("\n"),
    );

    const result = await execute(makeCtx());

    expect(result.resultJson?.session_id).toBe("actual-session-1");
    expect(result.resultJson?.result).toBe(
      [
        "The phrase session_id: example is part of this response.",
        "session_id: this is response text, not metadata",
        "Tail text",
      ].join("\n"),
    );
  });

  it("does not invent a session id from benign response prose", async () => {
    mockHermesOutput(
      [
        "The phrase session_id: example is part of this response.",
        "A saved session id: historic is also prose.",
      ].join("\n"),
    );

    const result = await execute(makeCtx());

    expect(result.resultJson?.session_id).toBeNull();
    expect(result.resultJson?.result).toBe(
      [
        "The phrase session_id: example is part of this response.",
        "A saved session id: historic is also prose.",
      ].join("\n"),
    );
  });

  it("preserves response text on both sides of session metadata", async () => {
    mockHermesOutput(
      "Before metadata\nsession_id: middle-1\nAfter metadata\n",
    );

    const result = await execute(makeCtx());

    expect(result.resultJson?.session_id).toBe("middle-1");
    expect(result.resultJson?.result).toBe(
      "Before metadata\nAfter metadata",
    );
  });

  it.each([
    ["leading newline", "\nsession_id: empty-1\n", "empty-1"],
    ["CRLF without leading newline", "session_id: empty-2\r\n", "empty-2"],
  ])("handles a no-response case with %s", async (_label, stdout, sessionId) => {
    mockHermesOutput(stdout);

    const result = await execute(makeCtx());

    expect(result.resultJson?.session_id).toBe(sessionId);
    expect(result.resultJson?.result).toBe("");
    expect(result.summary).toBeUndefined();
  });

  it("extracts the first session id and removes every metadata line", async () => {
    mockHermesOutput(
      "session_id: first-session\nResponse\nsession_id: second-session\n",
    );

    const result = await execute(makeCtx());

    expect(result.resultJson?.session_id).toBe("first-session");
    expect(result.resultJson?.result).toBe("Response");
  });

  it("retains stderr error classification when metadata precedes output", async () => {
    mockHermesOutput("session_id: failed-session\nPartial response\n", {
      stderr: "Error: upstream route failed\n",
      exitCode: 1,
    });

    const result = await execute(makeCtx());

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe("Error: upstream route failed");
    expect(result.resultJson?.session_id).toBe("failed-session");
    expect(result.resultJson?.result).toBe("Partial response");
  });

  it("extracts exact session metadata from stderr without inventing an error", async () => {
    mockHermesOutput("", {
      stderr: "session_id: 20260718_201011_81a6f8\n",
      exitCode: 130,
    });

    const result = await execute(makeCtx());

    expect(result.exitCode).toBe(130);
    expect(result.errorMessage).toBeUndefined();
    expect(result.resultJson?.session_id).toBe("20260718_201011_81a6f8");
    expect(result.resultJson?.result).toBe("");
  });

  it("does not classify an error-looking session id as stderr failure", async () => {
    mockHermesOutput("", {
      stderr: "session_id: failed-session-1\n",
      exitCode: 130,
    });

    const result = await execute(makeCtx());

    expect(result.resultJson?.session_id).toBe("failed-session-1");
    expect(result.errorMessage).toBeUndefined();
  });

  it("keeps real stderr errors while extracting exact session metadata", async () => {
    mockHermesOutput("Partial response", {
      stderr:
        "session_id: stderr-session-1\r\nError: run cancelled by operator\r\n",
      exitCode: 1,
    });

    const result = await execute(makeCtx());

    expect(result.resultJson?.session_id).toBe("stderr-session-1");
    expect(result.resultJson?.result).toBe("Partial response");
    expect(result.errorMessage).toBe("Error: run cancelled by operator\r");
  });

  it("does not extract a legacy session phrase from stderr", async () => {
    mockHermesOutput("", {
      stderr: "session saved: not-metadata\nError: actual failure\n",
      exitCode: 1,
    });

    const result = await execute(makeCtx());

    expect(result.resultJson?.session_id).toBeNull();
    expect(result.errorMessage).toBe("Error: actual failure");
  });
});

describe("legacy provider-exhaustion false-green defense", () => {
  beforeEach(() => vi.clearAllMocks());

  it("classifies the full terminal provider-exhaustion envelope as failure despite exit 0", async () => {
    vi.mocked(runChildProcess).mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      pid: 123,
      startedAt: "2026-07-15T00:00:00.000Z",
      stdout: PROVIDER_EXHAUSTION_OUTPUT,
      stderr: "",
    });

    const result = await execute(makeCtx());

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe(PROVIDER_EXHAUSTION_ERROR);
  });

  it("keeps ordinary HTTP-error prose successful", async () => {
    vi.mocked(runChildProcess).mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      pid: 123,
      startedAt: "2026-07-15T00:00:00.000Z",
      stdout:
        "The API docs explain that HTTP 400 means a malformed request.\n\nsession_id: normal-1\n",
      stderr: "",
    });

    const result = await execute(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeUndefined();
  });
});
