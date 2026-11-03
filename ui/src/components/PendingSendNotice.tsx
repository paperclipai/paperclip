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
  useTranslation();
  const nounKey = ["message", "comment", "task", "update"].includes(noun) ? noun : "custom";
  const replayable = Boolean(onResendNow);
  const title = !replayable
    ? t(`nov02Root.sendUnknown_${nounKey}`, { noun })
    : resending
      ? t("nov02Root.copyb8ed5279e8")
      : stalled
        ? t(`nov02Root.sendStalled_${nounKey}`, { noun })
        : t("nov02Root.copy8639e646e6");
  const detail = replayable
    ? persisted ? t(`nov02Root.sendSaved_${nounKey}`, { noun })
      : t("nov02Root.copy164d7a9ab8")
    : t("nov02Root.copycb18034a3c");
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
          <Button type="button" size="sm" variant="outline" disabled={resending} onClick={onResendNow}>
            {t("nov02Root.copya4fab5c812")}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" disabled={resending} onClick={onCancel}>
          {t("nov02Root.copy19766ed6cc")}
        </Button>
      </div>
    </div>
  );
}
