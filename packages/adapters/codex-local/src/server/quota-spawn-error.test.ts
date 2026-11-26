import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const cp = await importOriginal<typeof import("node:child_process")>();
  return {
    ...cp,
    spawn: (...args: Parameters<typeof cp.spawn>) => mockSpawn(...args) as ReturnType<typeof cp.spawn>,
  };
});

import { fetchCodexQuota, fetchCodexRpcQuota, getQuotaWindows } from "./quota.js";

function createChildThatErrorsOnMicrotask(err: Error): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stream = Object.assign(new EventEmitter(), {
    setEncoding: () => {},
  });
  Object.assign(child, {
    stdout: stream,
    stderr: Object.assign(new EventEmitter(), { setEncoding: () => {} }),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() }),
    kill: vi.fn(),
  });
  queueMicrotask(() => {
    child.emit("error", err);
  });
  return child;
}

type RpcRequest = { id?: number; method: string };

function createRpcChild(response?: (request: RpcRequest) => unknown) {
  const child = new EventEmitter() as ChildProcess;
  const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((line: string) => {
      const request = JSON.parse(line) as RpcRequest;
      if (request.id == null) return;
      const message = response ? response(request) : { id: request.id, result: {} };
      if (message !== undefined) {
        queueMicrotask(() => stdout.emit("data", JSON.stringify(message) + "\n"));
      }
    }),
    end: vi.fn(),
  });
  const kill = vi.fn((_signal?: string | number) => {
    queueMicrotask(() => child.emit("close", 0));
    return true;
  });
  Object.assign(child, { pid: 12345, stdout, stderr, stdin, kill });
  return { child, stdout, stderr, stdin, kill };
}

