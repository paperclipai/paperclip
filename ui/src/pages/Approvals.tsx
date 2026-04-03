import { useEffect, useMemo, useState, useRef } from "react";
import { useNavigate, useLocation } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { ShieldCheck, Pause, Calendar, RotateCcw, Pencil, Check, X, Trash2 } from "lucide-react";
import { ExpandableApprovalCard } from "../components/ExpandableApprovalCard";
import { PageSkeleton } from "../components/PageSkeleton";
import {
  approvalAgeHours,
  approvalLane,
  approvalNeedsReminder,
  approvalScheduledAt,
  approvalPublishedAt,
  compareApprovalsByStatusThenCreated,
  contentTier,
  approvalMatchesView,
  type ApprovalLane,
  type ApprovalStatusView,
  type ContentTier,
} from "../lib/approvals";
import type { Approval } from "@paperclipai/shared";
import { timeAgo } from "../lib/timeAgo";

type ColumnKey = ContentTier | "intake" | "ops" | "db_code";

const TIER_DOT: Record<string, string> = {
  blue: "bg-blue-500",
  purple: "bg-purple-500",
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  gray: "bg-muted-foreground/50",
};

const MARKETING_TIERS: { key: ContentTier; label: string; tier: string; color: "blue" | "purple" | "green" }[] = [
  { key: "blog", label: "Blog", tier: "Tier 1", color: "blue" },
  { key: "social", label: "Social", tier: "Tier 2", color: "purple" },
  { key: "outreach", label: "Outreach", tier: "Tier 3", color: "green" },
];

const SECONDARY_LANES: { key: ApprovalLane; label: string; color: "amber" | "gray" }[] = [
  { key: "intake", label: "Intake", color: "amber" },
  { key: "ops", label: "Ops", color: "gray" },
];

const VIEW_PATH_MAP: Record<ApprovalStatusView, string> = {
  pending: "pending",
  approved_scheduled: "approved",
  published: "published",
  all: "all",
};

const PATH_VIEW_MAP: Record<string, ApprovalStatusView> = {
  pending: "pending",
  approved: "approved_scheduled",
  published: "published",
  all: "all",
};

