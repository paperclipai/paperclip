import { and, eq, sql } from "drizzle-orm";
import { companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import type { SentryRunLinkResolver } from "../sentry-links.js";
import { readTaskCreationProvenance, unknownTaskCreationProvenance } from "./task-creation-provenance.js";

export function createSentryRunLinkResolver(db: Db): SentryRunLinkResolver {
  return async ({ runId, companyId, agentId, includeCreationProvenance }) => {
    const deadlineAt = Date.now() + 750;
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
    if (includeCreationProvenance && Date.now() >= deadlineAt) return null;
    const candidate = run.issueId ?? run.nativeIssueId ?? run.contextIssueId;
    const taskId = candidate && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(candidate) ? candidate : null;
    const [metadata] = await db.select({ companyPrefix: companies.issuePrefix, taskId: issues.id, taskIdentifier: issues.identifier })
      .from(companies).leftJoin(issues, and(
        eq(issues.companyId, companies.id),
        taskId ? eq(issues.id, taskId) : sql`false`,
      )).where(eq(companies.id, run.companyId)).limit(1);
    if (!metadata) return null;
    const creationProvenance = includeCreationProvenance
      ? await readTaskCreationProvenance(db, run.companyId, metadata.taskId, deadlineAt).catch(unknownTaskCreationProvenance)
      : undefined;
    return { ...run, ...metadata, ...(creationProvenance ? { creationProvenance } : {}) };
  };
}
