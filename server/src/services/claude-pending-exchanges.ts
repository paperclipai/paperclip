export type PendingClaudeExchange = { value: string; base: string; secretId: string; epoch: number; version: number };

const pending = new Map<string, PendingClaudeExchange>();
const key = (companyId: string, grantId: string) => `${companyId}:${grantId}`;

export const pendingClaudeExchanges = {
  get: (companyId: string, grantId: string) => pending.get(key(companyId, grantId)),
  set: (companyId: string, grantId: string, exchange: PendingClaudeExchange) => { pending.set(key(companyId, grantId), exchange); },
  delete: (companyId: string, grantId: string) => { pending.delete(key(companyId, grantId)); },
  any: () => pending.size > 0,
};

export const hasPendingClaudeExchange = (companyId: string, grantId: string) => pending.has(key(companyId, grantId));
