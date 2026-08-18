import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { adapterAuthSessions } from "@paperclipai/db";
import type {
  AdapterAuthSessionFailure,
  AdapterAuthSessionInternalStatus,
  AdapterAuthSessionOwnerResponse,
  AdapterAuthSessionResponse,
  AdapterAuthSessionStatus,
  AgentAdapterType,
  Environment,
  EnvironmentLease,
} from "@paperclipai/shared";
import { toPublicAdapterAuthSessionStatus } from "@paperclipai/shared";
import {
  CODEX_DEVICE_LOGIN_COMMAND,
  runDeviceLogin,
  type DeviceLoginOutcome,
  type DeviceLoginPrompt,
  type SandboxLoginDriver,
} from "@paperclipai/adapter-codex-local/server";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import { environmentService } from "./environments.js";

// The login-session service. It creates a login session, acquires a fresh
// sandbox lease, runs `codex login --device-auth` through the runner, and owns
// the sandbox delete. The service holds the company credential slot through the
// whole flow, so a second start for the same company and adapter cannot run at
// the same time.
//
// Security: the service records no secret data. An activity record carries no
// URL, no code, no credential, no account identifier, and no lease identifier.
// The service keeps the one-time login prompt in memory and returns it only
// through the owner read path.

/** The host timeout for the sandbox login command. It is exactly five minutes. */
export const CODEX_DEVICE_LOGIN_TIMEOUT_MS = 300_000;

/**
 * The lease-metadata key that tags a login sandbox lease with its session
 * identifier. The runtime stamps it at acquisition. The reaper reads it to find
 * an orphan lease that no live session references. It is not a public field.
 */
export const LOGIN_LEASE_SESSION_TAG_KEY = "adapterLoginSessionId";

/** The default Codex adapter type for a login session. */
export const CODEX_DEVICE_LOGIN_ADAPTER_TYPE: AgentAdapterType = "codex_local";

/**
 * The provider delete result the service observes on a terminal path. The
 * service treats both values as a confirmed delete. `not_found` is an idempotent
 * confirmation: the sandbox is already gone. A rejected delete (a thrown error)
 * is not a confirmed delete; the service records `cleanup_pending`.
 */
export type SandboxDeleteOutcome = "deleted" | "not_found";

export interface SandboxDeleteResult {
  outcome: SandboxDeleteOutcome;
}

/**
 * The sandbox lease for one login session. The runtime acquires it fresh with
 * reuse disabled and archive-on-release disabled, and tags the provider lease
 * with the session identifier. The service owns the delete seam and the release
 * seam; the runner never deletes the sandbox.
 */
export interface LoginSessionLease {
  /**
   * The provider lease identifier. The reaper resolves an unlinked sandbox
   * through it. The service persists it on the row, but it never puts it in an
   * activity record.
   */
  readonly providerLeaseId: string;
  /** The driver that runs the login command and reads the credential. */
  readonly driver: SandboxLoginDriver;
  /** The fixed, session-specific sandbox path of the credential file. */
  readonly authPath: string;
  /**
   * Delete the provider sandbox. The service owns this call. It awaits the
   * provider and returns the provider result. A rejection means the delete
   * failed, so the service records `cleanup_pending`.
   */
  deleteSandbox(): Promise<SandboxDeleteResult>;
  /**
   * Release the environment lease at once. The service calls this when a session
   * transition fails after acquisition, so no unlinked sandbox survives.
   */
  release(): Promise<void>;
}

export interface AcquireLoginLeaseInput {
  companyId: string;
  environmentId: string;
  adapterType: AgentAdapterType;
  sessionId: string;
  startedByUserId: string;
}

/** The sandbox side of a login session. A production runtime binds it to the
 *  environment runtime; a test binds it to a fake. */
export interface LoginSessionRuntime {
  acquireLoginLease(input: AcquireLoginLeaseInput): Promise<LoginSessionLease>;
}

/** The per-session context the promotion seam needs. The service knows the
 *  session, the company, and the adapter, so the promotion resolves the company
 *  scope and the sole-active-owner check for this exact session. */
export interface CredentialPromotionContext {
  sessionId: string;
  companyId: string;
  adapterType: AgentAdapterType;
}

/**
 * The mandatory promotion of the credential for a successful login. It runs
 * inside the internal `promoting` window on the success path. It validates the
 * credential, runs an independent readiness check, gates the write, and persists
 * the credential to the company credential slot. It must throw on any credential
 * that is empty, malformed, an API key, a non-subscription, oversized, unready,
 * or not the sole active owner. A throw turns the outcome into a failure, and
 * the service writes nothing and still deletes the sandbox.
 */
export interface CredentialPromotion {
  promote(authBytes: Buffer, context: CredentialPromotionContext): void | Promise<void>;
}

/** The redacted lifecycle phases. Each phase carries no secret data. */
export type LoginSessionActivityPhase =
  | "session_created"
  | "lease_acquired"
  | "lease_released"
  | "prompt_surfaced"
  | "promoting"
  | "sandbox_deleted"
  | "cleanup_pending"
  | "authenticated"
  | "failed"
  | "timed_out"
  | "cancelled";

/**
 * One redacted lifecycle record. It carries only non-secret fields: the session,
 * the company, the environment, the adapter, and the phase. It never carries a
 * URL, a code, a credential byte, an account identifier, or a lease identifier.
 */
export interface LoginSessionActivityEvent {
  sessionId: string;
  companyId: string;
  environmentId: string;
  adapterType: AgentAdapterType;
  phase: LoginSessionActivityPhase;
}

