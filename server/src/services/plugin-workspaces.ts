import { effectiveProjectWorkspacePolicy, isWorkspaceProvider } from "./project-workspace-provider.js";
import { releaseProviderRecoveryTransfers, stageProviderFreshWorkspace } from "./provider-fresh-workspace.js";
import { randomUUID, createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  executionWorkspaces,
  heartbeatRuns,
  issues,
  pluginCompanySettings,
  plugins,
  projects,
  projectWorkspaces,
  type Db,
} from "@paperclipai/db";
import {
  readWorkspaceProviderBinding,
  type WorkspaceProviderBinding,
} from "@paperclipai/shared";
import {
  parseWorkspaceProviderResult,
  workspaceProviderOperationSchema,
  type PluginWorkspaceOperation,
  type PluginWorkspaceParams,
  type PluginFreshWorkspace,
} from "@paperclipai/plugin-sdk";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { notifyTerminalWorkspaceWork } from "./terminal-workspace-work.js";
import { withExecutionWorkspaceLifecycleLock } from "./execution-workspace-lifecycle-lock.js";
import {
  assertTaskWorkspaceExecutionAccess,
  assertTaskWorkspaceSourceProjectAccess,
} from "./task-workspace-access.js";
import { forbidden, conflict } from "../errors.js";

export type WorkspaceWorkers = Pick<PluginWorkerManager, "call" | "getWorker">;
type Workspace = typeof executionWorkspaces.$inferSelect;

async function provider(
  db: Db,
  workers: WorkspaceWorkers | undefined,
  companyId: string,
  pluginId: string,
) {
  const [plugin] = await db
    .select()
    .from(plugins)
    .where(eq(plugins.id, pluginId));
  const [settings] = await db
    .select()
    .from(pluginCompanySettings)
    .where(
      and(
        eq(pluginCompanySettings.pluginId, pluginId),
        eq(pluginCompanySettings.companyId, companyId),
      ),
    );
  if (
    !workers ||
    !plugin ||
    plugin.status !== "ready" ||
    settings?.enabled === false ||
    !isWorkspaceProvider(plugin.manifestJson) ||
    !workers
      .getWorker(pluginId)
      ?.supportedMethods?.includes("workspaceOperation")
  ) {
    throw conflict("The workspace storage plugin is unavailable");
  }
  return plugin;
}

/** No paths or provider credentials are accepted from task callers. */
export async function callWorkspaceProvider(
  db: Db,
  workers: WorkspaceWorkers | undefined,
  input: {
    workspace: Workspace;
    operation: PluginWorkspaceOperation;
    pluginId?: string;
    advanceGeneration?: boolean;
    runId?: string | null;
    agentId?: string | null;
  },
) {
  const { workspace } = input;
  const binding = readWorkspaceProviderBinding(workspace.metadata);
  const pluginId = binding?.pluginId ?? input.pluginId;
  if (!pluginId || !workspace.projectId)
    throw conflict("Workspace storage ownership is missing");
  const selectedProvider = await provider(db, workers, workspace.companyId, pluginId);
  if (input.operation.kind === "prepare" && input.operation.fresh && selectedProvider.manifestJson.workspaceProvider?.freshWorkspaceVersion !== 1)
    throw conflict("Fresh workspace preparation is unavailable");
  const generation =
    typeof workspace.metadata?.lifecycleGeneration === "number"
      ? workspace.metadata.lifecycleGeneration
      : 0;
  const operationGeneration = generation + (input.advanceGeneration ? 1 : 0);
  const operation = workspaceProviderOperationSchema.parse(input.operation);
  if (operation.kind === "prepare" && operation.fresh) {
    if (!workspace.sourceIssueId) throw conflict("Fresh workspace task ownership is missing");
    operation.fresh = await stageProviderFreshWorkspace({ db, companyId: workspace.companyId,
      issueId: workspace.sourceIssueId, ...operation.fresh, existing: operation.fresh });
  }
  const params: PluginWorkspaceParams = {
    pluginId,
    companyId: workspace.companyId,
    projectId: workspace.projectId,
    executionWorkspaceId: workspace.id,
    operationId:
      operation.kind === "inspect"
        ? randomUUID()
        : createHash("sha256")
            .update(
              JSON.stringify([workspace.id, operationGeneration, operation]),
            )
            .digest("hex"),
    generation: operationGeneration,
    deadline: new Date(Date.now() + 300_000).toISOString(),
    runId: input.runId ?? null,
    agentId: input.agentId ?? null,
    operation,
  };
  let value: unknown;
  try {
    value = await workers!.call(
      pluginId,
      "workspaceOperation",
      params,
      310_000,
    );
  } catch {
    throw conflict(
      "Workspace storage operation is incomplete; retry the same workspace",
    );
  }
  // Recheck enablement and ownership after an external effect, including an ambiguous retry.
  await provider(db, workers, workspace.companyId, pluginId);
  const [fresh] = await db
    .select()
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.id, workspace.id),
        eq(executionWorkspaces.companyId, workspace.companyId),
      ),
    );
  if (
    !fresh ||
    fresh.status !== workspace.status ||
    (fresh.metadata?.lifecycleGeneration ?? 0) !== generation ||
    fresh.providerRef !== workspace.providerRef
  ) {
    throw conflict("Workspace changed during storage preparation");
  }
  const result = parseWorkspaceProviderResult(params, value);
  if (result.kind === "prepared" && result.binding.pluginId !== pluginId)
    throw conflict("Workspace provider ownership changed");
  return result;
}

