import { describe, expect, it } from "vitest";
import {
  isLoopbackHost,
  isAllInterfacesHost,
  inferBindModeFromHost,
  validateConfiguredBindMode,
  resolveRuntimeBind,
  LOOPBACK_BIND_HOST,
  ALL_INTERFACES_BIND_HOST,
} from "./network-bind.js";

// ============================================================================
// isLoopbackHost
// ============================================================================

describe("isLoopbackHost", () => {
  it("returns true for 127.0.0.1", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
  });

  it("returns true for localhost", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
  });

  it("returns true for ::1", () => {
    expect(isLoopbackHost("::1")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
  });

  it("returns false for 0.0.0.0", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });

  it("returns false for a custom host", () => {
    expect(isLoopbackHost("192.168.1.1")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isLoopbackHost(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isLoopbackHost(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isLoopbackHost("")).toBe(false);
  });

  it("trims whitespace before checking", () => {
    expect(isLoopbackHost("  localhost  ")).toBe(true);
  });
});

// ============================================================================
// isAllInterfacesHost
// ============================================================================

describe("isAllInterfacesHost", () => {
  it("returns true for 0.0.0.0", () => {
    expect(isAllInterfacesHost("0.0.0.0")).toBe(true);
  });

  it("returns true for ::", () => {
    expect(isAllInterfacesHost("::")).toBe(true);
  });

  it("returns false for localhost", () => {
    expect(isAllInterfacesHost("localhost")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isAllInterfacesHost(null)).toBe(false);
  });

  it("returns false for a custom host", () => {
    expect(isAllInterfacesHost("192.168.1.100")).toBe(false);
  });
});

// ============================================================================
// inferBindModeFromHost
// ============================================================================

describe("inferBindModeFromHost", () => {
  it("returns loopback for null", () => {
    expect(inferBindModeFromHost(null)).toBe("loopback");
  });

  it("returns loopback for undefined", () => {
    expect(inferBindModeFromHost(undefined)).toBe("loopback");
  });

  it("returns loopback for localhost", () => {
    expect(inferBindModeFromHost("localhost")).toBe("loopback");
  });

  it("returns loopback for 127.0.0.1", () => {
    expect(inferBindModeFromHost("127.0.0.1")).toBe("loopback");
  });

  it("returns lan for 0.0.0.0", () => {
    expect(inferBindModeFromHost("0.0.0.0")).toBe("lan");
  });

  it("returns tailnet when host matches tailnetBindHost", () => {
    expect(inferBindModeFromHost("100.64.0.1", { tailnetBindHost: "100.64.0.1" })).toBe("tailnet");
  });

  it("returns custom for unrecognized host", () => {
    expect(inferBindModeFromHost("192.168.1.50")).toBe("custom");
  });

  it("returns custom when tailnetBindHost differs from host", () => {
    expect(inferBindModeFromHost("192.168.1.50", { tailnetBindHost: "100.64.0.1" })).toBe("custom");
  });
});

// ============================================================================
// validateConfiguredBindMode
// ============================================================================

describe("validateConfiguredBindMode", () => {
  it("returns no errors for valid local_trusted+loopback", () => {
    const errors = validateConfiguredBindMode({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bind: "loopback",
    });
    expect(errors).toHaveLength(0);
  });

  it("returns error when local_trusted is combined with lan bind", () => {
    const errors = validateConfiguredBindMode({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bind: "lan",
    });
    expect(errors).toContain("local_trusted requires server.bind=loopback");
  });

  it("returns error when bind=custom but no customBindHost", () => {
    const errors = validateConfiguredBindMode({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bind: "custom",
    });
    expect(errors).toContain("server.customBindHost is required when server.bind=custom");
  });

  it("returns no errors when bind=custom and customBindHost provided", () => {
    const errors = validateConfiguredBindMode({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bind: "custom",
      customBindHost: "192.168.1.50",
    });
    expect(errors).toHaveLength(0);
  });

  it("returns error for tailnet+authenticated+public", () => {
    const errors = validateConfiguredBindMode({
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      bind: "tailnet",
    });
    expect(errors).toContain("server.bind=tailnet is only supported for authenticated/private deployments");
  });

  it("returns no errors for tailnet+authenticated+private", () => {
    const errors = validateConfiguredBindMode({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bind: "tailnet",
    });
    expect(errors).toHaveLength(0);
  });
});

// ============================================================================
// resolveRuntimeBind
// ============================================================================

describe("resolveRuntimeBind", () => {
  it("resolves loopback to 127.0.0.1", () => {
    const result = resolveRuntimeBind({ bind: "loopback" });
    expect(result.bind).toBe("loopback");
    expect(result.host).toBe(LOOPBACK_BIND_HOST);
    expect(result.errors).toHaveLength(0);
  });

  it("resolves lan to 0.0.0.0", () => {
    const result = resolveRuntimeBind({ bind: "lan" });
    expect(result.bind).toBe("lan");
    expect(result.host).toBe(ALL_INTERFACES_BIND_HOST);
    expect(result.errors).toHaveLength(0);
  });

  it("resolves custom with customBindHost", () => {
    const result = resolveRuntimeBind({ bind: "custom", customBindHost: "192.168.1.50" });
    expect(result.bind).toBe("custom");
    expect(result.host).toBe("192.168.1.50");
    expect(result.errors).toHaveLength(0);
  });

  it("resolves custom without customBindHost returns error", () => {
    const result = resolveRuntimeBind({ bind: "custom" });
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("resolves tailnet with tailnetBindHost", () => {
    const result = resolveRuntimeBind({ bind: "tailnet", tailnetBindHost: "100.64.0.1" });
    expect(result.bind).toBe("tailnet");
    expect(result.host).toBe("100.64.0.1");
    expect(result.errors).toHaveLength(0);
  });

  it("resolves tailnet without tailnetBindHost returns error", () => {
    const result = resolveRuntimeBind({ bind: "tailnet" });
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("infers bind mode from host when bind not provided", () => {
    const result = resolveRuntimeBind({ host: "0.0.0.0" });
    expect(result.bind).toBe("lan");
  });

  it("infers loopback from localhost", () => {
    const result = resolveRuntimeBind({ host: "localhost" });
    expect(result.bind).toBe("loopback");
    expect(result.host).toBe(LOOPBACK_BIND_HOST);
  });
});
