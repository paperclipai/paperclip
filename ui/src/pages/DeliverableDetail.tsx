import { useEffect, useState } from "react";
import { useParams, useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { deliverablesApi, type Deliverable, type DeliverableReviewStage } from "../api/deliverables";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { DeliverableStatusBadge, DeliverablePriorityBadge } from "../components/DeliverableStatusBadge";
import { PageSkeleton } from "../components/PageSkeleton";
import { MarkdownBody } from "../components/MarkdownBody";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  Send,
  CheckCircle2,
  XCircle,
  RotateCcw,
  MessageSquare,
  FileText,
  Link2,
  Code2,
  Eye,
  Plus,
  Trash2,
  SkipForward,
  ArrowLeftRight,
  ChevronRight,
  Bot,
  User,
  Clock,
  Layers,
} from "lucide-react";

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

const CONTENT_KIND_ICON: Record<string, typeof FileText> = {
  file: FileText,
  url: Link2,
  markdown: FileText,
  code_ref: Code2,
  preview: Eye,
};

const STAGE_STATUS_CONFIG: Record<string, { icon: typeof CheckCircle2; color: string }> = {
  pending: { icon: Clock, color: "text-muted-foreground" },
  approved: { icon: CheckCircle2, color: "text-[var(--status-active)]" },
  changes_requested: { icon: RotateCcw, color: "text-[var(--status-warning)]" },
  rejected: { icon: XCircle, color: "text-[var(--status-error)]" },
  skipped: { icon: SkipForward, color: "text-gray-400" },
};

