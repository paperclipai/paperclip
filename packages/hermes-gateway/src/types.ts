export type Platform = "telegram" | "slack" | "discord" | "whatsapp";

export interface InboundPayload {
  messageId: string;
  platform: Platform;
  timestamp: string;
  sender: {
    platformUserId: string;
    displayName: string;
    avatarUrl?: string;
  };
  conversation: {
    platformConversationId: string;
    threadId: string | null;
    replyToMessageId: string | null;
  };
  content: {
    type: "text" | "image" | "file" | "voice_memo";
    text?: string;
    attachments?: Array<{
      type: "image" | "file" | "voice";
      url: string;
      mimeType?: string;
      sizeBytes?: number;
    }>;
  };
  metadata: {
    bridgeVersion: string;
    rawEvent?: unknown;
  };
}

export interface OutboundPayload {
  platform: Platform;
  recipient: {
    platformUserId: string;
    platformConversationId: string;
  };
  replyToMessageId?: string;
  content: {
    type: "text" | "image" | "action_buttons";
    text?: string;
    buttons?: Array<{
      label: string;
      callbackData: string;
    }>;
    imageUrl?: string;
  };
}

export interface ConversationMapping {
  id: string;
  platform: Platform;
  platformUserId: string;
  platformConversationId: string;
  threadId: string | null;
  paperclipIssueId: string;
  paperclipCompanyId: string;
  paperclipUserId: string;
  status: "active" | "completed" | "cancelled";
  createdAt: string;
  lastActivityAt: string;
}

export interface IdentityBinding {
  id: string;
  platform: Platform;
  platformUserId: string;
  paperclipUserId: string;
  paperclipCompanyId: string;
  boundAt: string;
}

export interface PaperclipIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  status: string;
  priority: string;
}

export interface PaperclipWebhookEvent {
  event: "issue.status_changed" | "issue.comment_added" | "issue.completed";
  issueId: string;
  companyId: string;
  payload: Record<string, unknown>;
  timestamp: string;
}
