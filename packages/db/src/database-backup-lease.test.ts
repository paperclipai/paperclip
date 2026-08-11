import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  __setAfterDurableFenceClaimedForTests,
  tryAcquireDatabaseBackupEmitterLease,
  tryAcquireDatabaseBackupLease,
} from "./database-backup-lease.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("tryAcquireDatabaseBackupLease", () => {
  afterEach(async () => {
    __setAfterDurableFenceClaimedForTests(null);
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it(
    "clears its token-scoped durable fence when acquisition fails after claim",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase(
        "paperclip-backup-claim-cleanup-",
      );
      cleanups.push(database.cleanup);
      const admin = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      cleanups.push(() => admin.end());

      __setAfterDurableFenceClaimedForTests(() => {
        throw new Error("injected post-claim acquisition failure");
      });
      await expect(
        tryAcquireDatabaseBackupLease(database.connectionString),
      ).rejects.toThrow("injected post-claim acquisition failure");
      __setAfterDurableFenceClaimedForTests(null);

      const rows = await admin<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM database_backup_execution_fence
      `;
      expect(rows).toEqual([{ count: 0 }]);

      const replacement = await tryAcquireDatabaseBackupLease(database.connectionString);
      expect(replacement).not.toBeNull();
      if (replacement) cleanups.push(replacement.release);
      await replacement!.release();
    },
    30_000,
  );

  it(
    "keeps emitter leadership singleton without blocking the execution lease",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-backup-lease-");
      cleanups.push(database.cleanup);

      const first = await tryAcquireDatabaseBackupLease(database.connectionString);
      expect(first).not.toBeNull();
      if (first) cleanups.push(first.release);

      const second = await tryAcquireDatabaseBackupLease(database.connectionString);
      expect(second).toBeNull();

      const emitter = await tryAcquireDatabaseBackupEmitterLease(database.connectionString);
      expect(emitter).not.toBeNull();
      if (emitter) cleanups.push(emitter.release);
      expect(emitter?.isHeld()).toBe(true);

      const secondEmitter = await tryAcquireDatabaseBackupEmitterLease(
        database.connectionString,
      );
      expect(secondEmitter).toBeNull();

      await first!.release();
      await first!.release();

      const third = await tryAcquireDatabaseBackupLease(database.connectionString);
      expect(third).not.toBeNull();
      if (third) cleanups.push(third.release);
      await third!.release();

      const emitterLost = emitter!.lost;
      await emitter!.release();
      await emitterLost;
      expect(emitter?.isHeld()).toBe(false);

      const replacementEmitter = await tryAcquireDatabaseBackupEmitterLease(
        database.connectionString,
      );
      expect(replacementEmitter).not.toBeNull();
      if (replacementEmitter) cleanups.push(replacementEmitter.release);
      await replacementEmitter!.release();
    },
    30_000,
  );

  it(
    "reports leadership loss when the PostgreSQL session disappears",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-backup-loss-");
      cleanups.push(database.cleanup);

      const lease = await tryAcquireDatabaseBackupEmitterLease(database.connectionString);
      expect(lease).not.toBeNull();
      if (lease) cleanups.push(lease.release);

      await database.cleanup();
      await expect(
        Promise.race([
          lease!.lost.then(() => "lost"),
          new Promise<string>((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("backup emitter lease did not report connection loss")),
              5_000,
            );
            timer.unref?.();
          }),
        ]),
      ).resolves.toBe("lost");
      expect(lease!.isHeld()).toBe(false);
    },
    30_000,
  );

  it(
    "retains a second execution fence until the cancelled owner releases it",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-backup-fence-");
      cleanups.push(database.cleanup);
      const admin = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      cleanups.push(() => admin.end());

      const first = await tryAcquireDatabaseBackupLease(database.connectionString);
      expect(first).not.toBeNull();
      if (first) cleanups.push(first.release);

      const authoritySessions = await admin<{ pid: number }[]>`
        SELECT pid
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = 'paperclip-database-backup-execution-authority'
      `;
      expect(authoritySessions).toHaveLength(1);
      await admin`SELECT pg_terminate_backend(${authoritySessions[0]!.pid})`;
      await expect(
        Promise.race([
          first!.lost.then(() => "lost"),
          new Promise<string>((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("execution lease did not report authority-session loss")),
              5_000,
            );
            timer.unref?.();
          }),
        ]),
      ).resolves.toBe("lost");

      // The authority session is gone, but the independent fence remains held
      // until the owner has cancelled and joined its pg_dump child.
      const overlapping = await tryAcquireDatabaseBackupLease(database.connectionString);
      expect(overlapping).toBeNull();

      await first!.release();
      const replacement = await tryAcquireDatabaseBackupLease(database.connectionString);
      expect(replacement).not.toBeNull();
      if (replacement) cleanups.push(replacement.release);
      await replacement!.release();
    },
    30_000,
  );

  it(
    "fails closed when every advisory-lock session disappears until the prior owner finishes cleanup",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-backup-total-loss-");
      cleanups.push(database.cleanup);
      const admin = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      cleanups.push(() => admin.end());

      const first = await tryAcquireDatabaseBackupLease(database.connectionString);
      expect(first).not.toBeNull();
      if (first) cleanups.push(first.release);

      const executionSessions = await admin<{ pid: number }[]>`
        SELECT pid
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name IN (
            'paperclip-database-backup-execution-authority',
            'paperclip-database-backup-execution-fence'
          )
      `;
      expect(executionSessions).toHaveLength(2);
      for (const session of executionSessions) {
        await admin`SELECT pg_terminate_backend(${session.pid})`;
      }
      await expect(
        Promise.race([
          first!.lost.then(() => "lost"),
          new Promise<string>((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("execution lease did not report total session loss")),
              5_000,
            );
            timer.unref?.();
          }),
        ]),
      ).resolves.toBe("lost");

      // Advisory locks alone would now be reacquirable. The durable execution
      // marker must keep every replacement fail-closed while the prior owner
      // is still cancelling and joining its backup child.
      await expect(
        tryAcquireDatabaseBackupLease(database.connectionString),
      ).rejects.toMatchObject({ name: "DatabaseBackupFenceConflictError" });

      await first!.release();
      const replacement = await tryAcquireDatabaseBackupLease(database.connectionString);
      expect(replacement).not.toBeNull();
      if (replacement) cleanups.push(replacement.release);
      await replacement!.release();
    },
    30_000,
  );
});
