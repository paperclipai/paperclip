import { t } from "@/i18n";
import type { AgentConfigurationDocument, AgentConfigurationInput, AgentConfigurationWarning } from "@paperclipai/shared";
import { agentsApi } from "../../api/agents";
import { secretsApi } from "../../api/secrets";
import { agentConfigurationPatch } from "../agent-configuration-yaml";
import { equal, loadAgentConfiguration, ownedAdapterKeys, type AgentConfigurationSnapshot } from "./load";
import { planToolChanges } from "./tools";
import { planChannelChanges } from "./channels";
import { requireItem, unique, type ConfigurationStep, type AddConfigurationStep } from "./steps";
import { resolveAgentConfiguration } from "./resolve";

export interface ConfigurationReceipt { label: string; id: string; token?: string }
export class ConfigurationSaveInterrupted extends Error {
  constructor(label: string, completed: string[], cause: unknown) {
    super(t("nov02Core.configInterrupted", {
      saved: completed.length ? t("nov02Core.savedPrefix", { items: completed.join(", ") }) : "",
      label,
      reason: cause instanceof Error ? cause.message : t("nov02Core.requestFailed"),
    }));
  }
}

function planInstructions(snapshot: AgentConfigurationSnapshot, document: AgentConfigurationDocument, add: AddConfigurationStep) {
  const next = document.spec.instructions;
  if (!next) return;
  const previous = snapshot.document.spec.instructions!;
  if (equal(previous, next)) return;
  if (!snapshot.bundle.editable && !next.mode) throw new Error(t("nov02Core.config009"));
  if (next.mode === null && previous.mode !== null) throw new Error(t("nov02Core.config010"));
  if (next.mode === "external" && !next.rootPath?.startsWith("/")) throw new Error(t("nov02Core.config011"));
  if (Object.hasOwn(previous.files, next.entryFile) && !Object.hasOwn(next.files, next.entryFile)) throw new Error(t("nov02Core.config012"));
  for (const path of Object.keys(next.files)) {
    const existing = snapshot.bundle.files.find(file => file.path === path);
    if (existing && (!existing.editable || existing.binary || existing.virtual)) throw new Error(t("nov02Core.config013", { v0: path }));
  }
  const bundleChanged = previous.mode !== next.mode || previous.rootPath !== next.rootPath || previous.entryFile !== next.entryFile;
  if (bundleChanged) {
    if (!equal(previous.files, next.files)) throw new Error(t("nov02Core.config014"));
    if (next.mode === "managed" && previous.mode === "managed" && next.rootPath !== previous.rootPath) {
      throw new Error(t("nov02Core.config015"));
    }
    add(t("nov02Core.config016"), () => agentsApi.updateInstructionsBundle(snapshot.agent.id, {
      ...(next.mode ? { mode: next.mode } : {}), rootPath: next.rootPath, entryFile: next.entryFile,
    }, snapshot.agent.companyId));
    return;
  }
  const currentFiles = snapshot.files;
  for (const [path, content] of Object.entries(next.files)) {
    if (previous.files[path] === content) continue;
    add(t("nov02Core.config017", { v0: path }), () => {
      const file = currentFiles.get(path);
      if (file?.content === content) return Promise.resolve();
      return agentsApi.saveInstructionsFile(snapshot.agent.id, {
        path, content, baseHash: file?.contentHash ?? null, baseRevisionId: file?.revision?.id ?? null,
      }, snapshot.agent.companyId);
    });
  }
  for (const path of Object.keys(previous.files)) {
    if (Object.hasOwn(next.files, path)) continue;
    add(t("nov02Core.config018", { v0: path }), async () => {
      const file = currentFiles.get(path);
      if (!file) return;
      return agentsApi.deleteInstructionsFile(snapshot.agent.id, path, snapshot.agent.companyId, file.contentHash);
    });
  }
}

