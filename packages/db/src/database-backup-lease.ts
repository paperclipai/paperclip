import postgres from "postgres";
import { randomUUID } from "node:crypto";

const BACKUP_EXECUTION_LOCK_NAMESPACE = "paperclip:database-backup:execution:v1";
const BACKUP_EXECUTION_FENCE_LOCK_NAMESPACE =
  "paperclip:database-backup:execution-fence:v1";
const BACKUP_EMITTER_LOCK_NAMESPACE = "paperclip:database-backup:emitter:v1";
const BACKUP_EXECUTION_FENCE_SINGLETON_KEY = "default";

export type DatabaseBackupLease = {
  /** Resolves when the dedicated PostgreSQL session closes for any reason. */
  readonly lost: Promise<void>;
  /** Synchronous authority check for callers that own long-lived leases. */
  isHeld(): boolean;
  release(): Promise<void>;
};

export type AcquireDatabaseBackupLeaseOptions = {
  connectTimeoutSeconds?: number;
  operationTimeoutMs?: number;
};

let afterDurableFenceClaimedForTests: (() => void | Promise<void>) | null = null;

export function __setAfterDurableFenceClaimedForTests(
  hook: (() => void | Promise<void>) | null,
): void {
  afterDurableFenceClaimedForTests = hook;
}

export class DatabaseBackupFenceConflictError extends Error {
  constructor() {
    super(
      "Database backup execution is blocked by an uncleared durable fence from a prior owner",
    );
    this.name = "DatabaseBackupFenceConflictError";
  }
}

function databaseBackupSqlOptions(
  applicationName: string,
  opts: AcquireDatabaseBackupLeaseOptions,
) {
  const connectTimeoutSeconds = Math.max(
    1,
    Math.trunc(opts.connectTimeoutSeconds ?? 5),
  );
  const operationTimeoutMs = Math.max(
    1,
    Math.trunc(opts.operationTimeoutMs ?? connectTimeoutSeconds * 1_000),
  );
  return {
    max: 1,
    connect_timeout: connectTimeoutSeconds,
    connection: {
      application_name: applicationName,
      statement_timeout: operationTimeoutMs,
      lock_timeout: operationTimeoutMs,
    },
    max_lifetime: null,
    onnotice: () => {},
  } as const;
}

async function claimDurableDatabaseBackupFence(
  connectionString: string,
  ownerToken: string,
  opts: AcquireDatabaseBackupLeaseOptions,
): Promise<void> {
  const sql = postgres(
    connectionString,
    databaseBackupSqlOptions("paperclip-database-backup-durable-fence-claim", opts),
  );
  try {
    const rows = await sql<{ owner_token: string }[]>`
      INSERT INTO database_backup_execution_fence (
        singleton_key,
        owner_token
      )
      VALUES (
        ${BACKUP_EXECUTION_FENCE_SINGLETON_KEY},
        ${ownerToken}::uuid
      )
      ON CONFLICT (singleton_key) DO NOTHING
      RETURNING owner_token::text
    `;
    if (rows.length === 0) {
      throw new DatabaseBackupFenceConflictError();
    }
  } finally {
    await sql.end({ timeout: 0 });
  }
}

async function releaseDurableDatabaseBackupFence(
  connectionString: string,
  ownerToken: string,
  opts: AcquireDatabaseBackupLeaseOptions,
): Promise<void> {
  const sql = postgres(
    connectionString,
    databaseBackupSqlOptions("paperclip-database-backup-durable-fence-release", opts),
  );
  try {
    const rows = await sql<{ owner_token: string }[]>`
      DELETE FROM database_backup_execution_fence
      WHERE singleton_key = ${BACKUP_EXECUTION_FENCE_SINGLETON_KEY}
        AND owner_token = ${ownerToken}::uuid
      RETURNING owner_token::text
    `;
    if (rows.length !== 1) {
      throw new Error("Database backup durable fence was no longer owned by this execution");
    }
  } finally {
    await sql.end({ timeout: 0 });
  }
}

/**
 * Acquire a PostgreSQL session advisory lock for a database-scoped backup role.
 *
 * The lock is cluster-visible, so independent Paperclip server processes cannot
 * concurrently own the same role. Closing the dedicated session releases the
 * lock even when the owning process exits unexpectedly.
 */
