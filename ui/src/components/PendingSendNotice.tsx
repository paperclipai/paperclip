import { t, useTranslation } from "@/i18n";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Shown above a composer while a send waits for the connection. The text stays
 * on this device and resends with its original request ID, so it cannot post
 * twice; the user can resend now or take the text back with Cancel.
 *
 * Without `onResendNow` (a send saved by an older version, with no stored
 * request to replay) it only says the outcome is unknown and offers Cancel.
 */
export function PendingSendNotice({
  noun = "message",
  resending,
  stalled,
  persisted = false,
  onResendNow,
  onCancel,
  className,
}: {
  /** What is being sent: "comment", "task", "update". */
  noun?: string;
  resending: boolean;
  stalled: boolean;
  persisted?: boolean;
  onResendNow?: () => void;
  onCancel: () => void;
  className?: string;
}) {
  useTranslation("task-components");
  const nounLabel = ({ message: t("deep-ui:noun_message"), comment: t("deep-ui:noun_comment"), task: t("deep-ui:noun_task"), update: t("deep-ui:noun_update") } as Record<string, string>)[noun] ?? noun;
  const replayable = Boolean(onResendNow);
  const title = !replayable
    ? t("deep-ui:send_unknown", { noun: nounLabel })
    : resending
      ? t("task-components:sending_b8ed5279")
      : stalled
        ? t("deep-ui:send_failed", { noun: nounLabel })
        : t("deep-ui:sending_when_reconnected_8639e6");
  const detail = replayable
    ? persisted ? t("deep-ui:send_saved", { noun: nounLabel })
      : t("deep-ui:browser_storage_is_unavailable_keep_this_tab_open_or_copy_yo_164d7a")
    : t("deep-ui:it_may_already_be_in_the_conversation_check_it_before_sendin_cb1803");
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="pending-send-notice"
      className={cn("space-y-2 rounded-md border border-border bg-muted p-3 text-sm", className)}
    >
      <p className="flex items-center gap-2 font-medium">
        {resending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
        {title}
      </p>
      <p className="text-muted-foreground">{detail}</p>
      <div className="flex items-center gap-2">
        {onResendNow ? (
          <Button type="button" size="sm" variant="outline" disabled={resending} onClick={onResendNow}>{t("task-components:resendNow_a4fab5c8")}</Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" disabled={resending} onClick={onCancel}>{t("task-components:cancel_19766ed6")}</Button>
      </div>
    </div>
  );
}
