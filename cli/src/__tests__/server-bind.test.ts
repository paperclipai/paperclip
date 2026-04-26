import { describe, it, expect } from "vitest";
import { LOOPBACK_BIND_HOST, ALL_INTERFACES_BIND_HOST } from "@paperclipai/shared";
import {
  inferConfiguredBind,
  buildPresetServerConfig,
  buildCustomServerConfig,
  resolveQuickstartServerConfig,
} from "../config/server-bind.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_INPUT = {
  port: 3000,
  allowedHostnames: ["localhost"],
  serveUi: true,
};

// ---------------------------------------------------------------------------
// inferConfiguredBind
// ---------------------------------------------------------------------------

describe("inferConfiguredBind", () => {
  it("returns the explicit bind mode when server.bind is set", () => {
    expect(inferConfiguredBind({ bind: "loopback" })).toBe("loopback");
    expect(inferConfiguredBind({ bind: "lan" })).toBe("lan");
  });

  it("infers loopback when server.host is 127.0.0.1", () => {
    expect(inferConfiguredBind({ host: "127.0.0.1" })).toBe("loopback");
  });

  it("infers lan when server.host is 0.0.0.0", () => {
    expect(inferConfiguredBind({ host: "0.0.0.0" })).toBe("lan");
  });

  it("returns loopback when server is undefined", () => {
    expect(inferConfiguredBind(undefined)).toBe("loopback");
  });

  it("returns loopback when server is empty", () => {
    expect(inferConfiguredBind({})).toBe("loopback");
  });
});

// ---------------------------------------------------------------------------
// buildPresetServerConfig
// ---------------------------------------------------------------------------

describe("buildPresetServerConfig", () => {
  it("sets host to 127.0.0.1 for loopback bind", () => {
    const { server } = buildPresetServerConfig("loopback", BASE_INPUT);
    expect(server.host).toBe(LOOPBACK_BIND_HOST);
  });

  it("sets deploymentMode to local_trusted for loopback bind", () => {
    const { server } = buildPresetServerConfig("loopback", BASE_INPUT);
    expect(server.deploymentMode).toBe("local_trusted");
  });

  it("sets host to 0.0.0.0 for lan bind", () => {
    const { server } = buildPresetServerConfig("lan", BASE_INPUT);
    expect(server.host).toBe(ALL_INTERFACES_BIND_HOST);
  });

  it("sets deploymentMode to authenticated for lan bind", () => {
    const { server } = buildPresetServerConfig("lan", BASE_INPUT);
    expect(server.deploymentMode).toBe("authenticated");
  });

  it("preserves the port from input", () => {
    const { server } = buildPresetServerConfig("loopback", BASE_INPUT);
    expect(server.port).toBe(3000);
  });

  it("preserves the allowedHostnames from input", () => {
    const { server } = buildPresetServerConfig("loopback", BASE_INPUT);
    expect(server.allowedHostnames).toEqual(["localhost"]);
  });

  it("sets auth baseUrlMode to auto for preset configs", () => {
    const { auth } = buildPresetServerConfig("loopback", BASE_INPUT);
    expect(auth.baseUrlMode).toBe("auto");
  });

  it("sets bind field to the input bind mode", () => {
    const { server } = buildPresetServerConfig("lan", BASE_INPUT);
    expect(server.bind).toBe("lan");
  });

  it("sets exposure to private", () => {
    const { server } = buildPresetServerConfig("loopback", BASE_INPUT);
    expect(server.exposure).toBe("private");
  });
});

// ---------------------------------------------------------------------------
// buildCustomServerConfig
// ---------------------------------------------------------------------------

