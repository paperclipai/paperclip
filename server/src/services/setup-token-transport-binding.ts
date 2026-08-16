// The production transport binding for the Claude setup-token login session.
//
// The session service (`setup-token-session.ts`) drives the login flow over
// three injected components: a lease manager, a login-process factory, and a
// durable cleanup store. The router (`agents.ts`) accepts these components as an
// optional `setupTokenLogin` transport and falls back to a deferred, fail-closed
// default when a caller omits it. This module builds the production transport, so
// `app.ts` binds it one time at startup.
//
// The binding passes only the fixed command `CLAUDE_SETUP_TOKEN_COMMAND` to the
// login runner. It never accepts a command from a route, a request
// body, or an adapter configuration.
//
// The live pseudo-terminal opener is a separate seam. The Daytona sandbox
// provider runs as a plugin worker, so the server process does not hold the raw
// sandbox process. The real opener binds inside the worker; this module accepts
// it through `openLivePtySession`. A test injects a fake sandbox opener to drive
// the full session path. The live opener lands with the characterization
// test against a real sandbox.

import {
  SetupTokenSessionError,
  SETUP_TOKEN_START_FAILED,
  SETUP_TOKEN_STORAGE_FAILED,
  createDbSetupTokenCleanupStore,
  transitionSetupTokenSessionToStored,
  type SetupTokenCleanupStore,
  type SetupTokenLease,
  type SetupTokenLeaseManager,
  type SetupTokenLoginOutcome,
  type SetupTokenLoginProcess,
  type SetupTokenLoginProcessFactory,
  type SetupTokenSecretWriter,
  type SetupTokenSessionScope,
} from "./setup-token-session.js";
import { secretService } from "./secrets.js";
import type { environmentService } from "./environments.js";
import type { environmentRuntimeService } from "./environment-runtime.js";
import type { Db } from "@paperclipai/db";
import {
  createSetupTokenPtyTransport,
  type SetupTokenPtySession,
  type SetupTokenPtySessionOpener,
} from "@paperclipai/adapter-utils/setup-token-transport";
import {
  runSetupTokenLogin,
  CLAUDE_SETUP_TOKEN_COMMAND,
} from "@paperclipai/adapter-claude-local/server";

/**
 * The sandbox provider for one login session. It acquires a fresh sandbox lease
 * and returns the lease id plus the pseudo-terminal opener bound to that lease's
 * process. It releases the lease by id. The production provider wraps the
 * environment runtime. A test injects a fake provider.
 */
export interface SetupTokenSandboxProvider {
  /**
   * Acquires a fresh sandbox lease for a login session. It returns the lease id
   * and the pseudo-terminal opener bound to the acquired lease's process. It
   * throws a fail-closed error when it cannot acquire the lease or bind the
   * opener; the caller then returns the fixed start error.
   */
  acquire(input: {
    scope: SetupTokenSessionScope;
    deadline: number;
  }): Promise<{ leaseId: string; openPtySession: SetupTokenPtySessionOpener }>;
  /** Releases the lease by id. The service and the startup reaper call it. */
  release(leaseId: string): Promise<void>;
}

/** The dependencies the production transport binding needs. */
export interface SetupTokenLoginTransportDeps {
  /** The sandbox provider. The production provider wraps the environment runtime. */
  sandbox: SetupTokenSandboxProvider;
  /** The durable cleanup store. Defaults to the database-backed store over `db`. */
  store: SetupTokenCleanupStore;
  /**
   * The owner-bound secret writer. The binding forwards it to the router, so a
   * completed login stores the minted token in the secret store. When a caller
   * omits it, the router keeps its deferred, fail-closed writer.
   */
  completeCredential?: SetupTokenSecretWriter;
  /** A non-leaking status sink. It receives only fixed status lines. */
  log?: (line: string) => void;
}

/**
 * The production transport the router binds through `options.setupTokenLogin`. It
 * carries the live lease manager, the login-process factory, the durable cleanup
 * store, and the owner-bound secret writer. The router uses the writer for the
 * final secret write; when the binding omits it, the router keeps its deferred,
 * fail-closed writer.
 */
