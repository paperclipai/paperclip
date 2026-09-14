import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { environmentLeases, executionWorkspaces, heartbeatRuns, issues, runtimeServiceAllocations, type Db } from "@paperclipai/db";
import { z } from "zod";
import { conflict } from "../../errors.js";

type Reader = Pick<Db, "select">;

const connectionSchema = z.object({ scopeId: z.string().guid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const workspaceRunScopeSchema = z.object({
  version: z.literal(1),
  companyId: z.string().guid(), environmentId: z.string().guid(), executionWorkspaceId: z.string().guid(),
  pluginId: z.string().guid(), configurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  connection: connectionSchema,
}).strict();
export const runtimeServiceRunScopeSchema = z.discriminatedUnion("version", [workspaceRunScopeSchema, z.object({
  version: z.literal(2), companyId: z.string().guid(), environmentId: z.string().guid(),
  allocationId: z.string().guid(), taskWorkspaceId: z.string().guid(), hostCwd: z.string().min(1),
  pluginId: z.string().guid(), configurationDigest: z.string().regex(/^[a-f0-9]{64}$/), connection: connectionSchema,
}).strict()]);
export type RuntimeServiceRunScope = z.infer<typeof runtimeServiceRunScopeSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function sameRuntimeServiceConfiguration(left: unknown, right: unknown) { return canonical(left) === canonical(right); }

/** Same execution configuration, independent of the agent assigned to the task.
 * Resolved credentials are hashed, never copied into this host-owned receipt. */
export function runtimeServiceRunConfigurationDigest(input: {
  providerConfig: Record<string, unknown>; adapterType: string | null;
  executionWorkspaceMode: string | null; executionWorkspaceSettings: unknown;
  executionPolicy: Record<string, unknown>; pluginVersion: string;
}): string {
  // Heartbeat pins an inherited mode on the issue after the first realization.
  // Compare the already-resolved workspace mode, not that changing preference.
  const settings = input.executionWorkspaceSettings && typeof input.executionWorkspaceSettings === "object"
    ? Object.fromEntries(Object.entries(input.executionWorkspaceSettings).filter(([key]) => key !== "mode")) : {};
  return createHash("sha256").update(canonical({ ...input, executionWorkspaceSettings: settings })).digest("hex");
}

export async function retainedRuntimeServiceWorkspaces(db: Reader, companyId: string, workspaceId: string) {
  return db.select({ allocation: runtimeServiceAllocations, lease: environmentLeases }).from(runtimeServiceAllocations)
    .innerJoin(environmentLeases, and(eq(environmentLeases.id, runtimeServiceAllocations.environmentLeaseId), eq(environmentLeases.companyId, runtimeServiceAllocations.companyId)))
    .where(and(eq(runtimeServiceAllocations.companyId, companyId), eq(runtimeServiceAllocations.executionWorkspaceId, workspaceId),
      sql`coalesce(${runtimeServiceAllocations.metadata}->>'retentionReleased', 'false') <> 'true'`));
}

/** Rechecked under the physical allocation lock before resume and publication.
 * The existing run/task admission remains authoritative; these checks stop a
 * stale or cross-company caller from turning a workspace id into an attachment. */
export async function assertRuntimeServiceRunAttachment(db: Reader, input: {
  companyId: string; runId: string; agentId: string; issueId: string | null; workspaceId: string;
}) {
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId), inArray(heartbeatRuns.status, ["queued", "running"])));
  const [workspace] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, input.workspaceId), eq(executionWorkspaces.companyId, input.companyId)));
  const [issue] = input.issueId ? await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId), eq(issues.executionWorkspaceId, input.workspaceId))) : [];
  if (!run || !workspace || !issue || issue.assigneeAgentId !== input.agentId || run.contextSnapshot?.executionWorkspaceId !== input.workspaceId ||
      (run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId) !== issue.id) {
    throw conflict("The run is no longer authorized to attach this task's retained service workspace");
  }
}

export async function runtimeServiceWorkspaceLeaseHistory(db: Reader, input: { companyId: string; workspaceId: string | null; environmentId: string; providerLeaseId: string }) {
  return db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, input.companyId), input.workspaceId ? eq(environmentLeases.executionWorkspaceId, input.workspaceId) : undefined,
    eq(environmentLeases.environmentId, input.environmentId), eq(environmentLeases.provider, "daytona"), eq(environmentLeases.providerLeaseId, input.providerLeaseId),
    inArray(environmentLeases.status, ["active", "released", "retained"]),
  )).orderBy(desc(environmentLeases.createdAt), desc(environmentLeases.updatedAt));
}
