import { describe, expect, it } from "vitest";
import { parseSshRemoteExecutionSpec } from "./ssh.js";
import { buildRemoteExecutionSessionIdentity, remoteExecutionSessionMatches } from "./remote-managed-runtime.js";

const spec = { host: "ssh.example.test", port: 22, username: "fixture", remoteCwd: "/workspace", remoteWorkspacePath: "/workspace", privateKey: null, knownHosts: null, strictHostKeyChecking: true };

describe("SSH authentication source", () => {
  it.each([undefined, true, false])("preserves the SSH authentication option through target parsing (%s)", useHostAuth => {
    const target = { ...spec, ...(useHostAuth !== undefined ? { useHostAuth } : {}) };
    expect(parseSshRemoteExecutionSpec(target)).toEqual(target);
    expect(parseSshRemoteExecutionSpec({ ...spec, useHostAuth: "false" })).toBeNull();
  });
  it("starts a fresh SSH session when its authentication source changes", () => {
    const saved = buildRemoteExecutionSessionIdentity(spec);
    expect(remoteExecutionSessionMatches(saved, { ...spec })).toBe(true);
    expect(remoteExecutionSessionMatches(saved, { ...spec, useHostAuth: false })).toBe(false);
    const configured = buildRemoteExecutionSessionIdentity({ ...spec, useHostAuth: false });
    expect(remoteExecutionSessionMatches(configured, { ...spec, useHostAuth: false })).toBe(true);
    expect(remoteExecutionSessionMatches(configured, { ...spec, useHostAuth: true })).toBe(false);
  });

});
