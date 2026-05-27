import { useMemo, useState } from "react";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  CheckCircle2,
  ExternalLink,
  FileText,
  GitBranch,
  GitCommit,
  Link as LinkIcon,
  Package,
  Plus,
  Star,
  Trash2,
} from "lucide-react";

type WorkProductPatch = Partial<Pick<IssueWorkProduct, "isPrimary" | "reviewState" | "status">>;

interface IssueWorkProductsSectionProps {
  products: IssueWorkProduct[];
  isLoading?: boolean;
  isMutating?: boolean;
  onCreate: (data: {
    type: IssueWorkProduct["type"];
    provider: string;
    title: string;
    url: string | null;
    status: IssueWorkProduct["status"];
    reviewState: IssueWorkProduct["reviewState"];
    isPrimary: boolean;
  }) => Promise<unknown>;
  onUpdate: (id: string, patch: WorkProductPatch) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
}

const TYPE_OPTIONS: Array<{ value: IssueWorkProduct["type"]; label: string }> = [
  { value: "preview_url", label: "Preview" },
  { value: "pull_request", label: "Pull request" },
  { value: "artifact", label: "Artifact" },
  { value: "document", label: "Document" },
  { value: "runtime_service", label: "Runtime service" },
  { value: "branch", label: "Branch" },
  { value: "commit", label: "Commit" },
];

function typeLabel(type: string) {
  return TYPE_OPTIONS.find((option) => option.value === type)?.label ?? type.replaceAll("_", " ");
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ");
}

function workProductIcon(type: string) {
  switch (type) {
    case "preview_url":
    case "runtime_service":
      return <ExternalLink className="h-3.5 w-3.5" />;
    case "pull_request":
    case "branch":
      return <GitBranch className="h-3.5 w-3.5" />;
    case "commit":
      return <GitCommit className="h-3.5 w-3.5" />;
    case "document":
      return <FileText className="h-3.5 w-3.5" />;
    default:
      return <Package className="h-3.5 w-3.5" />;
  }
}

function statusTone(status: string) {
  switch (status) {
    case "approved":
    case "merged":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "ready_for_review":
      return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300";
    case "changes_requested":
    case "failed":
      return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
    case "draft":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    default:
      return "border-border bg-muted/40 text-muted-foreground";
  }
}

function normalizeProvider(type: IssueWorkProduct["type"], url: string) {
  const lower = url.toLowerCase();
  if (lower.includes("github.com")) return "github";
  if (lower.includes("vercel.app") || lower.includes("vercel.com")) return "vercel";
  if (type === "artifact") return "paperclip";
  return "custom";
}

