export type PendingClaudeExchange = { value: string; base: string; secretId: string; epoch: number; version: number };
type Entry = { exchange: PendingClaudeExchange; stillWanted: () => Promise<boolean>; checkedAt: number; checking: boolean };

const pending = new Map<string, Entry>();
const key = (companyId: string, grantId: string) => `${companyId}:${grantId}`;
const RECHECK_MS = 30_000;

export const pendingClaudeExchanges = {
  get: (companyId: string, grantId: string) => pending.get(key(companyId, grantId))?.exchange,
  /** `stillWanted` says whether the grant of this pair can still use it. */
  set: (companyId: string, grantId: string, exchange: PendingClaudeExchange, stillWanted: () => Promise<boolean>) => {
    pending.set(key(companyId, grantId), { exchange, stillWanted, checkedAt: Date.now(), checking: false });
  },
  delete: (companyId: string, grantId: string) => { pending.delete(key(companyId, grantId)); },
  /**
   * True while a pair awaits its save. A pair is saved by the next credential
   * read of its grant. A grant that was revoked or removed gets no further
   * read, so each call also asks, at most every 30 seconds per pair, whether
   * the pair is still wanted, and drops it when it is not. That covers each
   * way a grant can end without a hook in the code that ends it.
   */
  blocksIdle: (now = Date.now()) => {
    for (const [id, entry] of pending) {
      if (entry.checking || now - entry.checkedAt < RECHECK_MS) continue;
      entry.checking = true;
      void entry.stillWanted().then(wanted => { if (!wanted && pending.get(id) === entry) pending.delete(id); }, () => undefined)
        .finally(() => { entry.checking = false; entry.checkedAt = Date.now(); });
    }
    return pending.size > 0;
  },
};

/**
 * By grant, the token that a renewal issued right after the provider refused
 * the token before it. If the provider refuses this one too while it has not
 * expired, a further renewal would not help: the login needs a new sign-in.
 * Kept in memory; after a restart the limit takes one more renewal to apply.
 */
const renewedAfterRejection = new Map<string, string>();
export const claudeRenewalAfterRejection = {
  is: (companyId: string, grantId: string, generation: string) => renewedAfterRejection.get(key(companyId, grantId)) === generation,
  set: (companyId: string, grantId: string, generation: string | null) => {
    if (generation) renewedAfterRejection.set(key(companyId, grantId), generation); else renewedAfterRejection.delete(key(companyId, grantId));
  },
};

export const hasPendingClaudeExchange = (companyId: string, grantId: string) => pending.has(key(companyId, grantId));
