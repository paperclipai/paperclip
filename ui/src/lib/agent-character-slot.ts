/** Bound live WebGL contexts; excess placements retain their static image. */
function createCharacterSlots(limit: number) {
  let owners: ReadonlySet<symbol> = new Set();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot() { return owners; },
    acquire(id: symbol) {
      if (owners.has(id)) return true;
      if (owners.size >= limit) return false;
      owners = new Set([...owners, id]); notify(); return true;
    },
    release(id: symbol) {
      if (!owners.has(id)) return;
      const next = new Set(owners); next.delete(id); owners = next; notify();
    },
  };
}
// Other app surfaces retain the single-hero budget. Org leaders share a bounded pool.
export const characterSlot = createCharacterSlots(1);
export const orgChartCharacterSlots = createCharacterSlots(8);
