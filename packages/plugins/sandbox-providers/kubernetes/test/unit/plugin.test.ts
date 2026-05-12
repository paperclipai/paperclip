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
      }),
    );
  });

  it("onHealth returns ok", async () => {
    const result = await plugin.definition.onHealth!();
    expect(result.status).toBe("ok");
  });
});
