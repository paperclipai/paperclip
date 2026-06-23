import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { MarkdownBody } from "./MarkdownBody";
import { cn } from "../lib/utils";
import {
  FileText,
  ExternalLink,
  GitBranch,
  GitCommit,
  Globe,
  Server,
  Package,
  Loader2,
  ArrowLeft,
  X,
  CheckCircle2,
  XCircle,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation, t } from "@/i18n";

interface ArtifactsPanelProps {
  taskId: string;
  isAgentWorking?: boolean;
  /** Open the document viewer directly to a specific doc */
  openDocKey?: string | null;
  openDocTitle?: string | null;
  onClearOpenDoc?: () => void;
  /** Approval callbacks — called from the document viewer */
  onApprove?: () => void;
  onReject?: () => void;
}

type FilterValue = "all" | "in_progress" | "for_review" | "completed";

function getFilters(): Array<{ label: string; value: FilterValue }> {
  return [
    { label: t("components.artifactsPanel.filterAll", { defaultValue: "All" }), value: "all" },
    { label: t("components.artifactsPanel.filterInProgress", { defaultValue: "In Progress" }), value: "in_progress" },
    { label: t("components.artifactsPanel.filterForReview", { defaultValue: "For Review" }), value: "for_review" },
    { label: t("components.artifactsPanel.filterCompleted", { defaultValue: "Completed" }), value: "completed" },
  ];
}

function matchesFilter(wp: IssueWorkProduct, filter: FilterValue): boolean {
  if (filter === "all") return true;
  if (filter === "in_progress") return wp.status === "active" || wp.status === "draft";
  if (filter === "for_review") return wp.status === "ready_for_review";
  if (filter === "completed") return wp.status === "approved" || wp.status === "merged";
  return true;
}

function typeIcon(type: string) {
  switch (type) {
    case "document": return FileText;
    case "pull_request": return GitBranch;
    case "branch": return GitBranch;
    case "commit": return GitCommit;
    case "preview_url": return Globe;
    case "runtime_service": return Server;
    case "artifact": return Package;
    default: return FileText;
  }
}

function statusBadge(status: string) {
  switch (status) {
    case "active":
    case "draft":
      return { label: t("components.artifactsPanel.statusInProgress", { defaultValue: "In Progress" }), className: "bg-blue-500/10 text-blue-600 dark:text-blue-400" };
    case "ready_for_review":
      return { label: t("components.artifactsPanel.statusForReview", { defaultValue: "For Review" }), className: "bg-amber-500/10 text-amber-600 dark:text-amber-400" };
    case "approved":
    case "merged":
      return { label: t("components.artifactsPanel.statusCompleted", { defaultValue: "Completed" }), className: "bg-green-500/10 text-green-600 dark:text-green-400" };
    case "changes_requested":
      return { label: t("components.artifactsPanel.statusChangesRequested", { defaultValue: "Changes Requested" }), className: "bg-orange-500/10 text-orange-600 dark:text-orange-400" };
    case "failed":
      return { label: t("components.artifactsPanel.statusFailed", { defaultValue: "Failed" }), className: "bg-red-500/10 text-red-600 dark:text-red-400" };
    default:
      return { label: status, className: "bg-muted text-muted-foreground" };
  }
}

