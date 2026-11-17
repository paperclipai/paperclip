import type { ChatProvider } from "@paperclipai/shared";

export const RECEIVER_LEASE_KEYS = {
  discord: "discord_gateway_runtime",
  "imessage-photon": "photon_receiver_runtime",
} as const satisfies Partial<Record<ChatProvider, string>>;

export function receiverLeaseKey(provider: string) {
  return Object.hasOwn(RECEIVER_LEASE_KEYS, provider)
    ? RECEIVER_LEASE_KEYS[provider as keyof typeof RECEIVER_LEASE_KEYS] : undefined;
}

export const leasedChatProvider = (provider: string) => receiverLeaseKey(provider) !== undefined;
