import { describe, it, expect } from "vitest";
import plugin from "../../src/plugin.js";
import manifest from "../../src/manifest.js";

describe("plugin", () => {
  it("advertises login PTY only with all four worker hooks", () => {
    expect(manifest.environmentDrivers?.[0]?.supportsLoginPty).toBe(true);
    expect(plugin.definition.onLoginPtyOpen).toBeTypeOf("function");
    expect(plugin.definition.onLoginPtyInput).toBeTypeOf("function");
    expect(plugin.definition.onLoginPtyStop).toBeTypeOf("function");
    expect(plugin.definition.onLoginPtyClose).toBeTypeOf("function");
  });
  it("does not offer the non-PTY job backend in the manifest schema", () => {
    const properties = manifest.environmentDrivers?.[0]?.configSchema?.properties as Record<string, any>;
    expect(properties.backend.enum).toEqual(["sandbox-cr"]);
    expect(properties.paperclipServerPodSelector.additionalProperties).toEqual({ type: "string" });
  });
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

  it("validateConfig retains a custom server callback selector", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true, paperclipServerPodSelector: { app: "paperclip" } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig?.paperclipServerPodSelector).toEqual({ app: "paperclip" });
  });

  it("validateConfig rejects backend=job while the driver advertises login PTY", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true, backend: "job" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toMatch(/job.*login PTY|login PTY.*job/i);
  });

  it("validateConfig rejects a selector key that is not a Kubernetes label key", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true, paperclipServerPodSelector: { "bad key": "paperclip" } },
    });
    expect(result.ok).toBe(false);
  });

  it("acquire fails closed for a legacy job lease with a requested deadline, before touching the cluster", async () => {
    await expect(
      plugin.definition.onEnvironmentAcquireLease!({
        driverKey: "kubernetes",
        companyId: "11111111-1111-1111-1111-111111111111",
        environmentId: "env-1",
        runId: "run-1",
        config: { inCluster: true, backend: "job" },
        requestedExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      } as never),
    ).rejects.toThrow(/job backend cannot honor a requested lease deadline/);
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

  // Defining both hooks is what makes the worker advertise the
  // `environmentSyncIn`/`environmentSyncOut` verbs; the host runner then flips
  // K8s to native single-exec transfer. Absent them, the base64 fallback stays.
  it("defines the opt-in native file-sync hooks", () => {
    expect(plugin.definition.onEnvironmentSyncIn).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentSyncOut).toBeTypeOf("function");
  });

  it("file sync fails loud when the lease carries no workspace remote dir", async () => {
    await expect(
      plugin.definition.onEnvironmentSyncIn!({
        driverKey: "kubernetes",
        companyId: "co",
        environmentId: "env",
        config: { inCluster: true },
        lease: { providerLeaseId: "lease-1", metadata: {} },
        operations: [],
      }),
    ).rejects.toThrow(/workspace remote dir/);
  });

  it("file sync rejects the job backend (out of scope; sandbox-cr only)", async () => {
    await expect(
      plugin.definition.onEnvironmentSyncOut!({
        driverKey: "kubernetes",
        companyId: "co",
        environmentId: "env",
        config: { inCluster: true },
        lease: {
          providerLeaseId: "lease-1",
          metadata: { remoteCwd: "/workspace", backend: "job", namespace: "paperclip-co" },
        },
        operations: [],
      }),
    ).rejects.toThrow(/only supported on the sandbox-cr backend/);
  });
});
