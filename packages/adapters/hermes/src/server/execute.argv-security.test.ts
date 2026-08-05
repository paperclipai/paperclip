/**
 * Security regression test: hermes adapter must NOT pass the prompt as an
 * argv element.
 *
 * Background (TRA-257 / TRA-256): the original adapter called
 *   hermes chat -q "<full_prompt>"
 * This exposed the entire rendered prompt — task body, wake context, issue
 * comments, agent instructions, and API guidance — to any local process that
 * can read /proc/<pid>/cmdline or run `ps aux` on the same host.
 *
 * The fix changes the invocation to
 *   hermes chat -q -
 * and delivers the prompt via the `stdin` option of runChildProcess so it
 * never appears in argv.
 *
 * These tests:
 * 1. Verify args[2] is the sentinel "-", never prompt text.
 * 2. Verify opts.stdin contains the prompt text.
 * 3. Verify no sensitive sentinel (task id, wake context, company info) is
 *    visible in argv regardless of what the prompt contains.
 * 4. Verify cross-company isolation: a second company's context cannot bleed
 *    into the first run's argv.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// Intercept runChildProcess so we can inspect the invocation without spawning
// a real hermes process.
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

// Prevent real filesystem access inside execute().
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

// Sentinel values that must NOT appear in argv but MUST appear in stdin.
const SENTINEL_TASK_ID = "SENTINEL_TASK_ID_abc123";
const SENTINEL_ISSUE_TITLE = "SENTINEL_ISSUE_TITLE_xyz789";
const SENTINEL_COMPANY_A = "SENTINEL_COMPANY_A_payload_qwerty";
const SENTINEL_COMPANY_B = "SENTINEL_COMPANY_B_payload_asdfgh";

function makeCtx(overrides: Record<string, unknown> = {}, companySentinel = SENTINEL_COMPANY_A) {
  return {
    runId: "test-run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes Test Agent",
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
      ...overrides,
    },
    context: {
      issueId: SENTINEL_TASK_ID,
      wakeReason: "manual",
      paperclipWake: {
        reason: "issue_assigned",
        issue: {
          id: SENTINEL_TASK_ID,
          identifier: "TRA-257",
          title: SENTINEL_ISSUE_TITLE,
          status: "in_progress",
          priority: "critical",
          workMode: "standard",
        },
        payload: companySentinel,
        checkedOutByHarness: true,
        commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
        comments: [],
        fallbackFetchNeeded: false,
      },
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  };
}

describe("hermes adapter argv security (TRA-257)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes '-' (stdin sentinel) as the query arg, not the prompt text", async () => {
    const ctx = makeCtx();
    try {
      await execute(ctx as any);
    } catch {
      // May fail due to mock environment — we only care about the spy calls.
    }

    const mocked = vi.mocked(serverUtils.runChildProcess);
    expect(mocked.mock.calls.length).toBeGreaterThan(0);

    const [, , args] = mocked.mock.calls[mocked.mock.calls.length - 1];

    // args[0] must be "chat", args[1] must be "-q", args[2] must be "-"
    expect(args[0]).toBe("chat");
    expect(args[1]).toBe("-q");
    expect(args[2]).toBe("-");
  });

  it("delivers the prompt via opts.stdin, not via argv", async () => {
    const ctx = makeCtx();
    try {
      await execute(ctx as any);
    } catch {
      // Ignore
    }

    const mocked = vi.mocked(serverUtils.runChildProcess);
    expect(mocked.mock.calls.length).toBeGreaterThan(0);

    const [, , args, opts] = mocked.mock.calls[mocked.mock.calls.length - 1] as [
      unknown,
      unknown,
      string[],
      Record<string, unknown>,
    ];

    // Prompt text must be in opts.stdin
    expect(typeof opts.stdin).toBe("string");
    expect((opts.stdin as string).length).toBeGreaterThan(0);

    // opts.stdin must contain the issue title (sanity-check that it's a real prompt)
    expect(opts.stdin as string).toContain(SENTINEL_ISSUE_TITLE);

    // No argv element (beyond "-") should contain the sentinel
    const argvText = args.join(" ");
    expect(argvText).not.toContain(SENTINEL_ISSUE_TITLE);
  });

  it("task id sentinel does not appear in argv", async () => {
    const ctx = makeCtx();
    try {
      await execute(ctx as any);
    } catch {
      // Ignore
    }

    const mocked = vi.mocked(serverUtils.runChildProcess);
    expect(mocked.mock.calls.length).toBeGreaterThan(0);

    const [, , args] = mocked.mock.calls[mocked.mock.calls.length - 1];
    const argvText = args.join(" ");

    // The task/issue ID must not be visible in argv.
    expect(argvText).not.toContain(SENTINEL_TASK_ID);
  });

  it("company-A payload does not appear in company-B run's argv", async () => {
    // Run company A first
    const ctxA = makeCtx({}, SENTINEL_COMPANY_A);
    try {
      await execute(ctxA as any);
    } catch {
      // Ignore
    }

    vi.clearAllMocks();

    // Run company B
    const ctxB = makeCtx({ command: "/usr/bin/hermes" }, SENTINEL_COMPANY_B);
    try {
      await execute(ctxB as any);
    } catch {
      // Ignore
    }

    const mocked = vi.mocked(serverUtils.runChildProcess);
    expect(mocked.mock.calls.length).toBeGreaterThan(0);

    const [, , args, opts] = mocked.mock.calls[mocked.mock.calls.length - 1] as [
      unknown,
      unknown,
      string[],
      Record<string, unknown>,
    ];

    const argvText = args.join(" ");
    const stdinText = (opts.stdin as string) ?? "";

    // Company A's payload must not appear in company B's argv or stdin
    expect(argvText).not.toContain(SENTINEL_COMPANY_A);
    expect(stdinText).not.toContain(SENTINEL_COMPANY_A);

    // Company B's payload must NOT appear in argv.
    expect(argvText).not.toContain(SENTINEL_COMPANY_B);
  });

  it("all argv elements after the query sentinel are non-prompt flags only", async () => {
    const ctx = makeCtx({ quiet: true, verbose: true });
    try {
      await execute(ctx as any);
    } catch {
      // Ignore
    }

    const mocked = vi.mocked(serverUtils.runChildProcess);
    expect(mocked.mock.calls.length).toBeGreaterThan(0);

    const [, , args] = mocked.mock.calls[mocked.mock.calls.length - 1];

    // Every element in args should be a short CLI flag/option or its value,
    // not a paragraph of text.
    const qIdx = args.indexOf("-q");
    expect(qIdx).toBeGreaterThanOrEqual(0);
    expect(args[qIdx + 1]).toBe("-"); // sentinel, never the prompt body

    // No arg should be longer than 256 characters.
    for (const arg of args) {
      expect(arg.length).toBeLessThanOrEqual(256);
    }
  });
});
