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
  CODEX_DEVICE_LOGIN_COMMAND as DEFAULT_CODEX_LOGIN_COMMAND,
  parseDeviceLoginPrompt,
  runDeviceLogin,
  type DeviceLoginOutcome as RunnerDeviceLoginOutcome,
  type DeviceLoginPrompt,
  type SandboxLoginDriver,
} from "@paperclipai/adapter-codex-local/server";
import {
  GROK_DEVICE_LOGIN_COMMAND as DEFAULT_GROK_LOGIN_COMMAND,
  parseGrokDeviceLoginPrompt,
} from "@paperclipai/adapter-grok-local/server";
import type { AdapterLoginPrompt } from "@paperclipai/adapter-utils";
import {
  createLoginPtyTransport,
  type LoginPtySessionOpener,
} from "@paperclipai/adapter-utils/login-pty-transport";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import { buildLoginLeaseAcquireArgs } from "./adapter-login-lease.js";
import { environmentService } from "./environments.js";
import { runDescriptorBoundAuthRead } from "./device-login-credential-read.js";
import {
  resolveLoginCommandKey,
  validateLoginSessionHome,
  type LoginCommandKey,
} from "./login-command.js";
import type { LoginPtyWorkerManagerLike } from "./setup-token-transport-binding.js";

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
export const DEVICE_LOGIN_TIMEOUT_MS = 300_000;

// The fixed error for a sandbox provider that does not advertise the login
// pseudo-terminal capability. The Codex device login runs the login command on a
// real pseudo-terminal, so only a provider that advertises the capability can
// host the login. The route returns this specific, typed error and starts no
// session, so an unsupported provider never reaches a session row, a lease, or a
// pseudo-terminal.
export const DEVICE_LOGIN_PROVIDER_UNSUPPORTED =
  "The sandbox provider does not support the Codex device login.";
export const DEVICE_LOGIN_PROVIDER_UNSUPPORTED_CODE =
  "codex_device_login_provider_unsupported";

/**
 * The lease-metadata key that tags a login sandbox lease with its session
 * identifier. The runtime stamps it at acquisition. The reaper reads it to find
 * an orphan lease that no live session references. It is not a public field.
 */
export const LOGIN_LEASE_SESSION_TAG_KEY = "adapterLoginSessionId";

/**
 * The closed set of displayed-code adapter types. The shared
 * `adapter_auth_sessions` table also holds a Claude setup-token row. That row
 * uses a different login panel mode. So every store read and every reaper scan
 * filters to this set, instead of trusting the raw row's own value. No route
 * makes a row of an adapter type outside `codex_local` reachable yet. A later
 * phase widens the set of reachable adapters, with no change to this filter.
 */
export const DISPLAYED_CODE_ADAPTER_TYPES: readonly AgentAdapterType[] = [
  "codex_local",
  "grok_local",
];

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
 *  session, the company, the owner, and the adapter, so the promotion resolves
 *  the company slot and the sole-active-owner check for this exact session. */
