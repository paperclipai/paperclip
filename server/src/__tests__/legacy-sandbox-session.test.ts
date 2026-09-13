import { describe, expect, it } from "vitest";
import { sessionCodec as codex } from "@paperclipai/adapter-codex-local/server";
import { sessionCodec as claude, claudeSessionMcpServersMatch } from "@paperclipai/adapter-claude-local/server";
import { adapterExecutionTargetSessionIdentity, adapterExecutionTargetSessionMatches, type AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { recoverLegacySandboxSession, recoverLegacyClaudeMcpIdentity } from "../services/legacy-sandbox-session.js";

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
    const match = { savedIdentity: "", currentIdentity: JSON.stringify([{ name: "Paperclip connections", url: "https://paperclip.test/mcp/runtime-tools", connectionId: "paperclip-runtime-tools" }]), currentConnectionIds: ["paperclip-runtime-tools"], legacyPlatformSession: true, paperclipApiUrl: "https://paperclip.test" };
    expect(claudeSessionMcpServersMatch(match)).toBe(true);
    expect(claudeSessionMcpServersMatch({ ...match, legacyPlatformSession: false })).toBe(false);
    expect(claudeSessionMcpServersMatch({ ...match, currentConnectionIds: ["external"] })).toBe(false);
    expect(claudeSessionMcpServersMatch({ ...match, savedIdentity: "old" })).toBe(false);
    const persisted = claude.serialize({ ...recovered, mcpServerIdentity: "current" });
    expect(persisted?.legacyPlatformMcpSession).toBeUndefined();
    expect(claude.deserialize(persisted)?.mcpServerIdentity).toBe("current");
    expect(claudeSessionMcpServersMatch({ ...match, savedIdentity: match.currentIdentity, legacyPlatformSession: false })).toBe(true);
  });
  it("ignores only exact host-owned MCP additions while retaining external identities", () => {
    const external = { name: "paperclip-assigned", url: "https://paperclip.test/mcp/gateways/gw_one", connectionId: "assignment:digest" };
    const builtin = { name: "Paperclip projects", url: "https://paperclip.test/api/mcp/project-tools", connectionId: "paperclip-project-tools" };
    const input = { savedIdentity: JSON.stringify([external]), currentIdentity: JSON.stringify([builtin, external]), currentConnectionIds: [builtin.connectionId, external.connectionId], legacyPlatformSession: false, paperclipApiUrl: "https://paperclip.test", sandboxUpgrade: true };
    expect(claudeSessionMcpServersMatch(input)).toBe(true);
    expect(claudeSessionMcpServersMatch({ ...input, sandboxUpgrade: false })).toBe(false);
    for (const changed of [
      { ...builtin, url: "https://foreign.test/api/mcp/project-tools" },
      { ...builtin, url: builtin.url + "?redirect=evil" },
      { ...builtin, connectionId: "external" },
      { ...builtin, name: "External tool" },
    ]) expect(claudeSessionMcpServersMatch({ ...input, currentIdentity: JSON.stringify([changed, external]) })).toBe(false);
    expect(claudeSessionMcpServersMatch({ ...input, currentIdentity: JSON.stringify([builtin, { ...external, connectionId: "assignment:revoked" }]) })).toBe(false);
    expect(claudeSessionMcpServersMatch({ ...input, currentIdentity: JSON.stringify([builtin, { ...external, url: "https://foreign.test/mcp/gateways/gw_one" }]) })).toBe(false);
    expect(claudeSessionMcpServersMatch({ ...input, currentIdentity: JSON.stringify([builtin]) })).toBe(false);
    expect(claudeSessionMcpServersMatch({ ...input, savedIdentity: "", legacyPlatformSession: true })).toBe(false);
    expect(claudeSessionMcpServersMatch({ ...input, savedIdentity: "malformed" })).toBe(false);
  });

  it("matches reordered sandbox external MCP identities without losing duplicate multiplicity", () => {
    const first = { name: "First tool", url: "https://tools.test/first", connectionId: "external:first" };
    const second = { name: "Second tool", url: "https://tools.test/second", connectionId: "external:second" };
    const builtin = { name: "Paperclip projects", url: "https://paperclip.test/api/mcp/project-tools", connectionId: "paperclip-project-tools" };
    const input = { savedIdentity: JSON.stringify([first, second]), currentIdentity: JSON.stringify([second, builtin, first]),
      currentConnectionIds: [second.connectionId, builtin.connectionId, first.connectionId], legacyPlatformSession: false,
      paperclipApiUrl: "https://paperclip.test", sandboxUpgrade: true };
    expect(claudeSessionMcpServersMatch(input)).toBe(true);
    expect(claudeSessionMcpServersMatch({ ...input, sandboxUpgrade: false })).toBe(false);
    expect(claudeSessionMcpServersMatch({ ...input, currentIdentity: JSON.stringify([
      { connectionId: second.connectionId, url: second.url, name: second.name }, builtin, first,
    ]) })).toBe(true);
    for (const entries of [
      [second, builtin],
      [second, builtin, first, first],
      [second, builtin, { ...first, url: "https://foreign.test/first" }],
      [second, builtin, { ...first, name: "Changed tool" }],
      [second, builtin, { ...first, connectionId: "external:replacement" }],
      [second, builtin, { ...first, permissionScope: "unknown" }],
    ]) expect(claudeSessionMcpServersMatch({ ...input, currentIdentity: JSON.stringify(entries) })).toBe(false);
    expect(claudeSessionMcpServersMatch({ ...input, savedIdentity: JSON.stringify([first, first, second]) })).toBe(false);
    expect(claudeSessionMcpServersMatch({ ...input, savedIdentity: JSON.stringify([{ ...first, permissionScope: "unknown" }, second]) })).toBe(false);
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

  it("recovers historical host cwd after work folders recorded the remote workspace cwd", () => {
    const input = fixture(); input.adapterType = "claude_local";
    input.params = { ...input.params, cwd: "/host/project", workspaceId: "project-workspace" };
    const context = input.previousRun!.contextSnapshot as Record<string, any>;
    context.paperclipWorkspace = { cwd: target.remoteCwd, workspaceId: "project-workspace" };
    context.paperclipEnvironment.workspaceRealization.local = { path: "/host/project", projectWorkspaceId: "project-workspace" };
    expect(recoverLegacySandboxSession(input)).toMatchObject({ cwd: target.remoteCwd, legacyPlatformMcpSession: true });
    context.paperclipWorkspace.cwd = "/another/remote";
    expect(recoverLegacySandboxSession(input)).toBe(input.params);
  });

  it("reconstructs a discarded MCP identity only from the same successful run's host evidence", () => {
    const params = recoverLegacySandboxSession({ ...fixture(), adapterType: "claude_local" })!;
    const input = { params, previousRunId: "old-run", companyId: "company", agentId: "agent", taskId: "task", paperclipApiUrl: "https://paperclip.test",
      invocations: [{ payload: { adapterType: "claude_local", context: { taskId: "task" }, env: { PAPERCLIP_GITHUB_BROKER_URL: "https://paperclip.test", PAPERCLIP_API_URL: "http://127.0.0.1:32123" }, commandNotes: ["Using 2 Paperclip-managed MCP server(s) from strict config /remote/mcp.json."] } }],
      gateways: [{ companyId: "company", gatewayCompanyId: "company", subjectType: "heartbeat_run", subjectId: "old-run", createdByAgentId: "agent", gatewayPublicId: "gw_" + "a".repeat(32), metadata: { agentId: "agent", nativeRuntimeAssignmentDigest: "b".repeat(64) } }],
    };
    const failed = recoverLegacyClaudeMcpIdentity({ ...input, gateways: [] });
    const builtin = { name: "Paperclip connections", url: "https://paperclip.test/mcp/runtime-tools", connectionId: "paperclip-runtime-tools" };
    expect(claudeSessionMcpServersMatch({ savedIdentity: "", currentIdentity: JSON.stringify([builtin]),
      currentConnectionIds: [builtin.connectionId], legacyPlatformSession: failed.legacyPlatformMcpSession === true,
      paperclipApiUrl: input.paperclipApiUrl, sandboxUpgrade: true })).toBe(false);
    expect(claudeSessionMcpServersMatch({ savedIdentity: "", currentIdentity: "[]", currentConnectionIds: [],
      legacyPlatformSession: failed.legacyPlatformMcpSession === true,
      paperclipApiUrl: input.paperclipApiUrl, sandboxUpgrade: true })).toBe(false);
    expect(claudeSessionMcpServersMatch({ savedIdentity: JSON.stringify([builtin]), currentIdentity: JSON.stringify([builtin]),
      currentConnectionIds: [builtin.connectionId], legacyPlatformSession: false,
      paperclipApiUrl: input.paperclipApiUrl, sandboxUpgrade: true })).toBe(true);
    const recovered = recoverLegacyClaudeMcpIdentity(input);
    const identity = JSON.parse(recovered.mcpServerIdentity as string);
    expect(identity[1].connectionId).toBe("assignment:" + "b".repeat(64));
    expect(identity[1].url).toBe("https://paperclip.test/mcp/gateways/gw_" + "a".repeat(32));
    for (const mutate of [
      (copy: typeof input) => { copy.params.legacyPlatformMcpSession = false; },
      (copy: typeof input) => { copy.previousRunId = "another-run"; },
      (copy: typeof input) => { copy.companyId = "another-company"; },
      (copy: typeof input) => { copy.agentId = "another-agent"; },
      (copy: typeof input) => { copy.taskId = "another-task"; },
      (copy: typeof input) => { copy.paperclipApiUrl = "https://foreign.test"; },
      (copy: typeof input) => { copy.invocations[0].payload.env.PAPERCLIP_GITHUB_BROKER_URL = ""; },
      (copy: typeof input) => { copy.invocations[0].payload.commandNotes = ["Using 3 Paperclip-managed MCP server(s) from strict config /remote/mcp.json."]; },
      (copy: typeof input) => { copy.gateways[0].metadata.agentId = "another-agent"; },
      (copy: typeof input) => { copy.gateways[0].metadata.nativeRuntimeAssignmentDigest = "unknown"; },
      (copy: typeof input) => { copy.gateways.push(copy.gateways[0]); },
    ]) {
      const changed = structuredClone(input); mutate(changed);
      expect(recoverLegacyClaudeMcpIdentity(changed)).toEqual({ ...changed.params, legacyPlatformMcpSession: false });
    }
  });

  it("keeps legacy host-lease matching when no physical identity is available", () => {
    const oldTarget = { ...target, sandboxLeaseAcquisition: undefined };
    const saved = adapterExecutionTargetSessionIdentity(oldTarget);
    expect(adapterExecutionTargetSessionMatches(saved, oldTarget)).toBe(true);
    expect(adapterExecutionTargetSessionMatches(saved, { ...oldTarget, leaseId: "other" })).toBe(false);
  });
});
