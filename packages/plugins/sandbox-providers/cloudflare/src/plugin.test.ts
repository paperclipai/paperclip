import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
let plugin: typeof import("./plugin.js").default;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestInitAt(index = 0): RequestInit {
  return fetchMock.mock.calls[index]?.[1] as RequestInit;
}

function requestHeadersAt(index = 0): Headers {
  return requestInitAt(index).headers as Headers;
}

function requestBodyAt(index = 0): Record<string, unknown> {
  return JSON.parse(String(requestInitAt(index).body ?? "{}")) as Record<string, unknown>;
}

describe("Cloudflare sandbox provider plugin", () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    plugin = (await import("./plugin.js")).default;
  });

  it("declares the Cloudflare environment lifecycle handlers", async () => {
    expect(await plugin.definition.onHealth?.()).toEqual({
      status: "ok",
      message: "Cloudflare sandbox provider plugin healthy",
    });
    expect(plugin.definition.onEnvironmentAcquireLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentExecute).toBeTypeOf("function");
  });

  it("normalizes and validates Cloudflare config", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "cloudflare",
      config: {
        bridgeBaseUrl: " https://bridge.example.workers.dev/ ",
        bridgeAuthToken: " secret-ref://bridge-token ",
        reuseLease: true,
        keepAlive: true,
        normalizeId: false,
        requestedCwd: " /workspace/custom ",
        sessionStrategy: "default",
        timeoutMs: "450000.9",
        bridgeRequestTimeoutMs: "40000.1",
      },
    });

    expect(result).toEqual({
      ok: true,
      normalizedConfig: {
        bridgeBaseUrl: "https://bridge.example.workers.dev/",
        bridgeAuthToken: "secret-ref://bridge-token",
        reuseLease: true,
        keepAlive: true,
        sleepAfter: "10m",
        normalizeId: false,
        requestedCwd: "/workspace/custom",
        sessionStrategy: "default",
        sessionId: "paperclip",
        timeoutMs: 450000,
        bridgeRequestTimeoutMs: 40000,
        previewHostname: null,
      },
    });
  });

  it("rejects insecure or contradictory config", async () => {
    await expect(plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "cloudflare",
      config: {
        bridgeBaseUrl: "http://bridge.example.workers.dev",
        bridgeAuthToken: "secret-ref://bridge-token",
        reuseLease: true,
        keepAlive: false,
        requestedCwd: "workspace/not-absolute",
      },
    })).resolves.toEqual({
      ok: false,
      errors: [
        "bridgeBaseUrl must use HTTPS unless it points at localhost.",
        "reuseLease requires keepAlive for Cloudflare sandboxes.",
        "requestedCwd must be an absolute POSIX path.",
      ],
    });
  });

  it("maps acquire lease responses from the bridge", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        providerLeaseId: "pc-run-1-abcd1234",
        metadata: {
          provider: "cloudflare",
          remoteCwd: "/workspace/paperclip",
          resumedLease: false,
        },
      }),
    );

    const lease = await plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      issueId: "issue-1",
      runId: "run-1",
      requestedCwd: "/workspace/paperclip",
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    });

    expect(lease).toEqual({
      providerLeaseId: "pc-run-1-abcd1234",
      metadata: {
        provider: "cloudflare",
        remoteCwd: "/workspace/paperclip",
        resumedLease: false,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://bridge.example.workers.dev/api/paperclip-sandbox/v1/leases/acquire",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
      }),
    );
    expect(requestHeadersAt().get("X-Paperclip-Run-Id")).toBe("run-1");
    expect(requestHeadersAt().get("X-Paperclip-Environment-Id")).toBe("env-1");
    expect(requestHeadersAt().get("X-Paperclip-Issue-Id")).toBe("issue-1");
    expect(requestBodyAt()).toMatchObject({
      environmentId: "env-1",
      runId: "run-1",
      issueId: "issue-1",
      requestedCwd: "/workspace/paperclip",
    });
  });

  it("returns expired lease semantics when resume reports lost state", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: "sandbox_state_lost",
          message: "Cloudflare sandbox state is no longer available.",
        },
        409,
      ),
    );

    const lease = await plugin.definition.onEnvironmentResumeLease?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "pc-env-env-1",
      leaseMetadata: { remoteCwd: "/workspace/paperclip" },
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    });

    expect(lease).toEqual({
      providerLeaseId: null,
      metadata: {
        provider: "cloudflare",
        expired: true,
      },
    });
  });

  it("passes bridge execute results through unchanged", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "/workspace/paperclip\n",
        stderr: "",
      }),
    );

    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      lease: { providerLeaseId: "pc-run-1-abcd1234", metadata: {} },
      command: "pwd",
      args: [],
      cwd: "/workspace/paperclip",
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    });

    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "/workspace/paperclip\n",
      stderr: "",
    });
  });

  it("routes bridge-channel execute calls through a dedicated session", async () => {
    // pluginLogger must be set for the streaming branch to be reachable, so
    // we can assert that bridge-channel calls take the non-streaming path
    // even when adapter sessions would otherwise stream.
    await plugin.definition.setup?.({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    } as never);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok\n",
        stderr: "",
      }),
    );

    await plugin.definition.onEnvironmentExecute?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      lease: { providerLeaseId: "pc-run-1-abcd1234", metadata: {} },
      command: "sh",
      args: ["-lc", "ls"],
      cwd: "/workspace/paperclip",
      env: {
        PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge",
        KEEP_ME: "visible",
      },
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
        sessionStrategy: "default",
        sessionId: "paperclip",
      },
    });

    expect(requestBodyAt()).toMatchObject({
      sessionStrategy: "named",
      sessionId: "paperclip-bridge",
      env: {
        KEEP_ME: "visible",
      },
    });
    expect(requestBodyAt().env).not.toHaveProperty("PAPERCLIP_SANDBOX_EXEC_CHANNEL");
    // Bridge-channel commands must use the non-streaming exec path. The
    // @cloudflare/sandbox SDK's streaming mode can drop the final stdout
    // chunk when a short shell exits the same tick it writes — bridge ops
    // carry machine-consumed stdout (readiness JSON, base64 file payloads,
    // queue response bodies) where that data loss surfaces as opaque
    // "invalid readiness JSON" / "Invalid bridge request payload" errors.
    expect(requestBodyAt().streamOutput).toBe(false);
  });

  it("uses streaming exec for non-bridge adapter commands so live logs flow", async () => {
    // Streaming is gated on `pluginLogger` being set, which normally happens
    // in `setup()`. Wire a minimal logger so the streaming branch is reachable.
    await plugin.definition.setup?.({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    } as never);
    fetchMock.mockResolvedValueOnce(
      new Response(
        "event: stdout\ndata: {\"data\":\"hello\\n\"}\n\nevent: complete\ndata: {\"exitCode\":0,\"signal\":null,\"timedOut\":false,\"stdout\":\"hello\\n\",\"stderr\":\"\"}\n\n",
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      ),
    );

    await plugin.definition.onEnvironmentExecute?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      lease: { providerLeaseId: "pc-run-1-abcd1234", metadata: {} },
      command: "echo",
      args: ["hello"],
      cwd: "/workspace/paperclip",
      env: { KEEP_ME: "visible" },
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
        sessionStrategy: "named",
        sessionId: "paperclip",
      },
    });

    expect(requestBodyAt().streamOutput).toBe(true);
  });

  it("maps lost-lease execute errors into a deterministic command failure", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: "sandbox_state_lost",
          message: "Cloudflare sandbox state is no longer available.",
        },
        409,
      ),
    );

    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      lease: { providerLeaseId: "pc-run-1-abcd1234", metadata: {} },
      command: "pwd",
      args: [],
      cwd: "/workspace/paperclip",
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    });

    expect(result).toEqual({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Cloudflare sandbox state is no longer available.\n",
    });
  });

  it("wraps realizeWorkspace bridge failures and forwards the issue header", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: "command_failed",
          message: "mkdir: permission denied",
        },
        500,
      ),
    );

    await expect(plugin.definition.onEnvironmentRealizeWorkspace?.({
      driverKey: "cloudflare",
      companyId: "company-1",
      environmentId: "env-1",
      issueId: "issue-1",
      lease: {
        providerLeaseId: "pc-run-1-abcd1234",
        metadata: { remoteCwd: "/workspace/paperclip" },
      },
      workspace: {
        localPath: "/tmp/project",
        metadata: {
          workspaceRealizationRequest: {
            issueId: "issue-1",
          },
        },
      },
      config: {
        bridgeBaseUrl: "https://bridge.example.workers.dev",
        bridgeAuthToken: "resolved-token",
      },
    })).rejects.toThrow("Failed to prepare Cloudflare sandbox workspace at /workspace/paperclip: mkdir: permission denied");

    expect(requestHeadersAt().get("X-Paperclip-Issue-Id")).toBe("issue-1");
  });
});
