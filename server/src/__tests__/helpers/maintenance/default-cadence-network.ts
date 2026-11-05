type GuardStats = { loaded: true; identity: string; sourceHash: string; preload: string; pid: number; ppid: number; unexpectedAttempts: string[]; peakPgSockets: number; remainingPgSockets: number };
type GuardState = { stats(): GuardStats; allowOrigin(origin: string): void; allowDatabase(url: string): void };
function current(): GuardState {
  const state = (globalThis as unknown as Record<symbol, GuardState | undefined>)[Symbol.for('paperclip.skill.default-cadence.prewire')];
  if (!state || state.stats().pid !== process.pid || state.stats().identity !== 'skill-default-cadence-guard-v1') {
    throw new Error('Default cadence requires the checked-in preload before module operations');
  }
  return state;
}
export function installDefaultCadenceNetwork() { current(); }
export function defaultCadenceNetwork() { const stats = current().stats(); return { ...stats, offhostAttempts: stats.unexpectedAttempts }; }
export function allowDefaultCadenceOrigin(origin: string) { current().allowOrigin(origin); }
export function allowDefaultCadenceDatabase(url: string) { current().allowDatabase(url); }
