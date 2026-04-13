import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeBind, validateConfiguredBindMode } from "@paperclipai/shared";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

import { buildPresetServerConfig } from "../config/server-bind.js";

describe("network bind helpers", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_TAILNET_BIND_HOST;
  });

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

  it("stores the detected tailscale address for tailnet presets", () => {
    process.env.PAPERCLIP_TAILNET_BIND_HOST = "100.64.0.8";

    const preset = buildPresetServerConfig("tailnet", {
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    });

    expect(preset.server.host).toBe("100.64.0.8");

    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("falls back to loopback when no tailscale address is available for tailnet presets", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("tailscale unavailable");
    });

    const preset = buildPresetServerConfig("tailnet", {
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    });

    expect(preset.server.host).toBe("127.0.0.1");
  });
});
