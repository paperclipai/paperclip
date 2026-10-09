import type { IssueDocument } from "@paperclipai/shared";
import { Lightbulb, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
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
    : "Plan";
  const preview = lines
    .filter((line, index) => index !== headingIndex && !/^(```|~~~|---+$|\*\*\*+$|___+$)/.test(line))
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
  const title = activity.title.trim() && activity.title.trim().toLowerCase() !== "plan"
    ? activity.title.trim()
    : "Plan";
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
  const revision = planRevision(source);
  const content = source.kind === "saved" && source.document
    ? planPreviewContent(source.document.body)
    : source.kind === "saved"
      ? { title: source.fallbackTitle?.trim() || "Plan", preview: [] as string[] }
      : livePlanContent(source.activity);
  const live = source.kind === "live";
  const headerDetail = revision == null
    ? null
    : `rev ${revision}`;
  const body = (
    <>
      <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5 text-sm text-muted-foreground">
        <Lightbulb
          aria-hidden
          className={cn("h-4 w-4 shrink-0", live && "text-(--status-agent-running)")}
        />
        <span className={cn("font-medium", live && "shimmer-text shimmer-text-muted")} data-testid={live ? "task-chat-plan-streaming-status" : undefined}>
          {live ? "Writing plan" : "Plan"}
        </span>
        {headerDetail ? (
          <span
            className={cn("text-xs", live && "shimmer-text shimmer-text-muted")}
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
            {live ? "Waiting for the first plan step…" : "Open the synchronized plan to review it."}
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
        aria-label={ariaLabel ?? `Open Plan${revision == null ? "" : ` revision ${revision}`}`}
        className={sharedClassName}
      >
        {body}
      </a>
    );
  }

  return (
    <section
      aria-label={ariaLabel ?? "Streaming Plan preview"}
      data-testid={testId}
      className={sharedClassName}
    >
      {body}
    </section>
  );
}