function InlineEditCard({
  approval,
  onSave,
  onCancel,
  isSaving,
}: {
  approval: Approval;
  onSave: (payload: Record<string, unknown>) => void;
  onCancel: () => void;
  isSaving: boolean;
}) {
  const payload = approval.payload as Record<string, unknown>;
  const initialText =
    typeof payload.draft === "string" ? payload.draft
    : typeof payload.body === "string" ? payload.body
    : typeof payload.summary === "string" ? payload.summary
    : "";
  const [text, setText] = useState(initialText);
  const [field, setField] = useState<"draft" | "body" | "summary">(
    typeof payload.draft === "string" ? "draft"
    : typeof payload.body === "string" ? "body"
    : "summary",
  );

  return (
    <div className="space-y-2 p-3 rounded-lg border border-blue-500/40 bg-blue-500/5">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium text-blue-400 uppercase tracking-wide">Editing content</p>
        <span className="text-[10px] text-muted-foreground">{text.length} chars</span>
      </div>
      <textarea
        className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground resize-y min-h-[120px] focus:outline-none focus:ring-1 focus:ring-blue-500/50"
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
      />
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          disabled={isSaving}
        >
          <X className="h-3 w-3" /> Cancel
        </button>
        <button
          type="button"
          onClick={() => onSave({ ...payload, [field]: text })}
          className="flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
          disabled={isSaving || text === initialText}
        >
          <Check className="h-3 w-3" /> {isSaving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function ScheduleDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: (dt: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="space-y-2 p-3 rounded-lg border border-amber-500/40 bg-amber-500/5">
      <p className="text-[11px] font-medium text-amber-400 uppercase tracking-wide">Set publish time</p>
      <input
        type="datetime-local"
        className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
      />
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => value && onConfirm(new Date(value).toISOString())}
          disabled={!value}
          className="rounded bg-amber-600 px-2 py-1 text-xs text-white hover:bg-amber-700 disabled:opacity-50"
        >
          Schedule
        </button>
      </div>
    </div>
  );
}

function ApprovedCard({
  approval,
  view,
  isEditing,
  onEditOpen,
  onEditClose,
  onPause,
  onSchedule,
  onRecall,
  onContentSave,
  onDelete,
  isPending,
}: {
  approval: Approval;
  view: ApprovalStatusView;
  isEditing: boolean;
  onEditOpen: () => void;
  onEditClose: () => void;
  onPause: () => void;
  onSchedule: (dt: string) => void;
  onRecall: () => void;
  onContentSave: (payload: Record<string, unknown>) => void;
  onDelete: () => void;
  isPending: boolean;
}) {
  const [scheduling, setScheduling] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const payload = approval.payload as Record<string, unknown>;
  const title = typeof payload.title === "string" ? payload.title : approval.id.slice(0, 12);
  const scheduledAt = approvalScheduledAt(approval);
  const publishedAt = approvalPublishedAt(approval);
  const platform = typeof payload.channel === "string" ? payload.channel : null;

  return (
    <div className={cn("rounded-lg border border-border bg-card p-3 space-y-2 text-xs", isPending && "opacity-60")}>
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium text-foreground leading-snug truncate">{title}</p>
        <span className={cn(
          "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
          approval.status === "paused" ? "bg-amber-500/20 text-amber-400" :
          approval.status === "scheduled" ? "bg-blue-500/20 text-blue-400" :
          approval.status === "published" ? "bg-emerald-500/20 text-emerald-400" :
          approval.status === "recalled" ? "bg-rose-500/20 text-rose-400" :
          "bg-muted text-muted-foreground",
        )}>
          {approval.status}
        </span>
      </div>

      {platform && <p className="text-muted-foreground">{platform}</p>}
      {scheduledAt && (
        <p className="text-amber-400">
          Scheduled: {new Date(scheduledAt).toLocaleString()}
        </p>
      )}
      {publishedAt && (
        <p className="text-emerald-400">
          Published: {timeAgo(new Date(publishedAt))}
        </p>
      )}

      {isEditing && (
        <InlineEditCard
          approval={approval}
          onSave={(p) => { onContentSave(p); onEditClose(); }}
          onCancel={() => onEditClose()}
          isSaving={isPending}
        />
      )}

      {scheduling && (
        <ScheduleDialog
          onConfirm={(dt) => { onSchedule(dt); setScheduling(false); }}
          onCancel={() => setScheduling(false)}
        />
      )}

      {!isEditing && !scheduling && (
        <div className="flex flex-wrap gap-1.5 pt-1 border-t border-border/40">
          {view === "approved_scheduled" && (
            <>
              {confirmingDelete ? (
                <div className="w-full flex flex-col gap-1.5">
                  <p className="text-[10px] text-rose-400">Delete this approval? This cannot be undone.</p>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => { onDelete(); setConfirmingDelete(false); }}
                      className="flex items-center gap-1 rounded border border-rose-500/60 px-2 py-1 text-[10px] text-rose-400 hover:bg-rose-500/10"
                      disabled={isPending}
                    >
                      <Check className="h-3 w-3" /> Confirm
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(false)}
                      className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
                      disabled={isPending}
                    >
                      <X className="h-3 w-3" /> Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
              <button
                type="button"
                onClick={() => onEditOpen()}
                className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:border-blue-500/50"
                disabled={isPending}
              >
                <Pencil className="h-3 w-3" /> Edit
              </button>
              {approval.status !== "paused" && (
                <button
                  type="button"
                  onClick={onPause}
                  className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:border-amber-500/50"
                  disabled={isPending}
                >
                  <Pause className="h-3 w-3" /> Pause
                </button>
              )}
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:border-rose-500/50"
                disabled={isPending}
              >
                <Trash2 className="h-3 w-3" /> Delete
              </button>
              {approval.status === "scheduled" && scheduledAt && (
                <span className="text-[10px] text-amber-400 flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  {new Date(scheduledAt).toLocaleString()}
                </span>
              )}
              {approval.status !== "scheduled" && (
                <button
                  type="button"
                  onClick={() => setScheduling(true)}
                  className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:border-amber-500/50"
                  disabled={isPending}
                >
                  <Calendar className="h-3 w-3" /> Schedule
                </button>
              )}
                </>
              )}
            </>
          )}
          {view === "published" && approval.status === "published" && (
            <button
              type="button"
              onClick={onRecall}
              className="flex items-center gap-1 rounded border border-rose-500/40 px-2 py-1 text-[10px] text-rose-400 hover:bg-rose-500/10"
              disabled={isPending}
            >
              <RotateCcw className="h-3 w-3" /> Recall
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DbCodeColumn() {
  return (
    <section className="rounded-lg border border-dashed border-border bg-card/50 min-h-[200px]">
      <div className="sticky top-0 z-10 border-b border-dashed border-border px-3 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-2 w-2 rounded-full bg-muted-foreground/40" />
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">DB / Code · Tier 4</h3>
        </div>
        <span className="rounded px-1.5 py-0.5 text-[10px] bg-muted text-muted-foreground">0</span>
      </div>
      <div className="p-4 text-center text-[11px] text-muted-foreground leading-relaxed">
        No pending changes — database schema diffs and code changes will appear here when Builder agent is deployed.
      </div>
    </section>
  );
}

export function Approvals() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  const pathSegment = location.pathname.split("/").pop() ?? "pending";
  const currentView: ApprovalStatusView = PATH_VIEW_MAP[pathSegment] ?? "pending";

  const [actionError, setActionError] = useState<string | null>(null);
  const [editingApprovalId, setEditingApprovalId] = useState<string | null>(null);
  const [expandedByColumn, setExpandedByColumn] = useState<Record<ColumnKey, string | null>>({
    blog: null, social: null, outreach: null, intake: null, ops: null, db_code: null,
  });
  const [laneOpen, setLaneOpen] = useState<Record<string, boolean>>({ intake: false, ops: false });
  const [dismissingIds, setDismissingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setBreadcrumbs([{ label: "Approvals" }]);
  }, [setBreadcrumbs]);

  // Fetch all approvals (no status filter — we filter client-side by view)
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!),
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });

  const dismissThenRefresh = (id: string) => {
    setDismissingIds((prev) => new Set(prev).add(id));
    window.setTimeout(() => {
      invalidate();
      setDismissingIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }, 220);
  };

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: (_, id) => { setActionError(null); dismissThenRefresh(id); },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to approve"),
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: (_, id) => { setActionError(null); dismissThenRefresh(id); },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to reject"),
  });

  const requestRevisionMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => approvalsApi.requestRevision(id, note),
    onSuccess: (_, vars) => { setActionError(null); dismissThenRefresh(vars.id); },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to request edits"),
  });

  const pauseMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.pause(id),
    onSuccess: () => { setActionError(null); invalidate(); },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to pause"),
  });

  const scheduleMutation = useMutation({
    mutationFn: ({ id, scheduledAt }: { id: string; scheduledAt: string }) =>
      approvalsApi.schedule(id, scheduledAt),
    onSuccess: () => { setActionError(null); invalidate(); },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to schedule"),
  });

  const recallMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.recall(id),
    onSuccess: () => { setActionError(null); invalidate(); },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to recall"),
  });

  const updateContentMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) =>
      approvalsApi.updateContent(id, payload),
    onSuccess: () => { setActionError(null); invalidate(); },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to save content"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.deleteById(id),
    onSuccess: (_, id) => { setActionError(null); dismissThenRefresh(id); },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to delete"),
  });

  const viewFiltered = useMemo(() =>
    (data ?? [])
      .filter((a) => approvalMatchesView(a.status, currentView))
      .sort(compareApprovalsByStatusThenCreated),
    [data, currentView],
  );

  const pendingCount = (data ?? []).filter((a) => a.status === "pending" || a.status === "revision_requested").length;
  const approvedCount = (data ?? []).filter((a) => ["approved", "paused", "scheduled"].includes(a.status)).length;
  const publishedCount = (data ?? []).filter((a) => ["published", "recalled"].includes(a.status)).length;
  const stalePendingCount = (data ?? []).filter((a) => approvalNeedsReminder(a)).length;

  const marketingItems = viewFiltered.filter((a) => approvalLane(a) === "marketing");
  const intakeItems = viewFiltered.filter((a) => approvalLane(a) === "intake");
  const opsItems = viewFiltered.filter((a) => approvalLane(a) === "ops");

  const marketingByTier = useMemo(() => {
    const map: Record<ContentTier, typeof marketingItems> = { blog: [], social: [], outreach: [] };
    for (const item of marketingItems) map[contentTier(item)].push(item);
    return map;
  }, [marketingItems]);

  const pendingFor = (items: typeof viewFiltered) =>
    items.filter((a) => a.status === "pending" || a.status === "revision_requested").length;

  const toggleExpanded = (column: ColumnKey, id: string) => {
    setExpandedByColumn((prev) => ({ ...prev, [column]: prev[column] === id ? null : id }));
  };

  const actionIsPending = approveMutation.isPending || rejectMutation.isPending ||
    requestRevisionMutation.isPending || pauseMutation.isPending ||
    scheduleMutation.isPending || recallMutation.isPending || updateContentMutation.isPending;

  if (!selectedCompanyId) return <p className="text-sm text-muted-foreground">Select a company first.</p>;
  if (isLoading) return <PageSkeleton variant="approvals" />;

  const isPendingView = currentView === "pending";
  const isApprovedView = currentView === "approved_scheduled";
  const isPublishedView = currentView === "published";

  return (
    <div className="space-y-4 w-full">
      <div className="flex items-center justify-between">
        <Tabs value={VIEW_PATH_MAP[currentView]} onValueChange={(v) => navigate(`/approvals/${v}`)}>
          <PageTabBar items={[
            {
              value: "pending",
              label: (
                <>
                  Pending
                  {pendingCount > 0 && (
                    <span className={cn("ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium", "bg-yellow-500/20 text-yellow-500")}>
                      {pendingCount}
                    </span>
                  )}
                </>
              ),
            },
            {
              value: "approved",
              label: (
                <>
                  Approved & Scheduled
                  {approvedCount > 0 && (
                    <span className="ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/20 text-blue-400">
                      {approvedCount}
                    </span>
                  )}
                </>
              ),
            },
            {
              value: "published",
              label: (
                <>
                  Published
                  {publishedCount > 0 && (
                    <span className="ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-emerald-500/20 text-emerald-400">
                      {publishedCount}
                    </span>
                  )}
                </>
              ),
            },
            { value: "all", label: "All" },
          ]} />
        </Tabs>
      </div>

      <div className="rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-900 dark:text-blue-200">
        <p className="font-semibold">Approved & Scheduled policy (operator-locked)</p>
        <ul className="mt-1 list-disc pl-4 space-y-0.5">
          <li>Approved approvals can be deleted (safety kill switch).</li>
          <li>Do NOT edit already-approved approvals.</li>
          <li>Any changes after approval must use a new/replacement approval (with clear replaces lineage).</li>
          <li>Keep Pause and Schedule buttons on tiles in Approved and Scheduled views.</li>
        </ul>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      {stalePendingCount > 0 && isPendingView && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {stalePendingCount} approval{stalePendingCount === 1 ? "" : "s"} pending for more than 24h. Review to avoid stale queue drift.
        </p>
      )}

      {viewFiltered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <ShieldCheck className="h-8 w-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            {isPendingView ? "No pending approvals." :
             isApprovedView ? "No approved or scheduled items." :
             isPublishedView ? "No published items." : "No approvals yet."}
          </p>
        </div>
      )}

      {/* Marketing tiers + DB/Code — always show in grid */}
      <div className="grid grid-cols-4 gap-3 items-start">
        {MARKETING_TIERS.map((tierDef) => {
          const items = marketingByTier[tierDef.key];
          const pending = pendingFor(items);
          return (
            <section key={tierDef.key} className="rounded-lg border border-border bg-card min-h-[200px]">
              <div className="sticky top-0 z-10 border-b border-border bg-card px-3 py-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={cn("inline-flex h-2 w-2 rounded-full", TIER_DOT[tierDef.color])} />
                  <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">{tierDef.label} · {tierDef.tier}</h3>
                </div>
                <span className={cn("rounded px-1.5 py-0.5 text-[10px]", (isPendingView ? pending : items.length) > 0 ? "bg-yellow-500/20 text-yellow-600 dark:text-yellow-400" : "bg-muted text-muted-foreground")}>
                  {isPendingView ? pending : items.length}
                </span>
              </div>

              <div className="p-2 space-y-2">
                {isPendingView && items.map((approval) => {
                  const isResolved = approval.status !== "pending" && approval.status !== "revision_requested";
                  return (
                    <ExpandableApprovalCard
                      key={approval.id}
                      approval={approval}
                      requesterAgent={approval.requestedByAgentId ? (agents ?? []).find((a) => a.id === approval.requestedByAgentId) ?? null : null}
                      expanded={expandedByColumn[tierDef.key] === approval.id}
                      onToggle={() => toggleExpanded(tierDef.key, approval.id)}
                      onApprove={() => approveMutation.mutate(approval.id)}
                      onReject={() => rejectMutation.mutate(approval.id)}
                      onRequestRevision={(note) => requestRevisionMutation.mutate({ id: approval.id, note })}
                      isPending={actionIsPending}
                      needsReminder={approvalNeedsReminder(approval)}
                      ageHours={approvalAgeHours(approval)}
                      muted={false}
                      dismissing={dismissingIds.has(approval.id)}
                      detailLink={`/approvals/${approval.id}`}
                    />
                  );
                })}
                {(isApprovedView || isPublishedView) && items.map((approval) => (
                  <ApprovedCard
                    key={approval.id}
                    approval={approval}
                    view={currentView}
                    isEditing={editingApprovalId === approval.id}
                    onEditOpen={() => setEditingApprovalId(approval.id)}
                    onEditClose={() => setEditingApprovalId(null)}
                    onPause={() => pauseMutation.mutate(approval.id)}
                    onSchedule={(dt) => scheduleMutation.mutate({ id: approval.id, scheduledAt: dt })}
                    onRecall={() => recallMutation.mutate(approval.id)}
                    onContentSave={(p) => updateContentMutation.mutate({ id: approval.id, payload: p })}
                    onDelete={() => deleteMutation.mutate(approval.id)}
                    isPending={actionIsPending}
                  />
                ))}
                {currentView === "all" && items.map((approval) => {
                  const isResolved = approval.status !== "pending" && approval.status !== "revision_requested";
                  return (
                    <ExpandableApprovalCard
                      key={approval.id}
                      approval={approval}
                      requesterAgent={approval.requestedByAgentId ? (agents ?? []).find((a) => a.id === approval.requestedByAgentId) ?? null : null}
                      expanded={expandedByColumn[tierDef.key] === approval.id}
                      onToggle={() => toggleExpanded(tierDef.key, approval.id)}
                      onApprove={() => approveMutation.mutate(approval.id)}
                      onReject={() => rejectMutation.mutate(approval.id)}
                      onRequestRevision={(note) => requestRevisionMutation.mutate({ id: approval.id, note })}
                      isPending={actionIsPending}
                      needsReminder={approvalNeedsReminder(approval)}
                      ageHours={approvalAgeHours(approval)}
                      muted={isResolved}
                      dismissing={dismissingIds.has(approval.id)}
                      detailLink={`/approvals/${approval.id}`}
                    />
                  );
                })}
              </div>
            </section>
          );
        })}

        <DbCodeColumn />
      </div>

      {/* Intake + Ops secondary lanes — only in pending/all views */}
      {(isPendingView || currentView === "all") && (
        <div className="grid grid-cols-2 gap-3 items-start">
          {SECONDARY_LANES.map((laneDef) => {
            const laneItems = laneDef.key === "intake" ? intakeItems : opsItems;
            const pending = pendingFor(laneItems);
            const dimmed = pending === 0;
            const open = laneOpen[laneDef.key] ?? false;
            return (
              <section key={laneDef.key} className={cn("rounded-lg border border-border bg-card", dimmed && "opacity-70")}>
                <button
                  type="button"
                  className="w-full flex items-center justify-between border-b border-border px-3 py-2"
                  onClick={() => setLaneOpen((prev) => ({ ...prev, [laneDef.key]: !open }))}
                >
                  <div className="flex items-center gap-2">
                    <span className={cn("inline-flex h-2 w-2 rounded-full", TIER_DOT[laneDef.color])} />
                    <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">{laneDef.label}</h3>
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px]", pending > 0 ? "bg-yellow-500/20 text-yellow-600 dark:text-yellow-400" : "bg-muted text-muted-foreground")}>{pending}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">{open ? "▴" : "▾"}</span>
                </button>
                {open && (
                  <div className="p-2 space-y-2">
                    {laneItems.map((approval) => {
                      const isResolved = approval.status !== "pending" && approval.status !== "revision_requested";
                      return (
                        <ExpandableApprovalCard
                          key={approval.id}
                          approval={approval}
                          requesterAgent={approval.requestedByAgentId ? (agents ?? []).find((a) => a.id === approval.requestedByAgentId) ?? null : null}
                          expanded={expandedByColumn[laneDef.key as ColumnKey] === approval.id}
                          onToggle={() => toggleExpanded(laneDef.key as ColumnKey, approval.id)}
                          onApprove={() => approveMutation.mutate(approval.id)}
                          onReject={() => rejectMutation.mutate(approval.id)}
                          onRequestRevision={(note) => requestRevisionMutation.mutate({ id: approval.id, note })}
                          isPending={actionIsPending}
                          needsReminder={approvalNeedsReminder(approval)}
                          ageHours={approvalAgeHours(approval)}
                          muted={currentView === "all" && isResolved}
                          dismissing={dismissingIds.has(approval.id)}
                          detailLink={`/approvals/${approval.id}`}
                        />
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
