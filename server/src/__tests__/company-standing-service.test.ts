import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyStanding, createDb, plugins } from "@paperclipai/db";
import {
  closeDbClient,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyStandingService } from "../services/company-standing.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company-standing tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companyStandingService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-standing-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyStanding);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  async function insertCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Standing Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function insertPlugin(key: string) {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: key,
      packageName: `@paperclipai/${key}`,
      version: "1.0.0",
      manifestJson: {
        id: key,
        name: key,
        version: "1.0.0",
        capabilities: ["company.standing.write"],
      } as never,
      status: "ready",
    });
    return pluginId;
  }

  it("returns active when no rows exist (fail-safe default)", async () => {
    const companyId = await insertCompany();
    const service = companyStandingService(db);
    await expect(service.getEffectiveStanding(companyId)).resolves.toEqual({ status: "active" });
    await expect(service.getEffectiveStandings([companyId])).resolves.toEqual({
      [companyId]: { status: "active" },
    });
    await expect(service.getEffectiveStandings([])).resolves.toEqual({});
  });

  it("upserts one row per (company, plugin) and returns its fields", async () => {
    const companyId = await insertCompany();
    const pluginId = await insertPlugin("paperclip.billing");
    const service = companyStandingService(db);

    await service.setStanding(pluginId, companyId, {
      status: "grace",
      reason: "payment_failed",
      message: "Your last payment failed.",
      actionUrl: "/billing",
    });
    await expect(service.getEffectiveStanding(companyId)).resolves.toEqual({
      status: "grace",
      reason: "payment_failed",
      message: "Your last payment failed.",
      actionUrl: "/billing",
    });

    // Second write from the same plugin replaces, not duplicates.
    await service.setStanding(pluginId, companyId, {
      status: "blocked",
      reason: "subscription_lapsed",
      message: "Subscription lapsed.",
    });
    const rows = await db.select().from(companyStanding);
    expect(rows).toHaveLength(1);
    await expect(service.getEffectiveStanding(companyId)).resolves.toEqual({
      status: "blocked",
      reason: "subscription_lapsed",
      message: "Subscription lapsed.",
    });
  });

  it("merges by severity across plugins: blocked > grace > active", async () => {
    const companyId = await insertCompany();
    const billing = await insertPlugin("paperclip.billing");
    const compliance = await insertPlugin("paperclip.compliance");
    const quota = await insertPlugin("paperclip.quota");
    const service = companyStandingService(db);

    await service.setStanding(billing, companyId, {
      status: "active",
      reason: "ok",
      message: "All good.",
    });
    await service.setStanding(compliance, companyId, {
      status: "grace",
      reason: "review_pending",
      message: "Compliance review pending.",
      actionUrl: "/compliance",
    });
    await expect(service.getEffectiveStanding(companyId)).resolves.toMatchObject({
      status: "grace",
      reason: "review_pending",
    });

    await service.setStanding(quota, companyId, {
      status: "blocked",
      reason: "quota_exceeded",
      message: "Quota exceeded.",
    });
    await expect(service.getEffectiveStanding(companyId)).resolves.toMatchObject({
      status: "blocked",
      reason: "quota_exceeded",
      message: "Quota exceeded.",
    });
  });

  it("clearStanding removes only the calling plugin's row", async () => {
    const companyId = await insertCompany();
    const billing = await insertPlugin("paperclip.billing");
    const compliance = await insertPlugin("paperclip.compliance");
    const service = companyStandingService(db);

    await service.setStanding(billing, companyId, {
      status: "blocked",
      reason: "subscription_lapsed",
      message: "Subscription lapsed.",
    });
    await service.setStanding(compliance, companyId, {
      status: "grace",
      reason: "review_pending",
      message: "Review pending.",
    });

    await service.clearStanding(billing, companyId);
    await expect(service.getEffectiveStanding(companyId)).resolves.toMatchObject({ status: "grace" });

    await service.clearStanding(compliance, companyId);
    await expect(service.getEffectiveStanding(companyId)).resolves.toEqual({ status: "active" });
  });

  it("clearAllForPlugin deletes the plugin's rows across all companies", async () => {
    const companyA = await insertCompany();
    const companyB = await insertCompany();
    const billing = await insertPlugin("paperclip.billing");
    const service = companyStandingService(db);

    await service.setStanding(billing, companyA, {
      status: "blocked",
      reason: "subscription_lapsed",
      message: "Lapsed.",
    });
    await service.setStanding(billing, companyB, {
      status: "grace",
      reason: "payment_failed",
      message: "Failed.",
    });

    await service.clearAllForPlugin(billing);
    await expect(service.getEffectiveStandings([companyA, companyB])).resolves.toEqual({
      [companyA]: { status: "active" },
      [companyB]: { status: "active" },
    });
  });

  it("getEffectiveStandings scopes rows to the requested companies", async () => {
    const companyA = await insertCompany();
    const companyB = await insertCompany();
    const billing = await insertPlugin("paperclip.billing");
    const service = companyStandingService(db);

    await service.setStanding(billing, companyB, {
      status: "blocked",
      reason: "subscription_lapsed",
      message: "Lapsed.",
    });

    await expect(service.getEffectiveStandings([companyA])).resolves.toEqual({
      [companyA]: { status: "active" },
    });
  });

  it("rejects invalid input", async () => {
    const companyId = await insertCompany();
    const billing = await insertPlugin("paperclip.billing");
    const service = companyStandingService(db);

    await expect(
      service.setStanding(billing, companyId, {
        status: "frozen" as never,
        reason: "x",
        message: "y",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.setStanding(billing, companyId, { status: "blocked", reason: "", message: "y" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.setStanding(billing, companyId, { status: "blocked", reason: "x", message: "  " }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
