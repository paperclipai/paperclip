import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  DEFAULT_WATCHDOG_RESUME_WARMUP_MS,
  isCompanyWatchdogPaused,
} from "../services/recovery/pause-aware-guard.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("pause-aware watchdog guard", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pause-aware-guard-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("suppresses watchdogs while paused and during resume warm-up", async () => {
    const companyId = randomUUID();
    const now = new Date("2026-05-15T12:00:00.000Z");
    await db.insert(companies).values({
      id: companyId,
      name: "Pause Co",
      issuePrefix: "PAU",
      status: "paused",
      pausedAt: new Date(now.getTime() - 60_000),
    });

    await expect(isCompanyWatchdogPaused(db, companyId, now)).resolves.toBe(true);

    await db
      .update(companies)
      .set({
        status: "active",
        pausedAt: null,
        resumedAt: new Date(now.getTime() - DEFAULT_WATCHDOG_RESUME_WARMUP_MS + 1_000),
      })
      .where(eq(companies.id, companyId));
    await expect(isCompanyWatchdogPaused(db, companyId, now)).resolves.toBe(true);

    await db
      .update(companies)
      .set({ resumedAt: new Date(now.getTime() - DEFAULT_WATCHDOG_RESUME_WARMUP_MS - 1_000) })
      .where(eq(companies.id, companyId));
    await expect(isCompanyWatchdogPaused(db, companyId, now)).resolves.toBe(false);
  });
});
