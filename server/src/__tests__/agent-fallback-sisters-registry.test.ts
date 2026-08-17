import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentFallbackSisters, agents, companies, companyMemberships, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent fallback sister registry tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * TSMC-20938: POST /companies/:companyId/agent-fallback-sisters used to return
 * a blind 500 when the write collided with the production registry guards —
 * the partial unique index (one ACTIVE lane per sister) or the lane-topology
 * trigger (an active sister cannot also become a primary). The route now
 * pre-flights both shapes and answers 409 naming the claiming lane.
 *
 * The registry guards are created by repo migration
 * 9013_agent_fallback_sisters_registry_guards.sql, which the embedded-postgres
 * harness applies via applyPendingMigrations — so this suite exercises the
 * migration-created objects directly (no manual recreation): if the
 * route-level pre-checks ever regress, these scenarios degrade to the raw
 * database rejection instead of silently passing.
 */
describeEmbeddedPostgres("agent fallback sister registry conflicts", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-fallback-registry-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWithAgents(agentNames: string[]) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Fallback Registry Co",
      issuePrefix: `FR${companyId.replaceAll("-", "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });

    const agentIds: string[] = [];
    for (const name of agentNames) {
      const agentId = randomUUID();
      agentIds.push(agentId);
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    return { companyId, agentIds };
  }

  it("registers a fresh primary/sister pair with 201", async () => {
    const { companyId, agentIds: [primaryId, sisterId] } = await seedCompanyWithAgents([
      "Primary Lane",
      "Sister Lane",
    ]);

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/agent-fallback-sisters`)
      .send({ primaryAgentId: primaryId, sisterAgentId: sisterId, priority: 1 });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      companyId,
      primaryAgentId: primaryId,
      sisterAgentId: sisterId,
      priority: 1,
      revokedAt: null,
    });
  });

  it("returns 409 naming the claiming primary when the sister already actively backs another lane", async () => {
    const { companyId, agentIds: [claimantPrimaryId, requestedPrimaryId, sisterId] } =
      await seedCompanyWithAgents(["Claimant Primary", "Requested Primary", "Shared Sister"]);

    // The sister already actively backs the claimant primary, and the requested
    // pair exists as a REVOKED row — the exact un-revoke upsert shape that used
    // to blow up on the partial unique index with a blind 500.
    await db.insert(agentFallbackSisters).values([
      {
        companyId,
        primaryAgentId: claimantPrimaryId,
        sisterAgentId: sisterId,
        priority: 0,
        createdBy: "test-seed",
        revokedAt: null,
      },
      {
        companyId,
        primaryAgentId: requestedPrimaryId,
        sisterAgentId: sisterId,
        priority: 0,
        createdBy: "test-seed",
        revokedAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    ]);

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/agent-fallback-sisters`)
      .send({ primaryAgentId: requestedPrimaryId, sisterAgentId: sisterId });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toContain(claimantPrimaryId);
    expect(res.body.error).toContain("Claimant Primary");

    // The revoked row must stay revoked — no partial un-revoke.
    const stored = await db
      .select({ revokedAt: agentFallbackSisters.revokedAt })
      .from(agentFallbackSisters)
      .where(and(
        eq(agentFallbackSisters.companyId, companyId),
        eq(agentFallbackSisters.primaryAgentId, requestedPrimaryId),
        eq(agentFallbackSisters.sisterAgentId, sisterId),
      ))
      .then((rows) => rows[0] ?? null);
    expect(stored?.revokedAt).not.toBeNull();
  });

  it("returns 409 naming the lane primary when the requested primary is itself an active sister elsewhere", async () => {
    const { companyId, agentIds: [lanePrimaryId, requestedPrimaryId, sisterId] } =
      await seedCompanyWithAgents(["Lane Primary", "Requested Primary", "New Sister"]);

    // The requested primary already serves as an ACTIVE sister in another lane —
    // the shape the lane-topology trigger rejects with a raw 500 today.
    await db.insert(agentFallbackSisters).values({
      companyId,
      primaryAgentId: lanePrimaryId,
      sisterAgentId: requestedPrimaryId,
      priority: 0,
      createdBy: "test-seed",
      revokedAt: null,
    });

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/agent-fallback-sisters`)
      .send({ primaryAgentId: requestedPrimaryId, sisterAgentId: sisterId });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toContain(lanePrimaryId);
    expect(res.body.error).toContain("Lane Primary");

    // Nothing was written for the rejected pair.
    const stored = await db
      .select({ id: agentFallbackSisters.id })
      .from(agentFallbackSisters)
      .where(and(
        eq(agentFallbackSisters.companyId, companyId),
        eq(agentFallbackSisters.primaryAgentId, requestedPrimaryId),
        eq(agentFallbackSisters.sisterAgentId, sisterId),
      ));
    expect(stored).toHaveLength(0);
  });

  it("re-registers a revoked pair with no conflicts as 201 with revoked_at null", async () => {
    const { companyId, agentIds: [primaryId, sisterId] } = await seedCompanyWithAgents([
      "Returning Primary",
      "Returning Sister",
    ]);

    await db.insert(agentFallbackSisters).values({
      companyId,
      primaryAgentId: primaryId,
      sisterAgentId: sisterId,
      priority: 3,
      createdBy: "test-seed",
      revokedAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/agent-fallback-sisters`)
      .send({ primaryAgentId: primaryId, sisterAgentId: sisterId, priority: 2 });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      companyId,
      primaryAgentId: primaryId,
      sisterAgentId: sisterId,
      priority: 2,
      revokedAt: null,
    });

    const stored = await db
      .select({
        revokedAt: agentFallbackSisters.revokedAt,
        priority: agentFallbackSisters.priority,
      })
      .from(agentFallbackSisters)
      .where(and(
        eq(agentFallbackSisters.companyId, companyId),
        eq(agentFallbackSisters.primaryAgentId, primaryId),
        eq(agentFallbackSisters.sisterAgentId, sisterId),
      ))
      .then((rows) => rows[0] ?? null);
    expect(stored?.revokedAt).toBeNull();
    expect(stored?.priority).toBe(2);
  });
});
