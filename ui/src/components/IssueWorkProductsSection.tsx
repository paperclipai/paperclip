import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ExternalLink,
  FileText,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Package,
  Pencil,
  Plus,
  Server,
  Star,
  Link2,
  Trash2,
} from "lucide-react";

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const TYPE_META: Record<string, { icon: typeof GitPullRequest; label: string }> = {
  pull_request: { icon: GitPullRequest, label: "Pull Request" },
  branch: { icon: GitBranch, label: "Branch" },
  commit: { icon: GitCommit, label: "Commit" },
  document: { icon: FileText, label: "Document" },
  preview_url: { icon: ExternalLink, label: "Preview" },
  artifact: { icon: Package, label: "Artifact" },
  runtime_service: { icon: Server, label: "Service" },
};

const WORK_PRODUCT_TYPES = [
  "pull_request",
  "branch",
  "commit",
  "document",
  "preview_url",
  "artifact",
  "runtime_service",
] as const;

const PROVIDERS = ["paperclip", "github", "vercel", "s3", "custom"] as const;

const STATUSES = [
  "active",
  "draft",
  "ready_for_review",
  "approved",
  "changes_requested",
  "merged",
  "closed",
  "failed",
  "archived",
] as const;

const REVIEW_STATES = [
  "none",
  "needs_board_review",
  "approved",
  "changes_requested",
] as const;

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-500/15 text-green-700 dark:text-green-400",
  draft: "bg-muted text-muted-foreground",
  ready_for_review: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  approved: "bg-green-500/15 text-green-700 dark:text-green-400",
  changes_requested: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  merged: "bg-purple-500/15 text-purple-700 dark:text-purple-400",
  closed: "bg-muted text-muted-foreground",
  failed: "bg-red-500/15 text-red-700 dark:text-red-400",
  archived: "bg-muted text-muted-foreground",
};

const REVIEW_STATE_COLORS: Record<string, string> = {
  needs_board_review: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  approved: "bg-green-500/15 text-green-700 dark:text-green-400",
  changes_requested: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
};

function formatLabel(value: string) {
  return value.replace(/_/g, " ");
}

/* -------------------------------------------------------------------------- */
/*  Form state                                                                 */
/* -------------------------------------------------------------------------- */

interface WorkProductFormData {
  type: string;
  provider: string;
  title: string;
  url: string;
  status: string;
  reviewState: string;
  isPrimary: boolean;
  summary: string;
}

const EMPTY_FORM: WorkProductFormData = {
  type: "pull_request",
  provider: "github",
  title: "",
  url: "",
  status: "active",
  reviewState: "none",
  isPrimary: false,
  summary: "",
};

function formDataFromWorkProduct(wp: IssueWorkProduct): WorkProductFormData {
  return {
    type: wp.type,
    provider: wp.provider ?? "custom",
    title: wp.title ?? "",
    url: wp.url ?? "",
    status: String(wp.status),
    reviewState: wp.reviewState ?? "none",
    isPrimary: wp.isPrimary ?? false,
    summary: wp.summary ?? "",
  };
}

/* -------------------------------------------------------------------------- */
/*  Work Product Form Dialog                                                   */
/* -------------------------------------------------------------------------- */

interface FormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: WorkProductFormData;
  setForm: React.Dispatch<React.SetStateAction<WorkProductFormData>>;
  onSubmit: () => void;
  isPending: boolean;
  mode: "create" | "edit";
}

