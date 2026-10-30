/**
 * Regression tests for terminal Hermes API aborts that are written to stdout.
 *
 * Hermes prints its non-retryable abort to stdout and still exits 0. The
 * adapter only scanned stderr for error text, so such a run reached Paperclip
 * with exit code 0 and no errorMessage and recorded as `succeeded` despite
 * doing zero work.
 *
 * The stdout fixture below is the verbatim capture from run
 * 2215a6f1-7aa8-49c2-8ae1-ded70d299310, CRLF line endings included.
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

/** Verbatim stdout of the captured failing run. */
const ABORT_STDOUT = [
  "[hermes] Starting Hermes Agent (model=auto, provider=auto [auto], timeout=1800s)",
  "Initializing agent...\r",
  "────────────────────────────────────────\r",
  "",
  "⚠️  API call failed (attempt 1/3): BadRequestError [HTTP 400]\r",
  "   🔌 Provider: copilot  Model: auto\r",
  "   🌐 Endpoint: https://api.githubcopilot.com\r",
  "   📝 Error: HTTP 400: The requested model is not supported.\r",
  "   ⏱️  Elapsed: 0.96s  Context: 2 msgs, ~10,618 tokens\r",
  "❌ Non-retryable error (HTTP 400): HTTP 400: The requested model is not supported.\r",
  "❌ Non-retryable client error (HTTP 400). Aborting.\r",
  "   🔌 Provider: copilot  Model: auto\r",
  "   💡 This type of error won't be fixed by retrying.\r",
  "",
  "Resume this session with:",
  "  hermes --resume 20260823_033707_2cce8a",
  "",
  "Session:        20260823_033707_2cce8a",
  "Duration:       12s",
  "Messages:       1 (1 user, 0 tool calls)",
  "",
].join("\n");

/** A legitimate run that answered a question without calling any tool. */
const CLEAN_ZERO_TOOL_STDOUT = [
  "[hermes] Starting Hermes Agent (model=auto, provider=auto [auto], timeout=1800s)",
  "Yes — the deploy finished at 09:14 and both replicas are healthy.",
  "",
  "Session:        20260823_041500_9ab112",
  "Duration:       8s",
  "Messages:       2 (1 user, 0 tool calls)",
  "session_id: 20260823_041500_9ab112",
  "",
].join("\n");

function makeCtx() {
  return {
    runId: "test-run-stdout-abort",
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

function mockRun(overrides: { stdout?: string; stderr?: string; exitCode?: number }) {
  vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
    exitCode: overrides.exitCode ?? 0,
    signal: null,
    timedOut: false,
    stdout: overrides.stdout ?? "",
    stderr: overrides.stderr ?? "",
    pid: null,
    startedAt: null,
  } as never);
}

describe("hermes-local adapter stdout abort detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports a stdout non-retryable abort that exited 0", async () => {
    mockRun({ stdout: ABORT_STDOUT, exitCode: 0 });

    const result = await execute(makeCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBe(
      "❌ Non-retryable error (HTTP 400): HTTP 400: The requested model is not supported.",
    );
  });

  it("still reports the abort when only the terminal Aborting line is present", async () => {
    mockRun({
      stdout: "Working...\n❌ Non-retryable client error (HTTP 401). Aborting.\r\n",
      exitCode: 0,
    });

    const result = await execute(makeCtx() as never);

    expect(result.errorMessage).toBe("❌ Non-retryable client error (HTTP 401). Aborting.");
  });

  it("reports an exhausted retry budget", async () => {
    mockRun({
      stdout: "API call failed after 3 retries: Connection error.\n",
      exitCode: 0,
    });

    const result = await execute(makeCtx() as never);

    expect(result.errorMessage).toBe("API call failed after 3 retries: Connection error.");
  });

  it("leaves a successful run alone, including one with zero tool calls", async () => {
    mockRun({ stdout: CLEAN_ZERO_TOOL_STDOUT, exitCode: 0 });

    const result = await execute(makeCtx() as never);

    expect(result.errorMessage).toBeUndefined();
  });

  it("does not fail a run that recovered on a later API attempt", async () => {
    mockRun({
      stdout: [
        "⚠️  API call failed (attempt 1/3): APIConnectionError\r",
        "Retrying in 2s...\r",
        "Done — updated the config and pushed.",
        "",
      ].join("\n"),
      exitCode: 0,
    });

    const result = await execute(makeCtx() as never);

    expect(result.errorMessage).toBeUndefined();
  });

  it("does not fail a run that recovered on a fallback provider", async () => {
    mockRun({
      stdout: [
        "⚠️ Non-retryable error (HTTP 400) — trying fallback...\r",
        "⚠️ Max retries (3) exhausted — trying fallback...\r",
        "Done — answered from the fallback provider.",
        "",
      ].join("\n"),
      exitCode: 0,
    });

    const result = await execute(makeCtx() as never);

    expect(result.errorMessage).toBeUndefined();
  });

  it("keeps stderr as the higher-priority error source", async () => {
    mockRun({
      stdout: ABORT_STDOUT,
      stderr: "Error: provider unavailable\n",
      exitCode: 0,
    });

    const result = await execute(makeCtx() as never);

    expect(result.errorMessage).toBe("Error: provider unavailable");
  });
});
