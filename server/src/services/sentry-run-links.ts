import { and, eq, sql } from "drizzle-orm";
import { companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import type { SentryRunLinkResolver } from "../sentry-links.js";

/** Two indexed, company-bound metadata reads; no prompt, output, or credentials. */
export function createSentryRunLinkResolver(db: Db): SentryRunLinkResolver {
  return async ({ runId, companyId, agentId }) => {
    const [run] = await db.select({
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      issueId: heartbeatRuns.issueId,
      nativeIssueId: heartbeatRuns.nativeIssueId,
      contextIssueId: sql<string | null>`${heartbeatRuns.contextSnapshot}->>'issueId'`,
    }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, runId),
      companyId ? eq(heartbeatRuns.companyId, companyId) : undefined,
      agentId ? eq(heartbeatRuns.agentId, agentId) : undefined,
    )).limit(1);
    if (!run) return null;
    const candidate = run.issueId ?? run.nativeIssueId ?? run.contextIssueId;
    const taskId = candidate && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(candidate) ? candidate : null;
    const [metadata] = await db.select({ companyPrefix: companies.issuePrefix, taskId: issues.id, taskIdentifier: issues.identifier })
      .from(companies).leftJoin(issues, and(
        eq(issues.companyId, companies.id),
        taskId ? eq(issues.id, taskId) : sql`false`,
      )).where(eq(companies.id, run.companyId)).limit(1);
    if (!metadata) return null;
    return { ...run, ...metadata };
  };
}
