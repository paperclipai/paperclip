import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { IsolatedRepositorySourceBusy, withIsolatedRepositorySourceLock } from "./isolated-remote-workspace-source.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Workspace source lock tests require Postgres: ${support.reason}`);

describePostgres("workspace source ownership during preparation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("workspace-source-lock-");
    db = createDb(database.connectionString, { maxConnections: 1 });
    const rows = await db.execute(sql`select current_user as name`);
    const role = String(rows[0].name);
    await db.execute(sql`alter role ${sql.identifier(role)} set idle_in_transaction_session_timeout = '1s'`);
  });

  afterAll(async () => {
    try {
      await db?.$client.end({ timeout: 1 });
    } finally {
      await database?.cleanup();
    }
  });

  it("keeps preparation exclusive beyond the idle timeout while the ordinary pool stays usable", async () => {
    const companyId = randomUUID(), issueId = randomUUID();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const preparation = withIsolatedRepositorySourceLock(db, companyId, issueId, async () => {
      await db.execute(sql`select 1`);
      entered();
      await pending;
      return withIsolatedRepositorySourceLock(db, companyId, issueId, async () => "prepared");
    }).then(value => ({ value }), error => ({ error }));

    try {
      await started;
      await delay(1400);
      await expect(db.execute(sql`select 1 as usable`)).resolves.toMatchObject([{ usable: 1 }]);
      await expect(withIsolatedRepositorySourceLock(db, companyId, issueId, async () => "overlap", true))
        .rejects.toBeInstanceOf(IsolatedRepositorySourceBusy);
      await expect(withIsolatedRepositorySourceLock(db, randomUUID(), issueId, async () => "independent", true))
        .resolves.toBe("independent");
    } finally {
      release();
      await preparation;
    }
    expect(await preparation).toEqual({ value: "prepared" });
    await expect(withIsolatedRepositorySourceLock(db, companyId, issueId, async () => "next", true))
      .resolves.toBe("next");
  });

  it("releases a failed preparation and preserves the original failure", async () => {
    const companyId = randomUUID(), issueId = randomUUID();
    const failure = new Error("source preparation failed");
    await expect(withIsolatedRepositorySourceLock(db, companyId, issueId, async () => {
      await delay(1400);
      throw failure;
    })).rejects.toBe(failure);
    await expect(withIsolatedRepositorySourceLock(db, companyId, issueId, async () => "recovered", true))
      .resolves.toBe("recovered");
  });
});
