// The app gets one live hero. Other placements retain their static image.
let owner: symbol | null = null;
const listeners = new Set<() => void>();
export const characterSlot = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot() { return owner; },
  acquire(id: symbol) { if (owner) return false; owner = id; for (const listener of listeners) listener(); return true; },
  release(id: symbol) { if (owner !== id) return; owner = null; for (const listener of listeners) listener(); },
};
