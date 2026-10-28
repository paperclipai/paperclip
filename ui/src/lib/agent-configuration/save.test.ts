import { beforeEach, describe, expect, it, vi } from "vitest";
import { appearanceForPalette, type AgentConfigurationDocument } from "@paperclipai/shared";
import { parseAgentConfigurationYaml, serializeAgentConfigurationDocument } from "../agent-configuration-yaml";
import { loadAgentConfiguration } from "./load";
import { ConfigurationSaveInterrupted, planAgentConfiguration, saveAgentConfiguration } from "./save";

const api = vi.hoisted(() => ({
  agents: Object.fromEntries(["getConfiguration", "get", "instructionsBundle", "instructionsFile", "skills", "listKeys", "listConfigRevisions", "update", "updateInstructionsBundle", "saveInstructionsFile", "deleteInstructionsFile", "syncSkills", "updatePermissions", "createKey", "revokeKey", "rollbackConfigRevision"].map(key => [key, vi.fn()])),
  tools: Object.fromEntries(["listConnections", "listProfiles", "listPolicies", "getConnectionInstalls", "putConnectionInstalls", "createProfile", "updateProfile", "bindProfile", "unbindProfile", "createPolicy", "updatePolicy", "deletePolicy"].map(key => [key, vi.fn()])),
  channels: Object.fromEntries(["list", "get", "listResources", "listPrincipals", "update", "updateResources", "create", "setup", "revokeLink"].map(key => [key, vi.fn()])),
  secrets: Object.fromEntries(["list", "listProposals", "create", "rotate", "update", "approveProposal", "rejectProposal"].map(key => [key, vi.fn()])),
}));
vi.mock("../../api/agents", () => ({ agentsApi: api.agents }));
vi.mock("../../api/tools", () => ({ toolsApi: api.tools }));
vi.mock("../../api/chatEndpoints", () => ({ chatEndpointsApi: api.channels }));
vi.mock("../../api/secrets", () => ({ secretsApi: api.secrets }));
const agentId = "11111111-1111-4111-8111-111111111111";
const resourceId = "22222222-2222-4222-8222-222222222222";
const agent = {
  id: agentId, companyId: "company", name: "Codie", role: "engineer", title: null, icon: null,
  appearance: appearanceForPalette("bubblegum-sky"), reportsTo: null, capabilities: null,
  adapterType: "process", adapterConfig: { command: "echo", instructionsBundleMode: "managed", paperclipSkillSync: { desiredSkills: ["paperclip"] } },
  runtimeConfig: {}, defaultEnvironmentId: null, budgetMonthlyCents: 0, metadata: null,
  permissions: { canCreateAgents: false, canCreateSkills: true }, access: { canAssignTasks: false },
  configurationRevision: "a".repeat(64),
};
const file = { path: "AGENTS.md", content: "# Codie\n", contentHash: "hash", revision: { id: "revision-file" }, editable: true, binary: false };
const installs = [{ targetType: "agent", targetId: agentId }, { targetType: "agent", targetId: "another-agent" }];
const connection = { id: "connection", name: "GitHub", installs };
const channel = { id: "channel", companyId: "company", assignedAgentId: agentId, provider: "slack", status: "active", allowUnlinkedPeople: false };
const progress = vi.fn(), receipt = vi.fn();
const copy = <T>(value: T): T => structuredClone(value);
async function snapshot() { return loadAgentConfiguration(agentId, "company"); }
function roundTrip(document: AgentConfigurationDocument) { return parseAgentConfigurationYaml(serializeAgentConfigurationDocument(document)); }