function WorkProductFormDialog({
  open,
  onOpenChange,
  form,
  setForm,
  onSubmit,
  isPending,
  mode,
}: FormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {mode === "create" ? "Add Work Product" : "Edit Work Product"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Type</label>
              <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v }))}>
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORK_PRODUCT_TYPES.map((t) => (
                    <SelectItem key={t} value={t} className="text-xs">
                      {formatLabel(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Provider</label>
              <Select value={form.provider} onValueChange={(v) => setForm((f) => ({ ...f, provider: v }))}>
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p} className="text-xs">
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Title</label>
            <Input
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="e.g. smaugho/paperclip#42"
              className="h-8 text-xs"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">URL</label>
            <Input
              value={form.url}
              onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
              placeholder="https://github.com/..."
              className="h-8 text-xs"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Status</label>
              <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}>
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s} className="text-xs">
                      {formatLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Review State</label>
              <Select value={form.reviewState} onValueChange={(v) => setForm((f) => ({ ...f, reviewState: v }))}>
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REVIEW_STATES.map((r) => (
                    <SelectItem key={r} value={r} className="text-xs">
                      {formatLabel(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Summary</label>
            <Input
              value={form.summary}
              onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))}
              placeholder="Brief description (optional)"
              className="h-8 text-xs"
            />
          </div>

          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={form.isPrimary}
              onChange={(e) => setForm((f) => ({ ...f, isPrimary: e.target.checked }))}
              className="rounded border-border"
            />
            Primary work product
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} className="text-xs">
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={onSubmit}
            disabled={isPending || !form.title.trim() || !form.provider.trim()}
            className="text-xs"
          >
            {isPending ? "Saving..." : mode === "create" ? "Add" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/*  Work Product Row                                                           */
/* -------------------------------------------------------------------------- */

interface WorkProductRowProps {
  wp: IssueWorkProduct;
  onEdit: (wp: IssueWorkProduct) => void;
  onDelete: (wp: IssueWorkProduct) => void;
  onTogglePrimary: (wp: IssueWorkProduct) => void;
}

function WorkProductRow({ wp, onEdit, onDelete, onTogglePrimary }: WorkProductRowProps) {
  const meta = TYPE_META[wp.type] ?? { icon: Link2, label: wp.type };
  const Icon = meta.icon;

  return (
    <div className="group flex items-start gap-2 rounded-md border border-border p-2 text-xs">
      <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />

      <div className="min-w-0 flex-1 space-y-1">
        {/* Title + primary marker */}
        <div className="flex items-center gap-1.5">
          {wp.isPrimary && (
            <Star className="h-3 w-3 shrink-0 text-yellow-500 fill-yellow-500" />
          )}
          {wp.url ? (
            <a
              href={wp.url}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-foreground hover:underline truncate"
            >
              {wp.title || meta.label}
            </a>
          ) : (
            <span className="font-medium text-foreground truncate">
              {wp.title || meta.label}
            </span>
          )}
        </div>

        {/* Badges row */}
        <div className="flex flex-wrap items-center gap-1">
          <span
            className={cn(
              "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
              STATUS_COLORS[wp.status] ?? STATUS_COLORS.active,
            )}
          >
            {formatLabel(String(wp.status))}
          </span>

          {wp.reviewState && wp.reviewState !== "none" && (
            <span
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                REVIEW_STATE_COLORS[wp.reviewState] ?? "bg-muted text-muted-foreground",
              )}
            >
              {formatLabel(wp.reviewState)}
            </span>
          )}

          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-auto">
            {meta.label}
          </Badge>

          {wp.provider && wp.provider !== "custom" && (
            <span className="text-[10px] text-muted-foreground">
              {wp.provider}
            </span>
          )}
        </div>

        {/* Summary preview */}
        {wp.summary && (
          <p className="text-[11px] text-muted-foreground line-clamp-2">
            {wp.summary}
          </p>
        )}

        {/* Timestamp */}
        <span className="text-[10px] text-muted-foreground">
          {relativeTime(wp.updatedAt)}
        </span>
      </div>

      {/* Action buttons (visible on hover) */}
      <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={() => onTogglePrimary(wp)}
          className={cn(
            "p-0.5 rounded hover:bg-accent/50",
            wp.isPrimary
              ? "text-yellow-500"
              : "text-muted-foreground hover:text-foreground",
          )}
          title={wp.isPrimary ? "Remove primary" : "Set as primary"}
        >
          <Star className={cn("h-3 w-3", wp.isPrimary && "fill-yellow-500")} />
        </button>
        <button
          onClick={() => onEdit(wp)}
          className="p-0.5 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground"
          title="Edit"
        >
          <Pencil className="h-3 w-3" />
        </button>
        <button
          onClick={() => onDelete(wp)}
          className="p-0.5 rounded hover:bg-accent/50 text-muted-foreground hover:text-destructive"
          title="Delete"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      {/* External link icon */}
      {wp.url && (
        <a
          href={wp.url}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 p-0.5 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground"
          title="Open link"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Main component                                                             */
/* -------------------------------------------------------------------------- */

interface IssueWorkProductsSectionProps {
  issueId: string;
}

export function IssueWorkProductsSection({ issueId }: IssueWorkProductsSectionProps) {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingWp, setEditingWp] = useState<IssueWorkProduct | null>(null);
  const [form, setForm] = useState<WorkProductFormData>(EMPTY_FORM);
  const [confirmDelete, setConfirmDelete] = useState<IssueWorkProduct | null>(null);

  const { data: workProducts, isLoading } = useQuery({
    queryKey: queryKeys.issues.workProducts(issueId),
    queryFn: () => issuesApi.listWorkProducts(issueId),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.workProducts(issueId) });

  const createWp = useMutation({
    mutationFn: (data: Record<string, unknown>) => issuesApi.createWorkProduct(issueId, data),
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
      setForm(EMPTY_FORM);
    },
  });

  const updateWp = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.updateWorkProduct(id, data),
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
      setEditingWp(null);
      setForm(EMPTY_FORM);
    },
  });

  const deleteWp = useMutation({
    mutationFn: (id: string) => issuesApi.deleteWorkProduct(id),
    onSuccess: () => {
      invalidate();
      setConfirmDelete(null);
    },
  });

  function handleOpenCreate() {
    setEditingWp(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function handleEdit(wp: IssueWorkProduct) {
    setEditingWp(wp);
    setForm(formDataFromWorkProduct(wp));
    setDialogOpen(true);
  }

  function handleSubmit() {
    const payload: Record<string, unknown> = {
      type: form.type,
      provider: form.provider,
      title: form.title.trim(),
      status: form.status,
      reviewState: form.reviewState,
      isPrimary: form.isPrimary,
    };
    if (form.url.trim()) payload.url = form.url.trim();
    if (form.summary.trim()) payload.summary = form.summary.trim();

    if (editingWp) {
      updateWp.mutate({ id: editingWp.id, data: payload });
    } else {
      createWp.mutate(payload);
    }
  }

  function handleTogglePrimary(wp: IssueWorkProduct) {
    updateWp.mutate({ id: wp.id, data: { isPrimary: !wp.isPrimary } });
  }

  if (isLoading) return null;

  const sorted = [...(workProducts ?? [])].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
          <Package className="h-3.5 w-3.5" />
          Work Products
          {sorted.length > 0 && (
            <span className="text-[10px] font-normal">({sorted.length})</span>
          )}
        </h3>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs gap-1" onClick={handleOpenCreate}>
          <Plus className="h-3 w-3" />
          Add
        </Button>
      </div>

      {sorted.length > 0 ? (
        <div className="space-y-1.5">
          {sorted.map((wp) => (
            <WorkProductRow
              key={wp.id}
              wp={wp}
              onEdit={handleEdit}
              onDelete={setConfirmDelete}
              onTogglePrimary={handleTogglePrimary}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground py-2">
          No work products yet.
        </p>
      )}

      {/* Create / Edit dialog */}
      <WorkProductFormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setEditingWp(null);
            setForm(EMPTY_FORM);
          }
        }}
        form={form}
        setForm={setForm}
        onSubmit={handleSubmit}
        isPending={createWp.isPending || updateWp.isPending}
        mode={editingWp ? "edit" : "create"}
      />

      {/* Delete confirmation dialog */}
      <Dialog open={!!confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Delete work product?</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            This will permanently remove{" "}
            <span className="font-medium text-foreground">{confirmDelete?.title}</span>.
          </p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmDelete(null)} className="text-xs">
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => confirmDelete && deleteWp.mutate(confirmDelete.id)}
              disabled={deleteWp.isPending}
              className="text-xs"
            >
              {deleteWp.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
