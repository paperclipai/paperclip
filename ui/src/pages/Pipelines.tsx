import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { groupWarningsByStage } from "@paperclipai/shared";
import type {
  Issue,
  IssueAttachment,
  PipelineAutomationRetryCleanupOptions,
  PipelineAutomationRetryPlan,
  PipelineAutomationRetryScope,
} from "@paperclipai/shared";
import { AlertTriangle, ArrowUpDown, BookOpenText, Check, ChevronDown, ChevronRight, ChevronUp, CircleDot, Download, ExternalLink, FileText, GitBranch, Hexagon, Image as ImageIcon, Info, List, ListTree, Loader2, MessageSquare, MoreHorizontal, Plus, Search, Settings, Trash2, X } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Link, useLocation, useNavigate, useParams } from "@/lib/router";
import { ApiError } from "../api/client";
import {
  pipelinesApi,
  type PipelineAttentionFeed,
  type PipelineBatchIngestResult,
  type PipelineCase,
  type PipelineCaseActiveWork,
  type PipelineCaseDetail,
  type PipelineCaseEvent,
  type PipelineCaseIssueLinkWithIssue,
  type PipelineConnectionRef,
  type PipelineConnections,
  type PipelineIntakeField,
  type PipelineIntakeForm,
  type PipelineListItem,
  type PipelineReviewDecision,
  type PipelineReviewCaseRow,
  type PipelineStage,
} from "../api/pipelines";
import { issuesApi } from "../api/issues";
import { EmptyState } from "../components/EmptyState";
import { FoldCurtain } from "../components/FoldCurtain";
import { IssueChatThread } from "../components/IssueChatThread";
import { MarkdownBody } from "../components/MarkdownBody";
import { PageSkeleton } from "../components/PageSkeleton";
import { PipelineHealthBar } from "../components/PipelineHealthWarnings";
import { PipelineLivenessBanner } from "../components/PipelineLivenessBanner";
import { PipelineWorkReferences } from "../components/PipelineWorkReferences";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import {
  displayPipelineItemFields,
  formatPipelineItemEvent,
  getPendingTransitionBannerState,
  humanizePipelineItemStatus,
  changedNoticeFromEvents,
  itemHasChangedNotice,
  normalizePipelineChildRows,
  splitPipelineItemFields,
} from "../lib/pipeline-item-detail";
import { extractWorkReferences, referenceFieldKeys } from "../lib/pipeline-references";
import { pieceNounPlural, readStageBreakdown } from "../lib/pipeline-breakdown";
import { hasBlockingShortcutDialog, isKeyboardShortcutTextInputTarget } from "../lib/keyboardShortcuts";
import { formatLearningEvent, groupLearningEventsByDay } from "../lib/pipeline-learnings";
import { queryKeys } from "../lib/queryKeys";
import { shouldDisableRerunForPermission, type LivenessRetryKind } from "../lib/pipeline-liveness";
import { cn, formatNumber, relativeTime } from "../lib/utils";
import { attachmentDownloadPath, attachmentFilename, attachmentOpenPath, isImageAttachment } from "../lib/issue-attachments";
import { formatBytes } from "../lib/issue-output";
import { createIssueDetailPath, withIssueDetailHeaderSeed } from "../lib/issueDetailBreadcrumb";

interface DraftRow {
  id: string;
  expanded: boolean;
  values: Record<string, string>;
  serverError?: string | null;
}

function issueDetailPath(issue: Pick<Issue, "id" | "identifier">) {
  return createIssueDetailPath(issue.identifier ?? issue.id);
}

type FieldErrors = Record<string, string>;
type RowErrors = Record<string, FieldErrors>;

let draftCounter = 0;

function newDraftRow(expanded = true): DraftRow {
  draftCounter += 1;
  return { id: `draft-${draftCounter}`, expanded, values: {}, serverError: null };
}

function isBlank(value: string | undefined) {
  return !value || value.trim().length === 0;
}

export function validateDraftRows(rows: DraftRow[], fields: PipelineIntakeField[]): RowErrors {
  const errors: RowErrors = {};
  for (const row of rows) {
    const rowErrors: FieldErrors = {};
    for (const field of fields) {
      if (field.required && isBlank(row.values[field.key])) {
        rowErrors[field.key] = `${field.label} is required.`;
      }
    }
    if (Object.keys(rowErrors).length > 0) {
      errors[row.id] = rowErrors;
    }
  }
  return errors;
}

export function buildBatchPayload(rows: DraftRow[], fields: PipelineIntakeField[]) {
  return rows.map((row) => {
    const title = row.values.title?.trim() ?? "";
    const itemFields: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.key === "title") continue;
      const value = row.values[field.key];
      if (value !== undefined && value.trim().length > 0) {
        itemFields[field.key] = value.trim();
      }
    }
    return { title, fields: itemFields };
  });
}

export function plainBatchError(result: Extract<PipelineBatchIngestResult, { ok: false }>) {
  const details = result.error?.details ?? {};
  if (details.code === "required_field" && typeof details.label === "string") {
    return `${details.label} is required.`;
  }
  if (details.code === "invalid_select_value" && typeof details.label === "string") {
    return `${details.label} needs one of the available choices.`;
  }
  if (details.code === "duplicate_batch_key") {
    return "This item duplicates another row.";
  }
  if (details.code === "blocker_cycle") {
    return "This item waits on another row that also waits on it.";
  }
  if (typeof result.error?.message === "string" && result.error.message.trim()) {
    return result.error.message.replace(/^Pipeline\s+/i, "");
  }
  return "This item needs attention before it can be submitted.";
}

function itemCountLabel(count: number) {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

function currentStageAutomation(stage: PipelineStage) {
  const onEnter = stage.config?.onEnter;
  if (!onEnter || typeof onEnter !== "object" || Array.isArray(onEnter)) return null;
  const config = onEnter as Record<string, unknown>;
  return config.type === "run_routine" && typeof config.routineId === "string" && config.routineId.trim()
    ? { routineId: config.routineId }
    : null;
}

function RetryMetric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "warning";
}) {
  return (
    <div className={cn(
      "rounded-sm border px-3 py-2",
      tone === "warning"
        ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100"
        : "border-border bg-background text-foreground",
    )}>
      <div className="text-base font-semibold">{formatNumber(value)}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

type RetryCleanupId = keyof PipelineAutomationRetryCleanupOptions | "keepAuditHistory";

function retryCleanupItems(plan: PipelineAutomationRetryPlan): Array<{
  id: RetryCleanupId;
  label: string;
  description: string;
  count?: number;
  disabled?: boolean;
  required?: boolean;
}> {
  return [
    {
      id: "retireDirectChildren",
      label: "Retire direct child items",
      description: "Hide child outputs from normal pipeline boards and parent rollups.",
      count: plan.effectCounts.directChildren,
      disabled: plan.effectCounts.directChildren === 0,
    },
    {
      id: "retireDescendants",
      label: "Retire descendants",
      description: "Hide downstream output items under those children.",
      count: plan.effectCounts.descendants,
      disabled: plan.effectCounts.descendants === 0,
    },
    {
      id: "cancelLinkedAutomationIssues",
      label: "Cancel linked automation issues",
      description: "Cancel unfinished automation issues superseded by the fresh retry.",
      count: plan.effectCounts.linkedAutomationIssues,
      disabled: plan.effectCounts.linkedAutomationIssues === 0,
    },
    {
      id: "keepAuditHistory",
      label: "Keep audit trail visible in item history",
      description: "Record retry and retired outputs as history instead of deleting records.",
      required: true,
      disabled: true,
    },
  ];
}

function selectedCleanupIds(plan: PipelineAutomationRetryPlan) {
  const selected = new Set<string>(["keepAuditHistory"]);
  if (plan.defaultCleanup.retireDirectChildren) selected.add("retireDirectChildren");
  if (plan.defaultCleanup.retireDescendants) selected.add("retireDescendants");
  if (plan.defaultCleanup.cancelLinkedAutomationIssues) selected.add("cancelLinkedAutomationIssues");
  return selected;
}

function retryCleanupFromIds(ids: Set<string>): PipelineAutomationRetryCleanupOptions {
  return {
    retireDirectChildren: ids.has("retireDirectChildren"),
    retireDescendants: ids.has("retireDescendants"),
    cancelLinkedAutomationIssues: ids.has("cancelLinkedAutomationIssues"),
  };
}

function retryPrimaryActionLabel(plan: PipelineAutomationRetryPlan) {
  const retiredOutputCount = plan.effectCounts.directChildren + plan.effectCounts.descendants;
  if (retiredOutputCount > 0 && (plan.defaultCleanup.retireDirectChildren || plan.defaultCleanup.retireDescendants)) {
    return `Retry and retire ${formatNumber(retiredOutputCount)} ${retiredOutputCount === 1 ? "item" : "items"}`;
  }
  return plan.scope === "previous_stage" ? "Retry previous step" : "Re-run this step";
}

export function Pipelines() {
  const params = useParams<{ pipelineId?: string }>();
  const location = useLocation();
  const pipelineId = params.pipelineId ?? null;
  const addMode = Boolean(pipelineId && location.pathname.endsWith("/add"));

  if (pipelineId && addMode) return <PipelineAddItems pipelineId={pipelineId} />;
  if (pipelineId) return <PipelineBoard pipelineId={pipelineId} />;
  return <PipelinesIndex />;
}

// ---------------------------------------------------------------------------
// Pipelines index
// ---------------------------------------------------------------------------

export type PipelineViewMode = "nested" | "flat";

export interface PipelineTableRow {
  pipeline: PipelineListItem;
  depth: number;
  parentPipelineName: string | null;
  hasChildren: boolean;
  expanded: boolean;
}

function connectionId(ref: PipelineConnectionRef | null | undefined): string | null {
  if (!ref) return null;
  if (typeof ref === "string") return ref;
  return (
    ref.pipelineId ??
    ref.downstreamPipelineId ??
    ref.feedsIntoPipelineId ??
    ref.id ??
    null
  );
}

function connectionListIds(refs: PipelineConnectionRef[] | null | undefined): string[] {
  if (!Array.isArray(refs)) return [];
  return refs.map(connectionId).filter((id): id is string => Boolean(id));
}

function downstreamPipelineIds(connections: PipelineConnections | null | undefined): string[] {
  if (!connections) return [];

  const ids = [
    connections.feedsIntoPipelineId,
    connections.downstreamPipelineId,
    ...(connections.downstreamPipelineIds ?? []),
    ...connectionListIds(connections.feedsInto),
    ...connectionListIds(connections.downstream),
  ];

  return ids.filter((id): id is string => Boolean(id));
}

function hasConnectionsField(pipeline: PipelineListItem): boolean {
  return Object.prototype.hasOwnProperty.call(pipeline, "connections");
}

function pipelineOpenItemCount(pipeline: PipelineListItem) {
  return pipeline.openCaseCount ?? 0;
}

function pipelineAttentionCount(pipeline: PipelineListItem) {
  return pipeline.attentionCount ?? 0;
}

function pipelineInMotionCount(pipeline: PipelineListItem) {
  return pipeline.inMotionCount ?? 0;
}

function descendantActiveWorkCount(value: { descendantActiveWorkCount?: number | null }) {
  return value.descendantActiveWorkCount ?? 0;
}

function formatLiveDownstream(count: number) {
  return `${formatNumber(count)} live downstream`;
}

function pipelineActivityTime(pipeline: PipelineListItem) {
  return pipeline.lastActivityAt ?? pipeline.updatedAt ?? pipeline.createdAt ?? null;
}

type PipelineSortField = "name" | "activity" | "review" | "inMotion" | "openItems";
type PipelineSortDir = "asc" | "desc";

const PIPELINE_SORT_OPTIONS: ReadonlyArray<readonly [PipelineSortField, string]> = [
  ["name", "Name"],
  ["activity", "Last activity"],
  ["review", "Most to review"],
  ["inMotion", "Most in motion"],
  ["openItems", "Most open items"],
];

function comparePipelinesBySort(field: PipelineSortField, dir: PipelineSortDir) {
  const factor = dir === "asc" ? 1 : -1;
  return (left: PipelineListItem, right: PipelineListItem) => {
    let cmp = 0;
    switch (field) {
      case "name":
        cmp = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
        break;
      case "activity": {
        const leftTime = new Date(pipelineActivityTime(left) ?? 0).getTime() || 0;
        const rightTime = new Date(pipelineActivityTime(right) ?? 0).getTime() || 0;
        cmp = leftTime - rightTime;
        break;
      }
      case "review":
        cmp = pipelineAttentionCount(left) - pipelineAttentionCount(right);
        break;
      case "inMotion":
        cmp = pipelineInMotionCount(left) - pipelineInMotionCount(right);
        break;
      case "openItems":
        cmp = pipelineOpenItemCount(left) - pipelineOpenItemCount(right);
        break;
    }
    if (cmp === 0) cmp = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    return cmp * factor;
  };
}

function compareByInputOrder(order: Map<string, number>) {
  return (left: PipelineListItem, right: PipelineListItem) =>
    (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER);
}

export function pipelinesHaveConnectionData(pipelines: PipelineListItem[]) {
  return pipelines.some(hasConnectionsField);
}

export function buildPipelineTableRows(
  pipelines: PipelineListItem[],
  options: {
    viewMode: PipelineViewMode;
    collapsedPipelineIds?: Set<string>;
  },
): PipelineTableRow[] {
  if (options.viewMode === "flat") {
    return pipelines.map((pipeline) => ({
      pipeline,
      depth: 0,
      parentPipelineName: null,
      hasChildren: false,
      expanded: true,
    }));
  }

  const pipelinesById = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline]));
  const inputOrder = new Map(pipelines.map((pipeline, index) => [pipeline.id, index]));
  const parentByChild = new Map<string, string>();

  for (const pipeline of pipelines) {
    const downstreamId = downstreamPipelineIds(pipeline.connections).find((id) => pipelinesById.has(id));
    if (downstreamId && downstreamId !== pipeline.id && !parentByChild.has(downstreamId)) {
      parentByChild.set(downstreamId, pipeline.id);
    }
  }

  const childrenByParent = new Map<string, PipelineListItem[]>();
  for (const [childId, parentId] of parentByChild.entries()) {
    const child = pipelinesById.get(childId);
    if (!child) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(child);
    childrenByParent.set(parentId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort(compareByInputOrder(inputOrder));
  }

  const rows: PipelineTableRow[] = [];
  const visited = new Set<string>();
  const collapsed = options.collapsedPipelineIds ?? new Set<string>();

  function markSubtreeVisited(pipeline: PipelineListItem) {
    for (const child of childrenByParent.get(pipeline.id) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      markSubtreeVisited(child);
    }
  }

  function visit(pipeline: PipelineListItem, depth: number, stack: Set<string>) {
    if (visited.has(pipeline.id) || stack.has(pipeline.id)) return;
    visited.add(pipeline.id);

    const children = childrenByParent.get(pipeline.id) ?? [];
    const parentId = parentByChild.get(pipeline.id);
    rows.push({
      pipeline,
      depth,
      parentPipelineName: parentId ? pipelinesById.get(parentId)?.name ?? null : null,
      hasChildren: children.length > 0,
      expanded: !collapsed.has(pipeline.id),
    });

    if (collapsed.has(pipeline.id)) {
      markSubtreeVisited(pipeline);
      return;
    }

    const nextStack = new Set(stack);
    nextStack.add(pipeline.id);
    for (const child of children) {
      visit(child, depth + 1, nextStack);
    }
  }

  const roots = pipelines
    .filter((pipeline) => !parentByChild.has(pipeline.id))
    .sort(compareByInputOrder(inputOrder));
  for (const root of roots) visit(root, 0, new Set<string>());
  for (const pipeline of pipelines) visit(pipeline, 0, new Set<string>());

  return rows;
}

