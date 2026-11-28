import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createDb } from "./client.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(
    `Skipping idle-in-transaction timeout tests on this host: ${support.reason ?? "unsupported environment"}`,
  );
}

const ADVISORY_LOCK_KEY = 87_236_401;

describeEmbeddedPostgres("createDb idle-in-transaction timeout", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-idle-xact-");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  afterAll(async () => {
    await database?.cleanup();
  });

  it("sets idle_in_transaction_session_timeout to 30s on new backends", async () => {
    const db = createDb(database.connectionString);
    cleanups.push(async () => {
      await db.$client.end({ timeout: 1 });
    });
    const [shown] = await db.$client`show idle_in_transaction_session_timeout`;
    expect(shown?.idle_in_transaction_session_timeout).toBe("30s");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("aborts a session that stays idle in a transaction and releases its locks", async () => {
    const observer = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => {
      await observer.end({ timeout: 1 });
    });

    const db = createDb(database.connectionString, {
      maxConnections: 1,
      idleInTransactionSessionTimeoutMs: 1_000,
      applicationName: "paperclip-idle-xact-holder",
    });
    const swallowClosed = (reason: unknown, promise: Promise<unknown>) => {
      if (reason && typeof reason === "object" && "code" in reason && (reason as { code?: string }).code === "CONNECTION_CLOSED") {
        promise.catch(() => {});
      }
    };
    process.on("unhandledRejection", swallowClosed);
    cleanups.push(async () => {
      process.removeListener("unhandledRejection", swallowClosed);
      await db.$client.end({ timeout: 1 });
    });

    let released = false;
    let resolveHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      resolveHold = resolve;
    });
    const releaseHold = () => {
      if (released) return;
      released = true;
      resolveHold();
    };
    const holder = db.$client.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`;
      await hold;
    }).then(
      () => ({ settled: "fulfilled" as const }),
      (error: unknown) => ({ settled: "rejected" as const, error }),
    );
    cleanups.push(async () => {
      releaseHold();
      await holder;
    });

    const seenDeadline = Date.now() + 5_000;
    let pid: number | undefined;
    while (Date.now() < seenDeadline) {
      const rows = await observer<{ pid: number }[]>`
        select pid from pg_stat_activity
        where application_name = 'paperclip-idle-xact-holder'
          and state = 'idle in transaction'
      `;
      if (rows[0]?.pid) {
        pid = rows[0].pid;
        break;
      }
      await delay(50);
    }
    expect(pid).toEqual(expect.any(Number));

    const goneDeadline = Date.now() + 8_000;
    let gone = false;
    while (Date.now() < goneDeadline) {
      const rows = await observer<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity where pid = ${pid!}
      `;
      if ((rows[0]?.n ?? 1) === 0) {
        gone = true;
        break;
      }
      await delay(50);
    }
    expect(gone).toBe(true);

    await expect(holder).resolves.toMatchObject({ settled: "rejected" });
    releaseHold();
    await delay(100);
    const [ok] = await db.$client`select 1::int as ok`;
    expect(ok?.ok).toBe(1);

    const acquired = await observer.begin(async (tx) => {
      const [row] = await tx<{ got: boolean }[]>`select pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}) as got`;
      return row?.got;
    });
    expect(acquired).toBe(true);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("keeps an idle transaction when the timeout is 0", async () => {
    const db = createDb(database.connectionString, {
      maxConnections: 1,
      idleInTransactionSessionTimeoutMs: 0,
      applicationName: "paperclip-idle-xact-off",
    });
    cleanups.push(async () => {
      await db.$client.end({ timeout: 1 });
    });

    const [shown] = await db.$client`show idle_in_transaction_session_timeout`;
    expect(shown?.idle_in_transaction_session_timeout).toBe("0");

    await db.$client.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`;
      await delay(1_500);
      const [row] = await tx`select 1::int as ok`;
      expect(row?.ok).toBe(1);
    });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
