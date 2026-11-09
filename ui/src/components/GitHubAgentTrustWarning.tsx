import { AlertTriangle, ExternalLink } from "lucide-react";
import type { AgentPermissions } from "@paperclipai/shared";
import { getTrustPreset } from "@/lib/trust-policy-ui";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";

export const LOW_TRUST_AGENT_GUIDE =
  "https://docs.paperclip.ing/administration/trust-and-low-trust-review/";

export function GitHubAgentTrustWarning({
  agent,
  onChangeToLowTrust,
  disabled,
}: {
  agent:
    { name: string; permissions: Partial<AgentPermissions> } | null | undefined;
  onChangeToLowTrust?: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  if (!agent || getTrustPreset(agent.permissions) === "low_trust_review")
    return null;
  return (
    <div
      role="alert"
      className="space-y-2 rounded-lg border border-(--status-task-todo)/30 bg-(--status-task-todo)/10 p-4 text-sm"
    >
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle className="size-4 shrink-0" />
        {t("agents.githubAgentTrustWarning.notConfigured", { name: agent.name })}
      </p>
      <p>
        {t("agents.githubAgentTrustWarning.commentsWarning")}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("agents.githubAgentTrustWarning.continuing")}
      </p>
      {onChangeToLowTrust && (
        <Button variant="outline" className="h-auto whitespace-normal" disabled={disabled} onClick={onChangeToLowTrust}>
          {t("agents.githubAgentTrustWarning.changeToLowTrust", { name: agent.name })}
        </Button>
      )}
      <a
        className="inline-flex items-center gap-1 underline underline-offset-4"
        href={LOW_TRUST_AGENT_GUIDE}
        target="_blank"
        rel="noreferrer"
      >
        {t("agents.githubAgentTrustWarning.learnMore")}
        <ExternalLink className="size-3.5" />
      </a>
    </div>
  );
}
