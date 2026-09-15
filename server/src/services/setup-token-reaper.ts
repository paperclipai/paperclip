import type { Db } from "@paperclipai/db";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import { environmentService } from "./environments.js";
import {
  reapSetupTokenLeases,
  type SetupTokenCleanupStore,
  type SetupTokenLeaseManager,
  type SetupTokenReapResult,
} from "./setup-token-session.js";
import {
  createProductionSetupTokenCleanupStore,
  createProductionSetupTokenSandboxProvider,
} from "./setup-token-transport-binding.js";

// The restart-safe cleanup backstop for the Claude setup-token login flow.
//
// The in-process five-minute timer in the login-session service stays the
// primary control. This reaper is the backstop. It runs on server startup and on
// a fixed interval, so a sandbox lease survives a server restart and a release
// failure. The reaper reads the durable cleanup store and releases any lease
// whose session is terminal, past its deadline, or already consumed. It uses the
// same convention as the Codex device-login reaper, so both flows use one reaper
// convention.
//
// The reaper never records secret data. The durable cleanup record holds only
// ids, the deadline, the claim marker, and the state. It never holds a URL, a
// code, a token, or a raw process chunk.

/** The dependencies the standalone reaper needs. The reaper only reads reapable
 *  records and releases a lease by id, so it takes a store subset and a lease
 *  releaser, not the full session service. */
export interface SetupTokenReaperDeps {
  store: Pick<SetupTokenCleanupStore, "listReapable" | "remove">;
  leases: Pick<SetupTokenLeaseManager, "releaseById">;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Builds the standalone setup-token reaper. One sweep reaps every reapable
 * record: it releases the lease and clears the row. A failed release stays
 * retryable, so the next sweep retries it.
 */
export function createSetupTokenReaper(deps: SetupTokenReaperDeps) {
  const now = deps.now ?? Date.now;
  async function sweep(): Promise<SetupTokenReapResult> {
    return reapSetupTokenLeases({ store: deps.store, leases: deps.leases, log: deps.log }, now());
  }
  return { sweep };
}

export type SetupTokenReaper = ReturnType<typeof createSetupTokenReaper>;

// ---------------------------------------------------------------------------
// The production runtime binding.
// ---------------------------------------------------------------------------

export interface ProductionSetupTokenReaperDeps {
  db: Db;
  environmentRuntime: EnvironmentRuntimeService;
  log?: (line: string) => void;
}

/**
 * Builds the production setup-token reaper. It reads the durable cleanup store
 * and releases a lease by id through the production sandbox provider. The
 * provider release resolves the lease and its environment from the database and
 * tears down the remote sandbox through the driver, so the release frees the
 * remote sandbox and not only the database row. The reaper never acquires a
 * lease, so it binds no live pseudo-terminal opener.
 */
export function createProductionSetupTokenReaper(
  deps: ProductionSetupTokenReaperDeps,
): SetupTokenReaper {
  const environments = environmentService(deps.db);
  const sandbox = createProductionSetupTokenSandboxProvider({
    environments,
    environmentRuntime: deps.environmentRuntime,
    log: deps.log,
  });
  const store = createProductionSetupTokenCleanupStore(deps.db);
  return createSetupTokenReaper({
    store,
    leases: { releaseById: (leaseId) => sandbox.release(leaseId) },
    log: deps.log,
  });
}
