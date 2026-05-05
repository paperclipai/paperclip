import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  pluginManagedResources,
  plugins,
  projects,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import type {
  CreateRoutineTrigger,
  PluginManagedResourceRef,
  PluginManagedRoutineDeclaration,
  PluginManagedRoutineResolution,
  Routine,
  RoutineManagedByPlugin,
  RoutineStatus,
} from "@paperclipai/shared";
import { ROUTINE_STATUSES } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { routineService } from "./routines.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

const MANAGED_ROUTINE_RESOURCE_KIND = "routine";

interface PluginManagedRoutineServiceOptions {
  pluginId: string;
  pluginKey: string;
  manifest?: import("@paperclipai/shared").PaperclipPluginManifestV1 | null;
  pluginWorkerManager?: PluginWorkerManager;
}

interface RoutineOverrides {
  assigneeAgentId?: string | null;
  projectId?: string | null;
}

function buildRoutineDefaults(declaration: PluginManagedRoutineDeclaration) {
  return {
    routineKey: declaration.routineKey,
    title: declaration.title,
    description: declaration.description ?? null,
    assigneeRef: declaration.assigneeRef ?? null,
    projectRef: declaration.projectRef ?? null,
    goalId: declaration.goalId ?? null,
    status: declaration.status ?? null,
    priority: declaration.priority ?? "medium",
    concurrencyPolicy: declaration.concurrencyPolicy ?? "coalesce_if_active",
    catchUpPolicy: declaration.catchUpPolicy ?? "skip_missed",
    variables: declaration.variables ?? [],
    triggers: declaration.triggers ?? [],
    issueTemplate: declaration.issueTemplate ?? null,
  };
}

function normalizeRef(
  pluginKey: string,
  ref: PluginManagedResourceRef | null | undefined,
  resourceKind: "agent" | "project",
) {
  if (!ref) return null;
  if (ref.resourceKind !== resourceKind) {
    throw unprocessable(`Managed routine ${resourceKind} ref must target ${resourceKind}`);
  }
  if (ref.pluginKey && ref.pluginKey !== pluginKey) {
    throw unprocessable("Managed routine refs must target the declaring plugin");
  }
  return { ...ref, pluginKey };
}

