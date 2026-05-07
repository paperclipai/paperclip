import { useEffect, useMemo, useState } from "react";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { AlertCircle, ExternalLink, FileText, GitBranch, GitPullRequest, Globe, Loader2, MessageSquarePlus, Package } from "lucide-react";
import { cn, relativeTime } from "../lib/utils";
import { MarkdownBody } from "./MarkdownBody";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstString(source: Record<string, unknown> | null, ...keys: string[]) {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function humanizeToken(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function workProductTypeLabel(type: string) {
  return humanizeToken(type);
}

function workProductReviewStateLabel(state: string) {
  if (state === "none") return "No review state";
  return humanizeToken(state);
}

function workProductStatusLabel(status: string) {
  return humanizeToken(status);
}

function workProductIcon(type: IssueWorkProduct["type"]) {
  switch (type) {
    case "pull_request":
      return GitPullRequest;
    case "branch":
    case "commit":
      return GitBranch;
    case "preview_url":
    case "runtime_service":
      return Globe;
    case "artifact":
    case "document":
    default:
      return FileText;
  }
}

function looksLikeMarkdownPath(value: string | null | undefined) {
  if (!value) return false;
  return /\.md(?:own|arkdown)?(?:[#?].*)?$/i.test(value);
}

function isMarkdownWorkProduct(product: IssueWorkProduct) {
  const metadata = asRecord(product.metadata);
  const format = firstString(metadata, "format", "contentType", "mimeType")?.toLowerCase() ?? null;
  const path = firstString(metadata, "path", "filePath", "filename", "name");
  return product.type === "document"
    || format === "markdown"
    || format === "text/markdown"
    || looksLikeMarkdownPath(product.url)
    || looksLikeMarkdownPath(path);
}

function getEmbeddedMarkdownPreview(product: IssueWorkProduct) {
  const metadata = asRecord(product.metadata);
  return firstString(
    metadata,
    "markdown",
    "body",
    "content",
    "previewMarkdown",
    "summaryMarkdown",
  );
}

function resolveMarkdownPreviewUrl(product: IssueWorkProduct) {
  const metadata = asRecord(product.metadata);
  return firstString(metadata, "rawUrl", "downloadUrl", "previewUrl") ?? product.url;
}

function canReviewInline(product: IssueWorkProduct) {
  return Boolean(product.summary)
    || Boolean(getEmbeddedMarkdownPreview(product))
    || isMarkdownWorkProduct(product);
}

function MetaPill({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "subtle" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em]",
        tone === "default"
          ? "border-border/70 bg-transparent text-foreground"
          : "border-border/60 bg-transparent text-muted-foreground",
      )}
    >
      {label}: {value}
    </span>
  );
}

export function buildIssueWorkProductComment(product: Pick<IssueWorkProduct, "title" | "url">, comment: string) {
  const header = [
    `**Work product review — ${product.title}**`,
    product.url ? `Source: ${product.url}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return [header, comment.trim()].join("\n\n");
}

export function IssueWorkProductsSection({
  workProducts,
  onAddComment,
}: {
  workProducts: readonly IssueWorkProduct[];
  onAddComment?: (body: string) => Promise<void>;
}) {
  const [selectedProduct, setSelectedProduct] = useState<IssueWorkProduct | null>(null);
  const [previewState, setPreviewState] = useState<{
    status: "idle" | "loading" | "ready" | "error";
    markdown: string | null;
    error: string | null;
  }>({ status: "idle", markdown: null, error: null });
  const [commentDraft, setCommentDraft] = useState("");
  const [commentPending, setCommentPending] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);

  const sortedProducts = useMemo(
    () => [...workProducts].sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary)),
    [workProducts],
  );

  useEffect(() => {
    setCommentDraft("");
    setCommentError(null);
    if (!selectedProduct) {
      setPreviewState({ status: "idle", markdown: null, error: null });
      return;
    }

    const embeddedPreview = getEmbeddedMarkdownPreview(selectedProduct);
    if (embeddedPreview) {
      setPreviewState({ status: "ready", markdown: embeddedPreview, error: null });
      return;
    }

    if (!isMarkdownWorkProduct(selectedProduct)) {
      setPreviewState({ status: "ready", markdown: null, error: null });
      return;
    }

    const previewUrl = resolveMarkdownPreviewUrl(selectedProduct);
    if (!previewUrl) {
      setPreviewState({ status: "ready", markdown: null, error: null });
      return;
    }

    let cancelled = false;
    setPreviewState({ status: "loading", markdown: null, error: null });
    void fetch(previewUrl)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Preview unavailable (${response.status})`);
        }
        return response.text();
      })
      .then((markdown) => {
        if (cancelled) return;
        setPreviewState({ status: "ready", markdown, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPreviewState({
          status: "error",
          markdown: null,
          error: error instanceof Error ? error.message : "Preview unavailable.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [selectedProduct]);

  if (workProducts.length === 0) return null;

  async function handleAddComment() {
    if (!selectedProduct || !onAddComment) return;
    const trimmed = commentDraft.trim();
    if (!trimmed) {
      setCommentError("Write a review comment before posting.");
      return;
    }

    setCommentPending(true);
    setCommentError(null);
    try {
      await onAddComment(buildIssueWorkProductComment(selectedProduct, trimmed));
      setCommentDraft("");
    } catch (error) {
      setCommentError(error instanceof Error ? error.message : "Failed to post comment.");
    } finally {
      setCommentPending(false);
    }
  }

  return (
    <>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium text-muted-foreground">Work products</h3>
            <p className="text-xs text-muted-foreground">
              Review assignee outputs without leaving the issue.
            </p>
          </div>
          <span className="text-xs text-muted-foreground">
            {workProducts.length} item{workProducts.length === 1 ? "" : "s"}
          </span>
        </div>

        <div className="space-y-3">
          {sortedProducts.map((product) => {
            const ProductIcon = workProductIcon(product.type);
            const previewable = canReviewInline(product);
            return (
              <div key={product.id} className="rounded-lg border border-border bg-background/80 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-accent/20 text-muted-foreground">
                        <ProductIcon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-foreground">{product.title}</div>
                        <div className="text-xs text-muted-foreground">
                          Updated {relativeTime(product.updatedAt)}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <MetaPill label="Type" value={workProductTypeLabel(product.type)} />
                      <MetaPill label="Status" value={workProductStatusLabel(product.status)} tone="subtle" />
                      <MetaPill label="Review" value={workProductReviewStateLabel(product.reviewState)} tone="subtle" />
                      <MetaPill label="Provider" value={humanizeToken(product.provider)} tone="subtle" />
                      {product.isPrimary ? <MetaPill label="Primary" value="Yes" /> : null}
                    </div>

                    {product.summary ? (
                      <p className="text-sm leading-6 text-muted-foreground">{product.summary}</p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {previewable ? (
                      <Button size="sm" variant="outline" onClick={() => setSelectedProduct(product)}>
                        {onAddComment ? (
                          <>
                            <MessageSquarePlus className="mr-1.5 h-3.5 w-3.5" />
                            Review
                          </>
                        ) : (
                          "View"
                        )}
                      </Button>
                    ) : null}
                    {product.url ? (
                      <a
                        href={product.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-9 items-center rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground"
                      >
                        <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                        Open
                      </a>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <Dialog open={Boolean(selectedProduct)} onOpenChange={(open) => !open && setSelectedProduct(null)}>
        <DialogContent className="sm:max-w-4xl">
          {selectedProduct ? (
            <>
              <DialogHeader>
                <DialogTitle>{selectedProduct.title}</DialogTitle>
                <DialogDescription>
                  Review this work product in context and send feedback back to the issue thread.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <MetaPill label="Type" value={workProductTypeLabel(selectedProduct.type)} />
                  <MetaPill label="Status" value={workProductStatusLabel(selectedProduct.status)} tone="subtle" />
                  <MetaPill label="Review" value={workProductReviewStateLabel(selectedProduct.reviewState)} tone="subtle" />
                  {selectedProduct.url ? (
                    <a
                      href={selectedProduct.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center rounded-sm border border-border/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-foreground transition-colors hover:border-sky-500/70 hover:bg-sky-500/10"
                    >
                      <ExternalLink className="mr-1 h-3 w-3" />
                      Open source
                    </a>
                  ) : null}
                </div>

                {selectedProduct.summary ? (
                  <div className="rounded-lg border border-border/70 bg-accent/10 px-4 py-3 text-sm leading-6 text-muted-foreground">
                    {selectedProduct.summary}
                  </div>
                ) : null}

                <div className="rounded-lg border border-border/70 bg-background/70">
                  <div className="border-b border-border/60 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Preview
                  </div>
                  <div className="max-h-[26rem] overflow-y-auto px-4 py-4">
                    {previewState.status === "loading" ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading preview...
                      </div>
                    ) : previewState.markdown ? (
                      <MarkdownBody>{previewState.markdown}</MarkdownBody>
                    ) : previewState.status === "error" ? (
                      <div className="flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-3 text-sm text-amber-900 dark:text-amber-100">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <div>
                          <div className="font-medium">Preview unavailable</div>
                          <div className="mt-1">{previewState.error}</div>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-accent/10 px-3 py-3 text-sm text-muted-foreground">
                        <Package className="mt-0.5 h-4 w-4 shrink-0" />
                        <div>
                          This work product does not expose inline markdown content. Use the source link if you need the raw artifact.
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {onAddComment ? (
                  <div className="space-y-3 rounded-lg border border-border/70 bg-background/70 p-4">
                    <div>
                      <div className="text-sm font-medium text-foreground">Comment back to the issue</div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Paperclip will include the work product title and source link automatically.
                      </p>
                    </div>
                    <Textarea
                      value={commentDraft}
                      onChange={(event) => setCommentDraft(event.target.value)}
                      placeholder="Add review feedback, requested changes, or approval notes"
                      className="min-h-28 bg-background text-sm"
                    />
                    {commentError ? <p className="text-xs text-destructive">{commentError}</p> : null}
                    <div className="flex justify-end">
                      <Button size="sm" onClick={() => void handleAddComment()} disabled={commentPending}>
                        {commentPending ? (
                          <>
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            Posting...
                          </>
                        ) : (
                          "Post comment"
                        )}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