export async function preparePluginWorkspace(
  db: Db,
  workers: WorkspaceWorkers | undefined,
  input: {
    companyId: string;
    projectId: string | null;
    projectWorkspaceId: string | null;
    issueId: string | null;
    runId: string;
    agentId: string;
    responsibleUserId: string | null;
    existingWorkspaceId: string | null;
    mode: string;
    strategy: string;
    selectedProviderPluginId?: string | null;
    branchMode?: "create" | "existing";
    branchName?: string | null;
    baseRef?: string | null;
    fresh?: PluginFreshWorkspace;
    expectedBindingRevision?: number;
  },
) {
  const [previous] = input.existingWorkspaceId
    ? await db
        .select()
        .from(executionWorkspaces)
        .where(
          and(
            eq(executionWorkspaces.id, input.existingWorkspaceId),
            eq(executionWorkspaces.companyId, input.companyId),
          ),
        )
    : [];
  const [reservation] = input.fresh ? await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, input.companyId),
    eq(executionWorkspaces.sourceIssueId, input.issueId!),
    sql`${executionWorkspaces.metadata}#>>'{workspaceProviderFresh,attemptId}' = ${input.fresh.attemptId}`,
  )).limit(1) : [];
  const existing = input.fresh ? reservation : previous;
  const prior = existing ?? previous;
  if (
    existing?.metadata?.workspaceProviderRetired === true ||
    existing?.metadata?.workspaceProviderRemoval
  )
    throw conflict("Workspace storage is retired or awaiting cleanup");
  if (!existing && (!input.projectId || !input.projectWorkspaceId)) return null;
  const saved = readWorkspaceProviderBinding(existing?.metadata);
  const priorBinding = readWorkspaceProviderBinding(prior?.metadata);
  const mode = input.fresh ? "isolated_workspace" : existing?.mode ?? input.mode,
    strategy = existing?.strategyType ?? input.strategy;
  const projectId = priorBinding?.projectId ?? input.projectId;
  const [project] = projectId
    ? await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.companyId, input.companyId),
          ),
        )
    : [];
  if (prior && prior.providerType !== "plugin" && !priorBinding && !prior.metadata?.workspaceProviderOwner) return null;
  const owner = priorBinding?.pluginId ?? prior?.metadata?.workspaceProviderOwner ??
    (!existing && input.selectedProviderPluginId !== undefined ? input.selectedProviderPluginId :
      !existing && project ? (await effectiveProjectWorkspacePolicy(db, input.companyId, project.executionWorkspacePolicy, false))?.storageProviderPluginId : null);
  const pluginId = typeof owner === "string" ? owner : null;
  if (!pluginId) {
    if (existing?.providerType === "plugin")
      throw conflict("Workspace storage ownership is missing");
    return null;
  }
  if (
    !input.issueId ||
    !project ||
    project.archivedAt ||
    !input.projectWorkspaceId
  )
    throw conflict(
      "Managed storage requires a task and an available project source",
    );
  if (
    !["shared_workspace", "isolated_workspace", "operator_branch"].includes(
      input.mode,
    ) ||
    !["project_primary", "git_worktree"].includes(strategy)
  )
    throw conflict("Unsupported managed workspace strategy");
  if (existing && existing.providerType !== "plugin")
    throw conflict(
      "An existing local workspace cannot change storage providers",
    );
  const selectedProvider = await provider(
    db,
    workers,
    input.companyId,
    pluginId,
  );
  const declaration = selectedProvider.manifestJson.workspaceProvider!;
  if (input.fresh && declaration.freshWorkspaceVersion !== 1)
    throw conflict("A fresh attempt is unavailable for this workspace storage provider. The existing workspace is retained.", { reason: "fresh_workspace_storage_unsupported" });
  if (
    !declaration.modes.includes(mode as "isolated_workspace") ||
    !declaration.strategies.includes(strategy as "git_worktree")
  ) {
    throw conflict(
      "The storage plugin does not support this workspace mode or strategy",
    );
  }
  const actor = {
    type: "agent" as const,
    source: "agent_jwt" as const,
    companyId: input.companyId,
    agentId: input.agentId,
    runId: input.runId,
    onBehalfOfUserId:
      input.responsibleUserId === "local-board"
        ? null
        : input.responsibleUserId,
  };
  const authorize = async () => {
    await assertTaskWorkspaceExecutionAccess(db, actor, input.companyId, {
      issueId: input.issueId!,
      ...(existing
        ? { workspaceId: existing.id }
        : { projectWorkspaceId: input.projectWorkspaceId }),
    });
    await assertTaskWorkspaceSourceProjectAccess(
      db,
      actor,
      input.companyId,
      project.id,
    );
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.companyId, input.companyId),
        ),
      );
    if (
      !run ||
      run.agentId !== input.agentId ||
      ![run.issueId, run.nativeIssueId].includes(input.issueId!) ||
      run.status !== "running"
    )
      throw forbidden("Workspace preparation no longer has an active run");
  };
  await authorize();
  const [source] = await db
    .select()
    .from(projectWorkspaces)
    .where(
      and(
        eq(
          projectWorkspaces.id,
          saved?.projectWorkspaceId ?? input.projectWorkspaceId,
        ),
        eq(projectWorkspaces.projectId, project.id),
        eq(projectWorkspaces.companyId, input.companyId),
      ),
    );
  if (!source) throw conflict("Workspace repository source is unavailable");
  const sourceInput = (prior?.metadata?.workspaceProviderSource as
    | Extract<PluginWorkspaceOperation, { kind: "prepare" }>["source"]
    | undefined) ?? {
    id: source.id,
    revision:
      saved?.sourceRevision ??
      createHash("sha256")
        .update(
          JSON.stringify([
            source.id,
            source.repoUrl,
            source.repoRef,
            source.defaultRef,
          ]),
        )
        .digest("hex"),
    repoUrl: existing?.repoUrl ?? source.repoUrl,
    repoRef: existing?.baseRef ?? source.repoRef,
    defaultRef: source.defaultRef,
  };
  const branchName = input.fresh ? null : existing
    ? existing.branchName
    : (input.branchName ??
      (strategy === "git_worktree" ? `workspace-${randomUUID()}` : null));
  // Reserve and bind before calling the provider. A crash must not orphan a created checkout.
  const workspace =
    existing ??
    (await db.transaction(async (tx) => {
      const [currentProject] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, project.id))
        .for("update");
      const [currentSource] = await tx
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.id, source.id));
      if (
        !currentProject ||
        currentProject.archivedAt ||
        (await effectiveProjectWorkspacePolicy(tx, input.companyId, currentProject.executionWorkspacePolicy, false))?.storageProviderPluginId !==
          pluginId ||
        !currentSource ||
        currentSource.repoUrl !== source.repoUrl ||
        currentSource.repoRef !== source.repoRef ||
        currentSource.defaultRef !== source.defaultRef
      ) {
        throw conflict(
          "Project storage configuration changed; retry preparation",
        );
      }
      const [task] = await tx
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.id, input.issueId!),
            eq(issues.companyId, input.companyId),
          ),
        )
        .for("update");
      if (!task || (input.fresh ? task.executionWorkspaceId !== input.fresh.previousWorkspaceId || task.workspaceBindingRevision !== input.expectedBindingRevision : Boolean(task.executionWorkspaceId)))
        throw conflict("Task workspace binding changed; retry preparation");
      const id = randomUUID();
      await notifyTerminalWorkspaceWork(tx, `workspace:${id}`);
      const [row] = await tx
        .insert(executionWorkspaces)
        .values({
          id,
          companyId: input.companyId,
          projectId: project.id,
          projectWorkspaceId: source.id,
          sourceIssueId: input.issueId,
          mode,
          strategyType: strategy,
          name: branchName ?? source.name,
          providerType: "plugin",
          providerRef: null,
          cwd: null,
          branchName,
          repoUrl: source.repoUrl,
          baseRef: input.baseRef ?? source.repoRef,
          status: "idle",
          metadata: {
            workspaceProviderOwner: pluginId,
            workspaceProviderSource: sourceInput,
            workspaceProviderBranchMode: input.fresh ? "create" : input.branchMode ?? "create",
            ...(input.fresh ? { workspaceProviderFresh: input.fresh } : {}),
          },
        })
        .returning();
      await tx
        .update(issues)
        .set({
          executionWorkspaceId: id,
          executionWorkspacePreference: "reuse_existing",
          workspaceBindingRevision: task.workspaceBindingRevision + 1,
          workspacePendingSelection:
            task.workspacePendingSelection?.expectedBindingRevision ===
            task.workspaceBindingRevision
              ? {
                  ...task.workspacePendingSelection,
                  expectedBindingRevision: task.workspaceBindingRevision + 1,
                }
              : task.workspacePendingSelection,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, task.id));
      return row!;
    }));
  return withExecutionWorkspaceLifecycleLock(db, workspace.id, async (tx) => {
    const [current] = await tx
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspace.id));
    if (
      !current ||
      !["active", "idle", "in_review"].includes(current.status) ||
      current.metadata?.workspaceProviderRetired === true ||
      current.metadata?.workspaceProviderRemoval ||
      current.providerRef !== workspace.providerRef ||
      (current.metadata?.lifecycleGeneration ?? 0) !==
        (workspace.metadata?.lifecycleGeneration ?? 0)
    ) {
      throw conflict("Workspace lifecycle changed; reopen before preparing");
    }
    const result = await callWorkspaceProvider(tx as unknown as Db, workers, {
      workspace,
      pluginId,
      runId: input.runId,
      agentId: input.agentId,
      operation: {
        kind: "prepare",
        source: sourceInput,
        mode: workspace.mode as "isolated_workspace",
        strategy: workspace.strategyType as "git_worktree",
        branchName: workspace.metadata?.workspaceProviderFresh ? null : branchName,
        branchMode:
          (workspace.metadata?.workspaceProviderBranchMode as
            | "create"
            | "existing"
            | undefined) ??
          input.branchMode ??
          "create",
        baseRef: workspace.baseRef,
        existing: saved,
        ...(workspace.metadata?.workspaceProviderFresh ? { fresh: workspace.metadata.workspaceProviderFresh as PluginFreshWorkspace } : {}),
      },
    });
    if (result.kind !== "prepared")
      throw conflict("Workspace preparation is incomplete");
    await authorize();
    const [currentProject] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, project.id));
    if (!currentProject || currentProject.archivedAt)
      throw conflict("Project was archived during workspace preparation");
    const [task] = await tx
      .select()
      .from(issues)
      .where(eq(issues.id, input.issueId!));
    if (task?.executionWorkspaceId !== workspace.id)
      throw conflict("Task workspace binding changed during preparation");
    await notifyTerminalWorkspaceWork(tx, `workspace:${workspace.id}`);
    const [updated] = await tx
      .update(executionWorkspaces)
      .set({
        providerRef: result.binding.workspaceRef,
        branchName: result.branchName,
        status: "active",
        lastUsedAt: new Date(),
        updatedAt: new Date(),
        metadata: {
          ...workspace.metadata,
          workspaceProvider: result.binding,
          workspaceProviderBaseSha: result.baseSha,
          workspaceProviderSource: sourceInput,
          workspaceProviderRemoved: false,
          createdByRuntime: result.branchCreatedByRuntime,
        },
      })
      .where(
        and(
          eq(executionWorkspaces.id, workspace.id),
          eq(executionWorkspaces.companyId, input.companyId),
          sql`coalesce((${executionWorkspaces.metadata}->>'lifecycleGeneration')::int, 0) = ${workspace.metadata?.lifecycleGeneration ?? 0}`,
          sql`${executionWorkspaces.providerRef} IS NOT DISTINCT FROM ${workspace.providerRef}`,
        ),
      )
      .returning();
    if (!updated)
      throw conflict("Workspace changed before preparation could be recorded");
    return updated!;
  });
}

