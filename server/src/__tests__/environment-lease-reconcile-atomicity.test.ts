import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, companies, createDb, environmentLeases, environments, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * The audit write is made to fail on demand. That is the one failure this test
 * needs and the one the database will not produce on its own, because every
 * column the reconciler writes to the activity log is either free text or a key
 * the lease row already guarantees. Everything else here, the transaction
 * included, is real.
 */
const auditWrite: { mode: "ok" | "always_fail" | "fail_first"; calls: number } = { mode: "ok", calls: 0 };

vi.mock("../services/activity-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/activity-log.js")>();
  return {
    ...actual,
    logActivity: async (...args: Parameters<typeof actual.logActivity>) => {
      auditWrite.calls += 1;
      if (auditWrite.mode === "always_fail" || (auditWrite.mode === "fail_first" && auditWrite.calls === 1)) {
        throw new Error("activity write failed");
      }
      return actual.logActivity(...args);
    },
  };
});

const { environmentService } = await import("../services/environments.ts");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres lease reconciliation atomicity tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("reconcileOrphanedLeases atomicity", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof environmentService>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("lease-reconcile-atomicity");
    stopDb = started.stop;
    db = createDb(started.connectionString);
    svc = environmentService(db);
  });

  afterEach(async () => {
    auditWrite.mode = "ok";
    auditWrite.calls = 0;
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(issues);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  let seededCompanies = 0;

  async function seedTerminalIssueLease(name: string) {
    const companyId = randomUUID();
    const environmentId = randomUUID();
    const issueId = randomUUID();
    // The issue prefix is unique per company, so a test that seeds two of them
    // has to state one.
    seededCompanies += 1;
    await db.insert(companies).values({
      id: companyId,
      name,
      status: "active",
      issuePrefix: `T${seededCompanies}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(environments).values({
      id: environmentId,
      name,
      driver: "ssh",
      status: "active",
      config: {
        host: "fixture.example.test",
        port: 22,
        username: "fixture",
        remoteWorkspacePath: "/srv/paperclip",
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue",
      status: "done",
      priority: "medium",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { companyId, environmentId, issueId, lease: await svc.acquireLease({ companyId, environmentId, issueId }) };
  }

  it("leaves the lease active when its audit record cannot be written", async () => {
    const { lease } = await seedTerminalIssueLease("Atomicity Fixture");
    auditWrite.mode = "always_fail";

    const result = await svc.reconcileOrphanedLeases();
    expect(result).toMatchObject({ scanned: 1, released: 0, expired: 0, failed: 1 });

    // A released lease with no audit record could never be repaired: the sweep
    // reads active leases only, so the row would already be out of its reach.
    const [row] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
    expect(row.status).toBe("active");
    expect(row.releasedAt).toBeNull();

    const records = await db.select().from(activityLog).where(eq(activityLog.entityId, lease.id));
    expect(records).toHaveLength(0);
  });

  it("reconciles the lease on the next sweep once the audit write recovers", async () => {
    const { lease } = await seedTerminalIssueLease("Recovery Fixture");
    auditWrite.mode = "always_fail";
    await svc.reconcileOrphanedLeases();

    auditWrite.mode = "ok";
    const result = await svc.reconcileOrphanedLeases();
    expect(result).toMatchObject({ scanned: 1, released: 1, expired: 0, failed: 0 });

    const [row] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
    expect(row.status).toBe("released");

    const [record] = await db.select().from(activityLog).where(eq(activityLog.entityId, lease.id));
    expect(record?.action).toBe("environment.lease_released");
    expect(record?.actorId).toBe("environment-lease-reconciler");
  });

  it("carries on with the rest of the sweep when one lease fails", async () => {
    const first = await seedTerminalIssueLease("Sweep Fixture A");
    const second = await seedTerminalIssueLease("Sweep Fixture B");
    // Fail the first audit write only. Which of the two leases that is does not
    // matter; what matters is that the sweep reaches the other one.
    auditWrite.mode = "fail_first";

    const result = await svc.reconcileOrphanedLeases();
    expect(result).toMatchObject({ scanned: 2, released: 1, expired: 0, failed: 1 });

    const rows = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.status, "released"));
    expect(rows).toHaveLength(1);
    expect([first.lease.id, second.lease.id]).toContain(rows[0].id);
  });
});
