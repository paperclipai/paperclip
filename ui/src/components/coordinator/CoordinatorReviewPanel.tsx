import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Loader2 } from "lucide-react";
import type { Agent, AttentionItem } from "@paperclipai/shared";
import { approvalsApi } from "@/api/approvals";
import { issuesApi } from "@/api/issues";
import { buildDocumentAnnotationHash, parseDocumentAnnotationHash, type DocumentAnnotationHashTarget } from "@/lib/document-annotation-hash";
import { AttentionForOtherGate } from "@/components/AttentionCloseMenu";
import { queryKeys } from "@/lib/queryKeys";
import { attentionDetailImages, attentionImageUrl, isInlineResolvable } from "@/lib/attention";
import { AttentionInteractionResolver } from "@/components/AttentionInteractionResolver";
import { ApprovalPayloadRenderer } from "@/components/ApprovalPayload";
import { ApprovalResolver } from "@/components/AttentionQueueRow";
import { Button } from "@/components/ui/button";
import { useQueryView } from "@/components/QueryView";
import { MarkdownBody } from "@/components/MarkdownBody";
import { isImageFilename } from "@/components/task-chat/task-chat-attachments";

/** The document a card asks you to review, when it has one (a plan approval today). */
export function attentionReviewDocumentKey(item: AttentionItem): string | null {
  if (item.sourceKind !== "issue_thread_interaction") return null;
  const key = item.subject.metadata?.targetDocumentKey;
  return typeof key === "string" && key ? key : null;
}

/**
 * What a card is deciding on, when it can open beside the card (PAP-775,
 * IA5/IA6): a document such as a plan, an approval's request, or the
 * screenshots attached to the task.
 */
export type NeedsYouArtifact =
  | { kind: "document"; key: string; issueId: string; title?: string; documentTarget?: DocumentAnnotationHashTarget; requestIssueId?: string }
  | { kind: "approval"; approvalId?: string }
  | { kind: "images" }
  | { kind: "attachment"; assetId: string; name?: string };

export function needsYouArtifact(item: AttentionItem): NeedsYouArtifact | null {
  const issueId = item.relatedIssue?.id ?? (typeof item.subject.metadata?.issueId === "string" ? item.subject.metadata.issueId : null);
  const key = attentionReviewDocumentKey(item);
  if (key && issueId) return { kind: "document", key, issueId, requestIssueId: issueId };
  if (item.sourceKind === "approval") return { kind: "approval" };
  if (attentionDetailImages(item).length > 0) return { kind: "images" };
  return null;
}

/**
 * An artifact a card's text links to (PAP-775): another document of a task
 * (`/NEE/issues/NEE-12#document-design`), an approval, or an attachment. It
 * opens beside the card like the card's own artifact. `null` for any other
 * link, which keeps its normal behaviour.
 */
export function needsYouMentionedArtifact(href: string, name?: string | null): NeedsYouArtifact | null {
  let url: URL;
  try { url = new URL(href, "http://paperclip.local"); } catch { return null; }
  if (url.origin !== "http://paperclip.local" && typeof window !== "undefined" && url.origin !== window.location.origin) return null;
  const doc = parseDocumentAnnotationHash(url.hash);
  const issue = url.pathname.match(/\/issues\/([^/]+)\/?$/);
  if (doc && issue) {
    try { return { kind: "document", issueId: doc.documentIssueId ?? decodeURIComponent(issue[1]), key: doc.documentKey, title: name?.trim() || undefined, ...(url.hash.includes("&") ? { documentTarget: doc } : {}) }; }
    catch { return null; }
  }
  const approval = url.pathname.match(/\/approvals\/([^/]+)\/?$/);
  if (approval) return { kind: "approval", approvalId: decodeURIComponent(approval[1]) };
  const attachment = url.pathname.match(/^\/api\/attachments\/([^/]+)\/content\/?$/);
  if (attachment && name && isImageFilename(name.trim())) return { kind: "attachment", assetId: decodeURIComponent(attachment[1]), name: name.trim() };
  return null;
}

/** One id per artifact, so the same plan or approval never opens twice. */
export function needsYouArtifactId(artifact: NeedsYouArtifact, item: AttentionItem) {
  if (artifact.kind === "document" && artifact.requestIssueId) return `document:interaction:${item.subject.id}`;
  if (artifact.kind === "document") return `document:${artifact.issueId}:${artifact.key}${artifact.documentTarget?.revisionId ? `:${artifact.documentTarget.revisionId}` : ""}`;
  if (artifact.kind === "approval") return `approval:${artifact.approvalId ?? item.subject.id}`;
  if (artifact.kind === "attachment") return `attachment:${artifact.assetId}`;
  return `images:${item.id}`;
}

/** "Plan", "Approval" or "Attachments": the artifact's name on its tab and button. */
export function needsYouArtifactLabel(artifact: NeedsYouArtifact) {
  if (artifact.kind === "approval") return "Approval";
  if (artifact.kind === "images") return "Attachments";
  if (artifact.kind === "attachment") return artifact.name ?? "Attachment";
  return artifact.key === "plan" ? "Plan" : artifact.title ?? artifact.key;
}

