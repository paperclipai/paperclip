import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  crossCompanyGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { authorizationService } from "../services/authorization.js";
import { crossCompanyGrantService, crossCompanyGrantsEnabled, scopeMatches } from "../services/cross-company-grants.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createCompany(db: ReturnType<typeof createDb>, label: string) {
  return db
    .insert(companies)
    .values({
      name: `CCG ${label} ${randomUUID()}`,
      issuePrefix: `CG${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(db: ReturnType<typeof createDb>, companyId: string) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Agent ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

describe("scopeMatches", () => {
  it("allows all resources when scope is null", () => {
    expect(scopeMatches(null, { type: "company", companyId: "c1" })).toBe(true);
  });

  it("rejects unknown scope keys", () => {
    expect(
      scopeMatches({ secretId: "x" }, { type: "company", companyId: "c1" }),
    ).toBe(false);
  });
});

describeEmbeddedPostgres("cross-company grants authorization", () => {
  let db: ReturnType<typeof createDb>;
  let previousFlag: string | undefined;

  beforeAll(async () => {
    db = await startEmbeddedPostgresTestDatabase();
  });

  afterEach(async () => {
    await db.delete(crossCompanyGrants);
    if (previousFlag === undefined) {
      delete process.env.PAPERCLIP_CROSS_COMPANY_GRANTS;
    } else {
      process.env.PAPERCLIP_CROSS_COMPANY_GRANTS = previousFlag;
    }
  });

  it("denies cross-company access when flag is off", async () => {
    previousFlag = process.env.PAPERCLIP_CROSS_COMPANY_GRANTS;
    delete process.env.PAPERCLIP_CROSS_COMPANY_GRANTS;

    const home = await createCompany(db, "home");
    const target = await createCompany(db, "target");
    const grantee = await createAgent(db, home.id);

    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: grantee.id, companyId: home.id },
      action: "issue:read",
      resource: { type: "company", companyId: target.id },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("deny_company_boundary");
    expect(crossCompanyGrantsEnabled()).toBe(false);
  });

  it("allows issue:read with an active cross-company grant", async () => {
    previousFlag = process.env.PAPERCLIP_CROSS_COMPANY_GRANTS;
    process.env.PAPERCLIP_CROSS_COMPANY_GRANTS = "enabled";

    const home = await createCompany(db, "home");
    const target = await createCompany(db, "target");
    const grantee = await createAgent(db, home.id);

    await db.insert(crossCompanyGrants).values({
      targetCompanyId: target.id,
      granteeAgentId: grantee.id,
      granteeHomeCompanyId: home.id,
      actions: ["issue:read", "project:read"],
      scope: null,
      status: "active",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: grantee.id, companyId: home.id },
      action: "issue:read",
      resource: { type: "company", companyId: target.id },
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("allow_cross_company_grant");
  });

  it("denies actions outside the grant allowlist", async () => {
    previousFlag = process.env.PAPERCLIP_CROSS_COMPANY_GRANTS;
    process.env.PAPERCLIP_CROSS_COMPANY_GRANTS = "enabled";

    const home = await createCompany(db, "home");
    const target = await createCompany(db, "target");
    const grantee = await createAgent(db, home.id);

    await db.insert(crossCompanyGrants).values({
      targetCompanyId: target.id,
      granteeAgentId: grantee.id,
      granteeHomeCompanyId: home.id,
      actions: ["issue:read"],
      scope: null,
      status: "active",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: grantee.id, companyId: home.id },
      action: "issue:mutate",
      resource: { type: "company", companyId: target.id },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("deny_company_boundary");
  });

  it("denies when budget cap is exceeded", async () => {
    previousFlag = process.env.PAPERCLIP_CROSS_COMPANY_GRANTS;
    process.env.PAPERCLIP_CROSS_COMPANY_GRANTS = "enabled";

    const home = await createCompany(db, "home");
    const target = await createCompany(db, "target");
    const grantee = await createAgent(db, home.id);

    await db.insert(crossCompanyGrants).values({
      targetCompanyId: target.id,
      granteeAgentId: grantee.id,
      granteeHomeCompanyId: home.id,
      actions: ["issue:mutate"],
      scope: null,
      budgetCapCents: 100,
      budgetSpentCents: 100,
      status: "active",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: grantee.id, companyId: home.id },
      action: "issue:mutate",
      resource: { type: "company", companyId: target.id },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("deny_budget_exceeded");
  });

  it("marks expired grants and denies access", async () => {
    previousFlag = process.env.PAPERCLIP_CROSS_COMPANY_GRANTS;
    process.env.PAPERCLIP_CROSS_COMPANY_GRANTS = "enabled";

    const home = await createCompany(db, "home");
    const target = await createCompany(db, "target");
    const grantee = await createAgent(db, home.id);

    const [grant] = await db
      .insert(crossCompanyGrants)
      .values({
        targetCompanyId: target.id,
        granteeAgentId: grantee.id,
        granteeHomeCompanyId: home.id,
        actions: ["issue:read"],
        scope: null,
        status: "active",
        expiresAt: new Date(Date.now() - 1000),
      })
      .returning();

    const service = crossCompanyGrantService(db);
    const active = await service.findActiveCrossCompanyGrant({
      granteeAgentId: grantee.id,
      targetCompanyId: target.id,
    });
    expect(active).toBeNull();

    const row = await db
      .select()
      .from(crossCompanyGrants)
      .where(eq(crossCompanyGrants.id, grant!.id))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("expired");
  });
});
