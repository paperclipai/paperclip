import { AlertTriangle, ExternalLink, Loader2, Lock, RefreshCw } from "lucide-react";
import type { PipelineCaseLiveness } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import {
  derivePipelineLivenessBanner,
  type LivenessBannerLink,
  type LivenessBannerTone,
  type LivenessRetryKind,
} from "../lib/pipeline-liveness";

interface TonePalette {
  section: string;
  icon: string;
  pulse: string;
  link: string;
  button: string;
  Icon: typeof AlertTriangle;
}

const TONE_PALETTES: Record<LivenessBannerTone, TonePalette> = {
  blocked: {
    section:
      "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100",
    icon: "text-amber-700 dark:text-amber-300",
    pulse: "bg-amber-500",
    link: "text-amber-900 dark:text-amber-100",
    button:
      "border-amber-300 bg-transparent hover:bg-amber-100 dark:border-amber-900/70 dark:hover:bg-amber-950/40",
    Icon: AlertTriangle,
  },
  permission: {
    section:
      "border-purple-300 bg-purple-50 text-purple-950 dark:border-purple-900/70 dark:bg-purple-950/30 dark:text-purple-100",
    icon: "text-purple-700 dark:text-purple-300",
    pulse: "bg-purple-500",
    link: "text-purple-900 dark:text-purple-100",
    button:
      "border-purple-300 bg-transparent hover:bg-purple-100 dark:border-purple-900/70 dark:hover:bg-purple-950/40",
    Icon: Lock,
  },
  retry: {
    section:
      "border-indigo-300 bg-indigo-50 text-indigo-950 dark:border-indigo-900/70 dark:bg-indigo-950/30 dark:text-indigo-100",
    icon: "text-indigo-700 dark:text-indigo-300",
    pulse: "bg-indigo-500",
    link: "text-indigo-900 dark:text-indigo-100",
    button:
      "border-indigo-300 bg-transparent hover:bg-indigo-100 dark:border-indigo-900/70 dark:hover:bg-indigo-950/40",
    Icon: RefreshCw,
  },
  attention: {
    section:
      "border-orange-300 bg-orange-50 text-orange-950 dark:border-orange-900/70 dark:bg-orange-950/30 dark:text-orange-100",
    icon: "text-orange-700 dark:text-orange-300",
    pulse: "bg-orange-500",
    link: "text-orange-900 dark:text-orange-100",
    button:
      "border-orange-300 bg-transparent hover:bg-orange-100 dark:border-orange-900/70 dark:hover:bg-orange-950/40",
    Icon: AlertTriangle,
  },
};

function blockerLinkLabel(link: LivenessBannerLink): string {
  if (link.identifier) return `Open ${link.identifier}`;
  return "Open blocker";
}

function automationLinkLabel(link: LivenessBannerLink): string {
  if (link.identifier) return `Open ${link.identifier}`;
  return "Open automation issue";
}

export function PipelineLivenessBanner({
  liveness,
  onRetry,
  retryPending = false,
  retryError = null,
}: {
  liveness: PipelineCaseLiveness | null | undefined;
  onRetry?: (kind: LivenessRetryKind) => void;
  retryPending?: boolean;
  retryError?: string | null;
}) {
  const view = derivePipelineLivenessBanner(liveness);
  if (!view) return null;

  const palette = TONE_PALETTES[view.tone];
  const { Icon } = palette;
  const showRetry = view.showRetry && typeof onRetry === "function";

  return (
    <section
      role="status"
      aria-label={view.title}
      className={cn(
        "mb-5 flex flex-col gap-3 border-y py-4 md:flex-row md:items-start md:justify-between",
        palette.section,
      )}
    >
      <div className="flex min-w-0 gap-3">
        <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", palette.icon)} aria-hidden="true" />
        <div className="min-w-0 space-y-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            {view.tone === "retry" ? (
              <span
                className={cn("h-1.5 w-1.5 animate-pulse rounded-full", palette.pulse)}
                aria-hidden="true"
              />
            ) : null}
            {view.title}
          </h2>
          <p className="text-sm opacity-85">{view.body}</p>
          {view.permissionKey ? (
            <p className="text-sm opacity-85">
              Required permission:{" "}
              <code className="rounded-sm bg-black/10 px-1 py-0.5 text-xs font-medium dark:bg-white/10">
                {view.permissionKey}
              </code>{" "}
              on the target pipeline.
            </p>
          ) : null}
          {view.blockerLink || view.automationLink ? (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              {view.blockerLink ? (
                <Link
                  to={createIssueDetailPath(view.blockerLink.identifier ?? view.blockerLink.issueId)}
                  className={cn("inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline", palette.link)}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {blockerLinkLabel(view.blockerLink)}
                  {view.blockerLink.title ? `: ${view.blockerLink.title}` : ""}
                </Link>
              ) : null}
              {view.automationLink ? (
                <Link
                  to={createIssueDetailPath(view.automationLink.identifier ?? view.automationLink.issueId)}
                  className={cn("inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline", palette.link)}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {automationLinkLabel(view.automationLink)}
                </Link>
              ) : null}
            </p>
          ) : null}
          {view.helperNote ? (
            <p className="text-xs italic opacity-70">{view.helperNote}</p>
          ) : null}
          {retryError ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {retryError}
            </p>
          ) : null}
        </div>
      </div>
      {showRetry ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={cn("shrink-0", palette.button)}
          disabled={retryPending}
          onClick={() => onRetry?.(view.retryKind)}
        >
          {retryPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          {retryPending ? "Retrying…" : view.retryLabel}
        </Button>
      ) : null}
    </section>
  );
}
