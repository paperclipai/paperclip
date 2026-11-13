import type { Db } from "@paperclipai/db";
import type { CaseWorkflowTransition } from "@paperclipai/shared";
import { documentService } from "./documents.js";
import { getWorkflow, getWorkflowMetadata } from "./workflows.js";
import { persistActivity, type ActivityPublication } from "./activity-log.js";
import type { CaseHandoffRow } from "./case-handoffs.js";

export async function captureCaseWorkflow(db: Db, companyId: string,
  current: { workflowId: string | null; phase: string | null }, issueId: string,
  phase: string, workflowId?: string | null) {
  const previous = current.workflowId ? await getWorkflowMetadata(db, companyId, current.workflowId) : null;
  const selected = workflowId ? await getWorkflow(db, companyId, workflowId) : null;
  const next = workflowId === undefined ? previous : selected;
  const document = await documentService(db).getIssueDocumentByKey(issueId, "workflow");
  const revisionId = document?.latestRevisionId ?? null;
  const transition: CaseWorkflowTransition = {
    from: { workflowId: previous?.id ?? null, name: previous?.name ?? null, phase: current.phase },
    to: { workflowId: next?.id ?? null, name: next?.name ?? null, phase },
    documentRevisionId: revisionId,
  };
  return { workflowTransition: transition, workflowPrompt: selected?.prompt ?? null,
    baseWorkflowDocumentRevisionId: revisionId };
}

export async function applyCaseWorkflow(db: Db, row: CaseHandoffRow, publications: ActivityPublication[]) {
  if (!row.workflowTransition) return null;
  let revisionId: string | null;
  if (row.workflowPrompt !== null) {
    const saved = await documentService(db).upsertIssueDocument({ issueId: row.issueId,
      key: "workflow", title: "Workflow", format: "markdown", body: row.workflowPrompt,
      baseRevisionId: row.baseWorkflowDocumentRevisionId, changeSummary: "Adopt case workflow",
      createdByAgentId: row.actorType === "agent" ? row.actorId : null,
      createdByUserId: row.actorType === "user" ? row.actorId : null,
      createdByRunId: row.sourceRunId, lockedDocumentStrategy: "conflict" });
    revisionId = saved.document.latestRevisionId;
    publications.push((await persistActivity(db, { companyId: row.companyId, actorType: row.actorType, actorId: row.actorId,
      agentId: row.actorType === "agent" ? row.actorId : null, runId: row.sourceRunId, issueId: row.issueId,
      action: row.baseWorkflowDocumentRevisionId ? "issue.document_updated" : "issue.document_created",
      entityType: "issue", entityId: row.issueId, details: { key: "workflow", documentId: saved.document.id,
        revisionNumber: saved.document.latestRevisionNumber, source: "case_handoff", handoffId: row.id } })).publication);
  } else {
    revisionId = (await documentService(db).getIssueDocumentByKey(row.issueId, "workflow"))?.latestRevisionId ?? null;
  }
  return { ...row.workflowTransition, documentRevisionId: revisionId };
}