export function DeliverableDetail() {
  const { deliverableId } = useParams<{ deliverableId: string }>();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [commentBody, setCommentBody] = useState("");
  const [decisionNote, setDecisionNote] = useState("");
  const [showAddContent, setShowAddContent] = useState(false);
  const [showAddStage, setShowAddStage] = useState(false);

  const { data: deliverable, isLoading } = useQuery({
    queryKey: queryKeys.deliverables.detail(deliverableId!),
    queryFn: () => deliverablesApi.get(deliverableId!),
    enabled: !!deliverableId,
  });

  const { data: comments } = useQuery({
    queryKey: queryKeys.deliverables.comments(deliverableId!),
    queryFn: () => deliverablesApi.listComments(deliverableId!),
    enabled: !!deliverableId,
  });

  useEffect(() => {
    if (!deliverable?.companyId || deliverable.companyId === selectedCompanyId) return;
    setSelectedCompanyId(deliverable.companyId, { source: "route_sync" });
  }, [deliverable?.companyId, selectedCompanyId, setSelectedCompanyId]);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Deliverables", href: "/deliverables" },
      { label: deliverable?.title ?? deliverableId?.slice(0, 8) ?? "Detail" },
    ]);
  }, [setBreadcrumbs, deliverable, deliverableId]);

  const refresh = () => {
    if (!deliverableId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.deliverables.detail(deliverableId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.deliverables.comments(deliverableId) });
    if (deliverable?.companyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.deliverables.list(deliverable.companyId) });
    }
  };

  // ── Mutations ────────────────────────────────────────────────────
  const submitMutation = useMutation({
    mutationFn: () => deliverablesApi.submit(deliverableId!),
    onSuccess: () => { refresh(); pushToast({ title: "Submitted for review", tone: "success" }); },
    onError: (err) => pushToast({ title: "Failed to submit", body: err.message, tone: "error" }),
  });

  const approveStageMutation = useMutation({
    mutationFn: (stageId: string) => deliverablesApi.approveStage(deliverableId!, stageId, decisionNote || undefined),
    onSuccess: () => { setDecisionNote(""); refresh(); pushToast({ title: "Stage approved", tone: "success" }); },
    onError: (err) => pushToast({ title: "Failed to approve", body: err.message, tone: "error" }),
  });

  const requestChangesMutation = useMutation({
    mutationFn: (stageId: string) => deliverablesApi.requestChanges(deliverableId!, stageId, decisionNote || undefined),
    onSuccess: () => { setDecisionNote(""); refresh(); pushToast({ title: "Changes requested", tone: "warn" }); },
    onError: (err) => pushToast({ title: "Failed to request changes", body: err.message, tone: "error" }),
  });

  const rejectStageMutation = useMutation({
    mutationFn: (stageId: string) => deliverablesApi.rejectStage(deliverableId!, stageId, decisionNote || undefined),
    onSuccess: () => { setDecisionNote(""); refresh(); pushToast({ title: "Stage rejected", tone: "error" }); },
    onError: (err) => pushToast({ title: "Failed to reject", body: err.message, tone: "error" }),
  });

  const skipStageMutation = useMutation({
    mutationFn: (stageId: string) => deliverablesApi.skipStage(deliverableId!, stageId),
    onSuccess: () => { refresh(); pushToast({ title: "Stage skipped", tone: "info" }); },
    onError: (err) => pushToast({ title: "Failed to skip stage", body: err.message, tone: "error" }),
  });

  const reopenMutation = useMutation({
    mutationFn: () => deliverablesApi.reopen(deliverableId!),
    onSuccess: () => { refresh(); pushToast({ title: "Deliverable reopened", tone: "info" }); },
    onError: (err) => pushToast({ title: "Failed to reopen", body: err.message, tone: "error" }),
  });

  const addCommentMutation = useMutation({
    mutationFn: (body: string) => deliverablesApi.addComment(deliverableId!, body),
    onSuccess: () => {
      setCommentBody("");
      queryClient.invalidateQueries({ queryKey: queryKeys.deliverables.comments(deliverableId!) });
      pushToast({ title: "Comment added", tone: "success" });
    },
    onError: (err) => pushToast({ title: "Failed to add comment", body: err.message, tone: "error" }),
  });

  const addContentMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => deliverablesApi.addContent(deliverableId!, data),
    onSuccess: () => { setShowAddContent(false); refresh(); pushToast({ title: "Content added", tone: "success" }); },
    onError: (err) => pushToast({ title: "Failed to add content", body: err.message, tone: "error" }),
  });

  const removeContentMutation = useMutation({
    mutationFn: (contentId: string) => deliverablesApi.removeContent(deliverableId!, contentId),
    onSuccess: () => { refresh(); pushToast({ title: "Content removed", tone: "info" }); },
    onError: (err) => pushToast({ title: "Failed to remove content", body: err.message, tone: "error" }),
  });

  const addStageMutation = useMutation({
    mutationFn: (data: { label: string; reviewerAgentId?: string; reviewerUserId?: string }) =>
      deliverablesApi.addStage(deliverableId!, data),
    onSuccess: () => { setShowAddStage(false); refresh(); pushToast({ title: "Stage added", tone: "success" }); },
    onError: (err) => pushToast({ title: "Failed to add stage", body: err.message, tone: "error" }),
  });

  const removeStageMutation = useMutation({
    mutationFn: (stageId: string) => deliverablesApi.removeStage(deliverableId!, stageId),
    onSuccess: () => { refresh(); pushToast({ title: "Stage removed", tone: "info" }); },
    onError: (err) => pushToast({ title: "Failed to remove stage", body: err.message, tone: "error" }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deliverablesApi.remove(deliverableId!),
    onSuccess: () => { navigate("/deliverables"); pushToast({ title: "Deliverable deleted", tone: "info" }); },
    onError: (err) => pushToast({ title: "Failed to delete", body: err.message, tone: "error" }),
  });

  // ── Loading / Error ──────────────────────────────────────────────
  if (isLoading || !deliverable) return <PageSkeleton variant="detail" />;

  const stages = deliverable.stages ?? [];
  const contents = deliverable.contents ?? [];
  const currentStage = stages.find((s) => s.stageIndex === deliverable.currentStageIndex);
  const isDraft = deliverable.status === "draft";
  const isInReview = deliverable.status === "in_review";
  const isTerminal = deliverable.status === "approved" || deliverable.status === "rejected";

  return (
    <div className="space-y-6">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold font-[var(--font-display)] uppercase tracking-[0.06em]">{deliverable.title}</h1>
          <div className="mt-1 flex items-center gap-2">
            <DeliverableStatusBadge status={deliverable.status} />
            <DeliverablePriorityBadge priority={deliverable.priority} />
            {deliverable.submittedByAgentId && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Bot className="h-3 w-3" /> Agent submitted
              </span>
            )}
            {deliverable.dueAt && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" /> Due {formatDateTime(deliverable.dueAt)}
              </span>
            )}
          </div>
          {deliverable.description && (
            <p className="mt-2 text-sm text-muted-foreground">{deliverable.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isDraft && (
            <Button size="sm" onClick={() => submitMutation.mutate()} disabled={submitMutation.isPending}>
              <Send className="h-3.5 w-3.5 mr-1.5" />
              {submitMutation.isPending ? "Submitting..." : "Submit for Review"}
            </Button>
          )}
          {isTerminal && (
            <Button size="sm" variant="outline" onClick={() => reopenMutation.mutate()} disabled={reopenMutation.isPending}>
              <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
              Reopen
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => {
              if (confirm("Delete this deliverable?")) deleteMutation.mutate();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* ── Review Pipeline (stages) ────────────────────────────────── */}
      <section className="rounded-[2px] border border-border bg-card p-5 space-y-4 hud-panel hud-shimmer">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center h-7 w-7 rounded-[2px] bg-[var(--primary)]/10 dark:bg-[var(--primary)]/20">
              <Layers className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <h2 className="text-sm font-semibold hud-section-header font-[var(--font-display)] uppercase tracking-[0.06em]">Review Pipeline</h2>
            {stages.length > 0 && (
              <span className="text-[10px] text-muted-foreground ml-1">
                ({stages.filter((s) => s.status === "approved").length}/{stages.length} complete)
              </span>
            )}
          </div>
          {isDraft && (
            <Button size="sm" variant="ghost" onClick={() => setShowAddStage((v) => !v)}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Add Stage
            </Button>
          )}
        </div>

        {/* Mini stepper bar */}
        {stages.length > 0 && (
          <div className="flex items-center gap-1 px-1">
            {stages
              .sort((a, b) => a.stageIndex - b.stageIndex)
              .map((stage, i) => {
                const isApproved = stage.status === "approved";
                const isRejected = stage.status === "rejected";
                const isChanges = stage.status === "changes_requested";
                const isCurrent = isInReview && stage.stageIndex === deliverable.currentStageIndex;
                return (
                  <div key={stage.id} className="flex items-center flex-1 last:flex-none">
                    <div
                      className={cn(
                        "h-2 w-2 rounded-full shrink-0 transition-all",
                        isApproved && "bg-emerald-500 ring-2 ring-emerald-200 dark:ring-emerald-800",
                        isRejected && "bg-red-500 ring-2 ring-red-200 dark:ring-red-800",
                        isChanges && "bg-amber-500 ring-2 ring-amber-200 dark:ring-amber-800",
                        isCurrent && "bg-blue-500 ring-2 ring-blue-200 dark:ring-blue-800 animate-pulse",
                        !isApproved && !isRejected && !isChanges && !isCurrent && "bg-muted-foreground/20",
                      )}
                    />
                    {i < stages.length - 1 && (
                      <div
                        className={cn(
                          "flex-1 h-0.5 mx-1",
                          isApproved ? "bg-emerald-400 dark:bg-emerald-600" : "bg-muted",
                        )}
                      />
                    )}
                  </div>
                );
              })}
          </div>
        )}

        {stages.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No review stages — deliverable will auto-approve on submit.
          </p>
        ) : (
          <div className="space-y-2">
            {stages
              .sort((a, b) => a.stageIndex - b.stageIndex)
              .map((stage) => (
                <StageRow
                  key={stage.id}
                  stage={stage}
                  isCurrent={isInReview && stage.stageIndex === deliverable.currentStageIndex}
                  isEditable={isDraft}
                  decisionNote={decisionNote}
                  onDecisionNoteChange={setDecisionNote}
                  onApprove={() => approveStageMutation.mutate(stage.id)}
                  onRequestChanges={() => requestChangesMutation.mutate(stage.id)}
                  onReject={() => rejectStageMutation.mutate(stage.id)}
                  onSkip={() => skipStageMutation.mutate(stage.id)}
                  onRemove={() => removeStageMutation.mutate(stage.id)}
                  isPending={approveStageMutation.isPending || requestChangesMutation.isPending || rejectStageMutation.isPending}
                />
              ))}
          </div>
        )}

        {showAddStage && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              addStageMutation.mutate({ label: fd.get("label") as string });
            }}
            className="flex items-end gap-2 pt-2 border-t border-border"
          >
            <div className="flex-1">
              <label className="text-xs font-medium text-muted-foreground">Stage Label *</label>
              <input
                name="label"
                required
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                placeholder="e.g. Technical Review"
              />
            </div>
            <Button type="submit" size="sm" disabled={addStageMutation.isPending}>
              Add
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setShowAddStage(false)}>
              Cancel
            </Button>
          </form>
        )}
      </section>

      {/* ── Contents ────────────────────────────────────────────────── */}
      <section className="rounded-[2px] border border-border bg-card p-5 space-y-3 hud-panel hud-shimmer">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center h-7 w-7 rounded-[2px] bg-[var(--status-violet)]/10 dark:bg-[var(--status-violet)]/20">
              <FileText className="h-4 w-4 text-violet-600 dark:text-violet-400" />
            </div>
            <h2 className="text-sm font-semibold hud-section-header font-[var(--font-display)] uppercase tracking-[0.06em]">Contents</h2>
            <span className="text-[10px] text-muted-foreground">({contents.length})</span>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setShowAddContent((v) => !v)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add Content
          </Button>
        </div>

        {contents.length === 0 && !showAddContent && (
          <p className="text-xs text-muted-foreground italic">No content attached yet.</p>
        )}

        {contents.map((c) => {
          const Icon = CONTENT_KIND_ICON[c.kind] ?? FileText;
          return (
            <div key={c.id} className="flex items-start gap-3 rounded-[2px] border border-border/50 p-3">
              <Icon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{c.title}</span>
                  <Badge variant="secondary" className="text-[10px]">{c.kind}</Badge>
                </div>
                {c.body && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    <MarkdownBody>{c.body.length > 300 ? c.body.slice(0, 300) + "..." : c.body}</MarkdownBody>
                  </div>
                )}
                {c.url && (
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 text-xs text-blue-600 hover:underline truncate block"
                  >
                    {c.url}
                  </a>
                )}
                {c.originalFilename && (
                  <span className="mt-1 text-[10px] text-muted-foreground block">
                    {c.originalFilename} {c.sizeBytes ? `(${(c.sizeBytes / 1024).toFixed(1)} KB)` : ""}
                  </span>
                )}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 text-destructive/60 hover:text-destructive shrink-0"
                onClick={() => removeContentMutation.mutate(c.id)}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          );
        })}

        {showAddContent && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              addContentMutation.mutate({
                kind: fd.get("kind") as string,
                title: fd.get("title") as string,
                body: (fd.get("body") as string) || undefined,
                url: (fd.get("url") as string) || undefined,
              });
            }}
            className="space-y-3 pt-2 border-t border-border"
          >
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Title *</label>
                <input
                  name="title"
                  required
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                  placeholder="Content title"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Kind</label>
                <select
                  name="kind"
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                >
                  <option value="markdown">Markdown</option>
                  <option value="file">File</option>
                  <option value="url">URL</option>
                  <option value="code_ref">Code Reference</option>
                  <option value="preview">Preview</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">URL (for url/preview kind)</label>
              <input
                name="url"
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                placeholder="https://..."
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Body (for markdown/code_ref kind)</label>
              <Textarea name="body" rows={3} placeholder="Content body..." />
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={addContentMutation.isPending}>
                {addContentMutation.isPending ? "Adding..." : "Add Content"}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setShowAddContent(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </section>

      {/* ── Comments ────────────────────────────────────────────────── */}
      <section className="rounded-[2px] border border-border bg-card p-5 space-y-3 hud-panel hud-shimmer">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center h-7 w-7 rounded-[2px] bg-[var(--primary)]/10 dark:bg-[var(--primary)]/20">
            <MessageSquare className="h-4 w-4 text-sky-600 dark:text-sky-400" />
          </div>
          <h2 className="text-sm font-semibold hud-section-header font-[var(--font-display)] uppercase tracking-[0.06em]">Comments</h2>
          <span className="text-[10px] text-muted-foreground">({comments?.length ?? 0})</span>
        </div>

        {comments && comments.length > 0 && (
          <div className="space-y-3">
            {comments.map((c) => (
              <div key={c.id} className="rounded-[2px] border border-border/50 p-3">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                  {c.authorAgentId ? (
                    <span className="inline-flex items-center gap-1"><Bot className="h-3 w-3" /> Agent</span>
                  ) : c.authorUserId ? (
                    <span className="inline-flex items-center gap-1"><User className="h-3 w-3" /> User</span>
                  ) : (
                    <span>System</span>
                  )}
                  <span className="text-muted-foreground/50">{formatDateTime(c.createdAt)}</span>
                </div>
                <MarkdownBody>{c.body}</MarkdownBody>
              </div>
            ))}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!commentBody.trim()) return;
            addCommentMutation.mutate(commentBody.trim());
          }}
          className="flex gap-2"
        >
          <Textarea
            value={commentBody}
            onChange={(e) => setCommentBody(e.target.value)}
            placeholder="Add a comment..."
            rows={2}
            className="flex-1"
          />
          <Button
            type="submit"
            size="sm"
            disabled={!commentBody.trim() || addCommentMutation.isPending}
            className="self-end"
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </form>
      </section>

      {/* ── Metadata ────────────────────────────────────────────────── */}
      <section className="rounded-[2px] border border-border bg-card p-5 hud-panel hud-shimmer">
        <h2 className="text-sm font-semibold mb-3 hud-section-header font-[var(--font-display)] uppercase tracking-[0.06em]">Details</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
          <dt className="text-muted-foreground">ID</dt>
          <dd className="font-[var(--font-mono)] text-[11px]">{deliverable.id}</dd>
          <dt className="text-muted-foreground">Type</dt>
          <dd className="capitalize">{deliverable.type}</dd>
          <dt className="text-muted-foreground">Created</dt>
          <dd>{formatDateTime(deliverable.createdAt)}</dd>
          {deliverable.submittedAt && (
            <>
              <dt className="text-muted-foreground">Submitted</dt>
              <dd>{formatDateTime(deliverable.submittedAt)}</dd>
            </>
          )}
          {deliverable.approvedAt && (
            <>
              <dt className="text-muted-foreground">Approved</dt>
              <dd>{formatDateTime(deliverable.approvedAt)}</dd>
            </>
          )}
          {deliverable.rejectedAt && (
            <>
              <dt className="text-muted-foreground">Rejected</dt>
              <dd>{formatDateTime(deliverable.rejectedAt)}</dd>
            </>
          )}
        </dl>
      </section>
    </div>
  );
}

