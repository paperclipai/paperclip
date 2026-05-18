import { describe, it, expect } from "vitest";
import plugin from "../../src/plugin.js";

describe("plugin", () => {
  it("exports the kubernetes driver", () => {
    expect(plugin.definition.onEnvironmentAcquireLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentValidateConfig).toBeTypeOf("function");
  });

  it("validateConfig accepts inCluster=true config", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true },
    });
    expect(result.ok).toBe(true);
  });

  it("validateConfig rejects missing auth", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: {},
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/requires one of `inCluster`/);
  });

  it("validateConfig normalizes defaults", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig).toEqual(
      expect.objectContaining({
        namespacePrefix: "paperclip-",
        egressMode: "standard",
        jobTtlSecondsAfterFinished: 900,
        podActivityDeadlineSec: 3600,
        adapterType: "claude_local",
        backend: "sandbox-cr", // new default
      }),
    );
  });

  it("validateConfig accepts backend=sandbox-cr explicitly", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true, backend: "sandbox-cr" },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig?.backend).toBe("sandbox-cr");
  });

  it("validateConfig accepts backend=job (stable fallback)", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true, backend: "job" },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig?.backend).toBe("job");
  });

  it("validateConfig rejects unknown backend value", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true, backend: "kata-fc" },
    });
    expect(result.ok).toBe(false);
  });

  it("onHealth returns ok", async () => {
    const result = await plugin.definition.onHealth!();
    expect(result.status).toBe("ok");
  });

  it("validateConfig warns about FQDN limitation in standard mode", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true, adapterType: "claude_local" },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.some((w) => w.includes("api.anthropic.com"))).toBe(true);
  });

  it("validateConfig does NOT warn when egressMode is cilium", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true, adapterType: "claude_local", egressMode: "cilium" },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toBeUndefined();
  });
});
