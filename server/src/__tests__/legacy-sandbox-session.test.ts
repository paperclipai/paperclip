import { describe, expect, it } from "vitest";
import { sessionCodec as codex } from "@paperclipai/adapter-codex-local/server";
import { sessionCodec as claude, claudeSessionMcpServersMatch } from "@paperclipai/adapter-claude-local/server";
import { adapterExecutionTargetSessionIdentity, adapterExecutionTargetSessionMatches, type AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { recoverLegacySandboxSession } from "../services/legacy-sandbox-session.js";

const target: AdapterSandboxExecutionTarget = {
  kind: "remote", transport: "sandbox", providerKey: "daytona", environmentId: "env",
  leaseId: "new-run-lease", remoteCwd: "/home/daytona/repos/main",
  sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: "physical-sandbox" },
};
function fixture(): Parameters<typeof recoverLegacySandboxSession>[0] {
  return {
    adapterType: "codex_local", params: { sessionId: "conversation", cwd: target.remoteCwd }, target,
    companyId: "company", agentId: "agent", taskId: "task", responsibleUserId: "user",
    executionWorkspaceId: "workspace",
    previousRun: {
      companyId: "company", agentId: "agent", responsibleUserId: "user", status: "succeeded",
      sessionIdAfter: "conversation", contextSnapshot: {
        taskId: "task", executionWorkspaceId: "workspace",
        paperclipEnvironment: {
          driver: "sandbox", id: "env", leaseId: "old-run-lease", remoteCwd: target.remoteCwd,
          workspaceRealization: { provider: "daytona", providerLeaseId: "physical-sandbox" },
        },
      },
    },
  };
}

