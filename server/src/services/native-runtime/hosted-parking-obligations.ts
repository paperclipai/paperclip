const pending = new Map<string, string>();

export function holdHostedParking(scope: string, runId: string): void { pending.set(scope, runId); }
export function clearHostedParkingScope(scope: string): void { pending.delete(scope); }
export function observeSettledHostedParking(runId: string): void {
  for (const [scope, owner] of pending) if (owner === runId) pending.delete(scope);
}
export function hasUnresolvedHostedParking(): boolean { return pending.size !== 0; }
