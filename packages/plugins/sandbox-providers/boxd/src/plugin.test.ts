import { createHash } from "node:crypto";
import { PluginEnvironmentCreationCleanupError } from "@paperclipai/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  class BoxdError extends Error {
    grpcCode?: number;

    constructor(message: string, grpcCode?: number) {
      super(message);
      this.grpcCode = grpcCode;
    }
  }
  class NotFoundError extends BoxdError {}
  class ConflictError extends BoxdError {}
  class AgentOutdatedError extends ConflictError {}
  class FilesystemError extends BoxdError {}
  const machines = {
    create: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    exec: vi.fn(),
    waitUntilReady: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    wake: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    setDeleteAfter: vi.fn(),
    files: {
      upload: vi.fn(),
      delete: vi.fn(),
    },
    fs: {
      write: vi.fn(),
      remove: vi.fn(),
      mkdir: vi.fn(),
    },
  };
  const constructed: Array<{ apiKey?: string }> = [];
  const close = vi.fn().mockResolvedValue(undefined);
  class Boxd {
    machines = machines;
    close = close;

    constructor(options: { apiKey?: string }) {
      constructed.push(options);
    }
  }
  return { Boxd, BoxdError, NotFoundError, ConflictError, AgentOutdatedError, FilesystemError, machines, constructed, close };
});

vi.mock("@boxd-sh/sdk", () => ({
  Boxd: sdk.Boxd,
  BoxdError: sdk.BoxdError,
  NotFoundError: sdk.NotFoundError,
  ConflictError: sdk.ConflictError,
  AgentOutdatedError: sdk.AgentOutdatedError,
  FilesystemError: sdk.FilesystemError,
}));

import plugin from "./plugin.js";

const { machines } = sdk;
const hooks = plugin.definition;
const base = { driverKey: "boxd", companyId: "company-1", environmentId: "env-12345678abc" };

function machine(overrides: Partial<{ id: string; name: string; status: string }> = {}) {
  return { id: "vm-1", name: "paperclip-env12345-run12345-abcd", status: "running", ...overrides };
}

function execOk(stdout = "", stderr = "", exitCode = 0) {
  return { stdout, stderr, exitCode, success: exitCode === 0 };
}

function lease(metadata: Record<string, unknown> = {}) {
  return { providerLeaseId: "vm-1", metadata: { remoteCwd: "/home/boxd/paperclip-workspace", ...metadata } };
}

