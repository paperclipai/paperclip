import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    })),
  };
});

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeContext() {
  return {
    runId: "tri-108-output-test",
    agent: {
      id: "agent-test",
      companyId: "company-test",
      name: "Hermes test agent",
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
      command: "hermes",
      model: "gpt-5.4-mini",
      provider: "openai-codex",
      timeoutSec: 60,
      graceSec: 5,
    },
    context: {
      issueId: "TRI-108",
      wakeReason: "manual",
      paperclipWake: null,
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
  } satisfies Record<string, unknown>;
}

function mockChildOutput(stdout: string, stderr: string) {
  vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr,
    pid: null,
    startedAt: null,
  });
}

describe("Hermes adapter output protocol", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses quiet mode and parses the final response plus stderr session trailer", async () => {
    mockChildOutput("Read-only check completed.\n", "\nsession_id: session-tri108-1\n");

    const result = await execute(makeContext() as any);

    const [, , args] = vi.mocked(serverUtils.runChildProcess).mock.calls[0];
    expect(args).toContain("-Q");
    expect(result.summary).toBe("Read-only check completed.");
    expect(result.sessionParams).toEqual({ sessionId: "session-tri108-1" });
    expect(result.resultJson).toMatchObject({
      result: "Read-only check completed.",
      session_id: "session-tri108-1",
    });
    expect(result.errorMessage).toBeUndefined();
  });

  it("fails closed when exit-zero stdout contains only the Query echo", async () => {
    mockChildOutput("Query: sanitized TRI-108 test input\n", "");

    const result = await execute(makeContext() as any);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toMatch(/no assistant response/i);
    expect(result.summary).toBeUndefined();
    expect(result.resultJson).toMatchObject({ result: "", session_id: null });
    expect(result.sessionParams).toBeUndefined();
  });

  it("fails closed when Hermes exits zero without stdout response", async () => {
    mockChildOutput("  \n", "\n");

    const result = await execute(makeContext() as any);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toMatch(/no assistant response/i);
    expect(result.summary).toBeUndefined();
    expect(result.resultJson).toMatchObject({ result: "", session_id: null });
  });
});