function formatOpenItems(count: number) {
  return `${formatNumber(count)} open`;
}

function formatPipelineActivity(value: string | Date | null) {
  if (!value) return "No activity";
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return "No activity";
  const diffSeconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSeconds < 60) return "just now";
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes} min ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return diffHours === 1 ? "1 hr ago" : `${diffHours} hr ago`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 14) return "last week";
  if (diffDays < 30) return `${Math.round(diffDays / 7)} weeks ago`;
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function PipelineStatusChip({ archivedAt }: { archivedAt: Date | string | null }) {
  const paused = Boolean(archivedAt);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold",
        paused
          ? "border-muted-foreground/20 bg-muted text-muted-foreground"
          : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300",
      )}
    >
      {paused ? "Paused" : "Active"}
    </span>
  );
}

interface PipelinesIndexTableProps {
  pipelines: PipelineListItem[];
  viewMode: PipelineViewMode;
  onViewModeChange: (mode: PipelineViewMode) => void;
  connectionsAvailable: boolean;
  search: string;
  onSearchChange: (search: string) => void;
}

export function PipelinesIndexTable({
  pipelines,
  viewMode,
  onViewModeChange,
  connectionsAvailable,
  search,
  onSearchChange,
}: PipelinesIndexTableProps) {
  const [collapsedPipelineIds, setCollapsedPipelineIds] = useState<Set<string>>(() => new Set());
  const [sortField, setSortField] = useState<PipelineSortField>("name");
  const [sortDir, setSortDir] = useState<PipelineSortDir>("asc");
  const filteredPipelines = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return pipelines;
    return pipelines.filter((pipeline) => pipeline.name.toLowerCase().includes(q));
  }, [pipelines, search]);
  const sortedPipelines = useMemo(
    () => [...filteredPipelines].sort(comparePipelinesBySort(sortField, sortDir)),
    [filteredPipelines, sortField, sortDir],
  );
  const effectiveViewMode = connectionsAvailable ? viewMode : "flat";
  const rows = useMemo(
    () =>
      buildPipelineTableRows(sortedPipelines, {
        viewMode: effectiveViewMode,
        collapsedPipelineIds,
      }),
    [collapsedPipelineIds, effectiveViewMode, sortedPipelines],
  );

  const selectSort = (field: PipelineSortField) => {
    if (sortField === field) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "name" ? "asc" : "desc");
    }
  };

  const togglePipeline = (pipelineId: string) => {
    setCollapsedPipelineIds((current) => {
      const next = new Set(current);
      if (next.has(pipelineId)) next.delete(pipelineId);
      else next.add(pipelineId);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 border-y border-border py-4 lg:flex-row lg:items-center lg:justify-between">
        <label className="relative block w-full max-w-md">
          <span className="sr-only">Search pipelines</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search pipelines"
            className="h-10 pl-9"
          />
        </label>
        <div className="flex items-center gap-1 shrink-0">
          <div className="flex items-center overflow-hidden rounded-md border border-border">
            <button
              type="button"
              className={cn(
                "p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                effectiveViewMode === "nested" && connectionsAvailable
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              disabled={!connectionsAvailable}
              onClick={() => onViewModeChange("nested")}
              title="Nested view"
            >
              <ListTree className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className={cn(
                "p-1.5 transition-colors",
                effectiveViewMode === "flat"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => onViewModeChange("flat")}
              title="Flat list"
            >
              <List className="h-3.5 w-3.5" />
            </button>
          </div>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" title="Sort">
                <ArrowUpDown className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-48 p-0">
              <div className="space-y-0.5 p-2">
                {PIPELINE_SORT_OPTIONS.map(([field, label]) => (
                  <button
                    key={field}
                    type="button"
                    className={cn(
                      "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm",
                      sortField === field ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50",
                    )}
                    onClick={() => selectSort(field)}
                  >
                    <span>{label}</span>
                    {sortField === field && (
                      <span className="text-xs text-muted-foreground">{sortDir === "asc" ? "↑" : "↓"}</span>
                    )}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={Hexagon} message="No pipelines match your search." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[780px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                <th className="py-2 pl-3 pr-4">Name</th>
                <th className="px-4 py-2">Attention</th>
                <th className="px-4 py-2">Open items</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const attentionCount = pipelineAttentionCount(row.pipeline);
                const inMotionCount = pipelineInMotionCount(row.pipeline);
                const liveDownstreamCount = descendantActiveWorkCount(row.pipeline);
                return (
                  <tr key={row.pipeline.id} className="h-10 border-b border-border/70">
                    <td className="pl-3 pr-4">
                      <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: row.depth * 28 }}>
                        {row.hasChildren ? (
                          <button
                            type="button"
                            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                            aria-label={row.expanded ? `Collapse ${row.pipeline.name}` : `Expand ${row.pipeline.name}`}
                            onClick={() => togglePipeline(row.pipeline.id)}
                          >
                            {row.expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </button>
                        ) : (
                          <span className="h-6 w-6 shrink-0" aria-hidden="true" />
                        )}
                        <div className="min-w-0">
                          <Link
                            to={`/pipelines/${row.pipeline.id}`}
                            className="font-semibold text-foreground hover:underline"
                          >
                            {row.pipeline.name}
                          </Link>
                          {row.parentPipelineName ? (
                            <span className="ml-2 text-muted-foreground">under {row.parentPipelineName}</span>
                          ) : row.pipeline.description ? (
                            <span className="ml-2 text-muted-foreground">- {row.pipeline.description}</span>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 text-sm">
                      <div className="flex items-center gap-3 whitespace-nowrap">
                        {attentionCount > 0 ? (
                          <span className="inline-flex items-center gap-1.5 font-semibold text-red-700 dark:text-red-400">
                            <span className="h-2 w-2 rounded-full bg-red-600" aria-hidden="true" />
                            {formatNumber(attentionCount)} to review
                          </span>
                        ) : null}
                        {inMotionCount > 0 ? (
                          <span className="text-muted-foreground">
                            {formatNumber(inMotionCount)} in motion
                          </span>
                        ) : null}
                        {liveDownstreamCount > 0 ? (
                          <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                            {formatLiveDownstream(liveDownstreamCount)}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 text-muted-foreground">{formatOpenItems(pipelineOpenItemCount(row.pipeline))}</td>
                    <td className="px-4"><PipelineStatusChip archivedAt={row.pipeline.archivedAt} /></td>
                    <td className="px-4 text-muted-foreground">{formatPipelineActivity(pipelineActivityTime(row.pipeline))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-4 text-sm text-muted-foreground">
            Showing {formatNumber(rows.length)} of {formatNumber(filteredPipelines.length)}.
          </p>
        </div>
      )}
    </div>
  );
}

function NewPipelineDialog({
  open,
  onOpenChange,
  onSubmit,
  pending,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: { name: string; description: string }) => void;
  pending: boolean;
  error: string | null;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
    }
  }, [open]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;
    onSubmit({ name: trimmedName, description: description.trim() });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New pipeline</DialogTitle>
            <DialogDescription>Name the pipeline and add a short description.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block space-y-1.5 text-sm font-medium">
              <span>Name</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
            </label>
            <label className="block space-y-1.5 text-sm font-medium">
              <span>Description</span>
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
              />
            </label>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? "Creating..." : "Create pipeline"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function pipelineKeyFromName(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "pipeline";
}

function PipelinesIndex() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<PipelineViewMode>("nested");
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);

  useEffect(() => setBreadcrumbs([{ label: "Pipelines" }]), [setBreadcrumbs]);

  const pipelinesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.pipelines.list(selectedCompanyId) : ["pipelines", "missing-company"],
    queryFn: () => pipelinesApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const createPipeline = useMutation({
    mutationFn: async (data: { name: string; description: string }) => {
      const baseKey = pipelineKeyFromName(data.name);
      try {
        return await pipelinesApi.create(selectedCompanyId!, {
          key: baseKey,
          name: data.name,
          description: data.description || null,
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          return await pipelinesApi.create(selectedCompanyId!, {
            key: `${baseKey}-${Date.now().toString(36)}`,
            name: data.name,
            description: data.description || null,
          });
        }
        throw error;
      }
    },
    onSuccess: async (pipeline) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.list(selectedCompanyId!) });
      setNewPipelineOpen(false);
      navigate(`/pipelines/${pipeline.id}/settings`);
    },
  });

  if (!selectedCompanyId) {
    return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">Select a company to view pipelines.</div>;
  }
  if (pipelinesQuery.isLoading) return <PageSkeleton />;

  const pipelines = pipelinesQuery.data ?? [];
  const connectionsAvailable = pipelinesHaveConnectionData(pipelines);

  return (
    <div className="w-full max-w-6xl px-6 py-8">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Work</p>
          <h1 className="text-2xl font-semibold text-foreground">Pipelines</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatNumber(pipelines.length)} pipeline{pipelines.length === 1 ? "" : "s"}. Connected ones are grouped from upstream work into downstream work.
          </p>
        </div>
        <Button onClick={() => setNewPipelineOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New pipeline
        </Button>
      </div>

      {pipelinesQuery.error ? (
        <p className="mb-4 text-sm text-destructive">Could not load pipelines.</p>
      ) : null}

      {pipelines.length === 0 && !pipelinesQuery.error ? (
        <EmptyState
          icon={Hexagon}
          message="No pipelines yet."
          action="New pipeline"
          onAction={() => setNewPipelineOpen(true)}
        />
      ) : (
        <PipelinesIndexTable
          pipelines={pipelines}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          connectionsAvailable={connectionsAvailable}
          search={search}
          onSearchChange={setSearch}
        />
      )}

      <NewPipelineDialog
        open={newPipelineOpen}
        onOpenChange={(open) => {
          setNewPipelineOpen(open);
          if (!open) createPipeline.reset();
        }}
        onSubmit={(data) => createPipeline.mutate(data)}
        pending={createPipeline.isPending}
        error={createPipeline.error ? "Could not create the pipeline. Try a different name." : null}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pipeline board
// ---------------------------------------------------------------------------

const UNASSIGNED_STAGE_ID = "__pipeline_unassigned_stage";
const UNASSIGNED_STAGE_NAME = "Unassigned";

type BoardCase = PipelineCase & {
  activeWork?: PipelineCaseActiveWork | null;
  descendantActiveWorkCount?: number | null;
};

type PipelineTransitionEdge = { fromStageId: string; toStageId: string; label?: string | null };

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const next = value.trim();
  return next.length === 0 ? null : next;
}

function asBoardBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
  }
  return false;
}

function asPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return null;
}

export function getCaseTitle(caseItem: BoardCase) {
  const fields = caseItem.fields ?? {};
  const candidateKeys = [
    "title",
    "name",
    "summary",
    "subject",
    "item_title",
    "itemTitle",
    "issueTitle",
    "ticketTitle",
  ] as const;

  const direct = asText(caseItem.title);
  if (direct) return direct;
  for (const key of candidateKeys) {
    const value = asText(fields[key]);
    if (value) return value;
  }
  return "Untitled item";
}

export function isWorkingCase(caseItem: BoardCase) {
  if (caseItem.activeWork && typeof caseItem.activeWork === "object") return true;
  const fields = caseItem.fields ?? {};
  return (
    asBoardBoolean(fields.activeWork) ||
    asBoardBoolean(fields.active_work) ||
    asBoardBoolean(fields.isActiveWork) ||
    asBoardBoolean(fields.working) ||
    asBoardBoolean(fields.isWorking)
  );
}

export function getOpenBlockerCount(caseItem: BoardCase) {
  const fields = caseItem.fields ?? {};
  return asPositiveInteger(fields.openBlockers) ?? 0;
}

export function hasThisChanged(caseItem: BoardCase) {
  const fields = caseItem.fields ?? {};
  if (fields.changeAcknowledgedAt) return false;
  return (
    asBoardBoolean(fields.thisChanged) ||
    asBoardBoolean(fields["this changed"]) ||
    asBoardBoolean(fields.this_changed) ||
    asBoardBoolean(fields.hasThisChanged) ||
    Boolean(fields.upstreamChanged) ||
    Boolean(fields.upstreamDrift)
  );
}

export function getChildrenSummaryCount(caseItem: BoardCase) {
  if (typeof caseItem.childCount === "number" && caseItem.childCount > 0) {
    return Math.floor(caseItem.childCount);
  }
  const fields = caseItem.fields ?? {};
  const fromFields = asPositiveInteger(fields.childrenSummary);
  if (fromFields != null && fromFields > 0) return fromFields;
  return null;
}

export function createUnassignedStage(pipelineId: string): PipelineStage {
  return {
    id: UNASSIGNED_STAGE_ID,
    pipelineId,
    key: "__unassigned",
    name: UNASSIGNED_STAGE_NAME,
    kind: "working",
    position: Number.MAX_SAFE_INTEGER,
    config: {},
  };
}

export function isGuardedTransitionAllowed(
  transitions: PipelineTransitionEdge[],
  sourceStageId: string | null,
  targetStageId: string,
) {
  if (!transitions.length) return true;
  if (!sourceStageId) return false;
  if (sourceStageId === targetStageId) return true;

  for (const transition of transitions) {
    if (transition.fromStageId === sourceStageId && transition.toStageId === targetStageId) {
      return true;
    }
  }
  return false;
}

export function resolvePipelineTargetStageId(
  overId: string,
  columns: Set<string>,
  caseToColumnId: Map<string, string>,
) {
  if (columns.has(overId)) return overId;
  return caseToColumnId.get(overId) ?? null;
}

function PipelineCaseCard({
  caseItem,
  isOverlay = false,
}: {
  caseItem: BoardCase;
  isOverlay?: boolean;
}) {
  const title = getCaseTitle(caseItem);
  const isWorking = isWorkingCase(caseItem);
  const blockerCount = getOpenBlockerCount(caseItem);
  const hasNeedsAttention = blockerCount > 0;
  const hasChangedNotice = hasThisChanged(caseItem);
  const childrenSummary = getChildrenSummaryCount(caseItem);
  const liveDownstreamCount = descendantActiveWorkCount(caseItem);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: caseItem.id, data: { caseItem } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`rounded-md border bg-card px-3 py-2 text-sm ${
        isDragging && !isOverlay ? "opacity-40" : ""
      } ${isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:shadow-sm"}`}
    >
      <Link
        to={`/pipelines/${caseItem.pipelineId}/items/${caseItem.id}`}
        onClick={(event) => {
          if (isDragging) event.preventDefault();
        }}
        className="block text-inherit no-underline"
      >
        <p className="font-medium leading-snug text-foreground">{title}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {isWorking ? (
            <span className="relative inline-flex items-center rounded-full border border-emerald-400/40 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:border-emerald-300/30 dark:bg-emerald-900/30 dark:text-emerald-300">
              <span className="absolute -left-1 -top-1 h-2 w-2 animate-pulse rounded-full bg-emerald-500"></span>
              Working
            </span>
          ) : null}
          {hasNeedsAttention ? (
            <span className="inline-flex items-center rounded-full border border-amber-400/40 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-300/30 dark:bg-amber-900/25 dark:text-amber-300">
              Needs attention
            </span>
          ) : null}
          {hasChangedNotice ? (
            <span className="inline-flex items-center rounded-full border border-indigo-400/40 bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700 dark:border-indigo-300/30 dark:bg-indigo-900/25 dark:text-indigo-300">
              This changed
            </span>
          ) : null}
          {liveDownstreamCount > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/35 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:border-emerald-300/30 dark:bg-emerald-900/25 dark:text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
              {formatLiveDownstream(liveDownstreamCount)}
            </span>
          ) : null}
        </div>
        {childrenSummary != null ? (
          <p className="mt-1.5 text-xs text-muted-foreground">
            Built from {formatNumber(childrenSummary)} {childrenSummary === 1 ? "item" : "items"}
          </p>
        ) : null}
      </Link>
    </div>
  );
}

function PipelineBoardColumn({
  stage,
  cases,
  settingsHref,
  warningCount,
  breakdownTarget,
  onColumnEmpty,
  isDragTargeted,
  isDragBlocked,
}: {
  stage: PipelineStage;
  cases: BoardCase[];
  settingsHref?: string | null;
  warningCount?: number;
  breakdownTarget?: { pipelineId: string; name: string } | null;
  onColumnEmpty?: (stage: PipelineStage) => string;
  isDragTargeted?: boolean;
  isDragBlocked?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });

  const isBlockedDropTarget = !!isDragTargeted && !!isDragBlocked;

  return (
    <div
      key={stage.id}
      aria-label={`${stage.name} column`}
      className={`flex min-w-[260px] max-w-[320px] shrink-0 flex-col rounded-md border border-border ${isBlockedDropTarget ? "ring-1 ring-red-500/45" : ""}`}
    >
      <div className="group/stage-header flex items-center justify-between border-b border-border px-3 py-2 text-sm font-semibold text-muted-foreground">
        <div className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate">{stage.name}</span>
          {settingsHref ? (
            <Link
              to={settingsHref}
              aria-label={`Edit ${stage.name} stage`}
              title={`Edit ${stage.name} stage`}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/stage-header:opacity-100"
            >
              <Settings className="h-3.5 w-3.5" />
            </Link>
          ) : null}
        </div>
        <span className="ml-2 flex shrink-0 items-center gap-2 text-xs">
          <span>{cases.length} item{cases.length === 1 ? "" : "s"}</span>
          {warningCount ? (
            <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5" />
              {warningCount} warning{warningCount === 1 ? "" : "s"}
            </span>
          ) : null}
        </span>
      </div>
      {breakdownTarget ? (
        <div className="border-b border-border px-3 py-1.5">
          <Link
            to={`/pipelines/${breakdownTarget.pipelineId}`}
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            title={`Breaks into ${breakdownTarget.name}`}
          >
            <span className="shrink-0">→</span>
            <span className="truncate">Breaks into {breakdownTarget.name}</span>
          </Link>
        </div>
      ) : null}
      <div
        ref={setNodeRef}
        className={`min-h-[160px] flex-1 space-y-2 rounded-b-md px-2 py-2 transition-colors ${
          isBlockedDropTarget ? "bg-red-50 dark:bg-red-950/30" : isOver ? "bg-accent/40" : ""
        }`}
      >
        {isBlockedDropTarget ? (
          <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
            This move skips the normal flow
          </p>
        ) : null}
        <SortableContext items={cases.map((entry) => entry.id)} strategy={verticalListSortingStrategy}>
          {cases.length > 0 ? (
            cases.map((item) => <PipelineCaseCard key={item.id} caseItem={item} />)
          ) : (
            <div className="rounded-md border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
              {onColumnEmpty ? onColumnEmpty(stage) : "Empty"}
            </div>
          )}
        </SortableContext>
      </div>
    </div>
  );
}