export interface CredentialPromotionContext {
  sessionId: string;
  companyId: string;
  startedByUserId: string;
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

export interface StartDeviceLoginInput {
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

export interface DeviceLoginOutcome {
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

export interface StartDeviceLoginResult {
  /** The initial public response after the insert and the acquisition. */
  session: AdapterAuthSessionResponse;
  /**
   * Resolves when the terminal handling ends. The terminal handling runs the
   * readiness check, the promotion write, and the cleanup-state handoff, and
   * then it records the terminal status.
   */
  completed: Promise<DeviceLoginOutcome>;
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
  /** The public, CSPRNG session identifier. The API returns and looks up this
   *  value. It never equals the internal primary-key `id`, so a caller cannot
   *  address a row by the internal id. */
  publicSessionId: string;
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
  /** The public, CSPRNG session identifier. The service builds it and returns it
   *  to the client; the store persists it in `public_session_id`. */
  publicSessionId: string;
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
  /**
   * Read a session by its public session id, scoped to the company. The
   * predicate carries the company id, so a query never keys on the public
   * session id alone, and a foreign-company caller reads nothing. It never
   * accepts the internal primary-key `id`. `adapterType` scopes the read to one
   * requested adapter type. When the caller omits it, the read scopes to every
   * displayed-code adapter type.
   */
  getByPublicId(
    publicSessionId: string,
    companyId: string,
    adapterType?: AgentAdapterType,
  ): Promise<AdapterAuthSessionRow | null>;
  /** Run `fn` while the process holds the promotion critical-section lock for the
   *  company, owner, and adapter slot. The reaper reclaims a stale `promoting`
   *  row inside this lock, so a reclaim never interleaves with a live credential
   *  write for the same slot. */
  withCompanyAdapterPromotionLock<T>(
    companyId: string,
    startedByUserId: string,
    adapterType: AgentAdapterType,
    fn: () => Promise<T>,
  ): Promise<T>;
}

/** Build the advisory-lock key for the promotion critical section. The key is
 *  scoped to the company, the owner, and the adapter, so two different slots
 *  never contend. The credential-promotion path and the reaper reclaim both
 *  derive the key from this function, so they take the exact same lock. */
export function adapterLoginPromotionLockKey(
  companyId: string,
  startedByUserId: string,
  adapterType: AgentAdapterType,
): string {
  return `paperclip:adapter-login-promotion:${companyId}:${startedByUserId}:${adapterType}`;
}

/**
 * Run `fn` inside the promotion critical section for one company, owner, and
 * adapter slot.
 *
 * The function opens a database transaction and takes a transaction-scoped
 * PostgreSQL advisory lock. The lock serializes the credential-promotion path
 * against the reaper reclaim, so a reaper never releases the slot while a
 * credential write runs, and a stale promotion never writes after the reaper
 * reclaims the slot. The transaction holds the lock through `fn`, so the caller
 * runs the ownership check and the credential write in one mutually-exclusive
 * section. A process crash drops the connection and releases the lock, so a
 * stalled owner never blocks recovery.
 */
export async function withAdapterLoginPromotionLock<T>(
  db: Db,
  companyId: string,
  startedByUserId: string,
  adapterType: AgentAdapterType,
  fn: () => Promise<T>,
): Promise<T> {
  const key = adapterLoginPromotionLockKey(companyId, startedByUserId, adapterType);
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
   *  company, owner, and adapter slot. The reaper reclaims a stale `promoting`
   *  row inside this lock, so a reclaim never interleaves with a live credential
   *  write for the same slot. */
  withCompanyAdapterPromotionLock<T>(
    companyId: string,
    startedByUserId: string,
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
    publicSessionId: row.publicSessionId,
    companyId: row.companyId,
    environmentId: row.environmentId,
    adapterType: row.adapterType,
    startedByUserId: row.startedByUserId,
    providerLeaseId: row.providerLeaseId ?? null,
    // The unified `status` column type is the merged login-state union. A Codex
    // device-login row only ever holds a Codex internal status, so narrow the
    // read back to the internal union the service reasons about.
    status: row.status as AdapterAuthSessionInternalStatus,
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
          // The unified table requires a unique public session id. The service
          // builds it from a CSPRNG and returns it to the client, so the store
          // persists that value here. It never uses the internal id, a timestamp,
          // or a counter.
          publicSessionId: input.publicSessionId,
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
    async getByPublicId(publicSessionId, companyId, adapterType) {
      // The predicate carries the company id, so a read never keys on the public
      // session id alone. A foreign-company caller reads nothing. The internal
      // primary-key `id` never matches, so a caller cannot address a row by the
      // internal id. The adapter predicate scopes the read to the one requested
      // type, or, when the caller omits it, to every displayed-code adapter type.
      const rows = await db
        .select()
        .from(adapterAuthSessions)
        .where(
          and(
            eq(adapterAuthSessions.publicSessionId, publicSessionId),
            eq(adapterAuthSessions.companyId, companyId),
            adapterType
              ? eq(adapterAuthSessions.adapterType, adapterType)
              : inArray(adapterAuthSessions.adapterType, DISPLAYED_CODE_ADAPTER_TYPES),
          ),
        )
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
            // The shared table also holds the setup-token rows, so every reaper
            // scan filters by the closed set of displayed-code adapter types.
            inArray(adapterAuthSessions.adapterType, DISPLAYED_CODE_ADAPTER_TYPES),
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
        .where(
          and(
            inArray(adapterAuthSessions.adapterType, DISPLAYED_CODE_ADAPTER_TYPES),
            eq(adapterAuthSessions.status, "cleanup_pending"),
          ),
        );
      return rows.map(toRow);
    },
    async listLeaseReferences() {
      const rows = await db
        .select({ providerLeaseId: adapterAuthSessions.providerLeaseId })
        .from(adapterAuthSessions)
        .where(
          and(
            inArray(adapterAuthSessions.adapterType, DISPLAYED_CODE_ADAPTER_TYPES),
            isNotNull(adapterAuthSessions.providerLeaseId),
          ),
        );
      return rows
        .map((row) => row.providerLeaseId)
        .filter((value): value is string => value != null);
    },
    async withCompanyAdapterPromotionLock(companyId, startedByUserId, adapterType, fn) {
      return withAdapterLoginPromotionLock(db, companyId, startedByUserId, adapterType, fn);
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
// The host-owned displayed-code login profile. `runLogin` resolves one profile
// per login from the trusted adapter type, so a host-owned map, not the runner
// package, chooses the command, the home variable name, the prompt parser, and
// the timeout for each displayed-code adapter.
// ---------------------------------------------------------------------------

/**
 * The per-adapter values a displayed-code login run needs. `homeEnvVar` names
 * the environment variable the sandbox login pseudo-terminal opener sets to the
 * server-controlled session home, for example `CODEX_HOME`. The credential file
 * name under that home stays the same for every adapter.
 */
export interface DisplayedCodeLoginProfile {
  /** The login command the sandbox pseudo-terminal runs. */
  command: string;
  /** The environment variable name the login command reads its home from. */
  homeEnvVar: string;
  /** Parses the authorization prompt from the login output. Returns null when
   *  the output holds no prompt yet. */
  parsePrompt(output: string): AdapterLoginPrompt | null;
  /** The host timeout for the sandbox login command. */
  timeoutMs: number;
  /** The mandatory credential promotion for this adapter. */
  promotion: CredentialPromotion;
}

/** A promotion placeholder for a profile map entry. The service always resolves
 *  the real promotion from {@link DeviceLoginServiceDeps.promotion} before it
 *  runs a login, so this value never runs in production. */
const UNCONFIGURED_PROMOTION: CredentialPromotion = {
  promote() {
    throw new Error("device login: no credential promotion is configured for this adapter.");
  },
};

/**
 * The host-owned profile for every displayed-code adapter type. `AgentAdapterType`
 * covers every adapter, not only the displayed-code ones. So the map is a partial
 * record: a lookup for an adapter type with no entry yields `undefined`. Both the
 * `codex_local` entry and the `grok_local` entry are reachable today: the route
 * admission gate in `agents.ts` and the `login-command.ts` closed key map now
 * cover `grok_local` too.
 *
 * `homeEnvVar` names the environment variable the sandbox login pseudo-terminal
 * opener sets, for documentation only: no code reads this member today. The
 * opener (`composeLaunchLine` in the Daytona plugin) holds its own fixed
 * `CODEX_HOME` / `GROK_HOME` mapping, keyed off the closed login command key,
 * not off this profile. This matches the existing `codex_local` entry, whose
 * `homeEnvVar` has been unread the same way since phase 1.
 */
export const DISPLAYED_CODE_PROFILES: Readonly<
  Partial<Record<AgentAdapterType, DisplayedCodeLoginProfile>>
> = {
  codex_local: {
    command: DEFAULT_CODEX_LOGIN_COMMAND,
    homeEnvVar: "CODEX_HOME",
    parsePrompt: parseDeviceLoginPrompt,
    timeoutMs: DEVICE_LOGIN_TIMEOUT_MS,
    promotion: UNCONFIGURED_PROMOTION,
  },
  grok_local: {
    command: DEFAULT_GROK_LOGIN_COMMAND,
    homeEnvVar: "GROK_HOME",
    parsePrompt: parseGrokDeviceLoginPrompt,
    timeoutMs: DEVICE_LOGIN_TIMEOUT_MS,
    promotion: UNCONFIGURED_PROMOTION,
  },
};

// ---------------------------------------------------------------------------
// The service.
// ---------------------------------------------------------------------------

export interface DeviceLoginServiceDeps {
  store: AdapterAuthSessionStore;
  runtime: LoginSessionRuntime;
  /**
   * The mandatory credential promotion, keyed by adapter type. A successful
   * login authenticates only after the promotion for its own adapter type
   * resolves; a throw fails the session and writes nothing. An adapter type
   * with no entry falls back to the `codex_local` entry, matching the profile
   * map's own fallback below. Keying by adapter type keeps each adapter's
   * promotion running only for its own logins: a `grok_local` login never
   * runs the Codex promotion, and a `codex_local` login never runs the Grok
   * one.
   */
  promotionByAdapterType: Partial<Record<AgentAdapterType, CredentialPromotion>>;
  recordActivity?: LoginSessionActivityRecorder;
  now?: () => Date;
}

export function createDeviceLoginService(deps: DeviceLoginServiceDeps) {
  const { store, runtime, promotionByAdapterType } = deps;
  const now = deps.now ?? (() => new Date());
  const recordActivity = deps.recordActivity ?? (() => {});

  /**
   * Resolve the displayed-code profile for one login, with this service
   * instance's injected, adapter-scoped promotion in place of the map's
   * placeholder. Falls back to the `codex_local` profile (and the
   * `codex_local` promotion) for an adapter type with no entry of its own, so
   * a login for an adapter type outside the map keeps running the same
   * command, parser, and promotion it always did before the map existed.
   * `codex_local` and `grok_local` are reachable through the route admission
   * gate today; the fallback stays in place for a future adapter type with no
   * profile entry.
   */
  function resolveProfile(adapterType: AgentAdapterType): DisplayedCodeLoginProfile {
    const staticProfile = DISPLAYED_CODE_PROFILES[adapterType] ?? DISPLAYED_CODE_PROFILES.codex_local!;
    const promotion =
      promotionByAdapterType[adapterType] ??
      promotionByAdapterType.codex_local ??
      UNCONFIGURED_PROMOTION;
    return { ...staticProfile, promotion };
  }

  // The one-time prompt per session. The service holds it in memory only. The
  // owner read path returns it; it never reaches the durable row or an activity
  // record.
  const promptsBySession = new Map<string, DeviceLoginPrompt>();

  async function start(
    input: StartDeviceLoginInput,
  ): Promise<StartDeviceLoginResult> {
    const sessionId = randomUUID();
    // The public session identifier the API returns and looks up. It is an
    // independent CSPRNG value, so it never equals the internal `sessionId` and a
    // caller cannot address the row by the internal id.
    const publicSessionId = randomUUID();
    const startedAt = now();
    const ttlSeconds = input.ttlSeconds ?? resolveProfile(input.adapterType).timeoutMs / 1000;
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
      publicSessionId,
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
      // The API identifier is the public session id, never the internal `sessionId`.
      sessionId: publicSessionId,
      environmentId: input.environmentId,
      status: "starting",
      expiresAt: expiresAt.toISOString(),
      failure: null,
    };

    const completed = runLogin({ input, sessionId, lease, base, activity });
    return { session, completed };
  }

  async function runLogin(ctx: {
    input: StartDeviceLoginInput;
    sessionId: string;
    lease: LoginSessionLease;
    base: Omit<LoginSessionActivityEvent, "phase">;
    activity: (phase: LoginSessionActivityPhase) => void;
  }): Promise<DeviceLoginOutcome> {
    const { input, sessionId, lease, activity } = ctx;
    const profile = resolveProfile(input.adapterType);

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
    let outcome: RunnerDeviceLoginOutcome;
    try {
      const result = await runDeviceLogin(lease.driver, {
        command: profile.command,
        timeoutMs: profile.timeoutMs,
        // `RunDeviceLoginOptions.parsePrompt` keeps the runner's own required-code
        // prompt shape. The profile parser returns the wider adapter-neutral
        // shape, so this adapts one call's result without widening the runner's
        // own `onPrompt` contract. Every `codex_local` prompt carries a code, so
        // this is a no-op today.
        parsePrompt: (output) => {
          const prompt = profile.parsePrompt(output);
          return prompt && prompt.code !== undefined ? { url: prompt.url, code: prompt.code } : null;
        },
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
        await profile.promotion.promote(credential, {
          sessionId,
          companyId: input.companyId,
          startedByUserId: input.startedByUserId,
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
  }): Promise<DeviceLoginOutcome> {
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
  }): Promise<DeviceLoginOutcome> {
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
    publicSessionId: string,
    companyId: string,
    requestingUserId: string,
  ): Promise<AdapterAuthSessionOwnerResponse | null> {
    // Look the row up by its public session id, scoped to the company. A
    // foreign-company caller reads nothing, and the internal id never matches.
    const row = await store.getByPublicId(publicSessionId, companyId);
    if (!row) return null;
    const isOwner = row.startedByUserId === requestingUserId;
    const status = resolvePublicStatus(row);
    // Deliver the one-time prompt to the owner principal exactly once. The read
    // and the delete run with no await between them, so the first authorized
    // owner read consumes the prompt and every later read returns null. This
    // keeps the short-lived device code out of a repeated response. The prompt
    // map keys on the internal id, so read it by `row.id`, not the public id.
    let prompt: DeviceLoginPrompt | null = null;
    if (isOwner) {
      prompt = promptsBySession.get(row.id) ?? null;
      if (prompt) promptsBySession.delete(row.id);
    }
    return {
      sessionId: row.publicSessionId,
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
    publicSessionId: string,
    companyId: string,
    requestingUserId: string,
  ): Promise<AdapterAuthSessionOwnerResponse | null> {
    // Look the row up by its public session id, scoped to the company. The status
    // write keys on the internal `row.id`, so a cancel never addresses a row by
    // the public id alone.
    const row = await store.getByPublicId(publicSessionId, companyId);
    if (!row || row.startedByUserId !== requestingUserId) return null;
    const write = terminalCleanupWrite(false, "cancelled", null);
    await store.compareAndSetStatus({
      sessionId: row.id,
      expectedStatuses: ["starting", "waiting_for_user"],
      status: write.status,
      at: now(),
      failureReason: write.failureReason,
      finishedAt: now(),
      promotionExpiresAt: null,
    });
    return readOwnerSession(publicSessionId, companyId, requestingUserId);
  }

  return { start, readOwnerSession, cancelOwnerSession };
}

export type DeviceLoginService = ReturnType<typeof createDeviceLoginService>;

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
export function sessionLoginHomePath(sessionId: string): string {
  return `/tmp/paperclip-adapter-login/${sessionId}`;
}

/** The fixed, session-specific credential path. No caller controls it. */
export function sessionCredentialPath(sessionId: string): string {
  return `${sessionLoginHomePath(sessionId)}/auth.json`;
}

/**
 * Build the sandbox login driver. This is the one helper the production runtime
 * and the tests share. It runs the login command over the shared login
 * pseudo-terminal (PTY) transport and reads the credential with one
 * descriptor-bound read.
 *
 * - `start` runs the fixed login command on a real pseudo-terminal through the
 *   shared {@link createLoginPtyTransport} and streams each terminal output chunk
 *   to the runner while the login command waits for the user. The login command
 *   needs a pseudo-terminal: pipe stdio emits no login prompt. The pseudo-terminal
 *   opener sets the session-specific `CODEX_HOME` to the same verified session
 *   home this driver reads.
 * - `readFile` runs one descriptor-bound read. It opens the verified session home
 *   and the fixed credential file with no symlink follow, checks the opened
 *   descriptor, and reads only from that same descriptor. It ignores the path the
 *   runner passes, so no caller controls the read target. It reads the fixed
 *   `auth.json` under the server-controlled session home.
 * - `dispose` releases the pseudo-terminal transport, so the host frees the login
 *   pseudo-terminal slot. The service owns the sandbox delete through a separate
 *   seam, so this dispose never deletes the sandbox.
 *
 * The session home is server-controlled and shared: the pseudo-terminal opener
 * sets `CODEX_HOME` to it, and the descriptor-bound read opens it. So the login
 * command writes `auth.json` into the exact directory the read opens.
 */
export function buildSandboxLoginDriver(deps: {
  openPtySession: LoginPtySessionOpener;
  environmentRuntime: Pick<EnvironmentRuntimeService, "execute">;
  environment: Environment;
  lease: EnvironmentLease;
  sessionHome: string;
  timeoutMs: number;
}): SandboxLoginDriver {
  const { openPtySession, environmentRuntime, environment, lease, sessionHome, timeoutMs } = deps;
  const transport = createLoginPtyTransport(openPtySession);
  return {
    async start(command, onData) {
      return transport.start(command, onData);
    },
    async readFile(_path) {
      // The read ignores the runner path. It runs one fixed, server-controlled,
      // descriptor-bound operation against the verified session home. So a swap of
      // the credential file between a check and the read cannot steer the read.
      return runDescriptorBoundAuthRead({
        environmentRuntime,
        environment,
        lease,
        sessionHome,
        timeoutMs,
      });
    },
    async dispose() {
      // Free the host pseudo-terminal slot before the service deletes the sandbox.
      // The service owns the sandbox delete through a separate seam.
      await transport.dispose();
    },
  };
}

/**
 * The verified binding one login session hands to the live pseudo-terminal
 * opener. The opener sets the sandbox `CODEX_HOME` to `sessionHome`, so the login
 * command writes `auth.json` into the exact directory the descriptor-bound read
 * opens.
 */
export interface LoginPtySessionBinding {
  companyId: string;
  environmentId: string;
  adapterType: AgentAdapterType;
  /** The provider lease that binds the sandbox worker. */
  providerLeaseId: string;
  /** The server-controlled session home. The opener sets `CODEX_HOME` to it. */
  sessionHome: string;
  /** The resolved environment for the acquired lease. */
  environment: Environment;
  /** The acquired environment lease. */
  lease: EnvironmentLease;
}

/**
 * Opens the live pseudo-terminal for one login session and returns the shared
 * transport opener. The Daytona provider runs as a plugin worker, so the real
 * opener binds inside the worker through the plugin worker manager route. A test
 * injects a fake opener to drive the full session path.
 */
export type OpenLoginPtySession = (
  binding: LoginPtySessionBinding,
) => Promise<LoginPtySessionOpener>;

/** The fixed, non-secret error the Codex live opener throws when it cannot bind
 *  the sandbox worker route. It carries no lease detail and no secret. */
const CODEX_LOGIN_PTY_BIND_FAILED =
  "device login failed: the sandbox pseudo-terminal transport is not bound.";

/** The dependencies the worker-bound Codex live pseudo-terminal opener needs. */
export interface WorkerBoundLoginPtyOpenerDeps {
  /** The plugin worker manager that owns the host route gate. */
  workerManager: LoginPtyWorkerManagerLike;
  /** A non-leaking status sink. It receives only fixed status lines. */
  log?: (line: string) => void;
}

function readLeaseMetaString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Builds the production Codex `openLivePtySession`. It drives the sandbox worker
 * through the manager route gate. The manager mints the host route identifier and
 * owns the route lifecycle.
 *
 * The opener passes the binding's server-controlled `sessionHome` to the worker
 * route. That home is the exact directory the descriptor-bound credential read
 * opens, so the sandbox `CODEX_HOME` and the read target match. The opener never
 * derives a fresh home: a fresh home would set `CODEX_HOME` to a directory the
 * read never opens, and every Codex login would fail closed.
 *
 * The opener resolves the closed login command key from the trusted adapter type,
 * never from the caller. It validates the session home shape before the worker
 * RPC. It fails closed when the lease carries no sandbox worker binding.
 */
export function createWorkerBoundLoginPtyOpener(
  deps: WorkerBoundLoginPtyOpenerDeps,
): OpenLoginPtySession {
  const log = deps.log ?? (() => {});
  return async (binding) => {
    const metadata =
      binding.lease.metadata && typeof binding.lease.metadata === "object"
        ? (binding.lease.metadata as Record<string, unknown>)
        : {};
    const pluginId = readLeaseMetaString(metadata.pluginId);
    const driverKey =
      readLeaseMetaString(metadata.provider) ?? readLeaseMetaString(metadata.driver);
    if (!binding.providerLeaseId || !pluginId || !driverKey) {
      log("[paperclip] Device login: the lease carries no sandbox worker binding.");
      throw new Error(CODEX_LOGIN_PTY_BIND_FAILED);
    }
    // Resolve the closed command key from the trusted adapter type. An unmapped
    // adapter fails closed before the worker RPC.
    let loginCommandKey: LoginCommandKey;
    try {
      loginCommandKey = resolveLoginCommandKey(binding.adapterType);
    } catch {
      log("[paperclip] Device login: the adapter type has no login command key.");
      throw new Error(CODEX_LOGIN_PTY_BIND_FAILED);
    }
    // Validate the server-controlled session home shape before the worker RPC.
    // The runtime derived it from the session id; the manager revalidates it too.
    validateLoginSessionHome(binding.sessionHome);
    // The opener argument is the runner's fixed command string. It confers no
    // command authority, so the opener ignores it and returns a host-bound opener.
    return (_command: string) =>
      deps.workerManager.openLoginPtySession(pluginId, {
        driverKey,
        companyId: binding.companyId,
        environmentId: binding.environmentId,
        providerLeaseId: binding.providerLeaseId,
        loginCommandKey,
        sessionHome: binding.sessionHome,
      });
  };
}

export interface ProductionLoginSessionRuntimeDeps {
  db: Db;
  environmentRuntime: EnvironmentRuntimeService;
  /**
   * Re-checks the provider login pseudo-terminal capability from current runtime
   * state, immediately before the provider lease. The route gate already ran, so
   * a managed reconciliation can rebind the environment to an unsupported
   * provider between the route gate and this acquire. The check reads the current
   * provider capability, not the stale route decision. It throws the fixed
   * unsupported-provider error, so the runtime creates no lease and opens no
   * pseudo-terminal for an unsupported provider.
   */
  assertProviderSupportsLoginPty: (environmentId: string) => Promise<void>;
  /**
   * Opens the live pseudo-terminal for the acquired lease. When a caller omits
   * it, the runtime binds a fail-closed opener: the login run then fails and the
   * service deletes the sandbox. The live opener binds the sandbox worker route.
   */
  openLivePtySession?: OpenLoginPtySession;
}

/** The fixed, non-secret error the fail-closed opener throws when no live
 *  pseudo-terminal opener is bound. */
const LOGIN_PTY_OPENER_UNBOUND = "device login failed: the sandbox pseudo-terminal transport is not bound.";

/**
 * Build the production login-session runtime. It acquires a fresh lease with
 * reuse disabled (no heartbeat run, no execution workspace) and the active
 * custom-image template applied, binds the sandbox login driver over the shared
 * pseudo-terminal transport, and owns the delete and release seams.
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
      // Re-check the provider login pseudo-terminal capability from current
      // runtime state, immediately before the provider lease. A managed
      // reconciliation can rebind the environment to an unsupported provider
      // between the route gate and this acquire, so the check reads the current
      // capability, not the stale route decision. It throws the fixed
      // unsupported-provider error, so the runtime acquires no lease and opens no
      // pseudo-terminal for an unsupported provider.
      await deps.assertProviderSupportsLoginPty(input.environmentId);
      const record = await deps.environmentRuntime.acquireRunLease(
        buildLoginLeaseAcquireArgs({
          metadata: {
            companyId: input.companyId,
            environment,
            adapterType: input.adapterType,
          },
        }),
      );
      // Tag the lease with the session identifier, so the reaper resolves an
      // orphan lease that no live session references. The tag carries no secret.
      await environmentsSvc.updateLeaseMetadata(record.lease.id, {
        ...(record.lease.metadata ?? {}),
        [LOGIN_LEASE_SESSION_TAG_KEY]: input.sessionId,
      });
      const sessionHome = sessionLoginHomePath(input.sessionId);
      const authPath = sessionCredentialPath(input.sessionId);
      const providerLeaseId = record.lease.providerLeaseId ?? record.lease.id;
      // Resolve the live pseudo-terminal opener for this lease. When no live
      // opener is bound, use a fail-closed opener: the login run then fails and
      // the service deletes the sandbox. The opener sets `CODEX_HOME` to the same
      // `sessionHome` the descriptor-bound read opens.
      const openPtySession: LoginPtySessionOpener = deps.openLivePtySession
        ? await deps.openLivePtySession({
            companyId: input.companyId,
            environmentId: input.environmentId,
            adapterType: input.adapterType,
            providerLeaseId,
            sessionHome,
            environment: record.environment,
            lease: record.lease,
          })
        : () => Promise.reject(new Error(LOGIN_PTY_OPENER_UNBOUND));
      const driver = buildSandboxLoginDriver({
        openPtySession,
        environmentRuntime: deps.environmentRuntime,
        environment: record.environment,
        lease: record.lease,
        sessionHome,
        timeoutMs: DEVICE_LOGIN_TIMEOUT_MS,
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
