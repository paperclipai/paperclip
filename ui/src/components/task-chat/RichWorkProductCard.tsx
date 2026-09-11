import { t, useTranslation, i18n } from "@/i18n";
import { useContext, useState, type CSSProperties } from "react";
import { IssueGalleryContext } from "@/context/IssueGalleryContext";
import { ImageGalleryModal } from "@/components/ImageGalleryModal";
import { isImageContentType, isVideoLikeOutput } from "@/lib/issue-output";
import type { IssueWorkProduct } from "@paperclipai/shared";
import {
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
import { cn } from "@/lib/utils";

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
    return { get label() { return t("localizationTaskRuntime.ui_Changes_requested_i679pu"); }, tone: "failure" };
  }
  if (reviewState === "needs_board_review" || status === "ready_for_review") {
    return { get label() { return t("localizationTaskRuntime.ui_Review_tnr3lt"); }, tone: "review" };
  }
  if (["failed", "unhealthy", "down"].includes(status ?? "")) {
    return { get label() { return t("localizationTaskRuntime.ui_Failed_npsixg"); }, tone: "failure" };
  }
  if (["pending", "opening"].includes(status ?? "")) {
    return { label: status === "opening" ? t("localizationTaskRuntime.ui_Opening_dfet3") : t("localizationTaskRuntime.ui_Pending_e8nfto"), tone: "progress", dashed: true };
  }
  if (kind === "pull_request" && (status === "active" || status === "open")) {
    return { get label() { return t("localizationTaskRuntime.ui_Open_n6hn1l"); }, tone: "progress" };
  }
  if (kind === "pull_request" && status === "draft") {
    return { get label() { return t("localizationTaskRuntime.ui_Draft_129n38s"); }, tone: "review" };
  }
  if (kind === "pull_request" && status === "merged") {
    return { get label() { return t("localizationTaskRuntime.ui_Merged_b3sjo9"); }, tone: "success" };
  }
  if (kind === "pull_request" && status === "closed") {
    return { get label() { return t("localizationTaskRuntime.ui_Closed_dvi7s5"); }, tone: "neutral" };
  }
  if (kind === "runtime_service" && status === "active") {
    return { get label() { return t("localizationTaskRuntime.ui_Running_j6ts6k"); }, tone: "progress" };
  }
  if (kind === "runtime_service" && status === "closed") {
    return { get label() { return t("localizationTaskRuntime.ui_Stopped_118y86m"); }, tone: "failure" };
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
  const unit = value < 1024 ? "bytes" : value < 1024 * 1024 ? "kilobytes" : "megabytes";
  const size = value < 1024 ? value : value < 1024 * 1024 ? value / 1024 : value / (1024 * 1024);
  return t(`localizationIssueDetail.${unit}`, { size: new Intl.NumberFormat(i18n.resolvedLanguage, { useGrouping: false, minimumFractionDigits: value < 1024 ? 0 : 1, maximumFractionDigits: value < 1024 ? 0 : 1 }).format(size) });
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
  useTranslation();
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
  variant?: "card" | "compact";
}

