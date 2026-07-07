import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import type { Agent } from "@paperclipai/shared";
import { conflict, HttpError, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { agentService } from "./agents.js";
import {
  readBuiltInAgentMarker,
  withBuiltInAgentMarker,
} from "./built-in-agent-metadata.js";

export type BuiltInAgentStatus = "not_provisioned" | "needs_setup" | "ready" | "paused";

export interface BuiltInAgentDefinition {
  key: string;
  displayName: string;
  featureKeys: string[];
  shortPurpose: string;
  defaultInstructions: string;
  defaultRole: string;
  allowedAdapterTypes?: string[];
  defaultBudgetMonthlyCents?: number;
}

export interface BuiltInAgentState {
  definition: BuiltInAgentDefinition;
  status: BuiltInAgentStatus;
  agentId: string | null;
  agent: Agent | null;
  pauseReason: string | null;
}

export interface BuiltInAgentProvisionInput {
  adapterType?: string;
  adapterConfig?: Record<string, unknown>;
}

export interface RequiredBuiltInAgentWarning {
  code: "built_in_agent_paused";
  key: string;
  agentId: string;
  message: string;
  pauseReason: string | null;
}

export interface RequiredBuiltInAgent {
  definition: BuiltInAgentDefinition;
  agent: Agent;
  warning: RequiredBuiltInAgentWarning | null;
}

const BUILT_IN_AGENT_KEY_PATTERN = /^[a-z][a-z0-9_-]*$/;

const DEFINITIONS = validateBuiltInAgentDefinitions([
  {
    key: "briefs",
    displayName: "Briefs Agent",
    featureKeys: ["briefs"],
    shortPurpose: "Prepares concise operational briefs for the board and agent company.",
    defaultInstructions:
      "You are Paperclip's built-in Briefs agent. Produce concise, sourced operational briefs that help the board understand current company work, risks, and next actions.",
    defaultRole: "general",
    allowedAdapterTypes: ["codex_local", "claude_local", "gemini_local", "opencode_local", "process"],
    defaultBudgetMonthlyCents: 0,
  },
  {
    key: "learning",
    displayName: "Learning Agent",
    featureKeys: ["learning"],
    shortPurpose: "Maintains reusable company learning from completed work and recurring patterns.",
    defaultInstructions:
      "You are Paperclip's built-in Learning agent. Extract durable lessons from completed work, preserve useful patterns, and keep learning artifacts grounded in source context.",
    defaultRole: "general",
    allowedAdapterTypes: ["codex_local", "claude_local", "gemini_local", "opencode_local", "process"],
    defaultBudgetMonthlyCents: 0,
  },
]);

const DEFINITIONS_BY_KEY = new Map(DEFINITIONS.map((definition) => [definition.key, definition]));

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueNonEmptyStrings(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function validateBuiltInAgentDefinitions(definitions: BuiltInAgentDefinition[]) {
  const seenKeys = new Set<string>();
  for (const definition of definitions) {
    if (!BUILT_IN_AGENT_KEY_PATTERN.test(definition.key)) {
      throw new Error(`Invalid built-in agent key: ${definition.key}`);
    }
    if (seenKeys.has(definition.key)) {
      throw new Error(`Duplicate built-in agent key: ${definition.key}`);
    }
    seenKeys.add(definition.key);
    if (!definition.displayName.trim()) {
      throw new Error(`Built-in agent ${definition.key} requires a displayName`);
    }
    if (!definition.shortPurpose.trim()) {
      throw new Error(`Built-in agent ${definition.key} requires a shortPurpose`);
    }
    if (!definition.defaultInstructions.trim()) {
      throw new Error(`Built-in agent ${definition.key} requires defaultInstructions`);
    }
    if (!definition.defaultRole.trim()) {
      throw new Error(`Built-in agent ${definition.key} requires a defaultRole`);
    }
    if (uniqueNonEmptyStrings(definition.featureKeys).length !== definition.featureKeys.length) {
      throw new Error(`Built-in agent ${definition.key} featureKeys must be unique non-empty strings`);
    }
    if (definition.featureKeys.length === 0) {
      throw new Error(`Built-in agent ${definition.key} requires at least one featureKey`);
    }
    if (
      definition.allowedAdapterTypes
      && uniqueNonEmptyStrings(definition.allowedAdapterTypes).length !== definition.allowedAdapterTypes.length
    ) {
      throw new Error(`Built-in agent ${definition.key} allowedAdapterTypes must be unique non-empty strings`);
    }
    if (
      definition.defaultBudgetMonthlyCents !== undefined
      && (!Number.isInteger(definition.defaultBudgetMonthlyCents) || definition.defaultBudgetMonthlyCents < 0)
    ) {
      throw new Error(`Built-in agent ${definition.key} defaultBudgetMonthlyCents must be a non-negative integer`);
    }
  }
  return definitions.map((definition) => ({
    ...definition,
    featureKeys: [...definition.featureKeys],
    allowedAdapterTypes: definition.allowedAdapterTypes ? [...definition.allowedAdapterTypes] : undefined,
  }));
}

export function listBuiltInAgentDefinitions() {
  return DEFINITIONS.map((definition) => ({ ...definition, featureKeys: [...definition.featureKeys] }));
}

export function getBuiltInAgentDefinition(key: string) {
  return DEFINITIONS_BY_KEY.get(key) ?? null;
}

export function requireBuiltInAgentDefinition(key: string) {
  const definition = getBuiltInAgentDefinition(key);
  if (!definition) throw notFound(`Built-in agent definition not found: ${key}`);
  return definition;
}

function defaultAdapterType(definition: BuiltInAgentDefinition) {
  return definition.allowedAdapterTypes?.[0] ?? "process";
}

function assertAdapterAllowed(definition: BuiltInAgentDefinition, adapterType: string) {
  if (definition.allowedAdapterTypes && !definition.allowedAdapterTypes.includes(adapterType)) {
    throw unprocessable(`Adapter type ${adapterType} is not allowed for built-in agent ${definition.key}`, {
      code: "built_in_agent_adapter_not_allowed",
      key: definition.key,
      allowedAdapterTypes: definition.allowedAdapterTypes,
    });
  }
}

function hasCompleteAdapterConfig(adapterType: string, adapterConfig: unknown) {
  if (!isPlainRecord(adapterConfig)) return false;
  if (["process", "command"].includes(adapterType)) {
    return nonEmptyString(adapterConfig.command) || nonEmptyString(adapterConfig.script);
  }
  if (adapterType === "http") {
    return nonEmptyString(adapterConfig.url) || nonEmptyString(adapterConfig.endpoint) || nonEmptyString(adapterConfig.webhookUrl);
  }
  if (adapterType === "openclaw_gateway" || adapterType === "hermes_gateway") {
    return nonEmptyString(adapterConfig.baseUrl) || nonEmptyString(adapterConfig.url);
  }
  return nonEmptyString(adapterConfig.model);
}

export function deriveBuiltInAgentStatus(agent: Pick<Agent, "adapterType" | "adapterConfig" | "status" | "pausedAt"> | null): BuiltInAgentStatus {
  if (!agent) return "not_provisioned";
  if (agent.status === "paused" || agent.pausedAt) return "paused";
  return hasCompleteAdapterConfig(agent.adapterType, agent.adapterConfig) ? "ready" : "needs_setup";
}

function builtInMetadata(definition: BuiltInAgentDefinition, existing?: Record<string, unknown> | null) {
  return withBuiltInAgentMarker(existing, {
    key: definition.key,
    featureKeys: definition.featureKeys,
  });
}

function definitionPatch(definition: BuiltInAgentDefinition, input: BuiltInAgentProvisionInput = {}) {
  const adapterType = input.adapterType ?? defaultAdapterType(definition);
  assertAdapterAllowed(definition, adapterType);
  return {
    name: definition.displayName,
    role: definition.defaultRole,
    title: null,
    capabilities: definition.shortPurpose,
    adapterType,
    adapterConfig: input.adapterConfig ?? {},
    budgetMonthlyCents: definition.defaultBudgetMonthlyCents ?? 0,
  };
}

function builtInAgentNotConfiguredError(state: BuiltInAgentState) {
  return new HttpError(412, `Built-in agent is not configured: ${state.definition.key}`, {
    code: "built_in_agent_not_configured",
    key: state.definition.key,
    status: state.status,
    agentId: state.agentId,
    featureKeys: state.definition.featureKeys,
  });
}

function rowIsBuiltInAgent(row: typeof agents.$inferSelect, key: string) {
  const marker = readBuiltInAgentMarker(row.metadata);
  return marker?.key === key;
}

export function builtInAgentService(db: Db) {
  const agentSvc = agentService(db);

  async function ensureCompany(companyId: string) {
    const company = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) throw notFound("Company not found");
  }

  async function findMarkedRows(companyId: string, key: string) {
    const rows = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
    return rows
      .filter((row) => rowIsBuiltInAgent(row, key))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
  }

  async function findSingleAgent(companyId: string, definition: BuiltInAgentDefinition) {
    const markedRows = await findMarkedRows(companyId, definition.key);
    if (markedRows.length > 1) {
      throw conflict(`Multiple built-in agents found for ${definition.key}`, {
        code: "built_in_agent_duplicate_instance",
        key: definition.key,
        agentIds: markedRows.map((row) => row.id),
      });
    }
    if (markedRows.length === 0) return null;
    const agent = await agentSvc.getById(markedRows[0]!.id);
    return agent as Agent | null;
  }

  function state(definition: BuiltInAgentDefinition, agent: Agent | null): BuiltInAgentState {
    return {
      definition,
      status: deriveBuiltInAgentStatus(agent),
      agentId: agent?.id ?? null,
      agent,
      pauseReason: agent?.pauseReason ?? null,
    };
  }

  async function get(companyId: string, key: string) {
    const definition = requireBuiltInAgentDefinition(key);
    await ensureCompany(companyId);
    return state(definition, await findSingleAgent(companyId, definition));
  }

  async function ensure(companyId: string, key: string, input: BuiltInAgentProvisionInput = {}) {
    const definition = requireBuiltInAgentDefinition(key);
    await ensureCompany(companyId);
    const existing = await findSingleAgent(companyId, definition);
    if (existing) {
      const patch: Partial<typeof agents.$inferInsert> = {
        metadata: builtInMetadata(definition, existing.metadata),
      };
      if (input.adapterType !== undefined || input.adapterConfig !== undefined) {
        const adapterType = input.adapterType ?? existing.adapterType;
        assertAdapterAllowed(definition, adapterType);
        patch.adapterType = adapterType;
        patch.adapterConfig = input.adapterConfig ?? existing.adapterConfig;
      }
      const updated = await agentSvc.update(existing.id, patch, {
        allowBuiltInAgentMetadata: true,
        recordRevision: { source: "built-in-agent:ensure" },
      });
      if (!updated) throw notFound("Built-in agent not found");
      return state(definition, updated as Agent);
    }

    const created = await agentSvc.create(companyId, {
      ...definitionPatch(definition, input),
      status: "idle",
      metadata: builtInMetadata(definition),
      runtimeConfig: {},
      permissions: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    }, { allowBuiltInAgentMetadata: true }) as Agent;

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "built-in-agents",
      action: "built_in_agent.provisioned",
      entityType: "agent",
      entityId: created.id,
      details: {
        key: definition.key,
        featureKeys: definition.featureKeys,
        status: deriveBuiltInAgentStatus(created),
      },
    });

    return state(definition, created);
  }

  async function list(companyId: string) {
    await ensureCompany(companyId);
    return Promise.all(DEFINITIONS.map(async (definition) => state(definition, await findSingleAgent(companyId, definition))));
  }

  async function reconcileDefinitionDefaults(companyId: string, key: string) {
    const definition = requireBuiltInAgentDefinition(key);
    await ensureCompany(companyId);
    const existing = await findSingleAgent(companyId, definition);
    if (!existing) return state(definition, null);
    const patch = {
      name: definition.displayName,
      role: definition.defaultRole,
      title: null,
      capabilities: definition.shortPurpose,
      metadata: builtInMetadata(definition, existing.metadata),
    };
    const updated = await agentSvc.update(existing.id, patch, {
      allowBuiltInAgentMetadata: true,
      recordRevision: { source: "built-in-agent:reconcile-defaults" },
    });
    if (!updated) throw notFound("Built-in agent not found");
    return state(definition, updated as Agent);
  }

  async function reset(companyId: string, key: string) {
    return reconcileDefinitionDefaults(companyId, key);
  }

  async function requireBuiltInAgent(companyId: string, key: string): Promise<RequiredBuiltInAgent> {
    const current = await get(companyId, key);
    if (!current.agent) throw builtInAgentNotConfiguredError(current);
    if (current.status === "ready") {
      return { definition: current.definition, agent: current.agent, warning: null };
    }
    if (current.status === "paused") {
      return {
        definition: current.definition,
        agent: current.agent,
        warning: {
          code: "built_in_agent_paused",
          key: current.definition.key,
          agentId: current.agent.id,
          message: `Built-in agent ${current.definition.key} is paused; scheduled/background work should be skipped.`,
          pauseReason: current.pauseReason,
        },
      };
    }
    throw builtInAgentNotConfiguredError(current);
  }

  return {
    definitions: listBuiltInAgentDefinitions,
    get,
    ensure,
    list,
    reset,
    requireBuiltInAgent,
    reconcileDefinitionDefaults,
  };
}

export async function reconcileBuiltInAgentsOnStartup(db: Db) {
  const svc = builtInAgentService(db);
  const rows = await db
    .select({
      companyId: agents.companyId,
      metadata: agents.metadata,
      status: agents.status,
    })
    .from(agents)
    .where(ne(agents.status, "terminated"));
  const seen = new Set<string>();
  let scanned = 0;
  let reconciled = 0;
  let unknown = 0;
  let duplicates = 0;

  for (const row of rows) {
    const marker = readBuiltInAgentMarker(row.metadata);
    if (!marker) continue;
    scanned += 1;
    if (!getBuiltInAgentDefinition(marker.key)) {
      unknown += 1;
      continue;
    }
    const instanceKey = `${row.companyId}:${marker.key}`;
    if (seen.has(instanceKey)) {
      duplicates += 1;
      continue;
    }
    seen.add(instanceKey);
    await svc.reconcileDefinitionDefaults(row.companyId, marker.key);
    reconciled += 1;
  }

  return { scanned, reconciled, unknown, duplicates };
}
