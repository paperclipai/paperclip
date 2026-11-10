import { CHAT_ORACLE_KEY_ENV, privateOracleIdentity, oracleSemanticFields, verifyRetainedPrivateOracle, type PrivateOracleIdentity } from "./chat-private-oracle.js";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CREDENTIAL_NAMES, type CredentialName, type MatrixExecution } from "./types.js";
import type { ChatCatalogDescriptor } from "./chat-catalog-registry.js";
import { runtimePrivateProviders, runtimePrivateReferenceNames, validateRuntimePrivateRequirement, type RuntimePrivateProvider } from "./chat-runtime-private-requirements.js";

export const CHAT_PRIVATE_INPUTS_ENV = "PAPERCLIP_CHAT_PRIVATE_INPUTS";
const externalConfigEnv = "PAPERCLIP_CHAT_CATALOG_EXTERNAL_CONFIG";
export interface ChatExternalInputRequirement { provider: "notion" | "slack" | "agentmail" | "vault" | "github" | RuntimePrivateProvider; fields: readonly string[] }
type PrivateInputDescriptor = Pick<ChatCatalogDescriptor, "requiredCredentials" | "externalInput"> & Partial<Pick<ChatCatalogDescriptor, "scenarioId">>;
export interface ChatPrivateInputs {
  readonly setupBlockers?: readonly string[];
  readonly credentials: Readonly<Partial<Record<CredentialName, string>>>;
  read(name: string): string | undefined;
  configuration(name: "external-provider"): unknown;
}
interface PrivateEnvelope { version: 1; executionId: string; credentials: Partial<Record<CredentialName, string>>; references: Record<string, string>; external?: unknown; setupBlockers?: string[]; oracleExpectation?: PrivateOracleIdentity; declaredCredentialNames?: string[]; declaredReferenceNames?: string[]; declaredExternalRequirements?: Array<{ provider: string; fields: string[] }> }
function readPrivateJson(filename: string, ownedRoot?: string): unknown {
  const info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.size > 262144
    || (ownedRoot && !realpathSync(filename).startsWith(realpathSync(ownedRoot) + path.sep)))
    throw new Error("Selected-case inputs require a bounded private0600 owned file; contents withheld");
  try { return JSON.parse(readFileSync(filename, "utf8")); } catch { throw new Error("Selected-case private inputs are invalid; contents withheld"); }
}
export function chatPrivateInputRequirements(descriptor?: PrivateInputDescriptor) {
  const credentialNames = [...new Set(descriptor?.requiredCredentials ?? [])].sort();
  if (credentialNames.some(name => !CREDENTIAL_NAMES.includes(name))) throw new Error("Unknown selected-case credential name");
  const external = descriptor?.externalInput;
  if (external && (!["notion", "slack", "agentmail", "vault", "github", ...runtimePrivateProviders].includes(external.provider)
    || !external.fields.length || external.fields.some(field => !/^[a-zA-Z][a-zA-Z0-9]*$/.test(field)))) throw new Error("Invalid selected external configuration requirements");
  if (external) validateRuntimePrivateRequirement(descriptor?.scenarioId, external.provider, external.fields, credentialNames);
  const requirements = { credentialNames, external: external ? { provider: external.provider, fields: [...external.fields].sort() } : null };
  return { ...requirements, digest: createHash("sha256").update(JSON.stringify(requirements)).digest("hex") };
}
export function stageChatPrivateInputs(input: { execution: MatrixExecution; descriptor?: PrivateInputDescriptor; privateDir: string; env: NodeJS.ProcessEnv; secrets: string[] }) {
  if (input.descriptor?.scenarioId && input.execution.task?.id !== input.descriptor.scenarioId) throw new Error("Selected private input declaration belongs to another scenario");
  const requirements = chatPrivateInputRequirements(input.descriptor);
  const envelope: PrivateEnvelope = { version: 1, executionId: input.execution.id, credentials: {}, references: {}, setupBlockers: [], declaredCredentialNames: requirements.credentialNames, declaredReferenceNames: [], declaredExternalRequirements: requirements.external ? [{ provider: requirements.external.provider, fields: requirements.external.fields }] : [] };
  for (const name of requirements.credentialNames) {
    const value = input.env[name]?.trim(); if (!value) { envelope.setupBlockers!.push(`missing-credential:${name}`); continue; }
    envelope.credentials[name] = value; input.secrets.push(value);
  }
  if (requirements.external) {
    try {
    const ref = input.env[externalConfigEnv]; if (!ref) throw new Error("Missing selected-case private external configuration");
    const config = readPrivateJson(ref) as { schemaVersion?: number; providers?: Record<string, { disposable?: boolean; resourceIds?: string[]; credentialEnv?: string[]; prerequisites?: Record<string, string> }> };
    const binding = config.schemaVersion === 1 ? config.providers?.[requirements.external.provider] : undefined;
    if (binding?.prerequisites) for (const field of requirements.external.fields) {
      if (typeof binding.prerequisites[field] !== "string" || !binding.prerequisites[field]?.trim()) envelope.setupBlockers!.push(`missing-external-field:${requirements.external.provider}:${field}`);
    }
    if (!binding || binding.disposable !== true || !Array.isArray(binding.resourceIds) || !binding.resourceIds.length
      || !Array.isArray(binding.credentialEnv) || (!binding.credentialEnv.length && !runtimePrivateProviders.includes(requirements.external.provider)) || !binding.prerequisites
      || requirements.external.fields.some(field => typeof binding.prerequisites?.[field] !== "string" || !binding.prerequisites[field]?.trim())) throw new Error("Selected disposable external configuration lacks declared prerequisites; contents withheld");
    const selected = { disposable: true, resourceIds: binding.resourceIds, credentialEnv: binding.credentialEnv,
      prerequisites: Object.fromEntries(requirements.external.fields.map(field => [field, binding.prerequisites![field]])) };
    const names = [...binding.credentialEnv, ...requirements.external.fields.filter(field => /(?:Env|EnvName)$/.test(field)).map(field => binding.prerequisites![field]!)];
    if (runtimePrivateProviders.includes(requirements.external.provider)) {
      const expected = runtimePrivateReferenceNames(requirements.external.provider);
      if (expected.some(name => !names.includes(name)) || names.some(name => !expected.includes(name))) throw new Error("Runtime private reference names do not match the selected provider's finite contract");
    }
    envelope.declaredReferenceNames = [...new Set(names)].sort();
    for (const name of new Set(names)) {
      if (!/^PAPERCLIP_CHAT_EVAL_[A-Z0-9_]+$/.test(name)) throw new Error("External credential reference is not a declared private environment name");
      const value = input.env[name]?.trim(); if (!value) { envelope.setupBlockers!.push(`missing-external-reference:${name}`); continue; }
      envelope.references[name] = value; input.secrets.push(value);
    }
    try { envelope.oracleExpectation = privateOracleIdentity(requirements.external.provider, requirements.external.fields, selected.prerequisites, input.env); }
    catch { envelope.setupBlockers!.push(`unavailable-oracle-commitment:${requirements.external.provider}`); }
    envelope.external = { schemaVersion: 1, providers: { [requirements.external.provider]: selected } };
    } catch { envelope.setupBlockers!.push(`unavailable-external-configuration:${requirements.external.provider}`); }
  }
  const filename = path.join(input.privateDir, "chat-selected-inputs.json");
  writeFileSync(filename, JSON.stringify(envelope), { mode: 0o600, flag: "wx" });
  return { filename, requirements };
}
export function readChatPrivateInputs(executionId: string, secrets: string[], env: NodeJS.ProcessEnv = process.env): ChatPrivateInputs {
  const reference = env[CHAT_PRIVATE_INPUTS_ENV], root = env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT;
  if (!reference) return { credentials: Object.freeze({}), read: () => undefined, configuration: () => undefined };
  if (!root) throw new Error("Selected private input ownership root is missing");
  const envelope = readPrivateJson(reference, root) as PrivateEnvelope;
  if (envelope.version !== 1 || envelope.executionId !== executionId || !envelope.credentials || !envelope.references)
    throw new Error("Private inputs belong to another execution; contents withheld");
  for (const value of [...Object.values(envelope.credentials), ...Object.values(envelope.references)]) {
    if (typeof value !== "string" || !value.trim()) throw new Error("Invalid private credential value; contents withheld");
    secrets.push(value);
  }
  if (envelope.setupBlockers?.some(value => !/^(?:missing-credential:[A-Z0-9_]+|missing-external-reference:PAPERCLIP_CHAT_EVAL_[A-Z0-9_]+|missing-external-field:[a-zA-Z]+:[a-zA-Z][a-zA-Z0-9]*|(?:unavailable-external-configuration|unavailable-oracle-commitment):[a-zA-Z]+)$/.test(value))) throw new Error("Invalid private setup blocker receipt");
  return { setupBlockers: Object.freeze(envelope.setupBlockers ?? []), credentials: Object.freeze(envelope.credentials), read: name => envelope.references[name] ?? envelope.credentials[name as CredentialName],
    configuration: name => name === "external-provider" ? envelope.external : undefined };
}
export function scrubChatPrivateEnvironment(env: NodeJS.ProcessEnv, executions: readonly MatrixExecution[], removeReference = false) {
  delete env[CHAT_ORACLE_KEY_ENV];
  for (const key of Object.keys(env)) if (key.startsWith("PAPERCLIP_CHAT_EVAL_") || key === externalConfigEnv || removeReference && [CHAT_PRIVATE_INPUTS_ENV, "PAPERCLIP_CHAT_INSTALLED_PLAN", "PAPERCLIP_CHAT_OPERATOR_INSTALL_RECEIPT", "PAPERCLIP_CHAT_INSTALLED_SOURCE_CONFIG"].includes(key)) delete env[key];
  if (executions.length) {
    const profileNames = new Set(executions.flatMap(execution => [execution.profile.credential, execution.environment.credential].filter(Boolean)));
    for (const name of CREDENTIAL_NAMES) if (!profileNames.has(name)) delete env[name];
  }
  return env;
}
/** Public fingerprint projection contains reference names and field names only. */
export function chatPrivateInputNameIdentity(executionId: string, env: NodeJS.ProcessEnv = process.env) {
  const reference = env[CHAT_PRIVATE_INPUTS_ENV], root = env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT;
  if (!reference) return null;
  if (!root) throw new Error("Selected private input ownership root is missing");
  const envelope = readPrivateJson(reference, root) as PrivateEnvelope;
  if (envelope.executionId !== executionId) throw new Error("Private input identity belongs to another execution");
  const external = envelope.external as { providers?: Record<string, { prerequisites?: Record<string, unknown> }> } | undefined;
  return { ...(envelope.oracleExpectation ? { oracleExpectation: envelope.oracleExpectation } : {}), credentialNames: envelope.declaredCredentialNames ?? Object.keys(envelope.credentials).sort(), referenceNames: envelope.declaredReferenceNames ?? Object.keys(envelope.references).sort(),
    externalRequirements: envelope.declaredExternalRequirements ?? Object.entries(external?.providers ?? {}).map(([provider, binding]) => ({ provider, fields: Object.keys(binding.prerequisites ?? {}).sort() })) };
}