export type LoginSessionActivityRecorder = (event: LoginSessionActivityEvent) => void;

export interface StartCodexDeviceLoginInput {
  companyId: string;
  environmentId: string;
  adapterType: AgentAdapterType;
  /** The immutable owner principal. The service returns the prompt only to it. */
  startedByUserId: string;
  /**
   * The session time-to-live in seconds. It sets the expiring session intent at
   * creation. It defaults so the expiry matches the five-minute host timeout.
   */
  ttlSeconds?: number;
  /** An optional cancellation signal that aborts the login run. */
  signal?: AbortSignal;
}

export interface CodexDeviceLoginOutcome {
  sessionId: string;
  /** The resolved public terminal status. */
  status: AdapterAuthSessionStatus;
  /**
   * True when the provider delete failed and the row holds the durable internal
   * `cleanup_pending` state.
   */
  cleanupPending: boolean;
  /** True when the service observed a provider delete on this terminal path. */
  sandboxDeleteObserved: boolean;
}

export interface StartCodexDeviceLoginResult {
  /** The initial public response after the insert and the acquisition. */
  session: AdapterAuthSessionResponse;
  /**
   * Resolves when the terminal handling ends. The terminal handling runs the
   * readiness check, the promotion write, and the cleanup-state handoff, and
   * then it records the terminal status.
   */
  completed: Promise<CodexDeviceLoginOutcome>;
}

/** The service throws this when the active company credential slot is taken. */
export class AdapterAuthSessionConflictError extends Error {
  readonly statusCode = 409;
  constructor(
    message = "An adapter login session is already active for this company and adapter.",
  ) {
    super(message);
    this.name = "AdapterAuthSessionConflictError";
  }
}

// ---------------------------------------------------------------------------
// The durable session store.
// ---------------------------------------------------------------------------

export interface AdapterAuthSessionRow {
  id: string;
  companyId: string;
  environmentId: string;
  adapterType: AgentAdapterType;
  startedByUserId: string;
  providerLeaseId: string | null;
  status: AdapterAuthSessionInternalStatus;
  expiresAt: Date | null;
  /** The promotion claim deadline. A future value means the claim is live, so
   *  the reaper leaves the `promoting` row alone. A null or past value means no
   *  live claim. */
  promotionExpiresAt: Date | null;
  finishedAt: Date | null;
  failureReason: string | null;
}

export interface InsertAdapterAuthSessionInput {
  id: string;
  companyId: string;
  environmentId: string;
  adapterType: AgentAdapterType;
  startedByUserId: string;
  expiresAt: Date;
  at: Date;
}

export interface SetAdapterAuthSessionStatusInput {
  sessionId: string;
  status: AdapterAuthSessionInternalStatus;
  at: Date;
  failureReason?: string | null;
  finishedAt?: Date | null;
  /**
   * Set or clear the promotion claim deadline. `undefined` leaves the column
   * unchanged. A `Date` sets a live claim; `null` clears the claim.
   */
  promotionExpiresAt?: Date | null;
}

/**
 * The input for a conditional status write. The write updates the row only when
 * the current status is one of `expectedStatuses`. The method reports whether it
 * changed a row, so the caller can detect a lost race.
 */
export interface CompareAndSetAdapterAuthSessionStatusInput
  extends SetAdapterAuthSessionStatusInput {
  /** The write succeeds only when the current status is one of these. */
  expectedStatuses: readonly AdapterAuthSessionInternalStatus[];
}

/** The store for the login-session rows. The service inserts, transitions, and
 *  reads through it. The insert maps the active-slot conflict to a `409`. */
export interface AdapterAuthSessionStore {
  insert(input: InsertAdapterAuthSessionInput): Promise<void>;
  recordLeaseAcquired(input: {
    sessionId: string;
    providerLeaseId: string;
    at: Date;
  }): Promise<void>;
  setStatus(input: SetAdapterAuthSessionStatusInput): Promise<void>;
  /** A conditional status write. It returns true only when it changed one row. */
  compareAndSetStatus(input: CompareAndSetAdapterAuthSessionStatusInput): Promise<boolean>;
  get(sessionId: string): Promise<AdapterAuthSessionRow | null>;
  /** Run `fn` while the process holds the promotion critical-section lock for the
   *  company and adapter. The reaper reclaims a stale `promoting` row inside this
   *  lock, so a reclaim never interleaves with a live credential write. */
  withCompanyAdapterPromotionLock<T>(
    companyId: string,
    adapterType: AgentAdapterType,
    fn: () => Promise<T>,
  ): Promise<T>;
}

/** Build the advisory-lock key for the promotion critical section. The key is
 *  company-scoped and adapter-scoped, so two different company slots never
 *  contend. The credential-promotion path and the reaper reclaim both derive the
 *  key from this function, so they take the exact same lock. */
export function adapterLoginPromotionLockKey(
  companyId: string,
  adapterType: AgentAdapterType,
): string {
  return `paperclip:adapter-login-promotion:${companyId}:${adapterType}`;
}

/**
 * Run `fn` inside the promotion critical section for one company and adapter.
 *
 * The function opens a database transaction and takes a transaction-scoped
 * PostgreSQL advisory lock. The lock serializes the credential-promotion path
 * against the reaper reclaim, so a reaper never releases the company slot while a
 * credential write runs, and a stale promotion never writes after the reaper
 * reclaims the slot. The transaction holds the lock through `fn`, so the caller
 * runs the ownership check and the credential write in one mutually-exclusive
 * section. A process crash drops the connection and releases the lock, so a
 * stalled owner never blocks recovery.
 */
