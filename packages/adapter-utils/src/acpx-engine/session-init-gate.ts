// Bounds how many cold ACP session establishments (`session/new` handshakes)
// run concurrently in this process. After a host-sleep/offline gap the
// scheduler releases a backlog of runs at once; each cold handshake races the
// acpx session-create timeout (60s), and an unbounded burst through a
// slot-limited provider proxy converts the whole backlog into
// `acpx_session_init_failed` (KEN-7183). Warm-handle reuse never takes a slot.
//
// The gate fails open: a waiter that exceeds the max wait proceeds without a
// slot (and never releases one), so a leaked or wedged slot degrades to
// today's ungated behavior instead of deadlocking run dispatch.

export const DEFAULT_MAX_CONCURRENT_SESSION_INITS = 4;
export const DEFAULT_SESSION_INIT_GATE_MAX_WAIT_MS = 10 * 60 * 1000;

export function resolveMaxConcurrentSessionInits(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env.ACPX_MAX_CONCURRENT_SESSION_INITS);
  if (!Number.isFinite(raw)) return DEFAULT_MAX_CONCURRENT_SESSION_INITS;
  // Explicit non-positive value disables the gate.
  if (raw <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor(raw);
}

export function resolveSessionInitGateMaxWaitMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env.ACPX_SESSION_INIT_GATE_MAX_WAIT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SESSION_INIT_GATE_MAX_WAIT_MS;
  return Math.floor(raw);
}

export interface SessionInitSlot {
  /** Milliseconds spent waiting for the slot before proceeding. */
  waitedMs: number;
  /** True when the max wait elapsed and the caller proceeded without a slot. */
  timedOut: boolean;
  /** Idempotent. Must be called exactly once when the handshake settles. */
  release: () => void;
}

interface Waiter {
  grant: () => void;
  expire: () => void;
}

export class SessionInitGate {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly limit: () => number,
    private readonly maxWaitMs: () => number,
  ) {}

  /** Number of handshakes currently holding a slot (test/introspection hook). */
  get activeCount(): number {
    return this.active;
  }

  /** Number of handshakes queued for a slot (test/introspection hook). */
  get waitingCount(): number {
    return this.waiters.length;
  }

  async acquire(): Promise<SessionInitSlot> {
    const limit = this.limit();
    if (this.waiters.length === 0 && this.active < limit) {
      this.active += 1;
      return { waitedMs: 0, timedOut: false, release: this.buildRelease(true) };
    }

    const startedAt = Date.now();
    return new Promise<SessionInitSlot>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = {
        grant: () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          this.active += 1;
          resolve({
            waitedMs: Date.now() - startedAt,
            timedOut: false,
            release: this.buildRelease(true),
          });
        },
        expire: () => {
          if (settled) return;
          settled = true;
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          // Fail open: proceed without holding a slot; release is a no-op so an
          // ungated handshake never decrements the active count below reality.
          resolve({
            waitedMs: Date.now() - startedAt,
            timedOut: true,
            release: this.buildRelease(false),
          });
        },
      };
      this.waiters.push(waiter);
      timer = setTimeout(waiter.expire, this.maxWaitMs());
      timer.unref?.();
    });
  }

  private buildRelease(heldSlot: boolean): () => void {
    let released = false;
    return () => {
      if (released || !heldSlot) return;
      released = true;
      this.active -= 1;
      // Re-read the limit on every grant so an env-driven limit change (or an
      // Infinity opt-out) takes effect without recreating the gate.
      while (this.waiters.length > 0 && this.active < this.limit()) {
        const next = this.waiters.shift();
        next?.grant();
      }
    };
  }
}

export const sharedSessionInitGate = new SessionInitGate(
  resolveMaxConcurrentSessionInits,
  resolveSessionInitGateMaxWaitMs,
);
