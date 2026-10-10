import { beforeEach, describe, expect, it, vi } from "vitest";

const { create, connect } = vi.hoisted(() => ({ create: vi.fn(), connect: vi.fn() }));
vi.mock("smolmachines", () => ({
  Machine: { create, connect },
  SmolError: class SmolError extends Error { constructor(public code: string, message: string) { super(message); } },
}));
import plugin from "./plugin.js";

function machine() {
  return {
    name: "paperclip-123",
    exec: vi.fn().mockImplementation(async (command: string[]) => ({ exitCode: 0, stdout: command[0] === "sh" ? "/home/paperclip" : "", stderr: "" })),
    writeFile: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

const base = { driverKey: "smolmachines", companyId: "company-1", environmentId: "env-1" };
const acquireParams = { ...base, runId: "run-1", adapterType: "codex_local", config: { target: "local", reuseLease: false } };

beforeEach(() => {
  create.mockReset(); connect.mockReset();
});

describe("Smol Machines provider", () => {
  it("validates numeric resources and target", async () => {
    expect(await plugin.definition.onEnvironmentValidateConfig?.({ driverKey: "smolmachines", config: { target: "wrong", cpus: 1.2, ttlSeconds: 30 } })).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringContaining("target"), expect.stringContaining("cpus"), expect.stringContaining("ttlSeconds")]) });
  });

  it("creates a detached VM with no host mounts and deletes it on release", async () => {
    const vm = machine(); create.mockResolvedValue(vm); connect.mockResolvedValue(vm);
    const lease = await plugin.definition.onEnvironmentAcquireLease?.(acquireParams);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      image: "ghcr.io/paperclipai/agent-runtime-codex:git-38d8f371722b315d2fb3bbaa512518742e33ce2f", detach: true, persistent: true,
      labels: expect.objectContaining({ runId: "run-1" }),
      resources: expect.objectContaining({ network: true }),
    }), expect.objectContaining({ target: "local", handleSignals: false }));
    expect(create.mock.calls[0]?.[0]?.mounts).toBeUndefined();
    expect(lease?.providerLeaseId).toBe("paperclip-123");
    expect(lease?.metadata?.remoteCwd).toBe("/home/paperclip/paperclip-workspace");
    await plugin.definition.onEnvironmentReleaseLease?.({ ...base, config: acquireParams.config, providerLeaseId: lease!.providerLeaseId, leaseMetadata: lease!.metadata });
    expect(vm.delete).toHaveBeenCalledTimes(1);
    expect(vm.stop).not.toHaveBeenCalled();
  });

  it("removes a failed acquisition and does not guess an unpublished runtime image", async () => {
    const vm = machine(); create.mockResolvedValue(vm);
    vm.exec.mockResolvedValueOnce({ exitCode: 0, stdout: "/home/paperclip", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "home is read-only" });
    await expect(plugin.definition.onEnvironmentAcquireLease?.(acquireParams)).rejects.toThrow("home is read-only");
    expect(vm.delete).toHaveBeenCalledTimes(1);
    create.mockClear();
    await expect(plugin.definition.onEnvironmentAcquireLease?.({ ...acquireParams, adapterType: "cursor_local" })).rejects.toThrow("set image");
    expect(create).not.toHaveBeenCalled();
  });

  it("stages stdin, uses argument arrays, forwards env and cwd, and removes stdin", async () => {
    const vm = machine(); connect.mockResolvedValue(vm);
    vm.exec.mockResolvedValueOnce({ exitCode: 0, stdout: "/home/paperclip", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 7, stdout: "out", stderr: "err" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const result = await plugin.definition.onEnvironmentExecute?.({ ...base, config: { target: "cloud" }, lease: { providerLeaseId: "mach-123", metadata: { target: "cloud" } }, command: "printf", args: ["%s", "a';$(exit 1)"], cwd: "/workspace/paperclip-workspace", env: { HELLO: "world" }, stdin: "input", timeoutMs: 1500 });
    expect(result).toMatchObject({ exitCode: 7, stdout: "out", stderr: "err", timedOut: false });
    expect(vm.writeFile).toHaveBeenCalledWith(expect.stringMatching(/^\/home\/paperclip\/\.paperclip-stdin-/), "input");
    expect(vm.exec.mock.calls[1]?.[0]).toEqual(["sh", "-c", expect.stringContaining('exec "$@" < '), "sh", "printf", "%s", "a';$(exit 1)"]);
    expect(vm.exec.mock.calls[1]?.[1]).toMatchObject({ workdir: "/workspace/paperclip-workspace", env: { HELLO: "world" }, timeout: 2 });
    expect(vm.exec.mock.calls[2]?.[0]).toEqual(["rm", "-f", "--", expect.stringMatching(/^\/home\/paperclip\/\.paperclip-stdin-/)]);
  });

  it("returns full Cloud output when convenience text is truncated", async () => {
    const vm = machine(); connect.mockResolvedValue(vm);
    vm.exec.mockResolvedValueOnce({
      exitCode: 0, stdout: "prefix", stderr: "prefix-error", stdoutTruncated: true,
      stderrTruncated: true, stdoutBytes: Buffer.from("complete output"),
      stderrBytes: Buffer.from("complete error"),
    });
    const result = await plugin.definition.onEnvironmentExecute?.({
      ...base, config: { target: "cloud" },
      lease: { providerLeaseId: "mach-123", metadata: { target: "cloud" } },
      command: "printf", args: ["%s", "complete output"],
    });
    expect(result).toMatchObject({ stdout: "complete output", stderr: "complete error" });
  });

  it("removes a partially uploaded stdin file without hiding the upload error", async () => {
    const vm = machine(); connect.mockResolvedValue(vm);
    vm.writeFile.mockRejectedValueOnce(new Error("partial upload failed"));
    await expect(plugin.definition.onEnvironmentExecute?.({
      ...base, config: { target: "cloud" },
      lease: { providerLeaseId: "mach-123", metadata: { target: "cloud" } },
      command: "cat", stdin: "sensitive input",
    })).rejects.toThrow("partial upload failed");
    expect(vm.exec.mock.calls[1]?.[0]).toEqual(["rm", "-f", "--", expect.stringMatching(/^\/home\/paperclip\/\.paperclip-stdin-/)]);
  });

  it("stops a reusable Cloud lease and starts it on resume", async () => {
    const vm = machine(); create.mockResolvedValue(vm); connect.mockResolvedValue(vm);
    const config = { target: "cloud", reuseLease: true, ttlSeconds: 3600 };
    const lease = await plugin.definition.onEnvironmentAcquireLease?.({ ...acquireParams, config, requestedExpiresAt: new Date(Date.now() + 120_000).toISOString() });
    expect(lease?.expiresAt).toBeDefined();
    expect(create.mock.calls[0]?.[0]).toMatchObject({ ttlSeconds: expect.any(Number) });
    await plugin.definition.onEnvironmentReleaseLease?.({ ...base, config, providerLeaseId: lease!.providerLeaseId, leaseMetadata: lease!.metadata });
    expect(vm.stop).toHaveBeenCalledTimes(1);
    await plugin.definition.onEnvironmentResumeLease?.({ ...base, config, providerLeaseId: lease!.providerLeaseId!, leaseMetadata: lease!.metadata });
    expect(vm.start).toHaveBeenCalledTimes(1);
  });

  it("keeps Cloud expiry across resume and refuses expired leases", async () => {
    const vm = machine(); create.mockResolvedValue(vm); connect.mockResolvedValue(vm);
    const config = { target: "cloud", ttlSeconds: 600 };
    const lease = await plugin.definition.onEnvironmentAcquireLease?.({ ...acquireParams, config });
    const resumed = await plugin.definition.onEnvironmentResumeLease?.({ ...base, config, providerLeaseId: lease!.providerLeaseId!, leaseMetadata: lease!.metadata });
    expect(resumed?.expiresAt).toBe(lease?.expiresAt);
    connect.mockClear();
    const expired = await plugin.definition.onEnvironmentResumeLease?.({ ...base, config, providerLeaseId: lease!.providerLeaseId!, leaseMetadata: { ...lease!.metadata, expiresAt: new Date(0).toISOString() } });
    expect(expired).toMatchObject({ providerLeaseId: null, metadata: { expired: true } });
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects local leases with a requested expiry before creating a VM", async () => {
    await expect(plugin.definition.onEnvironmentAcquireLease?.({ ...acquireParams, requestedExpiresAt: new Date(Date.now() + 120_000).toISOString() })).rejects.toThrow("cannot guarantee");
    expect(create).not.toHaveBeenCalled();
  });
});
