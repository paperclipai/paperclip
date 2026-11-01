/**
 * Regression tests for #16443: when every Hermes provider call fails, the
 * CLI still exits 0 and prints the prompt echo ("Query: <prompt>") plus a
 * session footer. The adapter used to adopt that blob as the agent's
 * response, so the run recorded as succeeded with zero agent turns. The
 * footer line "Messages: 1 (1 user, 0 tool calls)" proves no agent turn
 * happened; the run must be marked failed instead.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

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
    })),
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
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx() {
  return {
    runId: "test-run-prompt-echo",
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

function mockChildResult(result: { exitCode: number; stdout: string; stderr: string }) {
  vi.mocked(serverUtils.runChildProcess).mockResolvedValue({
    exitCode: result.exitCode,
    signal: null,
    timedOut: false,
    stdout: result.stdout,
    stderr: result.stderr,
  } as Awaited<ReturnType<typeof serverUtils.runChildProcess>>);
}

const FAILED_RUN_STDOUT = [
  "Query: Summarize the open incident tickets",
  "",
  "Initializing agent...",
  "WARNING: API request failed: HTTP 404 model 'auto' not found",
  "WARNING: Retrying (1/3)...",
  "WARNING: API request failed: HTTP 404 model 'auto' not found",
  "Max retries (3) exhausted",
  "",
  "Resume this session with: hermes --resume 20260923_183254_cd6633",
  "Session: 20260923_183254_cd6633",
  "Duration: 43.27s",
  "Messages: 1 (1 user, 0 tool calls)",
].join("\n");

describe("hermes-local prompt-echo runs (#16443)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks a footer-only run (1 user message, 0 tool calls) as a zero-turn failure", async () => {
    mockChildResult({ exitCode: 0, stdout: FAILED_RUN_STDOUT, stderr: "" });

    const result = await execute(makeCtx() as never);

    expect(result.errorCode).toBe("zero_agent_turns");
    expect(result.errorMessage).toBeTruthy();
    expect(result.summary ?? "").not.toContain("Summarize the open incident tickets");
    const resultJson = result.resultJson as { result?: string } | undefined;
    expect(resultJson?.result ?? "").not.toContain("Summarize the open incident tickets");
  });

  it("ignores a zero-turn footer quoted inside the prompt when the real footer shows a reply", async () => {
    mockChildResult({
      exitCode: 0,
      stdout: [
        "Query: Why did the earlier run fail? Its transcript ended with:",
        "Messages: 1 (1 user, 0 tool calls)",
        "",
        "That earlier session never got a provider reply, so it recorded zero turns.",
        "",
        "Resume this session with: hermes --resume 20260923_210000_ij56kl",
        "Session: 20260923_210000_ij56kl",
        "Duration: 4.02s",
        "Messages: 2 (1 user, 0 tool calls)",
      ].join("\n"),
      stderr: "",
    });

    const result = await execute(makeCtx() as never);

    expect(result.errorCode).toBeUndefined();
    expect(result.summary ?? "").toContain("never got a provider reply");
  });

  it("keeps a real one-message answer that used no tools", async () => {
    mockChildResult({
      exitCode: 0,
      stdout: [
        "Query: What is the deploy freeze window?",
        "",
        "The deploy freeze window is Friday 17:00 to Monday 09:00 UTC.",
        "",
        "Resume this session with: hermes --resume 20260923_190000_ab12cd",
        "Session: 20260923_190000_ab12cd",
        "Duration: 3.10s",
        "Messages: 2 (1 user, 0 tool calls)",
      ].join("\n"),
      stderr: "",
    });

    const result = await execute(makeCtx() as never);

    expect(result.errorCode).toBeUndefined();
    expect(result.summary ?? "").toContain("deploy freeze window is Friday");
  });

  it("keeps a session that made tool calls", async () => {
    mockChildResult({
      exitCode: 0,
      stdout: [
        "Query: Check the ticket queue",
        "",
        "There are 3 open incident tickets.",
        "",
        "Resume this session with: hermes --resume 20260923_200000_ef34gh",
        "Session: 20260923_200000_ef34gh",
        "Duration: 12.40s",
        "Messages: 4 (1 user, 2 tool calls)",
      ].join("\n"),
      stderr: "",
    });

    const result = await execute(makeCtx() as never);

    expect(result.errorCode).toBeUndefined();
    expect(result.summary ?? "").toContain("3 open incident tickets");
  });
});
