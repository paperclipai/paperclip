export interface ChatRoom {
  id: string;
  companyId: string;
  kind: "direct" | "boardroom";
  agentId: string | null;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatMessage {
  id: string;
  companyId: string;
  chatRoomId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  runId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatMessageAttachment {
  id: string;
  companyId: string;
  chatMessageId: string;
  assetId: string;
  provider: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  originalFilename: string | null;
  createdAt: Date;
}
