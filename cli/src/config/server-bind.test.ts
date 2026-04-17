import { afterEach, describe, expect, it, vi } from "vitest";
import { inferConfiguredBind, buildPresetServerConfig, buildCustomServerConfig } from "./server-bind.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const BASE_INPUT = {
  port: 3100,
  allowedHostnames: [],
  serveUi: true,
};

// ============================================================================
// inferConfiguredBind
// ============================================================================

describe("inferConfiguredBind", () => {
  it("returns the explicit bind when set", () => {
    expect(inferConfiguredBind({ bind: "lan" })).toBe("lan");
  });

  it("returns 'loopback' for localhost host", () => {
    expect(inferConfiguredBind({ host: "127.0.0.1" })).toBe("loopback");
  });

  it("returns 'lan' for 0.0.0.0 host", () => {
    expect(inferConfiguredBind({ host: "0.0.0.0" })).toBe("lan");
  });

  it("returns 'loopback' when no server config provided", () => {
    expect(inferConfiguredBind(undefined)).toBe("loopback");
  });

  it("returns 'loopback' for undefined host", () => {
    expect(inferConfiguredBind({})).toBe("loopback");
  });
});

// ============================================================================
// buildPresetServerConfig
// ============================================================================

describe("buildPresetServerConfig", () => {
  it("builds loopback config with local_trusted deployment mode", () => {
    const { server, auth } = buildPresetServerConfig("loopback", BASE_INPUT);
    expect(server.bind).toBe("loopback");
    expect(server.host).toBe("127.0.0.1");
    expect(server.deploymentMode).toBe("local_trusted");
    expect(server.port).toBe(3100);
    expect(auth.baseUrlMode).toBe("auto");
  });

  it("builds lan config with authenticated deployment mode", () => {
    const { server, auth } = buildPresetServerConfig("lan", BASE_INPUT);
    expect(server.bind).toBe("lan");
    expect(server.host).toBe("0.0.0.0");
    expect(server.deploymentMode).toBe("authenticated");
    expect(auth.disableSignUp).toBe(false);
  });

  it("sets serveUi and allowedHostnames from input", () => {
    const input = { port: 4000, allowedHostnames: ["example.com"], serveUi: false };
    const { server } = buildPresetServerConfig("loopback", input);
    expect(server.serveUi).toBe(false);
    expect(server.allowedHostnames).toEqual(["example.com"]);
    expect(server.port).toBe(4000);
  });
});

// ============================================================================
// buildCustomServerConfig
// ============================================================================

describe("buildCustomServerConfig", () => {
  it("uses 'loopback' bind for 127.0.0.1 host", () => {
    const { server } = buildCustomServerConfig({
      ...BASE_INPUT,
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
    });
    expect(server.bind).toBe("loopback");
    expect(server.customBindHost).toBeUndefined();
  });

  it("uses 'lan' bind for 0.0.0.0 host", () => {
    const { server } = buildCustomServerConfig({
      ...BASE_INPUT,
      deploymentMode: "authenticated",
      exposure: "private",
      host: "0.0.0.0",
    });
    expect(server.bind).toBe("lan");
  });

  it("uses 'custom' bind for a non-standard host", () => {
    const { server } = buildCustomServerConfig({
      ...BASE_INPUT,
      deploymentMode: "authenticated",
      exposure: "private",
      host: "192.168.1.50",
    });
    expect(server.bind).toBe("custom");
    expect(server.customBindHost).toBe("192.168.1.50");
  });

  it("sets explicit publicBaseUrl when authenticated+public", () => {
    const { auth } = buildCustomServerConfig({
      ...BASE_INPUT,
      deploymentMode: "authenticated",
      exposure: "public",
      host: "0.0.0.0",
      publicBaseUrl: "https://app.example.com",
    });
    expect(auth.baseUrlMode).toBe("explicit");
    if (auth.baseUrlMode === "explicit") {
      expect(auth.publicBaseUrl).toBe("https://app.example.com");
    }
  });

  it("forces exposure to 'private' when deploymentMode is local_trusted", () => {
    const { server } = buildCustomServerConfig({
      ...BASE_INPUT,
      deploymentMode: "local_trusted",
      exposure: "public",
      host: "127.0.0.1",
    });
    expect(server.exposure).toBe("private");
  });

  it("trims whitespace from the host", () => {
    const { server } = buildCustomServerConfig({
      ...BASE_INPUT,
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "  127.0.0.1  ",
    });
    expect(server.host).toBe("127.0.0.1");
  });
});
