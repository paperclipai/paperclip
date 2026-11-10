import { beforeEach, describe, expect, it, vi } from "vitest";
import { appearanceForPalette, type AgentConfigurationDocument, type AgentConfigurationInput } from "@paperclipai/shared";
import { parseAgentConfigurationYaml, serializeAgentConfigurationDocument } from "../agent-configuration-yaml";
import { loadAgentConfiguration } from "./load";
import { ConfigurationSaveInterrupted, planAgentConfiguration, saveAgentConfiguration } from "./save";
import { compactAgentConfiguration } from "./compact";

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
  api.tools.listConnections.mockResolvedValue({ connections: [copy(connection)] });
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
    expect(doc.spec.instructions?.files?.["AGENTS.md"]).toBe(file.content);
    expect(doc.spec.skills).toEqual([{ key: "paperclip", versionId: resourceId }]);
    expect(doc.spec.adapterConfig).toEqual({ command: "echo" });
    expect(doc.observed).toBeUndefined();
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

  it("preserves omitted fields inside resource updates", async () => {
    const saved = await snapshot(); const doc = copy(saved.document);
    doc.spec.title = "Engineer";
    delete doc.spec.channels![0].resources[0].enabled;
    await saveAgentConfiguration(saved, doc, receipt, progress);
    expect(api.channels.updateResources).not.toHaveBeenCalled();
    expect(api.agents.update).toHaveBeenCalledWith(agentId, expect.objectContaining({ title: "Engineer" }), "company");
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
    doc.observed = { apiKeys: [] };
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

describe("compact agent configuration", () => {
  const input = (spec: AgentConfigurationInput["spec"]): AgentConfigurationInput => ({ apiVersion: "paperclip/v1", kind: "Agent", spec });
  const profile = (id = "profile", bound = true) => ({
    id, profileKey: id, name: id, description: null, status: "active", defaultAction: "deny", metadata: null,
    bindings: bound ? [{ targetType: "agent", targetId: agentId, priority: 100, metadata: null }] : [],
    entries: [{ selectorType: "tool_name", effect: "include", toolName: "get_repository", applicationId: null,
      connectionId: null, catalogEntryId: null, riskLevel: null, conditions: null }],
  });

  it("keeps a large company catalog and instruction contents out of the default YAML", async () => {
    const profiles = Array.from({ length: 30 }, (_, i) => ({ ...profile(`profile-${i}`, i === 0),
      entries: Array.from({ length: 50 }, (_, j) => ({ ...profile().entries[0], toolName: `tool_${j}` })),
    }));
    api.tools.listProfiles.mockResolvedValue({ profiles });
    api.agents.instructionsFile.mockResolvedValue({ ...file, content: "Do not embed this instruction file.\n".repeat(1000) });
    api.tools.listConnections.mockResolvedValue({ connections: [connection, { id: "unused", installs: [] }] });
    const saved = await snapshot();
    const compact = compactAgentConfiguration(saved.document);
    const source = serializeAgentConfigurationDocument(compact);
    const previous = serializeAgentConfigurationDocument({ ...saved.document, observed: { availableProfiles: profiles, inheritedProfiles: profiles } });
    expect(source.length).toBeLessThan(previous.length / 20);
    expect(source.split("\n").length).toBeLessThan(70);
    expect(compact.spec.tools?.profiles).toEqual([{ profileKey: "profile-0" }]);
    expect(compact.spec.tools?.connections).toEqual([{ connectionId: "connection" }]);
    for (const text of ["observed:", "tool_49", "profile-29", "Do not embed", "unused", "rootPath:", "create:", "revoke:", "metadata: null", "title: null"]) expect(source).not.toContain(text);
    expect(compact.spec.instructions).toEqual({ mode: "managed", entryFile: "AGENTS.md" });
    expect(planAgentConfiguration(saved, parseAgentConfigurationYaml(source))).toEqual([]);
  });

  it("preserves all hidden values on sparse saves and accepts removing legacy observed metadata", async () => {
    const saved = await snapshot();
    await saveAgentConfiguration(saved, input({ title: "Engineer" }), receipt, progress);
    expect(api.agents.update).toHaveBeenCalledWith(agentId, { title: "Engineer", expectedConfigurationRevision: agent.configurationRevision }, "company");
    for (const method of [api.agents.saveInstructionsFile, api.agents.deleteInstructionsFile, api.agents.syncSkills, api.tools.putConnectionInstalls, api.channels.updateResources, api.agents.updatePermissions]) expect(method).not.toHaveBeenCalled();
    saved.document.observed = { oldReadOnlyCatalog: [] };
    expect(planAgentConfiguration(saved, input({}))).toEqual([]);
  });

  it("round trips unpinned skill shorthand without synchronizing unchanged skills", async () => {
    api.agents.skills.mockResolvedValue({ desiredSkills: ["paperclip"], desiredSkillEntries: [{ key: "paperclip", versionId: null }], warnings: [] });
    const saved = await snapshot();
    const compact = compactAgentConfiguration(saved.document);
    expect(compact.spec.skills).toEqual(["paperclip"]);
    expect(planAgentConfiguration(saved, compact)).toEqual([]);
    compact.spec.title = "Engineer";
    await saveAgentConfiguration(saved, compact, receipt, progress);
    expect(api.agents.syncSkills).not.toHaveBeenCalled();
  });

  it("restores a revision with unpinned skills and mixed enabled/disabled channel resources", async () => {
    api.agents.skills.mockResolvedValue({ desiredSkills: ["paperclip"], desiredSkillEntries: [{ key: "paperclip", versionId: null }], warnings: [] });
    api.channels.listResources.mockResolvedValue([{ id: resourceId, enabled: true }, { id: agentId, enabled: false }]);
    const saved = await snapshot();
    const compact = compactAgentConfiguration(saved.document);
    expect(compact.spec.channels![0].resources).toHaveLength(1);
    expect(planAgentConfiguration(saved, compact)).toEqual([]);
    compact.spec.revisions = { restore: "revision" };
    await saveAgentConfiguration(saved, compact, receipt, progress);
    expect(api.agents.rollbackConfigRevision).toHaveBeenCalledWith(agentId, "revision", "company");
    expect(api.agents.syncSkills).not.toHaveBeenCalled();
    expect(api.channels.updateResources).not.toHaveBeenCalled();
  });

  it("binds a profile by key without copying or rewriting its definition", async () => {
    api.tools.listProfiles.mockResolvedValue({ profiles: [profile("read", false)] });
    const saved = await snapshot();
    await saveAgentConfiguration(saved, input({ tools: { profiles: [{ profileKey: "read" }] } }), receipt, progress);
    expect(api.tools.bindProfile).toHaveBeenCalledWith("company", "read", { targetType: "agent", targetId: agentId, priority: 100, metadata: null });
    expect(api.tools.updateProfile).not.toHaveBeenCalled();
    expect(api.tools.createProfile).not.toHaveBeenCalled();
    expect(api.tools.putConnectionInstalls).not.toHaveBeenCalled();
  });

  it("changes binding priority independently of its shared definition", async () => {
    api.tools.listProfiles.mockResolvedValue({ profiles: [profile()] });
    const saved = await snapshot();
    await saveAgentConfiguration(saved, input({ tools: { profiles: [{ profileKey: "profile", priority: 50 }] } }), receipt, progress);
    expect(api.tools.bindProfile).toHaveBeenCalledWith("company", "profile", expect.objectContaining({ priority: 50 }));
    expect(api.tools.updateProfile).not.toHaveBeenCalled();
  });

  it("validates references before applying any core changes", async () => {
    const saved = await snapshot();
    await expect(saveAgentConfiguration(saved, input({ title: "Engineer", tools: { profiles: [{ profileKey: "unknown" }] } }), receipt, progress)).rejects.toThrow("Profile unknown");
    expect(api.agents.update).not.toHaveBeenCalled();
  });

  it("installs an unselected connection without serializing the available catalog", async () => {
    api.tools.listConnections.mockResolvedValue({ connections: [{ ...connection, installs: [] }] });
    api.tools.getConnectionInstalls.mockResolvedValue({ installs: [] });
    const saved = await snapshot();
    expect(saved.document.spec.tools!.connections).toEqual([]);
    await saveAgentConfiguration(saved, input({ tools: { connections: [{ connectionId: "connection" }] } }), receipt, progress);
    expect(api.tools.putConnectionInstalls).toHaveBeenCalledWith("connection", [{ targetType: "agent", targetId: agentId }]);
  });

  it("ignores unrelated catalog additions during a profile binding edit", async () => {
    api.tools.listProfiles.mockResolvedValue({ profiles: [profile("read", false)] });
    const saved = await snapshot();
    api.tools.listConnections.mockResolvedValue({ connections: [copy(connection), { id: "unrelated", installs: [] }] });
    await saveAgentConfiguration(saved, input({ tools: { profiles: [{ profileKey: "read" }] } }), receipt, progress);
    expect(api.tools.bindProfile).toHaveBeenCalled();
    expect(api.tools.putConnectionInstalls).not.toHaveBeenCalled();
  });

  it("requires matching IDs and keys when both are supplied", async () => {
    api.tools.listProfiles.mockResolvedValue({ profiles: [profile()] });
    const saved = await snapshot();
    expect(() => planAgentConfiguration(saved, input({ tools: { profiles: [{ profileId: "profile", profileKey: "other" }] } }))).toThrow("Profile other");
    expect(() => planAgentConfiguration(saved, input({ tools: { profiles: [{ profileId: null, profileKey: "profile" }] } }))).toThrow("cannot also reference");
  });

  it("keeps explicit empty lists and nulls as real clears", async () => {
    api.agents.getConfiguration.mockResolvedValue({ ...agent, title: "Engineer" });
    api.tools.listProfiles.mockResolvedValue({ profiles: [profile()] });
    const saved = await snapshot();
    await saveAgentConfiguration(saved, input({ title: null, skills: [], tools: { connections: [], profiles: [] } }), receipt, progress);
    expect(api.agents.update).toHaveBeenCalledWith(agentId, expect.objectContaining({ title: null }), "company");
    expect(api.agents.syncSkills).toHaveBeenCalledWith(agentId, [], "replace", "company");
    expect(api.tools.unbindProfile).toHaveBeenCalledWith("company", "profile", { targetType: "agent", targetId: agentId });
    expect(api.tools.putConnectionInstalls).toHaveBeenCalledWith("connection", [{ targetType: "agent", targetId: "another-agent" }]);
    expect(api.agents.deleteInstructionsFile).not.toHaveBeenCalled();
  });

  it("preserves unmentioned permission fields and channel resources", async () => {
    const saved = await snapshot();
    await saveAgentConfiguration(saved, input({ permissions: { canCreateSkills: false }, channels: [{ id: "channel", settings: { allowUnlinkedPeople: true } }] }), receipt, progress);
    expect(api.agents.updatePermissions).toHaveBeenCalledWith(agentId, expect.objectContaining({ canCreateAgents: false, canAssignTasks: false, canCreateSkills: false, trustPreset: "standard" }), "company");
    expect(api.channels.update).toHaveBeenCalledWith("channel", { allowUnlinkedPeople: true });
    expect(api.channels.updateResources).not.toHaveBeenCalled();
  });

  it("edits individual instruction files and deletes only explicit null entries", async () => {
    api.agents.instructionsBundle.mockResolvedValue({ mode: "managed", rootPath: "/managed/codie", entryFile: "AGENTS.md", editable: true, files: [file, { ...file, path: "old.md" }], warnings: [] });
    api.agents.instructionsFile.mockImplementation(async (_id, path) => ({ ...file, path }));
    const saved = await snapshot();
    await saveAgentConfiguration(saved, input({ instructions: { files: { "new.md": "New workflow", "old.md": null } } }), receipt, progress);
    expect(api.agents.saveInstructionsFile).toHaveBeenCalledWith(agentId, { path: "new.md", content: "New workflow", baseHash: null, baseRevisionId: null }, "company");
    expect(api.agents.deleteInstructionsFile).toHaveBeenCalledExactlyOnceWith(agentId, "old.md", "company", "hash");
    expect(() => planAgentConfiguration(saved, input({ instructions: { files: { "AGENTS.md": null } } }))).toThrow("entry file cannot be removed");
  });

  it("hides legacy instruction text without deleting it during adapter edits", async () => {
    const adapterConfig = { ...agent.adapterConfig, promptTemplate: "Long legacy instructions\n".repeat(1000) };
    api.agents.getConfiguration.mockResolvedValue({ ...agent, adapterConfig });
    const saved = await snapshot();
    const compact = compactAgentConfiguration(saved.document);
    expect(serializeAgentConfigurationDocument(compact)).not.toContain("Long legacy instructions");
    expect(planAgentConfiguration(saved, compact)).toEqual([]);
    await saveAgentConfiguration(saved, input({ adapterConfig: { command: "printf" } }), receipt, progress);
    expect(api.agents.update).toHaveBeenCalledWith(agentId, expect.objectContaining({ adapterConfig: { ...adapterConfig, command: "printf" } }), "company");
    await saveAgentConfiguration(saved, input({ adapterConfig: { command: "echo", promptTemplate: "" } }), receipt, progress);
    expect(api.agents.update).toHaveBeenLastCalledWith(agentId, expect.objectContaining({ adapterConfig: { ...adapterConfig, promptTemplate: "" } }), "company");
  });

  it("rejects explicit deletion of read-only instruction files before any writes", async () => {
    api.agents.instructionsBundle.mockResolvedValue({ mode: "managed", rootPath: "/managed/codie", entryFile: "AGENTS.md", editable: true,
      files: [file, { ...file, path: "asset.png", editable: false, binary: true }], warnings: [],
    });
    const saved = await snapshot();
    await expect(saveAgentConfiguration(saved, input({ title: "Engineer", instructions: { files: { "asset.png": null } } }), receipt, progress)).rejects.toThrow("cannot be edited as text");
    expect(api.agents.update).not.toHaveBeenCalled();
  });
});