/** Recover a lost prepare result even when the originating run has already stopped. */
async function reconcilePluginWorkspaceReservation(
  db: Db,
  workers: WorkspaceWorkers | undefined,
  snapshot: Workspace,
): Promise<Workspace> {
  const [workspace] = await db
    .select()
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.id, snapshot.id),
        eq(executionWorkspaces.companyId, snapshot.companyId),
      ),
    );
  if (!workspace) throw conflict("Workspace is unavailable");
  if (readWorkspaceProviderBinding(workspace.metadata)) return workspace;
  const owner = workspace.metadata?.workspaceProviderOwner;
  if (typeof owner !== "string" || !workspace.metadata?.workspaceProviderSource)
    throw conflict("Workspace storage reservation is unavailable");
  const operation = workspaceProviderOperationSchema.parse({
    kind: "prepare",
    source: workspace.metadata.workspaceProviderSource,
    mode: workspace.mode,
    strategy: workspace.strategyType,
    branchName: workspace.metadata.workspaceProviderFresh ? null : workspace.branchName,
    branchMode: workspace.metadata.workspaceProviderBranchMode ?? "create",
    baseRef: workspace.baseRef,
    existing: null,
    ...(workspace.metadata?.workspaceProviderFresh ? { fresh: workspace.metadata.workspaceProviderFresh as PluginFreshWorkspace } : {}),
  });
  const result = await callWorkspaceProvider(db, workers, {
    workspace,
    pluginId: owner,
    operation,
  });
  if (result.kind !== "prepared")
    throw conflict("Workspace reconciliation is incomplete");
  const [updated] = await db.transaction(async (tx) => {
    await notifyTerminalWorkspaceWork(tx, `workspace:${workspace.id}`);
    return tx
      .update(executionWorkspaces)
      .set({
        providerRef: result.binding.workspaceRef,
        branchName: result.branchName,
        updatedAt: new Date(),
        metadata: {
          ...workspace.metadata,
          workspaceProvider: result.binding,
          workspaceProviderBaseSha: result.baseSha,
          createdByRuntime: result.branchCreatedByRuntime,
        },
      })
      .where(
        and(
          eq(executionWorkspaces.id, workspace.id),
          eq(executionWorkspaces.companyId, workspace.companyId),
          sql`${executionWorkspaces.providerRef} IS NULL`,
          sql`coalesce((${executionWorkspaces.metadata}->>'lifecycleGeneration')::int, 0) = ${workspace.metadata?.lifecycleGeneration ?? 0}`,
        ),
      )
      .returning();
  });
  if (!updated)
    throw conflict("Workspace changed during reconciliation; retry inspection");
  return updated;
}

