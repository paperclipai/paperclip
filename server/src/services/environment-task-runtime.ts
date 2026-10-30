import { beginIdleTrackedWork } from "./task-admission.js";
import { registerDeferredEnvironmentCleanup, writeEnvironmentCleanup } from "./environment-cleanup-notifications.js";
import { environmentService } from "./environments.js";
import { createSandboxOrphanCleanupSpool, type DeferredOrphanCleanupRecord } from "./sandbox-orphan-cleanup-spool.js";
import { logger } from "../middleware/logger.js";
import { releaseProviderRecoveryTransfers, stageProviderFreshWorkspace } from "./provider-fresh-workspace.js";
import { readWorkspaceProviderBinding } from "@paperclipai/shared";
import { settlePluginTaskCredentialHandoff } from "./plugin-task-credential-writeback.js";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { environmentLeases, executionWorkspaces, environments, heartbeatRuns, issues, projects, type Db } from "@paperclipai/db";
import { freshWorkspaceSchema, environmentTaskOperationSchema, parseEnvironmentTaskResult, type PluginEnvironmentTaskOperation } from "@paperclipai/plugin-sdk";
import { pluginRegistryService } from "./plugin-registry.js";
import { hasRemoteTerminationReceipt, remoteExecutionHasStopped, remoteTerminationReceipt } from "./remote-execution-termination.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

export async function pluginEnvironmentSupportsTasks(db: Db, workers: PluginWorkerManager, lease: { companyId: string; metadata: Record<string, unknown> | null }) {
  const metadata = lease.metadata ?? {};
  if (metadata.driver !== "plugin" || typeof metadata.pluginId !== "string" || typeof metadata.driverKey !== "string") return false;
  const plugin = await pluginRegistryService(db).getById(metadata.pluginId);
  const driver = plugin?.manifestJson.environmentDrivers?.find(value => value.driverKey === metadata.driverKey);
  const methods = workers.getWorker(metadata.pluginId)?.supportedMethods ?? [];
  return plugin?.status === "ready" && driver?.supportsTasks === true &&
    plugin.manifestJson.capabilities.includes("environment.drivers.register") &&
    methods.includes("environmentTask");
}

/** Server-only dispatch for plugin-provided Runner execution.
 * The caller supplies an authorized company and a persisted lease,
 * never a plugin identity, resource endpoint, or agent/project authority.
 * A timeout is ambiguous: retry the same operation against the same lease.
 */
