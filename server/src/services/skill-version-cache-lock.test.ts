import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { SkillCacheBusy, withSkillVersionCacheLock } from "./skill-version-cache.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skill version cache lock tests require Postgres: ${support.reason}`);

describePostgres("skill version cache lock during slow preparation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("skill-version-cache-lock-");
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

  it("keeps the lock beyond the idle timeout while preparation uses the ordinary pool", async () => {
    const companyId = randomUUID();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const preparation = withSkillVersionCacheLock(db, companyId, async () => {
      await db.execute(sql`select 1`);
      entered();
      await pending;
      return "prepared";
    }).then(value => ({ value }), error => ({ error }));

    try {
      await started;
      await delay(1400);
      await expect(db.execute(sql`select 1 as usable`)).resolves.toMatchObject([{ usable: 1 }]);
      await expect(withSkillVersionCacheLock(db, companyId, async () => "overlap", true))
        .rejects.toBeInstanceOf(SkillCacheBusy);
      await expect(withSkillVersionCacheLock(db, randomUUID(), async () => "independent", true))
        .resolves.toBe("independent");
    } finally {
      release();
      await preparation;
    }
    expect(await preparation).toEqual({ value: "prepared" });
    await expect(withSkillVersionCacheLock(db, companyId, async () => "next", true)).resolves.toBe("next");
  });

  it("releases a failed preparation and preserves the original failure", async () => {
    const companyId = randomUUID();
    const failure = new Error("skill preparation failed");
    await expect(withSkillVersionCacheLock(db, companyId, async () => {
      await delay(1400);
      throw failure;
    })).rejects.toBe(failure);
    await expect(withSkillVersionCacheLock(db, companyId, async () => "recovered", true)).resolves.toBe("recovered");
  });
});
