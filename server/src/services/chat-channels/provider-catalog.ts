import type {
  ChatAdapterCapabilities,
  ChatProvider,
} from "@paperclipai/shared";

const PROVIDER_LABELS: Record<ChatProvider, string> = {
  speko: "Speko",
  "imessage-photon": "iMessage Photon",
  agentmail: "AgentMail",
  slack: "Slack",
  github: "GitHub",
  discord: "Discord",
  "microsoft-teams": "Microsoft Teams",
  telegram: "Telegram",
};

const CAPABILITIES: Record<ChatProvider, ChatAdapterCapabilities> = {
  speko: { threads: false, directMessages: true, nativeStreaming: false, messageEdits: false, messageDeletes: false, reactions: false, files: false, cards: false, actions: false, modals: false, slashCommands: false, ephemeralMessages: false, proactiveDirectMessages: false },
  "imessage-photon": { threads: false, directMessages: true, nativeStreaming: false, messageEdits: true, messageDeletes: false, reactions: false, files: true, cards: false, actions: true, modals: false, slashCommands: false, ephemeralMessages: false, proactiveDirectMessages: false },
  agentmail: { threads: true, directMessages: true, nativeStreaming: false, messageEdits: false, messageDeletes: false, reactions: false, files: true, cards: false, actions: false, modals: false, slashCommands: false, ephemeralMessages: false, proactiveDirectMessages: true },
  slack: {
    threads: true,
    directMessages: true,
    nativeStreaming: true,
    messageEdits: true,
    messageDeletes: true,
    reactions: true,
    files: true,
    cards: true,
    actions: true,
    modals: true,
    slashCommands: true,
    ephemeralMessages: true,
    proactiveDirectMessages: false,
  },
  github: {
    threads: true,
    directMessages: false,
    nativeStreaming: false,
    messageEdits: true,
    messageDeletes: true,
    reactions: true,
    files: false,
    cards: true,
    actions: false,
    modals: false,
    slashCommands: false,
    ephemeralMessages: false,
    proactiveDirectMessages: false,
  },
  discord: {
    threads: true,
    directMessages: true,
    nativeStreaming: false,
    messageEdits: true,
    messageDeletes: true,
    reactions: true,
    files: true,
    cards: true,
    actions: true,
    modals: true,
    // Automatic registration upgrades these only after a durable provider
    // receipt. A draft or an uncertain/conflicting registration stays false.
    slashCommands: false,
    ephemeralMessages: false,
    proactiveDirectMessages: false,
  },
  "microsoft-teams": {
    threads: true,
    directMessages: true,
    // Production webhook processing is deferred into Paperclip's durable
    // ingress queue. The Teams adapter's request-scoped DM streamer is gone by
    // the time agent output is published, so advertise the durable behavior we
    // can actually provide. editMessage still lets one run coalesce its
    // queued, working, and final states in place.
    nativeStreaming: false,
    // Paperclip supplements the pinned adapter's missing inbound Bot Framework
    // messageUpdate/messageDelete dispatch after provider authentication.
    messageEdits: true,
    messageDeletes: true,
    reactions: true,
    files: true,
    cards: true,
    actions: true,
    modals: true,
    slashCommands: false,
    ephemeralMessages: true,
    proactiveDirectMessages: false,
  },
  telegram: {
    threads: true,
    directMessages: true,
    nativeStreaming: true,
    messageEdits: true,
    // Telegram's Bot API does not emit an update when a user deletes a
    // message, so this capability cannot be offered truthfully.
    messageDeletes: false,
    reactions: true,
    files: true,
    cards: true,
    actions: true,
    modals: false,
    slashCommands: false,
    ephemeralMessages: false,
    proactiveDirectMessages: false,
  },
};
export { PROVIDER_LABELS, CAPABILITIES };

export function chatConnectionTransport(provider: ChatProvider): "voice" | "rest_api" | "chat_sdk" {
  if (provider === "speko") return "voice";
  if (provider === "agentmail") return "rest_api";
  return "chat_sdk";
}
