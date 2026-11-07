import { t, useTranslation } from "@/i18n";
import { AlertTriangle } from "lucide-react";
export function EmailSafetyNotice() {
  useTranslation("task-components");
  return (
    <div
      role="note"
      className="space-y-3 rounded-lg border border-border bg-muted/30 p-4"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="size-4 shrink-0 text-(--status-agent-paused)" />
        <div className="space-y-1">
          <p className="text-sm font-medium">{t("task-components:anyoneCanEmailAnUnrestrictedInbox_850d77ab")}</p>
          <p className="text-sm text-muted-foreground">{t("task-components:incomingEmailCanCreateTasksAndTrigger_50c1c42c")}</p>
          <p className="text-xs text-muted-foreground">{t("task-components:paperclipDoesNotVerifySenderRestrictionsAgentmail_db40f3b5")}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <a
          href="https://console.agentmail.to"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-4"
        >{t("task-components:openAgentmail_1d9d67d1")}</a>
        <a
          href="https://docs.agentmail.to/knowledge-base/allowlists-blocklists"
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground underline underline-offset-4"
        >{t("task-components:setUpAllowlists_0bf5ad9e")}</a>
      </div>
    </div>
  );
}
