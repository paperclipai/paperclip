import { sql, lt } from "drizzle-orm";
import { oauthAuthorizationStates } from "@paperclipai/db/schema/oauth";
import { oauthLogger } from "./logger.js";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

export interface StateSweepDeps {
  // db: Drizzle handle. Loosely typed so this module does not pull the full
  // @paperclipai/db Db type — same convention as refresh.ts and the routes.
  db: any;
}

/**
 * Delete OAuth authorization states whose `expires_at` is more than 1 day in
 * the past. The 10-minute TTL is enforced at insert time; this sweep only
 * exists so abandoned rows do not accumulate forever. Errors are swallowed:
 * the next tick retries, and a stuck row never blocks production traffic.
 */
export async function runStateSweep(deps: StateSweepDeps): Promise<void> {
  try {
    await deps.db
      .delete(oauthAuthorizationStates)
      .where(
        lt(oauthAuthorizationStates.expiresAt, sql`now() - interval '1 day'`),
      );
  } catch (err) {
    oauthLogger.error(
      { err: { message: (err as Error).message } },
      "state sweep failed",
    );
  }
}

export function startStateSweeper(
  deps: StateSweepDeps,
): { stop: () => void } {
  let stopped = false;
  let timeout: NodeJS.Timeout;
  const tick = async () => {
    if (stopped) return;
    await runStateSweep(deps);
    if (!stopped) timeout = setTimeout(tick, SWEEP_INTERVAL_MS);
  };
  timeout = setTimeout(tick, SWEEP_INTERVAL_MS);
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timeout);
    },
  };
}
