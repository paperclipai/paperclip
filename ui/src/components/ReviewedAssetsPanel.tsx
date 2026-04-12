import { useMemo, useState } from "react";
import type { IssueAttachment, ReviewedArtifactsResponse } from "@paperclipai/shared";
import {
  AlertTriangle,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileArchive,
  FileQuestion,
  FileText,
  Files,
  Image as ImageIcon,
  Lock,
} from "lucide-react";
import { Link } from "@/lib/router";
import { cn, relativeTime } from "../lib/utils";
import { mapReviewedArtifactsResponse, type ReviewedArtifactPanelItem } from "../lib/reviewed-artifacts";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyText } from "./CopyText";
import { ImageGalleryModal } from "./ImageGalleryModal";
import { MarkdownBody } from "./MarkdownBody";

function formatBytes(bytes: number | null | undefined) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sourceLabel(sourceType: ReviewedArtifactPanelItem["sourceType"]) {
  if (sourceType === "issue_document") return "document";
  if (sourceType === "issue_attachment") return "attachment";
  if (sourceType === "issue_work_product") return "work product";
  if (sourceType === "workspace_file") return "workspace file";
  if (sourceType === "external_url") return "external link";
  return "approval payload";
}

function resolutionLabel(artifact: ReviewedArtifactPanelItem) {
  if (artifact.renderKind === "missing") return "Missing";
  if (artifact.renderKind === "permission_denied") return "Permission denied";
  if (artifact.renderKind === "unavailable") return "Unavailable";
  if (artifact.resolution.status === "too_large") return "Too large";
  if (artifact.renderKind === "unsupported") return "Unsupported";
  if (artifact.renderKind === "download_only") return "Download only";
  return null;
}

function artifactMeta(artifact: ReviewedArtifactPanelItem) {
  const parts = [
    sourceLabel(artifact.sourceType),
    artifact.preview.contentType,
    formatBytes(artifact.preview.byteSize),
    artifact.sourceIssue?.identifier ?? artifact.sourceIssue?.title,
  ].filter(Boolean);
  return parts.join(" - ");
}

function toGalleryAttachment(artifact: ReviewedArtifactPanelItem, companyId: string): IssueAttachment {
  return {
    id: artifact.id,
    companyId,
    issueId: artifact.sourceIssue?.id ?? "",
    issueCommentId: null,
    assetId: artifact.id,
    provider: "paperclip",
    objectKey: artifact.id,
    contentType: artifact.preview.contentType ?? "application/octet-stream",
    byteSize: artifact.preview.byteSize ?? 0,
    sha256: "",
    originalFilename: artifact.title,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    contentPath: artifact.preview.previewUrl ?? "",
  };
}

function ReviewedArtifactLoadingState() {
  return (
    <div className="min-h-[176px] space-y-3" data-testid="reviewed-assets-loading">
      <Skeleton className="h-20 w-full rounded-md" />
      <Skeleton className="h-20 w-full rounded-md" />
    </div>
  );
}

function ReviewedArtifactEmptyState({ suggested }: { suggested: boolean }) {
  return (
    <div
      className="min-h-24 rounded-md border border-dashed border-border bg-muted/20 px-3 py-4 text-sm text-muted-foreground"
      data-testid="reviewed-assets-empty"
    >
      {suggested
        ? "No suggested review assets are available yet."
        : "No reviewed assets selected yet."}
    </div>
  );
}

function ReviewedArtifactErrorState({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : "Reviewed assets could not be loaded.";
  return (
    <div
      className="flex min-h-24 items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-destructive"
      data-testid="reviewed-assets-error"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <p>{message}</p>
    </div>
  );
}

function ReviewedArtifactPartialFailure({ model }: { model: ReturnType<typeof mapReviewedArtifactsResponse> }) {
  if (model.errors.length === 0) return null;
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div>
        <p className="font-medium">Some assets could not load.</p>
        <p className="mt-0.5">
          Showing available assets. {model.errors.map((error) => `${error.source}: ${error.message}`).join("; ")}
        </p>
      </div>
    </div>
  );
}

function ArtifactIcon({ artifact }: { artifact: ReviewedArtifactPanelItem }) {
  if (artifact.renderKind === "permission_denied") return <Lock className="h-4 w-4 text-muted-foreground" />;
  if (artifact.renderKind === "missing" || artifact.renderKind === "unavailable") {
    return <FileQuestion className="h-4 w-4 text-muted-foreground" />;
  }
  if (artifact.renderKind === "image") return <ImageIcon className="h-4 w-4 text-muted-foreground" />;
  if (artifact.renderKind === "markdown") return <FileText className="h-4 w-4 text-muted-foreground" />;
  return <FileArchive className="h-4 w-4 text-muted-foreground" />;
}

