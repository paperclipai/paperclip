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

  it("keeps wake data in the prompt and drops configured JSON env copies", async () => {
    const { ctx } = makeCtx({ env: { PAPERCLIP_WAKE_PAYLOAD_JSON: "stale configured wake" } });
    const wake = { reason: "issue_assigned", issue: { id: "issue-1", description: "Current task brief" } };
    await execute({ ...ctx, context: { ...ctx.context, paperclipWake: wake } } as any);
    const call = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)!;
    expect(call[3].env).not.toHaveProperty("PAPERCLIP_WAKE_PAYLOAD_JSON");
    expect(call[2]).toContainEqual(expect.stringContaining("Current task brief"));
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

  // The echo has to be streamed while the child is running, because execute()
  // flushes the filter once it exits. Replaying stdout after execute() returns
  // would hit a filter that has already stopped, and would pass either way.
  // https://github.com/paperclipai/paperclip/pull/14845#discussion_r4156807288
  async function runEchoingStdout(quiet: boolean) {
    vi.mocked(serverUtils.runChildProcess).mockImplementationOnce(
      async (_runId: any, _cmd: any, args: any, opts: any) => {
        const echoed = args[args.indexOf("-q") + 1] as string;
        // Hermes prints the query back before the agent says anything.
        await opts.onLog("stdout", `Query: ${echoed}\n`);
        await opts.onLog("stdout", "the real answer\n");
        return {
          exitCode: 0, signal: null, timedOut: false,
          stdout: "", stderr: "", pid: null, startedAt: null,
        };
      },
    );

    const { ctx } = makeCtx({ quiet });
    await execute(ctx as any);

    const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![2] as string[];
    const prompt = args[args.indexOf("-q") + 1];
    const logged = vi.mocked(ctx.onLog).mock.calls as unknown as [
      string,
      string,
    ][];
    const streamed = logged
      .filter((c) => c[0] === "stdout")
      .map((c) => c[1])
      .join("");
    return { args, prompt, streamed };
  }

  it("keeps the echo out of the transcript on a non-quiet run", async () => {
    const { args, prompt, streamed } = await runEchoingStdout(false);
    expect(args).not.toContain("-Q");
    expect(prompt.length).toBeGreaterThan(200); // or the filter declines to act
    expect(streamed).not.toContain(prompt);
    expect(streamed).toContain("the real answer");
  });

  // A quiet run passes -Q and prints no echo, so filtering it could only ever
  // discard a real answer that opens by quoting the prompt back.
  it("never filters stdout when quiet mode is on", async () => {
    const { args, prompt, streamed } = await runEchoingStdout(true);
    expect(args).toContain("-Q");
    expect(prompt.length).toBeGreaterThan(200);
    expect(streamed).toContain(prompt);
    expect(streamed).toContain("the real answer");
  });

  // ── stream-json, opt-in ────────────────────────────────────────────────
  // Real stdout from `hermes chat -q "What is 2+2? Answer with just the
  // number." --format stream-json --source tool --yolo` on Hermes v0.21.5.
  const STREAM_JSON_RUN = [
    `{"type": "system", "subtype": "init", "model": "", "session_id": "20261001_120206_9d5174", "timestamp": 1790870526519}`,
    `{"type": "text", "text": "4", "timestamp": 1790870534345}`,
    `{"type": "result", "session_id": "20261001_120206_9d5174", "exit_code": 0, "text": "4", "tokens": {"input": 4, "output": 3, "total": 19707, "cache_read": 0, "cache_write": 19700}, "duration_ms": 8971, "timestamp": 1790870535490}`,
  ].join("\n") + "\n";

  it("leaves the command line alone unless the config opts in", async () => {
    const { ctx } = makeCtx();
    await execute(ctx as any);

    const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![2] as string[];
    expect(args).not.toContain("--format");
    expect(args).not.toContain("stream-json");
  });

  it("reads session, usage and answer from the events when opted in", async () => {
    vi.mocked(serverUtils.runChildProcess).mockImplementationOnce(
      async (_runId: any, _cmd: any, _args: any, opts: any) => {
        await opts.onLog("stdout", STREAM_JSON_RUN);
        return {
          exitCode: 0, signal: null, timedOut: false,
          stdout: "", stderr: "", pid: null, startedAt: null,
        };
      },
    );

    const { ctx } = makeCtx({ outputFormat: "stream-json" });
    const result = await execute(ctx as any);

    const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![2] as string[];
    expect(args.slice(args.indexOf("--format"), args.indexOf("--format") + 2))
      .toEqual(["--format", "stream-json"]);

    expect(result.sessionParams).toEqual({ sessionId: "20261001_120206_9d5174" });
    // 4 fresh input + 19700 written to the cache, which is billed as input.
    expect(result.usage).toEqual({ inputTokens: 4 + 19700, outputTokens: 3, cachedInputTokens: 0 });
    expect(result.summary).toBe("4");
    expect(result.errorMessage).toBeUndefined();

    // The transcript gets the answer, never the envelope it arrived in.
    const streamed = (vi.mocked(ctx.onLog).mock.calls as unknown as [string, string][])
      .filter((c) => c[0] === "stdout")
      .map((c) => c[1])
      .join("");
    expect(streamed).toContain("4");
    expect(streamed).not.toContain(`"type"`);
  });

  // argparse keeps the last --format, and the parse path is already committed
  // to events, so ours has to come after anything extraArgs contributes.
  // https://github.com/paperclipai/paperclip/pull/14860#discussion_r4157187841
  it("wins over a conflicting format in extraArgs", async () => {
    const { ctx } = makeCtx({ outputFormat: "stream-json", extraArgs: ["--format", "text"] });
    await execute(ctx as any);

    const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![2] as string[];
    expect(args.lastIndexOf("--format")).toBeGreaterThan(args.indexOf("--format"));
    expect(args[args.lastIndexOf("--format") + 1]).toBe("stream-json");
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
