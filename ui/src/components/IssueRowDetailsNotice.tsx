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
    <div role="alert" className="fixed bottom-4 right-4 z-50 flex max-w-sm items-center gap-3 rounded-lg border bg-card p-3 text-sm shadow-lg">
      <p>{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>{retryLabel}</Button>
    </div>, document.body,
  );
}