export interface SetupTokenLoginTransportBinding {
  factory: SetupTokenLoginProcessFactory;
  leases: SetupTokenLeaseManager;
  store: SetupTokenCleanupStore;
  completeCredential?: SetupTokenSecretWriter;
}

/**
 * The narrow secret-completion surface the production writer needs. The secrets
 * service exposes `completeClaudeOAuthUserSecret` as the owner-bound
 * compare-and-set for the Claude Code OAuth value. The writer forwards only the
 * scope owner, the session id, the mode, and the token to it.
 */
export interface SetupTokenSecretCompletion {
  completeClaudeOAuthUserSecret(
    companyId: string,
    ownerUserId: string,
    input: {
      sessionId: string;
      mode: "first_write" | "confirmed_rotation";
      value: string;
      expectedSecretId?: string | null;
      expectedLatestVersion?: number | null;
    },
    actor?: { userId?: string | null; agentId?: string | null },
  ): Promise<unknown>;
}

/** The owner-bound compare-and-set input the secrets service consumes. */
export type ClaudeOAuthWriteInput =
  | { sessionId: string; mode: "first_write"; value: string }
  | {
      sessionId: string;
      mode: "confirmed_rotation";
      value: string;
      expectedSecretId: string;
      expectedLatestVersion: number;
    };

/**
 * Maps the session writer input to the secrets service compare-and-set input. The
 * session scope selects the mode. A scope with no overwrite capture writes with
 * `mode: "first_write"`, so the login creates the first owner value only. A scope
 * that carries the confirmed-overwrite capture writes with
 * `mode: "confirmed_rotation"`, so the login rotates the stored value under the
 * captured `expectedSecretId` and `expectedLatestVersion`. The overwrite capture
 * carries no owner; the owner still comes from the scope.
 */
export function buildClaudeOAuthWriteInput(
  scope: SetupTokenSessionScope,
  sessionId: string,
  token: string,
): ClaudeOAuthWriteInput {
  const overwrite = scope.confirmedOverwrite ?? null;
  return overwrite
    ? {
        sessionId,
        mode: "confirmed_rotation",
        value: token,
        expectedSecretId: overwrite.expectedSecretId,
        expectedLatestVersion: overwrite.expectedLatestVersion,
      }
    : { sessionId, mode: "first_write", value: token };
}

/**
 * Builds the production atomic credential-claim writer for the login session. It
 * runs one control-plane transaction. Inside the transaction it first transitions
 * the exact durable session row to `stored` with a full-scope conditional update,
 * then writes or rotates the owner-bound secret on the same transaction handle.
 * The commit establishes the encrypted secret and the `stored` claim together, so
 * a crash between the two steps cannot leave a stored token with no valid claim.
 *
 * A zero-row transition means no claimable row exists in this scope. The writer
 * rolls back and rejects with the fixed, non-secret storage error, so the session
 * marks the login failed. A storage failure rejects and rolls back the whole
 * transaction, so neither the secret nor the claim commits. A concurrent change
 * fails the compare-and-set with the fixed stale conflict, so the write leaves no
 * partial state.
 *
 * It reads the company and the owner only from the immutable session scope, so a
 * request cannot redirect the write to another owner. It never logs
 * the token and never puts the token in an error; it lets the secrets service
 * error propagate unchanged, and the session maps a rejection to the fixed,
 * non-secret storage error.
 */
