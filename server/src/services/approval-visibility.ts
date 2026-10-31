import { sql, type SQL } from "drizzle-orm";
import { approvals, issues } from "@paperclipai/db";
import { executionIssueCondition } from "./issue-visibility.js";

export function firstApprovalIssueId(): SQL<string | null> {
  return sql`(select first_link.issue_id from issue_approvals first_link
    where first_link.company_id = ${approvals.companyId} and first_link.approval_id = ${approvals.id}
    order by first_link.issue_id limit 1)`;
}

export function approvalExecutionIssueCondition(): SQL {
  return sql`not exists (
    select 1 from issue_approvals linked where linked.company_id = ${approvals.companyId}
      and linked.approval_id = ${approvals.id} and linked.issue_id = ${firstApprovalIssueId()}
      and not exists (select 1 from ${issues} where ${issues.id} = linked.issue_id
        and ${issues.companyId} = ${approvals.companyId} and ${executionIssueCondition()})
  )`;
}
