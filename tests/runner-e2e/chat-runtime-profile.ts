/** Exact controller identity for the new remote campaign; historical Codex cells remain distinct. */
export const CHAT_OPENCODE_PROFILE = "runner-opencode";
export const CHAT_OPENCODE_MODEL = "openrouter/deepseek/deepseek-v4.1-flash-1017";
export function reviewedChatProfile(profile: { id?: string; provider?: string; model?: string; adapterType?: string; credential?: string } | undefined) {
  return profile?.id === "runner-codex-subscription" || !!profile && profile.id === CHAT_OPENCODE_PROFILE
    && profile.provider === "opencode" && profile.model === CHAT_OPENCODE_MODEL
    && profile.adapterType === "paperclip_runner" && profile.credential === "OPENROUTER_API_KEY";
}
export function reviewedChatExecutionIds(scenarioId: string) {
  return ["runner-codex-subscription", CHAT_OPENCODE_PROFILE].map(profile => `chat-features.${profile}.local.${scenarioId}`);
}