export interface CoordinatorReviewPanelProps {
  companyId: string;
  item: AttentionItem;
  artifact: NeedsYouArtifact;
  agentMap: Map<string, Agent>;
  currentUserId: string | null | undefined;
  userLabelMap?: ReadonlyMap<string, string>;
  onOpenTask: (href: string) => void;
  onResolved: () => void;
}

/**
 * Focus review panel (PAP-770, PAP-775): the artifact a card asks about,
 * opened beside the card. It links to the exact spot in the task and pins the
 * card's own actions to the bottom. Both read the same record, so answering
 * here or on the card resolves both (one record, many views).
 */
export function CoordinatorReviewPanel(props: CoordinatorReviewPanelProps) {
  const { artifact, item } = props;
  const requestIssueId = artifact.kind === "document" ? artifact.requestIssueId : undefined;
  const request = useQuery({
    queryKey: queryKeys.issues.interactions(requestIssueId ?? ""),
    queryFn: () => issuesApi.listInteractions(requestIssueId!),
    enabled: Boolean(requestIssueId),
  });
  const requestView = useQueryView(request);
  if (!requestIssueId) return <CoordinatorReviewPanelContent {...props} />;
  if (requestView.kind === "loading" || requestView.kind === "reconnecting") {
    return <p role="status" className="text-sm text-muted-foreground">Loading the requested document…</p>;
  }
  const interaction = request.data?.find(entry => entry.id === item.subject.id);
  const target = interaction?.kind === "request_confirmation" ? interaction.payload.target : null;
  if (requestView.kind === "error" || !target || target.type !== "issue_document") {
    return <div role="alert" className="space-y-2 text-sm"><p>The requested document could not be loaded.</p><Button variant="outline" onClick={() => void request.refetch()}>Retry</Button></div>;
  }
  const resolved: NeedsYouArtifact = { kind: "document", key: target.key, issueId: target.issueId ?? requestIssueId, requestIssueId,
    documentTarget: { documentKey: target.key, revisionId: target.revisionId, interactionId: interaction!.id,
      documentIssueId: target.issueId ?? requestIssueId, threadId: null, commentId: null, viewer: null } };
  return <CoordinatorReviewPanelContent {...props} artifact={resolved} />;
}

function CoordinatorReviewPanelContent({ companyId, item, artifact, agentMap, currentUserId, userLabelMap, onOpenTask, onResolved }: CoordinatorReviewPanelProps) {
  const task = item.relatedIssue;
  const label = needsYouArtifactLabel(artifact);
  const ownDocument = artifact.kind === "document" && (artifact.issueId === task?.id || artifact.requestIssueId === task?.id);
  const approvalId = artifact.kind === "approval" ? artifact.approvalId ?? item.subject.id : null;
  // "/NEE": the company prefix of the card's own links, for a mentioned artifact's link.
  const prefix = (task?.href ?? item.subject.href ?? "").match(/^\/[^/]+/)?.[0] ?? "";
  const exactHref = artifact.kind === "document" ? `${ownDocument && task?.href ? task.href : `${prefix}/issues/${artifact.requestIssueId ?? artifact.issueId}`}${buildDocumentAnnotationHash(artifact.documentTarget ?? { documentKey: artifact.key, threadId: null, commentId: null })}`
    : artifact.kind === "approval" ? (approvalId === item.subject.id ? item.subject.href : `${prefix}/approvals/${approvalId}`)
      : artifact.kind === "attachment" ? attachmentUrl(artifact.assetId)
        : task?.href ?? item.subject.href;
  const interactionIssueId = item.sourceKind === "issue_thread_interaction"
    ? item.relatedIssue?.id ?? (typeof item.subject.metadata?.issueId === "string" ? item.subject.metadata.issueId : null)
    : null;
  // Confirmation drafts/actions synchronize across views. Other interaction
  // kinds keep one editable form on the card while their artifact is open.
  const requestKind = item.subject.metadata?.requestKind;
  const sharedInteractionActions = interactionIssueId && item.subject.metadata?.kind === "request_confirmation"
    && (requestKind == null || requestKind === "deliverable");
  return <div className="flex min-h-full flex-col gap-4" data-coordinator-review-panel={item.id} data-artifact={artifact.kind}>
    <div className="min-h-0 flex-1">
      {artifact.kind === "document" ? <DocumentArtifact issueId={artifact.issueId} documentKey={artifact.key} label={label} revisionId={artifact.documentTarget?.revisionId} />
        : artifact.kind === "approval" ? <ApprovalArtifact approvalId={approvalId!} title={approvalId === item.subject.id ? item.subject.title : null} />
          : artifact.kind === "attachment" ? <AttachmentArtifact key={artifact.assetId} assetId={artifact.assetId} name={label} />
            : <ImagesArtifact item={item} />}
    </div>
    {exactHref ? artifact.kind === "attachment" ? <a href={exactHref} target="_blank" rel="noreferrer" className="flex max-w-full items-center gap-2 text-left text-sm text-muted-foreground hover:text-foreground">
      <span className="shrink-0">Open file</span><ArrowUpRight className="size-4 shrink-0" />
    </a> : <button type="button" onClick={() => onOpenTask(exactHref)} className="flex max-w-full items-center gap-2 text-left text-sm text-muted-foreground hover:text-foreground">
      <span className="shrink-0">{`Open in ${artifact.kind === "approval" && !task ? "approvals" : artifact.kind === "document" && !ownDocument ? artifact.issueId : task?.identifier ?? "task"}`}</span><ArrowUpRight className="size-4 shrink-0" />
    </button> : null}
    {/* The card's own actions, pinned to the bottom of the artifact. */}
    {/* Only the buttons the card itself offers (UX1). */}
    {sharedInteractionActions || (item.sourceKind === "approval" && isInlineResolvable(item)) ? <div className="coordinator-review-actions sticky bottom-0 -mx-4 border-t border-border bg-card px-4 py-3">
      <AttentionForOtherGate key={`${item.id}:${item.audience?.userId}`} item={item} currentUserId={currentUserId} userLabelMap={userLabelMap}>
      {sharedInteractionActions ? <AttentionInteractionResolver presentation="coordinator-decision" companyId={companyId} issueId={interactionIssueId!} interactionId={item.subject.id} shareReviseDraft
        agentMap={agentMap} currentUserId={currentUserId} userLabelMap={userLabelMap}
        onResolved={resolved => { if (resolved && resolved.status !== "pending") onResolved(); }} />
        : <ApprovalResolver item={item} companyId={companyId} toggle={null} presentation="panel" shareDraft onResolved={onResolved} />}
      </AttentionForOtherGate>
    </div> : interactionIssueId ? <p className="text-sm text-muted-foreground">Answer on the inbox card while reviewing this artifact.</p> : null}
  </div>;
}

