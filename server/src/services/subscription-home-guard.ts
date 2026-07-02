import os from "node:os";
import path from "node:path";
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";

// Subscription-scoped auth homes for local CLI adapters. Two active agents
// resolving the same home means two agents share one provider login, which
// risks cross-account/credential mixing when the homes belong to different
// employees (see PAU-263/PAU-281).
export const SUBSCRIPTION_HOME_ENV_KEYS = ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "HOME"] as const;

export type SubscriptionHomeEnvKey = (typeof SUBSCRIPTION_HOME_ENV_KEYS)[number];

export type SubscriptionHomeBinding = {
  envKey: SubscriptionHomeEnvKey;
  homePath: string;
};

export type SubscriptionHomeConflict = {
  envKey: SubscriptionHomeEnvKey;
  otherEnvKey: SubscriptionHomeEnvKey;
  homePath: string;
  otherAgentId: string;
  otherAgentName: string | null;
  otherAgentStatus: string | null;
};

type AgentLike = {
  id: string;
  name?: string | null;
  status?: string | null;
  adapterConfig?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// Accepts plain string env values and { type: "plain", value } bindings.
// Secret refs are skipped: their resolved values are unknown at config time
// and must not be surfaced in errors or logs.
function asPlainEnvString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const record = asRecord(value);
  if (record?.type !== "plain") return null;
  if (typeof record.value !== "string") return null;
  const trimmed = record.value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeSubscriptionHomePath(value: string): string {
  let expanded = value;
  if (expanded === "~") {
    expanded = os.homedir();
  } else if (expanded.startsWith("~/")) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  return path.resolve(expanded);
}

export function allowsSharedSubscriptionHome(adapterConfig: unknown): boolean {
  const config = asRecord(adapterConfig);
  return config?.allowSharedSubscriptionHome === true;
}

export function listSubscriptionHomeBindings(
  adapterConfig: unknown,
  options?: { skipEnvKeys?: ReadonlySet<string> },
): SubscriptionHomeBinding[] {
  const config = asRecord(adapterConfig);
  const env = asRecord(config?.env);
  if (!env) return [];
  const bindings: SubscriptionHomeBinding[] = [];
  for (const envKey of SUBSCRIPTION_HOME_ENV_KEYS) {
    if (options?.skipEnvKeys?.has(envKey)) continue;
    const raw = asPlainEnvString(env[envKey]);
    if (!raw) continue;
    bindings.push({ envKey, homePath: normalizeSubscriptionHomePath(raw) });
  }
  return bindings;
}

// Conflicts are detected by resolved path, not env key: HOME=/x on one agent
// and CLAUDE_CONFIG_DIR=/x on another still point both logins at /x.
export function findSubscriptionHomeConflicts(input: {
  candidateBindings: readonly SubscriptionHomeBinding[];
  otherAgents: readonly AgentLike[];
}): SubscriptionHomeConflict[] {
  if (input.candidateBindings.length === 0) return [];
  const conflicts: SubscriptionHomeConflict[] = [];
  for (const other of input.otherAgents) {
    if (allowsSharedSubscriptionHome(other.adapterConfig)) continue;
    const otherBindings = listSubscriptionHomeBindings(other.adapterConfig);
    if (otherBindings.length === 0) continue;
    for (const candidate of input.candidateBindings) {
      for (const otherBinding of otherBindings) {
        if (candidate.homePath !== otherBinding.homePath) continue;
        conflicts.push({
          envKey: candidate.envKey,
          otherEnvKey: otherBinding.envKey,
          homePath: candidate.homePath,
          otherAgentId: other.id,
          otherAgentName: other.name ?? null,
          otherAgentStatus: other.status ?? null,
        });
      }
    }
  }
  return conflicts;
}

export async function listOtherActiveAgentsForSubscriptionHomeCheck(
  db: Db,
  companyId: string,
  excludeAgentId: string,
): Promise<AgentLike[]> {
  return db
    .select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        ne(agents.id, excludeAgentId),
        ne(agents.status, "terminated"),
      ),
    );
}

export function formatSubscriptionHomeConflict(conflictEntry: SubscriptionHomeConflict): string {
  const otherAgentLabel = conflictEntry.otherAgentName
    ? `"${conflictEntry.otherAgentName}" (${conflictEntry.otherAgentId})`
    : conflictEntry.otherAgentId;
  return (
    `env ${conflictEntry.envKey} resolves to "${conflictEntry.homePath}", which agent ${otherAgentLabel} ` +
    `already binds via ${conflictEntry.otherEnvKey}`
  );
}
