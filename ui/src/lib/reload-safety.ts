const active = new Set<symbol>();
const listeners = new Set<() => void>();

export function trackPendingWrite(): () => void {
  const token = Symbol();
  active.add(token);
  for (const listener of listeners) listener();
  return () => {
    if (!active.delete(token)) return;
    for (const listener of listeners) listener();
  };
}

export function hasPendingWrites(): boolean {
  return active.size > 0;
}

export function subscribePendingWrites(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
