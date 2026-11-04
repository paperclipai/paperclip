import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Loader2 } from "lucide-react";
import type { Agent, AttentionItem } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { AttentionInteractionResolver } from "@/components/AttentionInteractionResolver";
import { MarkdownBody } from "@/components/MarkdownBody";
import { PROPERTIES_PANE_HEADER_SLOT_ID } from "@/components/PropertiesPanel";
import { SidePanelTab } from "@/components/side-panel";

/** The document a card asks you to review, when it has one (a plan approval today). */
export function attentionReviewDocumentKey(item: AttentionItem): string | null {
  if (item.sourceKind !== "issue_thread_interaction") return null;
  const key = item.subject.metadata?.targetDocumentKey;
  return typeof key === "string" && key ? key : null;
}

export interface CoordinatorReviewPanelProps {
  companyId: string;
  item: AttentionItem;
  issueId: string;
  documentKey: string;
  agentMap: Map<string, Agent>;
  currentUserId: string | null | undefined;
  userLabelMap?: ReadonlyMap<string, string>;
  onOpenTask: (href: string) => void;
  onResolved: () => void;
  onClose: () => void;
}

/**
 * Focus review panel (PAP-770): the artifact a card asks about, opened beside
 * the card. It links back to the exact spot in the task and pins the card's
 * own actions to the bottom. Both read the same interaction query, so
 * answering here or on the card resolves both (one record, many views).
 */
export function CoordinatorReviewPanel({ companyId, item, issueId, documentKey, agentMap, currentUserId, userLabelMap, onOpenTask, onResolved, onClose }: CoordinatorReviewPanelProps) {
  const doc = useQuery({ queryKey: queryKeys.issues.document(issueId, documentKey), queryFn: () => issuesApi.getDocument(issueId, documentKey) });
  const task = item.relatedIssue;
  const taskHref = task?.href ? `${task.href}#document-${documentKey}` : null;
  const label = documentKey === "plan" ? "Plan" : doc.data?.title ?? documentKey;
  const slot = typeof document !== "undefined" ? document.getElementById(PROPERTIES_PANE_HEADER_SLOT_ID) : null;
  const tab = <SidePanelTab id="decision-review" label={label} active onSelect={() => {}} onClose={onClose} />;
  return <div className="flex min-h-full flex-col gap-4" data-coordinator-review-panel={item.id}>
    {slot ? createPortal(tab, slot) : tab}
    <header className="space-y-1">
      <h2 className="text-lg font-medium">{doc.data?.title ?? label}</h2>
      {taskHref ? <button type="button" onClick={() => onOpenTask(taskHref)} className="flex max-w-full items-center gap-2 text-left text-sm text-muted-foreground hover:text-foreground">
        <span className="shrink-0">Open in {task?.identifier ?? "task"}</span><ArrowUpRight className="size-4 shrink-0" />
      </button> : null}
    </header>
    <div className="min-h-0 flex-1">
      {doc.isPending ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading {label.toLocaleLowerCase()}…</p>
        : doc.isError || !doc.data ? <p className="text-sm text-muted-foreground">This document couldn't be loaded. Open it in the task instead.</p>
        : <MarkdownBody>{doc.data.body}</MarkdownBody>}
    </div>
    {/* The card's own actions, pinned to the bottom of the artifact. */}
    <div className="coordinator-review-actions sticky bottom-0 -mx-4 border-t border-border bg-card px-4 py-3">
      <AttentionInteractionResolver presentation="coordinator-decision" companyId={companyId} issueId={issueId} interactionId={item.subject.id}
        agentMap={agentMap} currentUserId={currentUserId} userLabelMap={userLabelMap}
        onResolved={resolved => { if (resolved && resolved.status !== "pending") onResolved(); }} />
    </div>
  </div>;
}
