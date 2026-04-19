import { buildAgentMentionHref } from "@paperclipai/shared";

export const DEFAULT_AGENT_HELP_PROMPT =
  "Please review this task and propose specific ways you could help. Do not take ownership or start execution unless I explicitly ask.";

export interface AgentHelpRequestAgent {
  id: string;
  name: string;
  icon?: string | null;
}

export interface AgentHelpRequest {
  issueTitle: string;
  selectedAgents: AgentHelpRequestAgent[];
  prompt: string;
}

function escapeMentionLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

export function buildAgentHelpRequestComment({
  selectedAgents,
  prompt,
}: AgentHelpRequest): string {
  const mentions = selectedAgents
    .map((agent) => `[@${escapeMentionLabel(agent.name)}](${buildAgentMentionHref(agent.id, agent.icon ?? null)})`)
    .join(" ");
  const trimmedPrompt = prompt.trim();

  return [mentions, trimmedPrompt].filter(Boolean).join("\n\n");
}

export function canAskAgentsForIssue(
  issue: { assigneeUserId: string | null; status: string } | null | undefined,
  currentUserId: string | null | undefined,
): boolean {
  if (!issue || !currentUserId) return false;
  if (issue.assigneeUserId !== currentUserId) return false;
  return issue.status !== "done" && issue.status !== "cancelled";
}
