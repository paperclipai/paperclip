import { sql, type SQLWrapper } from "drizzle-orm";
import { ONBOARDING_FIRST_TASK_ORIGIN_KIND } from "@paperclipai/shared";

export function onboardingFirstTaskAwaitingUserSql(companyId: SQLWrapper, issueId: SQLWrapper, originKind: SQLWrapper) {
  return sql`${originKind} = ${ONBOARDING_FIRST_TASK_ORIGIN_KIND}
    AND NOT EXISTS (SELECT 1 FROM issue_comments c
      WHERE c.company_id = ${companyId} AND c.issue_id = ${issueId}
        AND (c.author_type = 'user' OR (c.author_type IS NULL AND c.author_user_id IS NOT NULL)))
    AND NOT EXISTS (SELECT 1 FROM issue_thread_interactions t
      WHERE t.company_id = ${companyId} AND t.issue_id = ${issueId} AND t.resolved_by_user_id IS NOT NULL)`;
}
