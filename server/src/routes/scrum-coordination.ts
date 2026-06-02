export function isScrumCoordinatorAgent(agent: { name?: string | null; urlKey?: string | null; role?: string | null } | null | undefined) {
  if (!agent) return false;
  const name = (agent.name ?? "").trim().toLowerCase();
  const urlKey = (agent.urlKey ?? "").trim().toLowerCase();
  return agent.role === "pm" && (name === "scrum" || urlKey === "scrum");
}

export function isActiveCoordinationIssueStatus(status: string) {
  return status === "todo" || status === "in_progress" || status === "blocked" || status === "in_review";
}
