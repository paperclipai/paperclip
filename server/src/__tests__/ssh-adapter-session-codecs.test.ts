import { describe, expect, it } from "vitest";
import { adapterExecutionTargetSessionIdentity, adapterExecutionTargetSessionMatches, type AdapterSshExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { getServerAdapter } from "../adapters/index.js";

describe("SSH adapter saved session identity", () => {
  it.each(["claude_local", "codex_local", "cursor", "gemini_local", "grok_local", "kimi_local", "opencode_local", "pi_local"])("keeps %s connection guards through persistence", adapterType => {
    const target: AdapterSshExecutionTarget = { kind: "remote", transport: "ssh", remoteCwd: "/remote/task",
      spec: { host: "ssh.example.test", port: 22, username: "fixture", remoteCwd: "/remote/task", remoteWorkspacePath: "/remote",
        useHostAuth: false, privateKey: null, knownHosts: null, strictHostKeyChecking: true } };
    const identity = adapterExecutionTargetSessionIdentity(target)!;
    const codec = getServerAdapter(adapterType).sessionCodec!;
    const stored = codec.serialize({ sessionId: "session-fixture", cwd: target.remoteCwd,
      remoteExecution: { ...identity, privateKey: "credential-canary", tailscaleSocket: "/private/socket" } });
    const restored = codec.deserialize(JSON.parse(JSON.stringify(stored)))!;
    expect(restored.remoteExecution).toEqual(identity);
    expect(adapterExecutionTargetSessionMatches(restored.remoteExecution, target)).toBe(true);
    expect(adapterExecutionTargetSessionMatches(restored.remoteExecution, { ...target, spec: { ...target.spec, host: "other.example.test" } })).toBe(false);
    const legacy = codec.deserialize({ sessionId: "session-fixture", cwd: target.remoteCwd })!;
    expect(legacy.remoteExecution).toBeUndefined();
    expect(adapterExecutionTargetSessionMatches(legacy.remoteExecution, target)).toBe(false);
  });
});
