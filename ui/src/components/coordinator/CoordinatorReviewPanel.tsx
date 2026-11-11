import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Loader2 } from "lucide-react";
import type { Agent, AttentionItem } from "@paperclipai/shared";
import { approvalsApi } from "@/api/approvals";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { attentionDetailImages, attentionImageUrl, isInlineResolvable } from "@/lib/attention";
import { AttentionInteractionResolver } from "@/components/AttentionInteractionResolver";
import { ApprovalPayloadRenderer } from "@/components/ApprovalPayload";
import { ApprovalResolver } from "@/components/AttentionQueueRow";
import { MarkdownBody } from "@/components/MarkdownBody";

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
  | { kind: "document"; key: string; issueId: string; title?: string }
  | { kind: "approval"; approvalId?: string }
  | { kind: "images" }
  | { kind: "attachment"; assetId: string; name?: string };

export function needsYouArtifact(item: AttentionItem): NeedsYouArtifact | null {
  const issueId = item.relatedIssue?.id ?? (typeof item.subject.metadata?.issueId === "string" ? item.subject.metadata.issueId : null);
  const key = attentionReviewDocumentKey(item);
  if (key && issueId) return { kind: "document", key, issueId };
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
  const doc = url.hash.match(/^#document-(.+)$/);
  const issue = url.pathname.match(/\/issues\/([^/]+)\/?$/);
  if (doc && issue) return { kind: "document", issueId: decodeURIComponent(issue[1]), key: decodeURIComponent(doc[1]), title: name?.trim() || undefined };
  const approval = url.pathname.match(/\/approvals\/([^/]+)\/?$/);
  if (approval) return { kind: "approval", approvalId: decodeURIComponent(approval[1]) };
  const attachment = url.pathname.match(/^\/api\/attachments\/([^/]+)\/content\/?$/);
  if (attachment) return { kind: "attachment", assetId: decodeURIComponent(attachment[1]), name: name?.trim() || undefined };
  return null;
}

/** One id per artifact, so the same plan or approval never opens twice. */
export function needsYouArtifactId(artifact: NeedsYouArtifact, item: AttentionItem) {
  if (artifact.kind === "document") return `document:${artifact.issueId}:${artifact.key}`;
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
export function CoordinatorReviewPanel({ companyId, item, artifact, agentMap, currentUserId, userLabelMap, onOpenTask, onResolved }: CoordinatorReviewPanelProps) {
  const task = item.relatedIssue;
  const label = needsYouArtifactLabel(artifact);
  const ownDocument = artifact.kind === "document" && artifact.issueId === task?.id;
  const approvalId = artifact.kind === "approval" ? artifact.approvalId ?? item.subject.id : null;
  // "/NEE": the company prefix of the card's own links, for a mentioned artifact's link.
  const prefix = (task?.href ?? item.subject.href ?? "").match(/^\/[^/]+/)?.[0] ?? "";
  const exactHref = artifact.kind === "document" ? `${ownDocument && task?.href ? task.href : `${prefix}/issues/${artifact.issueId}`}#document-${artifact.key}`
    : artifact.kind === "approval" ? (approvalId === item.subject.id ? item.subject.href : `${prefix}/approvals/${approvalId}`)
      : artifact.kind === "attachment" ? attachmentUrl(artifact.assetId)
        : task?.href ?? item.subject.href;
  const interactionIssueId = item.sourceKind === "issue_thread_interaction"
    ? item.relatedIssue?.id ?? (typeof item.subject.metadata?.issueId === "string" ? item.subject.metadata.issueId : null)
    : null;
  return <div className="flex min-h-full flex-col gap-4" data-coordinator-review-panel={item.id} data-artifact={artifact.kind}>
    <div className="min-h-0 flex-1">
      {artifact.kind === "document" ? <DocumentArtifact issueId={artifact.issueId} documentKey={artifact.key} label={label} />
        : artifact.kind === "approval" ? <ApprovalArtifact approvalId={approvalId!} title={approvalId === item.subject.id ? item.subject.title : null} />
          : artifact.kind === "attachment" ? <AttachmentArtifact assetId={artifact.assetId} name={label} />
            : <ImagesArtifact item={item} />}
    </div>
    {exactHref ? <button type="button" onClick={() => onOpenTask(exactHref)} className="flex max-w-full items-center gap-2 text-left text-sm text-muted-foreground hover:text-foreground">
      <span className="shrink-0">{artifact.kind === "attachment" ? "Open file" : `Open in ${artifact.kind === "approval" && !task ? "approvals" : artifact.kind === "document" && !ownDocument ? artifact.issueId : task?.identifier ?? "task"}`}</span><ArrowUpRight className="size-4 shrink-0" />
    </button> : null}
    {/* The card's own actions, pinned to the bottom of the artifact. */}
    {/* Only the buttons the card itself offers (UX1). */}
    {interactionIssueId || (item.sourceKind === "approval" && isInlineResolvable(item)) ? <div className="coordinator-review-actions sticky bottom-0 -mx-4 border-t border-border bg-card px-4 py-3">
      {interactionIssueId ? <AttentionInteractionResolver presentation="coordinator-decision" companyId={companyId} issueId={interactionIssueId} interactionId={item.subject.id} shareReviseDraft
        agentMap={agentMap} currentUserId={currentUserId} userLabelMap={userLabelMap}
        onResolved={resolved => { if (resolved && resolved.status !== "pending") onResolved(); }} />
        : <ApprovalResolver item={item} companyId={companyId} toggle={null} presentation="panel" shareDraft onResolved={onResolved} />}
    </div> : null}
  </div>;
}

function DocumentArtifact({ issueId, documentKey, label }: { issueId: string; documentKey: string; label: string }) {
  const doc = useQuery({ queryKey: queryKeys.issues.document(issueId, documentKey), queryFn: () => issuesApi.getDocument(issueId, documentKey) });
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
  return <>
    <h2 className="mb-4 text-lg font-medium">{name}</h2>
    <img src={attachmentUrl(assetId)} alt={name} className="w-full rounded-md border border-border bg-muted object-contain" />
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