export function createSetupTokenSecretWriter(deps: {
  db: Db;
  /**
   * Builds the transaction-bound owner-bound completion. It defaults to
   * `secretService(tx)`, so the compare-and-set runs on the passed transaction
   * handle. A test injects a fake to force a storage failure after the transition.
   */
  completionForTx?: (tx: Db) => SetupTokenSecretCompletion;
}): SetupTokenSecretWriter {
  const completionForTx = deps.completionForTx ?? ((tx) => secretService(tx));
  return async ({ scope, sessionId, token }) => {
    const input = buildClaudeOAuthWriteInput(scope, sessionId, token);
    await deps.db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      // Step 1: lock and conditionally transition the exact durable row to
      // `stored`. The predicate matches the full scope, an allowed predecessor
      // state, an unexpired deadline, and an unconsumed claim. It requires exactly
      // one returned row.
      const transitioned = await transitionSetupTokenSessionToStored(txDb, {
        sessionId,
        companyId: scope.companyId,
        ownerUserId: scope.ownerUserId,
        adapterType: scope.adapterType,
        environmentId: scope.environmentId,
      });
      if (!transitioned) {
        // Zero-row result: roll back the whole transaction. The session then marks
        // the login failed and returns the fixed no-secret error.
        throw new SetupTokenSessionError(500, SETUP_TOKEN_STORAGE_FAILED);
      }
      // Step 2: write or rotate the secret on the same transaction handle. A
      // failure here rolls back the transition too, so the commit is all-or-none.
      await completionForTx(txDb).completeClaudeOAuthUserSecret(
        scope.companyId,
        scope.ownerUserId,
        input,
        { userId: scope.ownerUserId },
      );
    });
  };
}

/** The immutable scope key that correlates one acquire with one factory call. */
function scopeKey(scope: SetupTokenSessionScope): string {
  return [scope.companyId, scope.ownerUserId, scope.adapterType, scope.environmentId].join("\u0000");
}

/**
 * Builds the production setup-token login transport. The lease manager acquires a
 * sandbox lease through the injected provider and hands the pseudo-terminal
 * opener to the factory. The factory drives the login runner over the transport
 * and passes only the fixed command. The lease manager releases the lease on
 * every terminal path, so the service runs its cleanup against the durable store.
 */
export function buildSetupTokenLoginTransport(
  deps: SetupTokenLoginTransportDeps,
): SetupTokenLoginTransportBinding {
  // The binding fixes the login command. It never reads a command from a route, a
  // request body, an adapter configuration, or the dependency object, so a
  // runtime-supplied value cannot change the pseudo-terminal command.
  const command = CLAUDE_SETUP_TOKEN_COMMAND;
  const log = deps.log ?? (() => {});

  // The pseudo-terminal opener that one acquire hands to the next factory call.
  // The service calls `leases.acquire` and then `factory` in sequence for one
  // session, so a per-scope handoff correlates them. The per-owner session cap is
  // one, so one scope holds at most one live acquire.
  const pendingOpeners = new Map<string, { leaseId: string; openPtySession: SetupTokenPtySessionOpener }>();
  // The reverse map releases a handoff by lease id when the factory never
  // consumes it (a factory error path).
  const leaseScopeKeys = new Map<string, string>();

  const leases: SetupTokenLeaseManager = {
    async acquire({ scope, deadline }): Promise<SetupTokenLease> {
      const acquired = await deps.sandbox.acquire({ scope, deadline });
      const key = scopeKey(scope);
      pendingOpeners.set(key, acquired);
      leaseScopeKeys.set(acquired.leaseId, key);
      return { id: acquired.leaseId };
    },
    async release(lease): Promise<void> {
      dropHandoff(lease.id);
      await deps.sandbox.release(lease.id);
    },
    async releaseById(leaseId): Promise<void> {
      dropHandoff(leaseId);
      await deps.sandbox.release(leaseId);
    },
  };

  function dropHandoff(leaseId: string): void {
    const key = leaseScopeKeys.get(leaseId);
    if (key !== undefined) {
      const pending = pendingOpeners.get(key);
      if (pending && pending.leaseId === leaseId) pendingOpeners.delete(key);
      leaseScopeKeys.delete(leaseId);
    }
  }

  const factory: SetupTokenLoginProcessFactory = ({ scope, onPrompt, onCredential, timeoutMs, signal }): SetupTokenLoginProcess => {
    const key = scopeKey(scope);
    const pending = pendingOpeners.get(key);
    if (!pending) {
      // The lease manager did not hand off an opener for this scope. Fail closed.
      throw new SetupTokenSessionError(503, SETUP_TOKEN_START_FAILED);
    }
    pendingOpeners.delete(key);
    leaseScopeKeys.delete(pending.leaseId);

    const transport = createSetupTokenPtyTransport(pending.openPtySession);

    // Bridge the browser code. The service calls `submitCode` one time after the
    // single `awaiting_code` transition wins. The runner calls `provideCode` one
    // time after it surfaces the prompt. A resolved promise hands the code from
    // the service call to the runner call.
    let deliverCode: ((code: string) => void) | null = null;
    const codeReady = new Promise<string>((resolve, reject) => {
      deliverCode = resolve;
      // A cancel or an expiry aborts the signal. Reject the pending code, so the
      // runner stops waiting and ends the run.
      if (signal.aborted) {
        reject(new SetupTokenSessionError(499, SETUP_TOKEN_START_FAILED));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new SetupTokenSessionError(499, SETUP_TOKEN_START_FAILED)),
        { once: true },
      );
    });
    // The runner rejects the run when `provideCode` rejects. Consume the pending
    // rejection here too, so it never becomes an unhandled rejection when the
    // runner ends on the timeout or the signal before it reads the code.
    codeReady.catch(() => {});

    const done: Promise<SetupTokenLoginOutcome> = runSetupTokenLogin(transport, {
      command,
      timeoutMs,
      signal,
      onPrompt: (prompt) => onPrompt({ url: prompt.url }),
      provideCode: () => codeReady,
      onCredential: async (authBytes) => {
        // Forward the minted token to the owner-bound secret write. The service
        // holds the token only for this call and never stores it.
        await onCredential(authBytes.toString("utf8"));
      },
      log,
    }).then((result) => result.outcome);

    return {
      done,
      submitCode(code): void {
        deliverCode?.(code);
      },
      stop(): void {
        // Stop the direct child. The service releases the lease after this call.
        transport.stop();
      },
    };
  };

  return { factory, leases, store: deps.store, completeCredential: deps.completeCredential };
}

