import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnsureSshWorkspaceReady = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/ssh", () => ({
  ensureSshWorkspaceReady: mockEnsureSshWorkspaceReady,
}));

import { probeEnvironment } from "../services/environment-probe.ts";

describe("probeEnvironment", () => {
  beforeEach(() => {
    mockEnsureSshWorkspaceReady.mockReset();
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
