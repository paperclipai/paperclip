import { useEffect, type SVGProps } from "react";
import { cn } from "../lib/utils";
import { useBlockingPageGate } from "../hooks/usePageContentReady";
import { beginRouteSuspense } from "../lib/activity-loader";

export function AnimatedPaperclipIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="-1 -1 26 26"
      className={cn("paperclip-thinking-icon", className)}
      aria-hidden="true"
      {...props}
    >
      <path
        className="paperclip-thinking-icon-path"
        d="M16 6 l-8.414 8.586 a2.000 2.000 0 0 0 2.828 2.828 l8.414 -8.586 a4.000 4.000 0 1 0 -5.657 -5.657 l-8.379 8.551 a6.000 6.000 0 1 0 8.485 8.485 l8.379 -8.551"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Full-page loading state: a large, centered, gray animated paperclip. */
export function PaperclipLoading({ className }: { className?: string }) {
  // While a full-page loading state is on screen the page has not loaded.
  useBlockingPageGate();
  return (
    <div
      role="status"
      className={cn("flex min-h-dvh w-full items-center justify-center", className)}
    >
      <AnimatedPaperclipIcon className="h-24 w-24 text-muted-foreground" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function RouteContentLoading({ className }: { className?: string }) {
  useBlockingPageGate();
  useEffect(() => beginRouteSuspense(), []);
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-h-64 w-full flex-col items-center justify-center gap-3 py-12",
        className,
      )}
    >
      <AnimatedPaperclipIcon className="h-14 w-14 text-primary/80" />
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span className="paperclip-inline-spinner" aria-hidden="true" />
        <span>Loading page…</span>
      </div>
    </div>
  );
}
