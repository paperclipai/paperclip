export interface EmailEnvelope {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
}
export type EmailDeliveryOutcome =
  | "queued"
  | "sent"
  | "delivered"
  | "failed"
  | "uncertain";
export interface EmailMessage extends EmailEnvelope {
  id: string;
  providerMessageId: string;
  direction: "inbound" | "outbound";
  text: string;
  fullText: string;
  commentId: string | null;
  attachmentIds: string[];
  timestamp: string;
  automatic: boolean;
}
export interface EmailEndpointSummary {
  id: string;
  companyId: string;
  connectionId: string;
  assignedAgentId: string;
  address: string | null;
  status: string;
  receiveMode: "websocket" | "webhook";
  lastError: string | null;
  lastSyncAt: string | null;
}
export interface EmailPublicationSummary {
  request?: import("../validators/email.js").EmailSendInput;
  createdAt?: string;
  id: string;
  issueId: string;
  conversationId: string;
  outcome: EmailDeliveryOutcome;
  error: string | null;
  providerMessageId: string | null;
}
export interface EmailThreadSummary {
  conversationId: string;
  issueId: string;
  endpoint: EmailEndpointSummary;
  subject: string;
  messages: EmailMessage[];
  publications: EmailPublicationSummary[];
}
/** A missing inbox is not proof of availability: AgentMail hides other accounts. */
export interface EmailAddressCheckResult {
  address: string;
  status: "taken" | "unknown";
}

/** Metadata only, filtered by provider and the current user's credential grants. */
export interface EmailCredentialOption {
  id: string;
  label: string;
  scope: "organization" | "pod" | "inbox" | "unavailable";
  inboxId: string | null;
  createdAt: string;
}
