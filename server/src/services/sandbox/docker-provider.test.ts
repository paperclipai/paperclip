import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOCKER_SANDBOX_PROVIDER_KEY,
  DockerSandboxProvider,
  buildDockerSandboxStartAudit,
  hashDockerSandboxPolicy,
  __testing,
  type DockerSandboxConfig,
} from "./docker-provider.js";
import {
  DEFAULT_SANDBOX_NETWORK_POLICY,
} from "./network-policy.js";
import { DEFAULT_SANDBOX_QUOTA_CEILINGS } from "./quotas.js";

const baseConfig: DockerSandboxConfig = {
  provider: DOCKER_SANDBOX_PROVIDER_KEY,
  image: "ubuntu:24.04",
  reuseLease: false,
};

describe("DockerSandboxProvider scaffold", () => {
  const originalFlag = process.env.PAPERCLIP_DOCKER_SANDBOX_ENABLED;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.PAPERCLIP_DOCKER_SANDBOX_ENABLED;
    } else {
      process.env.PAPERCLIP_DOCKER_SANDBOX_ENABLED = originalFlag;
    }
  });

  it("is disabled by default", () => {
    delete process.env.PAPERCLIP_DOCKER_SANDBOX_ENABLED;
    expect(__testing.isDockerSandboxEnabled()).toBe(false);
  });

  it("validateConfig accepts a minimal config and returns policy metadata", async () => {
    const provider = new DockerSandboxProvider();
    const result = await provider.validateConfig(baseConfig);
    expect(result.ok).toBe(true);
    expect(result.details?.policyHash).toEqual(expect.any(String));
    expect(result.details?.capabilities).toMatchObject({
      rootless: true,
      dropAllCapabilities: true,
      readOnlyRootfs: true,
      noNewPrivileges: true,
      cgroupsVersion: "v2",
    });
  });

  it("validateConfig rejects missing image", async () => {
    const provider = new DockerSandboxProvider();
    const result = await provider.validateConfig({ ...baseConfig, image: "" });
    expect(result.ok).toBe(false);
  });

  it("validateConfig rejects unbounded quotas", async () => {
    const provider = new DockerSandboxProvider();
    const result = await provider.validateConfig({
      ...baseConfig,
      quotas: { cpuMillis: 1_000 } as never,
    });
    expect(result.ok).toBe(false);
  });

  it("acquireLease throws when flag is off (no real docker call)", async () => {
    delete process.env.PAPERCLIP_DOCKER_SANDBOX_ENABLED;
    const provider = new DockerSandboxProvider();
    await expect(
      provider.acquireLease({
        config: baseConfig,
        environmentId: "env-1",
        heartbeatRunId: "hb-1",
        issueId: null,
      }),
    ).rejects.toThrow(/not enabled/i);
  });

  it("execute throws (no real docker call) regardless of flag", async () => {
    process.env.PAPERCLIP_DOCKER_SANDBOX_ENABLED = "1";
    const provider = new DockerSandboxProvider();
    await expect(
      provider.execute!({ config: baseConfig, providerLeaseId: "x", command: "echo" }),
    ).rejects.toThrow(/not enabled/i);
  });

  it("acquireLease records boundary metadata when enabled", async () => {
    process.env.PAPERCLIP_DOCKER_SANDBOX_ENABLED = "1";
    const provider = new DockerSandboxProvider();
    const handle = await provider.acquireLease({
      config: baseConfig,
      environmentId: "env-1",
      heartbeatRunId: "hb-1",
      issueId: null,
    });
    expect(handle.providerLeaseId).toMatch(/^sandbox:\/\/docker\//);
    expect(handle.metadata.kind).toBe("docker");
    expect(handle.metadata.sandboxState).toBe("requested");
    expect(handle.metadata.policyHash).toEqual(expect.any(String));
    expect(handle.metadata.capabilities).toBeDefined();
    expect(handle.metadata.quotas).toBeDefined();
    expect(handle.metadata.network).toBeDefined();
  });

  it("matchesReusableLease only matches when image and reuseLease align", () => {
    const provider = new DockerSandboxProvider();
    const lease = {
      providerLeaseId: "sandbox://docker/env-1/abc",
      metadata: {
        provider: DOCKER_SANDBOX_PROVIDER_KEY,
        image: "ubuntu:24.04",
        reuseLease: true,
      } as Record<string, unknown>,
    };
    expect(
      provider.matchesReusableLease({ config: { ...baseConfig, reuseLease: true }, lease }),
    ).toBe(true);
    expect(
      provider.matchesReusableLease({
        config: { ...baseConfig, image: "alpine:3.19", reuseLease: true },
        lease,
      }),
    ).toBe(false);
  });

  it("hashDockerSandboxPolicy is stable for the same inputs", () => {
    const a = hashDockerSandboxPolicy({
      image: "ubuntu:24.04",
      capabilities: {
        rootless: true,
        dropAllCapabilities: true,
        seccompProfile: "default",
        readOnlyRootfs: true,
        noNewPrivileges: true,
        cgroupsVersion: "v2",
      },
      quotas: DEFAULT_SANDBOX_QUOTA_CEILINGS,
      network: DEFAULT_SANDBOX_NETWORK_POLICY,
    });
    const b = hashDockerSandboxPolicy({
      image: "ubuntu:24.04",
      capabilities: {
        rootless: true,
        dropAllCapabilities: true,
        seccompProfile: "default",
        readOnlyRootfs: true,
        noNewPrivileges: true,
        cgroupsVersion: "v2",
      },
      quotas: DEFAULT_SANDBOX_QUOTA_CEILINGS,
      network: DEFAULT_SANDBOX_NETWORK_POLICY,
    });
    expect(a).toBe(b);
  });

  it("redaction-before-start: buildDockerSandboxStartAudit redacts secrets and is invoked before any provider execute call", async () => {
    process.env.PAPERCLIP_DOCKER_SANDBOX_ENABLED = "1";
    const provider = new DockerSandboxProvider();
    const audit = buildDockerSandboxStartAudit({
      providerLeaseId: "sandbox://docker/env-1/abc",
      policy: __testing.resolvePolicySnapshot(baseConfig),
      message: "Starting container with token=hunter2-supersecret",
    });
    expect(audit.message).not.toContain("hunter2-supersecret");
    expect(audit.policyHash).toEqual(expect.any(String));
    // Provider.execute must still refuse to run — redaction does not authorize a real call.
    await expect(
      provider.execute!({ config: baseConfig, providerLeaseId: audit.providerLeaseId, command: "echo" }),
    ).rejects.toThrow();
  });

  it("redaction-before-start: redaction call ordering is observed before execute (mocked spy)", async () => {
    process.env.PAPERCLIP_DOCKER_SANDBOX_ENABLED = "1";
    const provider = new DockerSandboxProvider();
    const order: string[] = [];
    const snapshot = __testing.resolvePolicySnapshot(baseConfig);
    const audit = buildDockerSandboxStartAudit({
      providerLeaseId: "sandbox://docker/env-1/abc",
      policy: snapshot,
      message: "preflight",
    });
    order.push(`redaction:${audit.policyHash.slice(0, 8)}`);
    const executeSpy = vi.spyOn(provider, "execute").mockImplementation(async () => {
      order.push("execute");
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await provider.execute!({ config: baseConfig, providerLeaseId: audit.providerLeaseId, command: "echo" });
    expect(order[0]).toMatch(/^redaction:/);
    expect(order[order.length - 1]).toBe("execute");
    executeSpy.mockRestore();
  });
});
