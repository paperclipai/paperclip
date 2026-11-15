export type InboxLiveEvent = Record<string, unknown> & { seq: number };

export type InboxLiveSnapshot = {
  seq: number;
  reset: boolean;
  events: InboxLiveEvent[];
};

/** A short in-memory difference log. The open page waits on it instead of polling Telegram. */
export function createInboxLive(limit = 40) {
  let seq = 0;
  const events: InboxLiveEvent[] = [];
  const waiters = new Set<() => void>();

  function snapshot(since: number): InboxLiveSnapshot {
    // since > seq means this process restarted under a client that still holds the old cursor.
    if (since > seq || (since > 0 && seq - since > limit)) return { seq, reset: true, events: [] };
    return { seq, reset: false, events: events.filter((item) => item.seq > since) };
  }

  return {
    push(event: Record<string, unknown>) {
      seq += 1;
      events.push({ ...event, seq });
      if (events.length > limit) events.splice(0, events.length - limit);
      for (const wake of [...waiters]) wake();
      return seq;
    },
    snapshot,
    wait(since: number, timeoutMs: number) {
      if (since > seq || seq > since) return Promise.resolve(snapshot(since));
      return new Promise<InboxLiveSnapshot>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          waiters.delete(wake);
          resolve(snapshot(since));
        };
        const wake = () => {
          if (seq > since) finish();
        };
        const timer = setTimeout(finish, timeoutMs);
        waiters.add(wake);
        if (seq > since) finish();
      });
    },
  };
}