export function ArtifactsPanel({ taskId, isAgentWorking, openDocKey, openDocTitle, onClearOpenDoc, onApprove, onReject }: ArtifactsPanelProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<FilterValue>("all");
  const [viewingDoc, setViewingDoc] = useState<{ key: string; title: string } | null>(null);

  const { data: workProducts, isLoading } = useQuery({
    queryKey: queryKeys.issues.workProducts(taskId),
    queryFn: () => issuesApi.listWorkProducts(taskId),
    refetchInterval: 5000,
  });

  // Open doc from parent (e.g. clicking plan link in chat)
  const effectiveViewingDoc = openDocKey
    ? { key: openDocKey, title: openDocTitle ?? t("components.artifactsPanel.documentFallbackTitle", { defaultValue: "Document" }) }
    : viewingDoc;

  const handleBack = () => {
    setViewingDoc(null);
    onClearOpenDoc?.();
  };

  // Find the work product for the currently viewed doc to know its status
  const viewedWorkProduct = effectiveViewingDoc
    ? (workProducts ?? []).find((wp) => wp.title === effectiveViewingDoc.title)
    : null;

  const filtered = (workProducts ?? []).filter((wp) => matchesFilter(wp, filter));

  // Document viewer
  if (effectiveViewingDoc) {
    return (
      <DocumentViewer
        taskId={taskId}
        docKey={effectiveViewingDoc.key}
        title={effectiveViewingDoc.title}
        onBack={handleBack}
        status={viewedWorkProduct?.status ?? null}
        reviewState={viewedWorkProduct?.reviewState ?? null}
        onApprove={onApprove}
        onReject={onReject}
      />
    );
  }

  return (
    <div className="flex flex-col h-full" data-artifacts-panel>
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <Package className="h-4 w-4 text-muted-foreground shrink-0" />
        <h3 className="text-sm font-semibold">{t("components.artifactsPanel.heading", { defaultValue: "Artifacts" })}</h3>
      </div>

      {/* Filter chips */}
      <div className="px-4 py-2 flex flex-wrap gap-1 border-b border-border">
        {getFilters().map((f) => (
          <button
            key={f.value}
            className={cn(
              "rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors",
              filter === f.value
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
            )}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Work products list */}
      <div className="flex-1 overflow-y-auto scrollbar-auto-hide">
        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            {t("components.artifactsPanel.loading", { defaultValue: "Loading..." })}
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <Package className="h-8 w-8 mx-auto text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">
              {workProducts?.length === 0
                ? t("components.artifactsPanel.emptyNoArtifacts", { defaultValue: "Your team's deliverables and plans will appear here as they're produced." })
                : t("components.artifactsPanel.emptyNoMatch", { defaultValue: "No artifacts match this filter." })}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((wp) => {
              const Icon = typeIcon(wp.type);
              const badge = statusBadge(wp.status);
              const isDraft = wp.status === "draft" || wp.status === "active";
              const showGenerating = isDraft && isAgentWorking;
              return (
                <button
                  key={wp.id}
                  className={cn(
                    "w-full text-left px-4 py-3 hover:bg-accent/30 transition-colors",
                    showGenerating && "bg-muted/30",
                  )}
                  onClick={() => {
                    if (wp.type === "document") {
                      setViewingDoc({ key: "plan", title: wp.title });
                    } else if (wp.url) {
                      window.open(wp.url, "_blank", "noopener,noreferrer");
                    }
                  }}
                >
                  <div className="flex items-start gap-2.5">
                    {showGenerating ? (
                      <div className="mt-0.5 shrink-0">
                        <span className="relative flex h-4 w-4">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                          <span className="relative inline-flex rounded-full h-4 w-4 bg-cyan-500" />
                        </span>
                      </div>
                    ) : (
                      <Icon className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{wp.title}</span>
                        {wp.url && (
                          <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] text-muted-foreground capitalize">
                          {wp.type.replace(/_/g, " ")}
                        </span>
                        {showGenerating ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-600 dark:text-cyan-400">
                            <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            {t("components.artifactsPanel.generating", { defaultValue: "Generating..." })}
                          </span>
                        ) : (
                          <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded-full", badge.className)}>
                            {badge.label}
                          </span>
                        )}
                      </div>
                      {wp.summary && (
                        <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2">
                          {wp.summary}
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function DocumentViewer({
  taskId,
  docKey,
  title,
  onBack,
  status,
  reviewState,
  onApprove,
  onReject,
}: {
  taskId: string;
  docKey: string;
  title: string;
  onBack: () => void;
  status: string | null;
  reviewState: string | null;
  onApprove?: () => void;
  onReject?: () => void;
}) {
  const { t } = useTranslation();
  const { data: doc, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.documents(taskId),
    queryFn: () => issuesApi.getDocument(taskId, docKey),
  });

  const needsAction = status === "ready_for_review" || reviewState === "needs_board_review";
  const isApproved = status === "approved" || reviewState === "approved";
  const isRejected = status === "changes_requested" || reviewState === "changes_requested";

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <button onClick={onBack} className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h3 className="text-sm font-semibold flex-1 truncate">{title}</h3>
        <button onClick={onBack} className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-auto-hide p-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            {t("components.artifactsPanel.loadingDocument", { defaultValue: "Loading document..." })}
          </div>
        ) : error ? (
          <p className="text-sm text-muted-foreground">{t("components.artifactsPanel.documentNotAvailable", { defaultValue: "Document not available yet." })}</p>
        ) : doc?.body ? (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <MarkdownBody>{doc.body}</MarkdownBody>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("components.artifactsPanel.documentEmpty", { defaultValue: "Document is empty." })}</p>
        )}
      </div>

      {/* Sticky action footer */}
      {needsAction && (
        <div className="border-t border-border px-4 py-3 bg-background shrink-0">
          <p className="text-[11px] text-muted-foreground mb-2">{t("components.artifactsPanel.needsReview", { defaultValue: "This document needs your review." })}</p>
          <div className="flex items-center gap-3">
            <Button size="lg" className="h-11 px-8 text-base font-semibold flex-1 rounded-lg bg-green-700 hover:bg-green-800 text-white border-0" onClick={onApprove}>
              {t("components.artifactsPanel.approve", { defaultValue: "Approve" })}
            </Button>
            <Button size="lg" className="h-11 px-8 text-base font-semibold flex-1 rounded-lg bg-red-900 hover:bg-red-950 text-white border-0" onClick={() => {
              onReject?.();
              onBack();
            }}>
              {t("components.artifactsPanel.reject", { defaultValue: "Reject" })}
            </Button>
          </div>
        </div>
      )}
      {isApproved && (
        <div className="border-t border-green-500/30 bg-green-500/5 px-4 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            <p className="text-[13px] font-medium text-green-700 dark:text-green-400">
              {t("components.artifactsPanel.approvedHireTasksCreated", { defaultValue: "Approved — hire tasks created" })}
            </p>
          </div>
        </div>
      )}
      {isRejected && (
        <div className="border-t border-orange-500/30 bg-orange-500/5 px-4 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <XCircle className="h-4 w-4 text-orange-500" />
            <p className="text-[13px] font-medium text-orange-700 dark:text-orange-400">
              {t("components.artifactsPanel.changesRequestedCeoRevising", { defaultValue: "Changes requested — CEO is revising" })}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
