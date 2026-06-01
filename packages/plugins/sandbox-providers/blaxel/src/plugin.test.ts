import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInitialize = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());
const mockGet = vi.hoisted(() => vi.fn());
const mockStaticDelete = vi.hoisted(() => vi.fn());

vi.mock("@blaxel/core", () => ({
  initialize: mockInitialize,
  SandboxInstance: {
    create: mockCreate,
    get: mockGet,
    delete: mockStaticDelete,
  },
}));

import plugin from "./plugin.js";

function createMockSandbox(overrides: {
  name?: string;
  status?: string;
  region?: string;
  image?: string;
  memory?: number;
  execResult?: { exitCode: number; stdout: string; stderr: string; pid: string; status: string };
  pwdResult?: string;
} = {}) {
  const defaultExecResult = overrides.execResult ?? {
    exitCode: 0,
    stdout: "",
    stderr: "",
    pid: "42",
    status: "completed",
  };
  return {
    metadata: { name: overrides.name ?? "pclip-env-1" },
    status: overrides.status ?? "RUNNING",
    spec: {
      region: overrides.region ?? "us-pdx-1",
      runtime: {
        image: overrides.image ?? "blaxel/base-image:latest",
        memory: overrides.memory ?? 4096,
      },
    },
    fs: { ls: vi.fn().mockResolvedValue([]) },
    process: {
      exec: vi.fn(async (req: { command: string }) => {
        if (req.command === "pwd") {
          return {
            exitCode: 0,
            stdout: overrides.pwdResult ?? "/home/user",
            stderr: "",
            pid: "1",
            status: "completed",
          };
        }
        return defaultExecResult;
      }),
    },
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

const def = plugin.definition;

describe("Blaxel sandbox provider plugin", () => {
  beforeEach(() => {
    mockInitialize.mockReset();
    mockCreate.mockReset();
    mockGet.mockReset();
    mockStaticDelete.mockReset();
    vi.restoreAllMocks();
    delete process.env.BL_API_KEY;
    delete process.env.BL_WORKSPACE;
    delete process.env.BL_REGION;
  });

  it("declares environment lifecycle handlers", async () => {
    expect(await def.onHealth?.()).toEqual({
      status: "ok",
      message: "Blaxel sandbox provider plugin healthy",
    });
    expect(def.onEnvironmentAcquireLease).toBeTypeOf("function");
    expect(def.onEnvironmentExecute).toBeTypeOf("function");
  });

  describe("onEnvironmentValidateConfig", () => {
    it("validates a complete config", async () => {
      const result = await def.onEnvironmentValidateConfig!({
        driverKey: "blaxel",
        config: {
          apiKey: "bl_test_key",
          workspace: "my-workspace",
          image: "blaxel/base-image:latest",
          memory: 4096,
          timeoutMs: 300_000,
        },
      });
      expect(result.ok).toBe(true);
    });

    it("falls back to env vars for API key and workspace", async () => {
      process.env.BL_API_KEY = "bl_env_key";
      process.env.BL_WORKSPACE = "env-workspace";
      const result = await def.onEnvironmentValidateConfig!({
        driverKey: "blaxel",
        config: {},
      });
      expect(result.ok).toBe(true);
    });

    it("rejects missing API key", async () => {
      const result = await def.onEnvironmentValidateConfig!({
        driverKey: "blaxel",
        config: { workspace: "my-workspace" },
      });
      expect(result.ok).toBe(false);
      expect(result.errors?.some((e) => e.includes("API key"))).toBe(true);
    });

    it("rejects missing workspace", async () => {
      const result = await def.onEnvironmentValidateConfig!({
        driverKey: "blaxel",
        config: { apiKey: "bl_test" },
      });
      expect(result.ok).toBe(false);
      expect(result.errors?.some((e) => e.includes("workspace"))).toBe(true);
    });

    it("rejects invalid memory values", async () => {
      process.env.BL_API_KEY = "bl_key";
      process.env.BL_WORKSPACE = "ws";
      const result = await def.onEnvironmentValidateConfig!({
        driverKey: "blaxel",
        config: { memory: 50 },
      });
      expect(result.ok).toBe(false);
      expect(result.errors?.some((e) => e.includes("memory"))).toBe(true);
    });

    it("rejects invalid timeoutMs values", async () => {
      process.env.BL_API_KEY = "bl_key";
      process.env.BL_WORKSPACE = "ws";
      const result = await def.onEnvironmentValidateConfig!({
        driverKey: "blaxel",
        config: { timeoutMs: -1 },
      });
      expect(result.ok).toBe(false);
      expect(result.errors?.some((e) => e.includes("timeoutMs"))).toBe(true);
    });
  });

  describe("onEnvironmentProbe", () => {
    it("reuses existing sandbox when available and does NOT delete it", async () => {
      const sandbox = createMockSandbox();
      mockGet.mockResolvedValue(sandbox);

      const result = await def.onEnvironmentProbe!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        config: { apiKey: "bl_key", workspace: "ws" },
      });

      expect(result.ok).toBe(true);
      expect(mockGet).toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
      expect(sandbox.delete).not.toHaveBeenCalled();
    });

    it("creates a probe sandbox and deletes it after", async () => {
      const sandbox = createMockSandbox();
      mockGet.mockRejectedValue(new Error("Not found"));
      mockCreate.mockResolvedValue(sandbox);

      const result = await def.onEnvironmentProbe!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        config: { apiKey: "bl_key", workspace: "ws" },
      });

      expect(result.ok).toBe(true);
      expect(result.summary).toContain("blaxel/base-image:latest");
      expect(result.metadata?.provider).toBe("blaxel");
      expect(sandbox.delete).toHaveBeenCalled();
    });

    it("handles probe failure gracefully", async () => {
      mockGet.mockRejectedValue(new Error("Not found"));
      mockCreate.mockRejectedValue(new Error("Connection refused"));

      const result = await def.onEnvironmentProbe!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        config: { apiKey: "bl_key", workspace: "ws" },
      });

      expect(result.ok).toBe(false);
      expect(result.metadata?.error).toContain("Connection refused");
    });
  });

  describe("onEnvironmentAcquireLease", () => {
    it("reuses existing sandbox if available", async () => {
      const sandbox = createMockSandbox({ name: "pclip-env-1" });
      mockGet.mockResolvedValue(sandbox);

      const result = await def.onEnvironmentAcquireLease!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        runId: "run-1",
        config: { apiKey: "bl_key", workspace: "ws" },
      });

      expect(result.providerLeaseId).toBe("pclip-env-1");
      expect(result.metadata?.provider).toBe("blaxel");
      expect(result.metadata?.remoteCwd).toContain("paperclip-workspace");
      expect(mockGet).toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("creates sandbox when none exists", async () => {
      const sandbox = createMockSandbox({ name: "pclip-env-1" });
      mockGet.mockRejectedValue(new Error("Not found"));
      mockCreate.mockResolvedValue(sandbox);

      const result = await def.onEnvironmentAcquireLease!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        runId: "run-1",
        config: { apiKey: "bl_key", workspace: "ws" },
      });

      expect(result.providerLeaseId).toBe("pclip-env-1");
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          lifecycle: {
            expirationPolicies: [
              { type: "ttl-idle", action: "delete", value: "30m" },
            ],
          },
        }),
        { safe: true },
      );
    });

    it("creates new sandbox when existing one is terminated", async () => {
      const terminated = createMockSandbox({ name: "pclip-env-1", status: "TERMINATED" });
      const fresh = createMockSandbox({ name: "pclip-env-1" });
      mockGet.mockResolvedValue(terminated);
      mockCreate.mockResolvedValue(fresh);

      const result = await def.onEnvironmentAcquireLease!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        runId: "run-1",
        config: { apiKey: "bl_key", workspace: "ws" },
      });

      expect(result.providerLeaseId).toBe("pclip-env-1");
      expect(mockCreate).toHaveBeenCalled();
    });

    it("cleans up freshly created sandbox on workspace setup failure", async () => {
      const sandbox = createMockSandbox();
      sandbox.process.exec.mockRejectedValueOnce(new Error("exec failed"));
      mockGet.mockRejectedValue(new Error("Not found"));
      mockCreate.mockResolvedValue(sandbox);

      await expect(
        def.onEnvironmentAcquireLease!({
          driverKey: "blaxel",
          companyId: "co-1",
          environmentId: "env-1",
          runId: "run-1",
          config: { apiKey: "bl_key", workspace: "ws" },
        }),
      ).rejects.toThrow("exec failed");

      expect(sandbox.delete).toHaveBeenCalled();
    });

    it("does NOT delete reused sandbox on transient workspace failure", async () => {
      const sandbox = createMockSandbox({ name: "pclip-env-1" });
      sandbox.process.exec.mockRejectedValueOnce(new Error("network blip"));
      mockGet.mockResolvedValue(sandbox);

      await expect(
        def.onEnvironmentAcquireLease!({
          driverKey: "blaxel",
          companyId: "co-1",
          environmentId: "env-1",
          runId: "run-1",
          config: { apiKey: "bl_key", workspace: "ws" },
        }),
      ).rejects.toThrow("network blip");

      expect(sandbox.delete).not.toHaveBeenCalled();
    });

    it("uses custom idleTtl from config", async () => {
      const sandbox = createMockSandbox({ name: "pclip-env-1" });
      mockGet.mockRejectedValue(new Error("Not found"));
      mockCreate.mockResolvedValue(sandbox);

      await def.onEnvironmentAcquireLease!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        runId: "run-1",
        config: { apiKey: "bl_key", workspace: "ws", idleTtl: "2h" },
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          lifecycle: {
            expirationPolicies: [
              { type: "ttl-idle", action: "delete", value: "2h" },
            ],
          },
        }),
        { safe: true },
      );
    });
  });

  describe("onEnvironmentResumeLease", () => {
    it("reconnects to an existing sandbox (auto-resumed from snapshot)", async () => {
      const sandbox = createMockSandbox({ name: "pclip-env-1" });
      mockGet.mockResolvedValue(sandbox);

      const result = await def.onEnvironmentResumeLease!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        providerLeaseId: "pclip-env-1",
        config: { apiKey: "bl_key", workspace: "ws" },
      });

      expect(result.providerLeaseId).toBe("pclip-env-1");
      expect(result.metadata?.resumedLease).toBe(true);
    });

    it("returns expired when sandbox is terminated", async () => {
      const sandbox = createMockSandbox({ status: "TERMINATED" });
      mockGet.mockResolvedValue(sandbox);

      const result = await def.onEnvironmentResumeLease!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        providerLeaseId: "pclip-env-1",
        config: { apiKey: "bl_key", workspace: "ws" },
      });

      expect(result.providerLeaseId).toBeNull();
      expect(result.metadata?.expired).toBe(true);
    });

    it("returns expired when sandbox is not found", async () => {
      mockGet.mockRejectedValue(new Error("Not found"));

      const result = await def.onEnvironmentResumeLease!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        providerLeaseId: "pclip-old",
        config: { apiKey: "bl_key", workspace: "ws" },
      });

      expect(result.providerLeaseId).toBeNull();
      expect(result.metadata?.expired).toBe(true);
    });

    it("returns expired for errors with status code 404", async () => {
      const err = Object.assign(new Error("request failed"), { status: 404 });
      mockGet.mockRejectedValue(err);

      const result = await def.onEnvironmentResumeLease!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        providerLeaseId: "pclip-old",
        config: { apiKey: "bl_key", workspace: "ws" },
      });

      expect(result.providerLeaseId).toBeNull();
      expect(result.metadata?.expired).toBe(true);
    });

    it("re-throws transient errors instead of marking expired", async () => {
      mockGet.mockRejectedValue(new Error("Connection timeout"));

      await expect(
        def.onEnvironmentResumeLease!({
          driverKey: "blaxel",
          companyId: "co-1",
          environmentId: "env-1",
          providerLeaseId: "pclip-env-1",
          config: { apiKey: "bl_key", workspace: "ws" },
        }),
      ).rejects.toThrow("Connection timeout");
    });
  });

  describe("onEnvironmentReleaseLease", () => {
    it("does NOT delete sandbox — relies on scale-to-zero snapshot", async () => {
      await def.onEnvironmentReleaseLease!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        providerLeaseId: "pclip-env-1",
        config: { apiKey: "bl_key", workspace: "ws" },
      });

      // Key difference from E2B: no delete, no pause.
      // Blaxel auto-hibernates idle sandboxes via snapshot.
      expect(mockGet).not.toHaveBeenCalled();
    });

    it("no-ops when providerLeaseId is null", async () => {
      await def.onEnvironmentReleaseLease!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        providerLeaseId: null,
        config: { apiKey: "bl_key", workspace: "ws" },
      });

      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe("onEnvironmentDestroyLease", () => {
    it("force-deletes sandbox via static delete (no extra GET)", async () => {
      mockStaticDelete.mockResolvedValue(undefined);

      await def.onEnvironmentDestroyLease!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        providerLeaseId: "pclip-env-1",
        config: { apiKey: "bl_key", workspace: "ws" },
      });

      expect(mockStaticDelete).toHaveBeenCalledWith("pclip-env-1");
      expect(mockGet).not.toHaveBeenCalled();
    });

    it("silently handles not-found sandbox", async () => {
      mockStaticDelete.mockRejectedValue(new Error("Not found"));

      await def.onEnvironmentDestroyLease!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        providerLeaseId: "pclip-gone",
        config: { apiKey: "bl_key", workspace: "ws" },
      });
    });
  });

  describe("onEnvironmentRealizeWorkspace", () => {
    it("uses remoteCwd from lease metadata", async () => {
      const sandbox = createMockSandbox();
      mockGet.mockResolvedValue(sandbox);

      const result = await def.onEnvironmentRealizeWorkspace!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        config: { apiKey: "bl_key", workspace: "ws" },
        lease: {
          providerLeaseId: "pclip-env-1",
          metadata: { remoteCwd: "/workspace/project" },
        },
        workspace: {},
      });

      expect(result.cwd).toBe("/workspace/project");
      expect(result.metadata?.provider).toBe("blaxel");
    });

    it("falls back to workspace paths when metadata missing", async () => {
      const result = await def.onEnvironmentRealizeWorkspace!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        config: { apiKey: "bl_key", workspace: "ws" },
        lease: { providerLeaseId: null, metadata: {} },
        workspace: { remotePath: "/remote/path" },
      });

      expect(result.cwd).toBe("/remote/path");
    });
  });

  describe("onEnvironmentExecute", () => {
    it("runs a command inside the sandbox", async () => {
      const sandbox = createMockSandbox({
        execResult: {
          exitCode: 0,
          stdout: "hello\n",
          stderr: "",
          pid: "99",
          status: "completed",
        },
      });
      mockGet.mockResolvedValue(sandbox);

      const result = await def.onEnvironmentExecute!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        config: { apiKey: "bl_key", workspace: "ws" },
        lease: { providerLeaseId: "pclip-env-1" },
        command: "echo",
        args: ["hello"],
        cwd: "/workspace",
        env: { FOO: "bar" },
        timeoutMs: 60_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello\n");
      expect(result.timedOut).toBe(false);
      expect(sandbox.process.exec).toHaveBeenCalledWith(
        expect.objectContaining({
          workingDir: "/workspace",
          env: { FOO: "bar" },
          waitForCompletion: true,
          timeout: 60,
        }),
      );
    });

    it("returns error when no lease ID", async () => {
      const result = await def.onEnvironmentExecute!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        config: { apiKey: "bl_key", workspace: "ws" },
        lease: { providerLeaseId: null },
        command: "echo",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No provider lease ID");
    });

    it("handles timeout errors", async () => {
      const sandbox = createMockSandbox();
      sandbox.process.exec.mockRejectedValue(new Error("Timeout exceeded"));
      mockGet.mockResolvedValue(sandbox);

      const result = await def.onEnvironmentExecute!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        config: { apiKey: "bl_key", workspace: "ws" },
        lease: { providerLeaseId: "pclip-env-1" },
        command: "sleep",
        args: ["3600"],
      });

      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBeNull();
    });

    it("detects ETIMEDOUT and deadline exceeded as timeout", async () => {
      for (const msg of ["ETIMEDOUT", "request timed out", "deadline exceeded"]) {
        mockGet.mockReset();
        const sandbox = createMockSandbox();
        sandbox.process.exec.mockRejectedValue(new Error(msg));
        mockGet.mockResolvedValue(sandbox);

        const result = await def.onEnvironmentExecute!({
          driverKey: "blaxel",
          companyId: "co-1",
          environmentId: "env-1",
          config: { apiKey: "bl_key", workspace: "ws" },
          lease: { providerLeaseId: "pclip-env-1" },
          command: "sleep",
          args: ["3600"],
        });

        expect(result.timedOut).toBe(true);
        expect(result.exitCode).toBeNull();
      }
    });

    it("propagates non-timeout errors", async () => {
      const sandbox = createMockSandbox();
      sandbox.process.exec.mockRejectedValue(new Error("Internal server error"));
      mockGet.mockResolvedValue(sandbox);

      await expect(
        def.onEnvironmentExecute!({
          driverKey: "blaxel",
          companyId: "co-1",
          environmentId: "env-1",
          config: { apiKey: "bl_key", workspace: "ws" },
          lease: { providerLeaseId: "pclip-env-1" },
          command: "broken",
        }),
      ).rejects.toThrow("Internal server error");
    });

    it("handles non-zero exit codes", async () => {
      const sandbox = createMockSandbox({
        execResult: {
          exitCode: 1,
          stdout: "",
          stderr: "not found\n",
          pid: "5",
          status: "failed",
        },
      });
      mockGet.mockResolvedValue(sandbox);

      const result = await def.onEnvironmentExecute!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        config: { apiKey: "bl_key", workspace: "ws" },
        lease: { providerLeaseId: "pclip-env-1" },
        command: "ls",
        args: ["/nonexistent"],
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not found");
      expect(result.timedOut).toBe(false);
    });
  });

  describe("SDK initialization", () => {
    it("calls initialize with config values", async () => {
      const sandbox = createMockSandbox();
      mockGet.mockRejectedValue(new Error("Not found"));
      mockCreate.mockResolvedValue(sandbox);

      await def.onEnvironmentProbe!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        config: { apiKey: "bl_my_key", workspace: "my-ws" },
      });

      expect(mockInitialize).toHaveBeenCalledWith({
        workspace: "my-ws",
        apiKey: "bl_my_key",
      });
    });

    it("uses env vars when config values are missing", async () => {
      process.env.BL_API_KEY = "bl_env_key";
      process.env.BL_WORKSPACE = "env-ws";
      const sandbox = createMockSandbox();
      mockGet.mockRejectedValue(new Error("Not found"));
      mockCreate.mockResolvedValue(sandbox);

      await def.onEnvironmentProbe!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        config: {},
      });

      expect(mockInitialize).toHaveBeenCalledWith({
        workspace: "env-ws",
        apiKey: "bl_env_key",
      });
    });

    it("falls back to BL_REGION env var for region", async () => {
      process.env.BL_API_KEY = "bl_env_key";
      process.env.BL_WORKSPACE = "env-ws";
      process.env.BL_REGION = "eu-ams-1";
      const sandbox = createMockSandbox({ name: "pclip-env-1" });
      mockGet.mockRejectedValue(new Error("Not found"));
      mockCreate.mockResolvedValue(sandbox);

      await def.onEnvironmentAcquireLease!({
        driverKey: "blaxel",
        companyId: "co-1",
        environmentId: "env-1",
        runId: "run-1",
        config: {},
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          region: "eu-ams-1",
        }),
        { safe: true },
      );
    });
  });
});