beforeEach(() => {
  vi.resetAllMocks();
  api.agents.getConfiguration.mockResolvedValue(copy(agent)); api.agents.get.mockResolvedValue(copy(agent));
  api.agents.instructionsBundle.mockResolvedValue({ mode: "managed", rootPath: "/managed/codie", entryFile: "AGENTS.md", editable: true, files: [file], warnings: [] });
  api.agents.instructionsFile.mockResolvedValue(file);
  api.agents.skills.mockResolvedValue({ desiredSkills: ["paperclip"], desiredSkillEntries: [{ key: "paperclip", versionId: resourceId }], warnings: [] });
  api.agents.listKeys.mockResolvedValue([{ id: "key", name: "Previous", scope: { kind: "standard" }, revokedAt: null }]);
  api.agents.listConfigRevisions.mockResolvedValue([{ id: "revision", source: "board", changedKeys: ["name"] }]);
  api.tools.listConnections.mockResolvedValue({ connections: [connection] });
  api.tools.listProfiles.mockResolvedValue({ profiles: [] }); api.tools.listPolicies.mockResolvedValue({ policies: [] });
  api.tools.getConnectionInstalls.mockResolvedValue({ installs });
  api.tools.createProfile.mockResolvedValue({ id: "new-profile" });
  api.channels.list.mockResolvedValue([channel]); api.channels.get.mockResolvedValue(channel);
  api.channels.listResources.mockResolvedValue([{ id: resourceId, enabled: true }]); api.channels.listPrincipals.mockResolvedValue([{ principalId: "principal" }]);
  api.secrets.list.mockResolvedValue([{ id: "secret", name: "Token", provider: "local_encrypted", latestVersion: 1 }]);
  api.secrets.listProposals.mockResolvedValue([{ id: "proposal", target: { id: agentId }, proposedBy: { id: agentId } }]);
  api.agents.createKey.mockResolvedValue({ id: "new-key", name: "Automation", token: "one-time-token" });
  api.secrets.create.mockResolvedValue({ id: "new-secret", name: "Token" });
});