function WorkProductRow({
  product,
  disabled,
  onUpdate,
  onDelete,
}: {
  product: IssueWorkProduct;
  disabled?: boolean;
  onUpdate: IssueWorkProductsSectionProps["onUpdate"];
  onDelete: IssueWorkProductsSectionProps["onDelete"];
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const reviewState = product.reviewState;
  const needsReview = reviewState === "needs_board_review";

  return (
    <li className="rounded-md border border-border bg-background px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          {workProductIcon(product.type)}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {product.url ? (
              <a
                href={product.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 truncate text-sm font-medium hover:underline"
                title={product.title}
              >
                {product.title}
              </a>
            ) : (
              <span className="min-w-0 truncate text-sm font-medium" title={product.title}>
                {product.title}
              </span>
            )}
            {product.isPrimary ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-yellow-500/30 bg-yellow-500/10 px-1.5 py-0.5 text-[10px] font-medium text-yellow-700 dark:text-yellow-300">
                <Star className="h-3 w-3 fill-current" />
                Primary
              </span>
            ) : null}
            {needsReview ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300">
                Review
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>{typeLabel(product.type)}</span>
            <span>·</span>
            <span>{product.provider}</span>
            <span className={cn("rounded-full border px-1.5 py-0.5 capitalize", statusTone(product.status))}>
              {statusLabel(product.status)}
            </span>
            {product.healthStatus !== "unknown" ? (
              <span className="capitalize">{product.healthStatus}</span>
            ) : null}
          </div>
          {product.summary ? (
            <p className="line-clamp-2 text-xs text-muted-foreground">{product.summary}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {!product.isPrimary ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              title="Mark primary"
              aria-label="Mark primary"
              disabled={disabled}
              onClick={() => void onUpdate(product.id, { isPrimary: true })}
            >
              <Star className="h-4 w-4" />
            </Button>
          ) : null}
          {needsReview ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              title="Approve work product"
              aria-label="Approve work product"
              disabled={disabled}
              onClick={() => void onUpdate(product.id, { reviewState: "approved", status: "approved" })}
            >
              <CheckCircle2 className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              title="Request review"
              aria-label="Request review"
              disabled={disabled}
              onClick={() => void onUpdate(product.id, { reviewState: "needs_board_review", status: "ready_for_review" })}
            >
              <CheckCircle2 className="h-4 w-4" />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title={confirmDelete ? "Confirm delete" : "Delete work product"}
            aria-label={confirmDelete ? "Confirm delete" : "Delete work product"}
            disabled={disabled}
            className={confirmDelete ? "text-destructive hover:text-destructive" : undefined}
            onClick={() => {
              if (confirmDelete) {
                void onDelete(product.id);
                setConfirmDelete(false);
                return;
              }
              setConfirmDelete(true);
            }}
            onBlur={() => setConfirmDelete(false)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </li>
  );
}

export function IssueWorkProductsSection({
  products,
  isLoading = false,
  isMutating = false,
  onCreate,
  onUpdate,
  onDelete,
}: IssueWorkProductsSectionProps) {
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<IssueWorkProduct["type"]>("preview_url");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const sortedProducts = useMemo(
    () => [...products].sort(
      (a, b) =>
        Number(b.isPrimary) - Number(a.isPrimary)
        || Date.parse(String(b.updatedAt)) - Date.parse(String(a.updatedAt)),
    ),
    [products],
  );
  const urlLooksInvalid = url.trim().length > 0 && !/^https?:\/\//i.test(url.trim());
  const canSubmit = title.trim().length > 0 && !urlLooksInvalid;

  const resetForm = () => {
    setType("preview_url");
    setTitle("");
    setUrl("");
    setError(null);
    setAdding(false);
  };

  const handleSubmit = async () => {
    if (!canSubmit) {
      setError("Use a title and an http(s) URL.");
      return;
    }
    const trimmedUrl = url.trim();
    try {
      await onCreate({
        type,
        provider: normalizeProvider(type, trimmedUrl),
        title: title.trim(),
        url: trimmedUrl || null,
        status: "active",
        reviewState: "none",
        isPrimary: sortedProducts.length === 0,
      });
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add work product");
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-muted-foreground">Work products</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Outputs attached to this issue: previews, pull requests, artifacts, documents, branches, and commits.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 shadow-none"
          onClick={() => setAdding((value) => !value)}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {adding ? (
        <div className="rounded-lg border border-border bg-muted/20 p-3">
          <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
            <select
              className="h-9 rounded-md border border-border bg-background px-2 text-sm outline-none"
              value={type}
              onChange={(event) => setType(event.target.value as IssueWorkProduct["type"])}
              disabled={isMutating}
              aria-label="Work product type"
            >
              {TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <input
              className="h-9 min-w-0 rounded-md border border-border bg-background px-2 text-sm outline-none placeholder:text-muted-foreground/50"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={isMutating}
              placeholder="Title"
              aria-label="Work product title"
            />
            <div className="sm:col-span-2 flex min-w-0 items-center gap-2 rounded-md border border-border bg-background px-2">
              <LinkIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                disabled={isMutating}
                placeholder="https://..."
                aria-label="Work product URL"
              />
            </div>
          </div>
          {urlLooksInvalid ? (
            <p className="mt-2 text-xs text-destructive">Use an http(s) URL.</p>
          ) : error ? (
            <p className="mt-2 text-xs text-destructive">{error}</p>
          ) : null}
          <div className="mt-3 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={resetForm} disabled={isMutating}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={() => void handleSubmit()} disabled={isMutating || !canSubmit}>
              Add work product
            </Button>
          </div>
        </div>
      ) : null}

      {isLoading ? (
        <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">Loading work products...</div>
      ) : sortedProducts.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          No work products yet.
        </div>
      ) : (
        <ul className="space-y-2">
          {sortedProducts.map((product) => (
            <WorkProductRow
              key={product.id}
              product={product}
              disabled={isMutating}
              onUpdate={onUpdate}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