/** Profile/environment credentials remain genuine launch prerequisites; selected
 * case-only inputs are evaluated within its reserved setup, never batch admission. */
export function chatLaunchCredentialNames(execution: MatrixExecution, descriptor?: PrivateInputDescriptor): CredentialName[] {
  const selected = new Set(descriptor?.requiredCredentials ?? []);
  const launch = new Set([execution.profile.credential, execution.environment.credential].filter(Boolean));
  return execution.requiredCredentials.filter(name => !selected.has(name) || launch.has(name));
}
export function chatPrivateSetupBlockers(inputs: ChatPrivateInputs | undefined, descriptor?: PrivateInputDescriptor): string[] {
  const requirements = chatPrivateInputRequirements(descriptor); const result = [...inputs?.setupBlockers ?? []];
  for (const name of requirements.credentialNames) if (!inputs?.credentials[name]?.trim()) result.push(`missing-credential:${name}`);
  if (requirements.external && !inputs?.configuration("external-provider")) result.push(`unavailable-external-configuration:${requirements.external.provider}`);
  return [...new Set(result)].sort();
}

export function verifyRetainedChatOracleIdentity(identity: ReturnType<typeof chatPrivateInputNameIdentity> | undefined, descriptor: PrivateInputDescriptor, env: NodeJS.ProcessEnv = process.env) {
  const requirement = descriptor.externalInput; if (!requirement || !oracleSemanticFields(requirement.provider, requirement.fields).length) return;
  const filename = env[externalConfigEnv]; if (!filename) throw new Error("Retained private oracle expectations unavailable; evidence cannot qualify");
  const config = readPrivateJson(filename) as { schemaVersion?: number; providers?: Record<string, { prerequisites?: Record<string, string> }> };
  if (config.schemaVersion !== 1) throw new Error("Retained private oracle configuration unavailable");
  verifyRetainedPrivateOracle(identity?.oracleExpectation, requirement.provider, requirement.fields, config.providers?.[requirement.provider]?.prerequisites ?? {}, env);
}
