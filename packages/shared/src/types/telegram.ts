export interface AgentTelegramConfig {
  id: string;
  companyId: string;
  agentId: string;
  botUsername: string | null;
  enabled: boolean;
  ownerChatId: string | null;
  allowedUserIds: string[];
  requireMention: boolean;
  mentionPatterns: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentTelegramTestResult {
  ok: boolean;
  botId: number;
  botUsername: string;
  firstName: string;
}

export type TelegramMediaType = "photo" | "document";

export interface SendTelegramNotificationOptions {
  sessionId?: string;
  mediaType?: TelegramMediaType;
  mediaUrl?: string;
  mediaPath?: string;
  caption?: string;
}
