import { createAgentLifecycle } from "./agent-lifecycle.js";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  pluginEntities,
  pluginManagedResources,
  plugins,
  activityLog,
} from "@paperclipai/db";
import type {
  Agent,
  PaperclipPluginManifestV1,
  PluginManagedAgentDeclaration,
  PluginManagedAgentResolution,
} from "@paperclipai/shared";
import { isUuidLike } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { agentService } from "./agents.js";
import { approvalService } from "./approvals.js";
import { logActivity } from "./activity-log.js";
import { agentInstructionsBundleMode, agentInstructionsService } from "./agent-instructions.js";
import { agentInstructionRevisionService } from "./agent-instruction-revisions.js";

const MANAGED_AGENT_ENTITY_TYPE = "managed_agent";
const DEFAULT_MANAGED_AGENT_ADAPTER_TYPE = "process";

function managedAgentPauseReason(pluginKey: string) {
  return `Provisioned paused by plugin ${pluginKey}; requires explicit activation.`;
}

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

function declaredInstructionFiles(
  declaration: PluginManagedAgentDeclaration,
  variables: Record<string, string | null | undefined>,
) {
  const instructionDeclaration = declaration.instructions;
  if (!instructionDeclaration?.content && !instructionDeclaration?.files) return null;

  const entryFile = instructionDeclaration.entryFile ?? "AGENTS.md";
  const files = { ...(instructionDeclaration.files ?? {}) };
  if (instructionDeclaration.content !== undefined) {
    files[entryFile] = instructionDeclaration.content;
  }
  if (files[entryFile] === undefined) {
    files[entryFile] = "";
  }

  return {
    entryFile,
    files: Object.fromEntries(
      Object.entries(files).map(([filePath, content]) => [
        filePath,
        applyInstructionTemplateVariables(content, variables),
      ]),
    ),
  };
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
  const agentSvcLifecycle = createAgentLifecycle(db);
  const approvalSvc = approvalService(db);
  const instructions = agentInstructionsService(db);

  function declarationFor(agentKey: string) {
    const declaration = options.manifest?.agents?.find((agent) => agent.agentKey === agentKey);
    if (!declaration) {
      throw notFound(`Managed agent declaration not found: ${agentKey}`);
    }
    return declaration;
  }

  async function getBinding(companyId: string, agentKey: string, client: Pick<Db, "select"> = db) {
    return client
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
    client: Pick<Db, "select" | "insert" | "update"> = db,
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
    const managedResource = await client
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
      await client
        .update(pluginManagedResources)
        .set({ resourceId: agentId, defaultsJson, updatedAt: new Date() })
        .where(eq(pluginManagedResources.id, managedResource.id));
    } else {
      await client.insert(pluginManagedResources).values({
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
    const existing = await getBinding(companyId, declaration.agentKey, client);
    if (existing) {
      return client
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
    return client
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

  async function relinkManagedAgent(companyId: string, declaration: PluginManagedAgentDeclaration, agentId: string) {
    const adapterType = await resolveManagedAdapterType(companyId, declaration);
    return db.transaction(async (tx) => {
      const [agent] = await tx.select().from(agents).where(and(
        eq(agents.id, agentId), eq(agents.companyId, companyId), ne(agents.status, "terminated"),
      )).for("update");
      if (!agent || !rowIsManagedAgent(agent, options.pluginKey, declaration.agentKey)) {
        throw conflict("Managed agent ownership changed before relink");
      }
      const [plugin] = await tx.select().from(plugins).where(and(
        eq(plugins.id, options.pluginId), eq(plugins.pluginKey, options.pluginKey),
      )).for("share");
      if (!plugin || plugin.status !== "ready" || !plugin.manifestJson.capabilities.includes("agents.managed")
        || !plugin.manifestJson.agents?.some((entry) => entry.agentKey === declaration.agentKey)) {
        throw forbidden("Plugin relink is limited to its registered managed agent declaration");
      }
      const marker = agent.metadata!.paperclipManagedResource as Record<string, unknown>;
      const previousPluginId = marker.pluginId;
      if (typeof previousPluginId !== "string" || !isUuidLike(previousPluginId)) throw forbidden("Managed agent has no plugin owner");
      if (previousPluginId !== options.pluginId) {
        const [previousPlugin] = await tx.select({ id: plugins.id }).from(plugins).where(eq(plugins.id, previousPluginId));
        if (previousPlugin) throw forbidden("Managed agent still belongs to another installed plugin");
      }
      // Hard uninstall cascades the bindings, but deliberately leaves the agent
      // and its canonical history. Transfer only its proven stable-key marker to
      // the replacement installation, atomically with the new scoped bindings.
      await upsertBinding(companyId, declaration, agentId, {}, adapterType, tx);
      await tx.update(agents).set({
        metadata: managedMetadata(options.pluginId, options.pluginKey, declaration, agent.metadata),
        updatedAt: new Date(),
      }).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId))).returning();
      await tx.insert(activityLog).values({
        companyId, actorType: "plugin", actorId: options.pluginId,
        action: "plugin.managed_agent.relinked", entityType: "agent", entityId: agentId,
        details: { sourcePluginKey: options.pluginKey, managedResourceKey: declaration.agentKey, previousPluginId },
      });
      const relinked = await agentService(tx as unknown as Db).getById(agentId);
      if (!relinked) throw notFound("Managed agent not found after relink");
      return relinked as Agent;
    });
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
    materializeOptions: { replaceExisting: boolean },
  ): Promise<Agent> {
    const variables = await optionsForInstructionVariables(companyId);
    const declared = declaredInstructionFiles(declaration, variables);
    if (!declared) return agent;

    let adapterConfig: Record<string, unknown>;
    if (materializeOptions.replaceExisting) {
      const revisions = agentInstructionRevisionService(db);
      const target = { companyId, agentId: agent.id };
      const actor = { type: "plugin" as const, pluginId: options.pluginId, pluginKey: options.pluginKey, agentKey: declaration.agentKey };
      const baseline = await revisions.readForPluginReset(target, actor);
      const receipt = await revisions.commitPluginReset({ ...target, entryFile: declared.entryFile,
        baseRevisionId: baseline.snapshot?.revision.id ?? null, configuredEntryFile: baseline.configuredEntryFile, content: declared.files[declared.entryFile] ?? "" }, actor);
      if (receipt.materialization === "pending") throw conflict("Instruction revision saved; retry reset to repair its disk copy", { revisionId: receipt.revision.id });
      const refreshed = await agentSvc.getById(agent.id);
      if (!refreshed) throw notFound("Managed agent not found");
      for (const [file, content] of Object.entries(declared.files)) {
        if (file !== declared.entryFile) await instructions.writeFile(refreshed, file, content);
      }
      // A stock reset owns declared instruction paths, not the agent's other
      // persistent files (including a formerly configured entry).
      adapterConfig = { ...refreshed.adapterConfig };
      delete adapterConfig.promptTemplate;
      delete adapterConfig.bootstrapPromptTemplate;
    } else {
      const materialized = await instructions.materializeManagedBundle(agent, declared.files, {
        entryFile: declared.entryFile, replaceExisting: false, clearLegacyPromptTemplate: true,
      });
      adapterConfig = materialized.adapterConfig;
    }
    const updated = await agentSvc.update(agent.id, {
      adapterConfig,
    }, {
      recordRevision: {
        source: `plugin:${optionsForRevisionSource()}:managed-agent-instructions`,
      },
    });
    return (updated as Agent | null) ?? { ...agent, adapterConfig };
  }

  async function managedInstructionDefaultDrift(
    companyId: string,
    agent: Agent | null,
    declaration: PluginManagedAgentDeclaration,
  ): Promise<PluginManagedAgentResolution["defaultDrift"]> {
    if (!agent) return null;
    const variables = await optionsForInstructionVariables(companyId);
    const declared = declaredInstructionFiles(declaration, variables);
    if (!declared) return null;
    if (agentInstructionsBundleMode(agent) === "external") {
      return { entryFile: declared.entryFile, changedFiles: [declared.entryFile] };
    }

    let exported: Awaited<ReturnType<typeof instructions.exportFiles>>;
    try {
      exported = await instructions.exportFiles(agent);
    } catch {
      return { entryFile: declared.entryFile, changedFiles: [declared.entryFile] };
    }

    const changedFiles = Object.keys(declared.files)
      .filter((filePath) => (exported.files[filePath] ?? null) !== (declared.files[filePath] ?? null))
      .sort((left, right) => left.localeCompare(right));
    if (exported.entryFile !== declared.entryFile && !changedFiles.includes(declared.entryFile)) {
      changedFiles.unshift(declared.entryFile);
    }
    return changedFiles.length > 0 ? { entryFile: declared.entryFile, changedFiles } : null;
  }

  async function optionsForInstructionVariables(companyId: string) {
    return options.instructionTemplateVariables ? options.instructionTemplateVariables(companyId) : {};
  }

  function optionsForRevisionSource() {
    return options.pluginKey;
  }

  async function resolution(
    companyId: string,
    declaration: PluginManagedAgentDeclaration,
    agent: Agent | null,
    status: PluginManagedAgentResolution["status"],
    approvalId?: string | null,
  ): Promise<PluginManagedAgentResolution> {
    return {
      pluginKey: options.pluginKey,
      resourceKind: "agent",
      resourceKey: declaration.agentKey,
      companyId,
      agentId: agent?.id ?? null,
      agent,
      status,
      approvalId: approvalId ?? null,
      defaultDrift: await managedInstructionDefaultDrift(companyId, agent, declaration),
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
    const initialStatus = requiresApproval ? "pending_approval" : declaration.status ?? "idle";
    let created = await agentSvcLifecycle.requestHire(companyId, {
      ...declarationPatch(declaration, { adapterType }),
      status: initialStatus,
      pauseReason: initialStatus === "paused" ? managedAgentPauseReason(options.pluginKey) : null,
      pausedAt: initialStatus === "paused" ? new Date() : null,
      metadata: managedMetadata(options.pluginId, options.pluginKey, declaration),
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    }) as Agent;
    created = await materializeDeclaredInstructions(companyId, created, declaration, { replaceExisting: false });

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

  async function backfillManagedPauseReason(
    companyId: string,
    declaration: PluginManagedAgentDeclaration,
    agent: Agent,
  ) {
    if (
      declaration.status !== "paused"
      || agent.lifecycleState !== "paused"
      || agent.pauseReason !== null
    ) {
      return agent;
    }

    const updated = await agentSvcLifecycle.pauseAgent(agent.id, managedAgentPauseReason(options.pluginKey));

    if (!updated) {
      const current = await agentSvc.getById(agent.id) as Agent | null;
      return current ?? agent;
    }

    await logActivity(db, {
      companyId,
      actorType: "plugin",
      actorId: options.pluginId,
      action: "plugin.managed_agent.pause_reason_backfilled",
      entityType: "agent",
      entityId: updated.id,
      details: {
        sourcePluginKey: options.pluginKey,
        managedResourceKey: declaration.agentKey,
        pauseReason: managedAgentPauseReason(options.pluginKey),
      },
    });

    const refreshed = await agentSvc.getById(updated.id) as Agent | null;
    return refreshed ?? agent;
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
        const agent = await backfillManagedPauseReason(companyId, declaration, current.agent);
        await upsertBinding(companyId, declaration, agent.id);
        return resolution(companyId, declaration, agent, current.status, current.approvalId);
      }

      const relinkCandidate = await findRelinkCandidate(companyId, declaration);
      if (relinkCandidate) {
        const relinkedAgent = await relinkManagedAgent(companyId, declaration, relinkCandidate.id);
        const agent = await backfillManagedPauseReason(
          companyId,
          declaration,
          relinkedAgent,
        );
        return resolution(companyId, declaration, agent, "relinked");
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
      // Reset content through the canonical CAS path before changing defaults.
      // A conflict must leave the existing adapter configuration untouched.
      const withInstructions = await materializeDeclaredInstructions(companyId, reconciled.agent, declaration, { replaceExisting: true });
      const defaults = declarationPatch(declaration, { adapterType });
      const adapterConfig = { ...defaults.adapterConfig } as Record<string, unknown>;
      if (declaration.instructions) {
        for (const key of ["instructionsBundleMode", "instructionsRootPath", "instructionsEntryFile", "instructionsFilePath"]) {
          if (withInstructions.adapterConfig[key] !== undefined) adapterConfig[key] = withInstructions.adapterConfig[key];
        }
      }
      const updated = await agentSvc.update(reconciled.agent.id, {
        ...defaults,
        adapterConfig,
        metadata: managedMetadata(options.pluginId, options.pluginKey, declaration, currentMetadata),
      }, {
        recordRevision: {
          source: `plugin:${options.pluginKey}:managed-agent-reset`,
        },
      });
      if (!updated) throw notFound("Managed agent not found");
      const updatedAgent = updated as Agent;
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