describe("complete agent configuration", () => {
  it("loads every resource section and round trips to a no-op without credential values", async () => {
    const saved = await snapshot();
    const doc = roundTrip(saved.document);
    expect(doc.spec.instructions?.files["AGENTS.md"]).toBe(file.content);
    expect(doc.spec.skills).toEqual([{ key: "paperclip", versionId: resourceId }]);
    expect(doc.spec.adapterConfig).toEqual({ command: "echo" });
    expect(doc.observed?.secretProposals).toHaveLength(1);
    expect(planAgentConfiguration(saved, doc)).toEqual([]);
    await saveAgentConfiguration(saved, doc, receipt, progress);
    expect(api.agents.getConfiguration).toHaveBeenCalledTimes(1);
    expect(api.agents.update).not.toHaveBeenCalled();
  });

  it("round trips existing profiles and agent policies without rewriting shared definitions", async () => {
    api.tools.listProfiles.mockResolvedValue({ profiles: [{ id: "profile", profileKey: "read", name: "Read", description: null,
      status: "active", defaultAction: "deny", metadata: null,
      bindings: [{ targetType: "agent", targetId: agentId, priority: 100, metadata: null }],
      entries: [{ selectorType: "tool_name", effect: "include", applicationId: null, connectionId: null,
        catalogEntryId: null, toolName: "get_repository", riskLevel: null, conditions: null }],
    }] });
    api.tools.listPolicies.mockResolvedValue({ policies: [{ id: "policy", name: "Read", description: null, policyType: "allow",
      priority: 100, enabled: true, selectors: { agentIds: [agentId] }, conditions: null, config: {} }] });
    const saved = await snapshot();
    expect(planAgentConfiguration(saved, roundTrip(saved.document))).toEqual([]);
    const doc = copy(saved.document); doc.spec.tools!.profiles = []; doc.spec.tools!.policies = [];
    await saveAgentConfiguration(saved, roundTrip(doc), receipt, progress);
    expect(api.tools.unbindProfile).toHaveBeenCalledWith("company", "profile", { targetType: "agent", targetId: agentId });
    expect(api.tools.deletePolicy).toHaveBeenCalledWith("company", "policy");
    expect(api.tools.updateProfile).not.toHaveBeenCalled();
  });

  it("switches instruction locations without overwriting files at the destination", async () => {
    const saved = await snapshot(); const doc = copy(saved.document);
    doc.spec.instructions!.rootPath = "/workspace/new"; doc.spec.instructions!.mode = "external";
    api.agents.updateInstructionsBundle.mockResolvedValue({ files: [file] });
    api.agents.instructionsFile.mockResolvedValueOnce(file).mockResolvedValueOnce({ ...file, content: "Destination instructions" });
    const result = await saveAgentConfiguration(saved, roundTrip(doc), receipt, progress);
    expect(api.agents.updateInstructionsBundle).toHaveBeenCalledWith(agentId, { mode: "external", rootPath: "/workspace/new", entryFile: "AGENTS.md" }, "company");
    expect(api.agents.saveInstructionsFile).not.toHaveBeenCalled();
    expect(api.agents.deleteInstructionsFile).not.toHaveBeenCalled();
    expect(result.document.spec.instructions!.files["AGENTS.md"]).toBe("Destination instructions");
  });

  it("rejects a location change combined with file edits before applying an unrelated core edit", async () => {
    const saved = await snapshot(); const doc = copy(saved.document);
    doc.spec.title = "Engineer"; doc.spec.instructions!.entryFile = "NEW.md";
    doc.spec.instructions!.files["NEW.md"] = "New instructions";
    await expect(saveAgentConfiguration(saved, doc, receipt, progress)).rejects.toThrow("location or entry file first");
    expect(api.agents.update).not.toHaveBeenCalled();
    expect(api.agents.updateInstructionsBundle).not.toHaveBeenCalled();
  });

  it("rejects ignored managed-root changes and impossible task-assignment permissions", async () => {
    const saved = await snapshot(); const doc = copy(saved.document);
    doc.spec.instructions!.rootPath = "/ignored/root";
    await expect(saveAgentConfiguration(saved, doc, receipt, progress)).rejects.toThrow("assigned by Paperclip");
    doc.spec.instructions = saved.document.spec.instructions;
    doc.spec.permissions!.canCreateAgents = true;
    await expect(saveAgentConfiguration(saved, doc, receipt, progress)).rejects.toThrow("task assignment authority");
    expect(api.agents.updatePermissions).not.toHaveBeenCalled();
  });

  it("creates a secret and binds its returned ID without exporting the value", async () => {
    const saved = await snapshot(); const doc = copy(saved.document);
    doc.spec.secrets!.create = [{ secret: { name: "Token", value: "write-only-value", provider: "local_encrypted" }, bind: { env: ["TOKEN"], api: ["SERVICE"] } }];
    const result = await saveAgentConfiguration(saved, roundTrip(doc), receipt, progress);
    expect(api.secrets.create).toHaveBeenCalledWith("company", expect.objectContaining({ value: "write-only-value" }));
    expect(api.agents.update).toHaveBeenCalledWith(agentId, expect.objectContaining({
      adapterConfig: expect.objectContaining({ env: { TOKEN: { type: "secret_ref", secretId: "new-secret", version: "latest" } },
        "access.SERVICE": { type: "secret_ref", secretId: "new-secret", version: "latest" } }),
      expectedConfigurationRevision: agent.configurationRevision,
    }), "company");
    expect(JSON.stringify(result.document)).not.toContain("write-only-value");
  });

  it("rejects nested schema typos and unsupported channel creation before writes", async () => {
    const saved = await snapshot();
    const doc = copy(saved.document);
    Object.assign(doc.spec.skills![0] as object, { typo: true });
    expect(() => roundTrip(doc)).toThrow("spec.skills.0");
    doc.spec.skills = saved.document.spec.skills;
    doc.spec.channelOperations!.create = [{ provider: "telegram", slackSetupMethod: "manual" }];
    await expect(saveAgentConfiguration(saved, doc, receipt, progress)).rejects.toThrow("Slack app details");
    expect(api.channels.create).not.toHaveBeenCalled();
  });

  it("saves each domain through its owning API and preserves other agents' installations", async () => {
    const saved = await snapshot(); const doc = copy(saved.document);
    doc.spec.title = "Engineer";
    doc.spec.instructions!.files["AGENTS.md"] = "# Revised\n";
    doc.spec.skills = [];
    doc.spec.permissions!.canCreateSkills = false;
    doc.spec.tools!.connections[0].installed = false;
    doc.spec.channels![0].settings.allowUnlinkedPeople = true;
    doc.spec.channels![0].resources = [];
    doc.spec.apiKeys = { create: [{ name: "Automation", scope: { kind: "standard" } }], revoke: ["key"] };
    doc.spec.channelOperations!.revokeIdentityLinks = [{ endpointId: "channel", principalId: "principal" }];
    doc.spec.secrets!.rotate = [{ id: "secret", input: { value: "replacement" } }];
    doc.spec.secrets!.proposals = [{ id: "proposal", decision: "reject", reason: "Wrong account" }];
    await saveAgentConfiguration(saved, roundTrip(doc), receipt, progress);
    expect(api.agents.update).toHaveBeenCalledExactlyOnceWith(agentId, { title: "Engineer", expectedConfigurationRevision: agent.configurationRevision }, "company");
    expect(api.agents.saveInstructionsFile).toHaveBeenCalledWith(agentId, { path: "AGENTS.md", content: "# Revised\n", baseHash: "hash", baseRevisionId: "revision-file" }, "company");
    expect(api.agents.syncSkills).toHaveBeenCalledWith(agentId, [], "replace", "company");
    expect(api.tools.putConnectionInstalls).toHaveBeenCalledWith("connection", [{ targetType: "agent", targetId: "another-agent" }]);
    expect(api.channels.update).toHaveBeenCalledExactlyOnceWith("channel", { allowUnlinkedPeople: true });
    expect(api.channels.updateResources).toHaveBeenCalledWith("channel", [{ id: resourceId, enabled: false, executionDefaults: null }]);
    expect(api.channels.revokeLink).toHaveBeenCalledWith("channel", "principal");
    expect(api.agents.updatePermissions).toHaveBeenCalledWith(agentId, expect.objectContaining({ canCreateSkills: false }), "company");
    expect(api.secrets.rotate).toHaveBeenCalledWith("secret", { value: "replacement" });
    expect(api.secrets.rejectProposal).toHaveBeenCalledWith("company", "proposal", { reason: "Wrong account" });
    expect(api.agents.revokeKey).toHaveBeenCalledWith(agentId, "key", "company");
    expect(receipt).toHaveBeenCalledWith({ label: "API key: Automation", id: "new-key", token: "one-time-token" });
  });

  it("requires explicit clears for nested PATCH fields", async () => {
    const saved = await snapshot(); const doc = copy(saved.document);
    doc.spec.title = "Engineer";
    delete doc.spec.channels![0].resources[0].enabled;
    await expect(saveAgentConfiguration(saved, doc, receipt, progress)).rejects.toThrow(".enabled explicit");
    expect(api.agents.update).not.toHaveBeenCalled();
  });

  it("requires explicit consent for shared profile changes and still supports binding without changing them", async () => {
    const profile = { id: "profile", profileKey: "shared", name: "Shared", description: null,
      status: "active", defaultAction: "deny", metadata: null, entries: [],
      bindings: [{ targetType: "agent", targetId: "another-agent", priority: 100, metadata: null }] };
    api.tools.listProfiles.mockResolvedValue({ profiles: [profile] });
    const saved = await snapshot(); const doc = copy(saved.document);
    const configuration = { profileKey: "shared", name: "Shared", description: null, status: "active" as const, defaultAction: "deny" as const, metadata: null, entries: [] };
    doc.spec.tools!.profiles = [{ profileId: "profile", priority: 100, metadata: null, configuration }];
    await saveAgentConfiguration(saved, doc, receipt, progress);
    expect(api.tools.bindProfile).toHaveBeenCalledTimes(1);
    expect(api.tools.updateProfile).not.toHaveBeenCalled();
    configuration.name = "Changed for everyone";
    await expect(saveAgentConfiguration(saved, doc, receipt, progress)).rejects.toThrow("updateSharedDefinition: true");
    doc.spec.tools!.profiles[0].updateSharedDefinition = true;
    await saveAgentConfiguration(saved, doc, receipt, progress);
    expect(api.tools.updateProfile).toHaveBeenCalledWith("profile", configuration);
    delete (configuration as Partial<typeof configuration>).description;
    await expect(saveAgentConfiguration(saved, doc, receipt, progress)).rejects.toThrow(".description explicit");
  });

  it("rejects a newly selected profile whose definition changed after the editor loaded", async () => {
    const profile = { id: "profile", profileKey: "unbound", name: "Unbound", description: null,
      status: "active", defaultAction: "deny", metadata: null, entries: [], bindings: [] };
    api.tools.listProfiles.mockResolvedValueOnce({ profiles: [profile] });
    const saved = await snapshot(); const doc = copy(saved.document);
    doc.spec.tools!.profiles = [{ profileId: "profile", priority: 100, metadata: null, configuration:
      { profileKey: "unbound", name: "Unbound", description: null, status: "active", defaultAction: "deny", metadata: null, entries: [] } }];
    api.tools.listProfiles.mockResolvedValue({ profiles: [{ ...profile, name: "Changed elsewhere" }] });
    await expect(saveAgentConfiguration(saved, doc, receipt, progress)).rejects.toThrow("Tool profile profile changed");
    expect(api.tools.updateProfile).not.toHaveBeenCalled();
    expect(api.tools.bindProfile).not.toHaveBeenCalled();
  });

  it("rejects removing a channel while editing its settings or identity links", async () => {
    const saved = await snapshot(); const doc = copy(saved.document);
    doc.spec.channels![0].settings.communicationInstructions = "New instructions";
    doc.spec.channelOperations!.setup = [{ id: "channel", input: { action: "remove" } }];
    await expect(saveAgentConfiguration(saved, doc, receipt, progress)).rejects.toThrow("edited and removed");
    doc.spec.channels = []; doc.spec.channelOperations!.setup = [];
    doc.spec.channelOperations!.revokeIdentityLinks = [{ endpointId: "channel", principalId: "principal" }];
    await expect(saveAgentConfiguration(saved, doc, receipt, progress)).rejects.toThrow("removed and have its identities edited");
    expect(api.channels.setup).not.toHaveBeenCalled();
    expect(api.channels.update).not.toHaveBeenCalled();
  });

  it("rejects overlapping secret bindings and preserves a concurrently edited binding", async () => {
    const saved = await snapshot(); const doc = copy(saved.document);
    const create = { secret: { name: "Token", value: "new-value", provider: "local_encrypted" as const }, bind: { env: ["TOKEN"], api: [] } };
    doc.spec.secrets!.create = [create, { ...create, secret: { ...create.secret, name: "Other" } }];
    await expect(saveAgentConfiguration(saved, doc, receipt, progress)).rejects.toThrow("bind.env contains duplicate");
    doc.spec.secrets!.create = [create]; doc.spec.adapterConfig.env = { TOKEN: "competing-value" };
    await expect(saveAgentConfiguration(saved, doc, receipt, progress)).rejects.toThrow("not both");
    delete doc.spec.adapterConfig.env;
    api.agents.getConfiguration.mockResolvedValueOnce(agent).mockResolvedValueOnce({ ...agent, adapterConfig: { ...agent.adapterConfig, env: { TOKEN: "someone-else" } } });
    await expect(saveAgentConfiguration(saved, doc, receipt, progress)).rejects.toThrow("TOKEN changed");
    expect(api.secrets.create).not.toHaveBeenCalled();
    expect(api.agents.update).not.toHaveBeenCalled();
  });

  it("retains normalization warnings returned by writes after refreshing the saved snapshot", async () => {
    const saved = await snapshot(); const doc = copy(saved.document); doc.spec.title = "Engineer";
    const warning = { code: "runner_option_ignored", field: "chrome", message: "Chrome is ignored" };
    api.agents.update.mockResolvedValue({ ...agent, configurationWarnings: [warning] });
    const result = await saveAgentConfiguration(saved, doc, receipt, progress);
    expect(result.agent.configurationWarnings).toEqual([warning]);
  });

  it("checks the entire plan before making any writes", async () => {
    const saved = await snapshot(); const doc = copy(saved.document);
    doc.spec.title = "Engineer"; doc.spec.apiKeys!.revoke = ["foreign-key"];
    await expect(saveAgentConfiguration(saved, doc, receipt, progress)).rejects.toThrow("foreign-key");
    expect(api.agents.update).not.toHaveBeenCalled(); expect(api.agents.getConfiguration).toHaveBeenCalledTimes(1);
  });

  it("rejects stale core, file content and edited channel settings before writes", async () => {
    const saved = await snapshot(); const doc = copy(saved.document); doc.spec.title = "Engineer";
    api.agents.getConfiguration.mockResolvedValueOnce({ ...agent, configurationRevision: "b".repeat(64) });
    await expect(saveAgentConfiguration(saved, doc, receipt, progress)).rejects.toThrow("configuration changed");
    doc.spec.instructions!.files["AGENTS.md"] = "My change";
    api.agents.instructionsFile.mockResolvedValueOnce({ ...file, content: "Someone else's change" });
    await expect(saveAgentConfiguration(saved, doc, receipt, progress)).rejects.toThrow("instructions changed");
    delete doc.spec.instructions;
    doc.spec.channels![0].settings.communicationInstructions = "Be concise";
    api.channels.get.mockResolvedValueOnce({ ...channel, allowUnlinkedPeople: true });
    await expect(saveAgentConfiguration(saved, doc, receipt, progress)).rejects.toThrow("channels changed");
    expect(api.agents.update).not.toHaveBeenCalled();
  });

  it("does not undo a concurrent change to an unedited resource section", async () => {
    const saved = await snapshot(); const doc = copy(saved.document); doc.spec.title = "Engineer";
    api.channels.get.mockResolvedValue({ ...channel, allowUnlinkedPeople: true });
    await saveAgentConfiguration(saved, doc, receipt, progress);
    expect(api.agents.update).toHaveBeenCalledTimes(1); expect(api.channels.update).not.toHaveBeenCalled();
  });

  it("reports partial progress without retrying or losing a newly created key", async () => {
    const saved = await snapshot(); const doc = copy(saved.document);
    doc.spec.title = "Engineer";
    doc.spec.apiKeys!.create = [{ name: "Automation", scope: { kind: "standard" } }, { name: "Second", scope: { kind: "standard" } }];
    api.agents.createKey.mockResolvedValueOnce({ id: "new-key", name: "Automation", token: "one-time-token" }).mockRejectedValueOnce(new Error("Network lost"));
    await expect(saveAgentConfiguration(saved, doc, receipt, progress)).rejects.toThrow(ConfigurationSaveInterrupted);
    expect(receipt).toHaveBeenCalledWith(expect.objectContaining({ token: "one-time-token" }));
    expect(api.agents.update).toHaveBeenCalledTimes(1); expect(api.agents.createKey).toHaveBeenCalledTimes(2);
  });

  it("requires revision restore to be the only change and never replays history", async () => {
    const saved = await snapshot(); const doc = copy(saved.document);
    doc.spec.revisions!.restore = "revision"; doc.spec.title = "Engineer";
    await expect(saveAgentConfiguration(saved, doc, receipt, progress)).rejects.toThrow("own save");
    doc.spec.title = null;
    await saveAgentConfiguration(saved, doc, receipt, progress);
    expect(api.agents.rollbackConfigRevision).toHaveBeenCalledWith(agentId, "revision", "company");
    expect(api.agents.update).not.toHaveBeenCalled();
  });

  it("rejects edits to observed context and changes to organization-wide installs", async () => {
    const saved = await snapshot(); const doc = copy(saved.document);
    doc.observed!.apiKeys = [];
    expect(() => planAgentConfiguration(saved, doc)).toThrow("observed is read-only");
    doc.observed = saved.document.observed;
    saved.connections[0].installs = [{ targetType: "company", targetId: "company" }] as typeof saved.connections[0]["installs"];
    doc.spec.tools!.connections[0].installed = false;
    expect(() => planAgentConfiguration(saved, doc)).toThrow("organization-wide");
  });

  it("creates profiles, scoped policies and channel setup using native contracts", async () => {
    const saved = await snapshot(); const doc = copy(saved.document);
    doc.spec.tools!.profiles = [{ profileId: null, priority: 10, metadata: null, configuration: { name: "Read", profileKey: "read", status: "active", defaultAction: "deny", entries: [] } }];
    doc.spec.tools!.policies = [{ id: null, configuration: { name: "Safe", policyType: "allow", priority: 10, enabled: true, selectors: {}, conditions: null, config: {} } }];
    doc.spec.channelOperations!.setup = [{ id: "channel", input: { action: "pause" } }];
    await saveAgentConfiguration(saved, roundTrip(doc), receipt, progress);
    expect(api.tools.createProfile).toHaveBeenCalledWith("company", expect.objectContaining({ profileKey: "read" }));
    expect(api.tools.bindProfile).toHaveBeenCalledWith("company", "new-profile", { targetType: "agent", targetId: agentId, priority: 10, metadata: null });
    expect(api.tools.createPolicy).toHaveBeenCalledWith("company", expect.objectContaining({ selectors: { agentIds: [agentId] } }));
    expect(api.channels.setup).toHaveBeenCalledWith("channel", { action: "pause" });
  });
});
