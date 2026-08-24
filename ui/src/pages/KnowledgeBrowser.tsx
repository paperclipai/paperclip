import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search,
  X,
  BookOpen,
  FileText,
  Clock,
  AlertCircle,
  Loader2,
  MoreHorizontal,
  Eye,
  Trash2,
  Plus,
  Send,
  CheckCircle,
  Archive,
  GitBranch,
  Link,
} from "lucide-react";
import { knowledgeApi } from "../api/knowledge";
import type {
  KnowledgeDocument,
  KnowledgeDocumentListItem,
  KnowledgeDocumentRevision,
  KnowledgeDocumentDiff,
  KnowledgeSourceBacklink,
  SearchPublishedResult,
} from "../api/knowledge";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { MarkdownBody } from "../components/MarkdownBody";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { usePageMeta } from "../hooks/usePageMeta";

// ─── Constants ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function statusColor(status: string): string {
  switch (status) {
    case "draft":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300";
    case "in_review":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300";
    case "published":
      return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300";
    case "archived":
      return "bg-gray-100 text-gray-600 dark:bg-gray-800/50 dark:text-gray-400";
    default:
      return "bg-gray-100 text-gray-700 dark:bg-gray-800/50 dark:text-gray-300";
  }
}

function reviewStatusColor(status: string): string {
  switch (status) {
    case "approved":
      return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300";
    case "changes_requested":
      return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300";
    case "pending":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300";
    default:
      return "bg-gray-100 text-gray-700 dark:bg-gray-800/50 dark:text-gray-300";
  }
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

function sentenceCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Status Badge ────────────────────────────────────────────────────────────

function StatusBadgeKn({ status }: { status: string }) {
  return (
    <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium", statusColor(status))}>
      {sentenceCase(status)}
    </span>
  );
}

// ─── Search Result Card ──────────────────────────────────────────────────────

function SearchResultCard({
  result,
  onSelect,
}: {
  result: SearchPublishedResult;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full text-left group rounded-lg border border-border bg-card p-3 transition-colors hover:border-border/80 hover:bg-accent/30"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1 flex-wrap">
            <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground bg-muted/50">
              <FileText className="h-3 w-3" />
              Published
            </span>
            <span className="text-[10px] text-muted-foreground bg-accent/30 rounded px-1 py-0.5">
              {(result.score * 100).toFixed(0)}% match
            </span>
          </div>
          <p className="text-sm font-medium text-foreground/90">{result.title}</p>
          {result.summary && (
            <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{result.summary}</p>
          )}
        </div>
      </div>
    </button>
  );
}

// ─── Document Card ───────────────────────────────────────────────────────────

function DocumentCard({
  doc,
  onSelect,
}: {
  doc: KnowledgeDocumentListItem;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full text-left group rounded-lg border border-border bg-card p-3 transition-colors hover:border-border/80 hover:bg-accent/30"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1 flex-wrap">
            <StatusBadgeKn status={doc.status} />
            {doc.latestReviewStatus && (
              <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium", reviewStatusColor(doc.latestReviewStatus))}>
                {sentenceCase(doc.latestReviewStatus)}
              </span>
            )}
            <span className="text-[10px] text-muted-foreground">v{doc.version}</span>
            <span className="text-[10px] text-muted-foreground ml-auto">{formatDate(doc.updatedAt)}</span>
          </div>
          <p className="text-sm font-medium text-foreground/90">{doc.title}</p>
          {doc.summary && (
            <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{doc.summary}</p>
          )}
          <div className="flex items-center gap-3 mt-1.5 text-[10px] text-muted-foreground">
            <span>{doc.revisionCount} revision{doc.revisionCount !== 1 ? "s" : ""}</span>
            {doc.publishedAt && <span>Published {formatDate(doc.publishedAt)}</span>}
          </div>
        </div>
      </div>
    </button>
  );
}

// ─── Backlinks Section ───────────────────────────────────────────────────────

function BacklinksSection({ backlinks }: { backlinks: KnowledgeSourceBacklink[] }) {
  if (backlinks.length === 0) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-2">Backlinks</h3>
      <div className="space-y-1">
        {backlinks.map((bl) => (
          <div key={bl.id} className="flex items-center gap-2 text-xs text-muted-foreground">
            <Link className="h-3 w-3 shrink-0" />
            <span className="truncate">{bl.sourceIssueId}</span>
            <Badge variant="outline" className="text-[10px]">{bl.sourceType.replace(/_/g, " ")}</Badge>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Diff Viewer ─────────────────────────────────────────────────────────────

function DiffViewer({ diff }: { diff: KnowledgeDocumentDiff }) {
  return (
    <div className="space-y-3">
      {/* Title change */}
      {diff.titleChanged && (
        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <h4 className="text-xs font-semibold text-muted-foreground mb-1">Title</h4>
          <p className="text-sm line-through text-red-500">{diff.oldTitle}</p>
          <p className="text-sm text-green-500">{diff.newTitle}</p>
        </div>
      )}

      {/* Summary change */}
      {diff.summaryChanged && (
        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <h4 className="text-xs font-semibold text-muted-foreground mb-1">Summary</h4>
          <p className="text-sm line-through text-red-500">{diff.oldSummary}</p>
          <p className="text-sm text-green-500">{diff.newSummary}</p>
        </div>
      )}

      {/* Body diff */}
      <div className="rounded-lg border border-border bg-muted/30">
        <h4 className="text-xs font-semibold text-muted-foreground px-3 pt-3 pb-1">Body</h4>
        <pre className="p-3 text-xs leading-relaxed overflow-x-auto whitespace-pre-wrap">
          {diff.bodyDiff.split("\n").map((line, i) => {
            const trimmed = line.trim();
            if (line.startsWith("+")) {
              return <div key={i} className="bg-green-500/10 text-green-600 dark:text-green-400 rounded px-1 -mx-1">{line}</div>;
            }
            if (line.startsWith("-")) {
              return <div key={i} className="bg-red-500/10 text-red-600 dark:text-red-400 rounded px-1 -mx-1">{line}</div>;
            }
            return <div key={i} className="text-muted-foreground">{line}</div>;
          })}
        </pre>
      </div>

      {diff.changeDescription && (
        <div className="text-xs text-muted-foreground">
          <span className="font-semibold">Change description:</span> {diff.changeDescription}
        </div>
      )}
    </div>
  );
}

// ─── Revisions Tab ───────────────────────────────────────────────────────────

function RevisionsTab({
  companyId,
  documentId,
}: {
  companyId: string;
  documentId: string;
}) {
  const { data: revisions, isLoading, error } = useQuery({
    queryKey: queryKeys.knowledge.revisions(companyId, documentId),
    queryFn: () => knowledgeApi.listRevisions(companyId, documentId),
    enabled: !!companyId && !!documentId,
  });

  const [revA, setRevA] = useState<string | null>(null);
  const [revB, setRevB] = useState<string | null>(null);

  const sortedRevisions = useMemo(() => {
    if (!revisions) return [];
    return [...revisions].sort((a, b) => b.version - a.version);
  }, [revisions]);

  // Auto-select last two
  useEffect(() => {
    if (sortedRevisions.length >= 2 && !revA && !revB) {
      setRevA(sortedRevisions[1].id);
      setRevB(sortedRevisions[0].id);
    }
  }, [sortedRevisions, revA, revB]);

  const diffQuery = useQuery({
    queryKey: queryKeys.knowledge.revisionDiff(companyId, documentId, revA ?? "", revB ?? ""),
    queryFn: () => knowledgeApi.diff(companyId, documentId, revA!, revB!),
    enabled: !!revA && !!revB && revA !== revB,
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border p-4 text-sm text-destructive">
        <AlertCircle className="h-4 w-4" />
        {(error as Error).message}
      </div>
    );
  }

  if (!revisions || revisions.length === 0) {
    return <EmptyState icon={GitBranch} message="No revisions recorded." />;
  }

  return (
    <div className="space-y-4">
      {/* Revision selector */}
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <Select
            value={revA ?? undefined}
            onValueChange={(val) => setRevA(val)}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Old version..." />
            </SelectTrigger>
            <SelectContent>
              {sortedRevisions.map((r) => (
                <SelectItem key={r.id} value={r.id} className="text-xs">
                  v{r.version} — {formatDate(r.createdAt)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">→</span>
        <div className="flex-1">
          <Select
            value={revB ?? undefined}
            onValueChange={(val) => setRevB(val)}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="New version..." />
            </SelectTrigger>
            <SelectContent>
              {sortedRevisions.map((r) => (
                <SelectItem key={r.id} value={r.id} className="text-xs">
                  v{r.version} — {formatDate(r.createdAt)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Diff output */}
      {diffQuery.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Computing diff...
        </div>
      )}
      {diffQuery.error && (
        <div className="flex items-center gap-2 rounded-lg border border-border p-4 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {(diffQuery.error as Error).message}
        </div>
      )}
      {diffQuery.data && (
        <DiffViewer diff={diffQuery.data} />
      )}

      {/* Revision list */}
      <Separator />
      <h4 className="text-xs font-semibold text-muted-foreground uppercase">All Revisions</h4>
      <div className="border border-border rounded-lg divide-y divide-border">
        {sortedRevisions.map((rev) => (
          <div key={rev.id} className="flex items-center justify-between px-3 py-2 text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <Badge variant="outline" className="text-[10px] shrink-0">v{rev.version}</Badge>
              <span className="truncate text-muted-foreground">{rev.changeDescription ?? "No description"}</span>
            </div>
            <span className="text-muted-foreground shrink-0 ml-2">{formatDate(rev.createdAt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Document Detail Sheet ────────────────────────────────────────────────────

function DocumentDetailSheet({
  documentId,
  companyId,
  open,
  onOpenChange,
  onDeleted,
}: {
  documentId: string | null;
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [activeTab, setActiveTab] = useState("detail");

  const { data: doc, isLoading, error } = useQuery({
    queryKey: queryKeys.knowledge.detail(companyId, documentId ?? ""),
    queryFn: () => knowledgeApi.get(companyId, documentId!),
    enabled: open && !!documentId,
  });

  const backlinksQuery = useQuery({
    queryKey: queryKeys.knowledge.backlinks(companyId, documentId ?? ""),
    queryFn: () => knowledgeApi.listBacklinks(companyId, documentId!),
    enabled: open && !!documentId,
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["knowledge", companyId] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.detail(companyId, documentId ?? "") });
    void queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.revisions(companyId, documentId ?? "") });
  }, [queryClient, companyId, documentId]);

  // ── Mutations ──────────────────────────────────────────────────────────

  const submitReviewMutation = useMutation({
    mutationFn: () => {
      if (!documentId) throw new Error("No document selected");
      return knowledgeApi.submitForReview(companyId, documentId);
    },
    onSuccess: () => {
      pushToast({ title: "Submitted for review", tone: "success" });
      invalidate();
    },
    onError: (err) => pushToast({ title: "Failed to submit", body: (err as Error).message, tone: "error" }),
  });

  const publishMutation = useMutation({
    mutationFn: (changeDescription?: string) => {
      if (!documentId) throw new Error("No document selected");
      return knowledgeApi.publish(companyId, documentId, { changeDescription });
    },
    onSuccess: () => {
      pushToast({ title: "Published", tone: "success" });
      invalidate();
    },
    onError: (err) => pushToast({ title: "Failed to publish", body: (err as Error).message, tone: "error" }),
  });

  const archiveMutation = useMutation({
    mutationFn: () => {
      if (!documentId) throw new Error("No document selected");
      return knowledgeApi.archive(companyId, documentId);
    },
    onSuccess: () => {
      pushToast({ title: "Archived", tone: "success" });
      invalidate();
    },
    onError: (err) => pushToast({ title: "Failed to archive", body: (err as Error).message, tone: "error" }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!documentId) throw new Error("No document selected");
      return knowledgeApi.remove(companyId, documentId);
    },
    onSuccess: () => {
      pushToast({ title: "Document deleted", tone: "success" });
      onOpenChange(false);
      invalidate();
      onDeleted();
    },
    onError: (err) => pushToast({ title: "Failed to delete", body: (err as Error).message, tone: "error" }),
  });

  // ── Review Dialog State ────────────────────────────────────────────────

  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [reviewDecision, setReviewDecision] = useState<"approved" | "changes_requested">("approved");
  const [reviewComment, setReviewComment] = useState("");

  const reviewMutation = useMutation({
    mutationFn: () => {
      if (!documentId) throw new Error("No document selected");
      return knowledgeApi.review(companyId, documentId, { status: reviewDecision, comment: reviewComment || undefined });
    },
    onSuccess: () => {
      pushToast({ title: reviewDecision === "approved" ? "Document approved" : "Changes requested", tone: "success" });
      setReviewDialogOpen(false);
      setReviewComment("");
      invalidate();
    },
    onError: (err) => pushToast({ title: "Review failed", body: (err as Error).message, tone: "error" }),
  });

  // ── Archive Confirm Dialog State ───────────────────────────────────────

  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);

  // ── Edit Dialog State ──────────────────────────────────────────────────

  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editSummary, setEditSummary] = useState("");
  const [editBody, setEditBody] = useState("");

  const editMutation = useMutation({
    mutationFn: () => {
      if (!documentId) throw new Error("No document selected");
      return knowledgeApi.update(companyId, documentId, {
        title: editTitle,
        summary: editSummary || undefined,
        body: editBody,
      });
    },
    onSuccess: () => {
      pushToast({ title: "Document updated", tone: "success" });
      setEditDialogOpen(false);
      invalidate();
    },
    onError: (err) => pushToast({ title: "Failed to update", body: (err as Error).message, tone: "error" }),
  });

  // Sync form fields when document loads
  useEffect(() => {
    if (doc) {
      setEditTitle(doc.title);
      setEditSummary(doc.summary ?? "");
      setEditBody(doc.body);
    }
  }, [doc]);

  if (!documentId) return null;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          {isLoading && (
            <div className="space-y-4">
              <Skeleton className="h-6 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-32 w-full" />
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-border p-4 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {(error as Error).message}
            </div>
          )}

          {doc && (
            <>
              <SheetHeader className="space-y-1">
                <SheetTitle className="flex items-center gap-2 text-base">
                  <BookOpen className="h-4 w-4" />
                  <span className="truncate">{doc.title}</span>
                </SheetTitle>
                <SheetDescription className="text-xs">
                  <div className="flex items-center gap-2 flex-wrap">
                    <StatusBadgeKn status={doc.status} />
                    <span>v{doc.version}</span>
                    <span>ID: {doc.id.slice(0, 8)}...</span>
                  </div>
                </SheetDescription>
              </SheetHeader>

              <div className="mt-6 space-y-5">
                {/* Metadata */}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {doc.authorAgentId && <span>Author: {doc.authorAgentId.slice(0, 8)}...</span>}
                  <span>Created: {formatDate(doc.createdAt)}</span>
                  <span>Updated: {formatDate(doc.updatedAt)}</span>
                  {doc.publishedAt && <span>Published: {formatDate(doc.publishedAt)}</span>}
                </div>

                {/* Actions (based on status) */}
                <div className="flex flex-wrap gap-2">
                  {/* Draft: edit, submit for review, delete */}
                  {doc.status === "draft" && (
                    <>
                      <Button variant="outline" size="sm" onClick={() => setEditDialogOpen(true)}>
                        <FileText className="h-3.5 w-3.5 mr-1.5" />
                        Edit
                      </Button>
                      <Button variant="default" size="sm" onClick={() => submitReviewMutation.mutate()} disabled={submitReviewMutation.isPending}>
                        <Send className="h-3.5 w-3.5 mr-1.5" />
                        {submitReviewMutation.isPending ? "Submitting..." : "Submit for Review"}
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => deleteMutation.mutate()} disabled={deleteMutation.isPending}>
                        <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                        Delete
                      </Button>
                    </>
                  )}

                  {/* In review: approve / request changes */}
                  {doc.status === "in_review" && (
                    <>
                      <Button
                        variant="default"
                        size="sm"
                        onClick={() => {
                          setReviewDecision("approved");
                          setReviewDialogOpen(true);
                        }}
                      >
                        <CheckCircle className="h-3.5 w-3.5 mr-1.5" />
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setReviewDecision("changes_requested");
                          setReviewDialogOpen(true);
                        }}
                      >
                        <AlertCircle className="h-3.5 w-3.5 mr-1.5" />
                        Request Changes
                      </Button>
                    </>
                  )}

                  {/* Published: archive */}
                  {doc.status === "published" && (
                    <Button variant="outline" size="sm" onClick={() => setArchiveDialogOpen(true)}>
                      <Archive className="h-3.5 w-3.5 mr-1.5" />
                      Archive
                    </Button>
                  )}
                </div>

                <Separator />

                {/* Tabs: Detail / Revisions */}
                <Tabs value={activeTab} onValueChange={setActiveTab}>
                  <TabsList>
                    <TabsTrigger value="detail" className="text-xs">
                      <FileText className="h-3.5 w-3.5 mr-1.5" />
                      Detail
                    </TabsTrigger>
                    <TabsTrigger value="revisions" className="text-xs">
                      <GitBranch className="h-3.5 w-3.5 mr-1.5" />
                      Revisions
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="detail" className="mt-4 space-y-4">
                    {/* Summary */}
                    {doc.summary && (
                      <div>
                        <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-2">Summary</h3>
                        <p className="text-sm text-muted-foreground">{doc.summary}</p>
                      </div>
                    )}

                    {/* Body */}
                    <div>
                      <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-2">Body</h3>
                      <div className="rounded-lg border border-border bg-muted/30 p-3">
                        {doc.body ? (
                          <MarkdownBody className="text-sm">{doc.body}</MarkdownBody>
                        ) : (
                          <p className="text-sm text-muted-foreground italic">No content</p>
                        )}
                      </div>
                    </div>

                    {/* Backlinks */}
                    <BacklinksSection backlinks={backlinksQuery.data ?? []} />
                  </TabsContent>

                  <TabsContent value="revisions" className="mt-4">
                    <RevisionsTab companyId={companyId} documentId={doc.id} />
                  </TabsContent>
                </Tabs>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Review Dialog */}
      <Dialog open={reviewDialogOpen} onOpenChange={setReviewDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-base">
              {reviewDecision === "approved" ? "Approve Document" : "Request Changes"}
            </DialogTitle>
            <DialogDescription>
              {reviewDecision === "approved"
                ? "This will mark the document as approved and ready for publishing."
                : "Request changes to the document before it can be published."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="review-comment" className="text-xs">Comment (optional)</Label>
              <Textarea
                id="review-comment"
                value={reviewComment}
                onChange={(e) => setReviewComment(e.currentTarget.value)}
                placeholder="Add a review comment..."
                className="mt-1 h-20 text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setReviewDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant={reviewDecision === "approved" ? "default" : "destructive"}
              onClick={() => reviewMutation.mutate()}
              disabled={reviewMutation.isPending}
            >
              {reviewMutation.isPending ? "Submitting..." : reviewDecision === "approved" ? "Approve" : "Request Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Archive Dialog */}
      <Dialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-base">Archive Document</DialogTitle>
            <DialogDescription>
              This will archive the published document. It will no longer appear in search results.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setArchiveDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                archiveMutation.mutate();
                setArchiveDialogOpen(false);
              }}
              disabled={archiveMutation.isPending}
            >
              {archiveMutation.isPending ? "Archiving..." : "Archive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-base">Edit Document</DialogTitle>
            <DialogDescription>Update the title, summary, or body of this draft.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="edit-title" className="text-xs">Title</Label>
              <Input
                id="edit-title"
                value={editTitle}
                onChange={(e) => setEditTitle(e.currentTarget.value)}
                className="mt-1 text-sm"
              />
            </div>
            <div>
              <Label htmlFor="edit-summary" className="text-xs">Summary</Label>
              <Input
                id="edit-summary"
                value={editSummary}
                onChange={(e) => setEditSummary(e.currentTarget.value)}
                placeholder="Brief summary of the document..."
                className="mt-1 text-sm"
              />
            </div>
            <div>
              <Label htmlFor="edit-body" className="text-xs">Body (Markdown)</Label>
              <Textarea
                id="edit-body"
                value={editBody}
                onChange={(e) => setEditBody(e.currentTarget.value)}
                placeholder="Document content in Markdown..."
                className="mt-1 h-48 text-sm font-mono"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => editMutation.mutate()} disabled={editMutation.isPending || !editTitle.trim()}>
              {editMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Create Document Dialog ──────────────────────────────────────────────────

function CreateDocumentDialog({
  open,
  onOpenChange,
  companyId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  onCreated: () => void;
}) {
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");

  const createMutation = useMutation({
    mutationFn: () =>
      knowledgeApi.create(companyId, {
        title,
        summary: summary || undefined,
        body,
      }),
    onSuccess: () => {
      pushToast({ title: "Document created", tone: "success" });
      setTitle("");
      setSummary("");
      setBody("");
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ["knowledge", companyId] });
      onCreated();
    },
    onError: (err) => pushToast({ title: "Failed to create", body: (err as Error).message, tone: "error" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-base">Create Knowledge Document</DialogTitle>
          <DialogDescription>Create a new knowledge document. It will start as a draft.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="new-title" className="text-xs">Title *</Label>
            <Input
              id="new-title"
              value={title}
              onChange={(e) => setTitle(e.currentTarget.value)}
              placeholder="Document title..."
              className="mt-1 text-sm"
            />
          </div>
          <div>
            <Label htmlFor="new-summary" className="text-xs">Summary</Label>
            <Input
              id="new-summary"
              value={summary}
              onChange={(e) => setSummary(e.currentTarget.value)}
              placeholder="Brief summary..."
              className="mt-1 text-sm"
            />
          </div>
          <div>
            <Label htmlFor="new-body" className="text-xs">Body (Markdown)</Label>
            <Textarea
              id="new-body"
              value={body}
              onChange={(e) => setBody(e.currentTarget.value)}
              placeholder="Document content in Markdown..."
              className="mt-1 h-48 text-sm font-mono"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || !title.trim()}
          >
            {createMutation.isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

  usePageMeta("Knowledge", "Browse and search company knowledge base.");
export function KnowledgeBrowser() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [draftSearch, setDraftSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("__all__");

  // Detail sheet state
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // Create dialog state
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const isSearching = searchQuery.trim().length > 0;

  useEffect(() => {
    setBreadcrumbs([{ label: "Knowledge Base" }]);
  }, [setBreadcrumbs]);

  // Sync draft search → committed search on debounce
  useEffect(() => {
    const trimmed = draftSearch.trim();
    if (trimmed === searchQuery) return;
    const handle = window.setTimeout(() => {
      setSearchQuery(trimmed);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [draftSearch, searchQuery]);

  // ── List Query (infinite scroll) ──────────────────────────────────────────

  const listQuery = useInfiniteQuery({
    queryKey: [
      "knowledge",
      selectedCompanyId,
      "list",
      statusFilter,
      searchQuery,
    ],
    queryFn: ({ pageParam }) => {
      if (!selectedCompanyId) return { items: [], nextCursor: undefined };

      if (isSearching) {
        // When searching, use searchPublished endpoint
        return knowledgeApi.searchPublished(selectedCompanyId, searchQuery, PAGE_SIZE * 2).then((results) => ({
          items: results.map((r) => ({
            id: r.id,
            title: r.title,
            summary: r.summary,
            status: "published" as const,
            version: 0,
            createdAt: "",
            updatedAt: "",
            revisionCount: 0,
          })),
          nextCursor: undefined,
        }));
      }

      return knowledgeApi.list(selectedCompanyId, {
        status: statusFilter === "__all__" ? undefined : statusFilter as any,
        cursor: pageParam,
        limit: PAGE_SIZE,
      });
    },
    enabled: !!selectedCompanyId,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  // ── Infinite Scroll ──────────────────────────────────────────────────────

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || listQuery.hasNextPage === false || listQuery.isFetchingNextPage || isSearching) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void listQuery.fetchNextPage();
      }
    }, { rootMargin: "320px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [listQuery.fetchNextPage, listQuery.hasNextPage, listQuery.isFetchingNextPage, isSearching]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleSelect = useCallback((docId: string) => {
    setSelectedDocumentId(docId);
    setDetailOpen(true);
  }, []);

  const handleClearSearch = useCallback(() => {
    setDraftSearch("");
    setSearchQuery("");
  }, []);

  const handleCreated = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["knowledge", selectedCompanyId] });
  }, [queryClient, selectedCompanyId]);

  const handleDeleted = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["knowledge", selectedCompanyId] });
  }, [queryClient, selectedCompanyId]);

  // ── Derived Data ──────────────────────────────────────────────────────────

  const items = useMemo(
    () => listQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [listQuery.data],
  );

  const showInfiniteScroll = !isSearching && listQuery.hasNextPage;

  // ── Render ────────────────────────────────────────────────────────────────

  if (!selectedCompanyId) {
    return <EmptyState icon={BookOpen} message="Select a company to view knowledge base." />;
  }

  return (
    <div className="w-full max-w-5xl space-y-5">
      {/* Header: Search + Status filter + Create button */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={draftSearch}
            onChange={(event) => setDraftSearch(event.currentTarget.value)}
            placeholder="Search published knowledge..."
            aria-label="Search knowledge"
            className="h-9 pl-9 pr-9 text-sm"
          />
          {draftSearch.length > 0 ? (
            <button
              type="button"
              onClick={handleClearSearch}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          {/* Status filter (only when not searching) */}
          {!isSearching && (
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[140px] h-9 text-sm">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All Statuses</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="in_review">In Review</SelectItem>
                <SelectItem value="published">Published</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
          )}

          <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New Document
          </Button>
        </div>
      </div>

      {/* Search results count */}
      {isSearching && (
        <p className="text-xs text-muted-foreground">
          {listQuery.isFetching
            ? "Searching..."
            : `${items.length} result${items.length !== 1 ? "s" : ""} for "${searchQuery}"`
          }
        </p>
      )}

      {/* Error */}
      {listQuery.error && (
        <div className="flex items-center gap-2 rounded-lg border border-border p-4 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {(listQuery.error as Error).message}
        </div>
      )}

      {/* Content */}
      {listQuery.isPending ? (
        <PageSkeleton variant="list" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          message={isSearching ? "No published documents match your search." : "No knowledge documents yet. Create one!"}
        />
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            if ("score" in item && typeof (item as any).score === "number") {
              // Search result
              const sr = item as unknown as SearchPublishedResult;
              return (
                <SearchResultCard
                  key={sr.id}
                  result={sr}
                  onSelect={() => handleSelect(sr.id)}
                />
              );
            }
            const doc = item as KnowledgeDocumentListItem;
            return (
              <DocumentCard
                key={doc.id}
                doc={doc}
                onSelect={() => handleSelect(doc.id)}
              />
            );
          })}

          {/* Infinite scroll sentinel */}
          <div
            ref={loadMoreRef}
            className="flex min-h-10 items-center justify-center pb-2 text-xs text-muted-foreground"
          >
            {listQuery.isFetchingNextPage ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading more...
              </span>
            ) : showInfiniteScroll ? null : listQuery.isFetching ? (
              "Updating..."
            ) : null}
          </div>
        </div>
      )}

      {/* Detail Sheet */}
      <DocumentDetailSheet
        documentId={selectedDocumentId}
        companyId={selectedCompanyId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onDeleted={handleDeleted}
      />

      {/* Create Dialog */}
      <CreateDocumentDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        companyId={selectedCompanyId}
        onCreated={handleCreated}
      />
    </div>
  );
}