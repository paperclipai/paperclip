import type { EnvSecretRefBinding, SecretVersionSelector } from "@paperclipai/shared";
import { AGENT_ACCESS_CONFIG_PATH_PREFIX, SECRET_ALIAS_RE } from "../lib/secret-delivery";
import { envKeyFromSecretName } from "./environment-variables-editor/model";

export interface AgentSecretRefEntry {
  /** env KEY (env delivery) or access ALIAS (API-access delivery). */
  name: string;
  secretId: string;
  version: SecretVersionSelector;
}

export interface AgentSecretBindingSummary {
  secretId: string;
  envKeys: string[];
  apiAliases: string[];
}

export interface EnvironmentSecretRow {
  id: string;
  name: string;
  secretId: string;
  version: SecretVersionSelector;
}

export interface AccessRow {
  id: string;
  alias: string;
  secretId: string;
  version: SecretVersionSelector;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readSecretRef(raw: unknown): { secretId: string; version: SecretVersionSelector } | null {
  const binding = asRecord(raw);
  if (!binding || binding.type !== "secret_ref") return null;
  const secretId = typeof binding.secretId === "string" ? binding.secretId : "";
  if (!secretId) return null;
  const version: SecretVersionSelector = typeof binding.version === "number" ? binding.version : "latest";
  return { secretId, version };
}

/** Secret-ref bindings delivered as environment variables (`config.env.<KEY>`). */
export function parseEnvSecretRefs(config: Record<string, unknown> | null | undefined): AgentSecretRefEntry[] {
  const env = asRecord(config?.env);
  if (!env) return [];
  const entries: AgentSecretRefEntry[] = [];
  for (const [key, raw] of Object.entries(env)) {
    const ref = readSecretRef(raw);
    if (ref) entries.push({ name: key, ...ref });
  }
  return entries;
}

/** Secret-ref bindings delivered via the agent API (top-level `access.<ALIAS>`). */
export function parseAccessGrants(config: Record<string, unknown> | null | undefined): AgentSecretRefEntry[] {
  if (!config) return [];
  const entries: AgentSecretRefEntry[] = [];
  for (const [key, raw] of Object.entries(config)) {
    if (!key.startsWith(AGENT_ACCESS_CONFIG_PATH_PREFIX)) continue;
    const ref = readSecretRef(raw);
    if (ref) entries.push({ name: key.slice(AGENT_ACCESS_CONFIG_PATH_PREFIX.length), ...ref });
  }
  return entries;
}

/** Group env + API bindings by secret for callers that need a combined summary. */
export function summarizeAgentBindings(
  envBindings: readonly AgentSecretRefEntry[],
  apiBindings: readonly AgentSecretRefEntry[],
): AgentSecretBindingSummary[] {
  const bySecret = new Map<string, AgentSecretBindingSummary>();
  const ensure = (secretId: string) => {
    let summary = bySecret.get(secretId);
    if (!summary) {
      summary = { secretId, envKeys: [], apiAliases: [] };
      bySecret.set(secretId, summary);
    }
    return summary;
  };
  for (const entry of envBindings) ensure(entry.secretId).envKeys.push(entry.name);
  for (const entry of apiBindings) ensure(entry.secretId).apiAliases.push(entry.name);
  return [...bySecret.values()];
}

let accessRowCounter = 0;
let environmentRowCounter = 0;

export function nextAccessRowId(): string {
  accessRowCounter += 1;
  return `access-row-${accessRowCounter}`;
}

export function nextEnvironmentRowId(): string {
  environmentRowCounter += 1;
  return `environment-secret-row-${environmentRowCounter}`;
}

export function entriesToAccessRows(entries: readonly AgentSecretRefEntry[]): AccessRow[] {
  return entries.map((entry) => ({
    id: nextAccessRowId(),
    alias: entry.name,
    secretId: entry.secretId,
    version: entry.version,
  }));
}

export function entriesToEnvironmentRows(entries: readonly AgentSecretRefEntry[]): EnvironmentSecretRow[] {
  return entries.map((entry) => ({
    id: nextEnvironmentRowId(),
    name: entry.name,
    secretId: entry.secretId,
    version: entry.version,
  }));
}

/** Derive a valid, collision-free env key for a newly selected company secret. */
export function nextAvailableEnvKey(secretName: string, existingNames: Iterable<string>): string {
  const used = new Set(
    Array.from(existingNames, (name) => name.trim()).filter(Boolean),
  );
  const base = envKeyFromSecretName(secretName);
  if (!used.has(base)) return base;

  for (let index = 2; ; index += 1) {
    const suffix = `_${index}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Complete environment-secret bindings keyed by their preserved env names. */
export function rowsToEnvMap(rows: readonly EnvironmentSecretRow[]): Record<string, EnvSecretRefBinding> {
  const map: Record<string, EnvSecretRefBinding> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name || !SECRET_ALIAS_RE.test(name) || !row.secretId || seen.has(name)) continue;
    seen.add(name);
    map[name] = { type: "secret_ref", secretId: row.secretId, version: row.version };
  }
  return map;
}

/** Complete, valid API-access grants keyed by alias. */
export function rowsToAccessMap(rows: readonly AccessRow[]): Record<string, EnvSecretRefBinding> {
  const map: Record<string, EnvSecretRefBinding> = {};
  for (const row of rows) {
    const alias = row.alias.trim();
    if (!alias || !SECRET_ALIAS_RE.test(alias) || !row.secretId) continue;
    map[alias] = { type: "secret_ref", secretId: row.secretId, version: row.version };
  }
  return map;
}

/** Stable key for controlled secret-ref maps. */
export function normalizeAccessMapKey(map: Record<string, EnvSecretRefBinding>): string {
  return JSON.stringify(
    Object.keys(map)
      .sort()
      .map((name) => {
        const binding = map[name]!;
        return [name, binding.secretId, binding.version ?? "latest"];
      }),
  );
}
