import { describe, it, expect } from "vitest";
import {
  openshellProviderConfigSchema,
  parseOpenShellProviderConfig,
} from "../../src/types.js";

describe("openshellProviderConfigSchema", () => {
  it("parses minimal valid config", () => {
    const result = openshellProviderConfigSchema.safeParse({
      gatewayEndpoint: "openshell.openshell.svc:8080",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gatewayEndpoint).toBe(
        "openshell.openshell.svc:8080"
      );
      expect(result.data.useTls).toBe(true);
      expect(result.data.gpu).toBe(false);
      expect(result.data.gpuCount).toBe(1);
      expect(result.data.timeoutSeconds).toBe(3600);
      expect(result.data.workspacePath).toBe("/workspace");
      expect(result.data.labels).toEqual({});
      expect(result.data.sandboxImage).toBe(
        "ghcr.io/nvidia/openshell-community/sandboxes/base:latest"
      );
    }
  });

  it("parses full config", () => {
    const result = openshellProviderConfigSchema.safeParse({
      gatewayEndpoint: "gw.prod:443",
      useTls: true,
      caCert: "-----BEGIN CERTIFICATE-----\nfoo\n-----END CERTIFICATE-----",
      sandboxImage: "custom-registry/sandbox:v2",
      workspacePath: "/data/work",
      gpu: true,
      gpuCount: 4,
      timeoutSeconds: 7200,
      labels: { env: "staging", team: "platform" },
      defaultPolicy: { version: 1, filesystem: { readWrite: ["/workspace"] } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.useTls).toBe(true);
      expect(result.data.gpu).toBe(true);
      expect(result.data.gpuCount).toBe(4);
      expect(result.data.timeoutSeconds).toBe(7200);
      expect(result.data.labels).toEqual({ env: "staging", team: "platform" });
    }
  });

  it("rejects missing gatewayEndpoint", () => {
    const result = openshellProviderConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects empty gatewayEndpoint", () => {
    const result = openshellProviderConfigSchema.safeParse({
      gatewayEndpoint: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects timeoutSeconds below minimum", () => {
    const result = openshellProviderConfigSchema.safeParse({
      gatewayEndpoint: "gw:8080",
      timeoutSeconds: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects gpuCount below minimum", () => {
    const result = openshellProviderConfigSchema.safeParse({
      gatewayEndpoint: "gw:8080",
      gpuCount: 0,
    });
    expect(result.success).toBe(false);
  });

  it("accepts extra unknown fields and strips them", () => {
    const result = openshellProviderConfigSchema.safeParse({
      gatewayEndpoint: "gw:8080",
      unknownField: "ignored",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect("unknownField" in result.data).toBe(false);
    }
  });
});

describe("parseOpenShellProviderConfig", () => {
  it("returns parsed config", () => {
    const config = parseOpenShellProviderConfig({
      gatewayEndpoint: "gw:8080",
    });
    expect(config.gatewayEndpoint).toBe("gw:8080");
    expect(config.useTls).toBe(true);
  });

  it("throws on invalid input", () => {
    expect(() => parseOpenShellProviderConfig({})).toThrow();
  });
});