describe("legacy sandbox conversation persistence", () => {
  it("migrates only the built-in MCP server for a host-verified old Claude session", () => {
    const input = fixture(); input.adapterType = "claude_local";
    const recovered = recoverLegacySandboxSession(input)!;
    expect(recovered.legacyPlatformMcpSession).toBe(true);
    const match = { savedIdentity: "", currentIdentity: "current", currentConnectionIds: ["paperclip-runtime-tools"], legacyPlatformSession: true };
    expect(claudeSessionMcpServersMatch(match)).toBe(true);
    expect(claudeSessionMcpServersMatch({ ...match, legacyPlatformSession: false })).toBe(false);
    expect(claudeSessionMcpServersMatch({ ...match, currentConnectionIds: ["external"] })).toBe(false);
    expect(claudeSessionMcpServersMatch({ ...match, savedIdentity: "old" })).toBe(false);
    const persisted = claude.serialize({ ...recovered, mcpServerIdentity: "current" });
    expect(persisted?.legacyPlatformMcpSession).toBeUndefined();
    expect(claude.deserialize(persisted)?.mcpServerIdentity).toBe("current");
    expect(claudeSessionMcpServersMatch({ ...match, savedIdentity: "current", legacyPlatformSession: false })).toBe(true);
  });
  for (const [name, codec] of [["codex_local", codex], ["claude_local", claude]] as const) {
    it(`${name} recovers old metadata, persists it, and resumes across host leases`, () => {
      const input = fixture(); input.adapterType = name;
      const recovered = recoverLegacySandboxSession(input);
      const next = codec.deserialize(codec.serialize(recovered));
      expect(next?.sessionId).toBe("conversation");
      expect(next?.remoteExecution).toEqual(adapterExecutionTargetSessionIdentity(target));
      expect(adapterExecutionTargetSessionMatches(next?.remoteExecution, { ...target, leaseId: "third-run-lease" })).toBe(true);
      expect(adapterExecutionTargetSessionMatches(next?.remoteExecution, { ...target,
        sandboxLeaseAcquisition: { outcome: "replacement", providerLeaseId: "another-sandbox" },
      })).toBe(false);
      expect(adapterExecutionTargetSessionMatches(next?.remoteExecution, { ...target, environmentId: "other-env" })).toBe(false);
      expect(adapterExecutionTargetSessionMatches(next?.remoteExecution, { ...target, remoteCwd: "/other" })).toBe(false);
      expect(adapterExecutionTargetSessionMatches(next?.remoteExecution, { kind: "local" })).toBe(false);
    });

    it(`${name} retains SSH identity and leaves local sessions unchanged`, () => {
      const local = { sessionId: "local-session", cwd: "/tmp/work" };
      expect(codec.deserialize(codec.serialize(local))).toEqual(local);
      const remoteExecution = { transport: "ssh", host: "host", username: "user", port: 22, remoteCwd: "/work" };
      expect(codec.deserialize(codec.serialize({ ...local, remoteExecution: { ...remoteExecution, secret: "discard-me" } }))?.remoteExecution).toEqual(remoteExecution);
      expect(adapterExecutionTargetSessionMatches(codec.serialize({ ...local, remoteExecution: {} })?.remoteExecution, { kind: "local" })).toBe(false);
    });
  }

  for (const field of ["companyId", "agentId", "taskId", "responsibleUserId", "executionWorkspaceId"] as const) {
    it(`does not recover across a different ${field}`, () => {
      const input = fixture(); input[field] = "another";
      expect(recoverLegacySandboxSession(input)).toBe(input.params);
    });
  }
  it("does not invent a resume after replacement, a changed cwd, an unknown run, or an explicit identity", () => {
    for (const mutate of [
      (input: ReturnType<typeof fixture>) => { input.target = { ...target, sandboxLeaseAcquisition: { outcome: "replacement", providerLeaseId: "physical-sandbox" } }; },
      (input: ReturnType<typeof fixture>) => { input.target = { ...target, sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: "other" } }; },
      (input: ReturnType<typeof fixture>) => { input.params!.cwd = "/other"; },
      (input: ReturnType<typeof fixture>) => { input.previousRun = null; },
      (input: ReturnType<typeof fixture>) => { input.previousRun!.sessionIdAfter = "other"; },
      (input: ReturnType<typeof fixture>) => { input.previousRun!.status = "failed"; },
      (input: ReturnType<typeof fixture>) => { input.params!.remoteExecution = { transport: "ssh" }; },
      (input: ReturnType<typeof fixture>) => { input.params!.remoteExecution = { transport: "sandbox", leaseId: "foreign" }; },
      (input: ReturnType<typeof fixture>) => { input.target = { kind: "local" }; },
    ]) {
      const input = fixture(); mutate(input);
      expect(recoverLegacySandboxSession(input)).toBe(input.params);
    }
  });
  it.each(["codex_local", "claude_local"])("recovers %s host cwd only from the exact recorded workspace", (adapterType) => {
    const input = fixture(); input.adapterType = adapterType;
    input.params = { ...input.params, cwd: "/host/project", workspaceId: "project-workspace" };
    const context = input.previousRun!.contextSnapshot as Record<string, any>;
    context.paperclipWorkspace = { cwd: "/host/project", workspaceId: "project-workspace" };
    context.paperclipEnvironment.workspaceRealization.local = { path: "/host/project", projectWorkspaceId: "project-workspace" };
    expect(recoverLegacySandboxSession(input)).toMatchObject({ cwd: target.remoteCwd, remoteExecution: adapterExecutionTargetSessionIdentity(target) });
    for (const mutate of [
      (copy: typeof input) => { copy.params!.cwd = "/another/project"; },
      (copy: typeof input) => { copy.params!.workspaceId = "another-workspace"; },
      (copy: typeof input) => { delete (copy.previousRun!.contextSnapshot as any).paperclipWorkspace; },
      (copy: typeof input) => { (copy.previousRun!.contextSnapshot as any).paperclipEnvironment.workspaceRealization.local.path = "/another/project"; },
      (copy: typeof input) => { (copy.previousRun!.contextSnapshot as any).paperclipEnvironment.remoteCwd = "/another/remote"; },
    ]) {
      const changed = structuredClone(input); mutate(changed);
      expect(recoverLegacySandboxSession(changed)).toBe(changed.params);
    }
  });

  it("keeps legacy host-lease matching when no physical identity is available", () => {
    const oldTarget = { ...target, sandboxLeaseAcquisition: undefined };
    const saved = adapterExecutionTargetSessionIdentity(oldTarget);
    expect(adapterExecutionTargetSessionMatches(saved, oldTarget)).toBe(true);
    expect(adapterExecutionTargetSessionMatches(saved, { ...oldTarget, leaseId: "other" })).toBe(false);
  });
});
