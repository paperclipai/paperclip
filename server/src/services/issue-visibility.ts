import { and, isNull, type SQL } from "drizzle-orm";
import { issues } from "@paperclipai/db";

export function visibleIssueCondition(options?: { includeArchived?: boolean }): SQL {
  const parts: SQL[] = [isNull(issues.hiddenAt), isNull(issues.harnessKind)];
  if (!options?.includeArchived) {
    parts.push(isNull(issues.archivedAt));
  }
  return and(...parts)!;
}

export function visibleIssueSql(alias = "issues", options?: { includeArchived?: boolean }) {
  const archivedClause = options?.includeArchived ? "" : ` AND "${alias}"."archived_at" IS NULL`;
  return `"${alias}"."hidden_at" IS NULL AND "${alias}"."harness_kind" IS NULL${archivedClause}`;
}