/** The dependencies the production sandbox provider needs. */
export interface ProductionSetupTokenSandboxProviderDeps {
  environments: Pick<ReturnType<typeof environmentService>, "getById" | "getLeaseById" | "releaseLease">;
  environmentRuntime: Pick<ReturnType<typeof environmentRuntimeService>, "acquireRunLease" | "getDriver">;
  /**
   * Opens the live pseudo-terminal for the acquired lease. The Daytona provider
   * runs as a plugin worker, so the real opener binds `sandbox.process` inside
   * the worker. When a caller omits it, the provider fails closed before it
   * acquires a lease, and the live path lands with the characterization
   * test.
   */
  openLivePtySession?: (input: {
    scope: SetupTokenSessionScope;
    environmentId: string;
    leaseId: string;
  }) => Promise<SetupTokenPtySessionOpener>;
  /** A non-leaking status sink. It receives only fixed status lines. */
  log?: (line: string) => void;
}

/**
 * Builds the production sandbox provider over the environment runtime. It
 * acquires a fresh sandbox lease for one login session, binds the live
 * pseudo-terminal opener to that lease, and releases the lease by id. It fails
 * closed for a local environment, an SSH environment, or a missing live opener.
 */
export function createProductionSetupTokenSandboxProvider(
  deps: ProductionSetupTokenSandboxProviderDeps,
): SetupTokenSandboxProvider {
  const log = deps.log ?? (() => {});
  // The acquired lease records, keyed by lease id. The provider releases a lease
  // through its driver. The startup reaper releases a lease by id after a
  // restart, when this map is empty; the provider then falls back to a direct
  // database release.
  const leaseRecords = new Map<
    string,
    Awaited<ReturnType<ReturnType<typeof environmentRuntimeService>["acquireRunLease"]>>
  >();

  const failClosed = (): never => {
    throw new SetupTokenSessionError(503, SETUP_TOKEN_START_FAILED);
  };

  return {
    async acquire({ scope, deadline }) {
      const environment = await deps.environments.getById(scope.environmentId);
      if (!environment) {
        log("[paperclip] Setup-token login: the selected environment is not found.");
        return failClosed();
      }
      if (environment.driver === "local" || environment.driver === "ssh") {
        // The login pseudo-terminal needs a sandbox. A local or an SSH
        // environment has no sandbox process to run the login command in.
        log("[paperclip] Setup-token login: the selected environment has no sandbox.");
        return failClosed();
      }
      if (!deps.openLivePtySession) {
        // The live sandbox pseudo-terminal opener is not bound yet. Fail closed
        // before the acquire, so the login holds no lease. The live opener lands
        // with the characterization test against a real sandbox.
        log(
          "[paperclip] Setup-token login: the live sandbox pseudo-terminal transport is not bound.",
        );
        return failClosed();
      }

      const leaseRecord = await deps.environmentRuntime.acquireRunLease({
        companyId: scope.companyId,
        environment,
        issueId: null,
        agentId: scope.targetAgentId ?? null,
        // A null heartbeat run and a null execution workspace disable lease
        // reuse, so the login session always runs in a fresh sandbox.
        heartbeatRunId: null,
        persistedExecutionWorkspace: null,
        adapterType: scope.adapterType,
        // Apply the active custom-image template, so the sandbox binds to the
        // trusted image and runtime identity.
        applyCustomImageTemplate: true,
        // Re-check the environment company binding inside the lease insert
        // transaction. The route guard ran earlier, so a managed reconciliation
        // can bind this sandbox to another company between the guard and this
        // acquire. The lease insert then rejects a foreign-company environment
        // with the 403 `environment_company_mismatch` and holds no lease.
        assertCompanyBinding: true,
        // Bound the lease expiry to the session deadline. The runtime records
        // the earlier of this deadline and the provider expiry on the lease row.
        requestedExpiresAt: new Date(deadline),
      });
      const leaseId = leaseRecord.lease.id;
      leaseRecords.set(leaseId, leaseRecord);

      // Enforce an independent, provider-backed expiry at or before the session
      // deadline. A crash or an outage stops the in-process cleanup, so the
      // lease row must carry a durable expiry that a lease reaper acts on. When
      // the acquired lease has no expiry, an invalid expiry, or an expiry after
      // the deadline, the server cannot guarantee the hard stop. Release the
      // remote lease and fail closed, so the login holds no lease and leaves no
      // durable cleanup row.
      const expiresAt = leaseRecord.lease.expiresAt;
      const expiresAtMs = expiresAt instanceof Date ? expiresAt.getTime() : Number.NaN;
      if (!Number.isFinite(expiresAtMs) || expiresAtMs > deadline) {
        await this.release(leaseId);
        log("[paperclip] Setup-token login: the acquired lease expiry does not bound the session deadline.");
        return failClosed();
      }

      try {
        const openPtySession = await deps.openLivePtySession({
          scope,
          environmentId: scope.environmentId,
          leaseId,
        });
        return { leaseId, openPtySession };
      } catch (err) {
        // The opener bind failed. Release the lease and fail closed, so the login
        // holds no lease.
        await this.release(leaseId);
        log("[paperclip] Setup-token login: the live pseudo-terminal bind failed.");
        void err;
        return failClosed();
      }
    },

    async release(leaseId) {
      const leaseRecord = leaseRecords.get(leaseId);
      if (leaseRecord) {
        leaseRecords.delete(leaseId);
        const driver = deps.environmentRuntime.getDriver(leaseRecord.environment.driver);
        if (driver) {
          await driver.releaseRunLease({
            environment: leaseRecord.environment,
            lease: leaseRecord.lease,
            status: "released",
          });
          return;
        }
      }
      // A restart cleared the in-memory record. Release the lease through the
      // provider driver, not only the database row, so the release tears down the
      // remote sandbox that holds the login state.
      await releaseLeaseById(leaseId);
    },
  };

  /**
   * Releases a lease by id after a restart, when the in-memory record is gone. It
   * resolves the stored lease and its environment, then releases the lease through
   * the provider driver, so the release tears down the remote sandbox and not only
   * the database row. It fails loud when it resolves a live lease that it cannot
   * release, so the reaper keeps the durable cleanup record and retries it. It
   * returns without an error only when the lease row is already gone, because then
   * no sandbox remains to release.
   */
  async function releaseLeaseById(leaseId: string): Promise<void> {
    const lease = await deps.environments.getLeaseById(leaseId);
    if (!lease) {
      // The lease row is already gone. No remote sandbox remains to release, so
      // the release is idempotent and the reaper may drop the cleanup record.
      return;
    }
    const environment = lease.environmentId
      ? await deps.environments.getById(lease.environmentId)
      : null;
    if (!environment) {
      // The lease resolves but its environment is gone, so no driver can tear down
      // the remote sandbox. Fail loud, so the reaper keeps the cleanup record.
      log("[paperclip] Setup-token login: the lease environment is not found for a restart release.");
      return failClosed();
    }
    const driver = deps.environmentRuntime.getDriver(environment.driver);
    if (!driver) {
      // No driver resolves the remote sandbox. Fail loud, so the reaper keeps the
      // cleanup record and retries the release.
      log("[paperclip] Setup-token login: no driver resolves the lease for a restart release.");
      return failClosed();
    }
    await driver.releaseRunLease({ environment, lease, status: "released" });
  }
}

