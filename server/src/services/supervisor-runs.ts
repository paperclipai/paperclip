import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";

export const SUPERVISOR_RUN_TTL_MS = 5 * 60 * 1000;
export const SUPERVISOR_RUN_TYPE = "supervisor";

export interface CreateSupervisorRunInput {
  companyId: string;
  agentId: string;
  issueId: string;
  motif?: string | null;
  source?: string | null;
}

export interface SupervisorRunResult {
  runId: string;
  expiresAt: string;
  issueId: string;
}

export async function createSupervisorRun(
  db: Db,
  input: CreateSupervisorRunInput,
): Promise<SupervisorRunResult> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SUPERVISOR_RUN_TTL_MS);

  const run = await db
    .insert(heartbeatRuns)
    .values({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "on_demand",
      triggerDetail: "supervisor",
      status: "running",
      startedAt: now,
      issueCommentStatus: "not_applicable",
      contextSnapshot: {
        type: SUPERVISOR_RUN_TYPE,
        issueId: input.issueId,
        source: input.source ?? null,
        motif: input.motif ?? null,
        expiresAt: expiresAt.toISOString(),
      },
      updatedAt: now,
    })
    .returning({ id: heartbeatRuns.id })
    .then((rows) => rows[0]);

  return {
    runId: run.id,
    expiresAt: expiresAt.toISOString(),
    issueId: input.issueId,
  };
}

export interface SupervisorRunScopeError {
  error: string;
  code: "supervisor_run_scope_mismatch" | "supervisor_run_expired" | "supervisor_run_not_found";
}

export async function validateSupervisorRunScope(
  db: Db,
  runId: string,
  issueId: string,
  companyId: string,
): Promise<SupervisorRunScopeError | null> {
  const run = await db
    .select({
      agentId: heartbeatRuns.agentId,
      companyId: heartbeatRuns.companyId,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);

  if (!run) return null;
  if (run.companyId !== companyId) return null;

  const ctx = run.contextSnapshot as Record<string, unknown> | null;
  if (!ctx || ctx.type !== SUPERVISOR_RUN_TYPE) return null;

  if (ctx.issueId !== issueId) {
    return {
      error: "Supervisor run is scoped to a different issue",
      code: "supervisor_run_scope_mismatch",
    };
  }

  const expiresAt = typeof ctx.expiresAt === "string" ? new Date(ctx.expiresAt) : null;
  if (!expiresAt || expiresAt.getTime() < Date.now()) {
    return {
      error: "Supervisor run has expired (TTL: 5 minutes)",
      code: "supervisor_run_expired",
    };
  }

  return null;
}

export function isSupervisorRunContext(contextSnapshot: unknown): boolean {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) {
    return false;
  }
  return (contextSnapshot as Record<string, unknown>).type === SUPERVISOR_RUN_TYPE;
}
