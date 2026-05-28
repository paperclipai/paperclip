import type { InboundPayload, ConversationMapping } from "./types.js";
import type { ConversationStore } from "./store.js";
import type { GatewayConfig } from "./config.js";

export type IntentResult =
  | { action: "create_issue"; title: string; description: string }
  | { action: "append_comment"; issueId: string; body: string }
  | { action: "unbound_user" };

const SPLIT_KEYWORDS = [
  "new task",
  "new issue",
  "another thing",
  "also,",
  "separately",
  "different topic",
  "新任务",
  "另外",
  "还有一件事",
];

export class IntentEngine {
  constructor(
    private readonly config: GatewayConfig,
    private readonly conversationStore: ConversationStore,
  ) {}

  async resolve(
    payload: InboundPayload,
    binding: { paperclipUserId: string; paperclipCompanyId: string } | null,
  ): Promise<IntentResult> {
    if (!binding) {
      return { action: "unbound_user" };
    }

    const text = payload.content.text || "";

    const existing = await this.conversationStore.findActiveMapping(
      payload.platform,
      payload.conversation.platformConversationId,
      payload.conversation.threadId,
    );

    if (existing) {
      if (this.isInactivityExpired(existing)) {
        return this.createNewIssueIntent(text);
      }

      if (this.detectsIntentSplit(text)) {
        return this.createNewIssueIntent(text);
      }

      return {
        action: "append_comment",
        issueId: existing.paperclipIssueId,
        body: text,
      };
    }

    return this.createNewIssueIntent(text);
  }

  private isInactivityExpired(mapping: ConversationMapping): boolean {
    const lastActivity = new Date(mapping.lastActivityAt).getTime();
    const now = Date.now();
    return now - lastActivity > this.config.inactivityTimeoutMs;
  }

  private detectsIntentSplit(text: string): boolean {
    const lower = text.toLowerCase();
    return SPLIT_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
  }

  private createNewIssueIntent(text: string): IntentResult {
    const title = this.extractTitle(text);
    return {
      action: "create_issue",
      title,
      description: text,
    };
  }

  private extractTitle(text: string): string {
    const firstLine = text.split("\n")[0] || text;
    if (firstLine.length <= 80) return firstLine;
    return firstLine.slice(0, 77) + "...";
  }
}
