import { sql, type SQL } from "drizzle-orm";
import { activityLog, cases, type Db } from "@paperclipai/db";
import type { AuthorizationActor } from "./authorization.js";
import { caseReadSqlCondition } from "./case-access.js";

/** Keep case-derived audit content behind the same boundary as the case itself. */
export async function caseActivityReadSqlCondition(db: Db, actor: AuthorizationActor): Promise<SQL<boolean>> {
  const readable = await caseReadSqlCondition(db, actor);
  return sql<boolean>`(${activityLog.entityType} <> 'case' or exists (
    select 1 from ${cases} where ${cases.id}::text = ${activityLog.entityId}
      and ${cases.companyId} = ${activityLog.companyId} and ${readable}
  ))`;
}
