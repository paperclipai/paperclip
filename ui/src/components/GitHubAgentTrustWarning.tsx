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
  if (!agent || getTrustPreset(agent.permissions) === "low_trust_review")
    return null;
  return (
    <div
      role="alert"
      className="space-y-2 rounded-lg border border-(--status-task-todo)/30 bg-(--status-task-todo)/10 p-4 text-sm"
    >
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle className="size-4 shrink-0" />
        {agent.name} is not configured for low-trust review
      </p>
      <p>
        GitHub comments and pull requests can contain malicious instructions. We
        recommend a low-trust agent with a scoped work boundary and an isolated
        sandbox runtime.
      </p>
      <p className="text-xs text-muted-foreground">
        Continuing keeps this agent’s current permissions. A restricted guest
        profile does not replace the agent’s trust and runtime settings.
      </p>
      <a
        className="inline-flex items-center gap-1 underline underline-offset-4"
        href={LOW_TRUST_AGENT_GUIDE}
        target="_blank"
        rel="noreferrer"
      >
        Learn about low-trust agents
        <ExternalLink className="size-3.5" />
      </a>
    </div>
  );
}