function ArtifactActions({
  artifact,
  issuePathId,
  onOpenImage,
}: {
  artifact: ReviewedArtifactPanelItem;
  issuePathId?: string | null;
  onOpenImage: (artifact: ReviewedArtifactPanelItem) => void;
}) {
  const documentHref = issuePathId && artifact.document?.key
    ? `/issues/${issuePathId}#document-${encodeURIComponent(artifact.document.key)}`
    : null;
  const externalHref = artifact.preview.externalUrl ?? (artifact.renderKind === "link" ? artifact.preview.previewUrl : null);
  const markdownBody = artifact.preview.markdownBody ?? "";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {artifact.renderKind === "image" ? (
        <Button type="button" variant="outline" size="sm" onClick={() => onOpenImage(artifact)}>
          <Eye className="mr-1.5 h-3.5 w-3.5" />
          Preview
        </Button>
      ) : null}
      {documentHref ? (
        <Link to={documentHref} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          <FileText className="mr-1.5 h-3.5 w-3.5" />
          Open document
        </Link>
      ) : null}
      {artifact.renderKind === "markdown" && markdownBody ? (
        <CopyText text={markdownBody} className={cn(buttonVariants({ variant: "outline", size: "sm" }))} copiedLabel="Copied">
          <Copy className="mr-1.5 h-3.5 w-3.5" />
          Copy
        </CopyText>
      ) : null}
      {externalHref ? (
        <a
          href={externalHref}
          target="_blank"
          rel="noreferrer"
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
          Open
        </a>
      ) : null}
      {artifact.preview.downloadUrl ? (
        <a
          href={artifact.preview.downloadUrl}
          download
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          <Download className="mr-1.5 h-3.5 w-3.5" />
          Download
        </a>
      ) : null}
    </div>
  );
}

function ReviewedMarkdownArtifact({ artifact }: { artifact: ReviewedArtifactPanelItem }) {
  return (
    <div
      className="mt-3 max-h-80 overflow-auto rounded-md border border-border/70 bg-muted/20 px-3 py-2"
      data-testid="reviewed-artifact-markdown"
    >
      <MarkdownBody className="text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0" softBreaks={false}>
        {artifact.preview.markdownBody ?? ""}
      </MarkdownBody>
    </div>
  );
}

function ReviewedImageArtifact({
  artifact,
  onOpenImage,
}: {
  artifact: ReviewedArtifactPanelItem;
  onOpenImage: (artifact: ReviewedArtifactPanelItem) => void;
}) {
  return (
    <button
      type="button"
      className="mt-3 block max-h-64 w-full overflow-hidden rounded-md border border-border bg-muted/20 text-left"
      data-testid="reviewed-artifact-image"
      onClick={() => onOpenImage(artifact)}
    >
      <img
        src={artifact.preview.previewUrl ?? ""}
        alt={artifact.title}
        className="max-h-64 w-full object-contain"
        loading="lazy"
      />
    </button>
  );
}

function ReviewedLinkArtifact({ artifact }: { artifact: ReviewedArtifactPanelItem }) {
  const provider = typeof artifact.snapshot?.provider === "string" ? artifact.snapshot.provider : null;
  const status = typeof artifact.snapshot?.status === "string" ? artifact.snapshot.status : null;
  return (
    <div
      className="mt-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-sm text-muted-foreground"
      data-testid="reviewed-artifact-link"
    >
      {[provider, status].filter(Boolean).join(" - ") || "Link-only asset"}
    </div>
  );
}

function ReviewedDownloadOnlyArtifact({ artifact }: { artifact: ReviewedArtifactPanelItem }) {
  return (
    <div
      className="mt-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-sm text-muted-foreground"
      data-testid="reviewed-artifact-download"
    >
      Download this asset to review it.
      {artifact.resolution.reason ? <span className="ml-1">{artifact.resolution.reason}</span> : null}
    </div>
  );
}

function ReviewedUnsupportedArtifact({ artifact }: { artifact: ReviewedArtifactPanelItem }) {
  return (
    <div
      className="mt-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-sm text-muted-foreground"
      data-testid="reviewed-artifact-unsupported"
    >
      {artifact.resolution.reason ?? "Inline preview is unavailable for this asset."}
    </div>
  );
}

function ReviewedUnavailableArtifact({ artifact }: { artifact: ReviewedArtifactPanelItem }) {
  const message = artifact.renderKind === "permission_denied"
    ? "You do not have permission to view this asset."
    : artifact.renderKind === "missing"
      ? "This asset is no longer available."
      : "This asset is unavailable.";
  return (
    <div
      className="mt-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-sm text-muted-foreground"
      data-testid={`reviewed-artifact-${artifact.renderKind}`}
    >
      {artifact.resolution.reason ?? message}
    </div>
  );
}