/** Builds the durable, database-backed cleanup store for the production binding. */
export function createProductionSetupTokenCleanupStore(db: Db): SetupTokenCleanupStore {
  return createDbSetupTokenCleanupStore(db);
}

/**
 * The narrow plugin worker manager surface the live opener needs. The manager
 * owns the host route gate: it mints the host route identifier,
 * reserves one route per worker, drives the open, binds the worker session
 * identifier one time, routes output, and terminalizes the route.
 */
export interface SetupTokenPtyWorkerManagerLike {
  openSetupTokenPtySession(
    pluginId: string,
    input: {
      driverKey: string;
      companyId: string;
      environmentId: string;
      providerLeaseId: string;
      command: string;
    },
  ): Promise<SetupTokenPtySession>;
}

/** The narrow lease-lookup surface the live opener needs. */
export interface SetupTokenPtyLeaseLookup {
  getLeaseById(leaseId: string): Promise<
    | {
        providerLeaseId: string | null;
        metadata: Record<string, unknown> | null | undefined;
      }
    | null
  >;
}

/** The dependencies the worker-bound live pseudo-terminal opener needs. */
export interface WorkerBoundSetupTokenPtyOpenerDeps {
  /** The plugin worker manager that owns the host route gate. */
  workerManager: SetupTokenPtyWorkerManagerLike;
  /** The environment lease lookup that resolves the worker target for a lease. */
  environments: SetupTokenPtyLeaseLookup;
  /** A non-leaking status sink. It receives only fixed status lines. */
  log?: (line: string) => void;
}

