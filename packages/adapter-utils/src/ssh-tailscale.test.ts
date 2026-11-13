import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSshSpawnTarget, parseSshRemoteExecutionSpec } from "./ssh.js";
import { buildRemoteExecutionSessionIdentity, remoteExecutionSessionMatches } from "./remote-managed-runtime.js";
import { normalizeAdapterExecutionTargetSessionIdentity } from "./execution-target.js";

const spec = { host: "workstation.tailnet.test", port: 22, username: "developer", remoteWorkspacePath: "/workspace",
  remoteCwd: "/workspace/task", privateKey: null, knownHosts: "host ssh-ed25519 fixture", strictHostKeyChecking: true };

describe("SSH task execution through Tailscale", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each(["/tmp/Paperclip tools/tailscale", "/tmp/tools%h/tailscale"])("uses the configured Tailscale executable without interpreting its path (%s)", async cli => {
    vi.stubEnv("PAPERCLIP_TAILSCALE_CLI", cli);
    const target = await buildSshSpawnTarget({ spec: { ...spec, tailscaleSocket: "/tmp/paperclip-ts-test/socket" }, command: "true", args: [], env: {} });
    try {
      expect(target.args).toContain(`ProxyCommand='${cli.replaceAll("%", "%%")}' --socket=/tmp/paperclip-ts-test/socket nc %h %p`);
    } finally { await target.cleanup(); }
  });
  it("uses the isolated tailnet socket for command execution while keeping host verification", async () => {
    const target = await buildSshSpawnTarget({ spec: { ...spec, tailscaleSocket: "/tmp/paperclip-ts-test/socket" }, command: "true", args: [], env: {} });
    try {
      expect(target.command).toBe("ssh");
      expect(target.args).toContain("ProxyCommand=tailscale --socket=/tmp/paperclip-ts-test/socket nc %h %p");
      expect(target.args).toContain("StrictHostKeyChecking=yes");
      expect(target.args).toContain("BatchMode=yes");
    } finally { await target.cleanup(); }
  });

  it("leaves direct SSH connections independent of Tailscale", async () => {
    const target = await buildSshSpawnTarget({ spec, command: "true", args: [], env: {} });
    try { expect(target.args.some(arg => arg.startsWith("ProxyCommand"))).toBe(false); }
    finally { await target.cleanup(); }
  });

  it.each(["/tmp/socket;touch bad", "/tmp/$(touch bad)", "relative/socket", "/tmp/socket%h"])("rejects unsafe socket %s", async tailscaleSocket => {
    await expect(buildSshSpawnTarget({ spec: { ...spec, tailscaleSocket }, command: "true", args: [], env: {} })).rejects.toThrow("Invalid Tailscale socket");
    expect(parseSshRemoteExecutionSpec({ ...spec, tailscaleSocket })).toBeNull();
  });

  it.each(["host;touch bad", "$(touch bad)", "-oProxyCommand=bad", "host%h"])("rejects host interpolation %s", async host => {
    await expect(buildSshSpawnTarget({ spec: { ...spec, host, tailscaleSocket: "/tmp/socket" }, command: "true", args: [], env: {} })).rejects.toThrow("Invalid Tailscale host");
  });

  it("preserves the transport through execution-spec parsing and isolates sessions across tailnets", () => {
    const tailscale = { ...spec, tailscaleSocket: "/tmp/socket", tailscaleIdentity: "company:connection-one" };
    expect(parseSshRemoteExecutionSpec(tailscale)).toEqual(tailscale);
    const saved = buildRemoteExecutionSessionIdentity(tailscale);
    expect(normalizeAdapterExecutionTargetSessionIdentity(saved)).toEqual(saved);
    expect(saved).not.toHaveProperty("tailscaleSocket");
    expect(remoteExecutionSessionMatches(saved, { ...tailscale, tailscaleSocket: "/tmp/restarted/socket" })).toBe(true);
    expect(remoteExecutionSessionMatches(saved, { ...tailscale, tailscaleIdentity: "company:connection-two" })).toBe(false);
    expect(remoteExecutionSessionMatches(saved, spec)).toBe(false);
  });
});
