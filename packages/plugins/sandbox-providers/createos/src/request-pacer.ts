import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// The public API allows 300 requests/minute per caller IP. Callback polling
// uses several requests per command. Keep this worker below that limit and
// share the budget across leases, command clients, and cleanup clients.
const accounts = new Map<string, { tail: Promise<void>; lastStarted: number }>();
const INTERVAL_MS = 300;

export async function waitForRequest(apiUrl: string, signal: AbortSignal): Promise<void> {
  const key = createHash("sha256").update(apiUrl).digest("hex");
  let account = accounts.get(key);
  if (!account) {
    account = { tail: Promise.resolve(), lastStarted: 0 };
    accounts.set(key, account);
  }
  const state = account;
  const turn = state.tail.catch(() => {}).then(async () => {
    signal.throwIfAborted();
    const remaining = state.lastStarted + INTERVAL_MS - Date.now();
    if (remaining > 0) await delay(remaining, undefined, { signal });
    signal.throwIfAborted();
    state.lastStarted = Date.now();
  });
  state.tail = turn;
  await turn;
}
