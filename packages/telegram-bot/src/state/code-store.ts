export type CodeEntry = {
  chatId: string;
  tgUserId?: string | null;
  tgUsername?: string | null;
  expiresAt: number;
};

export type CodeStoreOptions = {
  ttlMs?: number;
  now?: () => number;
  randomCode?: () => string;
};

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function generateSixDigitCode(): string {
  return Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0");
}

export class CodeStore {
  private readonly entries = new Map<string, CodeEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly randomCode: () => string;

  constructor(opts: CodeStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.randomCode = opts.randomCode ?? generateSixDigitCode;
  }

  issue(payload: { chatId: string; tgUserId?: string | null; tgUsername?: string | null }): {
    code: string;
    expiresAt: number;
  } {
    this.evictExpired();
    let code = this.randomCode();
    let attempts = 0;
    while (this.entries.has(code)) {
      if (attempts++ > 16) {
        throw new Error("Failed to generate unique login code");
      }
      code = this.randomCode();
    }
    const expiresAt = this.now() + this.ttlMs;
    this.entries.set(code, {
      chatId: payload.chatId,
      tgUserId: payload.tgUserId ?? null,
      tgUsername: payload.tgUsername ?? null,
      expiresAt,
    });
    return { code, expiresAt };
  }

  consume(code: string): CodeEntry | null {
    this.evictExpired();
    const entry = this.entries.get(code);
    if (!entry) return null;
    this.entries.delete(code);
    if (entry.expiresAt <= this.now()) return null;
    return entry;
  }

  size(): number {
    this.evictExpired();
    return this.entries.size;
  }

  private evictExpired(): void {
    const t = this.now();
    for (const [code, entry] of this.entries.entries()) {
      if (entry.expiresAt <= t) this.entries.delete(code);
    }
  }
}
