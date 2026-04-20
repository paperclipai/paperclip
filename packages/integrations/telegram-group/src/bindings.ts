import type { BindingScope, TelegramGroupBinding, TopicStrategy } from "./types.js";

export interface BindingStore {
  getActiveForScope(companyId: string, scope: BindingScope): Promise<TelegramGroupBinding | null>;
  getById(id: string): Promise<TelegramGroupBinding | null>;
  create(input: Omit<TelegramGroupBinding, "id" | "createdAt">): Promise<TelegramGroupBinding>;
  setStatus(id: string, status: TelegramGroupBinding["status"]): Promise<void>;
}

export interface CreateBindingRequest {
  companyId: string;
  scope: BindingScope;
  chatId: number;
  botTokenRef: string;
  adminUserIds: string[];
  topicStrategy?: TopicStrategy;
  redactInternalIds?: boolean;
  createdByUserId: string;
}

/**
 * Build a pending binding. Persistence + board-approval wiring live in the host platform;
 * this helper only validates the input shape.
 */
export function buildPendingBinding(req: CreateBindingRequest): Omit<TelegramGroupBinding, "id" | "createdAt"> {
  if (req.chatId === 0) throw new Error("chatId required");
  if (!req.botTokenRef) throw new Error("botTokenRef required");
  if (req.adminUserIds.length === 0) throw new Error("at least one adminUserId required");
  return {
    companyId: req.companyId,
    scope: req.scope,
    chatId: req.chatId,
    botTokenRef: req.botTokenRef,
    adminUserIds: req.adminUserIds,
    topicStrategy: req.topicStrategy ?? "root-issue-with-subtree",
    redactInternalIds: req.redactInternalIds ?? false,
    status: "pending",
    createdByUserId: req.createdByUserId,
  };
}
