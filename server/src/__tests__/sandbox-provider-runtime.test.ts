import { describe, expect, it } from "vitest";

import {
  acquireSandboxProviderLease,
  findReusableSandboxProviderLeaseId,
  getSandboxProvider,
  listSandboxProviders,
  probeSandboxProvider,
  releaseSandboxProviderLease,
  sandboxConfigFromLeaseMetadata,
  sandboxConfigFromLeaseMetadataLoose,
  validateSandboxProviderConfig,
} from "../services/sandbox-provider-runtime.ts";

describe("sandbox provider runtime", () => {
  it("exposes fake as the built-in sandbox provider implementation", async () => {
    expect(listSandboxProviders().map((provider) => provider.provider).sort()).toEqual(["fake"]);
    expect(getSandboxProvider("fake")?.provider).toBe("fake");
    expect(getSandboxProvider("fake-plugin")).toBeNull();

    await expect(
      validateSandboxProviderConfig({
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        details: expect.objectContaining({
          provider: "fake",
          image: "ubuntu:24.04",
        }),
      }),
    );
  });

  it("does not route plugin-backed providers through the built-in provider helper", async () => {
    await expect(probeSandboxProvider({
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 300000,
      reuseLease: false,
    })).rejects.toThrow('Sandbox provider "fake-plugin" is not registered as a built-in provider.');
  });

  it("acquires and resumes fake leases deterministically", async () => {
    const lease = await acquireSandboxProviderLease({
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
      environmentId: "env-1",
      heartbeatRunId: "run-1",
      issueId: "issue-1",
    });

    expect(lease.providerLeaseId).toBe("sandbox://fake/env-1");
    expect(lease.metadata).toEqual(expect.objectContaining({
      provider: "fake",
      image: "ubuntu:24.04",
      reuseLease: true,
    }));

    const resumed = await acquireSandboxProviderLease({
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
      environmentId: "env-1",
      heartbeatRunId: "run-2",
      issueId: "issue-1",
      reusableProviderLeaseId: lease.providerLeaseId,
    });

    expect(resumed.providerLeaseId).toBe(lease.providerLeaseId);
    expect(resumed.metadata).toEqual(expect.objectContaining({ resumedLease: true }));
  });

  it("matches reusable fake leases through the selected provider implementation", () => {
    expect(
      findReusableSandboxProviderLeaseId({
        config: {
          provider: "fake",
          image: "image-b",
          reuseLease: true,
        },
        leases: [
          {
            providerLeaseId: "sandbox-image-a",
            metadata: {
              provider: "fake",
              image: "image-a",
              reuseLease: true,
            },
          },
          {
            providerLeaseId: "sandbox-image-b",
            metadata: {
              provider: "fake",
              image: "image-b",
              reuseLease: true,
            },
          },
        ],
      }),
    ).toBe("sandbox-image-b");
  });

  it("matches reusable plugin leases by persisted config fields", () => {
    expect(
      findReusableSandboxProviderLeaseId({
        config: {
          provider: "secure-plugin",
          template: "template-b",
          apiKey: "22222222-2222-2222-2222-222222222222",
          timeoutMs: 300000,
          reuseLease: true,
        },
        leases: [
          {
            providerLeaseId: "sandbox-template-a",
            metadata: {
              provider: "secure-plugin",
              template: "template-a",
              apiKey: "11111111-1111-1111-1111-111111111111",
              reuseLease: true,
            },
          },
          {
            providerLeaseId: "sandbox-template-b",
            metadata: {
              provider: "secure-plugin",
              template: "template-b",
              apiKey: "22222222-2222-2222-2222-222222222222",
              timeoutMs: 300000,
              reuseLease: true,
            },
          },
        ],
      }),
    ).toBe("sandbox-template-b");
  });

  it("reconstructs fake sandbox config from lease metadata for later release", () => {
    const metadata = {
      provider: "fake",
      image: "paperclip-test",
      reuseLease: true,
    };

    expect(sandboxConfigFromLeaseMetadata({ metadata })).toEqual({
      provider: "fake",
      image: "paperclip-test",
      reuseLease: true,
    });
    expect(sandboxConfigFromLeaseMetadataLoose({ metadata })).toEqual({
      provider: "fake",
      image: "paperclip-test",
      reuseLease: true,
    });
  });

  it("reconstructs plugin-backed sandbox config from lease metadata for runtime recovery", () => {
    const metadata = {
      provider: "fake-plugin",
      reuseLease: true,
      timeoutMs: 45_000,
      remoteCwd: "/workspace/project",
      fakeRootDir: "/tmp/fake-root",
    };

    expect(sandboxConfigFromLeaseMetadataLoose({ metadata })).toEqual({
      provider: "fake-plugin",
      reuseLease: true,
      timeoutMs: 45_000,
      remoteCwd: "/workspace/project",
      fakeRootDir: "/tmp/fake-root",
    });
  });

  it("reconstructs plugin-backed secret-ref config from lease metadata for later release", () => {
    expect(sandboxConfigFromLeaseMetadata({
      metadata: {
        provider: "secure-plugin",
        template: "paperclip-template",
      },
    })).toBeNull();

    expect(sandboxConfigFromLeaseMetadataLoose({
      metadata: {
        provider: "secure-plugin",
        template: "paperclip-template",
        timeoutMs: 120000,
        reuseLease: true,
        apiKey: "11111111-1111-1111-1111-111111111111",
      },
    })).toEqual({
      provider: "secure-plugin",
      template: "paperclip-template",
      apiKey: "11111111-1111-1111-1111-111111111111",
      timeoutMs: 120000,
      reuseLease: true,
    });
  });

  it("releases fake leases without external side effects", async () => {
    await expect(releaseSandboxProviderLease({
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
      providerLeaseId: "sandbox://fake/env-1",
      status: "released",
    })).resolves.toBeUndefined();
  });
});
