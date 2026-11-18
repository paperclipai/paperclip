import type { Request, Router } from "express";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { issueDocumentBatchQuerySchema } from "@paperclipai/shared";
import { issueReadSqlCondition } from "../services/authorization.js";
import { documentService } from "../services/documents.js";
import { assertCompanyAccess } from "./authz.js";

type ReadableIssue = Pick<typeof issues.$inferSelect,
  "id" | "companyId" | "projectId" | "parentId" | "assigneeAgentId" | "assigneeUserId" | "status" | "updatedAt" | "lastStatusDecisionId" | "statusVersion">;

// Stay below download_artifact's 10 MiB limit, including JSON escaping and metadata.
export const ISSUE_DOCUMENT_BATCH_MAX_BYTES = 8 * 1024 * 1024;

export function registerIssueDocumentBatchRoute(router: Router, db: Db, options: {
  filterReadable: (req: Request, rows: ReadableIssue[]) => Promise<ReadableIssue[]>;
  recordRead: (req: Request, issue: ReadableIssue) => Promise<void>;
}) {
  router.get("/companies/:companyId/issue-documents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "agent" && req.actor.source === "agent_key" && req.actor.keyScope?.kind === "task_bridge") {
      res.status(403).json({ error: "Task bridge keys cannot use company-wide issue list APIs" });
      return;
    }
    const parsed = issueDocumentBatchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid issue document batch query", details: parsed.error.issues });
      return;
    }
    const { key, issueIds, includeBody } = parsed.data;
    const candidates = await db.select({
      id: issues.id, companyId: issues.companyId, projectId: issues.projectId, parentId: issues.parentId,
      assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId, status: issues.status,
      updatedAt: issues.updatedAt, lastStatusDecisionId: issues.lastStatusDecisionId, statusVersion: issues.statusVersion,
    }).from(issues).where(and(
      eq(issues.companyId, companyId), inArray(issues.id, issueIds), isNull(issues.hiddenAt),
      await issueReadSqlCondition(db, req.actor),
    ));
    const readable = await options.filterReadable(req, candidates);
    const byId = new Map(readable.map(issue => [issue.id, issue]));
    const docs = await documentService(db).getIssueDocumentsByKey(companyId, readable.map(issue => issue.id), key, includeBody);
    const byIssueId = new Map(docs.map(doc => [doc.issueId, doc]));
    const items = issueIds.filter(id => byId.has(id)).map(issueId => ({ issueId, document: byIssueId.get(issueId) ?? null }));
    const json = JSON.stringify({ key, items });
    res.setHeader("Cache-Control", "private, no-store");
    if (Buffer.byteLength(json) > ISSUE_DOCUMENT_BATCH_MAX_BYTES) {
      res.status(413).json({ error: "Document batch exceeds 8 MiB; split issueIds into smaller requests or use includeBody=false", maxResponseBytes: ISSUE_DOCUMENT_BATCH_MAX_BYTES });
      return;
    }
    if (includeBody) {
      for (const issue of readable) {
        if (byIssueId.has(issue.id)) await options.recordRead(req, issue);
      }
    }
    res.type("json").send(json);
  });
}