function managedByPlugin(row: {
  id: string;
  pluginId: string;
  pluginKey: string;
  manifestJson: { displayName?: string } | null;
  resourceKey: string;
  defaultsJson: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}): RoutineManagedByPlugin {
  return {
    id: row.id,
    pluginId: row.pluginId,
    pluginKey: row.pluginKey,
    pluginDisplayName: row.manifestJson?.displayName ?? row.pluginKey,
    resourceKind: "routine",
    resourceKey: row.resourceKey,
    defaultsJson: row.defaultsJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function triggerInput(trigger: NonNullable<PluginManagedRoutineDeclaration["triggers"]>[number]): CreateRoutineTrigger {
  if (trigger.kind === "schedule") {
    if (!trigger.cronExpression) {
      throw unprocessable("Managed schedule routine triggers require cronExpression");
    }
    return {
      kind: "schedule",
      label: trigger.label ?? null,
      enabled: trigger.enabled ?? true,
      cronExpression: trigger.cronExpression,
      timezone: trigger.timezone ?? "UTC",
    };
  }
  if (trigger.kind === "webhook") {
    return {
      kind: "webhook",
      label: trigger.label ?? null,
      enabled: trigger.enabled ?? true,
      signingMode: (trigger.signingMode ?? "bearer") as Extract<CreateRoutineTrigger, { kind: "webhook" }>["signingMode"],
      replayWindowSec: trigger.replayWindowSec ?? 300,
    };
  }
  return {
    kind: "api",
    label: trigger.label ?? null,
    enabled: trigger.enabled ?? true,
  };
}

export function pluginManagedRoutineService(
  db: Db,
  options: PluginManagedRoutineServiceOptions,
) {
  const routinesSvc = routineService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });

  function declarationFor(routineKey: string) {
    const declaration = options.manifest?.routines?.find((routine) => routine.routineKey === routineKey);
    if (!declaration) {
      throw notFound(`Managed routine declaration not found: ${routineKey}`);
    }
    return declaration;
  }

  async function getBinding(companyId: string, routineKey: string) {
    return db
      .select({
        id: pluginManagedResources.id,
        companyId: pluginManagedResources.companyId,
        pluginId: pluginManagedResources.pluginId,
        pluginKey: pluginManagedResources.pluginKey,
        resourceKind: pluginManagedResources.resourceKind,
        resourceKey: pluginManagedResources.resourceKey,
        resourceId: pluginManagedResources.resourceId,
        defaultsJson: pluginManagedResources.defaultsJson,
        manifestJson: plugins.manifestJson,
        createdAt: pluginManagedResources.createdAt,
        updatedAt: pluginManagedResources.updatedAt,
      })
      .from(pluginManagedResources)
      .innerJoin(plugins, eq(pluginManagedResources.pluginId, plugins.id))
      .where(
        and(
          eq(pluginManagedResources.companyId, companyId),
          eq(pluginManagedResources.pluginId, options.pluginId),
          eq(pluginManagedResources.resourceKind, MANAGED_ROUTINE_RESOURCE_KIND),
          eq(pluginManagedResources.resourceKey, routineKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function upsertBinding(
    companyId: string,
    declaration: PluginManagedRoutineDeclaration,
    routineId: string,
  ) {
    const defaultsJson = buildRoutineDefaults(declaration);
    const existing = await getBinding(companyId, declaration.routineKey);
    if (existing) {
      return db
        .update(pluginManagedResources)
        .set({
          resourceId: routineId,
          defaultsJson,
          updatedAt: new Date(),
        })
        .where(eq(pluginManagedResources.id, existing.id))
        .returning()
        .then((rows) => rows[0]);
    }
    return db
      .insert(pluginManagedResources)
      .values({
        companyId,
        pluginId: options.pluginId,
        pluginKey: options.pluginKey,
        resourceKind: MANAGED_ROUTINE_RESOURCE_KIND,
        resourceKey: declaration.routineKey,
        resourceId: routineId,
        defaultsJson,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function getRoutineWithManagedBy(companyId: string, declaration: PluginManagedRoutineDeclaration) {
    const binding = await getBinding(companyId, declaration.routineKey);
    if (!binding) return null;
    const routine = await db
      .select()
      .from(routines)
      .where(and(eq(routines.companyId, companyId), eq(routines.id, binding.resourceId)))
      .then((rows) => rows[0] ?? null);
    if (!routine) return null;
    return {
      ...routine,
      managedByPlugin: managedByPlugin(binding),
    } as Routine;
  }

  async function resolveAgentId(
    companyId: string,
    declaration: PluginManagedRoutineDeclaration,
    overrides?: RoutineOverrides,
  ) {
    if (overrides?.assigneeAgentId !== undefined) {
      if (!overrides.assigneeAgentId) return { agentId: null, missingRef: null };
      const row = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, overrides.assigneeAgentId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Assignee agent not found");
      return { agentId: row.id, missingRef: null };
    }

    const ref = normalizeRef(options.pluginKey, declaration.assigneeRef, "agent");
    if (!ref) return { agentId: null, missingRef: null };
    const binding = await db
      .select({ resourceId: pluginManagedResources.resourceId })
      .from(pluginManagedResources)
      .where(
        and(
          eq(pluginManagedResources.companyId, companyId),
          eq(pluginManagedResources.pluginId, options.pluginId),
          eq(pluginManagedResources.resourceKind, "agent"),
          eq(pluginManagedResources.resourceKey, ref.resourceKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!binding) return { agentId: null, missingRef: ref };
    const row = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, binding.resourceId)))
      .then((rows) => rows[0] ?? null);
    return row ? { agentId: row.id, missingRef: null } : { agentId: null, missingRef: ref };
  }

  async function resolveProjectId(
    companyId: string,
    declaration: PluginManagedRoutineDeclaration,
    overrides?: RoutineOverrides,
  ) {
    if (overrides?.projectId !== undefined) {
      if (!overrides.projectId) return { projectId: null, missingRef: null };
      const row = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.companyId, companyId), eq(projects.id, overrides.projectId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Project not found");
      return { projectId: row.id, missingRef: null };
    }

    const ref = normalizeRef(options.pluginKey, declaration.projectRef, "project");
    if (!ref) return { projectId: null, missingRef: null };
    const binding = await db
      .select({ resourceId: pluginManagedResources.resourceId })
      .from(pluginManagedResources)
      .where(
        and(
          eq(pluginManagedResources.companyId, companyId),
          eq(pluginManagedResources.pluginId, options.pluginId),
          eq(pluginManagedResources.resourceKind, "project"),
          eq(pluginManagedResources.resourceKey, ref.resourceKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!binding) return { projectId: null, missingRef: ref };
    const row = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.id, binding.resourceId)))
      .then((rows) => rows[0] ?? null);
    return row ? { projectId: row.id, missingRef: null } : { projectId: null, missingRef: ref };
  }

  async function resolveRefs(
    companyId: string,
    declaration: PluginManagedRoutineDeclaration,
    overrides?: RoutineOverrides,
  ) {
    const [agent, project] = await Promise.all([
      resolveAgentId(companyId, declaration, overrides),
      resolveProjectId(companyId, declaration, overrides),
    ]);
    const missingRefs: PluginManagedResourceRef[] = [];
    if (agent.missingRef) missingRefs.push(agent.missingRef);
    if (project.missingRef) missingRefs.push(project.missingRef);
    return {
      assigneeAgentId: agent.agentId,
      projectId: project.projectId,
      missingRefs,
    };
  }

  function resolution(
    companyId: string,
    declaration: PluginManagedRoutineDeclaration,
    routine: Routine | null,
    status: PluginManagedRoutineResolution["status"],
    missingRefs: PluginManagedResourceRef[] = [],
  ): PluginManagedRoutineResolution {
    return {
      pluginKey: options.pluginKey,
      resourceKind: "routine",
      resourceKey: declaration.routineKey,
      companyId,
      routineId: routine?.id ?? null,
      routine,
      status,
      missingRefs,
    };
  }

  async function ensureDefaultTriggers(
    routineId: string,
    declaration: PluginManagedRoutineDeclaration,
  ) {
    const triggers = declaration.triggers ?? [];
    if (triggers.length === 0) return;
    const existingCount = await db
      .select({ id: routineTriggers.id })
      .from(routineTriggers)
      .where(eq(routineTriggers.routineId, routineId))
      .limit(1)
      .then((rows) => rows.length);
    if (existingCount > 0) return;

    for (const trigger of triggers) {
      await routinesSvc.createTrigger(routineId, triggerInput(trigger), { agentId: null, userId: null });
    }
  }

  async function createManagedRoutine(
    companyId: string,
    declaration: PluginManagedRoutineDeclaration,
    overrides?: RoutineOverrides,
  ) {
    const refs = await resolveRefs(companyId, declaration, overrides);
    if (refs.missingRefs.length > 0) {
      return resolution(companyId, declaration, null, "missing_refs", refs.missingRefs);
    }

    const created = await routinesSvc.create(companyId, {
      projectId: refs.projectId,
      goalId: declaration.goalId ?? null,
      title: declaration.title,
      description: declaration.description ?? null,
      assigneeAgentId: refs.assigneeAgentId,
      priority: declaration.priority ?? "medium",
      status: declaration.status ?? (refs.assigneeAgentId ? "active" : "paused"),
      concurrencyPolicy: declaration.concurrencyPolicy ?? "coalesce_if_active",
      catchUpPolicy: declaration.catchUpPolicy ?? "skip_missed",
      variables: declaration.variables ?? [],
    }, { agentId: null, userId: null });
    await upsertBinding(companyId, declaration, created.id);
    await ensureDefaultTriggers(created.id, declaration);
    const routine = await getRoutineWithManagedBy(companyId, declaration);
    await logActivity(db, {
      companyId,
      actorType: "plugin",
      actorId: options.pluginId,
      action: "plugin.managed_routine.created",
      entityType: "routine",
      entityId: created.id,
      details: {
        sourcePluginKey: options.pluginKey,
        managedResourceKey: declaration.routineKey,
        assigneeAgentId: refs.assigneeAgentId,
        projectId: refs.projectId,
      },
    });
    return resolution(companyId, declaration, routine, "created");
  }

  async function get(routineKey: string, companyId: string) {
    const declaration = declarationFor(routineKey);
    const routine = await getRoutineWithManagedBy(companyId, declaration);
    return resolution(companyId, declaration, routine, routine ? "resolved" : "missing");
  }

  async function reconcile(routineKey: string, companyId: string, overrides?: RoutineOverrides) {
    const declaration = declarationFor(routineKey);
    const current = await get(routineKey, companyId);
    if (current.routine) {
      await upsertBinding(companyId, declaration, current.routine.id);
      await ensureDefaultTriggers(current.routine.id, declaration);
      return current;
    }
    return createManagedRoutine(companyId, declaration, overrides);
  }

  async function reset(routineKey: string, companyId: string, overrides?: RoutineOverrides) {
    const declaration = declarationFor(routineKey);
    const current = await get(routineKey, companyId);
    if (!current.routine) {
      return createManagedRoutine(companyId, declaration, overrides);
    }

    const refs = await resolveRefs(companyId, declaration, overrides);
    if (refs.missingRefs.length > 0) {
      return resolution(companyId, declaration, current.routine, "missing_refs", refs.missingRefs);
    }
    const updated = await routinesSvc.update(current.routine.id, {
      projectId: refs.projectId,
      goalId: declaration.goalId ?? null,
      title: declaration.title,
      description: declaration.description ?? null,
      assigneeAgentId: refs.assigneeAgentId,
      priority: declaration.priority ?? "medium",
      status: declaration.status ?? (refs.assigneeAgentId ? "active" : "paused"),
      concurrencyPolicy: declaration.concurrencyPolicy ?? "coalesce_if_active",
      catchUpPolicy: declaration.catchUpPolicy ?? "skip_missed",
      variables: declaration.variables ?? [],
    }, { agentId: null, userId: null });
    if (!updated) throw notFound("Managed routine not found");
    await upsertBinding(companyId, declaration, updated.id);
    await ensureDefaultTriggers(updated.id, declaration);
    const routine = await getRoutineWithManagedBy(companyId, declaration);
    await logActivity(db, {
      companyId,
      actorType: "plugin",
      actorId: options.pluginId,
      action: "plugin.managed_routine.reset",
      entityType: "routine",
      entityId: updated.id,
      details: {
        sourcePluginKey: options.pluginKey,
        managedResourceKey: declaration.routineKey,
        assigneeAgentId: refs.assigneeAgentId,
        projectId: refs.projectId,
      },
    });
    return resolution(companyId, declaration, routine, "reset");
  }

  async function update(
    routineKey: string,
    companyId: string,
    patch: { status?: string },
  ) {
    const declaration = declarationFor(routineKey);
    const current = await get(routineKey, companyId);
    if (!current.routine) throw notFound("Managed routine not found");
    const updatePatch: { status?: RoutineStatus } = {};
    if (patch.status !== undefined) {
      if (!ROUTINE_STATUSES.includes(patch.status as RoutineStatus)) {
        throw unprocessable("Invalid routine status");
      }
      updatePatch.status = patch.status as RoutineStatus;
    }
    const updated = await routinesSvc.update(current.routine.id, updatePatch, { agentId: null, userId: null });
    if (!updated) throw notFound("Managed routine not found");
    await logActivity(db, {
      companyId,
      actorType: "plugin",
      actorId: options.pluginId,
      action: "plugin.managed_routine.updated",
      entityType: "routine",
      entityId: updated.id,
      details: {
        sourcePluginKey: options.pluginKey,
        managedResourceKey: declaration.routineKey,
        status: updated.status,
      },
    });
    const routine = await getRoutineWithManagedBy(companyId, declaration);
    return routine ?? updated;
  }

  async function run(routineKey: string, companyId: string, overrides?: RoutineOverrides) {
    const declaration = declarationFor(routineKey);
    const current = await get(routineKey, companyId);
    if (!current.routine) throw notFound("Managed routine not found");
    const run = await routinesSvc.runRoutine(current.routine.id, {
      source: "manual",
      assigneeAgentId: overrides?.assigneeAgentId,
      projectId: overrides?.projectId,
    }, { agentId: null, userId: null });
    await logActivity(db, {
      companyId,
      actorType: "plugin",
      actorId: options.pluginId,
      action: "plugin.managed_routine.run_triggered",
      entityType: "routine_run",
      entityId: run.id,
      details: {
        sourcePluginKey: options.pluginKey,
        managedResourceKey: declaration.routineKey,
        routineId: current.routine.id,
        status: run.status,
      },
    });
    return run;
  }

  return {
    get,
    reconcile,
    reset,
    update,
    run,
  };
}
