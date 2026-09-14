import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { activityLog, environmentLeases, executionWorkspaceRuntimeLeases, executionWorkspaces, heartbeatRuns, issues, projectWorkspaces,
  runtimeServiceAllocations, runtimeServiceDataDeletions, runtimeServiceEvents, runtimeServices, workspaceRuntimeServices, type Db } from "@paperclipai/db";
import type { DeleteRuntimeServiceData, RuntimeServiceDataDeletionPlan } from "@paperclipai/shared";
import { conflict, forbidden, HttpError, notFound } from "../../errors.js";
import { lockRuntimeServiceCompany, reservesRunningCapacity } from "./company-policy.js";
import { claimRuntimeServiceDataDeletion, withRuntimeServiceDataDeletionClaim, runtimeServiceDataDeletionView, type createRuntimeServiceDataDeletionExecutor } from "./data-deletion.js";
import type { RuntimeServiceActor } from "./manager.js";
import { captureTaskWorkspaceDataTarget, removeTaskWorkspaceData, taskWorkspaceDataTargetSchema } from "./workspace-data-cleanup.js";
import { taskWorkspacePathsOverlap, tryLockTaskWorkspaceDataDeletion } from "./workspace-data-fence.js";
import { bumpExecutionWorkspaceLifecycleGeneration, clearMetadataReopenPendingConsumption, metadataHasReopenPendingConsumption } from "../execution-workspaces.js";
import { inspectTaskProviderData, taskDataIdentityHash, taskProviderDataTargetSchema, taskProviderDeletionConfirmed } from "./workspace-provider-data-deletion.js";
import { lockRuntimeServiceLease } from "./retention.js";
import { assertRuntimeServiceDataExpired, readRuntimeServiceDataExpiration } from "./retention-expiry.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Reader = Pick<Db, "select">;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item)).digest("hex");
const localTargetSchema = z.object({ kind: z.literal("local_task_workspace"), version: z.literal(2), workspaceId: z.string().guid(), allocationId: z.string().guid(),
  allocationIds: z.array(z.string().guid()).min(1), serviceIds: z.array(z.string().guid()).min(1), leaseIds: z.array(z.string().guid()),
  workspaceFingerprint: z.string(), filesystem: taskWorkspaceDataTargetSchema }).strict();
const targetSchema = z.discriminatedUnion("version", [localTargetSchema, localTargetSchema.extend({ kind: z.literal("task_workspace"), version: z.literal(3),
  providers: z.array(taskProviderDataTargetSchema) })]);
const failure = "Task workspace deletion could not be confirmed. Its files remain fenced from new work. Restore the reviewed workspace identity or resolve its remaining dependencies, then retry.";
const ownership = (row: typeof executionWorkspaces.$inferSelect) => ({ id: row.id, companyId: row.companyId, projectId: row.projectId,
  projectWorkspaceId: row.projectWorkspaceId, mode: row.mode, cwd: row.cwd, providerRef: row.providerRef, providerType: row.providerType, branchName: row.branchName,
  status: row.status, metadata: row.metadata });
const terminal = (status: string) => ["done", "cancelled"].includes(status);
async function canonical(value: string | null | undefined) {
  if (!value || !path.isAbsolute(value)) return null;
  return fs.realpath(value).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return path.resolve(value); throw error; });
}
function within(root: string, candidate: string) { return candidate === root || candidate.startsWith(`${root}${path.sep}`); }

