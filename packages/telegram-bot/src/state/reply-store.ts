export type ReplyTarget = {
  issueId: string;
  approvalId?: string | null;
};

export type ReplyStoreOptions = {
  maxEntries?: number;
};

const DEFAULT_MAX = 5_000;

/**
 * Maps Telegram message ids of outbound notifications back to their source
 * issue. We use it to route Telegram replies back to the right Paperclip
 * issue thread.
 */
export class ReplyStore {
  private readonly map = new Map<string, ReplyTarget>();
  private readonly max: number;

  constructor(opts: ReplyStoreOptions = {}) {
    this.max = opts.maxEntries ?? DEFAULT_MAX;
  }

  private key(chatId: string | number, messageId: number): string {
    return `${chatId}:${messageId}`;
  }

  remember(chatId: string | number, messageId: number, target: ReplyTarget): void {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest) this.map.delete(oldest);
    }
    this.map.set(this.key(chatId, messageId), target);
  }

  lookup(chatId: string | number, messageId: number): ReplyTarget | null {
    return this.map.get(this.key(chatId, messageId)) ?? null;
  }

  size(): number {
    return this.map.size;
  }
}
