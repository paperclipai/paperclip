import { describe, expect, it } from "vitest";
import {
  ALL_INTERFACES_BIND_HOST,
  LOOPBACK_BIND_HOST,
  inferBindModeFromHost,
  isAllInterfacesHost,
  isLoopbackHost,
  resolveRuntimeBind,
  validateConfiguredBindMode,
} from "./network-bind.js";

describe("isLoopbackHost", () => {
  it("recognizes loopback hosts case-insensitively and with padding", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("LocalHost")).toBe(true);
    expect(isLoopbackHost("  ::1  ")).toBe(true);
  });

  it("rejects other hosts and empty input", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});

describe("isAllInterfacesHost", () => {
  it("recognizes 0.0.0.0 and ::", () => {
    expect(isAllInterfacesHost("0.0.0.0")).toBe(true);
    expect(isAllInterfacesHost(" :: ")).toBe(true);
  });

  it("rejects loopback, specific hosts, and empty input", () => {
    expect(isAllInterfacesHost("127.0.0.1")).toBe(false);
    expect(isAllInterfacesHost("192.168.1.10")).toBe(false);
    expect(isAllInterfacesHost(null)).toBe(false);
  });
});

describe("inferBindModeFromHost", () => {
  it("defaults to loopback for empty or loopback hosts", () => {
    expect(inferBindModeFromHost(undefined)).toBe("loopback");
    expect(inferBindModeFromHost("   ")).toBe("loopback");
    expect(inferBindModeFromHost("localhost")).toBe("loopback");
  });

  it("maps all-interfaces hosts to lan", () => {
    expect(inferBindModeFromHost("0.0.0.0")).toBe("lan");
    expect(inferBindModeFromHost("::")).toBe("lan");
  });

  it("maps the detected tailnet host to tailnet", () => {
    expect(inferBindModeFromHost("100.64.0.7", { tailnetBindHost: "100.64.0.7" })).toBe("tailnet");
  });

  it("treats any other host as custom", () => {
    expect(inferBindModeFromHost("192.168.1.10")).toBe("custom");
    expect(inferBindModeFromHost("100.64.0.7", { tailnetBindHost: "100.64.0.8" })).toBe("custom");
  });
});

describe("validateConfiguredBindMode", () => {
  it("accepts the default local_trusted loopback configuration", () => {
    expect(
      validateConfiguredBindMode({ deploymentMode: "local_trusted", deploymentExposure: "private" }),
    ).toEqual([]);
  });

  it("rejects non-loopback bind for local_trusted", () => {
    const errors = validateConfiguredBindMode({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bind: "lan",
    });
    expect(errors).toEqual(["local_trusted requires server.bind=loopback"]);
  });

  it("infers bind from the legacy host when bind is omitted", () => {
    const errors = validateConfiguredBindMode({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      host: "0.0.0.0",
    });
    expect(errors).toEqual(["local_trusted requires server.bind=loopback"]);
  });

  it("requires customBindHost for bind=custom without a usable legacy host", () => {
    const errors = validateConfiguredBindMode({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bind: "custom",
    });
    expect(errors).toEqual(["server.customBindHost is required when server.bind=custom"]);
  });

  it("accepts bind=custom when a non-loopback legacy host stands in for customBindHost", () => {
    const errors = validateConfiguredBindMode({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bind: "custom",
      host: "192.168.1.10",
    });
    expect(errors).toEqual([]);
  });

  it("rejects tailnet bind for authenticated public deployments", () => {
    const errors = validateConfiguredBindMode({
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      bind: "tailnet",
    });
    expect(errors).toEqual(["server.bind=tailnet is only supported for authenticated/private deployments"]);
  });

  it("allows tailnet bind for authenticated private deployments", () => {
    const errors = validateConfiguredBindMode({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bind: "tailnet",
    });
    expect(errors).toEqual([]);
  });
});

describe("resolveRuntimeBind", () => {
  it("resolves loopback by default with no input", () => {
    expect(resolveRuntimeBind({})).toEqual({
      bind: "loopback",
      host: LOOPBACK_BIND_HOST,
      customBindHost: undefined,
      errors: [],
    });
  });

  it("resolves lan to the all-interfaces host", () => {
    const resolved = resolveRuntimeBind({ bind: "lan" });
    expect(resolved.bind).toBe("lan");
    expect(resolved.host).toBe(ALL_INTERFACES_BIND_HOST);
    expect(resolved.errors).toEqual([]);
  });

  it("resolves custom with an explicit customBindHost", () => {
    const resolved = resolveRuntimeBind({ bind: "custom", customBindHost: " 192.168.1.10 " });
    expect(resolved).toEqual({
      bind: "custom",
      host: "192.168.1.10",
      customBindHost: "192.168.1.10",
      errors: [],
    });
  });

  it("promotes a legacy non-loopback host into customBindHost", () => {
    const resolved = resolveRuntimeBind({ host: "192.168.1.10" });
    expect(resolved.bind).toBe("custom");
    expect(resolved.host).toBe("192.168.1.10");
    expect(resolved.customBindHost).toBe("192.168.1.10");
    expect(resolved.errors).toEqual([]);
  });

  it("reports an error and falls back to loopback for custom without any host", () => {
    const resolved = resolveRuntimeBind({ bind: "custom" });
    expect(resolved.bind).toBe("custom");
    expect(resolved.host).toBe(LOOPBACK_BIND_HOST);
    expect(resolved.errors).toEqual(["server.customBindHost is required when server.bind=custom"]);
  });

  it("resolves tailnet to the detected tailnet host", () => {
    const resolved = resolveRuntimeBind({ bind: "tailnet", tailnetBindHost: "100.64.0.7" });
    expect(resolved.bind).toBe("tailnet");
    expect(resolved.host).toBe("100.64.0.7");
    expect(resolved.errors).toEqual([]);
  });

  it("reports an error when tailnet is requested but no tailnet host exists", () => {
    const resolved = resolveRuntimeBind({ bind: "tailnet" });
    expect(resolved.bind).toBe("tailnet");
    expect(resolved.host).toBe(LOOPBACK_BIND_HOST);
    expect(resolved.errors).toEqual([
      "server.bind=tailnet requires a detected Tailscale address or PAPERCLIP_TAILNET_BIND_HOST",
    ]);
  });

  it("infers tailnet from the host when it matches the detected tailnet address", () => {
    const resolved = resolveRuntimeBind({ host: "100.64.0.7", tailnetBindHost: "100.64.0.7" });
    expect(resolved.bind).toBe("tailnet");
    expect(resolved.host).toBe("100.64.0.7");
    expect(resolved.errors).toEqual([]);
  });
});
