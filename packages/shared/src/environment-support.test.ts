import { describe, expect, it } from "vitest";
import {
  adapterSupportsRemoteManagedEnvironments,
  getEnvironmentCapabilities,
  isSandboxProviderSupportedForAdapter,
  supportedEnvironmentDriversForAdapter,
} from "./environment-support.js";

describe("isSandboxProviderSupportedForAdapter", () => {
  it("accepts additional sandbox providers for remote-managed adapters", () => {
    expect(
      isSandboxProviderSupportedForAdapter("codex_local", "fake-plugin", ["fake-plugin"]),
    ).toBe(true);
  });

  it("rejects providers for adapters without remote-managed environment support", () => {
    expect(
      isSandboxProviderSupportedForAdapter("openclaw", "fake-plugin", ["fake-plugin"]),
    ).toBe(false);
  });

  it("keeps copilot_local on local execution until remote Copilot home provisioning is supported", () => {
    expect(adapterSupportsRemoteManagedEnvironments("copilot_local")).toBe(false);
    expect(supportedEnvironmentDriversForAdapter("copilot_local")).toEqual(["local"]);
  });

  it("treats grok_local as a remote-managed local adapter", () => {
    expect(adapterSupportsRemoteManagedEnvironments("grok_local")).toBe(true);
    expect(supportedEnvironmentDriversForAdapter("grok_local")).toEqual(["local", "ssh", "sandbox"]);
    expect(
      isSandboxProviderSupportedForAdapter("grok_local", "fake-plugin", ["fake-plugin"]),
    ).toBe(true);
  });

  it("includes grok_local sandbox support in environment capabilities", () => {
    const capabilities = getEnvironmentCapabilities(["grok_local"], {
      sandboxProviders: {
        "fake-plugin": { displayName: "Fake Plugin" },
      },
    });

    expect(capabilities.adapters).toEqual([
      expect.objectContaining({
        adapterType: "grok_local",
        drivers: expect.objectContaining({ sandbox: "supported", ssh: "supported" }),
        sandboxProviders: expect.objectContaining({ "fake-plugin": "supported" }),
      }),
    ]);
  });
});
