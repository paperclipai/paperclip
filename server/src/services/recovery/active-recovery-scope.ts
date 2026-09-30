import { and, eq, inArray } from "drizzle-orm";
import { companies, issueRecoveryActions } from "@paperclipai/db";

export function activeRecoveryActionCompanyCondition() {
  return and(
    inArray(issueRecoveryActions.status, ["active", "escalated"]),
    eq(companies.status, "active"),
  );
}
