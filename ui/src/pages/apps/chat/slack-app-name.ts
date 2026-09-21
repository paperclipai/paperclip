export function slackBotNameForAgent(agentName: string): string {
  const safeName = agentName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return safeName || "paperclip-agent";
}

export function defaultSlackAppName(agentName: string): string {
  return `${slackBotNameForAgent(agentName).slice(0, 25)}-paperclip`;
}
