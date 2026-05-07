export interface StateApi {
  get(scope: { scopeKind: "company"; scopeId: string; namespace: string; stateKey: string }): Promise<unknown>;
  set(scope: { scopeKind: "company"; scopeId: string; namespace: string; stateKey: string }, value: unknown): Promise<void>;
}

const NAMESPACE = "github";

function key(companyId: string, deliveryId: string): string { return `delivery:${companyId}:${deliveryId}`; }

/**
 * Idempotency layer 2: plugin state. Returns true if first time
 * we see this deliveryId for the given company, false on duplicate.
 */
export async function acquireDelivery(state: StateApi, companyId: string, deliveryId: string): Promise<boolean> {
  const scope = { scopeKind: "company" as const, scopeId: companyId, namespace: NAMESPACE, stateKey: key(companyId, deliveryId) };
  const existing = await state.get(scope);
  if (existing) return false;
  await state.set(scope, new Date().toISOString());
  return true;
}
