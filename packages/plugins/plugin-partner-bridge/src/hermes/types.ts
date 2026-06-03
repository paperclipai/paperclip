export interface SendMessage {
  bridgeMsgId: string;
  channel: "telegram" | "email";
  to: string;
  subject?: string;
  body: string;
  attachments?: Array<{ name: string; mime: string; url?: string; base64?: string }>;
  approvalId?: string;
  linkId: string;
}
export interface InboundMessage {
  channel: "telegram" | "email";
  from: string;
  body: string;
  inReplyTo?: string;
  approvalDecision?: { approvalId: string; decision: "approve" | "reject"; by: string };
  linkId: string;
  secret: string; // shared secret echoed by Hermes for auth
}
export interface HermesConnector {
  send(msg: SendMessage): Promise<void>;
}