async function inspectBinding(
  db: Db,
  workers: WorkspaceWorkers | undefined,
  workspace: Workspace,
) {
  const binding = readWorkspaceProviderBinding(workspace.metadata);
  if (!binding) throw conflict("Workspace storage binding is unavailable");
  const result = await callWorkspaceProvider(db, workers, {
    workspace,
    operation: { kind: "inspect", binding },
  });
  if (result.kind !== "inspection")
    throw conflict("Workspace inspection is incomplete");
  return result;
}

export async function inspectPluginWorkspace(
  db: Db,
  workers: WorkspaceWorkers | undefined,
  workspace: Workspace,
) {
  return withExecutionWorkspaceLifecycleLock(db, workspace.id, async () => {
    // Keep recovery intent/results durable across an ambiguous provider response.
    workspace = await reconcilePluginWorkspaceReservation(
      db,
      workers,
      workspace,
    );
    if (workspace.metadata?.workspaceProviderRestoration)
      workspace = await finishPendingRestoration(db, workers, workspace);
    if (workspace.metadata?.workspaceProviderRemoval)
      workspace = await finishPendingRemoval(db, workers, workspace);
    if (workspace.metadata?.workspaceProviderRemoved === true)
      return removedInspection();
    return inspectBinding(db, workers, workspace);
  });
}

