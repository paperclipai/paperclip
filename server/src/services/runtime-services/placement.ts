import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import type { CreateRuntimeService } from "@paperclipai/shared";
import type { Request } from "express";
import { forbidden, notFound, unprocessable } from "../../errors.js";
import type { RuntimeServicePlacement } from "./manager.js";
import { withTaskWorkspaceDataAdmission } from "./workspace-data-fence.js";

export const runtimeServiceExecutionBoundarySchema = z.object({
  version: z.literal(1),
  provider: z.enum(["local", "daytona", "unsupported"]),
  workspaceRoot: z.string().min(1),
  executionWorkspaceId: z.string().guid().nullable(),
  network: z.enum(["enabled", "disabled", "allowlist"]),
}).strict();

/** Trusted adapter invocation metadata, never an agent-supplied HTTP/event payload.
 * Local adapters may replace the fallback agent home with an operator-configured
 * cwd. Bind that actual launch directory before spawning the agent process.
 * Remote boundaries remain owned by environment realization.
 */
export async function bindRuntimeServiceInvocationDirectory(db: Db, input: {
  companyId: string; runId: string; environmentLeaseId: string; cwd?: string;
}) {
  if (!input.cwd) return;
  const where = and(eq(environmentLeases.id, input.environmentLeaseId), eq(environmentLeases.companyId, input.companyId),
    eq(environmentLeases.heartbeatRunId, input.runId), eq(environmentLeases.status, "active"));
  const [lease] = await db.select({ metadata: environmentLeases.metadata }).from(environmentLeases).where(where);
  const boundary = runtimeServiceExecutionBoundarySchema.safeParse(lease?.metadata?.runtimeServiceBoundary);
  if (!boundary.success || boundary.data.provider !== "local") return;
  if (!path.isAbsolute(input.cwd)) throw unprocessable("The adapter's service working directory must be absolute");
  await withTaskWorkspaceDataAdmission(db, input.companyId, boundary.data.executionWorkspaceId, async () => {
    const root = await fs.realpath(input.cwd!).catch(() => { throw unprocessable("The adapter's service workspace is unavailable"); });
    await db.update(environmentLeases).set({
      metadata: sql`jsonb_set(${environmentLeases.metadata}, '{runtimeServiceBoundary,workspaceRoot}', to_jsonb(${root}::text))`, updatedAt: new Date(),
    }).where(where);
  }, input.cwd);
}

/** Resolve execution from server-stamped lease metadata, never caller provenance. */
export function createRuntimeServicePlacementResolver(db: Db, options: {
  allowLocal: boolean;
  allocate?: (companyId: string, input: CreateRuntimeService, actorId: string) => Promise<RuntimeServicePlacement>;
}) {
  return async (req: Request, companyId: string, input: CreateRuntimeService): Promise<RuntimeServicePlacement> => {
    const [task] = input.issueId ? await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, companyId))) : [];
    if (input.issueId && !task) throw notFound("Task not found");
    const [workspace] = task?.executionWorkspaceId ? await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, task.executionWorkspaceId), eq(executionWorkspaces.companyId, companyId))) : [];
    const runId = req.actor.type === "agent" ? req.actor.runId : null;
    if (req.actor.type === "agent") {
      if (!runId) throw forbidden("Starting a service requires an authenticated active run");
      const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, req.actor.agentId!), eq(heartbeatRuns.status, "running")));
      if (!run) throw forbidden("Starting a service requires an authenticated active run");
    }
    const leases = runId || workspace ? await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, companyId),
      runId ? eq(environmentLeases.heartbeatRunId, runId) : eq(environmentLeases.executionWorkspaceId, workspace!.id),
      inArray(environmentLeases.status, runId ? ["active"] : ["active", "retained", "released"]),
      input.environmentId ? eq(environmentLeases.environmentId, input.environmentId) : undefined,
    )).orderBy(desc(environmentLeases.createdAt)) : [];
    const lease = leases.find((row) => runtimeServiceExecutionBoundarySchema.safeParse(row.metadata?.runtimeServiceBoundary).success);
    if (req.actor.type === "agent" && !lease) throw unprocessable("This run has not established a service execution boundary. Retry after its workspace is ready.");
    const boundary = lease ? runtimeServiceExecutionBoundarySchema.parse(lease.metadata!.runtimeServiceBoundary) : null;
    if (boundary && boundary.provider === "unsupported") throw unprocessable("This execution provider does not support managed services yet");
    if (boundary?.network === "allowlist") throw unprocessable("This run requires a network allowlist that the service launcher cannot yet preserve");
    if (boundary && input.environmentId && lease!.environmentId !== input.environmentId) throw forbidden("The service environment must match the authorized execution allocation");
    if (boundary && lease!.expiresAt) throw unprocessable("This allocation has a fixed provider expiry. Create a service allocation with an independent lifetime before retaining it.");
    if (boundary?.provider === "daytona") {
      const root = path.posix.resolve(boundary.workspaceRoot);
      const cwd = input.cwd ? path.posix.resolve(root, input.cwd) : root;
      const relative = path.posix.relative(root, cwd);
      if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) throw forbidden("The service directory is outside its authorized workspace");
      if (lease!.provider !== "daytona" || !lease!.metadata?.sandboxProviderPlugin || !lease!.providerLeaseId) throw unprocessable("The recorded Daytona allocation is unavailable");
      const boundaryKey = createHash("sha256").update(JSON.stringify(boundary)).digest("hex");
      return { provider: "daytona", cwd, reuseKey: `daytona:${lease!.providerLeaseId}:${cwd}:${boundaryKey}`, environmentLeaseId: lease!.id, executionWorkspaceId: boundary.executionWorkspaceId, metadata: { executionBoundary: boundary } };
    }
    if (input.environmentId && !lease) {
      const [environment] = await db.select({ driver: environments.driver }).from(environments).where(eq(environments.id, input.environmentId));
      if (!environment) throw notFound("Environment not found");
      if (environment.driver !== "local") {
        if (!options.allocate) throw unprocessable("This instance cannot allocate a service in the selected environment");
        if (workspace) throw unprocessable("The task's existing files must be attached before allocating its service");
        return options.allocate(companyId, input, req.actor.userId ?? "local-board");
      }
    }
    if (!options.allowLocal) throw unprocessable("Local service execution is disabled on this instance");
    if (!boundary && workspace && !["local_fs", "git_worktree"].includes(workspace.providerType)) throw unprocessable("The task's remote workspace has no available service allocation");
    const requestedRoot = boundary?.workspaceRoot ?? workspace?.cwd ?? input.cwd;
    if (!requestedRoot || !path.isAbsolute(requestedRoot)) throw unprocessable("Choose an absolute working directory for the service");
    const root = await fs.realpath(requestedRoot).catch(() => { throw unprocessable("The service workspace is unavailable"); });
    const cwd = await fs.realpath(input.cwd ? path.resolve(root, input.cwd) : root).catch(() => { throw unprocessable("The service working directory is unavailable"); });
    const relative = path.relative(root, cwd);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw forbidden("The service directory is outside its authorized workspace");
    return {
      provider: "local", cwd, reuseKey: `local:${root}:${cwd}:${boundary?.network ?? "enabled"}:${boundary?.executionWorkspaceId ?? workspace?.id ?? ""}`,
      environmentLeaseId: lease?.id, executionWorkspaceId: boundary?.executionWorkspaceId ?? workspace?.id,
      metadata: { localBoundary: { kind: "workspace", workspaceRoot: root, network: boundary?.network ?? "enabled" } },
    };
  };
}
