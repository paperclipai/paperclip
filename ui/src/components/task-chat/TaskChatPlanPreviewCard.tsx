import { t, useTranslation } from "@/i18n";
import type { IssueDocument } from "@paperclipai/shared";
import { FileText, Lightbulb, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { SidebarDocumentLink } from "@/components/SidebarDocumentLink";
import { buildDocumentAnnotationHash } from "@/lib/document-annotation-hash";
import { useCoordinatorPresentation } from "@/components/coordinator/CoordinatorPresentation";
import { useTaskChatShimmer } from "./TaskChatShimmer";
import type { TaskChatProviderActivityItem } from "./task-chat-model";

const PLAN_PREVIEW_LINE_COUNT = 3;

export function planPreviewContent(markdown: string) {
  const lines = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const headingIndex = lines.findIndex((line) => /^#\s+/.test(line));
  const title = headingIndex >= 0
    ? lines[headingIndex]!.replace(/^#\s+/, "").trim()
    : t("task-components:plan_fa8ed0bd");
  const preview = lines
    // Section headings ("## Steps") are structure, not plan content.
    .filter((line, index) => index !== headingIndex && !/^#{1,6}\s+/.test(line) && !/^(```|~~~|---+$|\*\*\*+$|___+$)/.test(line))
    .map((line) => line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/^>\s*/, "")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
      .trim())
    .filter(Boolean)
    .slice(0, PLAN_PREVIEW_LINE_COUNT);
  return { title, preview };
}

export type TaskChatPlanPreviewSource =
  | {
      kind: "saved";
      document?: IssueDocument | null;
      revision?: number | null;
      fallbackTitle?: string | null;
    }
  | {
      kind: "live";
      activity: TaskChatProviderActivityItem;
    };

export interface TaskChatPlanPreviewCardProps {
  source: TaskChatPlanPreviewSource;
  href?: string | null;
  ariaLabel?: string;
  testId?: string;
  className?: string;
}

function livePlanContent(activity: TaskChatProviderActivityItem) {
  // A proposed-plan document streams as markdown; a checklist streams as steps.
  if (activity.output?.trim()) {
    const fromMarkdown = planPreviewContent(activity.output);
    if (fromMarkdown.title !== "Plan" || fromMarkdown.preview.length > 0) return fromMarkdown;
  }
  const title = activity.title.trim() && activity.title.trim().toLowerCase() !== "plan"
    ? activity.title.trim()
    : t("task-components:plan_fa8ed0bd");
  const preview = activity.steps
    .map((step) => step.label.trim())
    .filter(Boolean)
    .slice(0, PLAN_PREVIEW_LINE_COUNT);
  if (preview.length === 0 && activity.summary?.trim()) preview.push(activity.summary.trim());
  return { title, preview };
}

function planRevision(source: TaskChatPlanPreviewSource): number | null {
  if (source.kind === "saved") {
    return source.revision ?? source.document?.latestRevisionNumber ?? null;
  }
  const detail = source.activity.details.find(({ label }) =>
    label === "Revision" || label === "Document Revision",
  );
  if (!detail) return null;
  const revision = Number.parseInt(detail.value, 10);
  return Number.isFinite(revision) ? revision : null;
}

export function TaskChatPlanPreviewCard({
  source,
  href = source.kind === "saved" ? "#document-plan" : null,
  ariaLabel,
  testId = "task-chat-plan-preview",
  className,
}: TaskChatPlanPreviewCardProps) {
  useTranslation("task-components");
  const coordinator = useCoordinatorPresentation();
  const shimmer = useTaskChatShimmer(source.kind === "live" ? source.activity.id : "saved-plan");
  const revision = planRevision(source);
  const content = source.kind === "saved" && source.document
    ? planPreviewContent(source.document.body)
    : source.kind === "saved"
      ? { title: source.fallbackTitle?.trim() || t("task-components:plan_fa8ed0bd"), preview: [] as string[] }
      : livePlanContent(source.activity);
  const live = source.kind === "live";
  if (coordinator) {
    const document = source.kind === "saved" ? source.document : null;
    const targetHref = href === "#document-plan" && document
      ? `/issues/${document.issueId}${buildDocumentAnnotationHash({ documentKey: document.key,
        revisionId: document.latestRevisionId ?? undefined, threadId: null, commentId: null })}`
      : href;
    const compactClassName = cn("inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-muted/25 px-3 py-2.5 text-sm text-muted-foreground",
      targetHref && "transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className);
    const compactBody = <><FileText className="size-4 shrink-0" aria-hidden /><span className="shrink-0">{live ? t("task-chat-ui:writing") : t("task-components:open_ed077f3d")}</span>{" "}
      <span className={cn("min-w-0 truncate text-foreground", targetHref && "underline underline-offset-4", live && shimmer && "shimmer-text shimmer-text-muted")}>{content.title}</span>
      {targetHref ? <span className="hidden shrink-0 sm:inline">{t("task-components:sentence_bdfda3e53e7f")}</span> : null}</>;
    return targetHref ? <SidebarDocumentLink href={targetHref} testId={testId}
      ariaLabel={ariaLabel ?? (revision == null ? t("task-chat-ui:openPlanSidebar", { title: content.title }) : t("task-chat-ui:openPlanRevisionSidebar", { title: content.title, revision }))} className={className}>
      <span className="shrink-0">{t("task-components:open_ed077f3d")}</span>{" "}<span className="min-w-0 truncate text-foreground underline underline-offset-4">{content.title}</span>
      <span className="hidden shrink-0 sm:inline">{t("task-components:sentence_bdfda3e53e7f")}</span>
    </SidebarDocumentLink>
      : <section data-testid={testId} aria-label={ariaLabel ?? t("task-components:writingPlan_64c92e65")} className={compactClassName}>{compactBody}</section>;
  }
  const headerDetail = revision == null
    ? null
    : t("task-chat-ui:revisionCompact", { revision });
  const body = (
    <>
      <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5 text-sm text-muted-foreground">
        <Lightbulb
          aria-hidden
          className={cn("h-4 w-4 shrink-0", live && "text-(--status-agent-running)")}
        />
        <span className={cn("font-medium", live && shimmer && "shimmer-text shimmer-text-muted")} data-testid={live ? "task-chat-plan-streaming-status" : undefined}>
          {live ? t("task-components:writingPlan_64c92e65") : t("task-components:plan_fa8ed0bd")}
        </span>
        {headerDetail ? (
          <span
            className="text-xs"
          >
            · {headerDetail}
          </span>
        ) : null}
        {href ? (
          <Maximize2
            aria-hidden
            className="ml-auto h-4 w-4 transition-transform group-hover:scale-105 group-hover:text-foreground"
          />
        ) : null}
      </div>
      <div className="relative max-h-36 overflow-hidden px-4 py-3">
        <h3 className="text-base font-semibold leading-6 text-foreground">{content.title}</h3>
        {content.preview.length > 0 ? (
          <ul className="mt-2 space-y-1.5 text-sm leading-5 text-muted-foreground">
            {content.preview.map((line, index) => (
              <li key={`${index}-${line}`} className="flex gap-2">
                <span aria-hidden className="shrink-0 text-muted-foreground/60">•</span>
                <span className="line-clamp-1">{line}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            {live ? t("task-components:waitingForTheFirstPlanStep_e4fab791") : t("task-components:openTheSynchronizedPlanToReviewIt_57c679e3")}
          </p>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-b from-transparent to-card/95" />
      </div>
    </>
  );
  const sharedClassName = cn(
    "group block w-full overflow-hidden rounded-md border border-border bg-muted/25 text-left",
    href && "transition-colors hover:border-foreground/25 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    className,
  );

  if (href) {
    return (
      <a
        href={href}
        data-testid={testId}
        aria-label={ariaLabel ?? (revision == null ? t("task-chat-ui:openPlanAria") : t("task-chat-ui:openPlanRevisionAria", { revision }))}
        className={sharedClassName}
      >
        {body}
      </a>
    );
  }

  return (
    <section
      aria-label={ariaLabel ?? t("task-components:streamingPlanPreview_7a03f9c3")}
      data-testid={testId}
      className={sharedClassName}
    >
      {body}
    </section>
  );
}
