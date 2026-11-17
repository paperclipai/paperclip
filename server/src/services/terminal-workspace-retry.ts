import { and, eq, sql } from "drizzle-orm";
import { executionWorkspaces, type Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { findWorkspaceProviderFailure } from "./workspace-provider-failure.js";
import { TERMINAL_WORKSPACE_RETRY_MS } from "./terminal-workspace-work.js";

export const TERMINAL_WORKSPACE_RETRY_KEY = "terminalCleanupRetry";
export const TERMINAL_WORKSPACE_RETRY_MAX_MS = 4 * 60 * 60 * 1000;

export type TerminalWorkspaceFailure = { kind: string | null; reason: string | null; message: string };
export type TerminalWorkspaceRetry = {
  generation: number;
  failures: number;
  failedAt: string;
  retryAt: string;
  failure: TerminalWorkspaceFailure;
};

export function terminalWorkspaceFailure(error: unknown): TerminalWorkspaceFailure {
  const provider = findWorkspaceProviderFailure(error);
  const message = error instanceof HttpError ? error.message : "Workspace storage operation failed";
  return { kind: provider?.kind ?? null, reason: provider?.reason ?? null, message: message.slice(0, 500) };
}

export function terminalWorkspaceRetryDelayMs(failures: number) {
  return Math.min(TERMINAL_WORKSPACE_RETRY_MS * 2 ** Math.min(Math.max(failures - 1, 0), 16), TERMINAL_WORKSPACE_RETRY_MAX_MS);
}

export function readTerminalWorkspaceRetry(metadata: Record<string, unknown> | null | undefined, generation: number) {
  const retry = metadata?.[TERMINAL_WORKSPACE_RETRY_KEY] as Partial<TerminalWorkspaceRetry> | undefined;
  return retry && typeof retry === "object" && retry.generation === generation && Number.isInteger(retry.failures)
    && typeof retry.failedAt === "string" && typeof retry.retryAt === "string" ? retry as TerminalWorkspaceRetry : null;
}

export async function recordTerminalWorkspaceFailure(db: Db, workspace: { id: string; metadata: Record<string, unknown> | null },
  generation: number, failure: TerminalWorkspaceFailure, now: Date): Promise<TerminalWorkspaceRetry> {
  const failures = (readTerminalWorkspaceRetry(workspace.metadata, generation)?.failures ?? 0) + 1;
  const retry = { generation, failures, failedAt: now.toISOString(),
    retryAt: new Date(now.getTime() + terminalWorkspaceRetryDelayMs(failures)).toISOString(), failure };
  await db.update(executionWorkspaces)
    .set({ metadata: sql`coalesce(${executionWorkspaces.metadata}, '{}'::jsonb) || jsonb_build_object(${TERMINAL_WORKSPACE_RETRY_KEY}::text, ${JSON.stringify(retry)}::jsonb)` })
    .where(eq(executionWorkspaces.id, workspace.id));
  return retry;
}

export async function clearTerminalWorkspaceRetry(db: Db, workspaceId: string) {
  await db.update(executionWorkspaces)
    .set({ metadata: sql`${executionWorkspaces.metadata} - ${TERMINAL_WORKSPACE_RETRY_KEY}::text` })
    .where(and(eq(executionWorkspaces.id, workspaceId), sql`${executionWorkspaces.metadata} -> ${TERMINAL_WORKSPACE_RETRY_KEY}::text IS NOT NULL`));
}

// A provider workspace that a sweep inspected and kept. `local_data` holds until
// the workspace or its task tree changes; `unmerged` re-checks on a growing
// interval because the remote can change without touching the workspace.
export const TERMINAL_WORKSPACE_HOLD_KEY = "terminalInspectionHold";
export const TERMINAL_WORKSPACE_RECHECK_MS = 60 * 60 * 1000;
export const TERMINAL_WORKSPACE_RECHECK_MAX_MS = 24 * 60 * 60 * 1000;

export type TerminalWorkspaceHold = {
  generation: number;
  fingerprint: string;
  reason: "local_data" | "unmerged";
  headSha: string | null;
  checks: number;
  checkedAt: string;
  recheckAt: string | null;
};

export function terminalWorkspaceRecheckDelayMs(checks: number) {
  return Math.min(TERMINAL_WORKSPACE_RECHECK_MS * 2 ** Math.min(Math.max(checks - 1, 0), 16), TERMINAL_WORKSPACE_RECHECK_MAX_MS);
}

export function readTerminalWorkspaceHold(metadata: Record<string, unknown> | null | undefined, generation: number) {
  const hold = metadata?.[TERMINAL_WORKSPACE_HOLD_KEY] as Partial<TerminalWorkspaceHold> | undefined;
  return hold && typeof hold === "object" && hold.generation === generation && typeof hold.fingerprint === "string"
    && (hold.reason === "local_data" || hold.reason === "unmerged") && Number.isInteger(hold.checks)
    && typeof hold.checkedAt === "string" && (hold.recheckAt === null || typeof hold.recheckAt === "string")
    ? hold as TerminalWorkspaceHold : null;
}

/** Records the hold only while the workspace is still in the inspected lifecycle generation. */
export async function recordTerminalWorkspaceHold(db: Db, workspaceId: string, hold: TerminalWorkspaceHold) {
  await db.update(executionWorkspaces)
    .set({ metadata: sql`coalesce(${executionWorkspaces.metadata}, '{}'::jsonb) || jsonb_build_object(${TERMINAL_WORKSPACE_HOLD_KEY}::text, ${JSON.stringify(hold)}::jsonb)` })
    .where(and(eq(executionWorkspaces.id, workspaceId),
      sql`coalesce((${executionWorkspaces.metadata}->>'lifecycleGeneration')::int, 0) = ${hold.generation}`));
}

export async function clearTerminalWorkspaceHold(db: Db, workspaceId: string) {
  await db.update(executionWorkspaces)
    .set({ metadata: sql`${executionWorkspaces.metadata} - ${TERMINAL_WORKSPACE_HOLD_KEY}::text` })
    .where(and(eq(executionWorkspaces.id, workspaceId), sql`${executionWorkspaces.metadata} -> ${TERMINAL_WORKSPACE_HOLD_KEY}::text IS NOT NULL`));
}
