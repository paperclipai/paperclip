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