async function tryAcquireDatabaseBackupRoleLease(
  connectionString: string,
  lockNamespace: string,
  applicationName: string,
  opts: AcquireDatabaseBackupLeaseOptions = {},
): Promise<DatabaseBackupLease | null> {
  let held = false;
  let released = false;
  let resolveLost!: () => void;
  const lost = new Promise<void>((resolve) => {
    resolveLost = resolve;
  });
  const markLost = () => {
    if (!held && released) return;
    held = false;
    resolveLost();
  };
  const sql = postgres(connectionString, {
    ...databaseBackupSqlOptions(applicationName, opts),
    // A leadership lease must not disappear at postgres.js's randomized
    // 30 to 60 minute default max lifetime. PostgreSQL/socket failure still calls
    // onclose, resolves `lost`, and releases the advisory lock server-side.
    onclose: markLost,
  });

  try {
    const [row] = await sql<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(
        hashtext(${lockNamespace}),
        hashtext(current_database()::text)
      ) AS acquired
    `;

    if (!row?.acquired) {
      await sql.end({ timeout: 0 });
      return null;
    }

    held = true;
    return {
      lost,
      isHeld: () => held,
      release: async () => {
        if (released) return;
        released = true;
        try {
          held = false;
          await sql.end({ timeout: 0 });
        } finally {
          held = false;
          resolveLost();
        }
      },
    };
  } catch (error) {
    try {
      await sql.end({ timeout: 0 });
    } catch {
      // Preserve the acquisition error; closing the session releases any lock.
    }
    throw error;
  }
}

/**
 * Serialize the actual pg_dump operation across every server process.
 *
 * Execution uses two independent PostgreSQL sessions plus a durable database
 * row. The authority session is the loss detector; the advisory fence covers
 * ordinary cancellation; and the durable row survives total session loss.
 * The row is removed only when the original owner explicitly releases after
 * joining its backup child. If that owner dies, replacements fail closed until
 * an operator proves no dump remains and clears the abandoned marker.
 */
export async function tryAcquireDatabaseBackupLease(
  connectionString: string,
  opts: AcquireDatabaseBackupLeaseOptions = {},
): Promise<DatabaseBackupLease | null> {
  const fence = await tryAcquireDatabaseBackupRoleLease(
    connectionString,
    BACKUP_EXECUTION_FENCE_LOCK_NAMESPACE,
    "paperclip-database-backup-execution-fence",
    opts,
  );
  if (!fence) return null;

  let authority: DatabaseBackupLease | null = null;
  const ownerToken = randomUUID();
  try {
    authority = await tryAcquireDatabaseBackupRoleLease(
      connectionString,
      BACKUP_EXECUTION_LOCK_NAMESPACE,
      "paperclip-database-backup-execution-authority",
      opts,
    );
    if (!authority) {
      await fence.release();
      return null;
    }
    await claimDurableDatabaseBackupFence(connectionString, ownerToken, opts);
    await afterDurableFenceClaimedForTests?.();
  } catch (error) {
    // The INSERT may have committed even when its client observed a disconnect
    // or close failure. Attempt an owner-token-scoped delete while both
    // advisory sessions are still fenced; a foreign/stale marker is untouched.
    await releaseDurableDatabaseBackupFence(
      connectionString,
      ownerToken,
      opts,
    ).catch(() => {});
    await authority?.release().catch(() => {});
    await fence.release().catch(() => {});
    throw error;
  }

  let released = false;
  const lost = Promise.race([fence.lost, authority.lost]).then(() => undefined);
  return {
    lost,
    isHeld: () => fence.isHeld() && authority!.isHeld(),
    release: async () => {
      if (released) return;
      released = true;
      let durableFenceError: unknown = null;
      try {
        await releaseDurableDatabaseBackupFence(connectionString, ownerToken, opts);
      } catch (error) {
        durableFenceError = error;
      }
      const results = await Promise.allSettled([
        authority!.release(),
        fence.release(),
      ]);
      if (durableFenceError) throw durableFenceError;
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (rejected) throw rejected.reason;
    },
  };
}

/**
 * Elect exactly one automatic-backup emitter across every server process.
 *
 * This lease is deliberately distinct from the execution lease: the elected
 * emitter holds leadership for its lifetime while manual backups remain able
 * to acquire the short-lived execution lease between automatic runs.
 */
export function tryAcquireDatabaseBackupEmitterLease(
  connectionString: string,
  opts: AcquireDatabaseBackupLeaseOptions = {},
): Promise<DatabaseBackupLease | null> {
  return tryAcquireDatabaseBackupRoleLease(
    connectionString,
    BACKUP_EMITTER_LOCK_NAMESPACE,
    "paperclip-database-backup-emitter",
    opts,
  );
}
