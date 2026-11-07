import { t, useTranslation, Trans } from "@/i18n";
import { AlertTriangle, ExternalLink } from "lucide-react";
import type { AgentPermissions } from "@paperclipai/shared";
import { getTrustPreset } from "@/lib/trust-policy-ui";
import { Button } from "@/components/ui/button";

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
  useTranslation("task-components");
  if (!agent || getTrustPreset(agent.permissions) === "low_trust_review")
    return null;
  return (
    <div
      role="alert"
      className="space-y-2 rounded-lg border border-(--status-task-todo)/30 bg-(--status-task-todo)/10 p-4 text-sm"
    >
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle className="size-4 shrink-0" />
        {t("final-components-a:agentIsNotConfiguredFor_21bf13a9", { agent: agent.name })}
      </p>
      <p>{t("task-components:githubCommentsAndPullRequestsCanContain_e21696ad")}</p>
      <p className="text-xs text-muted-foreground">{t("task-components:continuingKeepsThisAgentSCurrentPermissions_63846416")}</p>
      {onChangeToLowTrust && (
        <Button variant="outline" className="h-auto whitespace-normal" disabled={disabled} onClick={onChangeToLowTrust}><Trans ns="task-components" i18nKey="sentence_e133dc275ff4" components={{ part1: <>{agent.name}</> }} /></Button>
      )}
      <a
        className="inline-flex items-center gap-1 underline underline-offset-4"
        href={LOW_TRUST_AGENT_GUIDE}
        target="_blank"
        rel="noreferrer"
      >{t("task-components:learnAboutLowTrustAgents_3c6aaa98")}<ExternalLink className="size-3.5" />
      </a>
    </div>
  );
}