export async function executeEnvironmentTask(db: Db, workers: PluginWorkerManager, input: {
  companyId: string;
  leaseId: string;
  operation: PluginEnvironmentTaskOperation;
}) {
  const operation = environmentTaskOperationSchema.parse(input.operation);
  const [row] = await db.select({ lease: environmentLeases, environment: environments, run: heartbeatRuns })
    .from(environmentLeases)
    .leftJoin(environments, eq(environments.id, environmentLeases.environmentId))
    .leftJoin(heartbeatRuns, and(eq(heartbeatRuns.id, environmentLeases.heartbeatRunId), eq(heartbeatRuns.companyId, environmentLeases.companyId)))
    .where(and(eq(environmentLeases.id, input.leaseId), eq(environmentLeases.companyId, input.companyId))).limit(1);
  if (!row || !row.lease.providerLeaseId) throw new Error("Plugin-provided Runner execution lease unavailable");
  const { lease, environment, run } = row;
  const taskId = row.lease.providerLeaseId;
  const metadata = lease.metadata ?? {};
  const probe = metadata.runnerTaskProbe as { runId?: unknown; sessionId?: unknown; expiresAtMs?: unknown } | undefined;
  const activeProbe = lease.heartbeatRunId === null && lease.issueId === null && probe
    && typeof probe.runId === "string" && typeof probe.sessionId === "string"
    && typeof probe.expiresAtMs === "number" && probe.expiresAtMs > Date.now();
  const checkpointIdentity = operation.kind === "read_state" || operation.kind === "read_file" ? operation.identity
    : operation.kind === "archive_state" ? operation.priorIdentity : null;
  const runner = checkpointIdentity ? { runnerId: checkpointIdentity.runnerInstanceId, leaseId: checkpointIdentity.environmentLeaseId,
    runId: checkpointIdentity.runId, sessionId: checkpointIdentity.normalizedSessionId } : operation.kind === "submit" ? operation.runner : operation.kind === "prepare" ? {
    runnerId: operation.requirements.identity.runnerInstanceId,
    leaseId: operation.requirements.identity.environmentLeaseId,
    runId: operation.requirements.identity.runId, sessionId: operation.requirements.identity.normalizedSessionId,
  } : null;
  const launches = operation.kind === "submit" || operation.kind === "prepare";
  const scopesProjects = launches || operation.kind === "check_project_auth" || operation.kind === "read_file";
  const resumeFrom = launches || checkpointIdentity ? (operation as { resumeFrom?: string }).resumeFrom : undefined;
  const savedIdentity = metadata.runnerTaskIdentity as Record<string, unknown> | undefined;
  const prior = operation.kind === "prepare" ? operation.priorIdentity : undefined;
  const priorSaved = metadata.runnerTaskPriorIdentity as Record<string, unknown> | undefined;
  const matches = (identity: typeof prior, saved: Record<string, unknown> | undefined) => !!identity && !!saved &&
    identity.runnerInstanceId === saved.runnerId && identity.environmentLeaseId === saved.leaseId &&
    identity.normalizedSessionId === saved.sessionId && identity.runId === saved.runId &&
    identity.turnId === saved.turnId && identity.itemId === saved.itemId;
  const ownCheckpoint = checkpointIdentity && !resumeFrom &&
    (matches(checkpointIdentity,savedIdentity) || operation.kind !== "read_file" && matches(checkpointIdentity,priorSaved));
  if (checkpointIdentity && !resumeFrom && !ownCheckpoint) throw new Error("Plugin Runner state identity mismatch");
  const retainedCheckpointRead = operation.kind === "read_state" && ownCheckpoint &&
    lease.leasePolicy === "reuse_by_environment" && ["retained", "expired"].includes(lease.status) &&
    run?.status === "succeeded" && metadata.runnerTaskDispatched === true &&
    (metadata.runnerTaskLifecyclePolicy as {mode?:unknown}|undefined)?.mode === "warm";
  const retainedConnection = operation.kind === "connection" && environment !== null &&
    lease.leasePolicy === "reuse_by_environment" && lease.status === "retained" &&
    run?.status === "succeeded" && savedIdentity?.runId === run.id &&
    metadata.runnerTaskDispatched === true && metadata.runnerTaskExecutionStopped !== true &&
    metadata.runnerTaskRetiring !== true && (!lease.expiresAt || lease.expiresAt.getTime() > Date.now()) &&
    (metadata.runnerTaskLifecyclePolicy as { mode?: unknown } | undefined)?.mode === "warm";
  if ((operation.kind === "read_file" || operation.kind === "describe" || operation.kind === "prepare" || operation.kind === "submit" || (operation.kind === "connection" && !retainedConnection) || (operation.kind === "read_state" && metadata.runnerTaskExecutionStopped !== true && !retainedCheckpointRead) || operation.kind === "archive_state" || operation.kind === "check_project_auth" || operation.kind === "copilot_metadata") &&
      (metadata.runnerTaskRetiring === true || !environment || (!activeProbe && run?.status !== "running") || lease.status !== "active" || (lease.expiresAt && lease.expiresAt.getTime() <= Date.now()))) throw new Error("Plugin-provided Runner execution lease is not active");
  if (operation.kind === "copilot_metadata" && !activeProbe) throw new Error("Copilot metadata requires a private setup lease");
  const warmAttachment = !!prior && metadata.runnerTaskReused === true &&
    (matches(prior, savedIdentity) || matches(prior, priorSaved) && operation.kind === "prepare" && matches(operation.requirements.identity, savedIdentity)) && runner?.runnerId === prior.runnerInstanceId &&
    runner?.leaseId === prior.environmentLeaseId && runner?.sessionId === prior.normalizedSessionId;
  if (prior && !warmAttachment) throw new Error("Plugin warm task prior identity mismatch");
  if (runner && ((!checkpointIdentity || !resumeFrom) && !(ownCheckpoint && operation.kind !== "read_file") && runner.runId !== (activeProbe ? probe.runId : run?.id) || (!resumeFrom && runner.leaseId !== lease.id && !ownCheckpoint && !warmAttachment)
    || (activeProbe && (runner.sessionId !== probe.sessionId || (launches && operation.projectIds.length > 0))))) {
    throw new Error("Plugin-provided Runner execution identity mismatch");
  }
  if (runner && resumeFrom) {
    const inspectCheckpoint = operation.kind === "read_state";
    const sources = await db.select({ id: environmentLeases.id, runId: environmentLeases.heartbeatRunId, metadata: environmentLeases.metadata }).from(environmentLeases).where(and(
      eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.provider, lease.provider!),
      eq(environmentLeases.providerLeaseId, resumeFrom),
      inspectCheckpoint ? undefined : sql`${environmentLeases.metadata}->>'runnerTaskSessionRetained' = 'true'`,
      checkpointIdentity ? eq(environmentLeases.heartbeatRunId, checkpointIdentity.runId) : undefined,
    )).limit(2);
    const priorRunId = sources.length === 1 ? sources[0]!.runId : null;
    const sourceIdentity = sources.length === 1 ? sources[0]!.metadata?.runnerTaskIdentity as Record<string, unknown> | undefined : undefined;
    if (activeProbe || !priorRunId || (checkpointIdentity && (checkpointIdentity.runId !== priorRunId
      || checkpointIdentity.turnId !== sourceIdentity?.turnId || checkpointIdentity.itemId !== sourceIdentity?.itemId)) || resumeFrom !== await resolvePluginTaskResume(db, {
      companyId: input.companyId, leaseId: lease.id,
      priorIdentity: { runnerInstanceId: runner.runnerId, environmentLeaseId: runner.leaseId,
        runId: priorRunId, normalizedSessionId: runner.sessionId },
      inspectCheckpoint,
    })) throw new Error("Plugin Runner resume identity mismatch");
    // Older providers misclassified suspended checkpoints. A fresh provider
    // attestation may repair availability, but never supplies stop/owner authority.
    if (inspectCheckpoint && sources[0]!.metadata?.runnerTaskSessionRetained !== true) {
      const status = await executeEnvironmentTask(db, workers, { companyId: input.companyId,
        leaseId: sources[0]!.id, operation: { kind: "status" } });
      if (status.kind !== "status" || status.executionStopped !== true || status.sessionStateAvailable !== true ||
          resumeFrom !== await resolvePluginTaskResume(db, { companyId: input.companyId, leaseId: lease.id,
            priorIdentity: { runnerInstanceId: runner.runnerId, environmentLeaseId: runner.leaseId,
              runId: priorRunId, normalizedSessionId: runner.sessionId } })) {
        throw new Error("Plugin Runner retained session is not authorized");
      }
    }
  }
  if (metadata.driver !== "plugin" || typeof metadata.pluginId !== "string" || typeof metadata.driverKey !== "string") {
    throw new Error("Plugin-provided Runner execution lease has no pinned plugin driver");
  }
  const plugin = await pluginRegistryService(db).getById(metadata.pluginId);
  const driver = plugin?.manifestJson.environmentDrivers?.find(value => value.driverKey === metadata.driverKey);
  if (!plugin || plugin.status !== "ready" || !driver?.supportsTasks ||
      !plugin.manifestJson.capabilities.includes("environment.drivers.register") ||
      !workers.getWorker(plugin.id)?.supportedMethods.includes("environmentTask")) {
    throw new Error("Plugin-provided Runner execution provider unavailable");
  }
  const issue = scopesProjects && lease.issueId ? await db.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.id, lease.issueId), eq(issues.companyId, input.companyId))).limit(1).then(rows => rows[0]) : null;
  if (scopesProjects && lease.issueId && !issue) throw new Error("Plugin-provided Runner execution issue unavailable");
  const workspaceBinding = readWorkspaceProviderBinding(lease.metadata);
  if (metadata.workspaceProvider !== undefined && !workspaceBinding) throw new Error("Invalid managed workspace binding");
  if (workspaceBinding) {
    const [workspace] = await db.select().from(executionWorkspaces).where(and(
      eq(executionWorkspaces.id, workspaceBinding.executionWorkspaceId), eq(executionWorkspaces.companyId, input.companyId)));
    const saved = readWorkspaceProviderBinding(workspace?.metadata);
    if (!workspace || workspace.id !== lease.executionWorkspaceId || workspace.providerType !== "plugin" || workspace.providerRef !== workspaceBinding.workspaceRef ||
        (scopesProjects && !["active", "idle", "in_review"].includes(workspace.status)) ||
        workspaceBinding.pluginId !== plugin.id || !saved || JSON.stringify(saved) !== JSON.stringify(workspaceBinding)) {
      throw new Error("Managed workspace execution binding changed");
    }
  }
  let freshWorkspace = metadata.freshWorkspace === undefined ? undefined : freshWorkspaceSchema.parse(metadata.freshWorkspace);
  if (freshWorkspace && driver.freshWorkspaceVersion !== 1 && (launches || operation.kind === "describe" || operation.kind === "check_project_auth"))
    throw new Error("Plugin-provided fresh workspace preparation unavailable");
  if (freshWorkspace && operation.kind === "prepare") {
    if (!lease.issueId) throw new Error("Fresh workspace task ownership is missing");
    freshWorkspace = await stageProviderFreshWorkspace({ db, companyId: input.companyId,
      issueId: lease.issueId, ...freshWorkspace, existing: freshWorkspace });
  }
  const projectIds = scopesProjects ? operation.projectIds : [];
  if (scopesProjects && Array.isArray(metadata.runnerTaskProjectIds) &&
      JSON.stringify(projectIds) !== JSON.stringify(metadata.runnerTaskProjectIds)) throw new Error("Plugin Runner project scope changed");
  if (activeProbe && projectIds.length > 0) throw new Error("Plugin Runner probe cannot use project mounts");
  if (projectIds.length > 0) {
    const authorizedProjects = await db.select({ id: projects.id }).from(projects)
      .where(and(eq(projects.companyId, input.companyId), inArray(projects.id, projectIds)));
    if (authorizedProjects.length !== projectIds.length) throw new Error("Plugin-provided Runner execution project unavailable");
  }
  // Provider identity comes from the lease. Editing the environment must never
  // redirect status or cleanup to a replacement plugin.
  const config = (environment?.config ?? {}) as Record<string, unknown>;
  const driverConfig = config.pluginKey === plugin.pluginKey && config.driverKey === metadata.driverKey
    ? (config.driverConfig as Record<string, unknown> | undefined) ?? {} : {};
  let requiredProjectAuthProof: Record<string, unknown> | undefined;
  if (operation.kind === "read_file") {
    const proof = metadata.runnerTaskProjectAuthValidation as { projectIds?: string[] } | undefined;
    if (metadata.runnerTaskExecutionStopped === true || !Array.isArray(proof?.projectIds) ||
      JSON.stringify([...proof.projectIds].sort()) !== JSON.stringify([...operation.projectIds].sort()))
      throw new Error("Plugin Runner file scope unavailable");
  }
  if (operation.kind === "submit") {
    const proof = metadata.runnerTaskProjectAuthValidation as { configurationId?: unknown; provider?: unknown; projectIds?: string[] } | undefined;
    const provider = operation.runner.harness === "codex" ? "openai" : operation.runner.harness === "claude" ? "anthropic" : operation.runner.harness;
    if (!provider || !operation.preparedLaunchId || proof?.configurationId !== operation.preparedLaunchId || proof.provider !== provider
      || (!Array.isArray(proof.projectIds) ? null : JSON.stringify([...proof.projectIds].sort())) !== JSON.stringify([...operation.projectIds].sort())
      || (operation.credential && (operation.credential.type === "codex-auth-json" ? "openai" : "anthropic") !== provider)) {
      throw new Error("Plugin Runner managed project authentication validation unavailable");
    }
    requiredProjectAuthProof = proof as Record<string, unknown>;
  }
  if (operation.kind === "check_project_auth" || operation.kind === "prepare") {
    await db.update(environmentLeases).set({ metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) - 'runnerTaskProjectAuthValidation'` })
      .where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, input.companyId)));
  }
  if (operation.kind === "submit" && activeProbe) {
    const remainingMs = Number(probe.expiresAtMs) - Date.now();
    if (remainingMs <= 0 || !operation.launch) throw new Error("Plugin-provided Runner probe lease is not active");
    // Runner itself must stop if Core disappears during a setup probe.
    const requestedLimits = [operation.launch.maxRuntimeMs, operation.launch.maxLifetimeMs]
      .filter((value): value is number => typeof value === "number" && value > 0);
    operation.launch.maxRuntimeMs = Math.min(remainingMs, ...requestedLimits);
    delete operation.launch.maxLifetimeMs;
  }
  if (operation.kind === "submit" || operation.kind === "copilot_metadata") {
    // No ticket, headers, environment values, or launch paths belong in metadata.
    const marked = await db.update(environmentLeases).set({
      metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ runnerTaskLease: true, runnerTaskDispatched: true, runnerTaskExecutionStopped: false, runnerTaskSessionRetained: false, ...(operation.kind === "submit" ? { runnerTaskIdentity: operation.runner, runnerTaskResumeFrom: operation.resumeFrom ?? null } : {}) })}::jsonb`,
    }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, input.companyId),
      eq(environmentLeases.status, "active"), sql`coalesce(${environmentLeases.metadata}->>'runnerTaskRetiring', 'false') != 'true'`,
      requiredProjectAuthProof ? sql`${environmentLeases.metadata}->'runnerTaskProjectAuthValidation' = ${JSON.stringify(requiredProjectAuthProof)}::jsonb` : undefined,
    )).returning({ id: environmentLeases.id });
    if (marked.length !== 1) throw new Error("Plugin-provided Runner execution lease is not active");
  }
  if (warmAttachment && operation.kind === "prepare") {
    const i = operation.requirements.identity;
    const marked = await db.update(environmentLeases).set({ metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({
      runnerTaskPriorIdentity: { runnerId: prior!.runnerInstanceId, leaseId: prior!.environmentLeaseId, runId: prior!.runId,
        sessionId: prior!.normalizedSessionId, turnId: prior!.turnId, itemId: prior!.itemId },
      runnerTaskIdentity: { runnerId: i.runnerInstanceId, leaseId: i.environmentLeaseId, runId: i.runId,
        sessionId: i.normalizedSessionId, turnId: i.turnId, itemId: i.itemId },
    })}::jsonb` }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.status, "active"),
      sql`coalesce(${environmentLeases.metadata}->>'runnerTaskRetiring', 'false') != 'true'`,
      sql`${environmentLeases.metadata}->'runnerTaskIdentity' = ${JSON.stringify(savedIdentity)}::jsonb`)).returning({id:environmentLeases.id});
    if (marked.length !== 1) throw new Error("Plugin warm task attachment lost authority");
  }
  try {
    if (operation.kind === "describe" && metadata.runnerTaskReused === true) {
      const state = parseEnvironmentTaskResult({kind:"status"}, taskId, await workers.call(plugin.id, "environmentTask", {
        driverKey: metadata.driverKey, companyId: input.companyId, environmentId: environment?.id ?? null,
        issueId: lease.issueId, config: driverConfig, taskId, runId: run?.id ?? null, agentId: run?.agentId ?? null,
        projectIds, lease: {providerLeaseId: taskId, metadata}, operation:{kind:"status"},
      }));
      if (state.kind === "status" && state.executionStopped === true) {
        await executeEnvironmentTask(db, workers, {...input, operation:{kind:"status"}});
        await executeEnvironmentTask(db, workers, {...input, operation:{kind:"complete"}});
        // Preserve the predecessor's stop proof for checkpoint authorization.
        if (typeof metadata.runnerTaskPreviousLeaseId === "string") await db.update(environmentLeases).set({
          metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({runnerTaskExecutionStopped:true,
            runnerTaskSessionRetained:state.sessionStateAvailable === true})}::jsonb`,
        }).where(and(eq(environmentLeases.id, metadata.runnerTaskPreviousLeaseId), eq(environmentLeases.companyId, input.companyId)));
        const fresh = await workers.call(plugin.id, "environmentAcquireLease", {driverKey:metadata.driverKey,
          companyId:input.companyId,environmentId:environment!.id,issueId:lease.issueId,config:driverConfig,
          runId:run!.id,agentId:run!.agentId,adapterType:"paperclip_runner",
          ...(typeof metadata.runnerTaskRequestedExpiresAt === "string" ? {requestedExpiresAt:metadata.runnerTaskRequestedExpiresAt} : {})});
        if (!fresh.providerLeaseId || fresh.providerLeaseId === taskId) throw new Error("Plugin replacement task identity unavailable");
        const {runnerTaskIdentity:_identity,runnerTaskPriorIdentity:_prior,runnerTaskCredentialHandoff:_handoff,
          runnerTaskResumeFrom:_resume,runnerTaskPreviousLeaseId:_previous,...rest}=metadata;
        const replacementMetadata={...rest,providerMetadata:fresh.metadata ?? {},runnerTaskReused:false,runnerTaskDispatched:false,
          runnerTaskExecutionStopped:false,runnerTaskSessionRetained:false};
        try {
          const expiresAt=fresh.expiresAt ? new Date(fresh.expiresAt) : null;
          const deadline=typeof metadata.runnerTaskRequestedExpiresAt === "string" ? Date.parse(metadata.runnerTaskRequestedExpiresAt) : null;
          if ((expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) ||
              (deadline !== null && (!Number.isFinite(deadline) || !expiresAt || expiresAt.getTime() > deadline)))
            throw new Error("Plugin replacement task expiry is not bounded");
          const replacement = await db.update(environmentLeases).set({providerLeaseId:fresh.providerLeaseId,expiresAt,
            metadata:replacementMetadata,
          }).where(and(eq(environmentLeases.id,lease.id),eq(environmentLeases.providerLeaseId,taskId),
            eq(environmentLeases.status,"active"))).returning({id:environmentLeases.id});
          if (replacement.length !== 1) throw new Error("Plugin task replacement ownership changed");
        } catch (error) {
          try {
            await workers.call(plugin.id,"environmentReleaseLease",{driverKey:metadata.driverKey,companyId:input.companyId,
              environmentId:environment!.id,issueId:lease.issueId,config:driverConfig,providerLeaseId:fresh.providerLeaseId,
              leaseMetadata:replacementMetadata});
          } catch {
            const orphan:DeferredOrphanCleanupRecord={companyId:input.companyId,environmentId:environment!.id,
              executionWorkspaceId:lease.executionWorkspaceId,issueId:lease.issueId,heartbeatRunId:lease.heartbeatRunId,
              provider:lease.provider!,providerLeaseId:fresh.providerLeaseId,metadata:replacementMetadata};
            try {
              await environmentService(db).insertPendingCleanupLease({...orphan,failureReason:"plugin_task_replacement_unowned"});
            } catch {
              // The existing orphan spool recovers cleanup even when the database is unavailable.
              const spool = createSandboxOrphanCleanupSpool();
              const persisted = await spool.append(orphan);
              const finish = beginIdleTrackedWork();
              let flushing: Promise<{ recovered: number; pending: number }> | null = null;
              const unregister = registerDeferredEnvironmentCleanup(db, () => {
                flushing ??= (async () => {
                  await environmentService(db).insertPendingCleanupLease({...orphan,failureReason:"plugin_task_replacement_unowned"});
                  await spool.remove(orphan);
                  unregister();
                  finish();
                  return { recovered: 1, pending: 0 };
                })().catch(error => { flushing = null; throw error; });
                // Keep successful completion for a concurrent sweep that already
                // captured this callback before it was unregistered.
                return flushing;
              });
              logger.error({providerLeaseId:fresh.providerLeaseId,persisted},"Plugin replacement cleanup requires recovery");
            }
          }
          throw error;
        }
        return executeEnvironmentTask(db, workers, input);
      }
    }
    if (operation.kind === "complete") {
      await settlePluginTaskCredentialHandoff(db, { companyId: input.companyId, leaseId: lease.id }, metadata, async accountIdentity => {
        const snapshot = await executeEnvironmentTask(db, workers, { ...input, operation: { kind: "credentials", accountIdentity } });
        if (snapshot.kind !== "credentials") throw new Error("Plugin Runner credential snapshot unavailable");
        return snapshot.credential;
      });
    }
    const result = await workers.call(plugin.id, "environmentTask", {
      driverKey: metadata.driverKey, companyId: input.companyId, environmentId: environment?.id ?? null,
      issueId: lease.issueId, config: driverConfig,
      taskId, runId: run?.id ?? (activeProbe ? String(probe.runId) : null), agentId: run?.agentId ?? null, projectIds,
      lease: { providerLeaseId: lease.providerLeaseId, metadata: lease.metadata ?? undefined },
      ...(workspaceBinding ? { workspace: workspaceBinding } : {}),
      ...(freshWorkspace && scopesProjects ? { fresh: freshWorkspace } : {}), operation,
    }, operation.kind === "copilot_metadata" ? Math.max(1, Math.min(40_000, Number(probe?.expiresAtMs) - Date.now())) : 15_000);
    const parsed = parseEnvironmentTaskResult(operation, taskId, result);
    if (operation.kind === "read_file") {
      const [current] = await db.select({ lease: environmentLeases, run: heartbeatRuns }).from(environmentLeases)
        .leftJoin(heartbeatRuns, and(eq(heartbeatRuns.id, environmentLeases.heartbeatRunId), eq(heartbeatRuns.companyId, environmentLeases.companyId)))
        .where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, input.companyId))).limit(1);
      if (!current || current.lease.status !== "active" || current.run?.status !== "running" ||
        current.lease.metadata?.runnerTaskRetiring === true || current.lease.metadata?.runnerTaskExecutionStopped === true ||
        current.lease.expiresAt && current.lease.expiresAt.getTime() <= Date.now()) throw new Error("Plugin Runner file lease expired during transfer");
    }
    if (freshWorkspace && parsed.kind === "description" && parsed.freshWorkspaceVersion !== 1)
      throw new Error("Plugin-provided fresh workspace preparation unavailable");
    if (operation.kind === "prepare" && parsed.kind === "prepared" && parsed.projectAuthCheckAtSubmit) {
      const harness = operation.requirements.provider === "acpx" ? operation.requirements.settings.acpxAgent : operation.requirements.provider;
      if (!harness) throw new Error("Plugin Runner prepared provider unavailable");
      const provider = harness === "codex" ? "openai" : harness === "claude" ? "anthropic" : harness;
      const saved = await db.update(environmentLeases).set({ metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({
        runnerTaskProjectAuthValidation: { configurationId: parsed.launch.configurationId, provider, projectIds, atSubmit: true },
      })}::jsonb` }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, input.companyId),
        eq(environmentLeases.status, "active"), sql`coalesce(${environmentLeases.metadata}->>'runnerTaskRetiring', 'false') != 'true'`)).returning({ id: environmentLeases.id });
      if (saved.length !== 1) throw new Error("Plugin Runner project validation lease expired");
    }
    if (operation.kind === "check_project_auth" && parsed.kind === "project_auth") {
      if (parsed.configurationId !== operation.configurationId || parsed.provider !== operation.provider) throw new Error("Plugin Runner project validation identity mismatch");
      if (parsed.allowed) {
        const saved = await db.update(environmentLeases).set({ metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({
          runnerTaskProjectAuthValidation: { configurationId: parsed.configurationId, provider: parsed.provider, projectIds },
        })}::jsonb` }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, input.companyId),
          eq(environmentLeases.status, "active"), sql`coalesce(${environmentLeases.metadata}->>'runnerTaskRetiring', 'false') != 'true'`)).returning({ id: environmentLeases.id });
        if (saved.length !== 1) throw new Error("Plugin Runner project validation lease expired");
      }
    }
    if ((parsed.kind === "status" || parsed.kind === "copilot_metadata") && parsed.executionStopped === true) {
      await db.update(environmentLeases).set({
        metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ runnerTaskExecutionStopped: true, runnerTaskSessionRetained: parsed.kind === "status" && parsed.sessionStateAvailable === true })}::jsonb`,
      }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, input.companyId)));
    }
    if (operation.kind === "complete") {
      if (freshWorkspace && metadata.runnerTaskExecutionStopped === true)
        await releaseProviderRecoveryTransfers(input.companyId, freshWorkspace);
      // A physical task can back several run leases. Confirm retirement for every prior owner.
      if (lease.leasePolicy === "reuse_by_environment" && metadata.runnerTaskExecutionStopped === true) {
        const owners=await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId,input.companyId),
          eq(environmentLeases.provider,lease.provider!),eq(environmentLeases.providerLeaseId,taskId)));
        for(const owner of owners) {
          const receipt=remoteTerminationReceipt(owner,{providerLeaseId:taskId,state:"stopped"});
          if(!receipt) continue;
          await writeEnvironmentCleanup(db, tx => tx.update(environmentLeases).set({
            ...(owner.status === "retained" ? {status:"released" as const,releasedAt:new Date(),cleanupStatus:"success" as const}:{}),
            metadata:sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({remoteExecutionTermination:receipt,runnerTaskExecutionStopped:true})}::jsonb`,
          }).where(eq(environmentLeases.id,owner.id)), { companyId: owner.companyId, runId: owner.heartbeatRunId ?? undefined });
        }
      }
      await db.update(environmentLeases).set({
        metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || '{"runnerTaskDispatched":false}'::jsonb`,
      }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, input.companyId),
        sql`${environmentLeases.metadata}->>'runnerTaskExecutionStopped' = 'true'`));
    }
    return parsed;
  } catch {
    // Worker errors and schema diagnostics can contain request credentials.
    throw new Error("Plugin-provided Runner execution operation unavailable; reconcile the same task before retrying");
  }
}

/** Failure leaves the dispatch marker and provider handle available to cleanup retries. */
export async function settleDispatchedEnvironmentTask(db: Db, workers: PluginWorkerManager, lease: { id: string; companyId: string }) {
  const [current] = await db.update(environmentLeases).set({
    metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || '{"runnerTaskRetiring":true}'::jsonb`,
  }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId)))
    .returning({ metadata: environmentLeases.metadata, heartbeatRunId: environmentLeases.heartbeatRunId });
  if (current?.metadata?.runnerTaskDispatched !== true) {
    if (current?.metadata) await settlePluginTaskCredentialHandoff(db, { companyId: lease.companyId, leaseId: lease.id }, current.metadata,
      async () => { throw new Error("Undispatched task must not request credentials"); });
    return current?.metadata?.runnerTaskExecutionStopped === true;
  }
  const scope = { companyId: lease.companyId, leaseId: lease.id };
  try {
    await executeEnvironmentTask(db, workers, { ...scope, operation: { kind: "stop" } });
    const state = await executeEnvironmentTask(db, workers, { ...scope, operation: { kind: "status" } });
    if (state.kind !== "status" || state.executionStopped !== true) throw new Error("Plugin Runner termination is unconfirmed");
    await executeEnvironmentTask(db, workers, { ...scope, operation: { kind: "complete" } });
    return true;
  } catch {
    await writeEnvironmentCleanup(db, tx => tx.update(environmentLeases).set({ status: "pending_cleanup", cleanupStatus: "failed",
      failureReason: "plugin_runner_task_cleanup_unconfirmed", releasedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId))), { companyId: lease.companyId, runId: current.heartbeatRunId ?? undefined });
    throw new Error("Plugin Runner termination is unconfirmed; the saved lease requires cleanup");
  }
}

