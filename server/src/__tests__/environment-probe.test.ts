import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnsureSshWorkspaceReady = vi.hoisted(() => vi.fn());
const mockProbePluginEnvironmentDriver = vi.hoisted(() => vi.fn());
const mockProbePluginSandboxProviderDriver = vi.hoisted(() => vi.fn());
const mockResolvePluginSandboxProviderDriverByKey = vi.hoisted(() => vi.fn());
const mockRuntimeAcquireRunLease = vi.hoisted(() => vi.fn());
const mockRuntimeReleaseRunLease = vi.hoisted(() => vi.fn());
const mockRuntimeExecute = vi.hoisted(() => vi.fn());
const mockRecordPlatformProbe = vi.hoisted(() => vi.fn());
const mockEnvironmentRuntimeService = vi.hoisted(() => vi.fn(() => ({
  acquireRunLease: mockRuntimeAcquireRunLease,
  execute: mockRuntimeExecute,
  getDriver: vi.fn(() => ({
    releaseRunLease: mockRuntimeReleaseRunLease,
  })),
})));
vi.mock("../services/environments.js", () => ({ environmentService: () => ({ recordSandboxPlatformProbe: mockRecordPlatformProbe }) }));

vi.mock("@paperclipai/adapter-utils/ssh", () => ({
  ensureSshWorkspaceReady: mockEnsureSshWorkspaceReady,
}));

vi.mock("../services/plugin-environment-driver.js", () => ({
  probePluginEnvironmentDriver: mockProbePluginEnvironmentDriver,
  probePluginSandboxProviderDriver: mockProbePluginSandboxProviderDriver,
  resolvePluginSandboxProviderDriverByKey: mockResolvePluginSandboxProviderDriverByKey,
  resolvePluginSandboxProviderConfigSchema: async (input: { db: unknown; driverKey: string }) =>
    (await mockResolvePluginSandboxProviderDriverByKey(input))?.driver?.configSchema ?? null,
}));

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: mockEnvironmentRuntimeService,
}));

import { probeEnvironment, readSandboxPlatformQualification, SANDBOX_PLATFORM_PROBE_COMMAND } from "../services/environment-probe.ts";
import * as configRuntime from "../services/environment-config.js";
import { SANDBOX_PLATFORM_PROBE_METADATA_KEY, resolveActiveEnvironmentCustomImageTemplateForRuntime } from "../services/environment-custom-image-runtime.js";