function planSecrets(snapshot: AgentConfigurationSnapshot, document: AgentConfigurationDocument, add: AddConfigurationStep, receipt: (value: ConfigurationReceipt) => void) {
  const next = document.spec.secrets;
  if (!next) return;
  const { id, companyId } = snapshot.agent;
  unique(next.rotate.map(row => row.id), "secrets.rotate");
  unique(next.update.map(row => row.id), "secrets.update");
  unique(next.proposals.map(row => row.id), "secrets.proposals");
  unique(next.create.map(row => row.secret.key ?? row.secret.name), "secrets.create");
  for (const operation of [...next.rotate, ...next.update]) requireItem(snapshot.secrets, secret => secret.id === operation.id, t("nov02Core.config019", { v0: operation.id }));
  unique(next.create.flatMap(operation => operation.bind.env), "secrets.create.bind.env");
  unique(next.create.flatMap(operation => operation.bind.api), "secrets.create.bind.api");
  const env = (config: Record<string, unknown>) => config.env && typeof config.env === "object" && !Array.isArray(config.env) ? config.env as Record<string, unknown> : {};
  for (const operation of next.create) {
    for (const key of operation.bind.env) {
      if (!equal(env(document.spec.adapterConfig)[key], env(snapshot.document.spec.adapterConfig)[key])) throw new Error(t("nov02Core.config020", { v0: key }));
    }
    for (const alias of operation.bind.api) {
      if (!equal(document.spec.adapterConfig[`access.${alias}`], snapshot.document.spec.adapterConfig[`access.${alias}`])) throw new Error(t("nov02Core.config021", { v0: alias }));
    }
    const assertBindingsCurrent = (config: Record<string, unknown>) => {
      for (const key of operation.bind.env) if (!equal(env(config)[key], env(snapshot.document.spec.adapterConfig)[key])) throw new Error(t("nov02Core.config022", { v0: key }));
      for (const alias of operation.bind.api) if (!equal(config[`access.${alias}`], snapshot.document.spec.adapterConfig[`access.${alias}`])) throw new Error(t("nov02Core.config023", { v0: alias }));
    };
    add(t("nov02Core.config024", { v0: operation.secret.name }), async () => {
      if (operation.bind.env.length || operation.bind.api.length) assertBindingsCurrent((await agentsApi.getConfiguration(id, companyId)).adapterConfig);
      const created = await secretsApi.create(companyId, operation.secret);
      receipt({ label: t("nov02Core.config025", { v0: created.name }), id: created.id });
      if (!operation.bind.env.length && !operation.bind.api.length) return;
      const current = await agentsApi.getConfiguration(id, companyId);
      assertBindingsCurrent(current.adapterConfig);
      const adapterConfig = { ...current.adapterConfig };
      const binding = { type: "secret_ref", secretId: created.id, version: "latest" };
      if (operation.bind.env.length) adapterConfig.env = { ...(adapterConfig.env as Record<string, unknown> ?? {}),
        ...Object.fromEntries(operation.bind.env.map(key => [key, binding])) };
      for (const alias of operation.bind.api) adapterConfig[`access.${alias}`] = binding;
      await agentsApi.update(id, { adapterConfig, replaceAdapterConfig: true, expectedConfigurationRevision: current.configurationRevision }, companyId);
    });
  }
  for (const operation of next.rotate) add(t("nov02Core.config026", { v0: operation.id }), () => secretsApi.rotate(operation.id, operation.input));
  for (const operation of next.update) add(t("nov02Core.config027", { v0: operation.id }), () => secretsApi.update(operation.id, operation.input));
  for (const operation of next.proposals) {
    requireItem(snapshot.proposals, proposal => proposal.id === operation.id && (proposal.target?.id === id || proposal.proposedBy.id === id), t("nov02Core.config028", { v0: operation.id }));
    if (operation.decision === "reject" && !operation.reason?.trim()) throw new Error(t("nov02Core.config029"));
    add(t("nov02Core.config030", { v0: operation.id }), () => operation.decision === "approve"
      ? secretsApi.approveProposal(companyId, operation.id)
      : secretsApi.rejectProposal(companyId, operation.id, { reason: operation.reason! }));
  }
}

export function planAgentConfiguration(snapshot: AgentConfigurationSnapshot, input: AgentConfigurationInput, receipt: (value: ConfigurationReceipt) => void = () => {}) {
  return planResolvedConfiguration(snapshot, resolveAgentConfiguration(snapshot, input), receipt);
}