// ── Stage row sub-component ───────────────────────────────────────
function StageRow({
  stage,
  isCurrent,
  isEditable,
  decisionNote,
  onDecisionNoteChange,
  onApprove,
  onRequestChanges,
  onReject,
  onSkip,
  onRemove,
  isPending,
}: {
  stage: DeliverableReviewStage;
  isCurrent: boolean;
  isEditable: boolean;
  decisionNote: string;
  onDecisionNoteChange: (v: string) => void;
  onApprove: () => void;
  onRequestChanges: () => void;
  onReject: () => void;
  onSkip: () => void;
  onRemove: () => void;
  isPending: boolean;
}) {
  const config = STAGE_STATUS_CONFIG[stage.status] ?? STAGE_STATUS_CONFIG.pending;
  const Icon = config.icon;

  return (
    <div
      className={cn(
        "rounded-[2px] border p-3 transition-colors",
        isCurrent
          ? "border-blue-300 bg-blue-50/50 dark:bg-blue-900/10 shadow-sm shadow-blue-100 dark:shadow-blue-900/20"
          : "border-border/50 hover:border-border",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className={`h-4 w-4 ${config.color}`} />
          <span className="text-sm font-medium">{stage.label}</span>
          <Badge variant="secondary" className="text-[10px]">
            Stage {stage.stageIndex + 1}
          </Badge>
          {isCurrent && (
            <Badge variant="outline" className="text-[10px] bg-blue-100 text-blue-700 border-blue-200">
              Current
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {stage.reviewerAgentId && (
            <span className="text-[10px] text-muted-foreground inline-flex items-center gap-0.5">
              <Bot className="h-3 w-3" /> Reviewer
            </span>
          )}
          {isEditable && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 text-destructive/60 hover:text-destructive"
              onClick={onRemove}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

      {stage.decisionNote && (
        <p className="mt-1 text-xs text-muted-foreground italic ml-6">"{stage.decisionNote}"</p>
      )}

      {stage.decidedAt && (
        <p className="text-[10px] text-muted-foreground/60 ml-6">
          Decided {formatDateTime(stage.decidedAt)}
        </p>
      )}

      {/* Action buttons for current stage */}
      {isCurrent && (
        <div className="mt-3 ml-6 space-y-2">
          <Textarea
            value={decisionNote}
            onChange={(e) => onDecisionNoteChange(e.target.value)}
            placeholder="Optional note..."
            rows={2}
            className="text-xs"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={onApprove} disabled={isPending}>
              <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Approve
            </Button>
            <Button size="sm" variant="outline" onClick={onRequestChanges} disabled={isPending}>
              <RotateCcw className="h-3.5 w-3.5 mr-1" /> Request Changes
            </Button>
            <Button size="sm" variant="outline" className="text-destructive" onClick={onReject} disabled={isPending}>
              <XCircle className="h-3.5 w-3.5 mr-1" /> Reject
            </Button>
            <Button size="sm" variant="ghost" onClick={onSkip} disabled={isPending}>
              <SkipForward className="h-3.5 w-3.5 mr-1" /> Skip
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
