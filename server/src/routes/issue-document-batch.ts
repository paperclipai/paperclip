import type { Request, Response, Router } from "express";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { issueDocumentBatchQuerySchema } from "@paperclipai/shared";
import { issueReadSqlCondition } from "../services/authorization.js";
import { documentService, ISSUE_DOCUMENT_BATCH_MAX_BYTES } from "../services/documents.js";
import { assertCompanyAccess } from "./authz.js";

type ReadableIssue = Pick<typeof issues.$inferSelect,
  "id" | "companyId" | "projectId" | "parentId" | "assigneeAgentId" | "assigneeUserId" | "status" | "updatedAt" | "lastStatusDecisionId" | "statusVersion">;

const MAX_ACTOR_READS = 2;
const MAX_SERVER_READS = 8;

function createBatchReadAdmission() {
  const active = new Map<string, number>();
  let total = 0;
  return (req: Request, res: Response): (() => void) | null => {
    const actor = `${req.actor.type}:${req.actor.agentId ?? req.actor.userId ?? req.actor.source}`;
    if (total >= MAX_SERVER_READS || (active.get(actor) ?? 0) >= MAX_ACTOR_READS) {
      res.setHeader("Retry-After", "1");
      res.status(429).json({ error: "Too many document batch reads; retry after an active read finishes" });
      return null;
    }
    total++;
    active.set(actor, (active.get(actor) ?? 0) + 1);
    let workDone = false, responseDone = false, released = false;
    const release = () => {
      if (released || !workDone || !responseDone) return;
      released = true;
      total--;
      const remaining = active.get(actor)! - 1;
      if (remaining) active.set(actor, remaining);
      else active.delete(actor);
    };
    const finish = () => { responseDone = true; release(); };
    res.once("finish", finish);
    res.once("close", finish);
    // A disconnect cannot free database capacity while its read is still live.
    return () => { workDone = true; release(); };
  };
}

export function registerIssueDocumentBatchRoute(router: Router, db: Db, options: {
  filterReadable: (req: Request, rows: ReadableIssue[]) => Promise<ReadableIssue[]>;
  recordReads: (req: Request, issues: ReadableIssue[]) => Promise<void>;
}) {
  const admit = createBatchReadAdmission();
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
    const settle = admit(req, res);
    if (!settle) return;
    try {
      res.setHeader("Cache-Control", "private, no-store");
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
      const parts = [`{"key":${JSON.stringify(key)},"items":[`];
      let bytes = Buffer.byteLength(parts[0]) + 2; // closing array and object
      for (const [index, item] of items.entries()) {
        const part = `${index ? "," : ""}${JSON.stringify(item)}`;
        bytes += Buffer.byteLength(part);
        if (bytes > ISSUE_DOCUMENT_BATCH_MAX_BYTES) {
          res.status(413).json({ error: "Document batch exceeds 8 MiB; split issueIds into smaller requests or use includeBody=false", maxResponseBytes: ISSUE_DOCUMENT_BATCH_MAX_BYTES });
          return;
        }
        parts.push(part);
      }
      if (includeBody) {
        await options.recordReads(req, readable.filter(issue => byIssueId.has(issue.id)));
      }
      res.type("json").send(parts.join("") + "]}");
    } finally { settle(); }
  });
}