function ReviewedArtifactPreview({
  artifact,
  onOpenImage,
}: {
  artifact: ReviewedArtifactPanelItem;
  onOpenImage: (artifact: ReviewedArtifactPanelItem) => void;
}) {
  if (artifact.renderKind === "markdown") return <ReviewedMarkdownArtifact artifact={artifact} />;
  if (artifact.renderKind === "image") return <ReviewedImageArtifact artifact={artifact} onOpenImage={onOpenImage} />;
  if (artifact.renderKind === "link") return <ReviewedLinkArtifact artifact={artifact} />;
  if (artifact.renderKind === "download_only") return <ReviewedDownloadOnlyArtifact artifact={artifact} />;
  if (artifact.renderKind === "unsupported") return <ReviewedUnsupportedArtifact artifact={artifact} />;
  return <ReviewedUnavailableArtifact artifact={artifact} />;
}

function ReviewedArtifactCard({
  artifact,
  issuePathId,
  onOpenImage,
}: {
  artifact: ReviewedArtifactPanelItem;
  issuePathId?: string | null;
  onOpenImage: (artifact: ReviewedArtifactPanelItem) => void;
}) {
  const label = resolutionLabel(artifact);
  const revision = artifact.document?.revisionNumber ? `Revision ${artifact.document.revisionNumber}` : null;
  const updatedAt = typeof artifact.snapshot?.updatedAt === "string" || artifact.snapshot?.updatedAt instanceof Date
    ? `updated ${relativeTime(artifact.snapshot.updatedAt)}`
    : null;

  return (
    <article className="rounded-md border border-border bg-background p-3" data-testid="reviewed-asset-card">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/30">
            <ArtifactIcon artifact={artifact} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="truncate text-sm font-medium text-foreground" title={artifact.title}>
                {artifact.title}
              </h4>
              {artifact.normalizedPrimary ? (
                <span className="rounded-md border border-primary/30 px-2 py-0.5 text-[10px] font-medium uppercase text-primary">
                  Primary
                </span>
              ) : null}
              <span className={cn(
                "rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase",
                artifact.selectedExplicitly
                  ? "border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                  : "border-amber-500/30 text-amber-700 dark:text-amber-300",
              )}>
                {artifact.selectionLabel}
              </span>
              {artifact.required ? (
                <span className="rounded-md border border-border px-2 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                  Required
                </span>
              ) : null}
              {label ? (
                <span className="rounded-md border border-border px-2 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                  {label}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {[artifactMeta(artifact), revision, updatedAt].filter(Boolean).join(" - ")}
            </p>
            {artifact.description ? (
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{artifact.description}</p>
            ) : null}
          </div>
        </div>
        <ArtifactActions artifact={artifact} issuePathId={issuePathId} onOpenImage={onOpenImage} />
      </div>
      <ReviewedArtifactPreview artifact={artifact} onOpenImage={onOpenImage} />
    </article>
  );
}

export function ReviewedAssetsPanel({
  response,
  isLoading = false,
  error = null,
  issuePathId,
  companyId,
  title,
  subtitle,
  className,
}: {
  response?: ReviewedArtifactsResponse | null;
  isLoading?: boolean;
  error?: unknown;
  issuePathId?: string | null;
  companyId: string;
  title?: string;
  subtitle?: string;
  className?: string;
}) {
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const model = useMemo(() => mapReviewedArtifactsResponse(response), [response]);
  const imageArtifacts = useMemo(
    () => model.items.filter((artifact) => artifact.renderKind === "image"),
    [model.items],
  );
  const galleryAttachments = useMemo(
    () => imageArtifacts.map((artifact) => toGalleryAttachment(artifact, companyId)),
    [companyId, imageArtifacts],
  );
  const panelTitle = title ?? (model.hasSuggestedSelection && !model.hasExplicitSelection
    ? "Suggested review assets"
    : "Reviewed assets");
  const panelSubtitle = subtitle ?? (model.hasSuggestedSelection && !model.hasExplicitSelection
    ? "Suggested from board-review work products."
    : "Selected for this review.");

  const openImage = (artifact: ReviewedArtifactPanelItem) => {
    const index = imageArtifacts.findIndex((entry) => entry.id === artifact.id);
    setGalleryIndex(index >= 0 ? index : 0);
    setGalleryOpen(true);
  };

  return (
    <section className={cn("space-y-3 rounded-md border border-border p-4", className)} data-testid="reviewed-assets-panel">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
          <Files className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">{panelTitle}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{panelSubtitle}</p>
        </div>
      </div>

      {isLoading ? (
        <ReviewedArtifactLoadingState />
      ) : error ? (
        <ReviewedArtifactErrorState error={error} />
      ) : model.items.length === 0 ? (
        <ReviewedArtifactEmptyState suggested={model.hasSuggestedSelection && !model.hasExplicitSelection} />
      ) : (
        <div className="space-y-3">
          <ReviewedArtifactPartialFailure model={model} />
          <div className="space-y-2">
            {model.items.map((artifact) => (
              <ReviewedArtifactCard
                key={artifact.id}
                artifact={artifact}
                issuePathId={issuePathId}
                onOpenImage={openImage}
              />
            ))}
          </div>
        </div>
      )}

      <ImageGalleryModal
        images={galleryAttachments}
        initialIndex={galleryIndex}
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
      />
    </section>
  );
}