describe("probeEnvironment", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockRecordPlatformProbe.mockReset().mockResolvedValue(true);
    mockRuntimeExecute.mockReset();
    mockEnsureSshWorkspaceReady.mockReset();
    mockProbePluginEnvironmentDriver.mockReset();
    mockProbePluginSandboxProviderDriver.mockReset();
    mockResolvePluginSandboxProviderDriverByKey.mockReset();
    mockResolvePluginSandboxProviderDriverByKey.mockResolvedValue(null);
    mockRuntimeAcquireRunLease.mockReset();
    mockRuntimeReleaseRunLease.mockReset().mockResolvedValue({ id: "lease", companyId: "company", environmentId: "env", status: "released", cleanupStatus: "success" });
    mockEnvironmentRuntimeService.mockClear();
  });

  it("qualifies a named Daytona snapshot only after an ID-pinned lease and owned cleanup", async () => {
    const environment = { id: "env", driver: "sandbox", status: "active", config: { provider: "daytona", snapshot: "managed-snapshot" }, metadata: null } as any;
    const identity = { provider: "daytona", requestedRef: "managed-snapshot", id: "a6b9e7d0-f886-471a-b461-640dd03e8d0f", name: "managed-snapshot", organizationId: "provider-account", createdAt: "2026-10-07T23:19:57.133Z" };
    vi.spyOn(configRuntime, "resolveEnvironmentDriverConfigForRuntime").mockResolvedValue({ driver: "sandbox", config: environment.config });
    mockRuntimeAcquireRunLease.mockResolvedValue({ lease: { id: "lease", provider: "daytona", metadata: { snapshot: "managed-snapshot", snapshotIdentity: identity } } });
    mockRuntimeExecute.mockResolvedValue({ exitCode: 0, stdout: "Linux\nx86_64\nglibc\nglibc 2.39\n" });
    const result = await probeEnvironment({} as any, environment, { companyId: "company", acquireSandboxRuntimeLease: true, assertCompanyBinding: true });
    expect(result.details?.platformQualificationRecorded).toBe(true);
    expect(mockRuntimeAcquireRunLease).toHaveBeenCalledWith(expect.objectContaining({ resolveSnapshotIdentity: true, assertCompanyBinding: true }));
    const proof = mockRecordPlatformProbe.mock.calls[1]![0].proof;
    expect(proof).toMatchObject({ v: 2, snapshotIdentity: identity });
    environment.metadata = { [SANDBOX_PLATFORM_PROBE_METADATA_KEY]: { company: proof } };
    expect(await readSandboxPlatformQualification({} as any, environment, "company")).toMatchObject({ platform: "linux", architecture: "x64", glibcVersion: "glibc 2.39" });
    expect(await readSandboxPlatformQualification({} as any, environment, "foreign-company")).toBeNull();
    expect(mockRuntimeAcquireRunLease).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "wrong-reference", "missing-owner", "cleanup"])("does not qualify a named snapshot after %s", async failure => {
    const environment = { id: "env", driver: "sandbox", status: "active", config: { provider: "daytona", snapshot: "managed-snapshot" } } as any;
    const identity = { provider: "daytona", requestedRef: failure === "wrong-reference" ? "other" : "managed-snapshot", id: "a6b9e7d0-f886-471a-b461-640dd03e8d0f", name: "managed-snapshot", organizationId: failure === "missing-owner" ? "" : "provider-account", createdAt: "2026-10-07T23:19:57.133Z" };
    vi.spyOn(configRuntime, "resolveEnvironmentDriverConfigForRuntime").mockResolvedValue({ driver: "sandbox", config: environment.config });
    mockRuntimeAcquireRunLease.mockResolvedValue({ lease: { id: "lease", provider: "daytona", metadata: { snapshot: "managed-snapshot", ...(failure === "missing" ? {} : { snapshotIdentity: identity }) } } });
    mockRuntimeExecute.mockResolvedValue({ exitCode: 0, stdout: "Linux\nx86_64\nglibc\nglibc 2.39\n" });
    if (failure === "cleanup") mockRuntimeReleaseRunLease.mockResolvedValue({ id: "lease", companyId: "company", environmentId: "env", status: "released", cleanupStatus: "failed" });
    const result = await probeEnvironment({} as any, environment, { companyId: "company", acquireSandboxRuntimeLease: true });
    expect(result.details?.platformQualificationRecorded).toBe(false);
    expect(mockRecordPlatformProbe).toHaveBeenCalledTimes(1);
  });

  it.each(["2.38", "2.39", "musl"])("records actual immutable-image facts for %s and reads them without another lease", async libc => {
    const image = `registry.example.test/runtime@sha256:${"a".repeat(64)}`;
    const environment = { id: "env", driver: "sandbox", status: "active", config: { provider: "daytona", image, reuseLease: false }, metadata: null } as any;
    vi.spyOn(configRuntime, "resolveEnvironmentDriverConfigForRuntime").mockResolvedValue({ driver: "sandbox", config: environment.config });
    mockRuntimeAcquireRunLease.mockResolvedValue({ lease: { id: "lease", provider: "daytona", metadata: { image, remoteCwd: "/workspace" } } });
    mockRuntimeExecute.mockResolvedValue({ exitCode: 0, stdout: `Linux\naarch64\n${libc === "musl" ? "musl" : `glibc\nglibc ${libc}`}\n` });
    const result = await probeEnvironment({} as any, environment, { companyId: "company", acquireSandboxRuntimeLease: true });
    expect(result.ok).toBe(true);
    expect(result.details?.platformQualificationRecorded).toBe(true);
    expect(mockRuntimeExecute).toHaveBeenCalledWith(expect.objectContaining({ command: "sh", args: ["-c", SANDBOX_PLATFORM_PROBE_COMMAND], timeoutMs: 10_000, bypassSession: true }));
    const proof = mockRecordPlatformProbe.mock.calls[1]![0].proof;
    const measured = { platform: "linux", architecture: "arm64", libc: libc === "musl" ? "musl" : "glibc", ...(libc === "musl" ? {} : { glibcVersion: `glibc ${libc}` }) };
    expect(proof.facts).toEqual(measured);
    environment.metadata = { [SANDBOX_PLATFORM_PROBE_METADATA_KEY]: { company: proof } };
    expect(await readSandboxPlatformQualification({} as any, environment, "company")).toEqual(measured);
    expect(mockRuntimeAcquireRunLease).toHaveBeenCalledTimes(1);
    expect(await readSandboxPlatformQualification({} as any, environment, "foreign-company")).toBeNull();
    expect(await readSandboxPlatformQualification({} as any, { ...environment, config: { ...environment.config, image: `registry.example.test/runtime@sha256:${"b".repeat(64)}` } }, "company")).toBeNull();
    vi.mocked(configRuntime.resolveEnvironmentDriverConfigForRuntime).mockImplementation(async (_db, _company, _env, options) => {
      options?.onResolvedCustomImageTemplate?.({ id: "changed-template", capturedAt: null, templateKind: "image", bindingField: "image" });
      return { driver: "sandbox", config: environment.config };
    });
    expect(await readSandboxPlatformQualification({} as any, environment, "company")).toBeNull();
    expect(mockRuntimeAcquireRunLease).toHaveBeenCalledTimes(1);
  });
  it.each(["measurement", "cleanup", "config-race"])("does not claim qualification after %s failure while retaining connection readiness", async failure => {
    const image = `registry.example.test/runtime@sha256:${"a".repeat(64)}`;
    const environment = { id: "env", driver: "sandbox", status: "active", config: { provider: "daytona", image }, metadata: null } as any;
    vi.spyOn(configRuntime, "resolveEnvironmentDriverConfigForRuntime").mockResolvedValue({ driver: "sandbox", config: environment.config });
    mockRuntimeAcquireRunLease.mockResolvedValue({ lease: { id: "lease", provider: "daytona", metadata: { image } } });
    mockRuntimeExecute.mockResolvedValue({ exitCode: failure === "measurement" ? 1 : 0, stdout: "Linux\nx86_64\nglibc\nglibc 2.39\n" });
    if (failure === "cleanup") mockRuntimeReleaseRunLease.mockRejectedValueOnce(new Error("owned cleanup failed"));
    if (failure === "config-race") mockRecordPlatformProbe.mockResolvedValue(false);
    const result = await probeEnvironment({} as any, environment, { companyId: "company", acquireSandboxRuntimeLease: true });
    expect(result.ok).toBe(true);
    expect(result.details?.platformQualificationRecorded).toBe(false);
    expect(mockRecordPlatformProbe.mock.calls[0]![0].proof).toBeNull();
    if (failure !== "config-race") expect(mockRecordPlatformProbe).toHaveBeenCalledTimes(1);
  });
  it.each([
    null,
    { id: "lease", companyId: "company", environmentId: "env", status: "released", cleanupStatus: "failed" },
    { id: "lease", companyId: "company", environmentId: "env", status: "pending_cleanup", cleanupStatus: "failed" },
    { id: "other-lease", companyId: "company", environmentId: "env", status: "released", cleanupStatus: "success" },
    { id: "lease", companyId: "foreign-company", environmentId: "env", status: "released", cleanupStatus: "success" },
    { id: "lease", companyId: "company", environmentId: "other-environment", status: "released", cleanupStatus: "success" },
  ])("does not record platform evidence without an owned successful cleanup receipt (%j)", async receipt => {
    const image = `registry.example.test/runtime@sha256:${"a".repeat(64)}`;
    const environment = { id: "env", driver: "sandbox", status: "active", config: { provider: "daytona", image }, metadata: null } as any;
    vi.spyOn(configRuntime, "resolveEnvironmentDriverConfigForRuntime").mockResolvedValue({ driver: "sandbox", config: environment.config });
    mockRuntimeAcquireRunLease.mockResolvedValue({ lease: { id: "lease", provider: "daytona", metadata: { image } } });
    mockRuntimeExecute.mockResolvedValue({ exitCode: 0, stdout: "Linux\nx86_64\nglibc\nglibc 2.39\n" });
    mockRuntimeReleaseRunLease.mockResolvedValue(receipt);
    const result = await probeEnvironment({} as any, environment, { companyId: "company", acquireSandboxRuntimeLease: true });
    expect(result.ok).toBe(true);
    expect(result.details?.platformQualificationRecorded).toBe(false);
    expect(mockRecordPlatformProbe).toHaveBeenCalledTimes(1);
    expect(mockRecordPlatformProbe.mock.calls[0]![0].proof).toBeNull();
  });
  it("reads an effective custom image without touching its usage timestamp", async () => {
    const update = vi.fn();
    const capturedAt = new Date("2026-10-12T00:00:00Z");
    const row = { id: "template", provider: "daytona", templateKind: "image", templateRef: `registry.example.test/runtime@sha256:${"a".repeat(64)}`, capturedAt, metadata: null };
    const db = { select: () => ({ from: () => ({ where: () => ({ orderBy: () => Promise.resolve([row]) }) }) }), update };
    const identity = vi.fn();
    const result = await resolveActiveEnvironmentCustomImageTemplateForRuntime(db as never, { environmentId: "env", baseConfig: { provider: "daytona", reuseLease: false }, runtimeConfig: { provider: "daytona", reuseLease: false }, readOnly: true, onResolvedTemplate: identity });
    expect(result).toMatchObject({ image: row.templateRef });
    expect(identity).toHaveBeenCalledWith({ id: "template", capturedAt: capturedAt.toISOString(), templateKind: "image", bindingField: "image" });
    expect(update).not.toHaveBeenCalled();
  });
  it.each(["provider_template", "unknown"])("does not qualify a named active %s boot binding over a pinned base image", async templateKind => {
    const image = `registry.example.test/runtime@sha256:${"a".repeat(64)}`;
    const environment = { id: "env", driver: "sandbox", status: "active", config: { provider: "daytona", image }, metadata: null } as any;
    vi.spyOn(configRuntime, "resolveEnvironmentDriverConfigForRuntime").mockImplementation(async (_db, _company, _env, options) => {
      const bindingField = templateKind === "provider_template" ? "template" : "templateRef";
      options?.onResolvedCustomImageTemplate?.({ id: "active-template", capturedAt: null, templateKind, bindingField });
      return { driver: "sandbox", config: { ...environment.config, [bindingField]: "mutable-template-name" } };
    });
    mockRuntimeAcquireRunLease.mockResolvedValue({ lease: { id: "lease", provider: "daytona", metadata: { image } } });
    const result = await probeEnvironment({} as any, environment, { companyId: "company", acquireSandboxRuntimeLease: true });
    expect(result.ok).toBe(true);
    expect(result.details?.platformQualificationRecorded).toBe(false);
    expect(mockRuntimeExecute).not.toHaveBeenCalled();
    expect(mockRecordPlatformProbe).toHaveBeenCalledTimes(1);
  });
  it("returns false when an atomic probe record loses its config comparison", async () => {
    const { environmentService } = await vi.importActual<typeof import("../services/environments.js")>("../services/environments.js");
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn(() => ({ returning }));
    const db = { update: vi.fn(() => ({ set: vi.fn(() => ({ where })) })) };
    expect(await environmentService(db as never).recordSandboxPlatformProbe({ environmentId: "env", companyId: "company", config: { provider: "daytona" }, proof: { v: 1 } })).toBe(false);
    expect(where).toHaveBeenCalledOnce();
    expect(returning).toHaveBeenCalledOnce();
  });

  it("reports local environments as immediately available", async () => {
    const result = await probeEnvironment({} as any, {
      id: "env-1",
      companyId: "company-1",
      name: "Local",
      description: null,
      driver: "local",
      status: "active",
      config: {},
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(result.ok).toBe(true);
    expect(result.driver).toBe("local");
    expect(result.summary).toContain("Local environment");
    expect(mockEnsureSshWorkspaceReady).not.toHaveBeenCalled();
  });

  it("runs an SSH probe and returns the verified remote cwd", async () => {
    mockEnsureSshWorkspaceReady.mockResolvedValue({
      remoteCwd: "/srv/paperclip/workspace",
    });

    const result = await probeEnvironment({} as any, {
      id: "env-ssh",
      companyId: "company-1",
      name: "SSH Fixture",
      description: null,
      driver: "ssh",
      status: "active",
      config: {
        host: "ssh.example.test",
        port: 2222,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        privateKeySecretRef: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(result).toEqual({
      ok: true,
      driver: "ssh",
      summary: "Connected to ssh-user@ssh.example.test and verified the remote workspace path.",
      details: {
        host: "ssh.example.test",
        port: 2222,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        remoteCwd: "/srv/paperclip/workspace",
      },
    });
    expect(mockEnsureSshWorkspaceReady).toHaveBeenCalledTimes(1);
  });

  it("reports fake sandbox environments as ready without external calls", async () => {
    const result = await probeEnvironment({} as any, {
      id: "env-sandbox",
      companyId: "company-1",
      name: "Fake Sandbox",
      description: null,
      driver: "sandbox",
      status: "active",
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(result).toEqual({
      ok: true,
      driver: "sandbox",
      summary: "Fake sandbox provider is ready for image ubuntu:24.04.",
      details: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
    });
    expect(mockEnsureSshWorkspaceReady).not.toHaveBeenCalled();
  });

  it("routes plugin-backed sandbox provider probes through plugin workers", async () => {
    mockProbePluginSandboxProviderDriver.mockResolvedValue({
      ok: true,
      driver: "sandbox",
      summary: "Fake plugin probe passed.",
      details: {
        provider: "fake-plugin",
        metadata: { ready: true },
      },
    });
    const workerManager = {} as any;

    const result = await probeEnvironment({} as any, {
      id: "env-sandbox-plugin",
      companyId: "company-1",
      name: "Fake Plugin Sandbox",
      description: null,
      driver: "sandbox",
      status: "active",
      config: {
        provider: "fake-plugin",
        image: "fake:test",
        reuseLease: false,
      },
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }, { pluginWorkerManager: workerManager });

    expect(result.ok).toBe(true);
    expect(mockProbePluginSandboxProviderDriver).toHaveBeenCalledWith({
      db: expect.anything(),
      workerManager,
      companyId: "instance",
      environmentId: "env-sandbox-plugin",
      provider: "fake-plugin",
      config: {
        provider: "fake-plugin",
        image: "fake:test",
        reuseLease: false,
      },
    });
  });

  it("boots a fresh runtime lease for saved sandbox probes when requested", async () => {
    mockRuntimeAcquireRunLease.mockResolvedValue({
      environment: {},
      leaseContext: {
        executionWorkspaceId: null,
        executionWorkspaceMode: null,
      },
      lease: {
        id: "lease-1",
        companyId: "company-1",
        environmentId: "env-sandbox-plugin",
        executionWorkspaceId: null,
        issueId: null,
        heartbeatRunId: null,
        status: "active",
        leasePolicy: "ephemeral",
        provider: "daytona",
        providerLeaseId: "sandbox-runtime-1",
        acquiredAt: new Date(),
        lastUsedAt: new Date(),
        expiresAt: null,
        releasedAt: null,
        failureReason: null,
        cleanupStatus: "pending",
        metadata: {
          provider: "daytona",
          sandboxName: "paperclip-probe",
          reuseLease: false,
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const environment = {
      id: "env-sandbox-plugin",
      companyId: "company-1",
      name: "Daytona",
      description: null,
      driver: "sandbox" as const,
      status: "active" as const,
      config: {
        provider: "daytona",
        image: "daytonaio/sandbox:0.8.0",
        reuseLease: true,
      },
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await probeEnvironment({} as any, environment, {
      companyId: "company-1",
      pluginWorkerManager: {} as any,
      applyCustomImageTemplate: true,
      acquireSandboxRuntimeLease: true,
    });

    expect(result).toMatchObject({
      ok: true,
      driver: "sandbox",
      summary: "Connected to daytona sandbox paperclip-probe.",
    });
    expect(mockProbePluginSandboxProviderDriver).not.toHaveBeenCalled();
    expect(mockRuntimeAcquireRunLease).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      issueId: null,
      agentId: null,
      heartbeatRunId: null,
      persistedExecutionWorkspace: null,
      adapterType: null,
      applyCustomImageTemplate: true,
    }));
    expect(mockRuntimeAcquireRunLease.mock.calls[0]?.[0].environment.config).toMatchObject({
      provider: "daytona",
      image: "daytonaio/sandbox:0.8.0",
      reuseLease: false,
      archiveOnRelease: true,
    });
    expect(mockRuntimeReleaseRunLease).toHaveBeenCalledWith(expect.objectContaining({
      lease: expect.objectContaining({ id: "lease-1" }),
      status: "released",
    }));
  });

  it("routes plugin environment probes through the plugin worker host", async () => {
    mockProbePluginEnvironmentDriver.mockResolvedValue({
      ok: true,
      driver: "plugin",
      summary: "Plugin probe passed.",
      details: {
        metadata: { ready: true },
      },
    });
    const workerManager = {} as any;

    const result = await probeEnvironment({} as any, {
      id: "env-plugin",
      companyId: "company-1",
      name: "Plugin Sandbox",
      description: null,
      driver: "plugin",
      status: "active",
      config: {
        pluginKey: "acme.environments",
        driverKey: "sandbox",
        driverConfig: { template: "base" },
      },
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }, { pluginWorkerManager: workerManager });

    expect(result.ok).toBe(true);
    expect(mockProbePluginEnvironmentDriver).toHaveBeenCalledWith({
      db: expect.anything(),
      workerManager,
      companyId: "instance",
      environmentId: "env-plugin",
      config: {
        pluginKey: "acme.environments",
        driverKey: "sandbox",
        driverConfig: { template: "base" },
      },
    });
  });

  it("captures SSH probe failures without throwing", async () => {
    mockEnsureSshWorkspaceReady.mockRejectedValue(
      Object.assign(new Error("Permission denied"), {
        code: 255,
        stdout: "",
        stderr: "Permission denied (publickey).",
      }),
    );

    const result = await probeEnvironment({} as any, {
      id: "env-ssh",
      companyId: "company-1",
      name: "SSH Fixture",
      description: null,
      driver: "ssh",
      status: "active",
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        privateKeySecretRef: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("SSH probe failed");
    expect(result.details).toEqual(
      expect.objectContaining({
        error: "Permission denied (publickey).",
        code: 255,
      }),
    );
  });
});