function planResolvedConfiguration(snapshot: AgentConfigurationSnapshot, document: AgentConfigurationDocument, receipt: (value: ConfigurationReceipt) => void) {
  const steps: ConfigurationStep[] = [];
  const add: AddConfigurationStep = (label, apply) => { steps.push({ label, apply }); };
  if (!equal(document.observed, snapshot.document.observed)) throw new Error(t("nov02Core.config031"));
  for (const key of ownedAdapterKeys) if (Object.hasOwn(document.spec.adapterConfig, key)) throw new Error(t("nov02Core.config032", { v0: key === "paperclipSkillSync" ? "skills" : "instructions", v1: key }));
  const adapterConfig = { ...document.spec.adapterConfig };
  for (const key of ownedAdapterKeys) if (Object.hasOwn(snapshot.core.adapterConfig, key)) adapterConfig[key] = snapshot.core.adapterConfig[key];
  const corePatch = agentConfigurationPatch({ ...document, spec: { ...document.spec, adapterConfig } }, snapshot.core);
  if (Object.keys(corePatch).length) add(t("nov02Core.config033"), () => agentsApi.update(snapshot.agent.id, {
    ...corePatch, expectedConfigurationRevision: snapshot.core.configurationRevision,
  }, snapshot.agent.companyId));
  if (document.spec.permissions && !document.spec.permissions.canAssignTasks && (document.spec.role === "ceo" || document.spec.permissions.canCreateAgents)) {
    throw new Error(t("nov02Core.config034"));
  }
  planInstructions(snapshot, document, add);
  if (document.spec.skills && !equal(document.spec.skills, snapshot.document.spec.skills)) {
    unique(document.spec.skills.map(skill => typeof skill === "string" ? skill : skill.key), "skills");
    add(t("nov02Core.config035"), () => agentsApi.syncSkills(snapshot.agent.id, document.spec.skills!, "replace", snapshot.agent.companyId));
  }
  planToolChanges(snapshot, document, add);
  planChannelChanges(snapshot, document, add);
  planSecrets(snapshot, document, add, receipt);
  if (document.spec.permissions && !equal(document.spec.permissions, snapshot.document.spec.permissions)) {
    add(t("nov02Core.config036"), () => agentsApi.updatePermissions(snapshot.agent.id, { ...document.spec.permissions!,
      authorizationPolicy: document.spec.permissions!.authorizationPolicy ?? {},
    }, snapshot.agent.companyId));
  }
  const keys = document.spec.apiKeys;
  if (keys) {
    unique(keys.revoke, "apiKeys.revoke");
    unique(keys.create.map(key => key.name), "apiKeys.create");
    for (const id of keys.revoke) {
      const key = requireItem(snapshot.keys, key => key.id === id, t("nov02Core.config037", { v0: id }));
      if (!key.revokedAt) add(t("nov02Core.config038", { v0: key.name }), () => agentsApi.revokeKey(snapshot.agent.id, id, snapshot.agent.companyId));
    }
    for (const input of keys.create) add(t("nov02Core.config039", { v0: input.name }), async () => {
      const key = await agentsApi.createKey(snapshot.agent.id, input.name, snapshot.agent.companyId, input.scope);
      receipt({ label: t("nov02Core.config040", { v0: key.name }), id: key.id, token: key.token });
    });
  }
  if (document.spec.revisions?.restore) {
    const id = document.spec.revisions.restore;
    requireItem(snapshot.revisions, revision => revision.id === id, t("nov02Core.config041", { v0: id }));
    if (steps.length) throw new Error(t("nov02Core.config042"));
    add(t("nov02Core.config043"), () => agentsApi.rollbackConfigRevision(snapshot.agent.id, id, snapshot.agent.companyId));
  }
  return steps;
}

export async function saveAgentConfiguration(snapshot: AgentConfigurationSnapshot, input: AgentConfigurationInput,
  onReceipt: (receipt: ConfigurationReceipt) => void, onProgress: (label: string) => void) {
  const document = resolveAgentConfiguration(snapshot, input);
  const initialPlan = planResolvedConfiguration(snapshot, document, onReceipt);
  if (!initialPlan.length) return snapshot;
  const current = await loadAgentConfiguration(snapshot.agent.id, snapshot.agent.companyId);
  if (current.core.configurationRevision !== snapshot.core.configurationRevision) throw new Error(t("nov02Core.config044"));
  for (const key of ["permissions", "instructions", "skills", "tools", "channels"] as const) {
    if (document.spec[key] !== undefined && !equal(document.spec[key], snapshot.document.spec[key]) && !equal(current.document.spec[key], snapshot.document.spec[key])) {
      throw new Error(t("nov02Core.config045", { v0: key }));
    }
  }
  const spec = { ...document.spec };
  for (const key of ["permissions", "instructions", "skills", "tools", "channels"] as const) {
    if (equal(document.spec[key], snapshot.document.spec[key])) Object.assign(spec, { [key]: current.document.spec[key] });
  }
  for (const operation of [...(document.spec.secrets?.rotate ?? []), ...(document.spec.secrets?.update ?? [])]) {
    const previous = snapshot.secrets.find(secret => secret.id === operation.id);
    if (!equal(previous, current.secrets.find(secret => secret.id === operation.id))) throw new Error(t("nov02Core.config046", { v0: operation.id }));
  }
  for (const profile of document.spec.tools?.profiles ?? []) {
    if (!profile.profileId) continue;
    const originalRow = snapshot.document.spec.tools?.profiles.find(value => value.profileId === profile.profileId);
    if (originalRow && equal(originalRow, profile)) continue;
    const before = snapshot.profiles.find(value => value.id === profile.profileId);
    const fresh = current.profiles.find(value => value.id === profile.profileId);
    if (!equal(before, fresh)) throw new Error(t("nov02Core.config047", { v0: profile.profileId }));
  }
  const steps = planResolvedConfiguration(current, { ...document, spec, observed: current.document.observed }, onReceipt);
  const completed: string[] = [];
  const warnings: AgentConfigurationWarning[] = [];
  for (const step of steps) {
    onProgress(step.label);
    try {
      const result = await step.apply();
      if (result && typeof result === "object" && "configurationWarnings" in result && Array.isArray(result.configurationWarnings)) {
        warnings.push(...result.configurationWarnings as AgentConfigurationWarning[]);
      }
      completed.push(step.label);
    }
    catch (cause) { throw new ConfigurationSaveInterrupted(step.label, completed, cause); }
  }
  try {
    const refreshed = await loadAgentConfiguration(snapshot.agent.id, snapshot.agent.companyId);
    if (warnings.length) refreshed.agent = { ...refreshed.agent, configurationWarnings: warnings };
    return refreshed;
  }
  catch (cause) { throw new ConfigurationSaveInterrupted(t("nov02Core.config048"), completed, cause); }
}