describe("CodexRpcClient spawn failures", () => {
  let previousCodexHome: string | undefined;
  let isolatedCodexHome: string | undefined;

  beforeEach(() => {
    mockSpawn.mockReset();
    // After the RPC path fails, getQuotaWindows() calls readCodexToken() which
    // reads $CODEX_HOME/auth.json (default ~/.codex). Point CODEX_HOME at an
    // empty temp directory so we never hit real host auth or the WHAM network.
    previousCodexHome = process.env.CODEX_HOME;
    isolatedCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-codex-spawn-test-"));
    process.env.CODEX_HOME = isolatedCodexHome;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (isolatedCodexHome) {
      try {
        fs.rmSync(isolatedCodexHome, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      isolatedCodexHome = undefined;
    }
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("reads account quota with a supported approval policy and never starts a model turn", async () => {
    const { child, stdin, kill } = createRpcChild((request) => {
      const result = request.method === "account/rateLimits/read"
        ? { rateLimits: { primary: { usedPercent: 37, windowDurationMins: 300 } } }
        : {};
      return { id: request.id, result };
    });
    mockSpawn.mockImplementation((_command, args: string[]) => {
      if (args.includes("untrusted")) return createChildThatErrorsOnMicrotask(new Error("invalid approval policy"));
      return child;
    });

    const result = await fetchCodexRpcQuota();
    expect(result.windows).toEqual([expect.objectContaining({ usedPercent: 37 })]);
    expect(mockSpawn).toHaveBeenCalledWith("codex", ["-s", "read-only", "-a", "on-request", "app-server"], expect.any(Object));
    expect(stdin.write.mock.calls.map(([line]) => JSON.parse(line).method)).toEqual([
      "initialize", "initialized", "account/rateLimits/read", "account/read",
    ]);
    expect(stdin.end).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(kill).not.toHaveBeenCalledWith("SIGKILL");
  });

  it("rejects RPC error envelopes and preserves their authentication classification", async () => {
    const { child, kill } = createRpcChild((request) => request.method === "account/rateLimits/read"
      ? { id: request.id, error: { code: -32000, message: "OAuth failed: refresh token has expired" } }
      : { id: request.id, result: {} });
    mockSpawn.mockReturnValue(child);

    const result = await getQuotaWindows();

    expect(result).toMatchObject({ ok: false, source: "codex-rpc", errorFamily: "refresh_token_expired", windows: [] });
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.each([null, [], "invalid", 17, undefined])("rejects an invalid result envelope (%s)", async (result) => {
    const { child } = createRpcChild((request) => ({ id: request.id, result }));
    mockSpawn.mockReturnValue(child);
    await expect(fetchCodexRpcQuota()).rejects.toThrow("invalid quota response");
  });

  it("tolerates non-object lines and parses fragmented, out-of-order replies", async () => {
    const probe = createRpcChild();
    mockSpawn.mockReturnValue(probe.child);
    probe.stdin.write.mockImplementation((line) => {
      const request = JSON.parse(line) as RpcRequest;
      if (request.method === "initialize") {
        queueMicrotask(() => probe.stdout.emit("data", 'null\n[]\nnot-json\n{"id":1,"result":{}}\n'));
      } else if (request.method === "account/read") {
        queueMicrotask(() => {
          probe.stdout.emit("data", '{"id":3,"result":{"account":{"email":"test@example.com"}}}\n{"id":2,');
          probe.stdout.emit("data", '"result":{"rateLimits":{"primary":{"usedPercent":37}}}}\n');
        });
      }
    });
    const result = await fetchCodexRpcQuota();
    expect(result.email).toBe("test@example.com");
    expect(result.windows[0].usedPercent).toBe(37);
  });

  it.each([false, true])("bounds stdout buffering with and without a completed frame (newline: %s)", async (newline) => {
    const probe = createRpcChild(() => undefined);
    mockSpawn.mockReturnValue(probe.child);
    const result = fetchCodexRpcQuota();
    probe.stdout.emit("data", "x".repeat(64 * 1024));
    probe.stdout.emit("data", "x" + (newline ? "\n" : ""));
    await expect(result).rejects.toThrow("response exceeded the quota probe limit");
    expect(probe.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("bounds stderr diagnostics when the process exits", async () => {
    const probe = createRpcChild(() => undefined);
    mockSpawn.mockReturnValue(probe.child);
    const result = fetchCodexRpcQuota().catch((error: Error) => error);
    probe.stderr.emit("data", "x".repeat(128 * 1024));
    probe.stderr.emit("data", " end of diagnostic");
    probe.child.emit("exit", 1);
    const error = await result as Error;
    expect(error.message.length).toBeLessThanOrEqual(4_000);
    expect(error.message).toMatch(/end of diagnostic$/);
  });

  it("handles a broken stdin without an uncaught stream error", async () => {
    const probe = createRpcChild(() => undefined);
    mockSpawn.mockReturnValue(probe.child);
    const result = fetchCodexRpcQuota();
    probe.stdin.emit("error", new Error("write EPIPE"));
    await expect(result).rejects.toThrow("write EPIPE");
    expect(probe.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("clears other pending requests when a probe times out and kills a child that ignores SIGTERM", async () => {
    vi.useFakeTimers();
    const probe = createRpcChild((request) => request.method === "initialize"
      ? { id: request.id, result: {} }
      : undefined);
    probe.kill.mockImplementation((signal) => {
      if (signal === "SIGKILL") queueMicrotask(() => probe.child.emit("close", null));
      return true;
    });
    mockSpawn.mockReturnValue(probe.child);
    const result = fetchCodexRpcQuota();
    const rejected = expect(result).rejects.toThrow("timed out on account/rateLimits/read");
    await vi.advanceTimersByTimeAsync(6_000);
    expect(probe.stdin.end).toHaveBeenCalledOnce();
    expect(probe.kill.mock.calls).toEqual([["SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(250);
    await rejected;
    expect(probe.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(vi.getTimerCount()).toBe(0);
    expect(probe.child.listenerCount("close")).toBe(1);
  });

  it("bounds shutdown even if a killed child never emits close", async () => {
    vi.useFakeTimers();
    const probe = createRpcChild();
    probe.kill.mockImplementation(() => true);
    mockSpawn.mockReturnValue(probe.child);
    const result = fetchCodexRpcQuota();
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toMatchObject({ windows: [] });
    expect(probe.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(vi.getTimerCount()).toBe(0);
    expect(probe.child.listenerCount("close")).toBe(1);
  });

  it("reaps a real subprocess that ignores SIGTERM", async () => {
    const { spawn: spawnReal } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const child = spawnReal(process.execPath, ["--input-type=commonjs", "-e", `
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 60_000);
      require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        if (request.id == null) return;
        const result = request.method === "account/rateLimits/read"
          ? { rateLimits: { primary: { usedPercent: 37 } } }
          : {};
        process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
      });
    `], { stdio: ["pipe", "pipe", "pipe"] });
    mockSpawn.mockReturnValue(child);
    try {
      const result = await fetchCodexRpcQuota();
      expect(result.windows[0].usedPercent).toBe(37);
      expect(child.signalCode).toBe("SIGKILL");
      expect(child.stdin.destroyed).toBe(true);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  it("classifies app-server refresh-token failures as quota probe auth errors", async () => {
    mockSpawn.mockImplementation(() => createChildThatErrorsOnMicrotask(new Error("OAuth failed: refresh token has expired")));

    const result = await getQuotaWindows();

    expect(result.ok).toBe(false);
    expect(result.source).toBe("codex-rpc");
    expect(result.errorFamily).toBe("refresh_token_expired");
    expect(result.error).toContain("Codex app-server");
  });

  it("falls back to WHAM after an app-server refresh-token failure", async () => {
    fs.writeFileSync(
      path.join(isolatedCodexHome!, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: "access-token-fixture-secret",
          refresh_token: "refresh-token-fixture-secret",
        },
      }),
      "utf8",
    );
    mockSpawn.mockImplementation(() => createChildThatErrorsOnMicrotask(new Error("OAuth failed: refresh token has expired")));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 0.5, reset_at: 1_711_111_111 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )),
    );

    const result = await getQuotaWindows();

    expect(result.ok).toBe(true);
    expect(result.source).toBe("codex-wham");
    expect(result.errorFamily).toBeUndefined();
    expect(result.windows).toEqual([
      expect.objectContaining({
        label: "5h limit",
        usedPercent: 0.5,
        resetsAt: "2024-03-22T12:38:31.000Z",
      }),
    ]);
  });

  it("classifies WHAM refresh-token response bodies without returning the body text", async () => {
    fs.writeFileSync(
      path.join(isolatedCodexHome!, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: "access-token-fixture-secret",
          refresh_token: "refresh-token-fixture-secret",
        },
      }),
      "utf8",
    );
    mockSpawn.mockImplementation(() => createChildThatErrorsOnMicrotask(new Error("spawn codex ENOENT")));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("OAuth failed: invalid_grant", { status: 401 })),
    );

    const result = await getQuotaWindows();

    expect(result.ok).toBe(false);
    expect(result.source).toBe("codex-wham");
    expect(result.errorFamily).toBe("refresh_token_invalidated");
    expect(result.error).toContain("chatgpt wham api returned 401");
    expect(result.error).not.toContain("invalid_grant");
    expect(JSON.stringify(result)).not.toContain("access-token-fixture-secret");
    expect(JSON.stringify(result)).not.toContain("refresh-token-fixture-secret");
  });

  it("limits WHAM error response buffering before classifying auth failures", async () => {
    const encoder = new TextEncoder();
    const totalChunks = 20;
    let pullCount = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount > totalChunks) {
          controller.close();
          return;
        }
        const text =
          pullCount === 1
            ? `OAuth failed: invalid_grant ${"x".repeat(1_024)}`
            : "x".repeat(1_024);
        controller.enqueue(encoder.encode(text));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 401 })),
    );

    await expect(fetchCodexQuota("access-token-fixture-secret", null)).rejects.toMatchObject({
      name: "CodexQuotaAuthError",
      errorFamily: "refresh_token_invalidated",
    });
    expect(pullCount).toBeLessThan(totalChunks);
    expect(cancelled).toBe(true);
  });

  it("does not classify bare WHAM 401 quota probe failures or expose token material", async () => {
    fs.writeFileSync(
      path.join(isolatedCodexHome!, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: "access-token-fixture-secret",
          refresh_token: "refresh-token-fixture-secret",
        },
      }),
      "utf8",
    );
    mockSpawn.mockImplementation(() => createChildThatErrorsOnMicrotask(new Error("spawn codex ENOENT")));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );

    const result = await getQuotaWindows();

    expect(result.ok).toBe(false);
    expect(result.errorFamily).toBeUndefined();
    expect(result.error).toContain("chatgpt wham api returned 401");
    expect(JSON.stringify(result)).not.toContain("access-token-fixture-secret");
    expect(JSON.stringify(result)).not.toContain("refresh-token-fixture-secret");
  });

  it("does not crash the process when codex is missing; getQuotaWindows returns ok: false", async () => {
    const enoent = Object.assign(new Error("spawn codex ENOENT"), {
      code: "ENOENT",
      errno: -2,
      syscall: "spawn codex",
      path: "codex",
    });
    mockSpawn.mockImplementation(() => createChildThatErrorsOnMicrotask(enoent));

    const result = await getQuotaWindows();

    expect(result.ok).toBe(false);
    expect(result.windows).toEqual([]);
    expect(result.error).toContain("Codex app-server");
    expect(result.error).toContain("spawn codex ENOENT");
  });
});
