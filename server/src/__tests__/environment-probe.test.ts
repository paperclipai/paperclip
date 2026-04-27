import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnsureSshWorkspaceReady = vi.hoisted(() => vi.fn());
const mockProbePluginEnvironmentDriver = vi.hoisted(() => vi.fn());
const mockProbePluginSandboxProviderDriver = vi.hoisted(() => vi.fn());
const mockResolvePluginSandboxProviderDriverByKey = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/ssh", () => ({
  ensureSshWorkspaceReady: mockEnsureSshWorkspaceReady,
}));

vi.mock("../services/plugin-environment-driver.js", () => ({
  probePluginEnvironmentDriver: mockProbePluginEnvironmentDriver,
  probePluginSandboxProviderDriver: mockProbePluginSandboxProviderDriver,
  resolvePluginSandboxProviderDriverByKey: mockResolvePluginSandboxProviderDriverByKey,
}));

import { probeEnvironment } from "../services/environment-probe.ts";

describe("probeEnvironment", () => {
  beforeEach(() => {
    mockEnsureSshWorkspaceReady.mockReset();
    mockProbePluginEnvironmentDriver.mockReset();
    mockProbePluginSandboxProviderDriver.mockReset();
    mockResolvePluginSandboxProviderDriverByKey.mockReset();
    mockResolvePluginSandboxProviderDriverByKey.mockResolvedValue(null);
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
      companyId: "company-1",
      environmentId: "env-sandbox-plugin",
      provider: "fake-plugin",
      config: {
        provider: "fake-plugin",
        image: "fake:test",
        reuseLease: false,
      },
    });
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
      companyId: "company-1",
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
