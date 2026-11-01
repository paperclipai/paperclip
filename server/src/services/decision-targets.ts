import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { decisions, decisionTargetIssues, issues, type Db } from "@paperclipai/db";
import { decisionEffectTargetIssueIds } from "@paperclipai/shared";
import type { decisionExpiryService } from "./decision-expiry.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

type Decision = typeof decisions.$inferSelect;
type Cursor = { expiresAt: string; id: string };
type Scope = { kind: "all" | "issue" | "decision"; id?: string; cursor?: Cursor };
const open = sql`${decisions.status} = 'open'`;

export function notifyDecisionTargetWork(transaction: object, hint: `issue:${string}` | `decision:${string}`) {
  return notifyDeliveryWork(transaction, DELIVERY_QUEUES.decisionTargets, hint);
}

export async function notifyDecisionTargetIssueRemoval(transaction: Pick<Db, "select" | "selectDistinct">, issueId: string) {
  const [issue] = await transaction.select({ companyId: issues.companyId }).from(issues)
    .where(eq(issues.id, issueId)).for("update");
  if (!issue) return;
  const linked = await transaction.selectDistinct({ decisionId: decisionTargetIssues.decisionId }).from(decisionTargetIssues)
    .innerJoin(decisions, eq(decisions.id, decisionTargetIssues.decisionId))
    .where(and(eq(decisionTargetIssues.companyId, issue.companyId), eq(decisionTargetIssues.issueId, issueId), eq(decisions.companyId, issue.companyId), open));
  for (const row of linked) await notifyDecisionTargetWork(transaction, `decision:${row.decisionId}`);
}

export function decisionTargetService(db: Db, expire: ReturnType<typeof decisionExpiryService>["expire"]) {
  const scopes = new Map<string, Scope>([["all", { kind: "all" }]]);

  function changed(hints?: ReadonlySet<string>) {
    if (!hints?.size) { scopes.set("all", { kind: "all" }); return; }
    for (const hint of hints) {
      const [kind, id] = hint.split(":");
      if ((kind === "issue" || kind === "decision") && id) scopes.set(hint, { kind, id });
      else scopes.set("all", { kind: "all" });
    }
  }

  async function reason(decision: Decision): Promise<"target_gone" | "target_completed" | null> {
    const strictIds = new Set(decision.options.flatMap(option => option.effects
      .filter(effect => effect.staleness === "strict").flatMap(decisionEffectTargetIssueIds)));
    if (strictIds.size === 0) return null;
    const targets = await db.select({ id: issues.id, status: issues.status }).from(issues)
      .where(and(eq(issues.companyId, decision.companyId), inArray(issues.id, [...strictIds])));
    if (targets.length !== strictIds.size || targets.some(target => target.status === "cancelled")) return "target_gone";
    const snapshots = decision.targetSnapshots as Record<string, { status?: string }>;
    return targets.every(target => target.status === "done") && targets.some(target => snapshots[target.id]?.status !== "done")
      ? "target_completed" : null;
  }

  async function sweep(now = new Date(), signal?: AbortSignal) {
    let expired = 0, inspected = 0;
    const errors: unknown[] = [];
    for (const [key, scope] of [...scopes]) {
      if (signal?.aborted || inspected >= 100) break;
      if (scopes.get(key) !== scope) continue;
      scopes.delete(key);
      const limit = 100 - inspected;
      try {
        const rows = await db.select({ ...getTableColumns(decisions), cursorExpiresAt: sql<string>`${decisions.expiresAt}::text` }).from(decisions).where(and(open,
          scope.kind === "decision" ? eq(decisions.id, scope.id!) : undefined,
          scope.kind === "issue" ? inArray(decisions.id, db.select({ id: decisionTargetIssues.decisionId })
            .from(decisionTargetIssues).where(eq(decisionTargetIssues.issueId, scope.id!))) : undefined,
          scope.cursor ? sql`(${decisions.expiresAt}, ${decisions.id}) > (${scope.cursor.expiresAt}::timestamptz, ${scope.cursor.id}::uuid)` : undefined,
        )).orderBy(asc(decisions.expiresAt), asc(decisions.id)).limit(limit);
        inspected += Math.max(1, rows.length);
        for (const row of rows) {
          if (signal?.aborted) {
            if (!scopes.has(key)) scopes.set(key, scope);
            return { expired };
          }
          try {
            const invalid = await reason(row);
            if (invalid) expired += await expire(row, invalid, now);
          } catch (error) {
            errors.push(error);
            const retry = `decision:${row.id}`;
            if (!scopes.has(retry)) scopes.set(retry, { kind: "decision", id: row.id });
          }
          scope.cursor = { expiresAt: row.cursorExpiresAt, id: row.id };
        }
        if (rows.length === limit && !scopes.has(key)) scopes.set(key, scope);
      } catch (error) {
        errors.push(error); inspected++;
        if (!scopes.has(key)) scopes.set(key, scope);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Decision target reconciliation failed");
    return { expired };
  }

  return { sweep, changed, hasPending: () => scopes.size > 0 };
}
