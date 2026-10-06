import { t, useTranslation } from "@/i18n";
import { AlertTriangle, ExternalLink } from "lucide-react";
import type { AgentPermissions } from "@paperclipai/shared";
import { getTrustPreset } from "@/lib/trust-policy-ui";

export const LOW_TRUST_AGENT_GUIDE =
  "https://docs.paperclip.ing/administration/trust-and-low-trust-review/";

export function GitHubAgentTrustWarning({
  agent,
}: {
  agent:
    { name: string; permissions: Partial<AgentPermissions> } | null | undefined;
}) {
  useTranslation();
  if (!agent || getTrustPreset(agent.permissions) === "low_trust_review")
    return null;
  return (
    <div
      role="alert"
      className="space-y-2 rounded-lg border border-(--status-task-todo)/30 bg-(--status-task-todo)/10 p-4 text-sm"
    >
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle className="size-4 shrink-0" />
        {t("sep28Apps.lowTrustTitle", { agent: agent.name })}
      </p>
      <p>{t("sep28Apps.lowTrustWarning")}</p>
      <p className="text-xs text-muted-foreground">{t("sep28Apps.lowTrustPermissions")}</p>
      <a
        className="inline-flex items-center gap-1 underline underline-offset-4"
        href={LOW_TRUST_AGENT_GUIDE}
        target="_blank"
        rel="noreferrer"
      >{t("sep28Apps.lowTrustLearn")}<ExternalLink className="size-3.5" />
      </a>
    </div>
  );
}
