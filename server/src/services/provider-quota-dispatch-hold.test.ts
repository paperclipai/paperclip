import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns,
  providerQuotaDispatchHolds,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  deferQueuedRunForProviderQuotaHold,
  providerQuotaResetAtFromRun,
  providerQuotaScopeForAgent,
  recordProviderQuotaDispatchHold,
} from "./provider-quota-dispatch-hold.js";

const detectedAt = new Date("2026-10-10T12:00:00.000Z");
const resetAt = new Date("2026-10-15T16:00:00.000Z");

describe("provider quota dispatch hold parsing", () => {
  it("requires a classified quota failure and a future durable reset instant", () => {
    expect(
      providerQuotaResetAtFromRun(
        {
          errorCode: "provider_quota",
          resultJson: { providerQuotaRetryNotBefore: resetAt.toISOString() },
        },
        detectedAt,
      ),
    ).toEqual(resetAt);
    expect(
      providerQuotaResetAtFromRun(
        {
          errorCode: "acpx_turn_failed",
          resultJson: { providerQuotaRetryNotBefore: resetAt.toISOString() },
        },
        detectedAt,
      ),
    ).toBeNull();
    expect(
      providerQuotaResetAtFromRun(
        { errorCode: "provider_quota", resultJson: {} },
        detectedAt,
      ),
    ).toBeNull();
  });

  it("separates multiplexed providers while sharing local provider logins", () => {
    expect(
      providerQuotaScopeForAgent({
        adapterType: "claude_local",
        adapterConfig: {},
      } as typeof agents.$inferSelect),
    ).toMatchObject({ provider: "anthropic" });
    expect(
      providerQuotaScopeForAgent({
        adapterType: "paperclip_runner",
        adapterConfig: { provider: "codex" },
      } as unknown as typeof agents.$inferSelect).scopeKey,
    ).not.toEqual(
      providerQuotaScopeForAgent({
        adapterType: "paperclip_runner",
        adapterConfig: { provider: "claude" },
      } as unknown as typeof agents.$inferSelect).scopeKey,
    );
  });
});

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("provider quota dispatch hold database boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase(
      "paperclip-provider-quota-dispatch-hold",
    );
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  async function fixture() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Quota gate", issuePrefix: "QGT" })
      .returning();
    const [sourceAgent, peerAgent, otherProviderAgent] = await db
      .insert(agents)
      .values([
        {
          companyId: company.id,
          name: "Source",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        {
          companyId: company.id,
          name: "Peer",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        {
          companyId: company.id,
          name: "Other",
          adapterType: "codex_local",
          adapterConfig: {},
        },
      ])
      .returning();
    const [sourceRun] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: sourceAgent.id,
        status: "failed",
        errorCode: "provider_quota",
        resultJson: {
          errorFamily: "provider_quota",
          providerQuotaRetryNotBefore: resetAt.toISOString(),
        },
      })
      .returning();
    return { company, sourceAgent, peerAgent, otherProviderAgent, sourceRun };
  }

  async function queuedRun(
    companyId: string,
    agentId: string,
  ) {
    return db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "queued" })
      .returning()
      .then((rows) => rows[0]!);
  }

  it("parks every peer run on one hold and releases automatically after reset", async () => {
    const f = await fixture();
    const hold = await recordProviderQuotaDispatchHold(db, {
      run: f.sourceRun,
      agent: f.sourceAgent,
      now: detectedAt,
    });
    expect(hold).toMatchObject({ sourceRunId: f.sourceRun.id, releasedAt: null });

    const [olderEvidenceRun] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: f.company.id,
        agentId: f.sourceAgent.id,
        status: "failed",
        errorCode: "provider_quota",
        resultJson: {
          errorFamily: "provider_quota",
          providerQuotaRetryNotBefore: new Date(
            detectedAt.getTime() + 24 * 60 * 60 * 1000,
          ).toISOString(),
        },
      })
      .returning();
    expect(
      await recordProviderQuotaDispatchHold(db, {
        run: olderEvidenceRun,
        agent: f.sourceAgent,
        now: detectedAt,
      }),
    ).toMatchObject({ sourceRunId: f.sourceRun.id, holdUntil: resetAt });

    const peerRun = await queuedRun(f.company.id, f.peerAgent.id);
    const deferred = await deferQueuedRunForProviderQuotaHold(db, {
      run: peerRun,
      agent: f.peerAgent,
      now: detectedAt,
    });
    expect(deferred?.run).toMatchObject({
      status: "scheduled_retry",
      scheduledRetryReason: "provider_quota_hold",
      scheduledRetryAt: resetAt,
      startedAt: null,
    });
    expect(await db.select().from(providerQuotaDispatchHolds)).toHaveLength(1);

    const unrelatedRun = await queuedRun(f.company.id, f.otherProviderAgent.id);
    expect(
      await deferQueuedRunForProviderQuotaHold(db, {
        run: unrelatedRun,
        agent: f.otherProviderAgent,
        now: detectedAt,
      }),
    ).toBeNull();

    const afterResetRun = await queuedRun(f.company.id, f.peerAgent.id);
    expect(
      await deferQueuedRunForProviderQuotaHold(db, {
        run: afterResetRun,
        agent: f.peerAgent,
        now: new Date(resetAt.getTime() + 1),
      }),
    ).toBeNull();
    expect(
      await db
        .select()
        .from(providerQuotaDispatchHolds)
        .where(eq(providerQuotaDispatchHolds.id, hold!.id))
        .then((rows) => rows[0]),
    ).toMatchObject({ releaseReason: "reset_elapsed" });
  });
});