export function createTaskWorkspaceDataDeletionStore(db: Db, options: { now: () => Date; executor?: ReturnType<typeof createRuntimeServiceDataDeletionExecutor>;
  clearEnvironment?: (tx: Transaction, row: typeof runtimeServices.$inferSelect) => Promise<void> }) {
  const updatedAt = () => sql`greatest(${options.now().toISOString()}::timestamptz, ${runtimeServiceDataDeletions.updatedAt} + interval '1 millisecond')`;
  async function selected(reader: Reader, companyId: string, serviceId: string) {
    const [row] = await reader.select({ allocation: runtimeServiceAllocations }).from(runtimeServices)
      .innerJoin(runtimeServiceAllocations, and(eq(runtimeServiceAllocations.id, runtimeServices.allocationId), eq(runtimeServiceAllocations.companyId, runtimeServices.companyId)))
      .where(and(eq(runtimeServices.companyId, companyId), eq(runtimeServices.id, serviceId)));
    if (!row) throw notFound("Service not found");
    return row.allocation;
  }
  async function inspect(reader: Reader, companyId: string, serviceId: string) {
    const allocation = await selected(reader, companyId, serviceId);
    const [workspace] = allocation.executionWorkspaceId ? await reader.select().from(executionWorkspaces)
      .where(and(eq(executionWorkspaces.companyId, companyId), eq(executionWorkspaces.id, allocation.executionWorkspaceId))) : [];
    if (!workspace) throw conflict("The task workspace ownership record is unavailable");
    const [job] = allocation.dataDeletionId ? await reader.select().from(runtimeServiceDataDeletions)
      .where(and(eq(runtimeServiceDataDeletions.companyId, companyId), eq(runtimeServiceDataDeletions.id, allocation.dataDeletionId))) : [];
    const saved = targetSchema.safeParse(job?.target);
    const root = saved.success ? saved.data.filesystem.root.path : await canonical(workspace.providerRef ?? workspace.cwd);
    const blockers: string[] = [];
    if (!["local", "daytona"].includes(allocation.provider) || workspace.mode !== "isolated_workspace") blockers.push("Only an owned, isolated task workspace can use this deletion control.");
    if (metadataHasReopenPendingConsumption(workspace.metadata)) blockers.push("This workspace has just been reopened. Wait for that operation to finish before deleting its data.");
    let allAllocations = await reader.select().from(runtimeServiceAllocations).where(or(
      eq(runtimeServiceAllocations.executionWorkspaceId, workspace.id),
      and(eq(runtimeServiceAllocations.provider, "local"), sql`coalesce(${runtimeServiceAllocations.metadata}->>'retentionReleased', 'false') <> 'true'`),
      ...(job ? [eq(runtimeServiceAllocations.dataDeletionId, job.id)] : []),
    )).orderBy(asc(runtimeServiceAllocations.id));
    const leaseRefs = allAllocations.filter((candidate) => candidate.executionWorkspaceId === workspace.id || candidate.dataDeletionId === job?.id)
      .flatMap((candidate) => candidate.environmentLeaseId ? [candidate.environmentLeaseId] : []);
    let leases = await reader.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, companyId), or(eq(environmentLeases.executionWorkspaceId, workspace.id),
      ...(leaseRefs.length ? [inArray(environmentLeases.id, leaseRefs)] : [])))).orderBy(asc(environmentLeases.id));
    const remoteIds = [...new Set(leases.filter((lease) => lease.provider && lease.provider !== "local").flatMap((lease) => lease.providerLeaseId ? [lease.providerLeaseId] : []))];
    if (remoteIds.length) {
      // Look across company/workspace boundaries without exposing their names.
      // A shared physical resource must never be deleted through one owner.
      const physicalLeases = await reader.select().from(environmentLeases).where(inArray(environmentLeases.providerLeaseId, remoteIds));
      if (physicalLeases.some((lease) => lease.companyId !== companyId || lease.executionWorkspaceId !== workspace.id)) blockers.push("Another workspace or company still depends on a remote sandbox. Resolve that dependency before deleting data.");
      leases = [...new Map([...leases, ...physicalLeases.filter((lease) => lease.companyId === companyId && lease.executionWorkspaceId === workspace.id)].map((lease) => [lease.id, lease])).values()].sort((a, b) => a.id.localeCompare(b.id));
      const physicalAllocations = await reader.select().from(runtimeServiceAllocations).where(inArray(runtimeServiceAllocations.environmentLeaseId, physicalLeases.map((lease) => lease.id)));
      allAllocations = [...new Map([...allAllocations, ...physicalAllocations].map((candidate) => [candidate.id, candidate])).values()].sort((a, b) => a.id.localeCompare(b.id));
    }
    const remoteLeaseIds = new Set(leases.filter((lease) => lease.provider && lease.provider !== "local").map((lease) => lease.id));
    const allocations: typeof allAllocations = [];
    for (const candidate of allAllocations) {
      const cwd = candidate.provider === "local" ? await canonical(candidate.cwd) : null;
      if (candidate.executionWorkspaceId !== workspace.id && !(job && candidate.dataDeletionId === job.id) && !remoteLeaseIds.has(candidate.environmentLeaseId ?? "") && !(root && cwd && taskWorkspacePathsOverlap(root, cwd))) continue;
      if (candidate.companyId !== companyId || (candidate.executionWorkspaceId && candidate.executionWorkspaceId !== workspace.id) || (root && cwd && !within(root, cwd))) {
        blockers.push("Another workspace or company still depends on these files. Resolve that dependency before deleting data."); continue;
      }
      allocations.push(candidate);
      if (!["local", "daytona"].includes(candidate.provider) || (candidate.provider === "daytona" && !remoteLeaseIds.has(candidate.environmentLeaseId ?? ""))) blockers.push("The task service's remote allocation identity could not be verified.");
      if (candidate.metadata.allocationRequest) blockers.push("An independently owned service allocation still uses this task workspace. Detach it before deleting task data.");
      if (candidate.dataDeletionId && candidate.dataDeletionId !== job?.id) blockers.push("Another deletion already owns part of this task workspace.");
      if (root && cwd && !within(root, cwd)) blockers.push("A service working directory is outside the owned task workspace.");
    }
    if (!allocations.some((candidate) => candidate.id === allocation.id)) throw conflict("The service allocation is outside its task workspace");
    const owner = job ? allocations.find((candidate) => candidate.id === job.allocationId) : allocations[0];
    if (!owner) throw conflict("The task workspace deletion owner is unavailable");
    const ids = allocations.map((candidate) => candidate.id);
    const services = await reader.select().from(runtimeServices).where(and(eq(runtimeServices.companyId, companyId), inArray(runtimeServices.allocationId, ids))).orderBy(asc(runtimeServices.id));
    const extraLeaseIds = allocations.flatMap((candidate) => candidate.environmentLeaseId && !leases.some((lease) => lease.id === candidate.environmentLeaseId) ? [candidate.environmentLeaseId] : []);
    if (extraLeaseIds.length) leases = [...leases, ...await reader.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, companyId), inArray(environmentLeases.id, extraLeaseIds)))].sort((a, b) => a.id.localeCompare(b.id));
    const providers = inspectTaskProviderData({ companyId, workspaceId: workspace.id, leases, deletionId: job?.id,
      supported: (target) => options.executor?.supportsTaskProvider(target) ?? false });
    blockers.push(...providers.blockers);
    if (leases.some((lease) => lease.metadata?.runtimeServiceDataDeletionId && lease.metadata.runtimeServiceDataDeletionId !== job?.id)) blockers.push("Another deletion already owns part of this task workspace.");
    if (saved.success && hash(providers.targets) !== hash(saved.data.version === 3 ? saved.data.providers : [])) blockers.push("The saved remote workspace identities changed. Restore the reviewed ownership before retrying deletion.");
    const tasks = await reader.select().from(issues).where(and(eq(issues.companyId, companyId), or(eq(issues.executionWorkspaceId, workspace.id),
      ...(workspace.sourceIssueId ? [eq(issues.id, workspace.sourceIssueId)] : [])))).orderBy(asc(issues.id));
    if (tasks.some((task) => !terminal(task.status))) blockers.push("Complete or cancel every linked task before deleting its workspace data.");
    const otherWorkspaces = await reader.select().from(executionWorkspaces).where(sql`${executionWorkspaces.id} <> ${workspace.id}`);
    const overlappingWorkspaceIds = [workspace.id];
    for (const other of otherWorkspaces) {
      if (other.cleanupReason === "runtime_service_data_deleted") continue;
      const cwd = await canonical(other.providerRef ?? other.cwd);
      if (!root || !cwd || !taskWorkspacePathsOverlap(root, cwd)) continue;
      overlappingWorkspaceIds.push(other.id);
      // An idle parent checkout is normal for .paperclip/worktrees. A second
      // workspace inside the deleted tree, however, owns files being removed.
      if (within(root, cwd)) blockers.push("Another execution workspace points at these files. Resolve that dependency before deleting data.");
    }
    const overlappingTasks = await reader.select({ id: issues.id, checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId }).from(issues)
      .where(inArray(issues.executionWorkspaceId, overlappingWorkspaceIds));
    const taskIds = [...new Set([...tasks, ...overlappingTasks].map((task) => task.id))].sort();
    const runIds = [...new Set([...tasks, ...overlappingTasks].flatMap((task) => [task.checkoutRunId, task.executionRunId])
      .concat(leases.map((lease) => lease.heartbeatRunId)).filter((id): id is string => !!id))];
    const runs = await reader.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]), or(
        sql`${heartbeatRuns.contextSnapshot}->>'executionWorkspaceId' in (${sql.join(overlappingWorkspaceIds.map((id) => sql`${id}`), sql`, `)})`,
        ...(taskIds.length ? [sql`${heartbeatRuns.contextSnapshot}->>'issueId' in (${sql.join(taskIds.map((id) => sql`${id}`), sql`, `)})`] : []),
        ...(runIds.length ? [inArray(heartbeatRuns.id, runIds)] : []),
      ))).orderBy(asc(heartbeatRuns.id));
    const activeLeases = await reader.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      inArray(environmentLeases.executionWorkspaceId, overlappingWorkspaceIds), eq(environmentLeases.status, "active")));
    const unboundLocalLeases = await reader.select({ metadata: environmentLeases.metadata, status: environmentLeases.status, updatedAt: environmentLeases.updatedAt }).from(environmentLeases).where(and(
      sql`${environmentLeases.metadata}->'runtimeServiceBoundary'->>'provider' = 'local'`));
    let localPathInUse = false;
    const activityDates = [workspace.updatedAt];
    for (const lease of unboundLocalLeases) {
      const boundary = lease.metadata?.runtimeServiceBoundary as { workspaceRoot?: unknown } | undefined;
      const cwd = typeof boundary?.workspaceRoot === "string" ? await canonical(boundary.workspaceRoot) : null;
      if (root && cwd && taskWorkspacePathsOverlap(root, cwd)) {
        activityDates.push(lease.updatedAt);
        if (lease.status === "active") localPathInUse = true;
      }
    }
    if (runs.length || activeLeases.length || localPathInUse || leases.some((lease) => lease.status === "active")) blockers.push("An agent run or its final file sync is still using this workspace. Wait for it to finish.");
    if (services.some((service) => reservesRunningCapacity(service) || !["stopped", "sleeping", "deleted"].includes(service.state) ||
      (service.controllerId && (!service.controllerExpiresAt || service.controllerExpiresAt > options.now())))) blockers.push("Stop all services and wait for their current operations to finish before deleting data.");
    const legacy = await reader.select().from(workspaceRuntimeServices).where(or(eq(workspaceRuntimeServices.executionWorkspaceId, workspace.id), isNotNull(workspaceRuntimeServices.cwd)));
    for (const service of legacy) {
      const cwd = await canonical(service.cwd);
      if ((service.executionWorkspaceId === workspace.id || (root && cwd && taskWorkspacePathsOverlap(root, cwd))) && !service.stoppedAt && !["stopped", "exited"].includes(service.status)) blockers.push("A workspace runtime is still using these files. Stop it before deleting data.");
    }
    const claims = await reader.select().from(executionWorkspaceRuntimeLeases).where(and(eq(executionWorkspaceRuntimeLeases.companyId, companyId), eq(executionWorkspaceRuntimeLeases.executionWorkspaceId, workspace.id)));
    if (claims.some((claim) => claim.expiresAt > options.now() && claim.lastAction !== "stop" &&
      !(claim.ownerIssueId && tasks.some((task) => task.id === claim.ownerIssueId && terminal(task.status))))) blockers.push("Workspace runtime controls are still reserved by an agent. Release that use before deleting data.");
    const projects = await reader.select({ cwd: projectWorkspaces.cwd }).from(projectWorkspaces).where(isNotNull(projectWorkspaces.cwd));
    const projectRoots: string[] = [];
    for (const project of projects) {
      const cwd = await canonical(project.cwd);
      if (root && cwd && within(root, cwd)) blockers.push("These files contain project workspace infrastructure and cannot be deleted here.");
      if (cwd && await fs.stat(cwd).then((stat) => stat.isDirectory(), () => false)) projectRoots.push(cwd);
    }
    let filesystem = saved.success ? saved.data.filesystem : null;
    if (!job) {
      try { filesystem = await captureTaskWorkspaceDataTarget(workspace, [...new Set(projectRoots)].sort()); }
      catch { blockers.push("The owned task workspace or its Git identity could not be verified, or it contains a managed instance requiring separate cleanup."); }
    } else if (!saved.success) blockers.push("The saved task workspace deletion receipt needs recovery.");
    const uniqueBlockers = [...new Set(blockers)].sort();
    const plan: RuntimeServiceDataDeletionPlan = { allocationId: owner.id, provider: providers.targets.length ? "daytona" : owner.provider, scope: "task_workspace", blockers: uniqueBlockers,
      services: services.map((service) => ({ id: service.id, name: service.name, state: service.state as RuntimeServiceDataDeletionPlan["services"][number]["state"] })),
      tasks: tasks.map((task) => ({ id: task.id, title: task.title, identifier: task.identifier })), includesHostMirror: providers.targets.length > 0 && !!filesystem,
      workspace: { id: workspace.id, name: workspace.name, providerType: workspace.providerType, preservesBranchHistory: workspace.providerType === "git_worktree" },
      remoteSandboxes: (saved.success && saved.data.version === 3 ? saved.data.providers : providers.targets).map((target) => ({ provider: target.provider, id: target.providerLeaseId, name: target.ownership.sandboxName,
        deleted: taskProviderDeletionConfirmed(target, leases, job?.id) })),
      deletion: runtimeServiceDataDeletionView(job), planToken: hash({ owner: owner.id, workspace: ownership(workspace), filesystem, allocations: ids, providers: providers.targets,
        services: services.map((service) => [service.id, service.revision, service.controllerId, service.processRef]),
        tasks: tasks.map((task) => [task.id, task.status, task.executionWorkspaceId]), leases: leases.map((lease) => [lease.id, lease.status]), runs,
        blockers: uniqueBlockers, job: job ? [job.id, job.state, job.attempts] : null }) };
    return { plan, owner, allocations, services, leases, tasks, workspace, filesystem, providers: providers.targets, job, activityDates, workspaceIds: overlappingWorkspaceIds };
  }
  async function event(tx: Transaction, companyId: string, serviceId: string, actor: RuntimeServiceActor, kind: string, details: Record<string, unknown>, requestKey?: string) {
    const [service] = await tx.select().from(runtimeServices).where(and(eq(runtimeServices.companyId, companyId), eq(runtimeServices.id, serviceId)));
    if (!service) throw notFound("Service not found");
    await tx.insert(runtimeServiceEvents).values({ companyId, serviceId, revision: service.revision, kind, actor, details, requestKey });
    await tx.insert(activityLog).values({ companyId, actorType: actor.type === "board" ? "user" : "system", actorId: actor.id, action: `runtime_service.${kind}`,
      entityType: "runtime_service_allocation", entityId: String(details.allocationId), details });
  }
  async function request(companyId: string, serviceId: string, actor: RuntimeServiceActor, input: DeleteRuntimeServiceData, retentionRevision?: number) {
    if (retentionRevision === undefined && actor.type !== "board") throw forbidden("Only an operator can authorize task workspace data deletion");
    const requestKey = `data-delete:${actor.id}:${input.requestId}`, inputHash = hash(input);
    await db.transaction(async (tx) => {
      await lockRuntimeServiceCompany(tx, companyId);
      const [prior] = await tx.select().from(runtimeServiceEvents).where(and(eq(runtimeServiceEvents.companyId, companyId), eq(runtimeServiceEvents.serviceId, serviceId), eq(runtimeServiceEvents.requestKey, requestKey)));
      if (prior) { if (prior.details.inputHash !== inputHash) throw conflict("This request ID was already used for a different data deletion"); return; }
      await tryLockTaskWorkspaceDataDeletion(tx);
      const first = await inspect(tx, companyId, serviceId);
      const lifecycle = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`execution_workspace_lifecycle:${first.workspace.id}`}, 0)) as acquired`);
      if (!lifecycle[0]?.acquired) throw conflict("The task workspace is changing. Refresh the deletion review and retry.");
      const physicalKeys = first.leases.map((lease) => `runtime-service-allocation:${lease.companyId}:${lease.provider ?? "local"}:${lease.providerLeaseId ?? lease.id}`);
      for (const key of [`runtime-service-workspace:${companyId}:${first.workspace.id}`, ...first.allocations.map((row) => `runtime-service-retention:${row.id}`), ...new Set(physicalKeys.sort())]) {
        const result = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${key})) as acquired`);
        if (!result[0]?.acquired) throw conflict("The task workspace is in use. Refresh the deletion review and retry.");
      }
      await tx.select({ id: runtimeServices.id }).from(runtimeServices).where(inArray(runtimeServices.id, first.services.map((service) => service.id))).for("update");
      await tx.select({ id: executionWorkspaces.id }).from(executionWorkspaces).where(eq(executionWorkspaces.id, first.workspace.id)).for("update");
      const current = await inspect(tx, companyId, serviceId);
      if (!input.confirm || input.confirmedAllocationId !== current.owner.id || input.planToken !== current.plan.planToken) throw conflict("The task workspace or its dependencies changed. Review the current deletion before confirming again.");
      if (current.plan.blockers.length) throw conflict(current.plan.blockers.join(" "));
      const authorization = retentionRevision === undefined ? { kind: "operator" as const }
        : assertRuntimeServiceDataExpired(await readRuntimeServiceDataExpiration(tx, companyId, current, options.now()), retentionRevision);
      const id = current.job?.id ?? randomUUID();
      if (current.job) {
        const lock = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${`runtime-service-data-deletion:${id}`})) as acquired`);
        if (!lock[0]?.acquired || current.job.state !== "failed") throw conflict("Task workspace deletion is already in progress");
        await tx.update(runtimeServiceDataDeletions).set({ state: "pending", retryAt: null, error: null, updatedAt: updatedAt() }).where(eq(runtimeServiceDataDeletions.id, id));
      } else {
        const metadata = { ...clearMetadataReopenPendingConsumption(bumpExecutionWorkspaceLifecycleGeneration(current.workspace.metadata)), runtimeServiceDataDeletionId: id };
        const nextWorkspace = { ...current.workspace, status: "archived", metadata };
        const target = targetSchema.parse({ kind: "task_workspace", version: 3, workspaceId: current.workspace.id, allocationId: current.owner.id,
          allocationIds: current.allocations.map((row) => row.id), serviceIds: current.services.map((row) => row.id), leaseIds: current.leases.map((row) => row.id),
          workspaceFingerprint: hash(ownership(nextWorkspace)), filesystem: current.filesystem, providers: current.providers });
        await tx.insert(runtimeServiceDataDeletions).values({ id, companyId, allocationId: current.owner.id, serviceId, requestedByUserId: authorization.kind === "operator" ? actor.id : null, authorization, target, createdAt: options.now(), updatedAt: options.now() });
        await tx.update(executionWorkspaces).set({ status: "archived", metadata, closedAt: options.now(), cleanupEligibleAt: null, cleanupReason: "runtime_service_data_deletion", updatedAt: options.now() }).where(eq(executionWorkspaces.id, target.workspaceId));
        await tx.update(runtimeServiceAllocations).set({ dataDeletionId: id, updatedAt: options.now() }).where(inArray(runtimeServiceAllocations.id, target.allocationIds));
        if (target.leaseIds.length) await tx.update(environmentLeases).set({ metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ runtimeServiceDataDeletionId: id })}::jsonb`, updatedAt: options.now() }).where(inArray(environmentLeases.id, target.leaseIds));
        for (const service of current.services) {
          await options.clearEnvironment?.(tx, service);
          await tx.update(runtimeServices).set({ state: "deleted", desiredState: "deleted", stopReason: "data_deletion", error: null, endpoints: [], spec: { ...service.spec, env: {} },
            revision: service.revision + 1, updatedAt: options.now() }).where(eq(runtimeServices.id, service.id));
        }
      }
      await event(tx, companyId, serviceId, actor, "data_deletion_requested", { allocationId: current.owner.id, workspaceId: current.workspace.id, deletionId: id, inputHash, authorization }, requestKey);
    });
    return (await inspect(db, companyId, serviceId)).plan;
  }
  async function reconcile(companyId: string, id: string) {
    const job = await claimRuntimeServiceDataDeletion(db, companyId, id, options.now);
    if (!job) return;
    try {
      const target = targetSchema.parse(job.target);
      const assertAuthorized = async (tx: Transaction) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`execution_workspace_lifecycle:${target.workspaceId}`}, 0))`);
        if (target.version === 3) for (const provider of target.providers) await lockRuntimeServiceLease(tx, { id: provider.leaseIds[0]!, companyId, provider: provider.provider, providerLeaseId: provider.providerLeaseId });
        const current = await inspect(tx, companyId, job.serviceId);
        if (current.plan.blockers.length || current.workspace.id !== target.workspaceId || hash(ownership(current.workspace)) !== target.workspaceFingerprint ||
          hash(current.allocations.map((row) => row.id)) !== hash(target.allocationIds) || current.allocations.some((row) => row.dataDeletionId !== id) ||
          hash(current.services.map((row) => row.id)) !== hash(target.serviceIds) || hash(current.leases.map((row) => row.id)) !== hash(target.leaseIds) ||
          current.leases.some((row) => row.metadata?.runtimeServiceDataDeletionId !== id)) throw conflict("The task workspace deletion ownership or dependencies changed");
        return current;
      };
      if (target.version === 3) for (const provider of target.providers) {
        const current = await withRuntimeServiceDataDeletionClaim(db, job, options.now, assertAuthorized);
        if (taskProviderDeletionConfirmed(provider, current.leases, id)) continue;
        if (!options.executor) throw new Error("Task provider data deletion is unavailable");
        await options.executor.removeTaskProvider(companyId, id, provider);
        // Persist each exact receipt in a short, still-owned checkpoint. An old
        // attempt cannot overwrite a newer attempt after its claim expires.
        await withRuntimeServiceDataDeletionClaim(db, job, options.now, async (checkpoint) => {
          await assertAuthorized(checkpoint);
          await checkpoint.update(environmentLeases).set({ metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ runtimeServiceTaskDataDeleted: {
            version: 1, state: "destroyed", deletionId: id, providerLeaseId: provider.providerLeaseId, targetHash: taskDataIdentityHash(provider), confirmedAt: options.now().toISOString(),
          } })}::jsonb`, updatedAt: options.now() }).where(and(eq(environmentLeases.companyId, companyId), inArray(environmentLeases.id, provider.leaseIds), sql`${environmentLeases.metadata}->>'runtimeServiceDataDeletionId' = ${id}`));
          await checkpoint.update(runtimeServiceDataDeletions).set({ updatedAt: updatedAt() }).where(eq(runtimeServiceDataDeletions.id, id));
        });
      }
      await withRuntimeServiceDataDeletionClaim(db, job, options.now, async (tx) => {
        const confirmed = await assertAuthorized(tx);
        if (target.version === 3 && target.providers.some((provider) => !taskProviderDeletionConfirmed(provider, confirmed.leases, id))) throw conflict("A remote sandbox deletion has not been durably confirmed");
        if (!job.providerDeletedAt) await tx.update(runtimeServiceDataDeletions).set({ providerDeletedAt: options.now(), updatedAt: updatedAt() }).where(eq(runtimeServiceDataDeletions.id, id));
      });
      await removeTaskWorkspaceData({ companyId, workspaceId: target.workspaceId, deletionId: id, target: target.filesystem,
        assertAuthorized: async () => { await withRuntimeServiceDataDeletionClaim(db, job, options.now, assertAuthorized); } });
      await withRuntimeServiceDataDeletionClaim(db, job, options.now, async (finish) => {
        await assertAuthorized(finish);
        await finish.update(runtimeServiceAllocations).set({ metadata: sql`${runtimeServiceAllocations.metadata} || ${JSON.stringify({ retentionReleased: true, retentionError: null, computeState: "stopped" })}::jsonb`, updatedAt: options.now() }).where(and(eq(runtimeServiceAllocations.companyId, companyId), eq(runtimeServiceAllocations.dataDeletionId, id)));
        if (target.leaseIds.length) await finish.update(environmentLeases).set({ status: "expired", releasedAt: options.now(), cleanupStatus: "success", updatedAt: options.now() }).where(inArray(environmentLeases.id, target.leaseIds));
        await finish.update(executionWorkspaces).set({ cleanupReason: "runtime_service_data_deleted", updatedAt: options.now() }).where(eq(executionWorkspaces.id, target.workspaceId));
        await finish.update(runtimeServiceDataDeletions).set({ state: "deleted", retryAt: null, error: null, completedAt: options.now(), updatedAt: updatedAt() }).where(eq(runtimeServiceDataDeletions.id, id));
        await event(finish, companyId, job.serviceId, { type: "system", id: "runtime-services" }, "data_deleted", { allocationId: target.allocationId, workspaceId: target.workspaceId, deletionId: id });
      });
    } catch (error) {
      const detail = error instanceof HttpError && error.status === 409 ? `${failure} ${error.message}` : failure;
      await db.transaction(async (failed) => {
        const [updated] = await failed.update(runtimeServiceDataDeletions).set({ state: "failed", error: detail, retryAt: job.attempts < 5 ? new Date(options.now().getTime() + Math.min(300_000, 5000 * 2 ** (job.attempts - 1))) : null, updatedAt: updatedAt() })
          .where(and(eq(runtimeServiceDataDeletions.id, id), eq(runtimeServiceDataDeletions.companyId, companyId),
            eq(runtimeServiceDataDeletions.state, "deleting"), eq(runtimeServiceDataDeletions.attempts, job.attempts))).returning();
        if (updated) await event(failed, companyId, job.serviceId, { type: "system", id: "runtime-services" }, "data_deletion_failed", { allocationId: job.allocationId, deletionId: id });
      });
    }
  }

  return { expiration: async (companyId: string, serviceId: string) => { const current = await inspect(db, companyId, serviceId); return { current, expiration: await readRuntimeServiceDataExpiration(db, companyId, current, options.now()) }; },
    requestExpired: (companyId: string, serviceId: string, input: DeleteRuntimeServiceData, revision: number) => request(companyId, serviceId, { type: "system", id: "runtime-service-retention" }, input, revision),
    supports: async (companyId: string, serviceId: string) => { const row = await selected(db, companyId, serviceId); return ["local", "daytona"].includes(row.provider) && !!row.executionWorkspaceId && !row.metadata.allocationRequest; },
    review: async (companyId: string, serviceId: string) => (await inspect(db, companyId, serviceId)).plan, request: (companyId: string, serviceId: string, actor: RuntimeServiceActor, input: DeleteRuntimeServiceData) => request(companyId, serviceId, actor, input), reconcile };
}