describe("buildCustomServerConfig", () => {
  it("sets bind to loopback when host is 127.0.0.1", () => {
    const { server } = buildCustomServerConfig({
      ...BASE_INPUT,
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
    });
    expect(server.bind).toBe("loopback");
  });

  it("sets bind to lan when host is 0.0.0.0", () => {
    const { server } = buildCustomServerConfig({
      ...BASE_INPUT,
      deploymentMode: "authenticated",
      exposure: "private",
      host: "0.0.0.0",
    });
    expect(server.bind).toBe("lan");
  });

  it("sets bind to custom for a non-standard host", () => {
    const { server } = buildCustomServerConfig({
      ...BASE_INPUT,
      deploymentMode: "authenticated",
      exposure: "private",
      host: "192.168.1.5",
    });
    expect(server.bind).toBe("custom");
    expect(server.customBindHost).toBe("192.168.1.5");
  });

  it("sets customBindHost to undefined for standard hosts", () => {
    const { server } = buildCustomServerConfig({
      ...BASE_INPUT,
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
    });
    expect(server.customBindHost).toBeUndefined();
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

  it("sets auth baseUrlMode to explicit when authenticated + public", () => {
    const { auth } = buildCustomServerConfig({
      ...BASE_INPUT,
      deploymentMode: "authenticated",
      exposure: "public",
      host: "0.0.0.0",
      publicBaseUrl: "https://app.example.com",
    });
    expect(auth.baseUrlMode).toBe("explicit");
    expect(auth.publicBaseUrl).toBe("https://app.example.com");
  });

  it("sets auth baseUrlMode to auto for local_trusted configs", () => {
    const { auth } = buildCustomServerConfig({
      ...BASE_INPUT,
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
    });
    expect(auth.baseUrlMode).toBe("auto");
  });

  it("overrides exposure to private for local_trusted even if private passed", () => {
    const { server } = buildCustomServerConfig({
      ...BASE_INPUT,
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
    });
    expect(server.exposure).toBe("private");
  });
});

// ---------------------------------------------------------------------------
// resolveQuickstartServerConfig
// ---------------------------------------------------------------------------

describe("resolveQuickstartServerConfig", () => {
  it("uses loopback preset when bind=loopback is explicit", () => {
    const { server } = resolveQuickstartServerConfig({ ...BASE_INPUT, bind: "loopback" });
    expect(server.bind).toBe("loopback");
    expect(server.host).toBe(LOOPBACK_BIND_HOST);
  });

  it("uses lan preset when bind=lan is explicit", () => {
    const { server } = resolveQuickstartServerConfig({ ...BASE_INPUT, bind: "lan" });
    expect(server.bind).toBe("lan");
    expect(server.host).toBe(ALL_INTERFACES_BIND_HOST);
  });

  it("falls back to loopback when no bind or host is specified", () => {
    const { server } = resolveQuickstartServerConfig(BASE_INPUT);
    expect(server.bind).toBe("loopback");
  });

  it("infers from the host when host is provided but bind is not", () => {
    const { server } = resolveQuickstartServerConfig({ ...BASE_INPUT, host: "0.0.0.0" });
    expect(server.bind).toBe("lan");
  });

  it("uses lan preset for authenticated + private deployments without host", () => {
    const { server } = resolveQuickstartServerConfig({
      ...BASE_INPUT,
      deploymentMode: "authenticated",
      exposure: "private",
    });
    expect(server.bind).toBe("lan");
  });

  it("uses lan with 0.0.0.0 for authenticated + public deployments without host", () => {
    const { server } = resolveQuickstartServerConfig({
      ...BASE_INPUT,
      deploymentMode: "authenticated",
      exposure: "public",
    });
    expect(server.host).toBe(ALL_INTERFACES_BIND_HOST);
  });

  it("uses custom bind when bind=custom is explicit", () => {
    const { server } = resolveQuickstartServerConfig({
      ...BASE_INPUT,
      bind: "custom",
      host: "192.168.1.5",
    });
    expect(server.bind).toBe("custom");
    expect(server.customBindHost).toBe("192.168.1.5");
  });

  it("preserves the port", () => {
    const { server } = resolveQuickstartServerConfig({ ...BASE_INPUT, port: 9999 });
    expect(server.port).toBe(9999);
  });
});
