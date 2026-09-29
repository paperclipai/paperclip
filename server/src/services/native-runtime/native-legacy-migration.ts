import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { and, eq, gt, sql } from "drizzle-orm";
import { nativeRunFinalizations, type Db } from "@paperclipai/db";
import { migrateLegacySessionAuthority, readRunnerdArtifactBinding, type DurableRecoveryIdentity, type PreparedLocalSession } from "../../vendor/paperclip-runner/index.js";
import { createNativePostgresAuthorityStore, type AuthorityTransaction, type PostgresAuthorityBinding } from "./postgres-authority-store.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { startNativeMaintenanceLeaseRenewal } from "./native-maintenance-lease.js";

const execute = promisify(execFile);

/** Retains the exact admitted migration owner for a job of any duration.
 * Short timing options allow real database fault tests without a minute-long
 * fixture; production callers use the 60-second renewable lease. */
export async function startNativeLegacyMigrationLease(input: {
  db: Db;
  owner: PostgresAuthorityBinding;
  lease: { owner: string; attempt: number };
  assertStoppedProcessTree(): Promise<void>;
}, options: { leaseMs?: number; intervalMs?: number; timeoutMs?: number } = {}) {
  const leaseMs = options.leaseMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 15_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (![leaseMs, intervalMs, timeoutMs].every(value => Number.isSafeInteger(value) && value > 0) || intervalMs + timeoutMs >= leaseMs) throw new Error("native_legacy_migration_lease_policy_invalid");
  const owner = { ...input.owner };
  const lease = { ...input.lease };
  const controller = await currentNativeControllerIdentity();
  const condition = () => and(eq(nativeRunFinalizations.companyId, owner.companyId), eq(nativeRunFinalizations.issueId, owner.issueId),
    eq(nativeRunFinalizations.runId, owner.runId), eq(nativeRunFinalizations.leaseOwner, lease.owner), eq(nativeRunFinalizations.attempt, lease.attempt),
    eq(nativeRunFinalizations.controllerBootId, controller.bootId), eq(nativeRunFinalizations.controllerPid, controller.pid),
    eq(nativeRunFinalizations.controllerProcessStartedAt, controller.processStartedAt), gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`));
  const renewLease = async (connection: Db | AuthorityTransaction = input.db) => {
    const rows = await connection.update(nativeRunFinalizations)
      .set({ leaseExpiresAt: sql`clock_timestamp() + ${leaseMs} * interval '1 millisecond'`, updatedAt: sql`clock_timestamp()` })
      .where(condition()).returning({ runId: nativeRunFinalizations.runId });
    if (rows.length !== 1) throw new Error("native_legacy_migration_lease_lost");
  };
  await input.assertStoppedProcessTree();
  await renewLease();
  const maintenance = startNativeMaintenanceLeaseRenewal(renewLease, intervalMs, { renewalTimeoutMs: timeoutMs });
  const assertLease = async (tx?: AuthorityTransaction) => {
    if (tx) {
      maintenance.assertKnown();
      // This update both fences publication and renews using the transaction's
      // own connection. Waiting for the background renewal while holding its
      // target row could deadlock. No history-sized work occurs in this tx.
      await renewLease(tx);
      maintenance.assertKnown();
      return;
    }
    await maintenance.assert();
    const query = input.db.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(condition());
    const rows = await query;
    if (rows.length !== 1) throw new Error("native_legacy_migration_lease_lost");
  };
  return { ...maintenance, assertLease };
}

/** Server entry point for an already-quiesced local migration. The caller's
 * normal recovery admission must supply the exact stopped process-tree proof;
 * this service does not infer death from an expired lease or invent a new run.
 * Both the filesystem steps and each PostgreSQL commit recheck ownership. */
export async function migrateNativeLegacySessionAuthority(input: {
  db: Db;
  root: string;
  owner: PostgresAuthorityBinding;
  identity: DurableRecoveryIdentity;
  agentId: string;
  runnerBinary: string;
  maxOutboxBytes: number;
  p0ReserveBytes: number;
  fenceId: string;
  lease: { owner: string; attempt: number };
  assertStoppedProcessTree(): Promise<void>;
}): Promise<void> {
  const { owner, identity } = input;
  if (identity.runId !== owner.runId || identity.runnerInstanceId !== owner.runnerInstanceId || identity.normalizedSessionId !== owner.normalizedSessionId || identity.environmentLeaseId !== owner.environmentLeaseId) throw new Error("native_legacy_migration_binding_mismatch");
  if (!Number.isSafeInteger(input.maxOutboxBytes) || input.maxOutboxBytes <= 0 || input.maxOutboxBytes > 512 * 1024 * 1024 ||
      !Number.isSafeInteger(input.p0ReserveBytes) || input.p0ReserveBytes <= 0 || input.p0ReserveBytes >= input.maxOutboxBytes) throw new Error("native_legacy_migration_capacity_invalid");
  const maintenance = await startNativeLegacyMigrationLease(input);
  const { assertLease } = maintenance;
  try {
    const authority = createNativePostgresAuthorityStore(input.db, owner, input.agentId, async tx => { await assertLease(tx); });
    const artifact = readRunnerdArtifactBinding(input.runnerBinary);
    await migrateLegacySessionAuthority({
      root: input.root, identity, authority, fenceId: input.fenceId, runnerBinary: input.runnerBinary,
      assertExclusiveFence: async () => { await assertLease(); await input.assertStoppedProcessTree(); await assertLease(); },
      prepareLocal: async destination => {
        await assertLease();
        const preparation = execute(input.runnerBinary, ["storage", "stage-legacy",
          "--state-dir", resolve(input.root, "runner"), "--destination", destination, "--fence-id", input.fenceId,
          "--connect-url", `ws://127.0.0.1:1/api/runner/v1/connect/${identity.runId}`,
          "--runner-version", artifact.version, "--runner-digest", artifact.digest,
          "--runner-id", identity.runnerInstanceId, "--environment-lease-id", identity.environmentLeaseId,
          "--session-id", identity.normalizedSessionId, "--run-id", identity.runId, "--turn-id", identity.turnId, "--item-id", identity.itemId,
          "--max-outbox-bytes", String(input.maxOutboxBytes), "--p0-reserve-bytes", String(input.p0ReserveBytes),
        ], { maxBuffer: 128 * 1024, signal: maintenance.signal, killSignal: "SIGKILL", env: { PATH: process.env.PATH, LANG: "C.UTF-8" } });
        // An AbortError can precede child exit. Keep the migration lifetime
        // until the native storage writer is actually reaped.
        const closed = new Promise<void>(resolve => preparation.child.once("close", () => resolve()));
        let stdout: string;
        try { ({ stdout } = await preparation); } finally { await closed; }
        await assertLease();
        // The session coordinator validates every returned field against the
        // actual staged stores. No provider credentials cross this subprocess.
        return JSON.parse(stdout) as PreparedLocalSession;
      },
    });
    await maintenance.assert();
  } catch (error) {
    // Preserve lease loss rather than reporting the subprocess's derivative
    // AbortError. Staging never launches provider children or publishes peers.
    maintenance.assertKnown();
    throw error;
  } finally { await maintenance.stop(); }
}
