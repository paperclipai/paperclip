type SetupDraft = { pauseReason?: unknown; metadata?: unknown };
export type PendingAgentSetupChoice = { adapterType: "paperclip_runner"; runnerProvider: "antigravity"; runner: "auto" };

/** Display and navigation intent only; never an execution configuration. */
export function pendingAgentSetupChoice(agent: SetupDraft | null | undefined): PendingAgentSetupChoice | undefined {
  if (agent?.pauseReason !== "setup" || !agent.metadata || typeof agent.metadata !== "object") return;
  const metadata = agent.metadata as Record<string, unknown>;
  if (metadata.setupAdapterPending !== true || !metadata.setupAdapterChoice || typeof metadata.setupAdapterChoice !== "object") return;
  const choice = metadata.setupAdapterChoice as Record<string, unknown>;
  if (choice.adapterType === "paperclip_runner" && choice.runnerProvider === "antigravity" && choice.runner === "auto") {
    return { adapterType: "paperclip_runner", runnerProvider: "antigravity", runner: "auto" };
  }
}

export function pendingAgentSetupDisplayAdapter(agent: SetupDraft | null | undefined): "antigravity_runtime" | undefined {
  return pendingAgentSetupChoice(agent) ? "antigravity_runtime" : undefined;
}
