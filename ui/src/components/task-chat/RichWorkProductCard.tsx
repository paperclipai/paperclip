import { t, useTranslation, Trans } from "@/i18n";
import { TextAttachmentContext } from "@/context/TextAttachmentContext";
import { isTextAttachment } from "@/lib/issue-attachments";
import { getAttachmentArtifactWorkProductMetadata } from "@paperclipai/shared";
import { useContext, useState, type CSSProperties } from "react";
import { IssueGalleryContext } from "@/context/IssueGalleryContext";
import { ArtifactPreview } from "@/components/artifacts/ArtifactCard";
import { MediaArtifactCard } from "@/components/artifacts/MediaArtifactCard";
import { ImageGalleryModal } from "@/components/ImageGalleryModal";
import { isImageLikeOutput, isVideoLikeOutput } from "@/lib/issue-output";
import { attachmentDownloadPath } from "@/lib/issue-attachments";
import type { IssueWorkProduct } from "@paperclipai/shared";
import {
  ChevronDown,
  ExternalLink,
  Maximize2,
  File,
  FileText,
  Film,
  GitBranch,
  GitCommit,
  Globe,
  Image,
  Server,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { GithubIcon } from "@/components/icons/github-icon";
import { cn, formatDateTime } from "@/lib/utils";

type StateChip = {
  label: string;
  tone: "progress" | "failure" | "review" | "success" | "neutral";
  dashed?: boolean;
};

/** Resting states stay quiet. A completed work product never gets a chip. */
export function stateChipFor(
  kind: IssueWorkProduct["type"],
  status: string | null | undefined,
  reviewState: IssueWorkProduct["reviewState"] | string | null | undefined,
): StateChip | null {
  if (reviewState === "changes_requested" || status === "changes_requested") {
    return { label: t("task-components:changesRequested_10a92a8a"), tone: "failure" };
  }
  if (reviewState === "needs_board_review" || status === "ready_for_review") {
    return { label: t("task-components:review_aff0766a"), tone: "review" };
  }
  if (["failed", "unhealthy", "down"].includes(status ?? "")) {
    return { label: t("task-components:failed_031a8f0f"), tone: "failure" };
  }
  if (["pending", "opening"].includes(status ?? "")) {
    return { label: status === "opening" ? t("deep-ui:opening_f4b13e") : t("task-components:pending_331551b0"), tone: "progress", dashed: true };
  }
  if (kind === "pull_request" && (status === "active" || status === "open")) {
    return { label: t("deep-ui:pr_open"), tone: "progress" };
  }
  if (kind === "pull_request" && status === "draft") {
    return { label: t("task-components:draft_ebf12ef4"), tone: "review" };
  }
  if (kind === "pull_request" && status === "merged") {
    return { label: t("deep-ui:merged_bd0a06"), tone: "success" };
  }
  if (kind === "pull_request" && status === "closed") {
    return { label: t("deep-ui:closed_c21ead"), tone: "neutral" };
  }
  if (kind === "runtime_service" && status === "active") {
    return { label: t("task-components:running_f4ccae29"), tone: "progress" };
  }
  if (kind === "runtime_service" && status === "closed") {
    return { label: t("task-components:stopped_1a4f630a"), tone: "failure" };
  }
  return null;
}

function stringMeta(metadata: Record<string, unknown> | null, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function numberMeta(metadata: Record<string, unknown> | null, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function urlLabel(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, typeof window === "undefined" ? "http://localhost" : window.location.origin);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

function Chip({ chip }: { chip: StateChip }) {
  useTranslation("task-components");
  const cssVar = chip.tone === "failure"
    ? "--status-task-blocked"
    : chip.tone === "success"
      ? "--status-task-done"
      : chip.tone === "neutral"
        ? "--status-task-cancelled"
    : chip.tone === "review"
      ? "--status-task-in_review"
      : "--status-task-in_progress";
  return (
    <span
      className={cn(
        "status-chip inline-flex shrink-0 items-center rounded-full border px-2 py-1 text-(length:--text-nano) font-medium leading-none",
        chip.dashed && "border-dashed",
      )}
      style={{ "--sc": `var(${cssVar})` } as CSSProperties}
    >
      {chip.label}
    </span>
  );
}

export interface RichWorkProductCardProps {
  workProduct: IssueWorkProduct;
  href: string | null;
  variant?: "card" | "compact" | "gallery";
}

export function RichWorkProductCard({ workProduct, href, variant = "card" }: RichWorkProductCardProps) {
  useTranslation("task-components");
  const openIssueGallery = useContext(IssueGalleryContext);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const metadata = workProduct.metadata;
  const contentType = stringMeta(metadata, "contentType") ?? "";
  const isImage = isImageLikeOutput(contentType, stringMeta(metadata, "originalFilename") ?? workProduct.title);
  const isVideo = isVideoLikeOutput(contentType, stringMeta(metadata, "originalFilename") ?? workProduct.title);
  let Icon: LucideIcon = File;
  let meta: Array<string | null> = [];
  let action = t("deep-ui:open_preview_f7afe3");

  switch (workProduct.type) {
    case "pull_request": {
      Icon = GithubIcon;
      const repository = stringMeta(metadata, "repository", "repo", "repositoryName");
      const number = stringMeta(metadata, "number", "pullRequestNumber");
      const base = stringMeta(metadata, "baseRef", "base", "baseBranch");
      const head = stringMeta(metadata, "headRef", "head", "headBranch", "branch");
      meta = [repository, number ? `#${number.replace(/^#/, "")}` : null, base && head ? `${base} ← ${head}` : null, urlLabel(workProduct.url)];
      action = t("deep-ui:open_on_github_03f698");
      break;
    }
    case "commit":
      Icon = GitCommit;
      meta = [stringMeta(metadata, "shortSha", "sha")?.slice(0, 8) ?? workProduct.externalId?.slice(0, 8) ?? null, stringMeta(metadata, "branch", "branchName"), urlLabel(workProduct.url)];
      action = t("deep-ui:open_on_github_03f698");
      break;
    case "branch":
      Icon = GitBranch;
      meta = [href ? t("deep-ui:branch_52656e") : t("deep-ui:branch_no_remote_link_b39f12"), stringMeta(metadata, "repository", "repo", "repositoryName"), stringMeta(metadata, "branch", "branchName") ?? workProduct.externalId, urlLabel(workProduct.url)];
      action = t("deep-ui:open_on_github_03f698");
      break;
    case "artifact": {
      Icon = isImage ? Image : isVideo ? Film : File;
      const size = numberMeta(metadata, "byteSize", "size");
      meta = [isImage ? t("deep-ui:image_1aa4cb") : isVideo ? t("deep-ui:video_d534be") : stringMeta(metadata, "kind", "fileType") ?? t("deep-ui:file_50009c"), size === null ? null : formatBytes(size)];
      action = isImage || isVideo ? t("deep-ui:open_gallery_1f0a43") : t("deep-ui:download_d6eafe");
      break;
    }
    case "document":
      Icon = FileText;
      meta = [t("deep-ui:document_d6bd8c"), stringMeta(metadata, "revision", "revisionNumber") ? t("deep-ui:work_revision", { revision: stringMeta(metadata, "revision", "revisionNumber") }) : null];
      action = t("deep-ui:open_document_07e93c");
      break;
    case "preview_url":
      Icon = Globe;
      meta = [urlLabel(workProduct.url)];
      action = t("deep-ui:open_preview_f7afe3");
      break;
    case "runtime_service":
      Icon = Server;
      meta = [stringMeta(metadata, "service", "serviceName") ?? workProduct.provider, stringMeta(metadata, "port") ? t("deep-ui:work_port", { port: stringMeta(metadata, "port") }) : null];
      action = t("deep-ui:open_service_40f3c5");
      break;
  }

  const openText = useContext(TextAttachmentContext);
  const textMetadata = getAttachmentArtifactWorkProductMetadata(workProduct);
  const canOpenText = Boolean(openText && textMetadata && isTextAttachment(textMetadata));
  const additions = numberMeta(metadata, "additions");
  const deletions = numberMeta(metadata, "deletions");
  const files = numberMeta(metadata, "files", "changedFiles");
  const unhealthyChip =
    workProduct.healthStatus === "unhealthy"
      ? workProduct.type === "preview_url"
        ? { label: t("task-components:down_b86d11af"), tone: "failure" as const }
        : workProduct.type === "runtime_service" && workProduct.status !== "closed"
          ? { label: t("task-components:unhealthy_317b1fbc"), tone: "failure" as const }
          : null
      : null;
  const chip =
    unhealthyChip ??
    stateChipFor(
      workProduct.type,
      workProduct.type === "pull_request"
        ? stringMeta(metadata, "state") ?? workProduct.status
        : workProduct.type === "runtime_service" &&
        workProduct.status === "active" &&
        workProduct.healthStatus !== "healthy"
        ? null
        : workProduct.status,
      workProduct.reviewState,
    );
  const visibleMeta = meta.filter((value): value is string => Boolean(value));
  const changeCounts = [additions === null ? null : `+${additions}`, deletions === null ? null : `−${deletions}`]
    .filter(Boolean)
    .join(" ");
  const fileCount = files === null ? null : t("deep-ui:work_files", { count: files });
  const statsLabel = [changeCounts || null, fileCount].filter(Boolean).join(" · ");
  const compact = variant === "compact";
  const mediaPath = workProduct.type === "artifact" && (isImage || isVideo)
    ? stringMeta(metadata, "contentPath", "openPath") ?? href
    : null;
  const artifactContentPath = stringMeta(metadata, "contentPath")
    ?? (href && /^\/api\/attachments\/[^/?#]+\/content$/.test(href) ? href : null);
  const actionHref = workProduct.type === "artifact" && !isImage && !isVideo
    ? stringMeta(metadata, "downloadPath") ?? (artifactContentPath
      ? attachmentDownloadPath({ contentPath: artifactContentPath })
      : href)
    : href;
  const expandable = !compact && !mediaPath && !actionHref;
  const summary = workProduct.summary?.trim();
  const linklessBranch = workProduct.type === "branch" && !href;
  const openGallery = () => {
    if (mediaPath && !openIssueGallery?.(mediaPath)) setGalleryOpen(true);
  };

  if (variant === "gallery" && mediaPath) {
    return (
      <MediaArtifactCard
        id={workProduct.id}
        title={workProduct.title}
        contentPath={mediaPath}
        contentType={contentType}
        originalFilename={stringMeta(metadata, "originalFilename") ?? workProduct.title}
        downloadPath={stringMeta(metadata, "downloadPath") ?? undefined}
        detail={visibleMeta.join(" · ")}
        badge={chip ? <Chip chip={chip} /> : null}
      />
    );
  }

  return (
    <article
      className={cn(
        "@container relative flex min-w-0 rounded-md border border-border bg-card/60",
        (mediaPath || actionHref) && "hover:bg-accent/50",
        compact ? "items-center gap-2 px-2.5 py-1.5" : "items-start gap-3 px-3 py-2.5",
      )}
      data-testid={`task-chat-rich-work-product-${workProduct.type}`}
      data-variant={variant}
    >
      <div className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted/60 text-muted-foreground",
        mediaPath ? "w-20" : compact ? "h-8 w-8" : "h-10 w-10",
      )}>
        {mediaPath ? (
          <ArtifactPreview artifact={{ contentPath: mediaPath, title: workProduct.title, mediaKind: isVideo ? "video" : "image" }} />
        ) : (
          <Icon aria-hidden className={compact ? "h-4 w-4" : "h-5 w-5"} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <strong className={cn("block text-sm font-medium text-foreground", expandable ? detailsOpen ? "break-words" : "line-clamp-2 break-words" : "truncate")}>{workProduct.title}</strong>
        {visibleMeta.length > 0 ? <p className="mt-1 truncate text-xs text-muted-foreground">{visibleMeta.join(" · ")}</p> : null}
        {statsLabel || workProduct.type === "pull_request" ? (
          // Provider refresh can supply these counts after first paint. Keep
          // the line's geometry while the saved PR card is already readable.
          <p className="mt-1 min-h-4 whitespace-nowrap text-xs text-muted-foreground" aria-hidden={!statsLabel}>{statsLabel || "\u00a0"}</p>
        ) : null}
        {!compact && summary && !linklessBranch ? <p className={cn("mt-1 text-xs text-muted-foreground", detailsOpen ? "whitespace-pre-wrap break-words" : "line-clamp-2")}>{summary}</p> : null}
        {expandable && detailsOpen ? (
          <div className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
            {workProduct.type !== "branch" ? <p>{t("task-components:noLinkWasProvidedForThisWork_e8448297")}</p> : null}
            <p><Trans ns="task-components" i18nKey="sentence_fe810789afbd" components={{ part1: <>{workProduct.provider}</>, part2: <>{workProduct.status.replaceAll("_", " ")}</>, part3: <>{formatDateTime(workProduct.updatedAt)}</> }} /></p>
            {linklessBranch && summary ? (
              <details className="relative z-10 mt-1">
                <summary className="w-fit cursor-pointer font-medium text-foreground">{t("task-components:savedDescription_1e502410")}</summary>
                <p className="mt-1 whitespace-pre-wrap break-words">{summary}</p>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className={cn("flex shrink-0 items-center", compact ? "gap-1.5" : "gap-2")}>
        {chip ? <Chip chip={chip} /> : null}
        {canOpenText ? (
          <button
            type="button"
            onClick={() => openText!(textMetadata!.attachmentId, textMetadata!.originalFilename ?? workProduct.title)}
            aria-label={t("task-components:openInTab_5d58d268", { value1: workProduct.title })}
            className="inline-flex items-center gap-1 text-xs font-medium text-foreground after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
          >
            {compact ? null : <span className="hidden @sm:inline">{t("task-components:openInTab_0e5d9596")}</span>}<FileText aria-hidden className="h-3 w-3" />
          </button>
        ) : null}
        {mediaPath ? (
          <button type="button" onClick={openGallery} aria-label={`${action}: ${workProduct.title}`} className="inline-flex items-center gap-1 text-xs font-medium text-foreground after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring">
            {compact ? null : <span className="hidden @sm:inline">{action}</span>}<Maximize2 aria-hidden className="h-3 w-3" />
          </button>
        ) : actionHref ? (
          <a href={actionHref} aria-label={`${action}: ${workProduct.title}`} className={cn("inline-flex items-center gap-1 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", canOpenText ? "relative z-10" : "after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-ring")} target={actionHref.startsWith("http") ? "_blank" : undefined} rel={actionHref.startsWith("http") ? "noreferrer" : undefined}>
            {compact ? null : <span className="hidden @sm:inline">{action}</span>}<ExternalLink aria-hidden className="h-3 w-3" />
          </a>
        ) : expandable ? (
          <button
            type="button"
            onClick={() => setDetailsOpen((open) => !open)}
            aria-label={detailsOpen ? t("deep-ui:work_hide_details", { title: workProduct.title }) : t("deep-ui:work_show_details", { title: workProduct.title })}
            aria-expanded={detailsOpen}
            className="inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-foreground after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
          >
            <span>{detailsOpen ? t("task-components:hideDetails_c9722a7a") : t("task-components:showDetails_1af77ee2")}</span>
            <ChevronDown aria-hidden className={cn("h-4 w-4", detailsOpen && "rotate-180")} />
          </button>
        ) : null}
      </div>
      {galleryOpen && mediaPath ? (
        <ImageGalleryModal
          items={[{
            id: workProduct.id,
            contentPath: mediaPath,
            downloadPath: stringMeta(metadata, "downloadPath") ?? undefined,
            contentType,
            originalFilename: stringMeta(metadata, "originalFilename") ?? workProduct.title,
          }]}
          initialIndex={0}
          open
          onOpenChange={setGalleryOpen}
        />
      ) : null}
    </article>
  );
}
