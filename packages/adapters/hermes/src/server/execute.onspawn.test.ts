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

import { buildHermesChildEnv, execute } from "./execute.js";
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

  it("does not forward server-only environment variables to Hermes", async () => {
    const previous = {
      databaseUrl: process.env.DATABASE_URL,
      jwtSecret: process.env.PAPERCLIP_AGENT_JWT_SECRET,
      hermesHome: process.env.HERMES_HOME,
      bashEnv: process.env.BASH_ENV,
      envHook: process.env.ENV,
    };
    process.env.DATABASE_URL = "postgres://server-only";
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "server-signing-secret";
    process.env.HERMES_HOME = "/server/control-plane-profile";
    process.env.BASH_ENV = "/server/hostile-bash-env";
    process.env.ENV = "/server/hostile-shell-env";

    try {
      const { ctx } = makeCtx();
      await execute(ctx as any);

      const mocked = vi.mocked(serverUtils.runChildProcess);
      const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
      const opts = lastCall[3] as {
        env: Record<string, string>;
        inheritProcessEnv?: boolean;
      };
      expect(opts.inheritProcessEnv).toBe(false);
      expect(opts.env.DATABASE_URL).toBeUndefined();
      expect(opts.env.PAPERCLIP_AGENT_JWT_SECRET).toBeUndefined();
      expect(opts.env.HERMES_HOME).toBeUndefined();
      expect(opts.env.BASH_ENV).toBeUndefined();
      expect(opts.env.ENV).toBeUndefined();
      expect(opts.env.PATH).toBe(process.env.PATH);
    } finally {
      if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous.databaseUrl;
      if (previous.jwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previous.jwtSecret;
      if (previous.hermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = previous.hermesHome;
      if (previous.bashEnv === undefined) delete process.env.BASH_ENV;
      else process.env.BASH_ENV = previous.bashEnv;
      if (previous.envHook === undefined) delete process.env.ENV;
      else process.env.ENV = previous.envHook;
    }
  });

  it("rejects unsupported remote targets before spawning a local process", async () => {
    const { ctx } = makeCtx();
    (ctx as any).executionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/remote/workspace",
    };

    await expect(execute(ctx as any)).rejects.toThrow(
      "Hermes local adapter does not support remote execution targets",
    );
    expect(vi.mocked(serverUtils.runChildProcess)).not.toHaveBeenCalled();
  });

  it("rejects legacy remote transports before spawning a local process", async () => {
    const { ctx } = makeCtx();
    (ctx as any).executionTransport = {
      remoteExecution: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteCwd: "/remote/workspace",
      },
    };

    await expect(execute(ctx as any)).rejects.toThrow(
      "Hermes local adapter does not support remote execution targets",
    );
    expect(vi.mocked(serverUtils.runChildProcess)).not.toHaveBeenCalled();
  });
});

describe("buildHermesChildEnv", () => {
  it("drops credentialed inherited proxy URLs", () => {
    const env = buildHermesChildEnv(
      {},
      {
        HTTP_PROXY: "http://proxy-user:proxy-pass@proxy.example:8080",
        HTTPS_PROXY: "https://proxy.example:8443",
        ALL_PROXY: "socks5://proxy-user@proxy.example:1080",
        NO_PROXY: "localhost,127.0.0.1",
      },
    );

    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.ALL_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe("https://proxy.example:8443");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
  });

  it("preserves a credentialed proxy explicitly configured for the agent", () => {
    const configuredProxy = "http://agent-user:agent-pass@proxy.example:8080";
    const env = buildHermesChildEnv(
      { env: { HTTP_PROXY: configuredProxy } },
      { HTTP_PROXY: "http://server-user:server-pass@proxy.example:8080" },
    );

    expect(env.HTTP_PROXY).toBe(configuredProxy);
  });

  it("lets configured Windows environment keys override inherited casing", () => {
    const env = buildHermesChildEnv(
      { env: { Path: "C:\\agent-bin" } },
      { PATH: "C:\\server-bin" },
      "win32",
    );

    expect(env).toEqual({ Path: "C:\\agent-bin" });
  });
});