function readLeaseMetaString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Builds the production `openLivePtySession`. It resolves the server lease to its
 * `providerLeaseId` and the sandbox worker plugin id, then returns an opener that
 * drives the worker through the manager route gate. The manager mints the host
 * route identifier and owns the route lifecycle. The opener fails closed when the
 * lease carries no sandbox worker binding.
 */
export function createWorkerBoundSetupTokenPtyOpener(
  deps: WorkerBoundSetupTokenPtyOpenerDeps,
): NonNullable<ProductionSetupTokenSandboxProviderDeps["openLivePtySession"]> {
  const log = deps.log ?? (() => {});
  return async ({ scope, environmentId, leaseId }) => {
    const lease = await deps.environments.getLeaseById(leaseId);
    const providerLeaseId =
      typeof lease?.providerLeaseId === "string" && lease.providerLeaseId.length > 0
        ? lease.providerLeaseId
        : null;
    const metadata =
      lease && typeof lease.metadata === "object" && lease.metadata !== null
        ? (lease.metadata as Record<string, unknown>)
        : {};
    const pluginId = readLeaseMetaString(metadata.pluginId);
    const driverKey =
      readLeaseMetaString(metadata.provider) ?? readLeaseMetaString(metadata.driver);
    if (!providerLeaseId || !pluginId || !driverKey) {
      log("[paperclip] Setup-token login: the lease carries no sandbox worker binding.");
      throw new SetupTokenSessionError(503, SETUP_TOKEN_START_FAILED);
    }
    return (command: string) =>
      deps.workerManager.openSetupTokenPtySession(pluginId, {
        driverKey,
        companyId: scope.companyId,
        environmentId,
        providerLeaseId,
        command,
      });
  };
}
