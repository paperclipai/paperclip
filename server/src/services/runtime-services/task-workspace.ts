import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { environmentLeases, executionWorkspaces, heartbeatRuns, issues, runtimeServiceAllocations, runtimeServices, runtimeServiceTaskWorkspaces, type Db } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../../errors.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { lockRuntimeServiceLease } from "./retention.js";

type Reader = Pick<Db, "select">;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

type IssueRow = typeof issues.$inferSelect;
const previousTaskWorkspaceSchema = z.object({
  version: z.literal(1), issueId: z.string().guid(), projectId: z.string().guid().nullable(),
  executionWorkspaceId: z.string().guid().nullable(), executionWorkspacePreference: z.string().nullable(),
  executionWorkspaceSettings: z.record(z.string(), z.unknown()).nullable(),
}).strict();

function usesAttachedSelection(issue: IssueRow) {
  return issue.executionWorkspaceId === null && issue.executionWorkspacePreference === "agent_default" && issue.executionWorkspaceSettings?.mode === "agent_default";
}

async function assertTaskIdle(tx: Transaction, issue: IssueRow) {
  const [active] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, issue.companyId),
    inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]), or(
      eq(heartbeatRuns.nativeIssueId, issue.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`,
      sql`${heartbeatRuns.contextSnapshot}->>'taskId' = ${issue.id}`,
      issue.executionRunId ? eq(heartbeatRuns.id, issue.executionRunId) : undefined,
      issue.checkoutRunId ? eq(heartbeatRuns.id, issue.checkoutRunId) : undefined,
    ))).limit(1);
  if (active) throw conflict("Wait for this task's active run to finish before changing its service workspace attachment");
}

async function assertLeaseIdle(tx: Transaction, lease: typeof environmentLeases.$inferSelect) {
  const [writer] = await tx.select({ id: heartbeatRuns.id }).from(environmentLeases)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, environmentLeases.heartbeatRunId), eq(heartbeatRuns.companyId, environmentLeases.companyId)))
    .where(and(eq(environmentLeases.companyId, lease.companyId), eq(environmentLeases.provider, "daytona"),
      eq(environmentLeases.providerLeaseId, lease.providerLeaseId!), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]))).limit(1);
  if (writer) throw conflict("Another active run is using these service files; wait for it to finish before changing the attachment");
}


export async function runtimeServiceTaskWorkspace(db: Reader, companyId: string, issueId: string) {
  const [result] = await db.select({ binding: runtimeServiceTaskWorkspaces, allocation: runtimeServiceAllocations, lease: environmentLeases })
    .from(runtimeServiceTaskWorkspaces)
    .innerJoin(runtimeServiceAllocations, and(eq(runtimeServiceAllocations.id, runtimeServiceTaskWorkspaces.allocationId), eq(runtimeServiceAllocations.companyId, runtimeServiceTaskWorkspaces.companyId)))
    .innerJoin(environmentLeases, and(eq(environmentLeases.id, runtimeServiceAllocations.environmentLeaseId), eq(environmentLeases.companyId, runtimeServiceAllocations.companyId)))
    .where(and(eq(runtimeServiceTaskWorkspaces.companyId, companyId), eq(runtimeServiceTaskWorkspaces.issueId, issueId)));
  if (result && (result.allocation.dataDeletionId || result.allocation.metadata.retentionReleased === true || !result.lease.providerLeaseId || !result.lease.environmentId)) {
    throw conflict("This task's service workspace is unavailable. Recover its retained files before continuing.");
  }
  return result ?? null;
}

/** The operator names a task, never an arbitrary host directory. */
export async function attachRuntimeServiceTaskWorkspace(tx: Transaction, input: {
  companyId: string; service: typeof runtimeServices.$inferSelect; issueId: string; actorId: string;
}) {
  const { companyId, service, issueId } = input;
  const [issue] = await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).for("update");
  if (!issue) throw notFound("Task not found");
  const [allocation] = await tx.select().from(runtimeServiceAllocations).where(and(eq(runtimeServiceAllocations.id, service.allocationId), eq(runtimeServiceAllocations.companyId, companyId)));
  const [lease] = allocation?.environmentLeaseId ? await tx.select().from(environmentLeases).where(and(eq(environmentLeases.id, allocation.environmentLeaseId), eq(environmentLeases.companyId, companyId))) : [];
  if (!allocation || allocation.dataDeletionId || allocation.provider !== "daytona" || allocation.executionWorkspaceId || !allocation.metadata.allocationRequest ||
      !allocation.metadata.provisionedAt || allocation.metadata.provisioningError || allocation.metadata.retentionReleased === true ||
      !lease?.providerLeaseId || !lease.environmentId || lease.expiresAt || !path.posix.isAbsolute(String(lease.metadata?.remoteCwd ?? ""))) {
    throw unprocessable("Only a provisioned independent Daytona service can supply a task's workspace");
  }
  await lockRuntimeServiceLease(tx, lease);
  // Compute/retention reconciliation holds the physical lease lock before it
  // writes allocation metadata. Recheck after that lock without reversing its
  // row-lock order while waiting for an in-flight provider operation.
  const [current] = await tx.select().from(runtimeServiceAllocations).where(eq(runtimeServiceAllocations.id, allocation.id));
  if (!current || current.dataDeletionId || current.environmentLeaseId !== lease.id || current.metadata.retentionReleased === true || current.metadata.provisioningError) {
    throw conflict("The retained allocation changed while attaching; refresh and retry");
  }
  const bindings = await tx.select().from(runtimeServiceTaskWorkspaces).where(and(eq(runtimeServiceTaskWorkspaces.companyId, companyId),
    or(eq(runtimeServiceTaskWorkspaces.issueId, issueId), eq(runtimeServiceTaskWorkspaces.allocationId, allocation.id))));
  if (bindings.some((binding) => (binding.issueId !== null && binding.issueId !== issueId) || binding.allocationId !== allocation.id)) {
    throw conflict("The task or service already has another workspace attachment");
  }
  const existing = bindings[0];
  // A second accepted association with this same source must not replace the
  // saved pre-attachment selection with our own temporary selection.
  if (existing?.issueId === issueId) return;
  await assertTaskIdle(tx, issue);
  await assertLeaseIdle(tx, lease);
  const hostCwd = path.join(resolvePaperclipInstanceRoot(), "runtime-services-v2", "workspaces", companyId, allocation.id);
  const previousTaskWorkspace = previousTaskWorkspaceSchema.parse({ version: 1, issueId, projectId: issue.projectId,
    executionWorkspaceId: issue.executionWorkspaceId, executionWorkspacePreference: issue.executionWorkspacePreference,
    executionWorkspaceSettings: issue.executionWorkspaceSettings });
  if (existing) await tx.update(runtimeServiceTaskWorkspaces).set({ issueId, previousTaskWorkspace }).where(eq(runtimeServiceTaskWorkspaces.id, existing.id));
  else await tx.insert(runtimeServiceTaskWorkspaces).values({ companyId, allocationId: allocation.id, issueId, hostCwd, previousTaskWorkspace, createdByUserId: input.actorId });
  // Existing checkout files remain where they are. Subsequent runs resolve the
  // explicit allocation binding instead of restoring that checkout over it.
  await tx.update(issues).set({ executionWorkspaceId: null, executionWorkspacePreference: "agent_default",
    executionWorkspaceSettings: { ...(issue.executionWorkspaceSettings ?? {}), mode: "agent_default" }, updatedAt: new Date(),
  }).where(eq(issues.id, issueId));
}

/** Restore only the workspace selection we changed. Newer operator choices
 * and unrelated settings (for example network egress) always survive. */
export async function detachRuntimeServiceTaskWorkspace(tx: Transaction, input: {
  companyId: string; service: typeof runtimeServices.$inferSelect; issueId: string;
}) {
  const [issue] = await tx.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))).for("update");
  if (!issue) throw notFound("Task not found");
  const [binding] = await tx.select().from(runtimeServiceTaskWorkspaces).where(and(eq(runtimeServiceTaskWorkspaces.companyId, input.companyId),
    eq(runtimeServiceTaskWorkspaces.allocationId, input.service.allocationId), eq(runtimeServiceTaskWorkspaces.issueId, input.issueId)));
  if (!binding) throw conflict("This service workspace is no longer attached to the selected task");
  const [allocation] = await tx.select().from(runtimeServiceAllocations).where(and(eq(runtimeServiceAllocations.id, binding.allocationId), eq(runtimeServiceAllocations.companyId, input.companyId)));
  const [lease] = allocation?.environmentLeaseId ? await tx.select().from(environmentLeases).where(and(eq(environmentLeases.id, allocation.environmentLeaseId), eq(environmentLeases.companyId, input.companyId))) : [];
  if (!lease?.providerLeaseId) throw conflict("Recover the service allocation identity before detaching its workspace");
  await lockRuntimeServiceLease(tx, lease);
  await assertTaskIdle(tx, issue);
  await assertLeaseIdle(tx, lease);
  const previous = previousTaskWorkspaceSchema.safeParse(binding.previousTaskWorkspace);
  if (usesAttachedSelection(issue)) {
    if (!previous.success || previous.data.issueId !== issue.id) {
      throw conflict("This older attachment has no saved workspace selection. Choose a workspace in the task before detaching.");
    }
    if (previous.data.projectId === issue.projectId) {
      if (previous.data.executionWorkspaceId) {
        const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, previous.data.executionWorkspaceId), eq(executionWorkspaces.companyId, input.companyId)));
        if (!workspace || workspace.projectId !== issue.projectId || workspace.status === "archived" || workspace.status === "failed") {
          throw conflict("The previous task workspace is unavailable. Choose a workspace in the task before detaching.");
        }
      }
      const settings = { ...(issue.executionWorkspaceSettings ?? {}) };
      if (previous.data.executionWorkspaceSettings && "mode" in previous.data.executionWorkspaceSettings) settings.mode = previous.data.executionWorkspaceSettings.mode;
      else delete settings.mode;
      await tx.update(issues).set({ executionWorkspaceId: previous.data.executionWorkspaceId,
        executionWorkspacePreference: previous.data.executionWorkspacePreference,
        executionWorkspaceSettings: Object.keys(settings).length || previous.data.executionWorkspaceSettings !== null ? settings : null,
        updatedAt: new Date(),
      }).where(eq(issues.id, issue.id));
    }
  }
  // Keep the workspace identity and mirror: provider and sync receipts name
  // this row, and must remain valid when another task attaches later.
  await tx.update(runtimeServiceTaskWorkspaces).set({ issueId: null, previousTaskWorkspace: null }).where(eq(runtimeServiceTaskWorkspaces.id, binding.id));
}

export async function materializeRuntimeServiceTaskMirror(binding: { hostCwd: string }) {
  await fs.mkdir(binding.hostCwd, { recursive: true, mode: 0o700 });
  const actual = await fs.realpath(binding.hostCwd);
  const root = await fs.realpath(resolvePaperclipInstanceRoot());
  const relative = path.relative(root, actual);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || (await fs.lstat(binding.hostCwd)).isSymbolicLink()) {
    throw conflict("The service's host mirror has moved outside its instance workspace");
  }
  return actual;
}

export async function assertRuntimeServiceTaskRun(db: Reader, input: {
  companyId: string; issueId: string | null; runId: string; agentId: string; bindingId: string; allocationId: string;
}) {
  const current = input.issueId ? await runtimeServiceTaskWorkspace(db, input.companyId, input.issueId) : null;
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId), inArray(heartbeatRuns.status, ["queued", "running"])));
  const [issue] = input.issueId ? await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))) : [];
  if (!current || current.binding.id !== input.bindingId || current.allocation.id !== input.allocationId || !run || issue?.assigneeAgentId !== input.agentId ||
      run.contextSnapshot?.runtimeServiceTaskWorkspaceId !== input.bindingId ||
      (run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId) !== input.issueId) {
    throw conflict("The run is no longer authorized to use this service workspace");
  }
}
