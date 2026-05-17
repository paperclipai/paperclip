import { describe, expect, it } from "vitest";

import {
  NULL_SANDBOX_PROVIDER_KEY,
  NullSandboxProvider,
  acquireSandboxProviderLease,
  findReusableSandboxProviderLeaseId,
  getSandboxProvider,
  listSandboxProviderDescriptors,
  listSandboxProviders,
  probeSandboxProvider,
  releaseSandboxProviderLease,
  sandboxConfigFromLeaseMetadata,
  sandboxConfigFromLeaseMetadataLoose,
  sandboxProviderStatusMap,
  validateSandboxProviderConfig,
} from "../services/sandbox-provider-runtime.ts";

describe("sandbox provider runtime", () => {
  it("exposes built-in providers through the provider interface", () => {
    expect(listSandboxProviders().map((provider) => provider.provider).sort()).toEqual([
      "docker",
      "fake",
      "null",
    ]);
    expect(getSandboxProvider(NULL_SANDBOX_PROVIDER_KEY)).toBeInstanceOf(NullSandboxProvider);
    expect(getSandboxProvider("e2b")).toBeNull();
    expect(getSandboxProvider("daytona")).toBeNull();
    expect(getSandboxProvider("fake-plugin")).toBeNull();

    const descriptors = listSandboxProviderDescriptors();
    expect(descriptors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "null", kind: "builtin", enabled: false, previewOnly: true }),
        expect.objectContaining({ provider: "docker", kind: "builtin", previewOnly: true }),
      ]),
    );
    expect(descriptors.find((descriptor) => descriptor.provider === "null")?.capabilities).toMatchObject({
      lease: true,
      exec: false,
      readLogs: true,
      streamEvents: true,
    });
    expect(descriptors.find((descriptor) => descriptor.provider === "null")?.secretInjection).toMatchObject({
      mode: "none",
      acceptsRawSecrets: false,
    });
    expect(sandboxProviderStatusMap().has("docker")).toBe(true);
  });

  it("validates and probes null provider configs without external side effects", async () => {
    await expect(
      validateSandboxProviderConfig({ provider: "null", reuseLease: true }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        summary: expect.stringContaining("Null sandbox provider"),
        issues: [],
        details: expect.objectContaining({ provider: "null", noOp: true }),
      }),
    );

    await expect(
      probeSandboxProvider({ provider: "null", reuseLease: true }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        driver: "sandbox",
        details: expect.objectContaining({ provider: "null", noOp: true }),
      }),
    );
  });

  it("implements the null provider lease/log/event/cleanup contract", async () => {
    const provider = getSandboxProvider("null");
    expect(provider).toBeTruthy();

    const handle = await acquireSandboxProviderLease({
      config: { provider: "null", reuseLease: true },
      environmentId: "env-1",
      heartbeatRunId: "run-1",
      issueId: "issue-1",
    });

    expect(handle).toEqual(expect.objectContaining({
      providerLeaseId: "sandbox://null/env-1",
      metadata: expect.objectContaining({ provider: "null", previewOnly: true, noOp: true }),
    }));

    await expect(provider!.start({ lease: handle })).resolves.toBe(handle);
    await expect(provider!.readLogs({ providerLeaseId: handle.providerLeaseId })).resolves.toEqual({
      lines: [],
      nextCursor: null,
      truncated: false,
    });

    const events: unknown[] = [];
    for await (const event of provider!.streamEvents({ providerLeaseId: handle.providerLeaseId })) {
      events.push(event);
    }
    expect(events).toEqual([]);

    await expect(releaseSandboxProviderLease({
      config: { provider: "null", reuseLease: true },
      providerLeaseId: handle.providerLeaseId,
      status: "released",
    })).resolves.toBeUndefined();
    await expect(provider!.destroy({ providerLeaseId: handle.providerLeaseId })).resolves.toBeUndefined();
  });

  it("keeps null provider exec unsupported and categorized", async () => {
    const provider = getSandboxProvider("null");
    await expect(
      provider!.exec({
        config: { provider: "null", reuseLease: true },
        providerLeaseId: "sandbox://null/env-1",
        command: "echo",
        args: ["hi"],
      }),
    ).rejects.toMatchObject({ code: "EXEC_UNSUPPORTED" });
  });

  it("honors cancellation with a categorized provider error", async () => {
    const provider = getSandboxProvider("null");
    const controller = new AbortController();
    controller.abort();

    await expect(provider!.exec({
      config: { provider: "null", reuseLease: true },
      providerLeaseId: "sandbox://null/env-1",
      command: "echo",
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("matches and reconstructs null reusable leases through the selected provider", () => {
    const metadata = { provider: "null", reuseLease: true, sandboxState: "requested", kind: "null" };
    expect(findReusableSandboxProviderLeaseId({
      config: { provider: "null", reuseLease: true },
      leases: [{ providerLeaseId: "sandbox://null/env-1", metadata }],
    })).toBe("sandbox://null/env-1");
    expect(sandboxConfigFromLeaseMetadata({ metadata })).toEqual({ provider: "null", reuseLease: true });
    expect(sandboxConfigFromLeaseMetadataLoose({ metadata })).toEqual({ provider: "null", reuseLease: true });
  });

  it("keeps plugin-backed reusable lease matching outside the built-in provider registry", () => {
    const pluginConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 300000,
      reuseLease: true,
    };
    const metadata = {
      provider: pluginConfig.provider,
      image: pluginConfig.image,
      timeoutMs: pluginConfig.timeoutMs,
      reuseLease: true,
    };

    expect(getSandboxProvider(pluginConfig.provider)).toBeNull();
    expect(findReusableSandboxProviderLeaseId({
      config: pluginConfig,
      leases: [{ providerLeaseId: "sandbox://plugin/env-1", metadata }],
    })).toBe("sandbox://plugin/env-1");
    expect(findReusableSandboxProviderLeaseId({
      config: { ...pluginConfig, image: "other:test" },
      leases: [{ providerLeaseId: "sandbox://plugin/env-1", metadata }],
    })).toBeNull();
    expect(sandboxConfigFromLeaseMetadata({ metadata })).toBeNull();
    expect(sandboxConfigFromLeaseMetadataLoose({ metadata })).toEqual(pluginConfig);
  });

  it("does not route plugin-backed providers through the built-in provider helpers", async () => {
    await expect(probeSandboxProvider({
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 300000,
      reuseLease: false,
    })).rejects.toThrow('Sandbox provider "fake-plugin" is not registered as a built-in provider.');
  });
});
