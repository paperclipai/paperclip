import type { Agent, CompanySecret, UserSecretDefinition } from "@paperclipai/shared";
import { agentsApi } from "../../api/agents";
import { AGENT_ACCESS_CONFIG_PATH_PREFIX } from "../../lib/secret-delivery";

export type AgentAccessReference =
  | { kind: "company"; secret: CompanySecret }
  | { kind: "user"; definition: UserSecretDefinition };

export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

type BindingRecord = Record<string, unknown>;

function isBinding(value: unknown): value is BindingRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bindingMatches(binding: BindingRecord, reference: AgentAccessReference): boolean {
  return reference.kind === "company"
    ? binding.type === "secret_ref" && binding.secretId === reference.secret.id
    : binding.type === "user_secret_ref" && binding.key === reference.definition.key;
}

/** Env keys in an agent's env config that resolve to this secret/definition. */
export function envKeysReferencingSecret(env: unknown, reference: AgentAccessReference): string[] {
  if (!isBinding(env)) return [];
  return Object.entries(env)
    .filter(([, binding]) => isBinding(binding) && bindingMatches(binding, reference))
    .map(([key]) => key)
    .sort();
}

/**
 * Top-level `access.<ALIAS>` keys in an agent's adapter config that resolve to
 * this secret (API-access delivery). Only company secrets support API access;
 * user secrets remain env-only.
 */
export function apiAliasesReferencingSecret(adapterConfig: unknown, reference: AgentAccessReference): string[] {
  if (reference.kind !== "company" || !isBinding(adapterConfig)) return [];
  return Object.entries(adapterConfig)
    .filter(([key, binding]) => key.startsWith(AGENT_ACCESS_CONFIG_PATH_PREFIX) && isBinding(binding) && bindingMatches(binding, reference))
    .map(([key]) => key.slice(AGENT_ACCESS_CONFIG_PATH_PREFIX.length))
    .sort();
}

export interface SecretAgentUsage {
  /** Agents holding a binding to a company secret, keyed by secret id. */
  bySecretId: Map<string, Agent[]>;
  /** Agents holding a binding to a user-provided secret, keyed by its key. */
  byUserSecretKey: Map<string, Agent[]>;
}

function push(map: Map<string, Agent[]>, key: string, agent: Agent) {
  const list = map.get(key);
  if (!list) map.set(key, [agent]);
  else if (list[list.length - 1] !== agent) list.push(agent);
}

/**
 * Which agents can use which secret, read once from the agents' own configs.
 * One pass over the agents instead of one scan per row.
 */
export function buildSecretAgentUsage(agents: readonly Agent[]): SecretAgentUsage {
  const usage: SecretAgentUsage = { bySecretId: new Map(), byUserSecretKey: new Map() };
  for (const agent of agents) {
    if (agent.status === "terminated") continue;
    const adapterConfig = agent.adapterConfig as unknown;
    if (!isBinding(adapterConfig)) continue;
    const bindings: unknown[] = [
      ...(isBinding(adapterConfig.env) ? Object.values(adapterConfig.env) : []),
      ...Object.entries(adapterConfig).filter(([key]) => key.startsWith(AGENT_ACCESS_CONFIG_PATH_PREFIX)).map(([, binding]) => binding),
    ];
    for (const binding of bindings) {
      if (!isBinding(binding)) continue;
      if (binding.type === "secret_ref" && typeof binding.secretId === "string") push(usage.bySecretId, binding.secretId, agent);
      else if (binding.type === "user_secret_ref" && typeof binding.key === "string") push(usage.byUserSecretKey, binding.key, agent);
    }
  }
  return usage;
}

/** Give one agent the secret as an environment variable, merged into its freshest config. */
export async function grantAgentSecretAccess(input: {
  companyId: string;
  agentId: string;
  envKey: string;
  reference: AgentAccessReference;
}): Promise<Agent> {
  const detail = await agentsApi.get(input.agentId, input.companyId);
  const adapterConfig = { ...((detail.adapterConfig ?? {}) as Record<string, unknown>) };
  const env = { ...((adapterConfig.env ?? {}) as Record<string, unknown>) };
  if (env[input.envKey] !== undefined) {
    throw new Error(`${detail.name} already has an env var named ${input.envKey}.`);
  }
  env[input.envKey] =
    input.reference.kind === "company"
      ? { type: "secret_ref", secretId: input.reference.secret.id }
      : { type: "user_secret_ref", key: input.reference.definition.key };
  return agentsApi.update(input.agentId, { adapterConfig: { ...adapterConfig, env }, replaceAdapterConfig: true }, input.companyId);
}

/** Remove every env var and API alias of one agent that points at the secret. */
export async function revokeAgentSecretAccess(input: {
  companyId: string;
  agentId: string;
  reference: AgentAccessReference;
}): Promise<Agent> {
  const detail = await agentsApi.get(input.agentId, input.companyId);
  const adapterConfig = { ...((detail.adapterConfig ?? {}) as Record<string, unknown>) };
  const env = { ...((adapterConfig.env ?? {}) as Record<string, unknown>) };
  const keys = envKeysReferencingSecret(env, input.reference);
  const aliases = apiAliasesReferencingSecret(adapterConfig, input.reference);
  if (keys.length === 0 && aliases.length === 0) return detail;
  for (const key of keys) delete env[key];
  for (const alias of aliases) delete adapterConfig[`${AGENT_ACCESS_CONFIG_PATH_PREFIX}${alias}`];
  return agentsApi.update(input.agentId, { adapterConfig: { ...adapterConfig, env }, replaceAdapterConfig: true }, input.companyId);
}