const removedInspection = () => ({
  kind: "inspection" as const,
  headSha: null,
  branchName: null,
  hasDirtyTrackedFiles: false,
  hasUntrackedFiles: false,
  hasLocalOnlyData: false,
  isMergedIntoBase: null,
  remotelyRecoverable: true,
});

async function finishPendingRestoration(
  db: Db,
  workers: WorkspaceWorkers | undefined,
  workspace: Workspace,
): Promise<Workspace> {
  const pending = workspace.metadata?.workspaceProviderRestoration as {
    generation?: unknown;
    operation?: unknown;
  };
  const operation = workspaceProviderOperationSchema.safeParse(
    pending?.operation,
  );
  const generation =
    (workspace.metadata?.lifecycleGeneration as number | undefined) ?? 0;
  if (
    !operation.success ||
    operation.data.kind !== "prepare" ||
    pending.generation !== generation + 1 ||
    JSON.stringify(operation.data.existing) !==
      JSON.stringify(readWorkspaceProviderBinding(workspace.metadata)) ||
    !["archived", "cleanup_failed"].includes(workspace.status)
  )
    throw conflict("Workspace restoration intent is unavailable or stale");
  const result = await callWorkspaceProvider(db, workers, {
    workspace,
    operation: operation.data,
    advanceGeneration: true,
  });
  if (result.kind !== "prepared")
    throw conflict("Workspace restoration is incomplete");
  const [updated] = await db.transaction(async (tx) => {
    await notifyTerminalWorkspaceWork(tx, `workspace:${workspace.id}`);
    return tx
      .update(executionWorkspaces)
      .set({
        providerRef: result.binding.workspaceRef,
        branchName: result.branchName,
        updatedAt: new Date(),
        metadata: {
          ...workspace.metadata,
          lifecycleGeneration: generation + 1,
          workspaceProvider: result.binding,
          workspaceProviderBaseSha: result.baseSha,
          workspaceProviderRemoved: false,
          workspaceProviderRestoration: null,
        },
      })
      .where(
        and(
          eq(executionWorkspaces.id, workspace.id),
          eq(executionWorkspaces.companyId, workspace.companyId),
          eq(executionWorkspaces.status, workspace.status),
          sql`coalesce((${executionWorkspaces.metadata}->>'lifecycleGeneration')::int, 0) = ${generation}`,
          sql`${executionWorkspaces.metadata}->'workspaceProviderRestoration' = ${JSON.stringify(pending)}::jsonb`,
        ),
      )
      .returning();
  });
  if (!updated)
    throw conflict("Workspace changed during restoration reconciliation");
  return updated;
}

