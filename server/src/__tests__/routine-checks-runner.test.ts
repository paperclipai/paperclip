import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, routineCheckRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { computePreviousStatus } from "../services/routine-checks/runner.ts";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("computePreviousStatus", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("pc-runner-prevstatus-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => { await tempDb?.cleanup(); });
  afterEach(async () => { await db.execute(sql`TRUNCATE TABLE routine_check_runs`); });

  it("returns null when no prior run", async () => {
    const r = await computePreviousStatus({ db, checkName: "x", currentId: "00000000-0000-0000-0000-000000000000" });
    expect(r).toBeNull();
  });

  it("returns latest status by scheduled_for, excluding current id", async () => {
    await db.insert(routineCheckRuns).values([
      { checkName: "x", scheduledFor: new Date("2026-04-30T08:00:00Z"), runAt: new Date(), status: "warn", findings: 1, notifyChannel: "silent", payloadJson: {} },
      { checkName: "x", scheduledFor: new Date("2026-04-30T09:00:00Z"), runAt: new Date(), status: "ok",   findings: 0, notifyChannel: "silent", payloadJson: {} },
    ]);
    const inserted = await db.insert(routineCheckRuns).values({
      checkName: "x", scheduledFor: new Date("2026-04-30T10:00:00Z"), runAt: new Date(), status: "ok", findings: 0, notifyChannel: "silent", payloadJson: {},
    }).returning();
    const r = await computePreviousStatus({ db, checkName: "x", currentId: inserted[0]!.id });
    expect(r).toBe("ok");
  });

  it("ignores rows for other check names", async () => {
    await db.insert(routineCheckRuns).values({
      checkName: "y", scheduledFor: new Date("2026-04-30T09:00:00Z"), runAt: new Date(), status: "error", findings: 5, notifyChannel: "silent", payloadJson: {},
    });
    const r = await computePreviousStatus({ db, checkName: "x", currentId: "00000000-0000-0000-0000-000000000000" });
    expect(r).toBeNull();
  });
});
