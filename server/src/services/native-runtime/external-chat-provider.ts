// Providers supported by the run-bound external-chat authorization path.
// AgentMail uses the email inbox path and is not admitted by this boundary.
const BOUND_EXTERNAL_CHAT_PROVIDERS = [
  "slack",
  "github",
  "discord",
  "microsoft-teams",
  "telegram",
  "imessage-photon",
] as const;

export function boundExternalChatProvider(source: unknown) {
  return BOUND_EXTERNAL_CHAT_PROVIDERS.find(
    (provider) => source === `chat:${provider}` || source === `chat:${provider}:recovery`,
  ) ?? null;
}
