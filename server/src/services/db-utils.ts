import { sql, type SQL } from "drizzle-orm";
import { issueRelations, issues } from "@paperclipai/db";

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
