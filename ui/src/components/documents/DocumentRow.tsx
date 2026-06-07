import { useMemo } from "react";
import {
  BarChart3,
  BookOpen,
  ClipboardList,
  FileText,
  ListTodo,
  MessageSquare,
  PencilLine,
  ShieldAlert,
  Link2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CompanyDocumentSummary, DocumentType } from "@paperclipai/shared";
import { EntityRow } from "../EntityRow";
import { Identity, deriveInitials } from "../Identity";
import { relativeTime } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { statusBadge, statusBadgeDefault } from "@/lib/status-colors";

const DOC_TYPE_ICON: Record<DocumentType, LucideIcon> = {
  plan: ListTodo,
  spec: BookOpen,
  brief: ClipboardList,
  report: BarChart3,
  other: FileText,
};

/** Status dot color matching the StatusBadge palette (see status-colors.ts). */
const STATUS_DOT: Record<string, string> = {
  draft: "bg-sky-500",
  in_review: "bg-violet-500",
  approved: "bg-green-500",
  archived: "bg-muted-foreground",
};

const DOC_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  in_review: "In review",
  approved: "Approved",
  archived: "Archived",
};

export interface DocumentOwner {
  name: string;
  avatarUrl?: string | null;
}

interface DocumentRowProps {
  document: CompanyDocumentSummary;
  /** Company prefix used to build the detail link (e.g. "PAP"). */
  to: string;
  owner?: DocumentOwner | null;
  /** Short identifier shown in monospace — typically the issue document key. */
  identifier?: string;
  selected?: boolean;
  companyPrefix?: string;
}

/**
 * Library row for a company document. Reuses `EntityRow` so it matches the
 * issues/projects list rhythm: leading status dot + type icon, monospace
 * identifier, title, then owner / source-trust / feedback-count / updated meta.
 */
export function DocumentRow({ document, to, owner, identifier, selected, companyPrefix }: DocumentRowProps) {
  const TypeIcon = DOC_TYPE_ICON[document.documentType] ?? FileText;
  const counts = document.feedbackCounts;
  const openComments = counts.openComments + counts.openReviewThreads;
  const pendingSuggestions = counts.pendingSuggestions;
  // Source trust: documents are trusted unless their source was quarantined by
  // the trust policy (matches the server-side `trustedOnly` filter).
  const quarantined = document.sourceTrust?.disposition === "quarantined";
  const backlinkCount = document.backlinks.length;

  const primaryBacklink = useMemo(() => {
    const issueLink = document.backlinks.find((link) => link.identifier);
    return issueLink ?? document.backlinks[0] ?? null;
  }, [document.backlinks]);

  const resolvedIdentifier = identifier ?? primaryBacklink?.issueDocumentKey ?? undefined;

  const displayIdentifier = resolvedIdentifier
    ? companyPrefix
      ? `${companyPrefix} · ${resolvedIdentifier}`
      : resolvedIdentifier
    : undefined;

  return (
    <EntityRow
      to={to}
      selected={selected}
      leading={
        <>
          <span
            className={cn("h-2 w-2 shrink-0 rounded-full", STATUS_DOT[document.status] ?? "bg-muted-foreground")}
            aria-hidden="true"
          />
          <TypeIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </>
      }
      identifier={displayIdentifier}
      title={document.title ?? "Untitled document"}
      subtitle={document.summary ?? undefined}
      reserveSubtitleSpace
      meta={
        <>
          <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0", statusBadge[document.status] ?? statusBadgeDefault)}>
            {DOC_STATUS_LABEL[document.status] ?? document.status}
          </span>
          {owner ? (
            <Identity
              name={owner.name}
              avatarUrl={owner.avatarUrl}
              initials={deriveInitials(owner.name)}
              size="sm"
              className="text-muted-foreground"
            />
          ) : null}
          {quarantined ? (
            <span
              className="inline-flex items-center text-amber-600 dark:text-amber-400"
              title="Untrusted source — quarantined by trust policy"
            >
              <ShieldAlert className="h-3.5 w-3.5" aria-label="Untrusted source" />
            </span>
          ) : null}
        </>
      }
      trailing={
        <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
          {backlinkCount > 0 ? (
            <span className="inline-flex items-center gap-0.5" title={`${backlinkCount} linked item(s)`}>
              <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
              {backlinkCount}
            </span>
          ) : null}
          {openComments > 0 ? (
            <span className="inline-flex items-center gap-0.5" title={`${openComments} open comment(s)`}>
              <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
              {openComments}
            </span>
          ) : null}
          {pendingSuggestions > 0 ? (
            <span className="inline-flex items-center gap-0.5" title={`${pendingSuggestions} pending suggestion(s)`}>
              <PencilLine className="h-3.5 w-3.5" aria-hidden="true" />
              {pendingSuggestions}
            </span>
          ) : null}
          <span className="tabular-nums whitespace-nowrap" title={new Date(document.updatedAt).toLocaleString()}>
            {relativeTime(document.updatedAt)}
          </span>
        </div>
      }
    />
  );
}
