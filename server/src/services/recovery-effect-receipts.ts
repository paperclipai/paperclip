import { and, eq, sql, ne, or, inArray } from "drizzle-orm";
import { heartbeatRuns, toolInvocations, type Db } from "@paperclipai/db";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { recoveryRunAncestry } from "./recovery-run-ancestry.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Generic upstream tools have no common authoritative result-query protocol.
 * Preserve their uncertain mutation fence across recovery. Exact publication
 * protocols can reconcile through their existing owner instead. No transcript
 * assertion or new call/idempotency key clears an old uncertain operation. */
export async function unresolvedRecoveryToolInvocation(db: Db, input: {
  companyId: string; issueId: string; runId: string; connectionId: string;
  toolName: string; risk: string;
}): Promise<string | null> {
  if (input.risk === "read") return null;
  const ancestry = await recoveryRunAncestry({ db, companyId: input.companyId,
    issueId: input.issueId, sourceRunIds: [input.runId] });
  if (!ancestry.some(source => source.id !== input.runId)) return null;
  const [prior] = await db.select({ id: toolInvocations.id }).from(toolInvocations)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, toolInvocations.runId),
      eq(heartbeatRuns.companyId, input.companyId)))
    .where(and(eq(toolInvocations.companyId, input.companyId), eq(toolInvocations.issueId, input.issueId),
      eq(toolInvocations.connectionId, input.connectionId), eq(toolInvocations.toolName, input.toolName),
      ne(toolInvocations.runId, input.runId),
      sql`${toolInvocations.riskLevel} is distinct from 'read'`,
      inArray(toolInvocations.status, ["executing", "failed", "timed_out"]),
      sql`${toolInvocations.startedAt} is not null`,
      sql`${heartbeatRuns.createdAt} < (select created_at from heartbeat_runs
        where id = ${input.runId} and company_id = ${input.companyId})`,
    )).limit(1);
  return prior?.id ?? null;
}

/** Keep the mutation fence across provider/session replacement. Read operations
 * and unrelated operations remain available for authoritative reconciliation. */
export async function priorRecoveryApiReceipt(db: Db, input: {
  companyId: string; issueId: string; runId: string; operationId: string; digest: string;
}): Promise<Record<string, unknown> | null> {
  // Start at the current run so persisted automatic retry edges inherit the
  // same protection as a deliberate Retry or explicit continuation receipt.
  const ancestry = new Set((await recoveryRunAncestry({ db, companyId: input.companyId,
    issueId: input.issueId, sourceRunIds: [input.runId] }))
    .map(source => source.id).filter(id => id !== input.runId));
  if (!ancestry.size) return null;
  const sources = await db.select({ id: heartbeatRuns.id, result: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId),
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text,
      ${heartbeatRuns.contextSnapshot}->>'issueId') = ${input.issueId}`,
    ne(heartbeatRuns.id, input.runId),
    or(inArray(heartbeatRuns.id, [...ancestry]),
      sql`${heartbeatRuns.createdAt} < (select created_at from heartbeat_runs where id = ${input.runId})`)));
  let completed: Record<string, unknown> | null = null;
  for (const source of sources) {
    for (const receipt of Object.values(record(source.result?.apiToolReceipts)).map(record)) {
      if (receipt.operationId !== input.operationId) continue;
      const result = receipt.encryptedResult
        ? record(JSON.parse(await getSecretProvider("local_encrypted").resolveVersion({ material: record(receipt.encryptedResult), externalRef: null })))
        : record(receipt.result);
      if (receipt.state !== "completed" || result.outcome === "unknown" || result.error === "api_outcome_unknown") {
        return { state: "pending", result: { ok: false, status: null, error: "api_outcome_unknown",
          outcome: "unknown", guidance: "Reconcile the existing operation before repeating it. Independent work and reads remain available." } };
      }
      // A completed HTTP request is not necessarily a completed effect. A
      // definite client rejection may be retried after the user fixes its cause.
      // Preserve the transport owner's uncertainty classification above.
      if (result.ok === false && typeof result.status === "number" &&
          result.status >= 400 && result.status < 500 && result.status !== 408) continue;
      if (result.ok !== true) return { state: "pending", result: { ok: false, status: null,
        error: "api_outcome_unknown", outcome: "unknown",
        guidance: "Reconcile the existing operation before repeating it. Independent work and reads remain available." } };
      // Successful effects belong to their original intent, not every later
      // request on this task. Uncertain effects above retain their wider fence.
      if (ancestry.has(source.id) && receipt.digest === input.digest) completed = receipt;
    }
  }
  return completed;
}
