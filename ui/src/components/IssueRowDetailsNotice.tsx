import { createPortal } from "react-dom";
import { Button } from "./ui/button";

/** Out of document flow so a failed optional read cannot move task rows. */
export function IssueRowDetailsNotice({ error, onRetry, message = "Some task details couldn’t load.", retryLabel = "Retry details" }: {
  error: Error | null;
  onRetry: () => void;
  message?: string;
  retryLabel?: string;
}) {
  if (!error) return null;
  return createPortal(
    <div
      role="alert"
      className="fixed inset-x-4 bottom-(--mobile-nav-overlay-bottom) z-50 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3 text-sm shadow-lg sm:left-auto sm:right-4 sm:max-w-sm sm:flex-nowrap md:bottom-4"
    >
      <p className="min-w-0 flex-1">{message}</p>
      <Button variant="outline" size="sm" className="shrink-0" onClick={onRetry}>{retryLabel}</Button>
    </div>, document.body,
  );
}
