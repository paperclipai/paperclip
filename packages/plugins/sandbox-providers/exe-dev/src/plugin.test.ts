import { beforeEach, describe, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ ssh: vi.fn(), openSsh: vi.fn() }));
vi.mock("./transport.js", () => ({ ...transport, quote: (value: string) => `'${value.replace(/'/g, `'"'"'`)}'` }));
import plugin, { parseConfig, validateSshPrivateKey } from "./plugin.js";
import manifest from "./manifest.js";
const hooks = plugin.definition;
const config = { reuseLease: true, mode: "attach", vmName: "test-box", sshIdentityFile: "/keys/exe" };
const params = { driverKey: "exe-dev", companyId: "company", environmentId: "environment", config };
const bindingId = "00000000-0000-4000-8000-000000000001";
const image = { schema: 1, sourceRevision: "abc123", contentId: "content" };
let vmExists = true;
let privateVm = true;
let scope = "";
beforeEach(async () => {
  await hooks.onShutdown?.();
  vmExists = true; privateVm = true; scope = "";
  transport.ssh.mockReset(); transport.openSsh.mockReset();
  transport.ssh.mockImplementation(async (_config, host, command) => {
    if (host === "exe.dev") {
      if (command.startsWith("ls")) return JSON.stringify({ vms: vmExists ? [{ vm_name: "test-box", proxy_share: privateVm ? "private" : "public" }] : [] });
      if (command.startsWith("new")) { vmExists = true; return "{}"; }
      throw Error(`Unexpected management command: ${command}`);
    }
    if (command.includes("image.json")) return JSON.stringify(image);
    if (command.includes("paperclip-exe-claim.lock")) {
      scope = command.match(/scope:[^a-f0-9]*([a-f0-9]{32})/)?.[1] ?? "";
      return bindingId;
    }
    if (command.includes("cat /var/lib/paperclip-exe/binding.json")) return JSON.stringify({ id: bindingId, scope });
    return "";
  });
});
const acquire = (runId = "run") => hooks.onEnvironmentAcquireLease!({ ...params, runId, agentId: runId });

describe("durable exe.dev lifecycle", () => {
  it("allocates independent leases on one VM without provisioning per run", async () => {
    const [a, b] = await Promise.all([acquire("a"), acquire("b")]);
    expect(a.providerLeaseId).not.toBe(b.providerLeaseId);
    expect(a.metadata?.vmName).toBe("test-box");
    expect(a.metadata?.remoteCwd).not.toBe(b.metadata?.remoteCwd);
    expect(a.metadata?.remoteHome).not.toBe(b.metadata?.remoteHome);
    expect(transport.ssh.mock.calls.some(([, host, cmd]) => host === "exe.dev" && !cmd.startsWith("ls"))).toBe(false);
  });
  it("normal release retains the VM and warm processes", async () => {
    const lease = await acquire(); transport.ssh.mockClear();
    await hooks.onEnvironmentReleaseLease!({ ...params, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata });
    expect(transport.ssh).not.toHaveBeenCalled();
  });
  it("destroy confirms only the lease cgroup stopped and never deletes a VM", async () => {
    const lease = await acquire(); transport.ssh.mockClear();
    const receipt = await hooks.onEnvironmentDestroyLease!({ ...params, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata });
    expect(receipt).toEqual({ providerLeaseId: lease.providerLeaseId, state: "stopped" });
    expect(transport.ssh.mock.calls.some(([, , cmd]) => cmd.includes("systemctl stop"))).toBe(true);
    expect(transport.ssh.mock.calls.some(([, host]) => host === "exe.dev")).toBe(false);
  });
  it("does not issue a termination receipt after transport loss", async () => {
    const lease = await acquire();
    transport.ssh.mockRejectedValueOnce(new Error("connection lost"));
    await expect(hooks.onEnvironmentDestroyLease!({ ...params, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata })).rejects.toThrow("connection lost");
  });
  it("rejects a foreign-company lease before contacting the VM", async () => {
    const lease = await acquire(); transport.ssh.mockClear();
    await expect(hooks.onEnvironmentDestroyLease!({ ...params, companyId: "other", providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata })).rejects.toThrow("does not belong");
    expect(transport.ssh).not.toHaveBeenCalled();
  });
  it("rejects replacement of a VM with the same DNS name", async () => {
    const lease = await acquire();
    const original = transport.ssh.getMockImplementation()!;
    transport.ssh.mockImplementation((...args) => String(args[2]).includes("cat /var/lib/paperclip-exe/binding.json") ? JSON.stringify({ id: "replacement", scope }) : original(...args));
    await expect(hooks.onEnvironmentResumeLease!({ ...params, providerLeaseId: lease.providerLeaseId!, leaseMetadata: lease.metadata })).rejects.toThrow("identity changed");
  });
  it("resumes the same workspace and home", async () => {
    const lease = await acquire();
    const resumed = await hooks.onEnvironmentResumeLease!({ ...params, providerLeaseId: lease.providerLeaseId!, leaseMetadata: lease.metadata });
    expect(resumed.providerLeaseId).toBe(lease.providerLeaseId);
    expect(resumed.metadata?.remoteCwd).toBe(lease.metadata?.remoteCwd);
    expect(resumed.metadata?.resumedLease).toBe(true);
  });
  it("probes without allocating, claiming, or deleting resources", async () => {
    expect((await hooks.onEnvironmentProbe!(params)).ok).toBe(true);
    expect(transport.ssh).toHaveBeenCalledTimes(2);
    expect(transport.ssh.mock.calls.some(([, , cmd]) => /new |rm |flock|systemd-run/.test(cmd))).toBe(false);
  });
  it("does not provision in response to a missing-VM probe", async () => {
    vmExists = false;
    expect((await hooks.onEnvironmentProbe!(params)).ok).toBe(false);
    expect(transport.ssh).toHaveBeenCalledTimes(1);
  });
  it("rejects publicly shared preview URLs", async () => {
    privateVm = false;
    await expect(acquire()).rejects.toThrow("private HTTP");
  });
  it("rechecks private sharing on resume", async () => {
    const lease = await acquire(); privateVm = false;
    await expect(hooks.onEnvironmentResumeLease!({ ...params, providerLeaseId: lease.providerLeaseId!, leaseMetadata: lease.metadata })).rejects.toThrow("private HTTP");
  });
  it("never replaces a missing VM after a durable identity is recorded", async () => {
    const lease = await acquire(); vmExists = false; transport.ssh.mockClear();
    await expect(hooks.onEnvironmentAcquireLease!({ ...params, runId: "replacement", config: { ...config, mode: "create", image: `ghcr.io/example/exe@sha256:${"a".repeat(64)}` }, resourceBinding: lease.metadata?.environmentResourceBinding as any })).rejects.toThrow("no automatic replacement");
    expect(transport.ssh.mock.calls.every(([, , cmd]) => cmd.startsWith("ls"))).toBe(true);
  });
  it("creates from a digest and reconciles the stable name", async () => {
    vmExists = false;
    await hooks.onEnvironmentAcquireLease!({ ...params, runId: "a", config: { ...config, mode: "create", image: `ghcr.io/example/exe@sha256:${"a".repeat(64)}` } });
    const command = transport.ssh.mock.calls.find(([, host, cmd]) => host === "exe.dev" && cmd.startsWith("new"))?.[2];
    expect(command).toContain("--name='test-box'");
    expect(command).not.toContain("setup-script");
    expect(command).not.toContain("prompt");
  });
  it("preserves the image digest when the host overlays lease metadata onto configuration", async () => {
    const createConfig = { ...config, mode: "create", image: `ghcr.io/example/exe@sha256:${"a".repeat(64)}` };
    const lease = await hooks.onEnvironmentAcquireLease!({ ...params, config: createConfig, runId: "a" });
    const realized = await hooks.onEnvironmentRealizeWorkspace!({ ...params, config: { ...createConfig, ...lease.metadata }, lease, workspace: {} });
    expect(realized.cwd).toBe(lease.metadata?.remoteCwd);
    expect(lease.metadata?.exeImageProvenance).toEqual(image);
  });
  it("bounds the cgroup, never the durable disk, by a lease deadline", async () => {
    const expiresAt = new Date(Date.now() + 60000).toISOString();
    const lease = await hooks.onEnvironmentAcquireLease!({ ...params, runId: "a", requestedExpiresAt: expiresAt });
    expect(lease.expiresAt).toBe(expiresAt);
    expect(transport.ssh.mock.calls.some(([, , cmd]) => cmd.includes("RuntimeMaxSec="))).toBe(true);
  });
});

describe("configuration and capability contract", () => {
  it.each([
    { mode: "attach", vmName: "-oProxyCommand=evil" },
    { mode: "create", image: "ubuntu:latest" },
    { strictHostKeyChecking: "no" },
    { setupScript: "curl install | sh" },
    { timeoutMs: NaN },
  ])("rejects unsafe or incompatible configuration %j", (patch) => {
    expect(() => parseConfig({ ...config, ...patch })).toThrow();
  });
  it("requires explicit migration of old per-run environments", () => {
    expect(() => parseConfig({ apiKey: "old-api-key", sshIdentityFile: "/key" })).toThrow("migrated explicitly");
  });
  it("advertises only implemented capabilities", () => {
    const capabilities = manifest.environmentDrivers![0].sandboxCapabilities!;
    expect(capabilities.duplexCommandStream).toBe(true);
    expect(capabilities.runnerWebSocketIngress).toBe(false);
    expect(capabilities.nativeSyncIn).toBe(false);
    expect(capabilities.nativeSyncOut).toBe(false);
  });
  it("rejects pasted public keys and truncated private keys", () => {
    expect(validateSshPrivateKey("ssh-ed25519 AAAA public")).toContain("PUBLIC");
    expect(validateSshPrivateKey("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA")).toContain("footer");
  });
});