export function RichWorkProductCard({ workProduct, href, variant = "card" }: RichWorkProductCardProps) {
  useTranslation();
  const openIssueGallery = useContext(IssueGalleryContext);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const metadata = workProduct.metadata;
  const contentType = stringMeta(metadata, "contentType") ?? "";
  const isImage = isImageContentType(contentType);
  const isVideo = isVideoLikeOutput(contentType, stringMeta(metadata, "originalFilename"));
  let Icon: LucideIcon = File;
  let meta: Array<string | null> = [];
  let action = t("localizationTaskRuntime.ui_Open_preview_ijv7rx");

  switch (workProduct.type) {
    case "pull_request": {
      Icon = GithubIcon;
      const repository = stringMeta(metadata, "repository", "repo", "repositoryName");
      const number = stringMeta(metadata, "number", "pullRequestNumber");
      const base = stringMeta(metadata, "baseRef", "base", "baseBranch");
      const head = stringMeta(metadata, "headRef", "head", "headBranch", "branch");
      meta = [repository, number ? `#${number.replace(/^#/, "")}` : null, base && head ? `${base} ← ${head}` : null, urlLabel(workProduct.url)];
      action = t("localizationTaskRuntime.ui_Open_on_GitHub_a4llll");
      break;
    }
    case "commit":
      Icon = GitCommit;
      meta = [stringMeta(metadata, "shortSha", "sha")?.slice(0, 8) ?? workProduct.externalId?.slice(0, 8) ?? null, stringMeta(metadata, "branch", "branchName"), urlLabel(workProduct.url)];
      action = t("localizationTaskRuntime.ui_Open_on_GitHub_a4llll");
      break;
    case "branch":
      Icon = GitBranch;
      meta = [stringMeta(metadata, "repository", "repo", "repositoryName"), stringMeta(metadata, "branch", "branchName") ?? workProduct.externalId, urlLabel(workProduct.url)];
      action = t("localizationTaskRuntime.ui_Open_on_GitHub_a4llll");
      break;
    case "artifact": {
      Icon = isImage ? Image : isVideo ? Film : File;
      const size = numberMeta(metadata, "byteSize", "size");
      meta = [isImage ? t("localizationTaskRuntime.ui_Image_ophmze") : isVideo ? t("localizationTaskRuntime.ui_Video_pd0tu4") : stringMeta(metadata, "kind", "fileType") ?? t("localizationTaskRuntime.ui_File_bygjtv"), size === null ? null : formatBytes(size)];
      action = isImage || isVideo ? t("localizationTaskRuntime.ui_Open_gallery_15roi53") : t("localizationTaskRuntime.ui_Open_preview_ijv7rx");
      break;
    }
    case "document":
      Icon = FileText;
      meta = [t("localizationTaskRuntime.ui_Document_1wvusj8"), stringMeta(metadata, "revision", "revisionNumber") ? t("localizationTaskRuntime.revisionShort", { number: stringMeta(metadata, "revision", "revisionNumber") }) : null];
      action = t("localizationTaskRuntime.ui_Open_document_1isshgu");
      break;
    case "preview_url":
      Icon = Globe;
      meta = [urlLabel(workProduct.url)];
      action = t("localizationTaskRuntime.ui_Open_preview_ijv7rx");
      break;
    case "runtime_service":
      Icon = Server;
      meta = [stringMeta(metadata, "service", "serviceName") ?? workProduct.provider, stringMeta(metadata, "port") ? t("localizationTaskRuntime.port", { number: stringMeta(metadata, "port") }) : null];
      action = t("localizationTaskRuntime.ui_Open_service_1b95l3i");
      break;
  }

  const additions = numberMeta(metadata, "additions");
  const deletions = numberMeta(metadata, "deletions");
  const files = numberMeta(metadata, "files", "changedFiles");
  const unhealthyChip =
    workProduct.healthStatus === "unhealthy"
      ? workProduct.type === "preview_url"
        ? { get label() { return t("localizationTaskRuntime.ui_Down_19o4rhx"); }, tone: "failure" as const }
        : workProduct.type === "runtime_service" && workProduct.status !== "closed"
          ? { get label() { return t("localizationTaskRuntime.ui_Unhealthy_1rx27pn"); }, tone: "failure" as const }
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
  const fileCount = files === null ? null : t("localizationTaskRuntime.fileCount", { count: files });
  const statsLabel = [changeCounts || null, fileCount].filter(Boolean).join(" · ");
  const compact = variant === "compact";
  const imagePath = isImage
    ? stringMeta(metadata, "openPath", "contentPath") ?? href
    : null;

  const mediaPath = workProduct.type === "artifact" && (isImage || isVideo)
    ? stringMeta(metadata, "contentPath", "openPath") ?? href
    : null;
  const openGallery = () => {
    if (mediaPath && !openIssueGallery?.(mediaPath)) setGalleryOpen(true);
  };

  return (
    <article
      className={cn(
        "@container flex min-w-0 rounded-md border border-border bg-card/60",
        compact ? "items-center gap-2 px-2.5 py-1.5" : "items-start gap-3 px-3 py-2.5",
      )}
      data-testid={`task-chat-rich-work-product-${workProduct.type}`}
      data-variant={variant}
    >
      <div className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted/60 text-muted-foreground",
        compact ? "h-8 w-8" : "h-10 w-10",
      )}>
        {imagePath ? (
          <img src={imagePath} alt="" className="h-full w-full object-cover" />
        ) : (
          <Icon aria-hidden className={compact ? "h-4 w-4" : "h-5 w-5"} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <strong className="block truncate text-sm font-medium text-foreground">{workProduct.title}</strong>
        {visibleMeta.length > 0 ? <p className="mt-1 truncate text-xs text-muted-foreground">{visibleMeta.join(" · ")}</p> : null}
        {statsLabel ? <p className="mt-1 whitespace-nowrap text-xs text-muted-foreground">{statsLabel}</p> : null}
      </div>
      <div className={cn("flex shrink-0 items-center", compact ? "gap-1.5" : "gap-2")}>
        {chip ? <Chip chip={chip} /> : null}
        {mediaPath ? (
          <button type="button" onClick={openGallery} aria-label={`${action}: ${workProduct.title}`} className="inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline">
            {compact ? null : <span className="hidden @sm:inline">{action}</span>}<Maximize2 aria-hidden className="h-3 w-3" />
          </button>
        ) : href ? (
          <a href={href} aria-label={`${action}: ${workProduct.title}`} className="inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline" target={href.startsWith("http") ? "_blank" : undefined} rel={href.startsWith("http") ? "noreferrer" : undefined}>
            {compact ? null : <span className="hidden @sm:inline">{action}</span>}<ExternalLink aria-hidden className="h-3 w-3" />
          </a>
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
