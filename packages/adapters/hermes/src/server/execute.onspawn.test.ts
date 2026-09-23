/**
 * Regression test for onSpawn forwarding in the hermes-local adapter.
 *
 * Ensures ctx.onSpawn is forwarded to runChildProcess() so the orphan
 * reaper can track live child processes by PID, preventing false-positive
 * reaps on runs whose updatedAt becomes stale.
 *
 * @see https://github.com/paperclipai/paperclip/issues/8723
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the adapter-utils server-utils module that execute.ts imports from.
// We intercept runChildProcess so we can inspect its opts without spawning
// a real child process.
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

// Mock fs and path resolution to avoid real file reads in execute()
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => "MANAGED_AGENT_INSTRUCTIONS"),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx(overrides: Record<string, unknown> = {}) {
  const onSpawn = vi.fn(async () => undefined);
  return {
    ctx: {
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
        ...overrides,
      },
      context: {
        issueId: "issue-1",
        wakeReason: "manual",
        paperclipWake: null,
      },
      onLog: vi.fn(async () => undefined),
      onMeta: vi.fn(async () => undefined),
      onSpawn,
    } satisfies Record<string, unknown>,
    onSpawn,
  };
}

describe("hermes-local adapter onSpawn forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards ctx.onSpawn to runChildProcess", async () => {
    const { ctx, onSpawn } = makeCtx();

    // execute() will call runChildProcess internally.
    // We expect it to propagate ctx.onSpawn.
    // Because we mocked runChildProcess, the actual child doesn't spawn,
    // but we can verify it was called with onSpawn.
    try {
      await execute(ctx as any);
    } catch {
      // execute may fail due to missing hermes binary / env — that's OK,
      // we only care that runChildProcess was called with onSpawn.
    }

    const mocked = vi.mocked(serverUtils.runChildProcess);
    expect(mocked.mock.calls.length).toBeGreaterThan(0);
    const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
    const opts = lastCall[3] as Record<string, unknown>;
    expect(opts.onSpawn).toBe(onSpawn);
  });

  it("enables quiet mode by default and allows an explicit opt-out", async () => {
    const { ctx } = makeCtx();
    await execute(ctx as any);

    const mocked = vi.mocked(serverUtils.runChildProcess);
    const defaultArgs = mocked.mock.calls.at(-1)?.[2] as string[];
    expect(defaultArgs).toContain("-Q");

    const { ctx: noisyCtx } = makeCtx({ quiet: false });
    await execute(noisyCtx as any);
    const noisyArgs = mocked.mock.calls.at(-1)?.[2] as string[];
    expect(noisyArgs).not.toContain("-Q");
  });

  it("does not trust the Hermes 0.20 non-quiet footer as session metadata", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        "Answer text",
        "",
        "Resume this session with:",
        "  hermes --resume 20260814_144930_03a3ec",
        "Session: 20260814_144930_03a3ec",
      ].join("\n"),
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx({ quiet: false });
    const result = await execute(ctx as any);

    expect(result.sessionParams).toBeUndefined();
    expect(result.resultJson).toMatchObject({
      result: [
        "Answer text",
        "",
        "Resume this session with:",
        "hermes --resume 20260814_144930_03a3ec",
        "Session: 20260814_144930_03a3ec",
      ].join("\n"),
    });
  });

  it("uses only the canonical terminal quiet-mode session line", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        "Answer text",
        "session_id: 20260101_010101_deadbeef",
        "Still part of the answer.",
        "",
        "session_id: 20260814_144930_03a3ec",
      ].join("\n"),
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.sessionParams).toEqual({ sessionId: "20260814_144930_03a3ec" });
    expect(result.resultJson).toMatchObject({
      result: [
        "Answer text",
        "session_id: 20260101_010101_deadbeef",
        "Still part of the answer.",
      ].join("\n"),
    });
  });

  it("parses quiet sessions enabled through extraArgs", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        "Answer text",
        "",
        "session_id: 20260814_144930_03a3ec",
      ].join("\n"),
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx({
      quiet: false,
      extraArgs: ["-Q"],
    });
    const result = await execute(ctx as any);

    expect(result.sessionParams).toEqual({
      sessionId: "20260814_144930_03a3ec",
    });
    expect(result.resultJson).toMatchObject({
      result: "Answer text",
    });
  });

  it("preserves footer-shaped answer prose and does not persist it as a session", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        "Session: planning",
        "session_id: planning",
        "session id: planning",
        "session saved: example",
        "Resume this session with:",
        "hermes --resume example",
        "This is ordinary answer content.",
      ].join("\n"),
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx({ quiet: false });
    const result = await execute(ctx as any);

    expect(result.sessionParams).toBeUndefined();
    expect(result.resultJson).toMatchObject({
      result: [
        "Session: planning",
        "session_id: planning",
        "session id: planning",
        "session saved: example",
        "Resume this session with:",
        "hermes --resume example",
        "This is ordinary answer content.",
      ].join("\n"),
    });
  });

  it("sends only the wake delta when resuming and does not reinject managed instructions", async () => {
    const { ctx } = makeCtx({ instructionsFilePath: "/managed/AGENTS.md" });
    (ctx.runtime as any).sessionParams = { sessionId: "20260814_155413_3d2fdf" };
    (ctx.context as any).paperclipWake = {
      reason: "issue_commented",
      issue: {
        id: "issue-1",
        identifier: "TES-10",
        title: "你是谁？",
        status: "in_progress",
        priority: "medium",
        workMode: "standard",
      },
      latestCommentId: "comment-1",
      commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
      comments: [{
        id: "comment-1",
        body: "帮我看看今天有什么 ai 新闻",
        createdAt: "2026-08-14T07:57:08.550Z",
      }],
      fallbackFetchNeeded: false,
    };
    (ctx.context as any).paperclipTaskMarkdown = [
      "Paperclip task context:",
      '- Issue: "TES-10"',
      "Latest wake comment:",
      "帮我看看今天有什么 ai 新闻",
    ].join("\n");
    (ctx.context as any).paperclipTaskMarkdownCompact = [
      "Paperclip task context:",
      '- Issue: "TES-10"',
      "",
      "Latest wake comment:",
      "```text",
      "帮我看看今天有什么 ai 新闻",
      "```",
      "",
      "Use this task context as the current assignment.",
    ].join("\n");

    await execute(ctx as any);

    const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)?.[2] as string[];
    const prompt = args[args.indexOf("-q") + 1];
    expect(args).toContain("--resume");
    expect(prompt).toContain("## Paperclip Resume Delta");
    expect(prompt.match(/帮我看看今天有什么 ai 新闻/g)).toHaveLength(1);
    expect(prompt).not.toContain("MANAGED_AGENT_INSTRUCTIONS");
    expect(prompt).toContain("Paperclip task context:");
    expect(prompt).not.toContain("Latest wake comment:");
    expect(prompt).not.toContain("Paperclip runtime identity:");
  });

  it("runChildProcess opts type includes onSpawn", () => {
    // Type-level assertion: if onSpawn were removed from the type,
    // this file would fail to compile. The runtime test above catches
    // the behavioral case; this documents the contract.
    const opts: Parameters<typeof serverUtils.runChildProcess>[3] = {
      cwd: "/tmp",
      env: {},
      timeoutSec: 60,
      graceSec: 5,
      onLog: async () => undefined,
      onSpawn: async () => undefined,
    };
    expect(opts.onSpawn).toBeDefined();
  });

  it("preserves a specific stderr diagnostic for a nonzero exit", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Error: provider unavailable\n",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorMessage).toBe("Error: provider unavailable");
  });

  it("reports the exit code when a nonzero exit has no diagnostic", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 130,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorMessage).toBe("Hermes exited with code 130");
  });

  it("leaves timeout diagnostics to the heartbeat timeout path", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 143,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorMessage).toBeUndefined();
  });

  it("does not label signal cancellation as a silent nonzero exit", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorMessage).toBeUndefined();
  });

  it("does not inherit PAPERCLIP_API_KEY without a harness token", async () => {
    const previousApiKey = process.env.PAPERCLIP_API_KEY;
    process.env.PAPERCLIP_API_KEY = "parent-process-key";

    try {
      const { ctx } = makeCtx();
      await execute(ctx as any);

      const mocked = vi.mocked(serverUtils.runChildProcess);
      const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
      const opts = lastCall[3] as { env: Record<string, string> };
      expect(opts.env.PAPERCLIP_API_KEY).toBeUndefined();
    } finally {
      if (previousApiKey === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = previousApiKey;
    }
  });
});
