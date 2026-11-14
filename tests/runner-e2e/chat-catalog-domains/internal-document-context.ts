import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { IssueDocument, IssueAttachment } from "../../../packages/shared/src/types/issue.js";
import type { Entity } from "./internal-support.js";
import { uploadFactualQueryAttachment } from "../chat-query-attachments.js";

/** Visible source metadata plus an actual human query attachment: conversation
 * descriptions alone are intentionally omitted from native wake context. */
export async function selectDocumentSource(ctx: ChatCatalogContext, input: {
  task: Entity;
  document?: { id: string; key: string; latestRevisionId: string | null };
  annotationId?: string;
  attachment?: IssueAttachment;
  workspaceFilename?: string;
}) {
  const { api, fixtures } = ctx.input;
  const target = await api.get<Entity>(`/api/issues/${input.task.id}`);
  if (target.id !== input.task.id || target.companyId !== fixtures.company.id || target.projectId !== input.task.projectId)
    throw new Error("Selected document source does not belong to the expected task/company/project");
  const taskHref = `/${fixtures.company.issuePrefix}/issues/${target.identifier ?? target.id}`;
  const lines = [`Selected source: [${target.title}](${taskHref}).`];
  if (input.document) {
    const doc = await api.get<IssueDocument>(`/api/issues/${target.id}/documents/${encodeURIComponent(input.document.key)}`);
    if (doc.id !== input.document.id || doc.issueId !== target.id || doc.latestRevisionId !== input.document.latestRevisionId)
      throw new Error("Selected source document or revision changed before the canonical turn");
    lines.push(`Selected document: [${doc.title ?? doc.key}](${taskHref}#document-${encodeURIComponent(doc.key)}).`);
    if (input.annotationId) {
      const annotations = await api.get<Entity[]>(`/api/issues/${target.id}/documents/${encodeURIComponent(doc.key)}/annotations?status=all&includeComments=true`);
      const annotation = annotations.find(row => row.id === input.annotationId);
      if (!annotation || annotation.documentId !== doc.id || annotation.originalRevisionId !== doc.latestRevisionId || annotation.status !== "open")
        throw new Error("Selected review annotation is not open on the actual source revision");
      lines.push(`Selected review comment: ${annotation.id} on this document.`);
    }
  } else if (input.annotationId) throw new Error("A selected annotation requires its actual document");
  if (input.attachment) {
    const file = (await api.get<IssueAttachment[]>(`/api/issues/${target.id}/attachments`)).find(row => row.id === input.attachment!.id);
    if (!file || file.issueId !== target.id || file.sha256 !== input.attachment.sha256 || file.contentPath !== input.attachment.contentPath)
      throw new Error("Selected prior delivery is not the original source attachment");
    lines.push(`Selected existing delivery: [${file.originalFilename}](${file.contentPath}).`);
  }
  if (input.workspaceFilename) lines.push(`Selected workspace file: ${input.workspaceFilename}, in the selected task's authorized workspace.`);
  const description = lines.join("\n\n");
  await api.post(`/api/companies/${fixtures.company.id}/chats/${fixtures.agent.id}`);
  await ctx.refreshIssue();
  const source = ctx.issue();
  if (!source || source.id === target.id) throw new Error("Source selection requires the actual separate standing conversation");
  await api.patch(`/api/issues/${source.id}`, { projectId: target.projectId, description });
  const saved = await api.get<Entity>(`/api/issues/${source.id}`);
  if (saved.id !== source.id || saved.companyId !== fixtures.company.id || saved.projectId !== target.projectId || saved.description !== description)
    throw new Error("Visible source selection did not persist on the canonical conversation");
  await ctx.refreshIssue();
  const factualContextAttachment = await uploadFactualQueryAttachment(ctx, { filename: "selected-source.md", body: description });
  const receipt = { sourceIssueId: saved.id, targetIssueId: target.id, projectId: target.projectId, description,
    documentId: input.document?.id, revisionId: input.document?.latestRevisionId, annotationId: input.annotationId,
    attachmentId: input.attachment?.id, attachmentSha256: input.attachment?.sha256, workspaceFilename: input.workspaceFilename, factualContextAttachment };
  await ctx.input.evidence("chat-catalog-selected-document-source.json", receipt);
  return receipt;
}