/** Replay the recorded delete before trying to inspect a checkout that may already be gone. */
async function finishPendingRemoval(
  db: Db,
  workers: WorkspaceWorkers | undefined,
  workspace: Workspace,
): Promise<Workspace> {
  if (workspace.metadata?.workspaceProviderRemoved === true) return workspace;
  const pending = workspace.metadata?.workspaceProviderRemoval as
    | { generation?: unknown; operation?: unknown }
    | undefined;
  const parsed = workspaceProviderOperationSchema.safeParse(pending?.operation);
  const binding = readWorkspaceProviderBinding(workspace.metadata);
  if (
    !parsed.success ||
    parsed.data.kind !== "remove" ||
    pending?.generation !== (workspace.metadata?.lifecycleGeneration ?? 0) ||
    JSON.stringify(parsed.data.binding) !== JSON.stringify(binding)
  )
    throw conflict("Workspace removal intent is unavailable or stale");
  const result = await callWorkspaceProvider(db, workers, {
    workspace,
    operation: parsed.data,
  });
  if (result.kind !== "removed")
    throw conflict("Workspace removal is incomplete");
  if (workspace.metadata?.workspaceProviderFresh)
    await releaseProviderRecoveryTransfers(workspace.companyId, workspace.metadata.workspaceProviderFresh as PluginFreshWorkspace);
  const [updated] = await db.transaction(async (tx) => {
    await notifyTerminalWorkspaceWork(tx, `workspace:${workspace.id}`);
    return tx
      .update(executionWorkspaces)
      .set({
        ...(workspace.status === "cleanup_failed"
          ? { status: "archived", cleanupReason: null }
          : {}),
        metadata: {
          ...workspace.metadata,
          workspaceProviderRemoval: null,
          workspaceProviderRemoved: true,
        },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(executionWorkspaces.id, workspace.id),
          eq(executionWorkspaces.companyId, workspace.companyId),
          sql`coalesce((${executionWorkspaces.metadata}->>'lifecycleGeneration')::int, 0) = ${pending!.generation}`,
        ),
      )
      .returning();
  });
  if (!updated)
    throw conflict("Workspace changed during removal reconciliation");
  return updated;
}

