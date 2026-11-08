import { t, useTranslation } from "@/i18n";
import { createPortal } from "react-dom";
import { Button } from "./ui/button";

/** Out of document flow so a failed optional read cannot move task rows. */
export function IssueRowDetailsNotice({ error, onRetry, message = t("final-components-b:IssueRowDetailsNotice.Some_task_details_couldn_t_load_b57b59"), retryLabel = t("final-components-b:IssueRowDetailsNotice.Retry_details_ffcac3") }: {
  error: Error | null;
  onRetry: () => void;
  message?: string;
  retryLabel?: string;
}) {
  useTranslation("final-components-b");
  if (!error) return null;
  return createPortal(
    <div role="alert" className="fixed bottom-4 right-4 z-50 flex max-w-sm items-center gap-3 rounded-lg border bg-card p-3 text-sm shadow-lg">
      <p>{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>{retryLabel}</Button>
    </div>, document.body,
  );
}