export async function withAdapterLoginPromotionLock<T>(
  db: Db,
  companyId: string,
  adapterType: AgentAdapterType,
  fn: () => Promise<T>,
): Promise<T> {
  const key = adapterLoginPromotionLockKey(companyId, adapterType);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    return fn();
  });
}

/** The three active statuses. A row in one of these states holds the company
 *  credential slot, so it is non-terminal and can time out. */
export const ADAPTER_AUTH_ACTIVE_STATUSES: readonly AdapterAuthSessionInternalStatus[] = [
  "starting",
  "waiting_for_user",
  "promoting",
];

/**
 * The promotion claim window. The service sets `promotion_expires_at` to this
 * far in the future when it moves a row to `promoting`. While the deadline is in
 * the future, the reaper leaves the row alone, so the credential write finishes
 * without a slot release. The window is far longer than the filesystem writes,
 * so a healthy promotion always finishes first. A crashed promotion lets the
 * deadline pass, so the reaper reclaims the stalled row on a later sweep.
 */
export const ADAPTER_AUTH_PROMOTION_CLAIM_MS = 60_000;

/**
 * The read side the reaper needs. The reaper sweeps three sets: the expired
 * non-terminal sessions, the terminal `cleanup_pending` sessions, and the
 * provider leases that no live session references. The db-backed store
 * implements this next to {@link AdapterAuthSessionStore}.
 */
export interface AdapterAuthReaperStore {
  /** The non-terminal sessions with an `expiresAt` at or before `now`. */
  listExpiredActiveSessions(now: Date): Promise<AdapterAuthSessionRow[]>;
  /** The terminal sessions left in the internal `cleanup_pending` state. */
  listCleanupPendingSessions(): Promise<AdapterAuthSessionRow[]>;
  /** Every provider lease reference a session row still holds. */
  listLeaseReferences(): Promise<string[]>;
  setStatus(input: SetAdapterAuthSessionStatusInput): Promise<void>;
  /** A conditional status write. It returns true only when it changed one row. */
  compareAndSetStatus(input: CompareAndSetAdapterAuthSessionStatusInput): Promise<boolean>;
  get(sessionId: string): Promise<AdapterAuthSessionRow | null>;
  /** Run `fn` while the process holds the promotion critical-section lock for the
   *  company and adapter. The reaper reclaims a stale `promoting` row inside this
   *  lock, so a reclaim never interleaves with a live credential write. */
  withCompanyAdapterPromotionLock<T>(
    companyId: string,
    adapterType: AgentAdapterType,
    fn: () => Promise<T>,
  ): Promise<T>;
}