describe("boxd sandbox provider plugin", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await hooks.onShutdown?.();
    sdk.constructed.length = 0;
    delete process.env.BOXD_API_KEY;
    machines.create.mockResolvedValue(machine());
    machines.waitUntilReady.mockResolvedValue(machine());
    machines.get.mockRejectedValue(new sdk.NotFoundError("not found", 5));
    machines.delete.mockResolvedValue(undefined);
    machines.exec.mockImplementation(async (_id: string, params: { command: string }) =>
      params.command.startsWith("printf") ? execOk("/home/boxd\n") : execOk(),
    );
    machines.setDeleteAfter.mockImplementation(async (_id: string, seconds: number) => new Date(Date.now() + seconds * 1000));
    machines.files.upload.mockResolvedValue(12);
    machines.files.delete.mockResolvedValue(undefined);
    machines.fs.write.mockResolvedValue({ size: 8 });
    machines.fs.remove.mockResolvedValue(undefined);
    machines.fs.mkdir.mockResolvedValue(undefined);
  });

  it("declares environment lifecycle handlers", async () => {
    expect(await hooks.onHealth?.()).toEqual({ status: "ok", message: "boxd sandbox provider plugin healthy" });
    for (const hook of [
      "onEnvironmentAcquireLease",
      "onEnvironmentResumeLease",
      "onEnvironmentReleaseLease",
      "onEnvironmentStopLease",
      "onEnvironmentDestroyLease",
      "onEnvironmentInspectLease",
      "onEnvironmentRealizeWorkspace",
      "onEnvironmentExecute",
    ] as const) {
      expect(hooks[hook]).toBeTypeOf("function");
    }
  });

  it("normalizes config", async () => {
    const result = await hooks.onEnvironmentValidateConfig?.({
      driverKey: "boxd",
      config: { apiKey: "  bxd_test  ", org: " acme ", vcpu: "4", namePrefix: "My Paperclip!", timeoutMs: "450000.9", reuseLease: true },
    });
    expect(result).toEqual({
      ok: true,
      normalizedConfig: {
        apiKey: "bxd_test",
        org: "acme",
        snapshot: null,
        vcpu: 4,
        namePrefix: "my-paperclip",
        timeoutMs: 450000,
        reuseLease: true,
      },
    });
  });

  it("rejects sizes boxd does not offer, a size with a snapshot, and a missing key", async () => {
    const result = await hooks.onEnvironmentValidateConfig?.({
      driverKey: "boxd",
      config: { vcpu: 3, snapshot: "golden", timeoutMs: 0 },
    });
    expect(result?.ok).toBe(false);
    expect(result?.errors).toEqual([
      "timeoutMs must be between 1 and 86400000.",
      "vcpu must be 1, 2, 4 or 8. boxd sizes are 1 vCPU/4 GB, 2/8 GB, 4/16 GB and 8/32 GB.",
      "vcpu applies to fresh machines only. A machine restored from a snapshot keeps the snapshot's size; clear vcpu or snapshot.",
      "boxd environments require an API key in config or BOXD_API_KEY.",
    ]);
  });

  it("accepts the BOXD_API_KEY host fallback", async () => {
    process.env.BOXD_API_KEY = "bxd_env";
    const result = await hooks.onEnvironmentValidateConfig?.({ driverKey: "boxd", config: {} });
    expect(result?.ok).toBe(true);
  });

  it("acquires an isolated machine, waits until it is ready, and prepares the workspace", async () => {
    const result = await hooks.onEnvironmentAcquireLease?.({
      ...base,
      runId: "run-12345678-xyz",
      config: { apiKey: "bxd_test", org: "acme", vcpu: 2 },
    });

    expect(machines.create).toHaveBeenCalledWith({
      name: expect.stringMatching(/^paperclip-env12345-run12345-[0-9a-f]{4}$/),
      org: "acme",
      isolated: true,
      labels: { "paperclip-provider": "boxd", "paperclip-environment": "env-12345678abc", "paperclip-run": "run-12345678-xyz" },
      config: { autoSuspendTimeout: 0, vcpu: 2, memory: "8G" },
    });
    expect(machines.waitUntilReady).toHaveBeenCalledWith("vm-1", { timeout: 120000 });
    expect(machines.fs.mkdir).toHaveBeenCalledWith("vm-1", "/home/boxd/paperclip-workspace");
    expect(machines.setDeleteAfter).not.toHaveBeenCalled();
    expect(result).toEqual({
      providerLeaseId: "vm-1",
      metadata: {
        provider: "boxd",
        machineId: "vm-1",
        machineName: "paperclip-env12345-run12345-abcd",
        sandboxName: "paperclip-env12345-run12345-abcd",
        url: "https://paperclip-env12345-run12345-abcd.boxd.sh",
        org: "acme",
        snapshot: null,
        shellCommand: "bash",
        remoteCwd: "/home/boxd/paperclip-workspace",
        timeoutMs: 3600000,
        reuseLease: false,
        resumedLease: false,
      },
    });
  });

  it("restores from a snapshot without a size", async () => {
    await hooks.onEnvironmentAcquireLease?.({ ...base, runId: "run-1", config: { apiKey: "bxd_test", snapshot: "golden" } });
    expect(machines.create).toHaveBeenCalledWith(expect.objectContaining({
      fromSnapshot: "golden",
      isolated: true,
      config: { autoSuspendTimeout: 0 },
    }));
  });

  it("bounds the machine lifetime at or before a requested expiry", async () => {
    const requestedExpiresAt = new Date(Date.now() + 600_000).toISOString();
    const result = await hooks.onEnvironmentAcquireLease?.({ ...base, runId: "run-1", config: { apiKey: "bxd_test" }, requestedExpiresAt });
    expect(machines.create.mock.calls[0][0]).not.toHaveProperty("deleteAfter");
    const [id, deleteAfter] = machines.setDeleteAfter.mock.calls[0];
    expect(id).toBe("vm-1");
    expect(deleteAfter).toBeGreaterThan(580);
    expect(deleteAfter).toBeLessThanOrEqual(595);
    expect(Date.parse(result!.expiresAt!)).toBeLessThanOrEqual(Date.parse(requestedExpiresAt));
  });

  it("deletes the machine when its lifetime cannot be bounded", async () => {
    machines.setDeleteAfter.mockRejectedValue(new sdk.BoxdError("unavailable", 14));
    const requestedExpiresAt = new Date(Date.now() + 600_000).toISOString();
    await expect(hooks.onEnvironmentAcquireLease?.({ ...base, runId: "run-1", config: { apiKey: "bxd_test" }, requestedExpiresAt }))
      .rejects.toThrow("unavailable");
    expect(machines.delete).toHaveBeenCalledWith("vm-1");
  });

  it("refuses an expiry it cannot honor before creating anything", async () => {
    await expect(hooks.onEnvironmentAcquireLease?.({
      ...base,
      runId: "run-1",
      config: { apiKey: "bxd_test" },
      requestedExpiresAt: new Date(Date.now() + 2_000).toISOString(),
    })).rejects.toThrow(/less than six seconds/);
    expect(machines.create).not.toHaveBeenCalled();
  });

  it("deletes the machine when workspace setup fails", async () => {
    machines.fs.mkdir.mockRejectedValue(new sdk.FilesystemError("/home/boxd/paperclip-workspace: Read-only file system"));
    await expect(hooks.onEnvironmentAcquireLease?.({ ...base, runId: "run-1", config: { apiKey: "bxd_test" } }))
      .rejects.toThrow("Failed to create /home/boxd/paperclip-workspace on boxd machine vm-1: /home/boxd/paperclip-workspace: Read-only file system");
    expect(machines.delete).toHaveBeenCalledWith("vm-1");
  });

  it("hands the host the machine when it cannot be deleted after a failed acquisition", async () => {
    machines.waitUntilReady.mockRejectedValue(new sdk.BoxdError("not ready", 4));
    machines.delete.mockRejectedValue(new sdk.BoxdError("unavailable", 14));
    const error = await hooks.onEnvironmentAcquireLease?.({
      ...base,
      runId: "run-12345678-xyz",
      config: { apiKey: "bxd_test" },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PluginEnvironmentCreationCleanupError);
    const cleanupError = error as PluginEnvironmentCreationCleanupError;
    expect(cleanupError.errors.map((cause) => (cause as Error).message)).toEqual(["not ready", "unavailable"]);
    expect(cleanupError.cleanup).toEqual({
      providerLeaseId: "vm-1",
      companyId: "company-1",
      environmentId: "env-12345678abc",
      runId: "run-12345678-xyz",
      attemptId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      accountFingerprint: createHash("sha256").update("bxd_test").digest("hex"),
      labels: { "paperclip-provider": "boxd", "paperclip-environment": "env-12345678abc", "paperclip-run": "run-12345678-xyz" },
    });
  });

  it("destroys a failed creation the host hands back only when it matches the machine", async () => {
    const failedCreateCleanup = {
      providerLeaseId: "vm-1",
      companyId: "company-1",
      environmentId: "env-12345678abc",
      runId: "run-1",
      attemptId: "attempt-1",
      accountFingerprint: createHash("sha256").update("bxd_test").digest("hex"),
      labels: { "paperclip-provider": "boxd", "paperclip-run": "run-1" },
    };
    const owned = machine({ labels: { "paperclip-provider": "boxd", "paperclip-run": "run-1" } } as never);
    machines.get.mockResolvedValueOnce(owned).mockRejectedValue(new sdk.NotFoundError("not found", 5));
    expect(await hooks.onEnvironmentDestroyLease?.({
      ...base, config: { apiKey: "bxd_test" }, providerLeaseId: "vm-1", leaseMetadata: { failedCreateCleanup },
    })).toEqual({ providerLeaseId: "vm-1", state: "destroyed" });
    expect(machines.delete).toHaveBeenCalledWith("vm-1");

    machines.delete.mockClear();
    machines.get.mockResolvedValue(machine({ labels: { "paperclip-provider": "boxd", "paperclip-run": "run-2" } } as never));
    await expect(hooks.onEnvironmentDestroyLease?.({
      ...base, config: { apiKey: "bxd_test" }, providerLeaseId: "vm-1", leaseMetadata: { failedCreateCleanup },
    })).rejects.toThrow("does not match");
    await expect(hooks.onEnvironmentDestroyLease?.({
      ...base, config: { apiKey: "bxd_other" }, providerLeaseId: "vm-1", leaseMetadata: { failedCreateCleanup },
    })).rejects.toThrow("does not match");
    expect(machines.delete).not.toHaveBeenCalled();
  });

  it("reuses one client per API key", async () => {
    const config = { apiKey: "bxd_test" };
    await hooks.onEnvironmentAcquireLease?.({ ...base, runId: "run-1", config });
    await hooks.onEnvironmentExecute?.({ ...base, config, lease: lease(), command: "true" });
    await hooks.onEnvironmentDestroyLease?.({ ...base, config, providerLeaseId: "vm-1" });
    expect(sdk.constructed).toEqual([{ apiKey: "bxd_test" }]);
  });

  it("executes through a login shell with quoted env, cwd and timeout", async () => {
    machines.exec.mockResolvedValue(execOk("out\n", "err\n", 42));
    const result = await hooks.onEnvironmentExecute?.({
      ...base,
      config: { apiKey: "bxd_test", timeoutMs: 1000 },
      lease: lease(),
      command: "sh",
      args: ["-c", "echo $GREETING"],
      env: { GREETING: "it's here" },
      timeoutMs: 5000,
    });

    const [id, params] = machines.exec.mock.calls[0];
    expect(id).toBe("vm-1");
    expect(params.cwd).toBe("/home/boxd/paperclip-workspace");
    expect(params.timeout).toBe(5000);
    expect(params.command).toContain(". \"$HOME/.profile\"");
    expect(params.command).toMatch(/exec env GREETING='it'"'"'s here' 'sh' '-c' 'echo \$GREETING'$/);
    expect(result).toEqual({ exitCode: 42, timedOut: false, stdout: "out\n", stderr: "err\n" });
  });

  it("falls back to the configured timeout", async () => {
    await hooks.onEnvironmentExecute?.({ ...base, config: { apiKey: "bxd_test", timeoutMs: 1234 }, lease: lease(), command: "true", timeoutMs: 0 });
    expect(machines.exec.mock.calls[0][1].timeout).toBe(1234);
  });

  it("stages stdin in a private temporary file and removes it afterwards", async () => {
    await hooks.onEnvironmentExecute?.({ ...base, config: { apiKey: "bxd_test" }, lease: lease(), command: "cat", stdin: "payload\n" });
    const [, stdinPath, contents, options] = machines.fs.write.mock.calls[0];
    expect(stdinPath).toMatch(/^\/tmp\/paperclip-stdin-/);
    expect(contents).toBe("payload\n");
    expect(options).toEqual({ mode: 0o600 });
    expect(machines.exec.mock.calls[0][1].command).toMatch(new RegExp(`exec 'cat' < '${stdinPath}'$`));
    expect(machines.fs.remove).toHaveBeenCalledWith("vm-1", stdinPath);
    expect(machines.files.upload).not.toHaveBeenCalled();
  });

  it("stages an empty stdin", async () => {
    await hooks.onEnvironmentExecute?.({ ...base, config: { apiKey: "bxd_test" }, lease: lease(), command: "cat", stdin: "" });
    expect(machines.fs.write.mock.calls[0][2]).toBe("");
  });

  it("falls back to the older file calls on a machine whose boxd agent predates the filesystem API", async () => {
    const outdated = () => new sdk.AgentOutdatedError("vm-1 was started before the filesystem API existed; reboot it to update it", 9);
    machines.fs.write.mockRejectedValue(outdated());
    machines.fs.remove.mockRejectedValue(outdated());
    machines.fs.mkdir.mockRejectedValue(outdated());
    await hooks.onEnvironmentExecute?.({ ...base, config: { apiKey: "bxd_test" }, lease: lease(), command: "cat", stdin: "payload\n" });
    const [, stdinPath, contents] = machines.files.upload.mock.calls[0];
    expect(contents).toBe("payload\n");
    expect(machines.files.delete).toHaveBeenCalledWith("vm-1", stdinPath);

    await hooks.onEnvironmentRealizeWorkspace?.({ ...base, config: { apiKey: "bxd_test" }, lease: lease(), workspace: {} });
    expect(machines.exec).toHaveBeenLastCalledWith("vm-1", { command: "mkdir -p '/home/boxd/paperclip-workspace'" });
  });

  it("reports an exec timeout as timedOut", async () => {
    machines.exec.mockRejectedValue(new sdk.BoxdError("exec timed out after 5000ms"));
    const result = await hooks.onEnvironmentExecute?.({ ...base, config: { apiKey: "bxd_test" }, lease: lease(), command: "sleep", args: ["60"], timeoutMs: 5000 });
    expect(result).toEqual({ exitCode: null, timedOut: true, stdout: "", stderr: "exec timed out after 5000ms\n" });
  });

  it("starts a stopped machine and retries the command once", async () => {
    machines.exec
      .mockRejectedValueOnce(new sdk.ConflictError("VM paperclip-x is stopped, so it won't be resumed automatically.", 9))
      .mockResolvedValueOnce(execOk("ok\n"));
    const result = await hooks.onEnvironmentExecute?.({ ...base, config: { apiKey: "bxd_test" }, lease: lease(), command: "echo", args: ["ok"] });
    expect(machines.start).toHaveBeenCalledWith("vm-1");
    expect(machines.waitUntilReady).toHaveBeenCalledWith("vm-1", { timeout: 120000 });
    expect(result?.stdout).toBe("ok\n");
  });

  it("rejects an invalid env key", async () => {
    await expect(hooks.onEnvironmentExecute?.({ ...base, config: { apiKey: "bxd_test" }, lease: lease(), command: "true", env: { "BAD-KEY": "x" } }))
      .rejects.toThrow("Invalid sandbox environment variable key: BAD-KEY");
  });

  it.each([
    ["suspended", "resume"],
    ["hibernated", "wake"],
    ["stopped", "start"],
  ] as const)("resumes a %s machine with %s and keeps the provider lease id", async (status, method) => {
    machines.get.mockResolvedValue(machine({ status }));
    const result = await hooks.onEnvironmentResumeLease?.({
      ...base,
      config: { apiKey: "bxd_test", reuseLease: true },
      providerLeaseId: "vm-1",
      leaseMetadata: { remoteCwd: "/home/boxd/project" },
    });
    expect(machines[method]).toHaveBeenCalledWith("vm-1");
    expect(machines.waitUntilReady).toHaveBeenCalledWith("vm-1", { timeout: 120000 });
    expect(result?.providerLeaseId).toBe("vm-1");
    expect(result?.metadata).toMatchObject({ resumedLease: true, remoteCwd: "/home/boxd/project", reuseLease: true });
  });

  it("reports a missing machine as an expired lease", async () => {
    const result = await hooks.onEnvironmentResumeLease?.({ ...base, config: { apiKey: "bxd_test" }, providerLeaseId: "vm-gone" });
    expect(result).toEqual({ providerLeaseId: null, metadata: { expired: true } });
  });

  it("suspends a reused machine on release instead of deleting it", async () => {
    machines.get.mockResolvedValue(machine());
    const result = await hooks.onEnvironmentReleaseLease?.({ ...base, config: { apiKey: "bxd_test", reuseLease: true }, providerLeaseId: "vm-1" });
    expect(machines.pause).toHaveBeenCalledWith("vm-1");
    expect(machines.delete).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("deletes on release and returns a receipt only after the machine is gone", async () => {
    machines.get.mockResolvedValueOnce(machine()).mockRejectedValue(new sdk.NotFoundError("not found", 5));
    const result = await hooks.onEnvironmentReleaseLease?.({ ...base, config: { apiKey: "bxd_test" }, providerLeaseId: "vm-1" });
    expect(machines.delete).toHaveBeenCalledWith("vm-1");
    expect(machines.get).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ providerLeaseId: "vm-1", state: "destroyed" });
  });

  it("stops and retains files when the host asks for it", async () => {
    machines.get.mockResolvedValueOnce(machine()).mockResolvedValue(machine({ status: "stopped" }));
    const result = await hooks.onEnvironmentReleaseLease?.({
      ...base,
      config: { apiKey: "bxd_test" },
      providerLeaseId: "vm-1",
      resourceDisposition: "stop_and_retain",
    });
    expect(machines.stop).toHaveBeenCalledWith("vm-1");
    expect(machines.delete).not.toHaveBeenCalled();
    expect(result).toEqual({ providerLeaseId: "vm-1", state: "stopped" });
  });

  it("stops a reused machine when active work is cancelled", async () => {
    machines.get.mockResolvedValueOnce(machine()).mockResolvedValue(machine({ status: "stopped" }));
    const result = await hooks.onEnvironmentReleaseLease?.({
      ...base,
      config: { apiKey: "bxd_test", reuseLease: true },
      providerLeaseId: "vm-1",
      cancelActiveWork: true,
    });
    expect(machines.pause).not.toHaveBeenCalled();
    expect(result).toEqual({ providerLeaseId: "vm-1", state: "stopped" });
  });

  it("treats an already deleted machine as destroyed", async () => {
    machines.delete.mockRejectedValue(new sdk.NotFoundError("not found", 5));
    const result = await hooks.onEnvironmentDestroyLease?.({ ...base, config: { apiKey: "bxd_test" }, providerLeaseId: "vm-1" });
    expect(result).toEqual({ providerLeaseId: "vm-1", state: "destroyed" });
  });

  it.each([
    ["running", "active"],
    ["starting", "active"],
    ["suspended", "stopped"],
    ["hibernated", "stopped"],
    ["stopped", "stopped"],
    ["failed", "unknown"],
  ])("inspects a %s machine as %s", async (status, state) => {
    machines.get.mockResolvedValue(machine({ status }));
    expect(await hooks.onEnvironmentInspectLease?.({ ...base, config: { apiKey: "bxd_test" }, providerLeaseId: "vm-1" }))
      .toEqual({ providerLeaseId: "vm-1", state });
  });

  it("inspects a missing machine as destroyed and surfaces other errors", async () => {
    expect(await hooks.onEnvironmentInspectLease?.({ ...base, config: { apiKey: "bxd_test" }, providerLeaseId: "vm-1" }))
      .toEqual({ providerLeaseId: "vm-1", state: "destroyed" });
    machines.get.mockRejectedValue(new sdk.BoxdError("unavailable", 14));
    await expect(hooks.onEnvironmentInspectLease?.({ ...base, config: { apiKey: "bxd_test" }, providerLeaseId: "vm-1" }))
      .rejects.toThrow("unavailable");
  });

  it("probes with a throwaway machine that boxd deletes on a timer, and deletes it", async () => {
    const result = await hooks.onEnvironmentProbe?.({ ...base, config: { apiKey: "bxd_test" } });
    expect(result?.ok).toBe(true);
    expect(machines.create.mock.calls[0][0].name).toMatch(/^paperclip-probe-/);
    expect(machines.setDeleteAfter).toHaveBeenCalledWith("vm-1", 900);
    expect(machines.delete).toHaveBeenCalledWith("vm-1");
  });

  it("fails a probe whose machine could not be deleted", async () => {
    machines.delete.mockRejectedValue(new sdk.BoxdError("unavailable", 14));
    const result = await hooks.onEnvironmentProbe?.({ ...base, config: { apiKey: "bxd_test" } });
    expect(result).toMatchObject({
      ok: false,
      summary: "boxd environment probe could not delete its machine paperclip-env12345-run12345-abcd.",
      metadata: { machineId: "vm-1", cleanupError: "unavailable", remoteCwd: "/home/boxd/paperclip-workspace" },
    });
  });

  it("reports a probe failure without throwing", async () => {
    machines.create.mockRejectedValue(new sdk.BoxdError("quota exceeded", 8));
    const result = await hooks.onEnvironmentProbe?.({ ...base, config: { apiKey: "bxd_test" } });
    expect(result).toMatchObject({ ok: false, summary: "boxd environment probe failed.", metadata: { error: "quota exceeded" } });
  });
});
