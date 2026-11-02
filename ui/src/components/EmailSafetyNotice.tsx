import { useTranslation } from "@/i18n";
import { AlertTriangle } from "lucide-react";
export function EmailSafetyNotice() {
  const { t } = useTranslation();
  return (
    <div
      role="note"
      className="space-y-3 rounded-lg border border-border bg-muted/30 p-4"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="size-4 shrink-0 text-(--status-agent-paused)" />
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {t("sep12Connections.unrestrictedInbox")}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("sep12Connections.allowlistAdvice")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("sep12Connections.senderRestrictionsNotice")}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <a
          href="https://console.agentmail.to"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-4"
        >
          {t("sep12Connections.openAgentMail")}
        </a>
        <a
          href="https://docs.agentmail.to/knowledge-base/allowlists-blocklists"
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground underline underline-offset-4"
        >
          {t("sep12Connections.setUpAllowlists")}
        </a>
      </div>
    </div>
  );
}
