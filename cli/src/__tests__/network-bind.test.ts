import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeBind, validateConfiguredBindMode } from "@paperclipai/shared";

async function loadServerBindWithExecFileSync(mockImplementation: () => string): Promise<
  typeof import("../config/server-bind.js")
> {
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: vi.fn(mockImplementation),
  }));
  return import("../config/server-bind.js");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("node:child_process");
  delete process.env.PAPERCLIP_TAILNET_BIND_HOST;
});

describe("network bind helpers", () => {
  it("rejects non-loopback bind modes in local_trusted", () => {
    expect(
      validateConfiguredBindMode({
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        bind: "lan",
        host: "0.0.0.0",
      }),
    ).toContain("local_trusted requires server.bind=loopback");
  });

  it("resolves tailnet bind using the detected tailscale address", () => {
    const resolved = resolveRuntimeBind({
      bind: "tailnet",
      host: "127.0.0.1",
      tailnetBindHost: "100.64.0.8",
    });

    expect(resolved.errors).toEqual([]);
    expect(resolved.host).toBe("100.64.0.8");
  });

  it("requires a custom bind host when bind=custom", () => {
    const resolved = resolveRuntimeBind({
      bind: "custom",
      host: "127.0.0.1",
    });

    expect(resolved.errors).toContain("server.customBindHost is required when server.bind=custom");
  });

  it("stores the detected tailscale address for tailnet presets", async () => {
    const serverBind = await loadServerBindWithExecFileSync(() => "100.64.0.8\n");

    const preset = serverBind.buildPresetServerConfig("tailnet", {
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    });

    expect(preset.server.host).toBe("100.64.0.8");
  });

  it("falls back to loopback when no tailscale address is available for tailnet presets", async () => {
    const serverBind = await loadServerBindWithExecFileSync(() => {
      throw new Error("tailscale unavailable");
    });

    const preset = serverBind.buildPresetServerConfig("tailnet", {
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    });

    expect(preset.server.host).toBe("127.0.0.1");
  });
});
