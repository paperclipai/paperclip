import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  pluginEntities,
  pluginManagedResources,
} from "@paperclipai/db";
import type {
  Agent,
  PaperclipPluginManifestV1,
  PluginManagedAgentDeclaration,
  PluginManagedAgentResolution,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { agentService } from "./agents.js";
import { approvalService } from "./approvals.js";
import { logActivity } from "./activity-log.js";
import { agentInstructionsService } from "./agent-instructions.js";

const MANAGED_AGENT_ENTITY_TYPE = "managed_agent";
const DEFAULT_MANAGED_AGENT_ADAPTER_TYPE = "process";

interface PluginManagedAgentServiceOptions {
  pluginId: string;
  pluginKey: string;
  manifest?: PaperclipPluginManifestV1 | null;
  instructionTemplateVariables?: (companyId: string) => Promise<Record<string, string | null | undefined>>;
}

function bindingExternalId(companyId: string, agentKey: string) {
  return `managed:agent:${companyId}:${agentKey}`;
}

function managedMetadata(
  pluginId: string,
  pluginKey: string,
  declaration: PluginManagedAgentDeclaration,
  existing?: Record<string, unknown> | null,
) {
  return {
    ...(existing ?? {}),
    paperclipManagedResource: {
      pluginId,
      pluginKey,
      resourceKind: "agent",
      resourceKey: declaration.agentKey,
    },
    pluginManagedAgent: {
      pluginId,
      pluginKey,
      agentKey: declaration.agentKey,
      displayName: declaration.displayName,
      instructions: declaration.instructions ?? null,
    },
  };
}

function normalizeAdapterType(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function fallbackAdapterType(declaration: PluginManagedAgentDeclaration) {
  return normalizeAdapterType(declaration.adapterType) ?? DEFAULT_MANAGED_AGENT_ADAPTER_TYPE;
}

function adapterPreference(declaration: PluginManagedAgentDeclaration) {
  const seen = new Set<string>();
  const preference: string[] = [];
  for (const value of declaration.adapterPreference ?? []) {
    const adapterType = normalizeAdapterType(value);
    if (!adapterType || seen.has(adapterType)) continue;
    seen.add(adapterType);
    preference.push(adapterType);
  }
  return preference;
}

function selectPreferredAdapterType(
  declaration: PluginManagedAgentDeclaration,
  usage: Array<{ adapterType: string; count: number }>,
) {
  const fallback = fallbackAdapterType(declaration);
  const preference = adapterPreference(declaration);
  if (preference.length === 0) return fallback;

  const rank = new Map(preference.map((adapterType, index) => [adapterType, index]));
  let selected: { adapterType: string; count: number; rank: number } | null = null;
  for (const entry of usage) {
    const adapterRank = rank.get(entry.adapterType);
    if (adapterRank === undefined) continue;
    if (
      !selected ||
      entry.count > selected.count ||
      (entry.count === selected.count && adapterRank < selected.rank)
    ) {
      selected = { ...entry, rank: adapterRank };
    }
  }
  return selected?.adapterType ?? fallback;
}

function declarationPatch(declaration: PluginManagedAgentDeclaration, input: { adapterType?: string } = {}) {
  return {
    name: declaration.displayName,
    role: declaration.role ?? "general",
    title: declaration.title ?? null,
    icon: declaration.icon ?? null,
    capabilities: declaration.capabilities ?? null,
    adapterType: input.adapterType ?? fallbackAdapterType(declaration),
    adapterConfig: declaration.adapterConfig ?? {},
    runtimeConfig: declaration.runtimeConfig ?? {},
    permissions: declaration.permissions ?? {},
    budgetMonthlyCents: declaration.budgetMonthlyCents ?? 0,
  };
}

function applyInstructionTemplateVariables(
  content: string,
  variables: Record<string, string | null | undefined>,
) {
  let next = content;
  for (const [key, value] of Object.entries(variables)) {
    next = next.replaceAll(`{{${key}}}`, value?.trim() || "(not configured)");
  }
  return next;
}

function rowIsManagedAgent(
  row: typeof agents.$inferSelect,
  pluginKey: string,
  agentKey: string,
) {
  const metadata = row.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const marker = (metadata as Record<string, unknown>).paperclipManagedResource;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
  const record = marker as Record<string, unknown>;
  return (
    record.pluginKey === pluginKey
    && record.resourceKind === "agent"
    && record.resourceKey === agentKey
  );
}

export function pluginManagedAgentService(
  db: Db,
  options: PluginManagedAgentServiceOptions,
) {
  const agentSvc = agentService(db);
  const approvalSvc = approvalService(db);
  const instructions = agentInstructionsService();

  function declarationFor(agentKey: string) {
    const declaration = options.manifest?.agents?.find((agent) => agent.agentKey === agentKey);
    if (!declaration) {
      throw notFound(`Managed agent declaration not found: ${agentKey}`);
    }
    return declaration;
  }

  async function getBinding(companyId: string, agentKey: string) {
    return db
      .select()
      .from(pluginEntities)
      .where(
        and(
          eq(pluginEntities.pluginId, options.pluginId),
          eq(pluginEntities.entityType, MANAGED_AGENT_ENTITY_TYPE),
          eq(pluginEntities.externalId, bindingExternalId(companyId, agentKey)),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function upsertBinding(
    companyId: string,
    declaration: PluginManagedAgentDeclaration,
    agentId: string,
    extraData: Record<string, unknown> = {},
    effectiveAdapterType?: string,
  ) {
    const adapterType = effectiveAdapterType ?? (await resolveManagedAdapterType(companyId, declaration));
    const defaultsJson = {
      agentKey: declaration.agentKey,
      displayName: declaration.displayName,
      role: declaration.role ?? "general",
      title: declaration.title ?? null,
      icon: declaration.icon ?? null,
      capabilities: declaration.capabilities ?? null,
      adapterType,
      adapterPreference: declaration.adapterPreference ?? null,
      adapterConfig: declaration.adapterConfig ?? {},
      runtimeConfig: declaration.runtimeConfig ?? {},
      permissions: declaration.permissions ?? {},
      budgetMonthlyCents: declaration.budgetMonthlyCents ?? 0,
      instructions: declaration.instructions ?? null,
    };
    const managedResource = await db
      .select({ id: pluginManagedResources.id })
      .from(pluginManagedResources)
      .where(and(
        eq(pluginManagedResources.companyId, companyId),
        eq(pluginManagedResources.pluginId, options.pluginId),
        eq(pluginManagedResources.resourceKind, "agent"),
        eq(pluginManagedResources.resourceKey, declaration.agentKey),
      ))
      .then((rows) => rows[0] ?? null);
    if (managedResource) {
      await db
        .update(pluginManagedResources)
        .set({ resourceId: agentId, defaultsJson, updatedAt: new Date() })
        .where(eq(pluginManagedResources.id, managedResource.id));
    } else {
      await db.insert(pluginManagedResources).values({
        companyId,
        pluginId: options.pluginId,
        pluginKey: options.pluginKey,
        resourceKind: "agent",
        resourceKey: declaration.agentKey,
        resourceId: agentId,
        defaultsJson,
      });
    }

    const externalId = bindingExternalId(companyId, declaration.agentKey);
    const data = {
      pluginKey: options.pluginKey,
      resourceKind: "agent",
      resourceKey: declaration.agentKey,
      agentId,
      adapterType,
      declarationSnapshot: declaration,
      lastReconciledAt: new Date().toISOString(),
      ...extraData,
    };
    const existing = await getBinding(companyId, declaration.agentKey);
    if (existing) {
      return db
        .update(pluginEntities)
        .set({
          scopeKind: "company",
          scopeId: companyId,
          title: declaration.displayName,
          status: "resolved",
          data,
          updatedAt: new Date(),
        })
        .where(eq(pluginEntities.id, existing.id))
        .returning()
        .then((rows) => rows[0]);
    }
    return db
      .insert(pluginEntities)
      .values({
        pluginId: options.pluginId,
        entityType: MANAGED_AGENT_ENTITY_TYPE,
        scopeKind: "company",
        scopeId: companyId,
        externalId,
        title: declaration.displayName,
        status: "resolved",
        data,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function findRelinkCandidate(companyId: string, declaration: PluginManagedAgentDeclaration) {
    const rows = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
    return rows.find((row) => rowIsManagedAgent(row, options.pluginKey, declaration.agentKey)) ?? null;
  }

  async function companyAdapterUsage(companyId: string) {
    const rows = await db
      .select({ adapterType: agents.adapterType })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
    const counts = new Map<string, number>();
    for (const row of rows) {
      const adapterType = normalizeAdapterType(row.adapterType);
      if (!adapterType) continue;
      counts.set(adapterType, (counts.get(adapterType) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([adapterType, count]) => ({ adapterType, count }))
      .sort((a, b) => b.count - a.count || a.adapterType.localeCompare(b.adapterType))
      .slice(0, 10);
  }

  async function resolveManagedAdapterType(companyId: string, declaration: PluginManagedAgentDeclaration) {
    return selectPreferredAdapterType(declaration, await companyAdapterUsage(companyId));
  }

  async function materializeDeclaredInstructions(
    companyId: string,
    agent: Agent,
    declaration: PluginManagedAgentDeclaration,
    options: { replaceExisting: boolean },
  ): Promise<Agent> {
    const instructionDeclaration = declaration.instructions;
    if (!instructionDeclaration?.content) return agent;

    const entryFile = instructionDeclaration.entryFile ?? "AGENTS.md";
    const variables = await optionsForInstructionVariables(companyId);
    const materialized = await instructions.materializeManagedBundle(
      agent,
      { [entryFile]: applyInstructionTemplateVariables(instructionDeclaration.content, variables) },
      {
        entryFile,
        replaceExisting: options.replaceExisting,
        clearLegacyPromptTemplate: true,
      },
    );
    const updated = await agentSvc.update(agent.id, {
      adapterConfig: materialized.adapterConfig,
    }, {
      recordRevision: {
        source: `plugin:${optionsForRevisionSource()}:managed-agent-instructions`,
      },
    });
    return (updated as Agent | null) ?? { ...agent, adapterConfig: materialized.adapterConfig };
  }

  async function optionsForInstructionVariables(companyId: string) {
    return options.instructionTemplateVariables ? options.instructionTemplateVariables(companyId) : {};
  }

  function optionsForRevisionSource() {
    return options.pluginKey;
  }

  function resolution(
    companyId: string,
    declaration: PluginManagedAgentDeclaration,
    agent: Agent | null,
    status: PluginManagedAgentResolution["status"],
    approvalId?: string | null,
  ): PluginManagedAgentResolution {
    return {
      pluginKey: options.pluginKey,
      resourceKind: "agent",
      resourceKey: declaration.agentKey,
      companyId,
      agentId: agent?.id ?? null,
      agent,
      status,
      approvalId: approvalId ?? null,
    };
  }

  async function createManagedAgent(companyId: string, declaration: PluginManagedAgentDeclaration) {
    const company = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) throw notFound("Company not found");

    const requiresApproval = company.requireBoardApprovalForNewAgents;
    const adapterType = await resolveManagedAdapterType(companyId, declaration);
    let created = await agentSvc.create(companyId, {
      ...declarationPatch(declaration, { adapterType }),
      status: requiresApproval ? "pending_approval" : declaration.status ?? "idle",
      metadata: managedMetadata(options.pluginId, options.pluginKey, declaration),
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    }) as Agent;
    created = await materializeDeclaredInstructions(companyId, created, declaration, { replaceExisting: true });

    let approvalId: string | null = null;
    if (requiresApproval) {
      const approval = await approvalSvc.create(companyId, {
        type: "hire_agent",
        requestedByAgentId: null,
        requestedByUserId: null,
        status: "pending",
        payload: {
          name: created.name,
          role: created.role,
          title: created.title,
          icon: created.icon,
          reportsTo: created.reportsTo,
          capabilities: created.capabilities,
          adapterType: created.adapterType,
          adapterConfig: created.adapterConfig,
          runtimeConfig: created.runtimeConfig,
          budgetMonthlyCents: created.budgetMonthlyCents,
          metadata: created.metadata,
          agentId: created.id,
          sourcePluginId: options.pluginId,
          sourcePluginKey: options.pluginKey,
          managedResourceKey: declaration.agentKey,
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });
      approvalId = approval.id;
      await logActivity(db, {
        companyId,
        actorType: "plugin",
        actorId: options.pluginId,
        action: "approval.created",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: "hire_agent",
          linkedAgentId: created.id,
          sourcePluginKey: options.pluginKey,
          managedResourceKey: declaration.agentKey,
        },
      });
    }

    await upsertBinding(companyId, declaration, created.id, { approvalId }, adapterType);
    await logActivity(db, {
      companyId,
      actorType: "plugin",
      actorId: options.pluginId,
      action: "plugin.managed_agent.created",
      entityType: "agent",
      entityId: created.id,
      details: {
        sourcePluginKey: options.pluginKey,
        managedResourceKey: declaration.agentKey,
        adapterType,
        requiresApproval,
        approvalId,
      },
    });
    return resolution(companyId, declaration, created as Agent, "created", approvalId);
  }

  async function get(agentKey: string, companyId: string) {
      const declaration = declarationFor(agentKey);
      const binding = await getBinding(companyId, agentKey);
      const boundAgentId = typeof binding?.data?.agentId === "string" ? binding.data.agentId : null;
      if (!boundAgentId) return resolution(companyId, declaration, null, "missing");
      const agent = await agentSvc.getById(boundAgentId);
      if (!agent || agent.companyId !== companyId || agent.status === "terminated") {
        return resolution(companyId, declaration, null, "missing");
      }
      return resolution(companyId, declaration, agent as Agent, "resolved");
  }

  async function reconcile(agentKey: string, companyId: string) {
      const declaration = declarationFor(agentKey);
      const current = await get(agentKey, companyId);
      if (current.agent) {
        await upsertBinding(companyId, declaration, current.agent.id);
        return current;
      }

      const relinkCandidate = await findRelinkCandidate(companyId, declaration);
      if (relinkCandidate) {
        await upsertBinding(companyId, declaration, relinkCandidate.id);
        const agent = await agentSvc.getById(relinkCandidate.id);
        return resolution(companyId, declaration, agent as Agent, "relinked");
      }

      return createManagedAgent(companyId, declaration);
  }

  async function reset(agentKey: string, companyId: string) {
      const declaration = declarationFor(agentKey);
      const reconciled = await reconcile(agentKey, companyId);
      if (!reconciled.agent) return reconciled;
      const currentMetadata = reconciled.agent.metadata && typeof reconciled.agent.metadata === "object"
        ? reconciled.agent.metadata
        : {};
      const adapterType = await resolveManagedAdapterType(companyId, declaration);
      const updated = await agentSvc.update(reconciled.agent.id, {
        ...declarationPatch(declaration, { adapterType }),
        metadata: managedMetadata(options.pluginId, options.pluginKey, declaration, currentMetadata),
      }, {
        recordRevision: {
          source: `plugin:${options.pluginKey}:managed-agent-reset`,
        },
      });
      if (!updated) throw notFound("Managed agent not found");
      const updatedAgent = await materializeDeclaredInstructions(companyId, updated as Agent, declaration, { replaceExisting: true });
      await upsertBinding(companyId, declaration, updatedAgent.id, {}, adapterType);
      await logActivity(db, {
        companyId,
        actorType: "plugin",
        actorId: options.pluginId,
        action: "plugin.managed_agent.reset",
        entityType: "agent",
        entityId: updatedAgent.id,
        details: {
          sourcePluginKey: options.pluginKey,
          managedResourceKey: declaration.agentKey,
        },
      });
      return resolution(companyId, declaration, updatedAgent, "reset");
  }

  return {
    get,
    reconcile,
    reset,
  };
}
