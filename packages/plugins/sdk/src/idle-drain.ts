export type PluginIdleHold = { ownerId: string; expiresAt: number };
export type PluginIdleWork = "none" | "present" | "unknown";

/** Worker admission stays closed for the exact bounded hold. A caller timeout
 * never releases a token: only the actual operation's settlement does. */
export function createPluginIdleDrain() {
  let active = 0;
  let preparing = 0;
  let hold: (PluginIdleHold & { controller: AbortController; ready: boolean }) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function release(ownerId: string): void {
    if (hold?.ownerId !== ownerId) return;
    const prior = hold;
    hold = null;
    clearTimeout(timer);
    prior.controller.abort();
  }

  function current() {
    if (hold && hold.expiresAt <= Date.now()) release(hold.ownerId);
    return hold;
  }

  function begin(): () => void {
    if (current()) throw new Error("Plugin is held for idle sleep");
    active++;
    let done = false;
    return () => { if (!done) { done = true; active--; } };
  }

  async function prepare(
    requested: PluginIdleHold,
    inspect?: (signal: AbortSignal) => Promise<PluginIdleWork>,
  ): Promise<PluginIdleWork> {
    if (!requested || typeof requested.ownerId !== "string" || !requested.ownerId ||
        !Number.isFinite(requested.expiresAt) || requested.expiresAt <= Date.now() ||
        requested.expiresAt > Date.now() + 300_000) return "unknown";
    if (!inspect) return "present";
    const prior = current();
    if (prior) return prior.ownerId === requested.ownerId && prior.expiresAt === requested.expiresAt && prior.ready
      ? "none" : "unknown";
    if (active !== 0 || preparing !== 0) return "present";
    const candidate = { ...requested, controller: new AbortController(), ready: false };
    hold = candidate;
    timer = setTimeout(() => release(candidate.ownerId), requested.expiresAt - Date.now());
    timer.unref?.();
    preparing++;
    try {
      const result = await inspect(candidate.controller.signal);
      if (current() !== candidate || active !== 0) return "unknown";
      if (result !== "none") {
        release(candidate.ownerId);
        return result === "present" ? "present" : "unknown";
      }
      candidate.ready = true;
      return "none";
    } catch {
      if (hold === candidate) release(candidate.ownerId);
      return "unknown";
    } finally {
      preparing--;
    }
  }

  return { begin, prepare, release, close: () => { if (hold) release(hold.ownerId); } };
}