export async function removePluginWorkspace(
  db: Db,
  workers: WorkspaceWorkers | undefined,
  workspace: Workspace,
  expectedHeadSha: string | null,
) {
  workspace = await reconcilePluginWorkspaceReservation(db, workers, workspace);
  if (workspace.metadata?.workspaceProviderRestoration)
    throw conflict("Workspace restoration must be reconciled before removal");
  if (workspace.metadata?.workspaceProviderRemoved === true) {
    if (workspace.metadata?.workspaceProviderFresh)
      await releaseProviderRecoveryTransfers(workspace.companyId, workspace.metadata.workspaceProviderFresh as PluginFreshWorkspace);
    return;
  }
  if (workspace.metadata?.workspaceProviderRemoval) {
    await finishPendingRemoval(db, workers, workspace);
    return;
  }
  const binding = readWorkspaceProviderBinding(workspace.metadata);
  if (!binding) throw conflict("Workspace storage binding is unavailable");
  const inspection = await inspectBinding(db, workers, workspace);
  if (
    inspection.hasDirtyTrackedFiles ||
    inspection.hasUntrackedFiles ||
    inspection.hasLocalOnlyData ||
    inspection.headSha !== expectedHeadSha ||
    (inspection.remotelyRecoverable !== true &&
      inspection.isMergedIntoBase !== true)
  ) {
    throw conflict(
      "Workspace has local changes or cannot be recovered remotely",
    );
  }
  const generation = workspace.metadata?.lifecycleGeneration ?? 0;
  const operation = { kind: "remove" as const, binding, expectedHeadSha };
  const [pending] = await db.transaction(async (tx) => {
    await notifyTerminalWorkspaceWork(tx, `workspace:${workspace.id}`);
    return tx
      .update(executionWorkspaces)
      .set({
        metadata: {
          ...workspace.metadata,
          workspaceProviderRemoval: { generation, operation },
        },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(executionWorkspaces.id, workspace.id),
          eq(executionWorkspaces.companyId, workspace.companyId),
          sql`coalesce((${executionWorkspaces.metadata}->>'lifecycleGeneration')::int, 0) = ${generation}`,
          eq(executionWorkspaces.providerRef, binding.workspaceRef),
        ),
      )
      .returning();
  });
  if (!pending)
    throw conflict("Workspace changed before removal could be recorded");
  await finishPendingRemoval(db, workers, pending);
}

