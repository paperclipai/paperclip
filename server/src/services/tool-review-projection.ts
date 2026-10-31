import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { issueThreadInteractions, toolActionRequests, toolInvocations, type Db } from "@paperclipai/db";

export function toolReviewProjectionService(db: Db, reflect: (input: {
  actionRequestId: string;
  status: "executed" | "failed" | "expired" | "cancelled";
  errorCode: string | null;
  errorMessage: string | null;
  resultSummary: string | null;
}) => Promise<void>) {
  const mismatch = and(
    inArray(toolActionRequests.status, ["executed", "failed", "expired", "cancelled"]),
    sql`coalesce(${issueThreadInteractions.result}->'toolAction'->>'status', '') <> case when ${toolActionRequests.status} = 'cancelled' then 'expired' else ${toolActionRequests.status} end`,
  );
  const candidates = (companyId?: string, cursor?: string) => db
    .select({ request: toolActionRequests, invocation: toolInvocations })
    .from(toolActionRequests)
    .innerJoin(issueThreadInteractions, eq(issueThreadInteractions.id, toolActionRequests.interactionId))
    .innerJoin(toolInvocations, eq(toolInvocations.id, toolActionRequests.invocationId))
    .where(and(mismatch, companyId ? eq(toolActionRequests.companyId, companyId) : undefined,
      cursor ? gt(toolActionRequests.id, cursor) : undefined))
    .orderBy(asc(toolActionRequests.id));

  const continuations = new Map<string, string>();
  return {
    async companies(companyId?: string) {
      const rows = await db.select({ companyId: toolActionRequests.companyId }).from(toolActionRequests)
        .innerJoin(issueThreadInteractions, eq(issueThreadInteractions.id, toolActionRequests.interactionId))
        .innerJoin(toolInvocations, eq(toolInvocations.id, toolActionRequests.invocationId))
        .where(and(mismatch, companyId ? eq(toolActionRequests.companyId, companyId) : undefined))
        .groupBy(toolActionRequests.companyId);
      const pending = new Set(rows.map(row => row.companyId));
      for (const scope of continuations.keys()) {
        if (companyId && scope !== companyId) continue;
        if (scope === "*" ? rows.length === 0 : !pending.has(scope)) continuations.delete(scope);
      }
      return rows;
    },
    async sweep(companyId?: string, options: {
      maxRows?: number;
      signal?: AbortSignal;
      shouldContinue?: () => boolean;
    } = {}) {
      const maxRows = options.maxRows ?? Infinity;
      const scope = companyId ?? "*";
      let cursor = maxRows === Infinity ? undefined : continuations.get(scope);
      const resumed = cursor !== undefined;
      let scanned = 0, completed = false;
      const canContinue = () => !options.signal?.aborted && (options.shouldContinue?.() ?? true);
      const failures: unknown[] = [];
      while (scanned < maxRows && canContinue()) {
        const pageSize = Math.min(100, maxRows - scanned);
        const rows = await candidates(companyId, cursor).limit(pageSize);
        for (const { request, invocation } of rows) {
          if (!canContinue()) break;
          try {
            await reflect({ actionRequestId: request.id,
              status: request.status as "executed" | "failed" | "expired" | "cancelled",
              errorCode: invocation.errorCode, errorMessage: invocation.errorMessage,
              resultSummary: invocation.resultSummary?.summary ?? null });
          } catch (error) { failures.push(error); }
          scanned++;
          cursor = request.id;
        }
        if (!canContinue()) break;
        if (rows.length < pageSize) { completed = true; break; }
      }
      if (maxRows !== Infinity) {
        if (completed) continuations.delete(scope);
        else if (cursor) continuations.set(scope, cursor);
      }
      if (failures.length) throw new AggregateError(failures, "Tool review projection repair failed");
      return { scanned, truncated: !completed,
        retry: !completed || ((scanned > 0 || resumed) && (await candidates(companyId).limit(1)).length > 0) };
    },
  };
}