// The Postgres unique-violation code. The database driver sets it on the error,
// and the query builder can wrap that error, so read the code from the error and
// from its cause chain.
const POSTGRES_UNIQUE_VIOLATION_CODE = "23505";

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if (
      typeof current === "object" &&
      (current as { code?: unknown }).code === POSTGRES_UNIQUE_VIOLATION_CODE
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function toRow(row: typeof adapterAuthSessions.$inferSelect): AdapterAuthSessionRow {
  return {
    id: row.id,
    companyId: row.companyId,
    environmentId: row.environmentId,
    adapterType: row.adapterType,
    startedByUserId: row.startedByUserId,
    providerLeaseId: row.providerLeaseId ?? null,
    status: row.status,
    expiresAt: row.expiresAt ?? null,
    promotionExpiresAt: row.promotionExpiresAt ?? null,
    finishedAt: row.finishedAt ?? null,
    failureReason: row.failureReason ?? null,
  };
}

/** Build the `update` patch for a status write. An omitted optional field stays
 *  unchanged; a present field writes its value, including a `null` clear. */
function buildStatusPatch(input: SetAdapterAuthSessionStatusInput) {
  return {
    status: input.status,
    updatedAt: input.at,
    ...(input.failureReason !== undefined ? { failureReason: input.failureReason } : {}),
    ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
    ...(input.promotionExpiresAt !== undefined
      ? { promotionExpiresAt: input.promotionExpiresAt }
      : {}),
  };
}

/** Build the Postgres-backed store. The partial unique index on the active
 *  statuses serializes the company credential slot; the insert maps its conflict
 *  to {@link AdapterAuthSessionConflictError}. */
export function createDbAdapterAuthSessionStore(
  db: Db,
): AdapterAuthSessionStore & AdapterAuthReaperStore {
  return {
    async insert(input) {
      try {
        await db.insert(adapterAuthSessions).values({
          id: input.id,
          companyId: input.companyId,
          environmentId: input.environmentId,
          adapterType: input.adapterType,
          startedByUserId: input.startedByUserId,
          status: "starting",
          expiresAt: input.expiresAt,
          createdAt: input.at,
          updatedAt: input.at,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AdapterAuthSessionConflictError();
        }
        throw error;
      }
    },
    async recordLeaseAcquired(input) {
      await db
        .update(adapterAuthSessions)
        .set({ providerLeaseId: input.providerLeaseId, updatedAt: input.at })
        .where(eq(adapterAuthSessions.id, input.sessionId));
    },
    async setStatus(input) {
      await db
        .update(adapterAuthSessions)
        .set(buildStatusPatch(input))
        .where(eq(adapterAuthSessions.id, input.sessionId));
    },
    async compareAndSetStatus(input) {
      // The conditional write. It changes the row only when the current status is
      // one of `expectedStatuses`. The `returning` clause reports the changed
      // rows, so a lost race returns an empty array. The active-slot partial
      // unique index still serializes the company slot on the write.
      const changed = await db
        .update(adapterAuthSessions)
        .set(buildStatusPatch(input))
        .where(
          and(
            eq(adapterAuthSessions.id, input.sessionId),
            inArray(adapterAuthSessions.status, [...input.expectedStatuses]),
          ),
        )
        .returning({ id: adapterAuthSessions.id });
      return changed.length > 0;
    },
    async get(sessionId) {
      const rows = await db
        .select()
        .from(adapterAuthSessions)
        .where(eq(adapterAuthSessions.id, sessionId))
        .limit(1);
      const row = rows[0];
      return row ? toRow(row) : null;
    },
    async listExpiredActiveSessions(nowAt) {
      // The partial index on the active statuses and the index on `expiresAt`
      // both support this scan. The scan is bounded by the active-status set, so
      // it never reads a terminal row. The scan skips a `promoting` row that
      // still holds a live promotion claim, so the reaper never terminates a row
      // whose credential write is in progress. It reclaims a `promoting` row only
      // after the claim deadline passes.
      const rows = await db
        .select()
        .from(adapterAuthSessions)
        .where(
          and(
            inArray(adapterAuthSessions.status, [...ADAPTER_AUTH_ACTIVE_STATUSES]),
            isNotNull(adapterAuthSessions.expiresAt),
            lte(adapterAuthSessions.expiresAt, nowAt),
            or(
              ne(adapterAuthSessions.status, "promoting"),
              isNull(adapterAuthSessions.promotionExpiresAt),
              lte(adapterAuthSessions.promotionExpiresAt, nowAt),
            ),
          ),
        );
      return rows.map(toRow);
    },
    async listCleanupPendingSessions() {
      const rows = await db
        .select()
        .from(adapterAuthSessions)
        .where(eq(adapterAuthSessions.status, "cleanup_pending"));
      return rows.map(toRow);
    },
    async listLeaseReferences() {
      const rows = await db
        .select({ providerLeaseId: adapterAuthSessions.providerLeaseId })
        .from(adapterAuthSessions)
        .where(isNotNull(adapterAuthSessions.providerLeaseId));
      return rows
        .map((row) => row.providerLeaseId)
        .filter((value): value is string => value != null);
    },
    async withCompanyAdapterPromotionLock(companyId, adapterType, fn) {
      return withAdapterLoginPromotionLock(db, companyId, adapterType, fn);
    },
  };
}

// ---------------------------------------------------------------------------
// The pending-terminal encoding for a `cleanup_pending` row.
// ---------------------------------------------------------------------------

// A delete failure records the durable internal `cleanup_pending` state before
// the terminal outcome. The row keeps the resolved terminal status and the
// failure code in the `failure_reason` column, so a reaper resolves the terminal
// status after it finishes the delete. The encoding is `<terminal>` or
// `<terminal>|<reason>`. The `cleanup_pending` state is internal, so this column
// value never reaches a public response before the reaper rewrites it.
function encodePendingTerminal(
  terminal: AdapterAuthSessionStatus,
  reason: string | null,
): string {
  return reason ? `${terminal}|${reason}` : terminal;
}

export function decodePendingTerminal(value: string | null): {
  terminal: AdapterAuthSessionStatus;
  reason: string | null;
} {
  if (!value) {
    return { terminal: "failed", reason: null };
  }
  const separatorIndex = value.indexOf("|");
  if (separatorIndex === -1) {
    return { terminal: value as AdapterAuthSessionStatus, reason: null };
  }
  return {
    terminal: value.slice(0, separatorIndex) as AdapterAuthSessionStatus,
    reason: value.slice(separatorIndex + 1) || null,
  };
}

// ---------------------------------------------------------------------------
// The shared terminal-cleanup transition. The timer path and the reaper path
// both delete the sandbox and then choose one durable write. This keeps one term
// for a confirmed delete and one encoding for a failed delete.
// ---------------------------------------------------------------------------

/**
 * A confirmed delete. The service treats `deleted` and `not_found` as confirmed.
 * `not_found` is the idempotent confirmation: the sandbox is already gone, so a
 * repeated delete is safe. A rejected delete (a thrown error) is not confirmed.
 */
export function isConfirmedDelete(result: SandboxDeleteResult): boolean {
  return result.outcome === "deleted" || result.outcome === "not_found";
}

/** The result of one sandbox delete attempt. */
export interface SandboxDeleteObservation {
  /** True when the delete seam ran, whether or not it confirmed. */
  observed: boolean;
  /** True when the provider confirmed the delete. */
  confirmed: boolean;
}

/**
 * Run the delete seam once and observe the result. A rejection is an observed
 * but unconfirmed delete; the caller records `cleanup_pending`.
 */
export async function observeSandboxDelete(
  deleteSandbox: () => Promise<SandboxDeleteResult>,
): Promise<SandboxDeleteObservation> {
  try {
    const result = await deleteSandbox();
    return { observed: true, confirmed: isConfirmedDelete(result) };
  } catch {
    return { observed: true, confirmed: false };
  }
}

/** One durable status write for a terminal cleanup. */
export interface TerminalCleanupWrite {
  status: AdapterAuthSessionInternalStatus;
  failureReason: string | null;
}

/**
 * Choose the durable write after a delete attempt. A confirmed delete writes the
 * terminal public status. An unconfirmed delete writes the internal
 * `cleanup_pending` state that keeps the terminal for a later reaper retry.
 */
export function terminalCleanupWrite(
  confirmed: boolean,
  terminal: AdapterAuthSessionStatus,
  reason: string | null,
): TerminalCleanupWrite {
  return confirmed
    ? { status: terminal, failureReason: reason }
    : { status: "cleanup_pending", failureReason: encodePendingTerminal(terminal, reason) };
}

// ---------------------------------------------------------------------------
// The service.
// ---------------------------------------------------------------------------

export interface CodexDeviceLoginServiceDeps {
  store: AdapterAuthSessionStore;
  runtime: LoginSessionRuntime;
  /** The mandatory credential promotion. A successful login authenticates only
   *  after this promotion resolves; a throw fails the session and writes nothing. */
  promotion: CredentialPromotion;
  recordActivity?: LoginSessionActivityRecorder;
  now?: () => Date;
}

export function createCodexDeviceLoginService(deps: CodexDeviceLoginServiceDeps) {
  const { store, runtime, promotion } = deps;
  const now = deps.now ?? (() => new Date());
  const recordActivity = deps.recordActivity ?? (() => {});

  // The one-time prompt per session. The service holds it in memory only. The
  // owner read path returns it; it never reaches the durable row or an activity
  // record.
  const promptsBySession = new Map<string, DeviceLoginPrompt>();

  async function start(
    input: StartCodexDeviceLoginInput,
  ): Promise<StartCodexDeviceLoginResult> {
    const sessionId = randomUUID();
    const startedAt = now();
    const ttlSeconds = input.ttlSeconds ?? CODEX_DEVICE_LOGIN_TIMEOUT_MS / 1000;
    const expiresAt = new Date(startedAt.getTime() + ttlSeconds * 1000);
    const base = {
      sessionId,
      companyId: input.companyId,
      environmentId: input.environmentId,
      adapterType: input.adapterType,
    };
    const activity = (phase: LoginSessionActivityPhase) =>
      recordActivity({ ...base, phase });

    // Insert the session row and the expiring session intent before the
    // acquisition. The owner and the expiry persist at creation. A conflict on
    // the active company-adapter slot throws a 409, and the service never
    // acquires a lease for a losing start.
    await store.insert({
      id: sessionId,
      companyId: input.companyId,
      environmentId: input.environmentId,
      adapterType: input.adapterType,
      startedByUserId: input.startedByUserId,
      expiresAt,
      at: startedAt,
    });
    activity("session_created");

    // Acquire a fresh lease. The runtime disables reuse and archive-on-release,
    // applies the active custom-image template, binds the sandbox to a trusted
    // image and runtime identity, and tags the provider lease with the session
    // identifier.
    let lease: LoginSessionLease;
    try {
      lease = await runtime.acquireLoginLease({
        companyId: input.companyId,
        environmentId: input.environmentId,
        adapterType: input.adapterType,
        sessionId,
        startedByUserId: input.startedByUserId,
      });
    } catch (error) {
      // The acquisition failed, so no lease exists to release. Free the slot: a
      // `starting` row would hold it forever. Mark the row failed, then rethrow.
      await store
        .setStatus({
          sessionId,
          status: "failed",
          at: now(),
          failureReason: "lease_acquire_failed",
          finishedAt: now(),
        })
        .catch(() => {});
      activity("failed");
      throw error;
    }

    // Record the lease acquisition. This is a transition after the acquisition.
    // If it fails, release the lease at once, so no unlinked sandbox survives.
    try {
      await store.recordLeaseAcquired({
        sessionId,
        providerLeaseId: lease.providerLeaseId,
        at: now(),
      });
    } catch (error) {
      await lease.release();
      activity("lease_released");
      await store
        .setStatus({
          sessionId,
          status: "failed",
          at: now(),
          failureReason: "session_transition_failed",
          finishedAt: now(),
        })
        .catch(() => {});
      activity("failed");
      throw error;
    }
    activity("lease_acquired");

    const session: AdapterAuthSessionResponse = {
      sessionId,
      environmentId: input.environmentId,
      status: "starting",
      expiresAt: expiresAt.toISOString(),
      failure: null,
    };

    const completed = runLogin({ input, sessionId, lease, base, activity });
    return { session, completed };
  }

  async function runLogin(ctx: {
    input: StartCodexDeviceLoginInput;
    sessionId: string;
    lease: LoginSessionLease;
    base: Omit<LoginSessionActivityEvent, "phase">;
    activity: (phase: LoginSessionActivityPhase) => void;
  }): Promise<CodexDeviceLoginOutcome> {
    const { input, sessionId, lease, activity } = ctx;

    // Serialize every status write for this session, so a late write from a
    // callback never overwrites a later transition. Each write runs after the
    // previous one settles, and a failed write never blocks the next one.
    let statusTail: Promise<unknown> = Promise.resolve();

    // The serialized conditional status write. It runs after the previous write
    // and changes the row only when the current status is one of
    // `expectedStatuses`. It returns whether it changed the row, so a caller can
    // detect a lost race with the reaper. A failed write never blocks the next.
    function conditionalTransition(
      expectedStatuses: readonly AdapterAuthSessionInternalStatus[],
      status: AdapterAuthSessionInternalStatus,
      patch?: {
        failureReason?: string | null;
        finishedAt?: Date | null;
        promotionExpiresAt?: Date | null;
      },
    ): Promise<boolean> {
      const run = statusTail.then(
        () =>
          store.compareAndSetStatus({ sessionId, expectedStatuses, status, at: now(), ...patch }),
        () =>
          store.compareAndSetStatus({ sessionId, expectedStatuses, status, at: now(), ...patch }),
      );
      statusTail = run.then(
        () => {},
        () => {},
      );
      return run;
    }

    let authBytes: Buffer | null = null;
    let outcome: DeviceLoginOutcome;
    try {
      const result = await runDeviceLogin(lease.driver, {
        command: CODEX_DEVICE_LOGIN_COMMAND,
        timeoutMs: CODEX_DEVICE_LOGIN_TIMEOUT_MS,
        signal: input.signal,
        authPath: lease.authPath,
        onPrompt: (prompt) => {
          // Move the row to the active `waiting_for_user` state with a
          // conditional write from `starting`. Retain and surface the prompt only
          // when the write wins. A lost write means the reaper already reclaimed
          // the expired row, so the service never resurrects a reaped session and
          // never surfaces a prompt for a slot it no longer owns.
          void conditionalTransition(["starting"], "waiting_for_user").then((won) => {
            if (!won) return;
            promptsBySession.set(sessionId, prompt);
            activity("prompt_surfaced");
          });
        },
        onCredential: (bytes) => {
          authBytes = bytes;
        },
      });
      outcome = result.outcome;
    } catch {
      // The runner only throws on a driver error, and it never leaks the stream.
      // Treat a driver error as a login failure.
      outcome = "failure";
    }

    if (outcome === "success") {
      // Claim the slot for the mandatory promotion. The claim is a conditional
      // write from a pre-promotion active status to `promoting`, and it sets the
      // promotion deadline. While the deadline is in the future, the reaper never
      // terminates the row or releases the company slot, so the credential write
      // finishes without a race. A lost claim means the reaper already reclaimed
      // an expired row; the service then promotes nothing and authenticates
      // nothing.
      const claimDeadline = new Date(now().getTime() + ADAPTER_AUTH_PROMOTION_CLAIM_MS);
      const claimed = await conditionalTransition(["starting", "waiting_for_user"], "promoting", {
        promotionExpiresAt: claimDeadline,
      });
      if (!claimed) {
        return await abandonAfterLostClaim({ sessionId, lease, activity });
      }
      activity("promoting");
      try {
        // Fail closed. A success outcome must carry a non-empty credential, and
        // the mandatory promotion must accept it. Absent or empty bytes, or a
        // rejected promotion, never authenticate.
        // The `onCredential` callback assigns `authBytes`, so read it as the
        // declared union. The cast keeps the null case, which the guard rejects.
        const credential = authBytes as Buffer | null;
        if (!credential || credential.length === 0) {
          throw new Error("missing_credential");
        }
        await promotion.promote(credential, {
          sessionId,
          companyId: input.companyId,
          adapterType: input.adapterType,
        });
      } catch {
        // The promotion failed. The login did not finish, so fall through to the
        // failed terminal. The service writes nothing and still deletes the
        // sandbox. The terminal write is conditional on the held claim.
        return await terminate({
          sessionId,
          lease,
          terminal: "failed",
          reason: "promotion_failed",
          expectedStatuses: ["promoting"],
          conditionalTransition,
          activity,
        });
      }
      // Publish `authenticated` only when the final conditional write still finds
      // the held claim. A lost write means the claim expired and the reaper
      // reclaimed the row, so the service never publishes `authenticated`.
      return await terminate({
        sessionId,
        lease,
        terminal: "authenticated",
        reason: null,
        expectedStatuses: ["promoting"],
        conditionalTransition,
        activity,
      });
    }

    const terminal: AdapterAuthSessionStatus =
      outcome === "timeout"
        ? "timed_out"
        : outcome === "cancelled"
          ? "cancelled"
          : "failed";
    const reason = terminal === "failed" ? "login_command_failed" : null;
    // The pre-promotion terminal writes race the reaper at the expiry boundary.
    // The conditional write on the active pre-promotion statuses lets the reaper
    // win without a clobber; the service never revives a reaped row.
    return await terminate({
      sessionId,
      lease,
      terminal,
      reason,
      expectedStatuses: ["starting", "waiting_for_user"],
      conditionalTransition,
      activity,
    });
  }

  // Abandon a success outcome whose promotion claim was lost. The reaper already
  // terminated this session, so the service writes no status and no credential.
  // It deletes the sandbox best-effort; the reaper delete is idempotent.
  async function abandonAfterLostClaim(ctx: {
    sessionId: string;
    lease: LoginSessionLease;
    activity: (phase: LoginSessionActivityPhase) => void;
  }): Promise<CodexDeviceLoginOutcome> {
    const { sessionId, lease, activity } = ctx;
    const observation = await observeSandboxDelete(() => lease.deleteSandbox());
    if (observation.confirmed) {
      activity("sandbox_deleted");
    }
    activity("timed_out");
    return {
      sessionId,
      status: "timed_out",
      cleanupPending: false,
      sandboxDeleteObserved: observation.observed,
    };
  }

  async function terminate(ctx: {
    sessionId: string;
    lease: LoginSessionLease;
    terminal: AdapterAuthSessionStatus;
    reason: string | null;
    /** The statuses the terminal write may replace. The write is conditional. */
    expectedStatuses: readonly AdapterAuthSessionInternalStatus[];
    conditionalTransition: (
      expectedStatuses: readonly AdapterAuthSessionInternalStatus[],
      status: AdapterAuthSessionInternalStatus,
      patch?: {
        failureReason?: string | null;
        finishedAt?: Date | null;
        promotionExpiresAt?: Date | null;
      },
    ) => Promise<boolean>;
    activity: (phase: LoginSessionActivityPhase) => void;
  }): Promise<CodexDeviceLoginOutcome> {
    const { sessionId, lease, terminal, reason, expectedStatuses, conditionalTransition, activity } =
      ctx;

    // The cleanup-state handoff. The service owns and observes the provider
    // delete on every terminal path. The reaper path shares the same delete
    // observation and the same durable-write choice.
    const observation = await observeSandboxDelete(() => lease.deleteSandbox());
    if (observation.confirmed) {
      activity("sandbox_deleted");
    }
    const finishedAt = now();
    const write = terminalCleanupWrite(observation.confirmed, terminal, reason);

    // A failed delete records the durable internal `cleanup_pending` state before
    // the terminal outcome, so a reaper retries the delete. A confirmed delete
    // records the terminal public status and releases the active claim. The write
    // is conditional and clears the promotion claim, so a lost race leaves the
    // reaper terminal in place.
    const committed = await conditionalTransition(expectedStatuses, write.status, {
      finishedAt,
      failureReason: write.failureReason,
      promotionExpiresAt: null,
    });
    if (!committed) {
      // The reaper already terminated the row. Leave its terminal in place. The
      // sandbox delete above is idempotent, so no sandbox survives.
      activity("timed_out");
      return {
        sessionId,
        status: "timed_out",
        cleanupPending: false,
        sandboxDeleteObserved: observation.observed,
      };
    }
    activity(observation.confirmed ? (terminal as LoginSessionActivityPhase) : "cleanup_pending");
    return {
      sessionId,
      status: terminal,
      cleanupPending: !observation.confirmed,
      sandboxDeleteObserved: observation.observed,
    };
  }

  async function readOwnerSession(
    sessionId: string,
    requestingUserId: string,
  ): Promise<AdapterAuthSessionOwnerResponse | null> {
    const row = await store.get(sessionId);
    if (!row) return null;
    const isOwner = row.startedByUserId === requestingUserId;
    const status = resolvePublicStatus(row);
    // Deliver the one-time prompt to the owner principal exactly once. The read
    // and the delete run with no await between them, so the first authorized
    // owner read consumes the prompt and every later read returns null. This
    // keeps the short-lived device code out of a repeated response.
    let prompt: DeviceLoginPrompt | null = null;
    if (isOwner) {
      prompt = promptsBySession.get(sessionId) ?? null;
      if (prompt) promptsBySession.delete(sessionId);
    }
    return {
      sessionId: row.id,
      environmentId: row.environmentId,
      status,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      failure: buildFailure(row, status),
      prompt: prompt ? { url: prompt.url, code: prompt.code } : null,
    };
  }

  // Cancel a login session for its owner. The write is durable, so a cancel
  // releases the company slot even when the calling process does not own the
  // in-flight run. A cross-process cancel, or a cancel after a restart, has no
  // in-memory controller to abort, so a process-local abort alone would leave the
  // row in an active state until the expiry. The durable write closes that gap.
  //
  // The transition is a conditional write from a pre-promotion active status to
  // the internal `cleanup_pending` state that encodes the `cancelled` terminal.
  // This releases the slot at once and hands the sandbox delete and the terminal
  // finalize to the reaper's cleanup-pending sweep. The write skips a `promoting`
  // row, so a cancel never interrupts an in-flight credential write; that
  // promotion runs to its own terminal.
  async function cancelOwnerSession(
    sessionId: string,
    requestingUserId: string,
  ): Promise<AdapterAuthSessionOwnerResponse | null> {
    const row = await store.get(sessionId);
    if (!row || row.startedByUserId !== requestingUserId) return null;
    const write = terminalCleanupWrite(false, "cancelled", null);
    await store.compareAndSetStatus({
      sessionId,
      expectedStatuses: ["starting", "waiting_for_user"],
      status: write.status,
      at: now(),
      failureReason: write.failureReason,
      finishedAt: now(),
      promotionExpiresAt: null,
    });
    return readOwnerSession(sessionId, requestingUserId);
  }

  return { start, readOwnerSession, cancelOwnerSession };
}

export type CodexDeviceLoginService = ReturnType<typeof createCodexDeviceLoginService>;

/** Resolve the public status of a row. A `cleanup_pending` row resolves the
 *  retained terminal status; every other status maps through the shared helper. */
function resolvePublicStatus(row: AdapterAuthSessionRow): AdapterAuthSessionStatus {
  if (row.status === "cleanup_pending") {
    return decodePendingTerminal(row.failureReason).terminal;
  }
  return toPublicAdapterAuthSessionStatus(row.status);
}

function buildFailure(
  row: AdapterAuthSessionRow,
  status: AdapterAuthSessionStatus,
): AdapterAuthSessionFailure | null {
  if (status !== "failed") return null;
  const reason =
    row.status === "cleanup_pending"
      ? decodePendingTerminal(row.failureReason).reason
      : row.failureReason;
  return { reason: reason ?? "unknown", message: null };
}

// ---------------------------------------------------------------------------
// The production runtime binding and the shared driver helper.
// ---------------------------------------------------------------------------

/** The fixed, session-specific Codex home template. The session identifier is
 *  server-generated, so no caller controls this path. */
export function sessionCodexHomePath(sessionId: string): string {
  return `/tmp/paperclip-adapter-login/${sessionId}`;
}

/** The fixed, session-specific credential path. No caller controls it. */
export function sessionCredentialPath(sessionId: string): string {
  return `${sessionCodexHomePath(sessionId)}/auth.json`;
}

/**
 * Build the sandbox login driver. This is the one helper the production runtime
 * and the tests share. It binds streamed execution and a credential read to the
 * environment runtime.
 *
 * - `execStreaming` sets an empty session-specific Codex home before the fixed
 *   login command runs, exports `CODEX_HOME`, and streams standard output to the
 *   runner. It passes the command through `sh -c`, so the runtime runs the whole
 *   compound command in one shell. It sets `forceSession`, so the command opens
 *   the persistent session and streams each standard-output chunk while the
 *   login command waits for the user. A one-shot exec returns the output only at
 *   the end, so the login prompt would never reach the user in time.
 * - `readFile` reads the credential from the fixed session-specific path with a
 *   one-shot `cat` command. No caller controls the path.
 * - `dispose` is a no-op. The service owns the sandbox delete through a separate
 *   seam, so the runner's swallowed dispose must not delete the sandbox.
 *
 * The runtime passes `command` and `args` to the provider as a program and its
 * argument vector. The provider quotes each element as one shell token. So a
 * compound command must run through a shell (`sh -c "<script>"`); a bare
 * compound string in `command` becomes one token and never runs.
 */
export function buildSandboxLoginDriver(deps: {
  environmentRuntime: Pick<EnvironmentRuntimeService, "execute">;
  environment: Environment;
  lease: EnvironmentLease;
  sessionHome: string;
  timeoutMs: number;
}): SandboxLoginDriver {
  const { environmentRuntime, environment, lease, sessionHome, timeoutMs } = deps;
  return {
    async execStreaming(command, onStdout) {
      const script = `rm -rf ${sessionHome} && mkdir -p ${sessionHome} && CODEX_HOME=${sessionHome} ${command}`;
      const result = await environmentRuntime.execute({
        environment,
        lease,
        command: "sh",
        args: ["-c", script],
        timeoutMs,
        // Open the persistent session, so the runtime streams each output chunk
        // to the runner while the login command waits. A one-shot exec returns
        // the output only at the end, so the prompt would arrive too late.
        forceSession: true,
        onLog: (stream, chunk) => {
          if (stream === "stdout") onStdout(chunk);
        },
      });
      return { exitCode: result.exitCode };
    },
    async readFile(path) {
      const result = await environmentRuntime.execute({
        environment,
        lease,
        command: "cat",
        args: [path],
        timeoutMs,
        bypassSession: true,
      });
      return Buffer.from(result.stdout ?? "", "utf8");
    },
    async dispose() {
      // The service owns the sandbox delete. This dispose is a no-op.
    },
  };
}

export interface ProductionLoginSessionRuntimeDeps {
  db: Db;
  environmentRuntime: EnvironmentRuntimeService;
}

/**
 * Build the production login-session runtime. It acquires a fresh lease with
 * reuse disabled (no heartbeat run, no execution workspace) and the active
 * custom-image template applied, binds the sandbox login driver, and owns the
 * delete and release seams.
 */
export function createProductionLoginSessionRuntime(
  deps: ProductionLoginSessionRuntimeDeps,
): LoginSessionRuntime {
  const environmentsSvc = environmentService(deps.db);
  return {
    async acquireLoginLease(input) {
      const environment = await environmentsSvc.getById(input.environmentId);
      if (!environment) {
        throw new Error(`Environment "${input.environmentId}" is not found.`);
      }
      const record = await deps.environmentRuntime.acquireRunLease({
        companyId: input.companyId,
        environment,
        issueId: null,
        agentId: null,
        // A null heartbeat run and a null execution workspace disable lease
        // reuse, so the login session always runs in a fresh sandbox.
        heartbeatRunId: null,
        persistedExecutionWorkspace: null,
        adapterType: input.adapterType,
        // Apply the active custom-image template, so the sandbox binds to the
        // trusted image and runtime identity.
        applyCustomImageTemplate: true,
      });
      // Tag the lease with the session identifier, so the reaper resolves an
      // orphan lease that no live session references. The tag carries no secret.
      await environmentsSvc.updateLeaseMetadata(record.lease.id, {
        ...(record.lease.metadata ?? {}),
        [LOGIN_LEASE_SESSION_TAG_KEY]: input.sessionId,
      });
      const sessionHome = sessionCodexHomePath(input.sessionId);
      const authPath = sessionCredentialPath(input.sessionId);
      const providerLeaseId = record.lease.providerLeaseId ?? record.lease.id;
      const driver = buildSandboxLoginDriver({
        environmentRuntime: deps.environmentRuntime,
        environment: record.environment,
        lease: record.lease,
        sessionHome,
        timeoutMs: CODEX_DEVICE_LOGIN_TIMEOUT_MS,
      });
      const driverKey = record.environment.driver;
      return {
        providerLeaseId,
        driver,
        authPath,
        async deleteSandbox() {
          const runtimeDriver = deps.environmentRuntime.getDriver(driverKey);
          if (!runtimeDriver) {
            throw new Error(`Environment driver "${driverKey}" is not registered.`);
          }
          const released = await runtimeDriver.releaseRunLease({
            environment: record.environment,
            lease: record.lease,
            status: "released",
          });
          // A failed provider cleanup is not a confirmed delete. The service
          // records `cleanup_pending` on the rejection.
          if (released?.cleanupStatus === "failed") {
            throw new Error("The sandbox delete did not confirm.");
          }
          return { outcome: "deleted" };
        },
        async release() {
          const runtimeDriver = deps.environmentRuntime.getDriver(driverKey);
          await runtimeDriver?.releaseRunLease({
            environment: record.environment,
            lease: record.lease,
            status: "failed",
          });
        },
      };
    },
  };
}