/** An authorized storage edit atomically retires closed, removed dependencies under the reopen fence. */
export async function retireRemovedPluginWorkspaceDependents(
  db: Db,
  projectId: string,
  sourceId?: string,
) {
  const rows = await db
    .select({ id: executionWorkspaces.id })
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.projectId, projectId),
        eq(executionWorkspaces.providerType, "plugin"),
        sourceId
          ? eq(executionWorkspaces.projectWorkspaceId, sourceId)
          : undefined,
      ),
    );
  for (const { id } of rows.sort((a, b) => a.id.localeCompare(b.id))) {
    const acquired = await db.execute(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${`execution_workspace_lifecycle:${id}`}, 0)) as acquired`,
    );
    if (!acquired[0]?.acquired)
      throw conflict("Workspace lifecycle is busy; retry the source edit");
    const [row] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, id));
    if (!row || row.metadata?.workspaceProviderRetired === true) continue;
    if (
      row.metadata?.workspaceProviderRemoved !== true ||
      row.metadata?.workspaceProviderRestoration ||
      !["archived", "cleanup_failed"].includes(row.status)
    ) {
      throw conflict(
        "Retire managed execution workspaces before changing their storage owner or repository source",
      );
    }
    await db
      .update(executionWorkspaces)
      .set({
        metadata: { ...row.metadata, workspaceProviderRetired: true },
        updatedAt: new Date(),
      })
      .where(eq(executionWorkspaces.id, row.id));
  }
}

/** Called inside Core's existing lifecycle fence after task authorization. */
export async function restorePluginWorkspace(
  db: Db,
  workers: WorkspaceWorkers | undefined,
  workspace: Workspace,
) {
  workspace = await reconcilePluginWorkspaceReservation(db, workers, workspace);
  if (workspace.metadata?.workspaceProviderRetired === true)
    throw conflict("Workspace storage was retired");
  if (workspace.metadata?.workspaceProviderRemoval)
    workspace = await finishPendingRemoval(db, workers, workspace);
  const binding = readWorkspaceProviderBinding(workspace.metadata);
  const source = workspace.metadata?.workspaceProviderSource;
  if (!binding || !source)
    throw conflict("Workspace restoration recipe is unavailable");
  const operation = workspaceProviderOperationSchema.parse({
    kind: "prepare",
    source,
    mode: workspace.mode,
    strategy: workspace.strategyType,
    branchName: workspace.metadata?.workspaceProviderFresh ? null : workspace.branchName,
    branchMode: workspace.metadata?.workspaceProviderFresh ? "create" : "existing",
    baseRef: workspace.baseRef,
    existing: binding,
    ...(workspace.metadata?.workspaceProviderFresh ? { fresh: workspace.metadata.workspaceProviderFresh as PluginFreshWorkspace } : {}),
  });
  const [pending] = await db.transaction(async (tx) => {
    await notifyTerminalWorkspaceWork(tx, `workspace:${workspace.id}`);
    return tx
      .update(executionWorkspaces)
      .set({
        metadata: {
          ...workspace.metadata,
          workspaceProviderRemoved: false,
          workspaceProviderRestoration: {
            generation:
              ((workspace.metadata?.lifecycleGeneration as number) ?? 0) + 1,
            operation,
          },
        },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(executionWorkspaces.id, workspace.id),
          eq(executionWorkspaces.companyId, workspace.companyId),
          sql`coalesce((${executionWorkspaces.metadata}->>'lifecycleGeneration')::int, 0) = ${workspace.metadata?.lifecycleGeneration ?? 0}`,
        ),
      )
      .returning();
  });
  if (!pending)
    throw conflict("Workspace changed before restoration could be recorded");
  workspace = pending;
  const result = await callWorkspaceProvider(db, workers, {
    workspace,
    operation,
    advanceGeneration: true,
  });
  if (result.kind !== "prepared")
    throw conflict("Workspace restoration is incomplete");
  return {
    ...workspace.metadata,
    workspaceProvider: result.binding,
    workspaceProviderRemoved: false,
    workspaceProviderRestoration: null,
    workspaceProviderBaseSha: result.baseSha,
  };
}
