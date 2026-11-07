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
    super(t("display:config_d336d6b85399", { value0: completed.length ? t("display:config_588dd2a4bdbc", { value0: completed.join(", ") }) : "", value1: label, value2: cause instanceof Error ? cause.message : t("display:config_9fcda32cc0cb") }));
  }
}

function planInstructions(snapshot: AgentConfigurationSnapshot, document: AgentConfigurationDocument, add: AddConfigurationStep) {
  const next = document.spec.instructions;
  if (!next) return;
  const previous = snapshot.document.spec.instructions!;
  if (equal(previous, next)) return;
  if (!snapshot.bundle.editable && !next.mode) throw new Error(t("display:config_2415224ec4e6"));
  if (next.mode === null && previous.mode !== null) throw new Error(t("display:config_05408a1b2776"));
  if (next.mode === "external" && !next.rootPath?.startsWith("/")) throw new Error(t("display:config_58f409a569f6"));
  if (Object.hasOwn(previous.files, next.entryFile) && !Object.hasOwn(next.files, next.entryFile)) throw new Error(t("display:config_cb1e82a6bcb6"));
  for (const path of Object.keys(next.files)) {
    const existing = snapshot.bundle.files.find(file => file.path === path);
    if (existing && (!existing.editable || existing.binary || existing.virtual)) throw new Error(t("display:config_16cfcb6db6cb", { value0: path }));
  }
  const bundleChanged = previous.mode !== next.mode || previous.rootPath !== next.rootPath || previous.entryFile !== next.entryFile;
  if (bundleChanged) {
    if (!equal(previous.files, next.files)) throw new Error(t("display:config_f32315b9d699"));
    if (next.mode === "managed" && previous.mode === "managed" && next.rootPath !== previous.rootPath) {
      throw new Error(t("display:config_d0ca833a7806"));
    }
    add(t("display:config_78ef0feb5e2f"), () => agentsApi.updateInstructionsBundle(snapshot.agent.id, {
      ...(next.mode ? { mode: next.mode } : {}), rootPath: next.rootPath, entryFile: next.entryFile,
    }, snapshot.agent.companyId));
    return;
  }
  const currentFiles = snapshot.files;
  for (const [path, content] of Object.entries(next.files)) {
    if (previous.files[path] === content) continue;
    add(t("display:config_3bce3bc15177", { value0: path }), () => {
      const file = currentFiles.get(path);
      if (file?.content === content) return Promise.resolve();
      return agentsApi.saveInstructionsFile(snapshot.agent.id, {
        path, content, baseHash: file?.contentHash ?? null, baseRevisionId: file?.revision?.id ?? null,
      }, snapshot.agent.companyId);
    });
  }
  for (const path of Object.keys(previous.files)) {
    if (Object.hasOwn(next.files, path)) continue;
    add(t("display:config_a75cc68d66e8", { value0: path }), async () => {
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
  for (const operation of [...next.rotate, ...next.update]) requireItem(snapshot.secrets, secret => secret.id === operation.id, t("display:config_433bd7c1b734", { value0: operation.id }));
  unique(next.create.flatMap(operation => operation.bind.env), "secrets.create.bind.env");
  unique(next.create.flatMap(operation => operation.bind.api), "secrets.create.bind.api");
  const env = (config: Record<string, unknown>) => config.env && typeof config.env === "object" && !Array.isArray(config.env) ? config.env as Record<string, unknown> : {};
  for (const operation of next.create) {
    for (const key of operation.bind.env) {
      if (!equal(env(document.spec.adapterConfig)[key], env(snapshot.document.spec.adapterConfig)[key])) throw new Error(t("display:config_0204d3b796f4", { value0: key }));
    }
    for (const alias of operation.bind.api) {
      if (!equal(document.spec.adapterConfig[`access.${alias}`], snapshot.document.spec.adapterConfig[`access.${alias}`])) throw new Error(t("display:config_b5aaf5239f70", { value0: alias }));
    }
    const assertBindingsCurrent = (config: Record<string, unknown>) => {
      for (const key of operation.bind.env) if (!equal(env(config)[key], env(snapshot.document.spec.adapterConfig)[key])) throw new Error(t("display:config_4dd05c8a3818", { value0: key }));
      for (const alias of operation.bind.api) if (!equal(config[`access.${alias}`], snapshot.document.spec.adapterConfig[`access.${alias}`])) throw new Error(t("display:config_9b1f7248fac6", { value0: alias }));
    };
    add(t("display:config_1fdc76d9e9cc", { value0: operation.secret.name }), async () => {
      if (operation.bind.env.length || operation.bind.api.length) assertBindingsCurrent((await agentsApi.getConfiguration(id, companyId)).adapterConfig);
      const created = await secretsApi.create(companyId, operation.secret);
      receipt({ label: t("display:config_3609e7522f13", { value0: created.name }), id: created.id });
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
  for (const operation of next.rotate) add(t("display:config_736083aed760", { value0: operation.id }), () => secretsApi.rotate(operation.id, operation.input));
  for (const operation of next.update) add(t("display:config_6a2f6b73412c", { value0: operation.id }), () => secretsApi.update(operation.id, operation.input));
  for (const operation of next.proposals) {
    requireItem(snapshot.proposals, proposal => proposal.id === operation.id && (proposal.target?.id === id || proposal.proposedBy.id === id), t("display:config_ba959c9b2363", { value0: operation.id }));
    if (operation.decision === "reject" && !operation.reason?.trim()) throw new Error(t("display:config_f6b877f93ac4"));
    add(t("display:config_b37c13800cf8", { value0: operation.id }), () => operation.decision === "approve"
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
  if (!equal(document.observed, snapshot.document.observed)) throw new Error(t("display:config_9a41667f55c6"));
  for (const key of ownedAdapterKeys) if (Object.hasOwn(document.spec.adapterConfig, key)) throw new Error(t("display:config_5ae7c55d5d3d", { value0: key === "paperclipSkillSync" ? "skills" : "instructions", value1: key }));
  const adapterConfig = { ...document.spec.adapterConfig };
  for (const key of ownedAdapterKeys) if (Object.hasOwn(snapshot.core.adapterConfig, key)) adapterConfig[key] = snapshot.core.adapterConfig[key];
  const corePatch = agentConfigurationPatch({ ...document, spec: { ...document.spec, adapterConfig } }, snapshot.core);
  if (Object.keys(corePatch).length) add(t("display:config_1c12eb5afa21"), () => agentsApi.update(snapshot.agent.id, {
    ...corePatch, expectedConfigurationRevision: snapshot.core.configurationRevision,
  }, snapshot.agent.companyId));
  if (document.spec.permissions && !document.spec.permissions.canAssignTasks && (document.spec.role === "ceo" || document.spec.permissions.canCreateAgents)) {
    throw new Error(t("display:config_48899f274cbf"));
  }
  planInstructions(snapshot, document, add);
  if (document.spec.skills && !equal(document.spec.skills, snapshot.document.spec.skills)) {
    unique(document.spec.skills.map(skill => typeof skill === "string" ? skill : skill.key), "skills");
    add(t("display:config_b3441235613a"), () => agentsApi.syncSkills(snapshot.agent.id, document.spec.skills!, "replace", snapshot.agent.companyId));
  }
  planToolChanges(snapshot, document, add);
  planChannelChanges(snapshot, document, add);
  planSecrets(snapshot, document, add, receipt);
  if (document.spec.permissions && !equal(document.spec.permissions, snapshot.document.spec.permissions)) {
    add(t("display:config_ebefb6061816"), () => agentsApi.updatePermissions(snapshot.agent.id, { ...document.spec.permissions!,
      authorizationPolicy: document.spec.permissions!.authorizationPolicy ?? {},
    }, snapshot.agent.companyId));
  }
  const keys = document.spec.apiKeys;
  if (keys) {
    unique(keys.revoke, "apiKeys.revoke");
    unique(keys.create.map(key => key.name), "apiKeys.create");
    for (const id of keys.revoke) {
      const key = requireItem(snapshot.keys, key => key.id === id, t("display:config_473001c729b2", { value0: id }));
      if (!key.revokedAt) add(t("display:config_82468d030f46", { value0: key.name }), () => agentsApi.revokeKey(snapshot.agent.id, id, snapshot.agent.companyId));
    }
    for (const input of keys.create) add(t("display:config_408ded387ba5", { value0: input.name }), async () => {
      const key = await agentsApi.createKey(snapshot.agent.id, input.name, snapshot.agent.companyId, input.scope);
      receipt({ label: t("display:config_83893bad839f", { value0: key.name }), id: key.id, token: key.token });
    });
  }
  if (document.spec.revisions?.restore) {
    const id = document.spec.revisions.restore;
    requireItem(snapshot.revisions, revision => revision.id === id, t("display:config_36c8a102465e", { value0: id }));
    if (steps.length) throw new Error(t("display:config_946c2bb906a8"));
    add(t("display:config_71a1f0ce2e6d"), () => agentsApi.rollbackConfigRevision(snapshot.agent.id, id, snapshot.agent.companyId));
  }
  return steps;
}

export async function saveAgentConfiguration(snapshot: AgentConfigurationSnapshot, input: AgentConfigurationInput,
  onReceipt: (receipt: ConfigurationReceipt) => void, onProgress: (label: string) => void) {
  const document = resolveAgentConfiguration(snapshot, input);
  const initialPlan = planResolvedConfiguration(snapshot, document, onReceipt);
  if (!initialPlan.length) return snapshot;
  const current = await loadAgentConfiguration(snapshot.agent.id, snapshot.agent.companyId);
  if (current.core.configurationRevision !== snapshot.core.configurationRevision) throw new Error(t("display:config_e8721a26758e"));
  for (const key of ["permissions", "instructions", "skills", "tools", "channels"] as const) {
    if (document.spec[key] !== undefined && !equal(document.spec[key], snapshot.document.spec[key]) && !equal(current.document.spec[key], snapshot.document.spec[key])) {
      throw new Error(t("display:config_1fac9137457f", { value0: key }));
    }
  }
  const spec = { ...document.spec };
  for (const key of ["permissions", "instructions", "skills", "tools", "channels"] as const) {
    if (equal(document.spec[key], snapshot.document.spec[key])) Object.assign(spec, { [key]: current.document.spec[key] });
  }
  for (const operation of [...(document.spec.secrets?.rotate ?? []), ...(document.spec.secrets?.update ?? [])]) {
    const previous = snapshot.secrets.find(secret => secret.id === operation.id);
    if (!equal(previous, current.secrets.find(secret => secret.id === operation.id))) throw new Error(t("display:config_77a2c3369bcf", { value0: operation.id }));
  }
  for (const profile of document.spec.tools?.profiles ?? []) {
    if (!profile.profileId) continue;
    const originalRow = snapshot.document.spec.tools?.profiles.find(value => value.profileId === profile.profileId);
    if (originalRow && equal(originalRow, profile)) continue;
    const before = snapshot.profiles.find(value => value.id === profile.profileId);
    const fresh = current.profiles.find(value => value.id === profile.profileId);
    if (!equal(before, fresh)) throw new Error(t("display:config_5e6319c1b721", { value0: profile.profileId }));
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
  catch (cause) { throw new ConfigurationSaveInterrupted(t("display:config_df01993de049"), completed, cause); }
}