function PipelineBoard({ pipelineId }: { pipelineId: string }) {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [activeCaseId, setActiveCaseId] = useState<string | null>(null);
  const [activeOverId, setActiveOverId] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<{
    caseId: string;
    caseVersion: number;
    itemTitle: string;
    sourceName: string;
    targetStageId: string;
    targetStageKey: string;
    targetName: string;
    allowed: boolean;
  } | null>(null);
  const [overrideReason, setOverrideReason] = useState("");

  const pipelineQuery = useQuery({
    queryKey: queryKeys.pipelines.detail(pipelineId),
    queryFn: () => pipelinesApi.get(pipelineId),
  });

  const casesQuery = useQuery({
    queryKey: queryKeys.pipelines.cases(pipelineId),
    queryFn: () => pipelinesApi.listCases(pipelineId),
  });

  const healthQuery = useQuery({
    queryKey: queryKeys.pipelines.health(pipelineId),
    queryFn: () => pipelinesApi.getHealth(pipelineId),
  });

  // The workspace pipeline list lets us resolve "Break into pieces" connector
  // chips by name — which pipeline this board feeds, and which feed into it.
  const allPipelinesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.pipelines.list(selectedCompanyId) : ["pipelines", "missing-company"],
    queryFn: () => pipelinesApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const pipeline = pipelineQuery.data;
  const cases = useMemo<BoardCase[]>(
    () => (casesQuery.data ?? []).map((row) => ({
      ...row.case,
      activeWork: row.activeWork ?? null,
      descendantActiveWorkCount: row.descendantActiveWorkCount ?? 0,
    })),
    [casesQuery.data],
  );

  const orderedStages = useMemo(() => {
    if (!pipeline?.stages) return [] as PipelineStage[];
    return [...pipeline.stages].sort((left, right) => left.position - right.position);
  }, [pipeline?.stages]);
  const healthWarningsByStage = useMemo(
    () => groupWarningsByStage(healthQuery.data?.warnings ?? []),
    [healthQuery.data?.warnings],
  );

  const stageIds = useMemo(() => new Set(orderedStages.map((stage) => stage.id)), [orderedStages]);

  const boardColumns = useMemo(() => {
    const byStage = new Map<string, BoardCase[]>();
    const caseToColumn = new Map<string, string>();
    const caseById = new Map<string, BoardCase>();

    for (const stage of orderedStages) {
      byStage.set(stage.id, []);
    }

    const unassigned: BoardCase[] = [];
    for (const caseItem of cases) {
      const stageId = caseItem.stageId && stageIds.has(caseItem.stageId) ? caseItem.stageId : UNASSIGNED_STAGE_ID;
      if (stageId === UNASSIGNED_STAGE_ID) {
        unassigned.push(caseItem);
      } else {
        byStage.get(stageId)!.push(caseItem);
      }
      caseToColumn.set(caseItem.id, stageId);
      caseById.set(caseItem.id, caseItem);
    }

    const columns = [...orderedStages];
    if (unassigned.length > 0) {
      byStage.set(UNASSIGNED_STAGE_ID, unassigned);
      columns.push(createUnassignedStage(pipelineId));
    }

    return { columns, byStage, caseToColumn, caseById };
  }, [orderedStages, cases, stageIds, pipelineId]);

  const transitions = useMemo<PipelineTransitionEdge[]>(
    () => pipeline?.transitions ?? [],
    [pipeline?.transitions],
  );
  const guardrailsActive = Boolean(pipeline?.enforceTransitions);
  const columnsById = useMemo(() => new Set(boardColumns.columns.map((stage) => stage.id)), [boardColumns.columns]);

  const stageNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const stage of boardColumns.columns) {
      map.set(stage.id, stage.name);
    }
    return map;
  }, [boardColumns.columns]);

  const stageKeyById = useMemo(() => {
    const map = new Map<string, string>();
    for (const stage of orderedStages) {
      map.set(stage.id, stage.key);
    }
    return map;
  }, [orderedStages]);

  const pipelineNameById = useMemo(
    () => new Map((allPipelinesQuery.data ?? []).map((entry) => [entry.id, entry.name])),
    [allPipelinesQuery.data],
  );

  // Per-stage outbound chip: "Breaks into <target>" on any stage configured to
  // break work into another pipeline.
  const breakdownTargetByStageId = useMemo(() => {
    const map = new Map<string, { pipelineId: string; name: string }>();
    for (const stage of orderedStages) {
      const breakdown = readStageBreakdown(stage);
      if (breakdown?.targetPipelineId) {
        map.set(stage.id, {
          pipelineId: breakdown.targetPipelineId,
          name: pipelineNameById.get(breakdown.targetPipelineId) ?? "another pipeline",
        });
      }
    }
    return map;
  }, [orderedStages, pipelineNameById]);

  // Inbound chip on the board title bar: which other pipelines break into this
  // one, derived from their stage configs.
  const fedByPipelines = useMemo(() => {
    const seen = new Map<string, string>();
    for (const candidate of allPipelinesQuery.data ?? []) {
      if (candidate.id === pipelineId) continue;
      for (const stage of candidate.stages ?? []) {
        const breakdown = readStageBreakdown(stage);
        if (breakdown?.targetPipelineId === pipelineId) {
          seen.set(candidate.id, candidate.name);
          break;
        }
      }
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [allPipelinesQuery.data, pipelineId]);

  const moveAllowed = useCallback(
    (sourceStageId: string | null, targetStageId: string) => {
      if (!guardrailsActive) return true;
      return transitions.length > 0 && isGuardedTransitionAllowed(transitions, sourceStageId, targetStageId);
    },
    [guardrailsActive, transitions],
  );

  const transitionCase = useMutation({
    mutationFn: ({
      caseId,
      toStageKey,
      expectedVersion,
      reason,
      force,
    }: {
      caseId: string;
      toStageKey: string;
      expectedVersion: number;
      reason?: string | null;
      force?: boolean;
    }) => pipelinesApi.transitionCase(caseId, { toStageKey, expectedVersion, reason, force }),
    onSuccess: async () => {
      setPendingMove(null);
      setOverrideReason("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.cases(pipelineId) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Move blocked",
        body:
          error instanceof ApiError && error.status === 409
            ? "This item changed while you were looking. The board has been refreshed."
            : "The item could not be moved.",
        tone: "error",
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.cases(pipelineId) });
    },
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function handleDragStart(event: DragStartEvent) {
    setActiveCaseId(event.active.id as string);
    setActiveOverId(null);
  }

  function handleDragOver(event: DragOverEvent) {
    setActiveOverId(event.over ? String(event.over.id) : null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveCaseId(null);
    setActiveOverId(null);
    const { active, over } = event;
    if (!over) return;

    const activeCaseIdValue = active.id as string;
    const activeCase = boardColumns.caseById.get(activeCaseIdValue);
    if (!activeCase) return;

    const sourceStageId = boardColumns.caseToColumn.get(activeCaseIdValue) ?? null;
    const targetStageId = resolvePipelineTargetStageId(
      over.id as string,
      columnsById,
      boardColumns.caseToColumn,
    );

    if (!targetStageId || sourceStageId === targetStageId) return;
    if (targetStageId === UNASSIGNED_STAGE_ID) return;
    const targetStageKey = stageKeyById.get(targetStageId);
    if (!targetStageKey) return;

    const sourceName = stageNameById.get(sourceStageId ?? "") ?? UNASSIGNED_STAGE_NAME;
    const targetName = stageNameById.get(targetStageId) ?? UNASSIGNED_STAGE_NAME;
    setPendingMove({
      caseId: activeCase.id,
      caseVersion: activeCase.version ?? 1,
      itemTitle: getCaseTitle(activeCase),
      sourceName,
      targetStageId,
      targetStageKey,
      targetName,
      allowed: moveAllowed(sourceStageId, targetStageId),
    });
  }

  useEffect(() => {
    setBreadcrumbs([
      { label: "Pipelines", href: "/pipelines" },
      { label: pipeline?.name ?? "Pipeline" },
    ]);
  }, [pipeline?.name, setBreadcrumbs]);

  if (pipelineQuery.isLoading || casesQuery.isLoading) return <PageSkeleton />;
  if (!pipeline) {
    return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">Pipeline not found.</div>;
  }

  if (orderedStages.length === 0) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 px-6 py-8">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Pipeline</p>
          <h1 className="text-2xl font-semibold text-foreground">{pipeline.name}</h1>
          <p className="text-sm text-muted-foreground">No stages are set up for this pipeline yet.</p>
        </div>
        <EmptyState
          icon={Hexagon}
          message="Add stages in pipeline settings to enable the board."
          action="Open settings"
          onAction={() => navigate(`/pipelines/${pipelineId}/settings`)}
        />
      </div>
    );
  }

  const activeCase = activeCaseId ? boardColumns.caseById.get(activeCaseId) ?? null : null;

  return (
    <div className="w-full space-y-4 px-6 py-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Pipeline</p>
          <h1 className="text-2xl font-semibold text-foreground">{pipeline.name}</h1>
          {pipeline.description ? <p className="mt-1 text-sm text-muted-foreground">{pipeline.description}</p> : null}
          <p className="mt-1 text-xs text-muted-foreground">{cases.length} total item{cases.length === 1 ? "" : "s"}</p>
          {fedByPipelines.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {fedByPipelines.map((source) => (
                <Link
                  key={source.id}
                  to={`/pipelines/${source.id}`}
                  className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                  title={`Fed by ${source.name}`}
                >
                  <span className="shrink-0">←</span>
                  <span className="truncate">Fed by {source.name}</span>
                </Link>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
          <Button asChild>
            <Link to={`/pipelines/${pipelineId}/add`}>
              <Plus className="mr-2 h-4 w-4" />
              Add items
            </Link>
          </Button>
          <Button variant="outline" size="icon" asChild>
            <Link to={`/pipelines/${pipelineId}/settings`} aria-label="Pipeline settings" title="Pipeline settings">
              <Settings className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>

      <PipelineHealthBar
        warnings={healthQuery.data?.warnings ?? []}
        onSelectStage={(stageId) => navigate(`/pipelines/${pipelineId}/settings?stage=${stageId}`)}
      />

      <DndContext
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        sensors={sensors}
      >
        <div className="overflow-x-auto">
          <div className="flex items-start gap-3 pb-3">
            {boardColumns.columns.map((stage) => {
              const items = boardColumns.byStage.get(stage.id) ?? [];
              const activeSourceStageId = activeCaseId ? boardColumns.caseToColumn.get(activeCaseId) ?? null : null;
              const activeTargetStageId = activeOverId
                ? resolvePipelineTargetStageId(activeOverId, columnsById, boardColumns.caseToColumn)
                : null;
              const isDragTargeted = activeCaseId != null && activeTargetStageId === stage.id;
              const isDragBlocked = isDragTargeted
                ? stage.id === UNASSIGNED_STAGE_ID || !moveAllowed(activeSourceStageId, stage.id)
                : false;
              return (
                <PipelineBoardColumn
                  key={stage.id}
                  stage={stage}
                  cases={items}
                  settingsHref={
                    stage.id === UNASSIGNED_STAGE_ID ? null : `/pipelines/${pipelineId}/settings?stage=${stage.id}`
                  }
                  warningCount={healthWarningsByStage[stage.id]?.length ?? 0}
                  breakdownTarget={breakdownTargetByStageId.get(stage.id) ?? null}
                  isDragTargeted={isDragTargeted}
                  isDragBlocked={isDragBlocked}
                  onColumnEmpty={(columnStage) =>
                    columnStage.id === UNASSIGNED_STAGE_ID ? "Unassigned items" : "Drop items here"
                  }
                />
              );
            })}
          </div>
        </div>

        <DragOverlay>
          {activeCase ? <PipelineCaseCard caseItem={activeCase} isOverlay /> : null}
        </DragOverlay>
      </DndContext>

      <Dialog
        open={Boolean(pendingMove)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingMove(null);
            setOverrideReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingMove?.allowed ? `Move ${pendingMove.itemTitle}?` : "This skips the normal flow"}
            </DialogTitle>
            <DialogDescription>
              {pendingMove?.allowed
                ? `Move ${pendingMove.itemTitle} to ${pendingMove.targetName} yourself? Usually the agent suggests this when it is ready.`
                : pendingMove
                  ? `${pendingMove.itemTitle} would jump from ${pendingMove.sourceName} to ${pendingMove.targetName}. Add a reason before overriding.`
                  : "Review this move before continuing."}
            </DialogDescription>
          </DialogHeader>
          {pendingMove && !pendingMove.allowed ? (
            <label className="block space-y-1.5 text-sm font-medium">
              <span>Reason</span>
              <Textarea
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
                rows={3}
                placeholder="Explain why this item should skip the normal flow."
                autoFocus
              />
            </label>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={transitionCase.isPending}
              onClick={() => {
                setPendingMove(null);
                setOverrideReason("");
              }}
            >
              Cancel
            </Button>
            {pendingMove?.allowed ? (
              <Button
                type="button"
                disabled={transitionCase.isPending}
                onClick={() =>
                  transitionCase.mutate({
                    caseId: pendingMove.caseId,
                    toStageKey: pendingMove.targetStageKey,
                    expectedVersion: pendingMove.caseVersion,
                  })
                }
              >
                Move it
              </Button>
            ) : pendingMove ? (
              <Button
                type="button"
                variant="destructive"
                disabled={transitionCase.isPending || !overrideReason.trim()}
                onClick={() =>
                  transitionCase.mutate({
                    caseId: pendingMove.caseId,
                    toStageKey: pendingMove.targetStageKey,
                    expectedVersion: pendingMove.caseVersion,
                    reason: overrideReason.trim(),
                    force: true,
                  })
                }
              >
                Override and move
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function PipelineItemLegacyRedirect() {
  const params = useParams<{ pipelineId?: string; caseId?: string }>();
  if (!params.pipelineId || !params.caseId) return <NavigateMissingItem />;
  return <NavigateToItem pipelineId={params.pipelineId} caseId={params.caseId} />;
}

function NavigateToItem({ pipelineId, caseId }: { pipelineId: string; caseId: string }) {
  return <LinkRedirect to={`/pipelines/${pipelineId}/items/${caseId}`} />;
}

function NavigateMissingItem() {
  return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">Item not found.</div>;
}

function LinkRedirect({ to }: { to: string }) {
  const navigate = useNavigate();
  useEffect(() => {
    navigate(to, { replace: true });
  }, [navigate, to]);
  return null;
}

export function PipelineItemDetail() {
  const params = useParams<{ pipelineId?: string; caseId?: string }>();
  if (!params.pipelineId || !params.caseId) return <NavigateMissingItem />;
  return <PipelineItemDetailView pipelineId={params.pipelineId} caseId={params.caseId} />;
}

export function PipelineItemDetailView({ pipelineId, caseId }: { pipelineId: string; caseId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId } = useCompany();
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [moveStageKey, setMoveStageKey] = useState("");
  const [reviewDecisionNote, setReviewDecisionNote] = useState("");
  const [livenessRetryError, setLivenessRetryError] = useState<string | null>(null);
  const [retryDialogScope, setRetryDialogScope] = useState<PipelineAutomationRetryScope | null>(null);
  const [selectedRetryCleanupIds, setSelectedRetryCleanupIds] = useState<Set<string>>(() => new Set());
  const [retryDialogError, setRetryDialogError] = useState<string | null>(null);

  const pipeline = useQuery({
    queryKey: queryKeys.pipelines.detail(pipelineId),
    queryFn: () => pipelinesApi.get(pipelineId),
  });
  const item = useQuery({
    queryKey: queryKeys.pipelines.caseDetail(caseId),
    queryFn: () => pipelinesApi.getCase(caseId),
  });
  const children = useQuery({
    queryKey: queryKeys.pipelines.caseChildren(caseId),
    queryFn: () => pipelinesApi.getCaseChildren(caseId),
  });
  const events = useQuery({
    queryKey: queryKeys.pipelines.caseEvents(caseId),
    queryFn: () => pipelinesApi.getCaseEvents(caseId, { order: "asc", limit: 100 }),
  });
  const issueLinks = useQuery({
    queryKey: queryKeys.pipelines.caseIssueLinks(caseId),
    queryFn: () => pipelinesApi.getCaseIssueLinks(caseId),
  });

  const detail = item.data;
  const reviewQueueItems = useQuery({
    queryKey: selectedCompanyId
      ? ["pipelines", "review-cases", selectedCompanyId, "pipeline", pipelineId]
      : ["pipelines", "review-cases", "__none__", "pipeline", pipelineId],
    queryFn: () => pipelinesApi.listReviewCases(selectedCompanyId!, { pipelineId }),
    enabled: Boolean(selectedCompanyId && detail?.stage.kind === "review"),
  });
  const stages = pipeline.data?.stages ?? detail?.allowedNextStages ?? [];
  const stageLookup = useMemo(() => {
    const lookup = new Map<string, string>();
    for (const stage of stages) {
      lookup.set(stage.id, stage.name);
      lookup.set(stage.key, stage.name);
    }
    return lookup;
  }, [stages]);
  const conversationLink = useMemo(() => {
    const links = issueLinks.data ?? [];
    return links.find((link) => link.link.role === "conversation")
      ?? links.find((link) => link.link.role === "work")
      ?? null;
  }, [issueLinks.data]);
  const conversationIssue = detail?.conversationSource?.issue ?? conversationLink?.issue ?? null;
  const linkedIssues = useMemo(() => {
    const byIssueId = new Map<string, PipelineCaseIssueLinkWithIssue["issue"]>();
    for (const link of issueLinks.data ?? []) {
      byIssueId.set(link.issue.id, link.issue);
    }
    return [...byIssueId.values()];
  }, [issueLinks.data]);
  const linkedIssueAssets = useQuery({
    queryKey: ["pipelines", "item", caseId, "linked-issue-assets", linkedIssues.map((issue) => issue.id)],
    queryFn: async () => {
      const groups = await Promise.all(
        linkedIssues.map(async (issue) => ({
          issue,
          attachments: await issuesApi.listAttachments(issue.id),
        })),
      );
      return groups.filter((group) => group.attachments.length > 0);
    },
    enabled: issueLinks.isSuccess && linkedIssues.length > 0,
  });
  const conversationIssueId = conversationIssue?.id ?? null;
  const comments = useQuery({
    queryKey: conversationIssueId ? queryKeys.issues.comments(conversationIssueId) : ["pipeline-item", caseId, "missing-conversation"],
    queryFn: () => issuesApi.listComments(conversationIssueId!, { order: "asc", limit: 50 }),
    enabled: Boolean(conversationIssueId),
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Pipelines", href: "/pipelines" },
      { label: pipeline.data?.name ?? detail?.pipeline.name ?? "Pipeline", href: `/pipelines/${pipelineId}` },
      { label: detail?.case.title ?? "Item" },
    ]);
  }, [detail?.case.title, detail?.pipeline.name, pipeline.data?.name, pipelineId, setBreadcrumbs]);

  const invalidateItem = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.cases(pipelineId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseDetail(caseId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseEvents(caseId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseIssueLinks(caseId) }),
    ]);
  }, [caseId, pipelineId, queryClient]);

  const startConversation = useMutation({
    mutationFn: async () => {
      await pipelinesApi.createIssueLink(caseId, { role: "conversation" });
    },
    onSuccess: async () => {
      await invalidateItem();
      pushToast({ title: "Conversation started", tone: "success" });
    },
    onError: () => pushToast({ title: "Could not start the conversation", tone: "error" }),
  });

  const addConversationComment = useCallback(async (body: string) => {
    if (!conversationIssueId) return;
    await issuesApi.addComment(conversationIssueId, body);
    await queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(conversationIssueId) });
  }, [conversationIssueId, queryClient]);

  const resolveSuggestion = useMutation({
    mutationFn: ({ resolution, suggestionId }: { resolution: "accept" | "dismiss"; suggestionId: string }) =>
      pipelinesApi.resolveSuggestion(caseId, {
        suggestionId,
        resolution,
        expectedVersion: detail?.case.version,
      }),
    onSuccess: async (_result, variables) => {
      await invalidateItem();
      pushToast({
        title: variables.resolution === "accept" ? "Move approved" : "Suggestion dismissed",
        tone: "success",
      });
    },
    onError: () => pushToast({ title: "Could not resolve the suggestion", tone: "error" }),
  });

  const acknowledgeChange = useMutation({
    mutationFn: () => pipelinesApi.acknowledgeDrift(caseId, { expectedVersion: detail?.case.version }),
    onSuccess: async () => {
      await invalidateItem();
      pushToast({ title: "Change acknowledged", tone: "success" });
    },
    onError: () => pushToast({ title: "Could not acknowledge the change", tone: "error" }),
  });

  const previousRetryAvailability = useQuery({
    queryKey: ["pipelines", "item", caseId, "automation-retry-plan", "previous_stage"],
    queryFn: () => pipelinesApi.getAutomationRetryPlan(caseId, "previous_stage"),
    enabled: Boolean(caseId),
    retry: false,
  });

  const retryPlan = useQuery({
    queryKey: ["pipelines", "item", caseId, "automation-retry-plan", retryDialogScope],
    queryFn: () => pipelinesApi.getAutomationRetryPlan(caseId, retryDialogScope!),
    enabled: Boolean(retryDialogScope),
    retry: false,
  });

  useEffect(() => {
    if (!retryPlan.data) return;
    setRetryDialogError(null);
    setSelectedRetryCleanupIds(selectedCleanupIds(retryPlan.data));
  }, [retryPlan.data]);

  const rerunCurrentStageAutomation = useMutation({
    mutationFn: () => pipelinesApi.retryStageAutomation(caseId, {
      scope: "current_stage",
      expectedVersion: retryPlan.data?.caseVersion ?? detail?.case.version ?? 1,
      cleanup: retryCleanupFromIds(selectedRetryCleanupIds),
    }),
    onSuccess: async () => {
      setRetryDialogScope(null);
      await invalidateItem();
      pushToast({ title: "Step automation re-run started", tone: "success" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError && error.message ? error.message : "Could not re-run this step.";
      setRetryDialogError(message);
      pushToast({ title: "Could not re-run this step", tone: "error" });
    },
  });

  const retryStageAutomation = useMutation({
    mutationFn: (plan: PipelineAutomationRetryPlan) => pipelinesApi.retryStageAutomation(caseId, {
      scope: plan.scope,
      expectedVersion: plan.caseVersion,
      cleanup: retryCleanupFromIds(selectedRetryCleanupIds),
    }),
    onSuccess: async () => {
      setRetryDialogScope(null);
      setRetryDialogError(null);
      await Promise.all([
        invalidateItem(),
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.cases(pipelineId) }),
        queryClient.invalidateQueries({ queryKey: ["pipelines", "item", caseId, "automation-retry-plan"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseChildren(caseId) }),
      ]);
      pushToast({ title: "Retry started", tone: "success" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError && error.message ? error.message : "Could not retry this automation.";
      setRetryDialogError(message);
      pushToast({ title: "Could not retry this automation", tone: "error" });
    },
  });

  // Liveness banner retry. Targets the specific failed automation ledger when we
  // know its id (e.g. permission-restored recovery), otherwise falls back to
  // re-running the current stage's entry automation. Surfaces the API error
  // inline so a 403/409 is never silently dropped.
  const retryLiveness = useMutation({
    mutationFn: (kind: LivenessRetryKind) => {
      const automationId = detail?.liveness?.automation?.automationId ?? null;
      if (kind === "automation" && automationId) {
        return pipelinesApi.retryAutomation(caseId, automationId);
      }
      return pipelinesApi.rerunCurrentStageAutomation(caseId);
    },
    onMutate: () => setLivenessRetryError(null),
    onSuccess: async () => {
      await invalidateItem();
      pushToast({ title: "Retry started", tone: "success" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError && error.message
        ? error.message
        : "Could not retry. Please try again.";
      setLivenessRetryError(message);
      pushToast({ title: "Could not retry the automation", tone: "error" });
    },
  });

  const removeStage = useMemo(
    () => stages.find((stage) => stage.kind === "cancelled") ?? stages.find((stage) => stage.key === "cancelled") ?? null,
    [stages],
  );
  const moveStageOptions = useMemo(
    () => stages
      .filter((stage) => stage.id !== detail?.stage.id)
      .sort((left, right) => left.position - right.position),
    [detail?.stage.id, stages],
  );
  const selectedMoveStage = useMemo(
    () => moveStageOptions.find((stage) => stage.key === moveStageKey) ?? null,
    [moveStageKey, moveStageOptions],
  );
  const moveItemToStage = useMutation({
    mutationFn: () => {
      if (!selectedMoveStage || !detail?.case.version) throw new Error("Missing target stage");
      return pipelinesApi.transitionCase(caseId, {
        toStageKey: selectedMoveStage.key,
        expectedVersion: detail.case.version,
        reason: `Manual board override from item page: moved from ${detail.stage.name} to ${selectedMoveStage.name}.`,
        force: true,
      });
    },
    onSuccess: async () => {
      setMoveDialogOpen(false);
      setMoveStageKey("");
      await invalidateItem();
      pushToast({ title: "Item moved", tone: "success" });
    },
    onError: () => pushToast({ title: "Could not move the item", tone: "error" }),
  });
  const removeItem = useMutation({
    mutationFn: () => {
      if (!removeStage || !detail?.case.version) throw new Error("Missing removal stage");
      return pipelinesApi.transitionCase(caseId, {
        toStageKey: removeStage.key,
        expectedVersion: detail.case.version,
        reason: "Removed from the item detail page.",
      });
    },
    onSuccess: async () => {
      setRemoveDialogOpen(false);
      await invalidateItem();
      pushToast({ title: "Item removed", tone: "success" });
      navigate(`/pipelines/${pipelineId}`);
    },
    onError: () => pushToast({ title: "Could not remove the item", tone: "error" }),
  });

  const reviewConfig = useMemo(
    () => detail ? reviewDecisionConfig(detail.stage, stages) : null,
    [detail, stages],
  );
  const reviewActions = useMemo(
    () => reviewConfig ? reviewDecisionActions(reviewConfig, stageLookup) : [],
    [reviewConfig, stageLookup],
  );
  const nextReviewItem = useMemo(() => {
    const rows = reviewQueueItems.data ?? [];
    if (rows.length === 0) return null;
    const currentIndex = rows.findIndex((row) => row.case.id === caseId);
    if (currentIndex >= 0) {
      const laterRow = rows.slice(currentIndex + 1).find((row) => row.case.id !== caseId);
      if (laterRow) return laterRow;
    }
    return rows.find((row) => row.case.id !== caseId) ?? null;
  }, [caseId, reviewQueueItems.data]);
  const decideReview = useMutation({
    mutationFn: ({ decision }: { decision: PipelineReviewDecision }) => {
      if (!detail?.case.version) throw new Error("Missing item version");
      return pipelinesApi.reviewCase(caseId, {
        decision,
        reason: reviewDecisionNote.trim() || null,
        expectedVersion: detail.case.version,
      });
    },
    onSuccess: async (_result, variables) => {
      let nextHref = nextReviewItem
        ? `/pipelines/${nextReviewItem.pipeline.id}/items/${nextReviewItem.case.id}`
        : null;
      if (!nextHref && selectedCompanyId) {
        try {
          const latestReviewItems = await pipelinesApi.listReviewCases(selectedCompanyId, { pipelineId });
          const latestNextItem = latestReviewItems.find((row) => row.case.id !== caseId) ?? null;
          nextHref = latestNextItem
            ? `/pipelines/${latestNextItem.pipeline.id}/items/${latestNextItem.case.id}`
            : null;
        } catch {
          nextHref = null;
        }
      }
      setReviewDecisionNote("");
      await Promise.all([
        invalidateItem(),
        selectedCompanyId
          ? queryClient.invalidateQueries({ queryKey: ["pipelines", "review-cases", selectedCompanyId] })
          : Promise.resolve(),
      ]);
      pushToast({
        title: reviewDecisionToastTitle(variables.decision, Boolean(nextHref)),
        tone: "success",
      });
      if (nextHref) navigate(nextHref);
    },
    onError: () => pushToast({ title: "Could not update the review", tone: "error" }),
  });

  if (pipeline.isLoading || item.isLoading) return <PageSkeleton />;
  if (!detail || !pipeline.data) {
    return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">Item not found.</div>;
  }

  const workReferences = extractWorkReferences(detail.case);
  const referenceKeys = referenceFieldKeys(detail.case.fields);
  const { shortFields: itemFields, longFields: mainPaneFields } = splitPipelineItemFields(
    displayPipelineItemFields(detail.case.fields).filter((field) => !referenceKeys.has(field.key)),
  );
  const banner = getPendingTransitionBannerState(detail.case, stageLookup);
  const statusLabel = humanizePipelineItemStatus(detail.case.terminalKind ?? detail.stage.kind);
  const stageAutomation = currentStageAutomation(detail.stage);
  const previousRetryPlan = previousRetryAvailability.data;
  // Don't let the operator re-run automation into the same 403 — they must get
  // the grant first. The banner's "Request access" path is the way out.
  const rerunBlockedByPermission = shouldDisableRerunForPermission(detail.liveness);
  const childRows = normalizePipelineChildRows(children.data);
  const eventRows = events.data?.items ?? [];
  const activeWork = detail.activeWork ?? null;
  const conversationIssuePath = conversationIssue ? issueDetailPath(conversationIssue) : null;
  const conversationIssueState = conversationIssue ? withIssueDetailHeaderSeed(null, conversationIssue) : undefined;
  const waitingChildren = getWaitingChildren(childRows);
  const childrenGate = hasChildrenGate(detail.stage);
  // "Break into pieces" rollup: the configured piece noun drives every count
  // string when this case's stage breaks work into another pipeline.
  const breakdown = readStageBreakdown(detail.stage);
  const pieceCountTotal = detail.childrenSummary.childCount;
  const pieceCountDone = detail.childrenSummary.terminalChildCount;
  const pieceNoun = breakdown?.pieceNoun ?? "piece";
  const pieceNounPluralLabel = pieceNounPlural(pieceNoun);
  const pieceLabel = (count: number) => (count === 1 ? pieceNoun : pieceNounPluralLabel);
  const changedNotice = itemHasChangedNotice(detail.case) ?? changedNoticeFromEvents(eventRows);
  const primaryAction = conversationIssue
    ? (
        <Button asChild>
          <Link to={conversationIssuePath!} state={conversationIssueState} issuePrefetch={conversationIssue}>
            <MessageSquare className="mr-2 h-4 w-4" />
            Open conversation
          </Link>
        </Button>
      )
    : (
        <Button onClick={() => startConversation.mutate()} disabled={startConversation.isPending}>
          <MessageSquare className="mr-2 h-4 w-4" />
          {startConversation.isPending ? "Starting..." : "Start a conversation"}
        </Button>
      );
  const reviewPanel = detail.stage.kind === "review" && reviewConfig ? (
    <ReviewDecisionPanel
      actions={reviewActions}
      note={reviewDecisionNote}
      requireReason={reviewConfig.requireRejectReason}
      pendingDecision={decideReview.variables?.decision ?? null}
      pending={decideReview.isPending}
      nextItemTitle={nextReviewItem?.case.title ?? null}
      onNoteChange={setReviewDecisionNote}
      onDecide={(decision) => decideReview.mutate({ decision })}
    />
  ) : null;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start lg:gap-8">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Link to="/pipelines" className="hover:text-foreground">Pipelines</Link>
            <ChevronRight className="h-3.5 w-3.5" />
            <Link to={`/pipelines/${pipelineId}`} className="hover:text-foreground">{pipeline.data.name}</Link>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="min-w-0 text-2xl font-semibold text-foreground">{detail.case.title}</h1>
            <span className="rounded-sm border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {statusLabel}
            </span>
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              Stage: <span className="font-medium text-foreground">{detail.stage.name}</span>
            </div>
          </div>
          {detail.parentCase ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Built for{" "}
              <Link
                to={`/pipelines/${detail.parentCase.case.pipelineId}/items/${detail.parentCase.case.id}`}
                className="font-medium text-foreground hover:underline"
              >
                {detail.parentCase.pipeline.name}: {detail.parentCase.case.title}
              </Link>
            </p>
          ) : null}
        </div>
        <div className="flex w-full flex-col gap-5">
          <div className="flex items-center gap-2 lg:justify-end">
            {primaryAction}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="Item actions">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={!stageAutomation || rerunCurrentStageAutomation.isPending || rerunBlockedByPermission}
                  title={rerunBlockedByPermission ? "Permission still missing — request access first" : undefined}
                  onSelect={(event) => {
                    event.preventDefault();
                    setRetryDialogScope("current_stage");
                  }}
                >
                  {rerunCurrentStageAutomation.isPending && retryDialogScope === "current_stage" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CircleDot className="h-4 w-4" />
                  )}
                  Re-run this step
                </DropdownMenuItem>
                {previousRetryPlan?.allowed ? (
                  <DropdownMenuItem
                    disabled={retryStageAutomation.isPending}
                    onSelect={(event) => {
                      event.preventDefault();
                      setRetryDialogScope("previous_stage");
                    }}
                  >
                    {retryStageAutomation.isPending && retryDialogScope === "previous_stage" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ArrowUpDown className="h-4 w-4" />
                    )}
                    Retry previous step...
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  disabled={moveStageOptions.length === 0 || moveItemToStage.isPending}
                  onSelect={(event) => {
                    event.preventDefault();
                    setMoveStageKey(moveStageOptions[0]?.key ?? "");
                    setMoveDialogOpen(true);
                  }}
                >
                  <ArrowUpDown className="h-4 w-4" />
                  Move to stage...
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  disabled={!removeStage || removeItem.isPending}
                  onSelect={(event) => {
                    event.preventDefault();
                    setRemoveDialogOpen(true);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                  Remove item
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <Dialog open={moveDialogOpen} onOpenChange={setMoveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move to stage</DialogTitle>
            <DialogDescription>
              Manual moves can bypass the normal agent handoff for this item. Let automation move work when possible;
              use this override only when the board needs to correct the item state.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="rounded-sm border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100">
              <div className="flex gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  Moving this item may skip stage automation, review expectations, and configured transition paths.
                  Paperclip will still enforce blockers and other hard safety checks.
                </p>
              </div>
            </div>
            <label className="block space-y-2">
              <span className="text-sm font-medium text-foreground">Stage</span>
              <Select value={moveStageKey} onValueChange={setMoveStageKey}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a stage" />
                </SelectTrigger>
                <SelectContent>
                  {moveStageOptions.map((stage) => (
                    <SelectItem key={stage.id} value={stage.key}>
                      {stage.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setMoveDialogOpen(false)}
              disabled={moveItemToStage.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => moveItemToStage.mutate()}
              disabled={!selectedMoveStage || moveItemToStage.isPending}
            >
              {moveItemToStage.isPending ? "Moving..." : `Move to ${selectedMoveStage?.name ?? "stage"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(retryDialogScope)} onOpenChange={(open) => {
        if (!open) {
          setRetryDialogScope(null);
          setRetryDialogError(null);
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{retryDialogScope === "previous_stage" ? "Retry previous step" : "Re-run this step"}</DialogTitle>
            <DialogDescription>
              Review the automation preflight before Paperclip dispatches a fresh run.
            </DialogDescription>
          </DialogHeader>
          {retryPlan.isLoading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking retry safety...
            </div>
          ) : retryPlan.error ? (
            <div className="rounded-sm border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {retryPlan.error instanceof ApiError && retryPlan.error.message
                ? retryPlan.error.message
                : "Could not check whether this automation can be retried."}
            </div>
          ) : retryPlan.data ? (
            <div className="space-y-4 py-2">
              <div className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <div className="text-xs font-medium uppercase text-muted-foreground">From</div>
                  <div className="mt-1 font-medium text-foreground">{retryPlan.data.currentStage.name}</div>
                </div>
                <div>
                  <div className="text-xs font-medium uppercase text-muted-foreground">Runs at</div>
                  <div className="mt-1 font-medium text-foreground">{retryPlan.data.targetStage?.name ?? "No retryable step"}</div>
                </div>
                <div className="sm:col-span-2">
                  <div className="text-xs font-medium uppercase text-muted-foreground">Automation</div>
                  <div className="mt-1 text-foreground">
                    {retryPlan.data.routine
                      ? `Routine ${retryPlan.data.routine.id}${retryPlan.data.routine.assigneeAgentId ? ` with assignee ${retryPlan.data.routine.assigneeAgentId}` : ""}`
                      : "No routine configured"}
                  </div>
                </div>
              </div>

              <div className="grid gap-2 text-sm sm:grid-cols-4">
                <RetryMetric label="children" value={retryPlan.data.effectCounts.directChildren} />
                <RetryMetric label="descendants" value={retryPlan.data.effectCounts.descendants} />
                <RetryMetric label="linked issues" value={retryPlan.data.effectCounts.linkedAutomationIssues} />
                <RetryMetric label="active work" value={retryPlan.data.effectCounts.activeDescendants} tone={retryPlan.data.effectCounts.activeDescendants > 0 ? "warning" : "default"} />
              </div>

              {retryPlan.data.blockers.length > 0 ? (
                <div className="space-y-2">
                  {retryPlan.data.blockers.map((blocker) => (
                    <div
                      key={blocker.kind}
                      className={cn(
                        "flex gap-2 rounded-sm border p-3 text-sm",
                        "border-destructive/30 bg-destructive/5 text-destructive",
                      )}
                    >
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{blocker.message}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="space-y-2">
                {retryCleanupItems(retryPlan.data).map((option) => {
                  const checked = selectedRetryCleanupIds.has(option.id);
                  return (
                    <label
                      key={option.id}
                      className={cn(
                        "grid grid-cols-[18px_minmax(0,1fr)] gap-3 py-1.5 text-sm",
                        option.disabled && !option.required ? "text-muted-foreground" : "text-foreground",
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={option.disabled || option.required}
                        onCheckedChange={(value) => {
                          setSelectedRetryCleanupIds((current) => {
                            const next = new Set(current);
                            if (value) next.add(option.id);
                            else next.delete(option.id);
                            return next;
                          });
                        }}
                      />
                      <span>
                        <span className="block font-medium">
                          {option.label}{typeof option.count === "number" ? ` (${formatNumber(option.count)})` : ""}
                        </span>
                        <span className="block text-xs text-muted-foreground">{option.description}</span>
                      </span>
                    </label>
                  );
                })}
              </div>

              {retryDialogError ? (
                <div className="rounded-sm border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  {retryDialogError}
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRetryDialogScope(null)}
              disabled={rerunCurrentStageAutomation.isPending || retryStageAutomation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                !retryPlan.data?.allowed ||
                rerunCurrentStageAutomation.isPending ||
                retryStageAutomation.isPending
              }
              onClick={() => {
                const plan = retryPlan.data;
                if (!plan) return;
                if (plan.scope === "current_stage") rerunCurrentStageAutomation.mutate();
                else retryStageAutomation.mutate(plan);
              }}
            >
              {(rerunCurrentStageAutomation.isPending || retryStageAutomation.isPending)
                ? "Starting..."
                : retryPlan.data ? retryPrimaryActionLabel(retryPlan.data) : "Retry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {activeWork ? (
        <ActivePipelineWorkBanner activeWork={activeWork} />
      ) : (
        <PipelineLivenessBanner
          liveness={detail.liveness}
          onRetry={(kind) => retryLiveness.mutate(kind)}
          retryPending={retryLiveness.isPending}
          retryError={livenessRetryError}
        />
      )}

      {banner.visible ? (
        <section className="mb-5 flex flex-col gap-3 border-y border-border bg-muted/20 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Ready to move to {banner.stageName}?</h2>
            {banner.rationale ? <p className="mt-1 text-sm text-muted-foreground">{banner.rationale}</p> : null}
          </div>
          {banner.suggestionId ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => resolveSuggestion.mutate({ resolution: "accept", suggestionId: banner.suggestionId! })}
                disabled={resolveSuggestion.isPending}
              >
                <Check className="mr-2 h-4 w-4" />
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => resolveSuggestion.mutate({ resolution: "dismiss", suggestionId: banner.suggestionId! })}
                disabled={resolveSuggestion.isPending}
              >
                <X className="mr-2 h-4 w-4" />
                Not yet
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}

      {changedNotice ? (
        <section className="mb-5 flex flex-col gap-3 border-y border-amber-300 bg-amber-50 py-4 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100 md:flex-row md:items-center md:justify-between">
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold">{changedNotice.title}</h2>
              <p className="mt-1 text-sm opacity-85">{changedNotice.body}</p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => acknowledgeChange.mutate()}
            disabled={acknowledgeChange.isPending}
          >
            Acknowledge
          </Button>
        </section>
      ) : null}

      {(childrenGate || (breakdown?.waitForPieces ?? false)) && waitingChildren.length > 0 ? (
        <section aria-label="Waiting child items" className="mb-5 border-y border-border px-4 py-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <ListTree className="h-4 w-4 text-muted-foreground" />
              {breakdown
                ? `Waiting on ${waitingChildren.length} of ${pieceCountTotal} ${pieceLabel(pieceCountTotal)} · ${pieceCountDone} finished`
                : `Waiting on ${waitingChildren.length} of ${pieceCountTotal} child ${pieceCountTotal === 1 ? "item" : "items"}`}
            </div>
            <ul className="divide-y divide-border">
              {waitingChildren.map((row) => (
                <WaitingChildRow key={row.case.id} row={row} />
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <main className="min-w-0 space-y-8">
          {detail.case.summary ? (
            <FoldCurtain className="max-w-3xl">
              <MarkdownBody className="text-[15px] leading-7 text-foreground">
                {detail.case.summary}
              </MarkdownBody>
            </FoldCurtain>
          ) : null}

          {mainPaneFields.map((field) => (
            <DetailSection key={field.key} title={field.label}>
              <MarkdownBody className="py-3 text-[15px] leading-7 text-foreground">
                {field.value}
              </MarkdownBody>
            </DetailSection>
          ))}

          <LinkedIssueAssetsSection
            groups={linkedIssueAssets.data ?? []}
            loading={linkedIssueAssets.isLoading}
            error={linkedIssueAssets.isError}
          />

          <DetailSection title="Conversation">
            {conversationIssue ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <Link
                    to={conversationIssuePath!}
                    state={conversationIssueState}
                    issuePrefetch={conversationIssue}
                    className="min-w-0 font-medium text-foreground hover:underline"
                  >
                    {conversationIssue.identifier ? `${conversationIssue.identifier}: ` : null}
                    {conversationIssue.title}
                  </Link>
                  <Link
                    to={conversationIssuePath!}
                    state={conversationIssueState}
                    issuePrefetch={conversationIssue}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    Open conversation
                  </Link>
                </div>
                <IssueChatThread
                  comments={comments.data ?? []}
                  issueId={conversationIssue.id}
                  companyId={conversationIssue.companyId}
                  projectId={conversationIssue.projectId}
                  issueStatus={conversationIssue.status}
                  onAdd={addConversationComment}
                  emptyMessage="No conversation yet."
                  variant="embedded"
                />
              </div>
            ) : (
              <div className="flex flex-col items-start gap-3 py-3 text-sm text-muted-foreground">
                <p>No active conversation yet.</p>
                <Button size="sm" variant="outline" onClick={() => startConversation.mutate()} disabled={startConversation.isPending}>
                  <MessageSquare className="mr-2 h-4 w-4" />
                  {startConversation.isPending ? "Starting..." : "Start a conversation"}
                </Button>
              </div>
            )}
          </DetailSection>
        </main>

        <aside className="min-w-0 space-y-8">
          {reviewPanel}

          <DetailSection title="Linked work">
            <PipelineWorkReferences references={workReferences} />
          </DetailSection>

          <DetailSection
            title={
              breakdown
                ? pieceCountTotal > 0
                  ? `Built from ${pieceCountTotal} ${pieceLabel(pieceCountTotal)}`
                  : `No ${pieceNounPluralLabel} needed`
                : `Built from ${pieceCountTotal} ${pieceCountTotal === 1 ? "item" : "items"}`
            }
          >
            {breakdown && pieceCountTotal > 0 ? (
              <p className="py-2 text-sm text-muted-foreground">
                {pieceCountDone} of {pieceCountTotal} {pieceLabel(pieceCountTotal)} finished
              </p>
            ) : null}
            {breakdown && pieceCountTotal === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">
                Nothing was worth splitting — this case moved straight ahead without creating any {pieceNounPluralLabel}.
              </p>
            ) : (
              <BuiltFromTree rows={childRows} />
            )}
            {breakdown && breakdown.targetPipelineId && pieceCountTotal > 0 ? (
              <Link
                to={`/pipelines/${breakdown.targetPipelineId}`}
                className="mt-2 inline-block text-sm font-medium text-foreground hover:underline"
              >
                Open all {pieceNounPluralLabel} →
              </Link>
            ) : null}
          </DetailSection>

          <DetailSection title="Details">
            {itemFields.length > 0 ? (
              <dl className="divide-y divide-border">
                {itemFields.map((field) => (
                  <div key={field.key} className="grid grid-cols-[120px_1fr] gap-3 py-2 text-sm">
                    <dt className="text-muted-foreground">{field.label}</dt>
                    <dd className="min-w-0 text-foreground [overflow-wrap:anywhere]">{field.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="py-3 text-sm text-muted-foreground">No added details.</p>
            )}
          </DetailSection>

          <DetailSection title="Activity">
            {eventRows.length > 0 ? (
              <ol className="divide-y divide-border">
                {eventRows.map((event) => (
                  <li key={event.id} className="py-2 text-sm">
                    <p className="text-foreground">
                      <PipelineEventText event={event} pipelineId={pipelineId} stages={stageLookup} />
                    </p>
                    <time className="text-xs text-muted-foreground">{formatShortDate(event.createdAt)}</time>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="py-3 text-sm text-muted-foreground">No activity yet.</p>
            )}
          </DetailSection>
        </aside>
      </div>

      <Dialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove item</DialogTitle>
            <DialogDescription>
              This moves the item out of active work. It stays visible in the pipeline history.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveDialogOpen(false)}>Keep item</Button>
            <Button variant="destructive" onClick={() => removeItem.mutate()} disabled={removeItem.isPending || !removeStage}>
              {removeItem.isPending ? "Removing..." : "Remove item"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ActivePipelineWorkBanner({ activeWork }: { activeWork: PipelineCaseActiveWork }) {
  const isAutomation = activeWork.issueRole === "automation";
  const title = isAutomation ? "Automation is running" : "Linked work is running";
  const issueLabel = activeWork.issueIdentifier ?? activeWork.issueTitle;
  const issuePath = createIssueDetailPath(activeWork.issueIdentifier ?? activeWork.issueId);
  const startedLabel = activeWork.startedAt ? `Started ${relativeTime(activeWork.startedAt)}` : null;

  return (
    <section
      aria-label={title}
      className="mb-5 flex flex-col gap-3 rounded-lg border border-blue-300 bg-blue-50 px-4 py-4 text-blue-950 dark:border-blue-900/70 dark:bg-blue-950/25 dark:text-blue-100 md:flex-row md:items-center md:justify-between"
    >
      <div className="flex min-w-0 gap-3">
        <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" aria-hidden="true" />
            {title}
          </h2>
          <p className="mt-1 text-sm opacity-85">
            <Link to={issuePath} className="font-medium underline-offset-2 hover:underline">
              {issueLabel}
            </Link>{" "}
            is active with {activeWork.agentName}
            {startedLabel ? ` · ${startedLabel}` : ""}.
          </p>
        </div>
      </div>
      <Button
        asChild
        size="sm"
        variant="outline"
        className="border-blue-300 bg-transparent hover:bg-blue-100 dark:border-blue-900/70 dark:hover:bg-blue-950/40"
      >
        <Link to={issuePath}>
          <ExternalLink className="mr-2 h-4 w-4" />
          Open issue
        </Link>
      </Button>
    </section>
  );
}

function hasChildrenGate(stage: PipelineStage) {
  const config = stage.config ?? {};
  return config.requireChildrenTerminal === true ||
    (typeof config.autoAdvanceOnChildrenTerminal === "string" && config.autoAdvanceOnChildrenTerminal.trim().length > 0);
}

function isTerminalChild(row: { case: PipelineCase; stage: PipelineStage }) {
  return Boolean(row.case.terminalKind) || row.stage.kind === "done" || row.stage.kind === "cancelled";
}

function getWaitingChildren<T extends { case: PipelineCase; stage: PipelineStage }>(rows: T[]) {
  return rows.filter((row) => !isTerminalChild(row));
}

function WaitingChildRow({
  row,
}: {
  row: {
    case: PipelineCase;
    stage: PipelineStage;
    activeWork?: PipelineCaseActiveWork | null;
    descendantActiveWorkCount?: number | null;
  };
}) {
  const liveDownstreamCount = descendantActiveWorkCount(row);

  return (
    <li>
      <Link
        to={`/pipelines/${row.case.pipelineId}/items/${row.case.id}`}
        className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-3 py-2 text-sm"
      >
        <GitBranch className="h-4 w-4 text-muted-foreground" />
        <span className="min-w-0">
          <span className="block font-medium text-foreground [overflow-wrap:anywhere]">{row.case.title}</span>
          {row.activeWork || liveDownstreamCount > 0 ? (
            <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              {row.activeWork ? (
                <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden="true" />
                  Live with {row.activeWork.agentName}
                </span>
              ) : null}
              {liveDownstreamCount > 0 ? (
                <span>{formatLiveDownstream(liveDownstreamCount)}</span>
              ) : null}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 rounded-sm border border-border px-2 py-0.5 text-xs text-muted-foreground">
          {humanizePipelineItemStatus(row.case.terminalKind ?? row.stage.kind)}
        </span>
      </Link>
    </li>
  );
}

interface ReviewDecisionConfig {
  approveToStageKey: string | null;
  rejectToStageKey: string | null;
  requestChangesToStageKey: string | null;
  requireRejectReason: boolean;
}

interface ReviewDecisionAction {
  decision: PipelineReviewDecision;
  label: string;
  targetStageName: string;
  targetStageKey: string;
  requireReason: boolean;
  variant: "default" | "outline" | "destructive";
}

function configString(config: Record<string, unknown> | null | undefined, key: string) {
  const value = config?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stageKeyForKind(stages: PipelineStage[], kind: string) {
  return stages.find((stage) => stage.kind === kind)?.key ?? stages.find((stage) => stage.key === kind)?.key ?? null;
}

function reviewDecisionConfig(stage: PipelineStage, stages: PipelineStage[]): ReviewDecisionConfig | null {
  if (stage.kind !== "review") return null;
  const config = stage.config ?? {};
  return {
    approveToStageKey: configString(config, "approveToStageKey") ?? stageKeyForKind(stages, "done"),
    rejectToStageKey: configString(config, "rejectToStageKey") ?? stageKeyForKind(stages, "cancelled"),
    requestChangesToStageKey: configString(config, "requestChangesToStageKey"),
    requireRejectReason: config.requireRejectReason !== false,
  };
}

function reviewDecisionActions(
  config: ReviewDecisionConfig,
  stageLookup: Map<string, string>,
): ReviewDecisionAction[] {
  const actions: ReviewDecisionAction[] = [];
  if (config.approveToStageKey) {
    actions.push({
      decision: "approve",
      label: "Approve",
      targetStageKey: config.approveToStageKey,
      targetStageName: stageLookup.get(config.approveToStageKey) ?? humanizePipelineItemStatus(config.approveToStageKey),
      requireReason: false,
      variant: "default",
    });
  }
  if (config.requestChangesToStageKey) {
    actions.push({
      decision: "request_changes",
      label: "Request changes",
      targetStageKey: config.requestChangesToStageKey,
      targetStageName: stageLookup.get(config.requestChangesToStageKey) ?? humanizePipelineItemStatus(config.requestChangesToStageKey),
      requireReason: config.requireRejectReason,
      variant: "outline",
    });
  }
  if (config.rejectToStageKey) {
    actions.push({
      decision: "reject",
      label: "Reject",
      targetStageKey: config.rejectToStageKey,
      targetStageName: stageLookup.get(config.rejectToStageKey) ?? humanizePipelineItemStatus(config.rejectToStageKey),
      requireReason: config.requireRejectReason,
      variant: "destructive",
    });
  }
  return actions;
}

function reviewDecisionToastTitle(decision: PipelineReviewDecision, movedToNextItem: boolean) {
  const prefix = decision === "approve"
    ? "Item approved"
    : decision === "request_changes"
      ? "Changes requested"
      : "Item rejected";
  return movedToNextItem ? `${prefix}; moved to the next review` : prefix;
}

function ReviewDecisionPanel({
  actions,
  note,
  requireReason,
  pending,
  pendingDecision,
  nextItemTitle,
  onNoteChange,
  onDecide,
}: {
  actions: ReviewDecisionAction[];
  note: string;
  requireReason: boolean;
  pending: boolean;
  pendingDecision: PipelineReviewDecision | null;
  nextItemTitle: string | null;
  onNoteChange: (value: string) => void;
  onDecide: (decision: PipelineReviewDecision) => void;
}) {
  const trimmedNote = note.trim();

  return (
    <section>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Review</h2>
      <div className="border-y border-amber-300 bg-amber-50/70 p-5 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100 sm:p-6">
        <div className="space-y-5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-1 h-5 w-5 shrink-0" />
            <div>
              <p className="text-2xl font-semibold leading-tight">In review</p>
              <p className="mt-1 text-sm opacity-80">
                Decide where this item goes next.
              </p>
            </div>
          </div>

          <label className="block space-y-1.5 text-sm font-medium">
            <span>Reason</span>
            <Textarea
              value={note}
              onChange={(event) => onNoteChange(event.target.value)}
              rows={4}
              placeholder={requireReason ? "Required for changes or rejection." : "Optional note."}
              className="bg-background/90 text-foreground"
            />
          </label>

          <div className="space-y-2">
            {actions.map((action) => {
              const reasonMissing = action.requireReason && trimmedNote.length === 0;
              const isPendingAction = pending && pendingDecision === action.decision;
              return (
                <Button
                  key={action.decision}
                  type="button"
                  variant={action.variant}
                  className="h-auto min-h-14 w-full justify-start px-4 py-3 text-left"
                  aria-label={`${action.label} and move to ${action.targetStageName}`}
                  disabled={pending || reasonMissing}
                  onClick={() => onDecide(action.decision)}
                >
                  {isPendingAction ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : action.decision === "approve" ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <X className="h-4 w-4" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block">{action.label}</span>
                    <span className="block truncate text-xs font-normal opacity-75">
                      Move to {action.targetStageName}
                    </span>
                  </span>
                </Button>
              );
            })}
          </div>

          {nextItemTitle ? (
            <p className="text-xs opacity-75">
              Next in this review queue: <span className="font-medium">{nextItemTitle}</span>
            </p>
          ) : (
            <p className="text-xs opacity-75">No other item is waiting in this pipeline review queue.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function PipelineEventText({
  event,
  pipelineId,
  stages,
}: {
  event: PipelineCaseEvent;
  pipelineId: string;
  stages: Map<string, string>;
}) {
  const kind = event.type.startsWith("case.") ? event.type.slice("case.".length) : event.type;
  if (kind === "automation_executed" && event.automation) {
    const routineName = event.automation.routine?.title ?? "the automation";
    const issue = event.automation.issue;
    return (
      <>
        Automation completed — ran <span className="font-medium">{routineName}</span>
        {issue ? (
          <>
            {" -> "}
            <Link
              to={issueDetailPath(issue)}
              className="font-medium text-foreground hover:underline"
            >
              {issue.identifier ?? issue.title}
            </Link>
          </>
        ) : null}
        .
      </>
    );
  }
  if (kind === "automation_failed") {
    const stageId = event.automation?.stage?.id ?? event.toStageId ?? null;
    return (
      <>
        {formatPipelineItemEvent(event, stages)}
        {stageId ? (
          <>
            {" "}
            <Link to={`/pipelines/${pipelineId}/settings?stage=${stageId}`} className="font-medium text-foreground hover:underline">
              Fix stage settings
            </Link>
          </>
        ) : null}
      </>
    );
  }
  return <>{formatPipelineItemEvent(event, stages)}</>;
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{title}</h2>
      <div className="border-y border-border">{children}</div>
    </section>
  );
}

interface LinkedIssueAssetGroup {
  issue: PipelineCaseIssueLinkWithIssue["issue"];
  attachments: IssueAttachment[];
}

function LinkedIssueAssetsSection({
  groups,
  loading,
  error,
}: {
  groups: LinkedIssueAssetGroup[];
  loading: boolean;
  error: boolean;
}) {
  if (!loading && !error && groups.length === 0) return null;

  return (
    <DetailSection title="Linked assets">
      {loading ? (
        <p className="py-3 text-sm text-muted-foreground">Loading linked assets...</p>
      ) : error ? (
        <p className="py-3 text-sm text-destructive">Could not load linked issue assets.</p>
      ) : (
        <div className="divide-y divide-border">
          {groups.map((group) => (
            <LinkedIssueAssetGroup key={group.issue.id} group={group} />
          ))}
        </div>
      )}
    </DetailSection>
  );
}

function LinkedIssueAssetGroup({ group }: { group: LinkedIssueAssetGroup }) {
  const issueLabel = group.issue.identifier ?? group.issue.title;
  return (
    <div className="py-3">
      <div className="mb-2 flex min-w-0 items-center justify-between gap-3">
        <Link
          to={issueDetailPath(group.issue)}
          state={withIssueDetailHeaderSeed(null, group.issue)}
          issuePrefetch={group.issue}
          className="min-w-0 truncate text-sm font-medium text-foreground hover:underline"
          title={group.issue.title}
        >
          {issueLabel}
        </Link>
        <span className="shrink-0 text-xs text-muted-foreground">
          {group.attachments.length} {group.attachments.length === 1 ? "asset" : "assets"}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {group.attachments.map((attachment) => (
          <LinkedIssueAsset key={attachment.id} attachment={attachment} />
        ))}
      </div>
    </div>
  );
}

function LinkedIssueAsset({ attachment }: { attachment: IssueAttachment }) {
  const filename = attachmentFilename(attachment);
  const isImage = isImageAttachment(attachment);
  return (
    <div id={`linked-attachment-${attachment.id}`} className="min-w-0 overflow-hidden rounded-md border border-border bg-card">
      {isImage ? (
        <a
          href={attachmentOpenPath(attachment)}
          target="_blank"
          rel="noreferrer"
          className="group relative block aspect-video bg-accent/10"
          aria-label={`Open ${filename}`}
        >
          <img
            src={attachment.contentPath}
            alt={filename}
            className="h-full w-full object-cover"
            loading="lazy"
          />
          <span className="absolute right-2 top-2 rounded bg-black/55 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100">
            <ExternalLink className="h-3.5 w-3.5" />
          </span>
        </a>
      ) : null}
      <div className="flex items-center gap-2 p-2">
        {isImage ? (
          <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <a
            href={attachmentOpenPath(attachment)}
            target="_blank"
            rel="noreferrer"
            className="block truncate text-sm font-medium text-foreground hover:underline"
            title={filename}
          >
            {filename}
          </a>
          <p className="truncate text-[11px] text-muted-foreground">
            {attachment.contentType} · {formatBytes(attachment.byteSize)}
          </p>
        </div>
        <a
          href={attachmentDownloadPath(attachment)}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={`Download ${filename}`}
          title="Download"
        >
          <Download className="h-4 w-4" />
        </a>
      </div>
    </div>
  );
}

function BuiltFromTree({
  rows,
}: {
  rows: Array<{ case: PipelineCase; stage: PipelineStage }>;
}) {
  if (rows.length === 0) {
    return <p className="py-3 text-sm text-muted-foreground">No built-from items.</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => (
        <li key={row.case.id}>
          <Link
            to={`/pipelines/${row.case.pipelineId}/items/${row.case.id}`}
            className="grid grid-cols-[18px_1fr_auto] items-center gap-3 py-3 text-sm hover:bg-muted/40"
          >
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block truncate font-medium text-foreground">{row.case.title}</span>
              {(row.case.childCount ?? 0) > 0 ? (
                <span className="block text-xs text-muted-foreground">
                  {row.case.childCount} nested {(row.case.childCount ?? 0) === 1 ? "item" : "items"} hidden
                </span>
              ) : null}
            </span>
            <span className="rounded-sm border border-border px-2 py-0.5 text-xs text-muted-foreground">
              {humanizePipelineItemStatus(row.case.terminalKind ?? row.stage.kind)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function formatShortDate(value: Date | string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function PipelineAddItems({ pipelineId }: { pipelineId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [rows, setRows] = useState<DraftRow[]>(() => [newDraftRow(true)]);

  const pipeline = useQuery({
    queryKey: queryKeys.pipelines.detail(pipelineId),
    queryFn: () => pipelinesApi.get(pipelineId),
  });
  const intake = useQuery({
    queryKey: queryKeys.pipelines.intakeForm(pipelineId),
    queryFn: () => pipelinesApi.getIntakeForm(pipelineId),
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Pipelines", href: "/pipelines" },
      { label: pipeline.data?.name ?? "Pipeline", href: `/pipelines/${pipelineId}` },
      { label: "Add items" },
    ]);
  }, [pipeline.data?.name, pipelineId, setBreadcrumbs]);

  const fields = intake.data?.fields ?? [];
  const errors = useMemo(() => validateDraftRows(rows, fields), [fields, rows]);
  const invalid = rows.length === 0 || Object.keys(errors).length > 0;

  const submit = useMutation({
    mutationFn: () => pipelinesApi.ingestCasesBatch(pipelineId, { items: buildBatchPayload(rows, fields) }),
    onSuccess: async (results) => {
      const failedByIndex = new Map<number, string>();
      results.forEach((result, index) => {
        if (!result.ok) failedByIndex.set(index, plainBatchError(result));
      });
      if (failedByIndex.size > 0) {
        setRows((current) =>
          current.map((row, index) => ({
            ...row,
            expanded: failedByIndex.has(index) ? true : row.expanded,
            serverError: failedByIndex.get(index) ?? null,
          })),
        );
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.cases(pipelineId) }),
      ]);
      pushToast({ title: `${itemCountLabel(rows.length)} submitted`, tone: "success" });
      navigate(`/pipelines/${pipelineId}`);
    },
  });

  if (pipeline.isLoading || intake.isLoading) return <PageSkeleton />;
  if (!pipeline.data || !intake.data) {
    return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">Pipeline not found.</div>;
  }

  const firstStageName = intake.data.stageName ?? pipeline.data.stages[0]?.name ?? "first stage";

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Add to {pipeline.data.name}
        </p>
        <h1 className="text-2xl font-semibold text-foreground">Build your list, then submit it all at once</h1>
        <p className="text-sm text-muted-foreground">
          Items will be added to the first stage ({firstStageName}).
        </p>
      </div>

      <div className="mb-5 flex items-center gap-2 border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
        <Info className="h-4 w-4 shrink-0" />
        <span>
          These fields come from <span className="font-medium text-foreground">Pipeline settings -&gt; {firstStageName} stage</span>.
        </span>
      </div>

      <div className="space-y-3">
        {rows.map((row, index) => (
          <DraftItemRow
            key={row.id}
            row={row}
            index={index}
            fields={fields}
            intake={intake.data}
            errors={errors[row.id] ?? {}}
            onToggle={() =>
              setRows((current) => current.map((candidate) => candidate.id === row.id ? { ...candidate, expanded: !candidate.expanded } : candidate))
            }
            onRemove={() => setRows((current) => current.filter((candidate) => candidate.id !== row.id))}
            onChange={(fieldKey, value) =>
              setRows((current) =>
                current.map((candidate) =>
                  candidate.id === row.id
                    ? { ...candidate, values: { ...candidate.values, [fieldKey]: value }, serverError: null }
                    : candidate,
                ),
              )
            }
          />
        ))}

        <button
          type="button"
          className="flex h-14 w-full items-center justify-center border border-dashed border-border text-sm font-semibold text-foreground hover:bg-muted/40"
          onClick={() => setRows((current) => [...current, newDraftRow(false)])}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add another item
        </button>
      </div>

      <div className="mt-10 flex items-center justify-between border-t border-border pt-5">
        <Button variant="outline" onClick={() => navigate(`/pipelines/${pipelineId}`)}>
          Cancel
        </Button>
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground">
            {rows.length === 0 ? "Add at least one item." : "Count updates live."}
          </span>
          <Button disabled={invalid || submit.isPending} onClick={() => submit.mutate()}>
            {submit.isPending ? "Submitting..." : `Submit ${itemCountLabel(rows.length)}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

function DraftItemRow({
  row,
  index,
  fields,
  intake,
  errors,
  onToggle,
  onRemove,
  onChange,
}: {
  row: DraftRow;
  index: number;
  fields: PipelineIntakeField[];
  intake: PipelineIntakeForm;
  errors: FieldErrors;
  onToggle: () => void;
  onRemove: () => void;
  onChange: (fieldKey: string, value: string) => void;
}) {
  const title = row.values.title?.trim() || `Item ${index + 1}`;
  const preview = fields
    .filter((field) => field.key !== "title")
    .map((field) => row.values[field.key])
    .filter((value): value is string => Boolean(value && value.trim()))
    .slice(0, 2)
    .join(" · ");

  return (
    <section className={cn("border border-border bg-background", row.expanded && "border-primary")}>
      <div className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3">
        <button type="button" className="min-w-0 text-left" onClick={onToggle}>
          <span className="block text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Item {index + 1}</span>
          <span className="block truncate text-sm font-semibold text-foreground">{title}</span>
          {!row.expanded && preview ? <span className="block truncate text-xs text-muted-foreground">{preview}</span> : null}
          {!row.expanded && row.serverError ? <span className="block text-xs text-destructive">{row.serverError}</span> : null}
        </button>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={onToggle} aria-label={row.expanded ? "Collapse item" : "Expand item"}>
            {row.expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
          <Button variant="outline" size="icon" onClick={onRemove} aria-label="Remove item">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {row.expanded ? (
        <div className="grid gap-5 border-t border-border px-4 py-4 lg:grid-cols-[1fr_280px]">
          <div className="grid gap-4 md:grid-cols-2">
            {fields.map((field) => (
              <GeneratedField
                key={field.key}
                field={field}
                value={row.values[field.key] ?? ""}
                error={errors[field.key]}
                onChange={(value) => onChange(field.key, value)}
              />
            ))}
            {row.serverError ? <p className="md:col-span-2 text-sm text-destructive">{row.serverError}</p> : null}
          </div>
          <aside className="border border-border p-4 text-sm">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Preview</p>
            <p className="font-semibold text-foreground">{title}</p>
            <p className="mt-3 text-xs text-muted-foreground">First stage on submit:</p>
            <p className="font-semibold text-foreground">{intake.stageName ?? "First stage"}</p>
          </aside>
        </div>
      ) : null}
    </section>
  );
}

export function GeneratedField({
  field,
  value,
  error,
  onChange,
}: {
  field: PipelineIntakeField;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const inputId = `pipeline-intake-${field.key}`;
  return (
    <label className={cn("block space-y-1", field.type === "multiline" && "md:col-span-2")}>
      <span className="text-sm font-medium text-foreground">
        {field.label}
        {field.required ? <span className="ml-1 font-normal text-destructive">required</span> : null}
      </span>
      {field.type === "select" ? (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id={inputId} aria-invalid={Boolean(error)} className="w-full">
            <SelectValue placeholder="Choose..." />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((option) => (
              <SelectItem key={option} value={option}>{option}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.type === "multiline" ? (
        <Textarea id={inputId} value={value} aria-invalid={Boolean(error)} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <Input id={inputId} value={value} aria-invalid={Boolean(error)} onChange={(event) => onChange(event.target.value)} />
      )}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

type ReviewQueueKind = "suggestion" | "review" | "headsUp";

export interface ReviewQueueRow {
  id: string;
  caseId: string;
  pipelineId: string;
  pipelineName: string;
  title: string;
  prompt: string;
  kind: ReviewQueueKind;
  createdAt: string | Date | null;
  expectedVersion: number | null;
  suggestionId: string | null;
  requireRejectReason: boolean;
  fields: Record<string, unknown> | null;
}

const REVIEW_QUEUE_SECTION_LABELS: Record<ReviewQueueKind, string> = {
  suggestion: "Suggestions to review",
  review: "Final calls",
  headsUp: "Heads-up",
};

const REVIEW_QUEUE_SECTION_ORDER: ReviewQueueKind[] = ["suggestion", "review", "headsUp"];

function humanizeFieldLabel(key: string) {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function buildReviewQueueRows({
  attention,
  reviewCases,
}: {
  attention: PipelineAttentionFeed | null | undefined;
  reviewCases: PipelineReviewCaseRow[];
}): ReviewQueueRow[] {
  const rows = new Map<string, ReviewQueueRow>();
  const reviewStageCaseIds = new Set<string>([
    ...(attention?.reviews ?? []).map((entry) => entry.case.id),
    ...reviewCases.map((entry) => entry.case.id),
  ]);

  for (const entry of attention?.suggestions ?? []) {
    if (reviewStageCaseIds.has(entry.case.id)) continue;
    const id = `suggestion:${entry.case.id}`;
    rows.set(id, {
      id,
      caseId: entry.case.id,
      pipelineId: entry.case.pipeline.id,
      pipelineName: entry.case.pipeline.name,
      title: entry.case.title,
      prompt:
        entry.suggestion.rationale?.trim() ||
        `${entry.case.pipeline.name} thinks ${entry.case.title} is ready to move forward.`,
      kind: "suggestion",
      createdAt: entry.suggestion.createdAt ?? entry.case.updatedAt ?? null,
      expectedVersion: entry.case.version ?? null,
      suggestionId: entry.suggestion.id,
      requireRejectReason: false,
      fields: null,
    });
  }

  for (const entry of attention?.reviews ?? []) {
    const id = `review:${entry.case.id}`;
    rows.set(id, {
      id,
      caseId: entry.case.id,
      pipelineId: entry.case.pipeline.id,
      pipelineName: entry.case.pipeline.name,
      title: entry.case.title,
      prompt:
        entry.case.summary?.trim() ||
        `Decide whether ${entry.case.title} is ready to move forward.`,
      kind: "review",
      createdAt: entry.case.updatedAt ?? entry.case.createdAt ?? null,
      expectedVersion: entry.review.expectedVersion ?? entry.case.version ?? null,
      suggestionId: null,
      requireRejectReason: entry.review.requireRejectReason !== false,
      fields: null,
    });
  }

  for (const entry of attention?.headsUp ?? []) {
    const id = `headsUp:${entry.case.id}`;
    const upstreamTitle = entry.drift.upstream?.title?.trim();
    rows.set(id, {
      id,
      caseId: entry.case.id,
      pipelineId: entry.case.pipeline.id,
      pipelineName: entry.case.pipeline.name,
      title: entry.case.title,
      prompt: upstreamTitle
        ? `${upstreamTitle} changed upstream. Take a quick look before work continues.`
        : `${entry.case.title} needs a quick look before work continues.`,
      kind: "headsUp",
      createdAt: entry.drift.createdAt ?? entry.case.updatedAt ?? null,
      expectedVersion: entry.case.version ?? null,
      suggestionId: null,
      requireRejectReason: false,
      fields: null,
    });
  }

  for (const entry of reviewCases) {
    const id = `review:${entry.case.id}`;
    const pendingSuggestion = entry.pendingSuggestion ?? entry.case.pendingSuggestion ?? null;
    const existing = rows.get(id);
    if (existing) {
      existing.fields = entry.case.fields ?? null;
      if (existing.expectedVersion === null && typeof entry.case.version === "number") {
        existing.expectedVersion = entry.case.version;
      }
      continue;
    }
    rows.set(id, {
      id,
      caseId: entry.case.id,
      pipelineId: entry.pipeline.id,
      pipelineName: entry.pipeline.name,
      title: entry.case.title,
      prompt:
        pendingSuggestion?.rationale?.trim() ||
        entry.case.summary?.trim() ||
        `Decide whether ${entry.case.title} is ready to move forward.`,
      kind: "review",
      createdAt: entry.case.updatedAt ?? entry.case.createdAt ?? null,
      expectedVersion: typeof entry.case.version === "number" ? entry.case.version : null,
      suggestionId: null,
      requireRejectReason: entry.reviewConfig?.requireRejectReason !== false,
      fields: entry.case.fields ?? null,
    });
  }

  return [...rows.values()].sort((left, right) => {
    const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    return rightTime - leftTime;
  });
}

function ReviewQueueStatusChip({ failed }: { failed: boolean }) {
  if (!failed) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-300">
      <AlertTriangle className="h-3 w-3" />
      Needs attention
    </span>
  );
}

function reviewQueueFieldEntries(fields: Record<string, unknown> | null | undefined) {
  const hidden = new Set(["review"]);
  return Object.entries(fields ?? {})
    .filter(([key, value]) => !hidden.has(key) && ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 6);
}

function ReviewQueueDetailDialog({
  row,
  open,
  pending,
  onOpenChange,
  onApprove,
  onRequestChanges,
}: {
  row: ReviewQueueRow | null;
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onApprove: (note: string) => void;
  onRequestChanges: (note: string) => void;
}) {
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!open) setNote("");
  }, [open]);

  const fields = reviewQueueFieldEntries(row?.fields);
  const trimmedNote = note.trim();
  const canDecide = row ? row.kind !== "headsUp" : false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{row?.title ?? "Review item"}</DialogTitle>
          <DialogDescription>
            {row ? `${row.pipelineName} is waiting for your decision.` : "Review the item and decide what happens next."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">What is being decided</p>
            <p className="text-sm text-foreground">{row?.prompt}</p>
          </section>

          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Item preview</p>
            {fields.length > 0 ? (
              <div className="divide-y divide-border rounded-md border border-border">
                {fields.map(([key, value]) => (
                  <div key={key} className="grid grid-cols-[160px_1fr] gap-3 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">{humanizeFieldLabel(key)}</span>
                    <span className="text-foreground">{String(value)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="rounded-md border border-border px-3 py-3 text-sm text-muted-foreground">
                No preview details yet.
              </p>
            )}
          </section>

          {row ? (
            <Link
              to={`/pipelines/${row.pipelineId}/items/${row.caseId}`}
              className="inline-block text-sm font-medium text-primary hover:underline"
              onClick={() => onOpenChange(false)}
            >
              Open the full item
            </Link>
          ) : null}

          {canDecide ? (
            <label className="block space-y-1.5 text-sm font-medium">
              <span>Note</span>
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                placeholder="Required when requesting changes."
              />
            </label>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          {canDecide ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => onRequestChanges(trimmedNote)}
                disabled={pending || !trimmedNote}
              >
                {row?.kind === "suggestion" ? "Not yet" : "Request changes"}
              </Button>
              <Button type="button" onClick={() => onApprove(trimmedNote)} disabled={pending}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Approve
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReviewQueueSection({
  title,
  rows,
  activeRowId,
  failedRowIds,
  selectedRowIds,
  pendingRowIds,
  showSelection,
  onActivate,
  onToggleSelected,
  onApprove,
  onDecline,
  onRequestChanges,
  onOpen,
}: {
  title: string;
  rows: ReviewQueueRow[];
  activeRowId: string | null;
  failedRowIds: Set<string>;
  selectedRowIds: Set<string>;
  pendingRowIds: Set<string>;
  showSelection: boolean;
  onActivate: (rowId: string) => void;
  onToggleSelected: (rowId: string) => void;
  onApprove: (row: ReviewQueueRow) => void;
  onDecline: (row: ReviewQueueRow) => void;
  onRequestChanges: (row: ReviewQueueRow) => void;
  onOpen: (row: ReviewQueueRow) => void;
}) {
  if (rows.length === 0) return null;

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between border-b border-border pb-2">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <span className="text-xs text-muted-foreground">{formatNumber(rows.length)} item{rows.length === 1 ? "" : "s"}</span>
      </div>
      <div className="divide-y divide-border">
        {rows.map((row) => {
          const pending = pendingRowIds.has(row.id);
          const failed = failedRowIds.has(row.id);
          const selected = selectedRowIds.has(row.id);
          const active = activeRowId === row.id;
          const selectable = row.kind !== "headsUp";

          return (
            <div
              key={row.id}
              role="button"
              tabIndex={0}
              aria-current={active ? "true" : undefined}
              className={cn(
                "grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-2 py-2 text-sm outline-none transition-colors",
                active ? "bg-accent/60" : "hover:bg-accent/40",
              )}
              onMouseEnter={() => onActivate(row.id)}
              onFocus={() => onActivate(row.id)}
              onClick={() => onOpen(row)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onOpen(row);
              }}
            >
              <div className="flex min-w-0 items-center gap-3">
                {showSelection ? (
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.title}`}
                    checked={selected}
                    disabled={!selectable || pending}
                    onClick={(event) => event.stopPropagation()}
                    onChange={() => onToggleSelected(row.id)}
                    className="h-4 w-4 rounded border-border"
                  />
                ) : null}
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate font-semibold text-foreground">{row.title}</p>
                    <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                      {row.pipelineName}
                    </span>
                    <ReviewQueueStatusChip failed={failed} />
                  </div>
                  <p className="truncate text-muted-foreground">{row.prompt}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="hidden whitespace-nowrap text-xs text-muted-foreground sm:inline">
                  {row.createdAt ? relativeTime(row.createdAt) : "recently"}
                </span>
                {row.kind === "suggestion" ? (
                  <>
                    <Button type="button" size="sm" disabled={pending} onClick={(event) => {
                      event.stopPropagation();
                      onApprove(row);
                    }}>
                      Approve
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={(event) => {
                      event.stopPropagation();
                      onDecline(row);
                    }}>
                      Not yet
                    </Button>
                  </>
                ) : row.kind === "review" ? (
                  <>
                    <Button type="button" size="sm" disabled={pending} onClick={(event) => {
                      event.stopPropagation();
                      onApprove(row);
                    }}>
                      Approve
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={(event) => {
                      event.stopPropagation();
                      onRequestChanges(row);
                    }}>
                      Request changes
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function ReviewQueue() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(() => new Set());
  const [hiddenRowIds, setHiddenRowIds] = useState<Set<string>>(() => new Set());
  const [failedRowIds, setFailedRowIds] = useState<Set<string>>(() => new Set());
  const [pendingRowIds, setPendingRowIds] = useState<Set<string>>(() => new Set());
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [detailRow, setDetailRow] = useState<ReviewQueueRow | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Review queue" }]);
  }, [setBreadcrumbs]);

  const attentionQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.pipelines.attention(selectedCompanyId) : ["pipelines", "attention", "none"],
    queryFn: () => pipelinesApi.listAttention(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const reviewCasesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.pipelines.reviewCases(selectedCompanyId) : ["pipelines", "review-cases", "none"],
    queryFn: () => pipelinesApi.listReviewCases(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const rows = useMemo(
    () =>
      buildReviewQueueRows({
        attention: attentionQuery.data,
        reviewCases: reviewCasesQuery.data ?? [],
      }),
    [attentionQuery.data, reviewCasesQuery.data],
  );

  const visibleRows = rows.filter((row) => !hiddenRowIds.has(row.id));
  const actionableRows = visibleRows.filter((row) => row.kind !== "headsUp");
  const selectedRows = visibleRows.filter((row) => selectedRowIds.has(row.id) && row.kind !== "headsUp");
  const groupedRows = REVIEW_QUEUE_SECTION_ORDER.map((kind) => ({
    kind,
    rows: visibleRows.filter((row) => row.kind === kind),
  }));

  useEffect(() => {
    if (visibleRows.length === 0) {
      setActiveRowId(null);
      return;
    }
    if (!activeRowId || !visibleRows.some((row) => row.id === activeRowId)) {
      setActiveRowId(visibleRows[0].id);
    }
  }, [activeRowId, visibleRows]);

  const invalidateReviewQueue = async () => {
    if (!selectedCompanyId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.attention(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.reviewCases(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.list(selectedCompanyId) }),
    ]);
  };

  const decideRow = useMutation({
    mutationFn: async ({ row, decision, note }: { row: ReviewQueueRow; decision: "approve" | "decline" | "request_changes"; note?: string }) => {
      if (row.kind === "suggestion") {
        if (!row.suggestionId) throw new Error("This item is not ready for a decision.");
        await pipelinesApi.resolveSuggestion(row.caseId, {
          suggestionId: row.suggestionId,
          resolution: decision === "approve" ? "accept" : "dismiss",
          expectedVersion: row.expectedVersion ?? undefined,
          reason: note || null,
        });
        return;
      }
      if (row.expectedVersion === null) throw new Error("This item is not ready for a decision.");
      await pipelinesApi.reviewCase(row.caseId, {
        decision: decision === "request_changes" ? "request_changes" : "approve",
        reason: note || null,
        expectedVersion: row.expectedVersion,
      });
    },
    onMutate: ({ row }) => {
      setPendingRowIds((current) => new Set(current).add(row.id));
      setHiddenRowIds((current) => new Set(current).add(row.id));
      setFailedRowIds((current) => {
        const next = new Set(current);
        next.delete(row.id);
        return next;
      });
      setSelectedRowIds((current) => {
        const next = new Set(current);
        next.delete(row.id);
        return next;
      });
    },
    onError: (_error, { row }) => {
      setHiddenRowIds((current) => {
        const next = new Set(current);
        next.delete(row.id);
        return next;
      });
      setFailedRowIds((current) => new Set(current).add(row.id));
    },
    onSettled: async (_data, _error, { row }) => {
      setPendingRowIds((current) => {
        const next = new Set(current);
        next.delete(row.id);
        return next;
      });
      await invalidateReviewQueue();
    },
  });

  const bulkApprove = useMutation({
    mutationFn: async (targetRows: ReviewQueueRow[]) => {
      if (!selectedCompanyId) throw new Error("Select a company first.");
      const reviewRows = targetRows.filter((row) => row.kind === "review");
      const suggestionRows = targetRows.filter((row) => row.kind === "suggestion" && row.suggestionId);
      const tasks: Promise<unknown>[] = [];
      if (reviewRows.length > 0) {
        const items = reviewRows.map((row) => {
          if (row.expectedVersion === null) throw new Error("This item is not ready for a decision.");
          return { caseId: row.caseId, decision: "approve" as const, expectedVersion: row.expectedVersion };
        });
        tasks.push(
          pipelinesApi.bulkReviewCases(selectedCompanyId, { items }).then((response) => {
            const failures = (response.results ?? []).filter((result) => !result.ok);
            if (failures.length > 0) {
              throw new Error("Some items could not be approved.");
            }
          }),
        );
      }
      tasks.push(
        ...suggestionRows.map((row) =>
          pipelinesApi.resolveSuggestion(row.caseId, {
            suggestionId: row.suggestionId!,
            resolution: "accept",
            expectedVersion: row.expectedVersion ?? undefined,
          }),
        ),
      );
      await Promise.all(tasks);
    },
    onMutate: (targetRows) => {
      const ids = targetRows.map((row) => row.id);
      setPendingRowIds((current) => new Set([...current, ...ids]));
      setHiddenRowIds((current) => new Set([...current, ...ids]));
      setSelectedRowIds(new Set());
      setFailedRowIds((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
    },
    onError: (_error, targetRows) => {
      const ids = targetRows.map((row) => row.id);
      setHiddenRowIds((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
      setFailedRowIds((current) => new Set([...current, ...ids]));
    },
    onSettled: async (_data, _error, targetRows) => {
      const ids = targetRows.map((row) => row.id);
      setPendingRowIds((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
      await invalidateReviewQueue();
    },
  });

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        hasBlockingShortcutDialog() ||
        isKeyboardShortcutTextInputTarget(event.target) ||
        visibleRows.length === 0
      ) {
        return;
      }

      const currentIndex = Math.max(0, visibleRows.findIndex((row) => row.id === activeRowId));
      const key = event.key.toLowerCase();
      if (event.key === "ArrowDown" || key === "j") {
        event.preventDefault();
        setActiveRowId(visibleRows[Math.min(visibleRows.length - 1, currentIndex + 1)].id);
        return;
      }
      if (event.key === "ArrowUp" || key === "k") {
        event.preventDefault();
        setActiveRowId(visibleRows[Math.max(0, currentIndex - 1)].id);
        return;
      }

      const activeRow = visibleRows[currentIndex];
      if (!activeRow) return;
      if (event.key === "Enter") {
        event.preventDefault();
        setDetailRow(activeRow);
        return;
      }
      if (key === "a" && activeRow.kind !== "headsUp") {
        event.preventDefault();
        decideRow.mutate({ row: activeRow, decision: "approve" });
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activeRowId, decideRow, visibleRows]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select a company to view the review queue." />;
  }

  if (attentionQuery.isLoading || reviewCasesQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const selectedCount = selectedRows.length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-foreground">Review queue</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Needs your attention ({formatNumber(visibleRows.length)})
          </p>
        </div>
        <Button
          type="button"
          disabled={selectedCount === 0 || bulkApprove.isPending}
          onClick={() => bulkApprove.mutate(selectedRows)}
        >
          {bulkApprove.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Approve {formatNumber(selectedCount)} item{selectedCount === 1 ? "" : "s"}
        </Button>
      </div>

      {attentionQuery.error || reviewCasesQuery.error ? (
        <p className="text-sm text-amber-700 dark:text-amber-300">Some items need attention. Try again in a moment.</p>
      ) : null}

      {visibleRows.length === 0 ? (
        <EmptyState icon={Check} message="Nothing needs you right now." />
      ) : (
        <div className="space-y-6">
          {groupedRows.map((group) => (
            <ReviewQueueSection
              key={group.kind}
              title={REVIEW_QUEUE_SECTION_LABELS[group.kind]}
              rows={group.rows}
              activeRowId={activeRowId}
              failedRowIds={failedRowIds}
              selectedRowIds={selectedRowIds}
              pendingRowIds={pendingRowIds}
              showSelection={actionableRows.length > 1}
              onActivate={setActiveRowId}
              onToggleSelected={(rowId) => {
                setSelectedRowIds((current) => {
                  const next = new Set(current);
                  if (next.has(rowId)) next.delete(rowId);
                  else next.add(rowId);
                  return next;
                });
              }}
              onApprove={(row) => decideRow.mutate({ row, decision: "approve" })}
              onDecline={(row) => decideRow.mutate({ row, decision: "decline" })}
              onRequestChanges={(row) => setDetailRow(row)}
              onOpen={(row) => setDetailRow(row)}
            />
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Shortcuts: <span className="font-semibold">j</span>/<span className="font-semibold">k</span> or arrow keys move, <span className="font-semibold">Enter</span> opens, <span className="font-semibold">a</span> approves.
      </p>

      <ReviewQueueDetailDialog
        row={detailRow}
        open={Boolean(detailRow)}
        pending={decideRow.isPending}
        onOpenChange={(open) => {
          if (!open) setDetailRow(null);
        }}
        onApprove={(note) => {
          if (!detailRow) return;
          decideRow.mutate({ row: detailRow, decision: "approve", note });
          setDetailRow(null);
        }}
        onRequestChanges={(note) => {
          if (!detailRow) return;
          decideRow.mutate({
            row: detailRow,
            decision: detailRow.kind === "suggestion" ? "decline" : "request_changes",
            note,
          });
          setDetailRow(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Learnings
// ---------------------------------------------------------------------------

const LEARNINGS_PAGE_SIZE = 100;
const LEARNING_EVENT_TYPES = "review_decided,transition_forced";

export function Learnings() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    setBreadcrumbs([{ label: "Learnings" }]);
  }, [setBreadcrumbs]);

  const learningsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.pipelines.learnings(selectedCompanyId, offset)
      : ["pipelines", "learnings", "none"],
    queryFn: () =>
      pipelinesApi.listCompanyCaseEvents(selectedCompanyId!, {
        types: LEARNING_EVENT_TYPES,
        limit: LEARNINGS_PAGE_SIZE,
        offset,
      }),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={BookOpenText} message="Select a company to view learnings." />;
  }

  if (learningsQuery.isLoading && !learningsQuery.data) {
    return <PageSkeleton variant="list" />;
  }

  const events = learningsQuery.data?.items ?? [];
  const pagination = learningsQuery.data?.pagination;
  const groups = groupLearningEventsByDay(events);
  const firstVisible = events.length === 0 ? 0 : offset + 1;
  const lastVisible = offset + events.length;
  const canGoPrevious = offset > 0;
  const canGoNext = Boolean(pagination?.hasMore);

  return (
    <div className="space-y-6">
      <div className="border-b border-border pb-5">
        <h1 className="text-2xl font-semibold tracking-normal text-foreground">Learnings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Patterns from review decisions and hand moves, in plain words.
        </p>
      </div>

      <div className="flex items-center justify-end">
        <p className="text-sm text-muted-foreground">
          {learningsQuery.isFetching
            ? "Refreshing..."
            : events.length > 0
              ? `${formatNumber(firstVisible)}-${formatNumber(lastVisible)}`
              : "No rows"}
        </p>
      </div>

      {learningsQuery.error ? (
        <p className="text-sm text-destructive">Could not load learnings.</p>
      ) : groups.length === 0 ? (
        <EmptyState icon={BookOpenText} message="No learnings yet." />
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.key} className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                {group.label}
              </h2>
              <div className="overflow-hidden rounded-md border border-border">
                {group.events.map((event) => {
                  const presentation = formatLearningEvent(event);
                  const forcedMove = presentation.kind === "forced_move";
                  return (
                    <div
                      key={event.id}
                      className={cn(
                        "grid min-h-11 grid-cols-[6rem_1fr] items-center gap-3 border-b border-border/70 px-3 py-2 text-sm last:border-b-0",
                        forcedMove && "border-l-2 border-l-amber-400 bg-amber-50/50 dark:bg-amber-400/10",
                      )}
                    >
                      <span className="text-xs text-muted-foreground" title={new Date(event.createdAt).toLocaleString()}>
                        {relativeTime(event.createdAt)}
                      </span>
                      <div className="min-w-0">
                        <Link
                          to={`/pipelines/${event.pipeline.id}/items/${event.caseId}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {presentation.sentence}
                        </Link>
                        <span className="ml-2 text-muted-foreground">{event.pipeline.name}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button
          type="button"
          variant="outline"
          disabled={!canGoPrevious}
          onClick={() => setOffset((current) => Math.max(0, current - LEARNINGS_PAGE_SIZE))}
        >
          Previous
        </Button>
        <span className="text-sm text-muted-foreground">
          {events.length > 0 ? `${formatNumber(firstVisible)}-${formatNumber(lastVisible)}` : "No rows"}
        </span>
        <Button
          type="button"
          variant="outline"
          disabled={!canGoNext}
          onClick={() => setOffset((current) => pagination?.nextOffset ?? current + LEARNINGS_PAGE_SIZE)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
