/**
 * The hermes-local adapter passes `--in <workspace cwd>` to `hermes chat`,
 * because the shared Hermes gateway ignores the cwd of the child process.
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

describe("hermes execute: start in the run workspace", () => {
  beforeEach(() => {
    vi.mocked(serverUtils.runChildProcess).mockClear();
  });

  function argsOfLastRun(): string[] {
    const calls = vi.mocked(serverUtils.runChildProcess).mock.calls;
    return calls[calls.length - 1][2] as string[];
  }

  it("passes --in with the resolved workspace cwd", async () => {
    const { ctx } = makeCtx();
    (ctx.context as Record<string, unknown>).paperclipWorkspace = { cwd: "/srv/workspaces/run-1" };
    await execute(ctx as never);
    const args = argsOfLastRun();
    const i = args.indexOf("--in");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("/srv/workspaces/run-1");
  });

  it("lets an explicit adapterConfig.cwd win", async () => {
    const { ctx } = makeCtx({ cwd: "/srv/explicit" });
    (ctx.context as Record<string, unknown>).paperclipWorkspace = { cwd: "/srv/workspaces/run-1" };
    await execute(ctx as never);
    const args = argsOfLastRun();
    expect(args[args.indexOf("--in") + 1]).toBe("/srv/explicit");
  });

  it("does not pass --in when startInWorkspace is false", async () => {
    const { ctx } = makeCtx({ startInWorkspace: false });
    (ctx.context as Record<string, unknown>).paperclipWorkspace = { cwd: "/srv/workspaces/run-1" };
    await execute(ctx as never);
    expect(argsOfLastRun()).not.toContain("--in");
  });

  it("does not pass --in without an absolute directory", async () => {
    const { ctx } = makeCtx();
    await execute(ctx as never);
    expect(argsOfLastRun()).not.toContain("--in");
  });

  it("does not add a second --in from extraArgs", async () => {
    const { ctx } = makeCtx({ extraArgs: ["--in", "/srv/custom"] });
    (ctx.context as Record<string, unknown>).paperclipWorkspace = { cwd: "/srv/workspaces/run-1" };
    await execute(ctx as never);
    const args = argsOfLastRun();
    expect(args.filter((a) => a === "--in")).toHaveLength(1);
    expect(args[args.indexOf("--in") + 1]).toBe("/srv/custom");
  });
});
