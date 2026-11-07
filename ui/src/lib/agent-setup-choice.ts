type SetupDraft = { pauseReason?: unknown; metadata?: unknown };
export type PendingAgentSetupChoice = { adapterType: "paperclip_runner"; runnerProvider: "antigravity" | "pool"; runner: "auto" };

/** Display and navigation intent only; never an execution configuration. */
export function pendingAgentSetupChoice(agent: SetupDraft | null | undefined): PendingAgentSetupChoice | undefined {
  if (agent?.pauseReason !== "setup" || !agent.metadata || typeof agent.metadata !== "object") return;
  const metadata = agent.metadata as Record<string, unknown>;
  if (metadata.setupAdapterPending !== true || !metadata.setupAdapterChoice || typeof metadata.setupAdapterChoice !== "object") return;
  const choice = metadata.setupAdapterChoice as Record<string, unknown>;
  if (choice.adapterType === "paperclip_runner" && ["antigravity", "pool"].includes(String(choice.runnerProvider)) && choice.runner === "auto") {
    return { adapterType: "paperclip_runner", runnerProvider: choice.runnerProvider as "antigravity" | "pool", runner: "auto" };
  }
}

export function pendingAgentSetupDisplayAdapter(agent: SetupDraft | null | undefined): "antigravity_runtime" | "pool" | undefined {
  const choice = pendingAgentSetupChoice(agent);
  return choice ? choice.runnerProvider === "pool" ? "pool" : "antigravity_runtime" : undefined;
}
