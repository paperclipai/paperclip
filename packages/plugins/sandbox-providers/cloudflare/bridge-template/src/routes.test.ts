import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: vi.fn(),
}));

import { handleBridgeRequest } from "./routes.js";
import { resolveSandbox } from "./sandboxes.js";

vi.mock("./sandboxes.js", async () => {
  const actual = await vi.importActual<typeof import("./sandboxes.js")>("./sandboxes.js");
  return {
    ...actual,
    resolveSandbox: vi.fn(),
  };
});

function bridgeRequest(pathname: string, body: unknown): Request {
  return new Request(`https://bridge.example.test${pathname}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("bridge routes", () => {
  beforeEach(() => {
    vi.mocked(resolveSandbox).mockReset();
  });

  it("writes lease sentinels through the named-session exec target", async () => {
    const sessionExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const sandbox = {
      getSession: vi.fn().mockResolvedValue({ exec: sessionExec }),
      createSession: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", {
        environmentId: "env-1",
        runId: "run-1",
        requestedCwd: "/workspace/paperclip",
        sessionStrategy: "named",
        sessionId: "paperclip",
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(200);
    // Sentinel write must NOT use sandbox.writeFile (sandbox-level race);
    // it goes through the same session as the mkdir.
    expect(sandbox.writeFile).not.toHaveBeenCalled();

    // Both calls use a single command string — the SDK's exec API ignores
    // any `args` or `stdin` option, so the bridge folds them into the
    // command line itself.
    expect(sessionExec).toHaveBeenCalledTimes(2);
    for (const call of sessionExec.mock.calls) {
      const [commandArg, optionsArg] = call;
      expect(typeof commandArg).toBe("string");
      expect(commandArg).toMatch(/^sh -lc /);
      expect(optionsArg).toEqual({ cwd: "/", timeout: expect.any(Number) });
      expect(optionsArg).not.toHaveProperty("args");
      expect(optionsArg).not.toHaveProperty("stdin");
    }
    expect(sessionExec.mock.calls[0]?.[0]).toContain("mkdir");
    expect(sessionExec.mock.calls[0]?.[0]).toContain("/workspace/paperclip");
    expect(sessionExec.mock.calls[1]?.[0]).toContain("/workspace/paperclip/.paperclip-lease.json");
  });

  it("checks lease sentinels through the named-session exec target on resume", async () => {
    const sessionExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const sandbox = {
      getSession: vi.fn().mockResolvedValue({ exec: sessionExec }),
      createSession: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/resume", {
        providerLeaseId: "pc-run-1-abcd1234",
        requestedCwd: "/workspace/paperclip",
        sessionStrategy: "named",
        sessionId: "paperclip",
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(200);
    for (const call of sandbox.readFile.mock.calls) {
      expect(String(call[0])).toMatch(/^\/tmp\/\.paperclip-bridge-(out|err)-/);
      expect(call[1]).toMatchObject({ encoding: "base64", sessionId: "paperclip" });
    }
    const [commandArg, optionsArg] = sessionExec.mock.calls[0] ?? [];
    expect(typeof commandArg).toBe("string");
    expect(commandArg).toMatch(/^sh -lc /);
    expect(commandArg).toContain("test -s");
    expect(commandArg).toContain("/workspace/paperclip/.paperclip-lease.json");
    expect(optionsArg).toEqual({ cwd: "/", timeout: expect.any(Number) });
    expect(optionsArg).not.toHaveProperty("args");
  });

  it("streams exec stdout and completion metadata when requested", async () => {
    const sessionExec = vi.fn().mockImplementation(async (_command, options) => {
      await options?.onOutput?.("stdout", "hello\n");
      return { exitCode: 0, stdout: "hello\n", stderr: "" };
    });
    const sandbox = {
      getSession: vi.fn().mockResolvedValue({ exec: sessionExec }),
      createSession: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/exec", {
        providerLeaseId: "pc-run-1-abcd1234",
        command: "echo",
        args: ["hello"],
        sessionStrategy: "named",
        sessionId: "paperclip",
        streamOutput: true,
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("event: stdout");
    expect(body).toContain("event: complete");
    expect(vi.mocked(resolveSandbox)).toHaveBeenCalledWith(expect.anything(), "pc-run-1-abcd1234", { normalizeId: true });
  });

  it("release and destroy return 502 when teardown keeps failing", async () => {
    const destroy = vi.fn().mockRejectedValue(new Error("Durable Object is overloaded. Requests queued for too long."));
    vi.mocked(resolveSandbox).mockResolvedValue({ destroy } as never);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const env = { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never };
      const releasing = handleBridgeRequest(
        bridgeRequest("/api/paperclip-sandbox/v1/leases/release", { providerLeaseId: "pc-run-1-abcd1234" }),
        env,
      );
      const release = await releasing;
      expect(release.status).toBe(502);
      await expect(release.json()).resolves.toMatchObject({
        error: "sandbox_destroy_failed",
        details: { providerLeaseId: "pc-run-1-abcd1234", attempts: 3 },
      });

      const destroying = handleBridgeRequest(
        new Request("https://bridge.example.test/api/paperclip-sandbox/v1/leases/pc-run-1-abcd1234", {
          method: "DELETE",
          headers: { Authorization: "Bearer secret-token" },
        }),
        env,
      );
      expect((await destroying).status).toBe(502);
      expect(destroy).toHaveBeenCalledTimes(6);
    } finally {
      log.mockRestore();
    }
  }, 15_000);

  it("release and destroy resolve the sandbox without lease-config overrides", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    vi.mocked(resolveSandbox).mockResolvedValue({ destroy } as never);
    const env = { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never };

    const release = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/release", { providerLeaseId: "pc-run-1-abcd1234", keepAlive: true }),
      env,
    );
    expect(release.status).toBe(200);
    expect(vi.mocked(resolveSandbox)).toHaveBeenLastCalledWith(expect.anything(), "pc-run-1-abcd1234", { normalizeId: true });

    const destroyed = await handleBridgeRequest(
      new Request("https://bridge.example.test/api/paperclip-sandbox/v1/leases/pc-run-1-abcd1234", {
        method: "DELETE",
        headers: { Authorization: "Bearer secret-token" },
      }),
      env,
    );
    expect(destroyed.status).toBe(200);
    expect(vi.mocked(resolveSandbox)).toHaveBeenLastCalledWith(expect.anything(), "pc-run-1-abcd1234", { normalizeId: true });
    expect(destroy).toHaveBeenCalledTimes(2);
  });
});
