import { sql, type SQL } from "drizzle-orm";
import { issueRelations, issues } from "@paperclipai/db";

const POSTGRES_DEADLOCK_CODE = "40P01";
const MAX_DEADLOCK_RETRIES = 3;

export async function withDeadlockRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_DEADLOCK_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if ((err as any)?.code === POSTGRES_DEADLOCK_CODE) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export async function withAdvisoryLock(tx: { execute: (query: SQL) => Promise<unknown> }, lockKey: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
}

export function noUnresolvedBlockersSubquery(companyId: string): SQL {
  return sql`not exists (
    select 1
    from ${issueRelations}
    join ${issues} as blocker_issues
      on blocker_issues.id = ${issueRelations.issueId}
    where ${issueRelations.companyId} = ${companyId}
      and ${issueRelations.type} = 'blocks'
      and ${issueRelations.relatedIssueId} = ${issues.id}
      and blocker_issues.status not in ('done', 'cancelled')
  )`;
}
