import { beforeEach, describe, expect, it, vi } from "vitest";

const childResult = vi.hoisted(() => ({
  current: {
    exitCode: 1 as number | null,
    signal: null as string | null,
    timedOut: false,
    stdout: "",
    stderr: "",
  },
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => childResult.current),
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute } from "./execute.js";

function makeCtx() {
  return {
    runId: "test-run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "/usr/bin/hermes",
      timeoutSec: 60,
      graceSec: 5,
    },
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: null,
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  };
}

describe("hermes-local transient provider failure classification", () => {
  beforeEach(() => {
    childResult.current = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    };
  });

  it("classifies the captured engine-overload transcript", async () => {
    childResult.current.stdout =
      "API call failed after 3 retries: HTTP 429: The engine is currently overloaded, please try again later\n";

    const result = await execute(makeCtx() as any);

    expect(result.errorMessage).toContain("HTTP 429");
    expect(result.errorCode).toBe("hermes_transient_upstream");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.resultJson).toMatchObject({ errorFamily: "transient_upstream" });
  });

  it.each([
    "API call failed after 3 retries: HTTP 502: Bad gateway",
    "API call failed after 3 retries: HTTP 503: Service unavailable",
    "API call failed after 3 retries: HTTP 504: Gateway timeout",
    "API call failed after 3 retries: request failed: ECONNRESET",
    "API call failed after 3 retries: request failed: ETIMEDOUT",
    "API call failed after 3 retries: connection reset by peer",
    "API call failed after 3 retries: socket hang up",
  ])("classifies transient signature: %s", async (message) => {
    childResult.current.stdout = message;

    const result = await execute(makeCtx() as any);

    expect(result.errorCode).toBe("hermes_transient_upstream");
    expect(result.errorFamily).toBe("transient_upstream");
  });

  it("does not classify an ordinary nonzero exit as transient", async () => {
    childResult.current.stderr = "Error: invalid tool configuration";

    const result = await execute(makeCtx() as any);

    expect(result.errorCode).toBeUndefined();
    expect(result.errorFamily).toBeUndefined();
    expect(result.resultJson).not.toHaveProperty("errorFamily");
  });

  it("does not classify transient-looking text quoted inside ordinary output", async () => {
    childResult.current.stdout = [
      "Tool output from a diagnostic file:",
      "API call failed after 3 retries: HTTP 503: Service unavailable",
      "The task then failed validation.",
    ].join("\n");

    const result = await execute(makeCtx() as any);

    expect(result.errorCode).toBeUndefined();
    expect(result.errorFamily).toBeUndefined();
    expect(result.resultJson).not.toHaveProperty("errorFamily");
  });

  it("does not classify a transient-looking stderr diagnostic before an unrelated terminal error", async () => {
    childResult.current.stderr = [
      "API call failed after 3 retries: HTTP 503: Service unavailable",
      "Fatal: invalid local Hermes configuration",
    ].join("\n");

    const result = await execute(makeCtx() as any);

    expect(result.errorCode).toBeUndefined();
    expect(result.errorFamily).toBeUndefined();
    expect(result.resultJson).not.toHaveProperty("errorFamily");
  });

  it("does not classify a deterministic 429 quota response as transient", async () => {
    childResult.current.stdout =
      "API call failed after 3 retries: HTTP 429: Monthly quota exhausted; upgrade your plan\n";

    const result = await execute(makeCtx() as any);

    expect(result.errorCode).toBeUndefined();
    expect(result.errorFamily).toBeUndefined();
    expect(result.resultJson).not.toHaveProperty("errorFamily");
  });
});