/** A saved provider task can resume only within the same authorized agent workspace. */
export async function resolvePluginTaskResume(db: Db, input: {
  companyId: string; leaseId: string;
  priorIdentity: { runnerInstanceId: string; environmentLeaseId: string; runId: string; normalizedSessionId: string };
  /** Read-only discovery; launching still requires an attested retained checkpoint. */
  inspectCheckpoint?: boolean;
}): Promise<string> {
  const rows = await db.select({ lease: environmentLeases, run: heartbeatRuns }).from(environmentLeases)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, environmentLeases.heartbeatRunId), eq(heartbeatRuns.companyId, input.companyId)))
    .where(and(eq(environmentLeases.companyId, input.companyId),
      or(eq(environmentLeases.id, input.leaseId), eq(heartbeatRuns.id, input.priorIdentity.runId))));
  const next = rows.find(row => row.lease.id === input.leaseId);
  // A retained PRP lease is logical; later provider tasks have different physical lease IDs.
  const candidates = rows.filter(row => {
    const identity = row.lease.metadata?.runnerTaskIdentity as Record<string, unknown> | undefined;
    return row.lease.id !== input.leaseId && row.run.id === input.priorIdentity.runId &&
      (input.inspectCheckpoint || row.lease.metadata?.runnerTaskSessionRetained === true) &&
      identity?.runnerId === input.priorIdentity.runnerInstanceId && identity.leaseId === input.priorIdentity.environmentLeaseId &&
      identity.sessionId === input.priorIdentity.normalizedSessionId && identity.runId === input.priorIdentity.runId &&
      !rows.some(successor => successor.lease.id !== input.leaseId &&
        successor.lease.metadata?.runnerTaskResumeFrom === row.lease.providerLeaseId);
  });
  const old = candidates.length === 1 ? candidates[0] : undefined;
  const identity = old?.lease.metadata?.runnerTaskIdentity as Record<string, unknown> | undefined;
  if (!old || !next || !old.lease.providerLeaseId || !identity ||
      identity.runnerId !== input.priorIdentity.runnerInstanceId || identity.leaseId !== input.priorIdentity.environmentLeaseId ||
      identity.sessionId !== input.priorIdentity.normalizedSessionId || identity.runId !== input.priorIdentity.runId ||
      old.lease.metadata?.driver !== "plugin" || next.lease.metadata?.driver !== "plugin" ||
      !next.lease.providerLeaseId || next.lease.providerLeaseId === old.lease.providerLeaseId ||
      (old.run.id !== next.run.id && !["succeeded", "interrupted", "failed", "cancelled", "timed_out"].includes(old.run.status)) ||
      old.run.agentId !== next.run.agentId || old.lease.issueId !== next.lease.issueId ||
      old.lease.executionWorkspaceId !== next.lease.executionWorkspaceId ||
      !old.lease.environmentId || old.lease.environmentId !== next.lease.environmentId ||
      !next.lease.provider?.startsWith("plugin:") || old.lease.provider !== next.lease.provider ||
      old.lease.metadata?.pluginId !== next.lease.metadata?.pluginId || old.lease.metadata?.driverKey !== next.lease.metadata?.driverKey ||
      next.lease.status !== "active" || next.lease.releasedAt || next.run.status !== "running" ||
      (next.lease.expiresAt && next.lease.expiresAt.getTime() <= Date.now()) ||
      !(old.run.id === next.run.id
        ? rows.filter(row => row.lease.id !== next.lease.id).every(row => hasRemoteTerminationReceipt(row.lease))
        : await remoteExecutionHasStopped(db, input.companyId, old.run.id))) {
    throw new Error("Plugin Runner retained session is not authorized");
  }
  return old.lease.providerLeaseId;
}
