import { createHash } from "node:crypto";
import type { Agent } from "@paperclipai/shared";

export interface AgentConfigSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  companyId: string;
  agents: AgentConfigSnapshotEntry[];
}

export interface AgentConfigSnapshotEntry {
  id: string;
  name: string;
  urlKey: string;
  role: Agent["role"];
  title: string | null;
  status: Agent["status"];
  reportsTo: string | null;
  reportsToName: string | null;
  adapterType: Agent["adapterType"];
  defaultEnvironmentId: string | null;
  budgetMonthlyCents: number;
  permissions: Agent["permissions"];
  adapterConfig: ConfigFingerprint;
  runtimeConfig: ConfigFingerprint;
  metadata: ConfigFingerprint;
}

export interface ConfigFingerprint {
  keys: string[];
  fingerprint: string;
  safeValues: Record<string, unknown>;
}

export interface AgentSnapshotDiff {
  status: "match" | "drift";
  missingAgents: string[];
  unexpectedAgents: string[];
  changedAgents: Array<{ name: string; fields: string[] }>;
}

const SAFE_CONFIG_PATHS = new Set([
  "cwd",
  "model",
  "modelId",
  "profile",
  "hermesProfile",
  "workspaceStrategy.type",
  "workspaceStrategy.branchTemplate",
  "workspaceStrategy.baseRef",
  "heartbeat.enabled",
  "heartbeat.intervalSec",
  "heartbeat.wakeOnAssignment",
  "heartbeat.wakeOnOnDemand",
  "heartbeat.wakeOnAutomation",
  "heartbeat.maxConcurrentRuns",
  "timeoutSec",
  "graceSec",
]);

export function buildAgentConfigSnapshot(input: {
  companyId: string;
  generatedAt?: string;
  agents: Agent[];
}): AgentConfigSnapshot {
  const agentNameById = new Map(input.agents.map((agent) => [agent.id, agent.name]));
  const agents = input.agents
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      urlKey: agent.urlKey,
      role: agent.role,
      title: agent.title,
      status: agent.status,
      reportsTo: agent.reportsTo,
      reportsToName: agent.reportsTo ? agentNameById.get(agent.reportsTo) ?? null : null,
      adapterType: agent.adapterType,
      defaultEnvironmentId: agent.defaultEnvironmentId ?? null,
      budgetMonthlyCents: agent.budgetMonthlyCents,
      permissions: agent.permissions,
      adapterConfig: fingerprintConfig(agent.adapterConfig),
      runtimeConfig: fingerprintConfig(agent.runtimeConfig),
      metadata: fingerprintConfig(agent.metadata ?? {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    companyId: input.companyId,
    agents,
  };
}

export function diffAgentConfigSnapshots(
  expected: AgentConfigSnapshot,
  actual: AgentConfigSnapshot,
): AgentSnapshotDiff {
  const expectedByName = new Map(expected.agents.map((agent) => [agent.name, agent]));
  const actualByName = new Map(actual.agents.map((agent) => [agent.name, agent]));
  const missingAgents = expected.agents
    .filter((agent) => !actualByName.has(agent.name))
    .map((agent) => agent.name)
    .sort();
  const unexpectedAgents = actual.agents
    .filter((agent) => !expectedByName.has(agent.name))
    .map((agent) => agent.name)
    .sort();
  const changedAgents = expected.agents
    .filter((agent) => actualByName.has(agent.name))
    .map((expectedAgent) => {
      const actualAgent = actualByName.get(expectedAgent.name)!;
      return {
        name: expectedAgent.name,
        fields: diffAgentFields(expectedAgent, actualAgent),
      };
    })
    .filter((entry) => entry.fields.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    status:
      missingAgents.length === 0 && unexpectedAgents.length === 0 && changedAgents.length === 0
        ? "match"
        : "drift",
    missingAgents,
    unexpectedAgents,
    changedAgents,
  };
}

export function renderAgentSnapshotDiff(diff: AgentSnapshotDiff): string {
  if (diff.status === "match") return "Agent snapshot matches expected fixture.";
  const lines = ["Agent snapshot drift detected."];
  if (diff.missingAgents.length > 0) {
    lines.push(`Missing agents: ${diff.missingAgents.join(", ")}`);
  }
  if (diff.unexpectedAgents.length > 0) {
    lines.push(`Unexpected agents: ${diff.unexpectedAgents.join(", ")}`);
  }
  for (const changed of diff.changedAgents) {
    lines.push(`Changed ${changed.name}: ${changed.fields.join(", ")}`);
  }
  return lines.join("\n");
}

function diffAgentFields(
  expected: AgentConfigSnapshotEntry,
  actual: AgentConfigSnapshotEntry,
): string[] {
  return Object.keys(expected)
    .filter((key) => {
      const field = key as keyof AgentConfigSnapshotEntry;
      return stableStringify(expected[field]) !== stableStringify(actual[field]);
    })
    .sort();
}

function fingerprintConfig(config: Record<string, unknown>): ConfigFingerprint {
  return {
    keys: Object.keys(config).sort(),
    fingerprint: sha256(stableStringify(config)),
    safeValues: collectSafeValues(config),
  };
}

function collectSafeValues(config: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  function visit(value: unknown, path: string): void {
    if (SAFE_CONFIG_PATHS.has(path) && isJsonPrimitive(value)) {
      values[path] = value;
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
      visit(child, path ? `${path}.${key}` : key);
    }
  }

  visit(config, "");
  return Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
}

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableJson(value));
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortForStableJson(child)]),
  );
}
