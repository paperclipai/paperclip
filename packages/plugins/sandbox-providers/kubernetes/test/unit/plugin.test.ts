import { describe, it, expect } from "vitest";
import plugin, {
  buildSandboxExecShellCommand,
  extractAdapterEnvFromProcess,
} from "../../src/plugin.js";

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
        paperclipServerNamespace: "paperclip",
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

  it("warns when adapter env keys are missing from the worker process", () => {
    const warnMessages: string[] = [];
    const originalPresent = process.env.PAPERCLIP_TEST_PRESENT_KEY;
    const originalMissing = process.env.PAPERCLIP_TEST_MISSING_KEY;
    process.env.PAPERCLIP_TEST_PRESENT_KEY = "secret-value";
    delete process.env.PAPERCLIP_TEST_MISSING_KEY;
    try {
      const result = extractAdapterEnvFromProcess(
        ["PAPERCLIP_TEST_PRESENT_KEY", "PAPERCLIP_TEST_MISSING_KEY"],
        (message) => warnMessages.push(message),
      );
      expect(result).toEqual({ PAPERCLIP_TEST_PRESENT_KEY: "secret-value" });
      expect(warnMessages).toHaveLength(1);
      expect(warnMessages[0]).toContain("PAPERCLIP_TEST_MISSING_KEY");
      expect(warnMessages[0]).not.toContain("secret-value");
    } finally {
      if (originalPresent === undefined) {
        delete process.env.PAPERCLIP_TEST_PRESENT_KEY;
      } else {
        process.env.PAPERCLIP_TEST_PRESENT_KEY = originalPresent;
      }
      if (originalMissing === undefined) {
        delete process.env.PAPERCLIP_TEST_MISSING_KEY;
      } else {
        process.env.PAPERCLIP_TEST_MISSING_KEY = originalMissing;
      }
    }
  });

  it("preserves intentionally empty adapter env values", () => {
    const warnMessages: string[] = [];
    const originalValue = process.env.PAPERCLIP_TEST_EMPTY_KEY;
    process.env.PAPERCLIP_TEST_EMPTY_KEY = "";
    try {
      const result = extractAdapterEnvFromProcess(
        ["PAPERCLIP_TEST_EMPTY_KEY"],
        (message) => warnMessages.push(message),
      );
      expect(result).toEqual({ PAPERCLIP_TEST_EMPTY_KEY: "" });
      expect(warnMessages).toHaveLength(0);
    } finally {
      if (originalValue === undefined) {
        delete process.env.PAPERCLIP_TEST_EMPTY_KEY;
      } else {
        process.env.PAPERCLIP_TEST_EMPTY_KEY = originalValue;
      }
    }
  });

  it("quotes args before passing them to /bin/sh -lc", () => {
    expect(
      buildSandboxExecShellCommand({
        args: ["git", "commit", "-m", "feat: add feature", "it's ready"],
      }),
    ).toBe("'git' 'commit' '-m' 'feat: add feature' 'it'\\''s ready'");
  });

  it("uses command verbatim when command is provided", () => {
    expect(
      buildSandboxExecShellCommand({
        command: "pnpm test -- --runInBand",
        args: ["ignored"],
      }),
    ).toBe("pnpm test -- --runInBand");
  });
});