function DocumentArtifact({ issueId, documentKey, label, revisionId }: { issueId: string; documentKey: string; label: string; revisionId?: string }) {
  const doc = useQuery<{ title: string | null; body: string }>({
    queryKey: revisionId ? [...queryKeys.issues.document(issueId, documentKey), "revision", revisionId] : queryKeys.issues.document(issueId, documentKey),
    queryFn: () => revisionId ? issuesApi.getDocumentRevision(issueId, documentKey, revisionId) : issuesApi.getDocument(issueId, documentKey),
  });
  return <>
    {/* Say the title once (IA4): a body that opens with it already shows it. */}
    {doc.data?.body.trimStart().toLocaleLowerCase().startsWith(`# ${(doc.data.title ?? label).toLocaleLowerCase()}`) ? null : <h2 className="mb-4 text-lg font-medium">{doc.data?.title ?? label}</h2>}
    {doc.isPending ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading {label.toLocaleLowerCase()}…</p>
      : doc.isError || !doc.data ? <p className="text-sm text-muted-foreground">This document couldn't be loaded. Open it in the task instead.</p>
      : <MarkdownBody>{doc.data.body}</MarkdownBody>}
  </>;
}

function ApprovalArtifact({ approvalId, title }: { approvalId: string; title: string | null }) {
  const approval = useQuery({ queryKey: queryKeys.approvals.detail(approvalId), queryFn: () => approvalsApi.get(approvalId) });
  return <>
    <h2 className="mb-4 text-lg font-medium">{title ?? "Approval"}</h2>
    {approval.isPending ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading approval…</p>
      : approval.isError || !approval.data ? <p className="text-sm text-muted-foreground">This approval couldn't be loaded. Open it instead.</p>
      : <ApprovalPayloadRenderer type={approval.data.type} payload={approval.data.payload} hidePrimaryTitle />}
  </>;
}

const attachmentUrl = (assetId: string) => `/api/attachments/${encodeURIComponent(assetId)}/content`;

function AttachmentArtifact({ assetId, name }: { assetId: string; name: string }) {
  const [previewFailed, setPreviewFailed] = useState(false);
  return <>
    <h2 className="mb-4 text-lg font-medium">{name}</h2>
    {previewFailed ? <p className="text-sm text-muted-foreground">This file cannot be previewed. Open the original file below.</p>
      : <img src={attachmentUrl(assetId)} alt={name} onError={() => setPreviewFailed(true)} className="w-full rounded-md border border-border bg-muted object-contain" />}
  </>;
}

function ImagesArtifact({ item }: { item: AttentionItem }) {
  const images = attentionDetailImages(item);
  return <>
    <h2 className="mb-4 text-lg font-medium">Attachments</h2>
    <div className="space-y-3">
      {images.map((image, index) => <img key={`${image.assetId}-${index}`} src={attentionImageUrl(image.assetId)} alt={image.alt ?? ""} loading="lazy"
        className="w-full rounded-md border border-border bg-muted object-contain" />)}
    </div>
  </>;
}
