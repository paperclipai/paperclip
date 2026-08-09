import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  agentOwnershipGrants,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  authorizationService,
  resetAgentOwnershipEnforcementColumnWarnedForTests,
} from "../services/authorization.js";
import { companyService } from "../services/companies.js";
import { agentOwnershipService } from "../services/agent-ownership.js";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";

/**
 * TECH-4930 stage 2: agent-ownership enforcement.
 *
 * These tests exercise the single central gate --
 * `applyAgentOwnershipEnforcement` inside `authorizationService(db).decide()`
 * -- directly, plus the two places that consult the same
 * `companies.enforce_agent_ownership` flag and ownership-grant data:
 * `companyService.update` (refuses to enable enforcement over unowned
 * agents) and `agentOwnershipService.buildEnforcementDryRunReport` (the
 * read-only preview of the same data before an admin flips the flag).
 *
 * Route-level wiring for each of the six call sites this backs is covered
 * by targeted tests in agent-permissions-routes.test.ts (wakeup/heartbeat-
 * invoke), issue-closed-workspace-routes.test.ts (comment,
 * checkout-already-assignee), issue-scheduled-retry-routes.test.ts
 * (retry-now), and approval-routes-idempotency.test.ts (approve/reject).
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-ownership enforcement tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("agent-ownership enforcement (TECH-4930 stage 2)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-ownership-enforcement-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentOwnershipGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
    // The 42703 warn-once dedup Set in authorization.ts is module-scoped and
    // otherwise leaks state across tests/companyIds within this process.
    resetAgentOwnershipEnforcementColumnWarnedForTests();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(overrides: Partial<typeof companies.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: `Enforcement ${randomUUID()}`,
      issuePrefix: `E${randomUUID().slice(0, 6).toUpperCase()}`,
      enforceAgentOwnership: false,
      ...overrides,
    });
    return id;
  }

  async function seedAgent(companyId: string, name = "Builder") {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function grantOwner(companyId: string, agentId: string, userId: string) {
    await db.insert(agentOwnershipGrants).values({
      companyId,
      agentId,
      principalType: "user",
      principalId: userId,
      role: "owner",
      source: "agent_create",
    });
  }

  async function activeMembership(companyId: string, userId: string, membershipRole = "member") {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole,
    });
  }

  function boardActor(companyId: string, userId: string) {
    return {
      type: "board" as const,
      userId,
      companyIds: [companyId],
      isInstanceAdmin: false,
      source: "session" as const,
    };
  }

  /**
   * Wraps `baseDb` so that only the exact query
   * `agentOwnershipEnforcementEnabled` issues -- `select({ enforceAgentOwnership:
   * companies.enforceAgentOwnership }).from(companies).where(...)` -- rejects
   * with `error`. Every other query (agents, companyMemberships,
   * agentOwnershipGrants, or any other `companies` shape) passes through to
   * the real `baseDb` untouched. This lets a test inject a fault at the
   * precise boundary the function under test reads, instead of breaking an
   * entire table and hoping nothing else in the `decide()` call graph
   * touches it.
   */
  function dbThatFailsEnforcementColumnQuery(baseDb: typeof db, error: unknown): typeof db {
    return new Proxy(baseDb, {
      get(target, prop, receiver) {
        if (prop === "select") {
          return (config?: unknown) => {
            const isEnforcementColumnQuery =
              typeof config === "object" &&
              config !== null &&
              (config as Record<string, unknown>).enforceAgentOwnership === companies.enforceAgentOwnership;
            if (isEnforcementColumnQuery) {
              return {
                from() {
                  return {
                    where() {
                      return Promise.reject(error);
                    },
                  };
                },
              };
            }
            const realSelect = Reflect.get(target, "select", target) as (...args: unknown[]) => unknown;
            return config === undefined ? realSelect.apply(target, []) : realSelect.apply(target, [config]);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;
  }

  describe("agent:wake ownership boundary", () => {
    it("allows a board actor without any grant when enforcement is off (byte-identical default)", async () => {
      const companyId = await seedCompany({ enforceAgentOwnership: false });
      const agentId = await seedAgent(companyId);
      await grantOwner(companyId, agentId, "the-owner");

      const decision = await authorizationService(db).decide({
        actor: boardActor(companyId, "some-other-member"),
        action: "agent:wake",
        resource: { type: "agent", companyId, agentId },
      });

      expect(decision.allowed).toBe(true);
    });

    it("denies a board actor without a grant once enforcement is on", async () => {
      const companyId = await seedCompany({ enforceAgentOwnership: true });
      const agentId = await seedAgent(companyId);
      await grantOwner(companyId, agentId, "the-owner");

      const decision = await authorizationService(db).decide({
        actor: boardActor(companyId, "some-other-member"),
        action: "agent:wake",
        resource: { type: "agent", companyId, agentId },
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("deny_agent_ownership_required");
      expect(decision.code).toBe("AGENT_OWNERSHIP_REQUIRED");
    });

    it("allows a board actor holding an active grant once enforcement is on", async () => {
      const companyId = await seedCompany({ enforceAgentOwnership: true });
      const agentId = await seedAgent(companyId);
      await grantOwner(companyId, agentId, "the-owner");

      const decision = await authorizationService(db).decide({
        actor: boardActor(companyId, "the-owner"),
        action: "agent:wake",
        resource: { type: "agent", companyId, agentId },
      });

      expect(decision.allowed).toBe(true);
    });

    it("allows a non-owner role (admin/user), not just the owner, once enforcement is on", async () => {
      const companyId = await seedCompany({ enforceAgentOwnership: true });
      const agentId = await seedAgent(companyId);
      await grantOwner(companyId, agentId, "the-owner");
      await db.insert(agentOwnershipGrants).values({
        companyId,
        agentId,
        principalType: "user",
        principalId: "the-admin",
        role: "admin",
        source: "manual_grant",
      });

      const decision = await authorizationService(db).decide({
        actor: boardActor(companyId, "the-admin"),
        action: "agent:wake",
        resource: { type: "agent", companyId, agentId },
      });

      expect(decision.allowed).toBe(true);
    });

    it("keeps the self-actor carve-out unconditionally, enforcement on or off", async () => {
      const companyId = await seedCompany({ enforceAgentOwnership: true });
      const agentId = await seedAgent(companyId);
      // Deliberately no ownership grant on this agent at all.

      const decision = await authorizationService(db).decide({
        actor: { type: "agent", agentId, companyId, source: "agent_jwt" },
        action: "agent:wake",
        resource: { type: "agent", companyId, agentId },
      });

      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe("allow_self");
    });

    it("does not narrow a decision that was already denied for an unrelated reason", async () => {
      const companyId = await seedCompany({ enforceAgentOwnership: true });
      const otherCompanyId = await seedCompany({ enforceAgentOwnership: true });
      const agentId = await seedAgent(companyId);
      await grantOwner(companyId, agentId, "the-owner");

      // Actor's company does not match the target agent's company: denied
      // by the existing company-boundary check in decideBase, well before
      // the ownership intersection ever runs.
      const decision = await authorizationService(db).decide({
        actor: { type: "agent", agentId: randomUUID(), companyId: otherCompanyId, source: "agent_jwt" },
        action: "agent:wake",
        resource: { type: "agent", companyId, agentId },
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reason).not.toBe("deny_agent_ownership_required");
    });
  });

  describe("agentOwnershipEnforcementEnabled: 42703 undefined_column fallback", () => {
    it("treats a missing enforce_agent_ownership column (42703) as enforcement-off rather than throwing", async () => {
      const companyId = await seedCompany({ enforceAgentOwnership: false });
      const agentId = await seedAgent(companyId);
      await grantOwner(companyId, agentId, "the-owner");

      await db.execute(sql`alter table companies drop column enforce_agent_ownership`);
      try {
        const decision = await authorizationService(db).decide({
          actor: boardActor(companyId, "some-other-member"),
          action: "agent:wake",
          resource: { type: "agent", companyId, agentId },
        });

        // Column not there yet (e.g. pre-migration) -> falls back to the
        // column's own DEFAULT false, i.e. enforcement disabled, matching
        // the "enforcement off" behavior asserted above rather than
        // throwing and breaking every agent:wake decision.
        expect(decision.allowed).toBe(true);
      } finally {
        await db.execute(
          sql`alter table companies add column enforce_agent_ownership boolean not null default false`,
        );
      }
    });

    it("does not swallow an unrelated Postgres error -- it still propagates", async () => {
      const companyId = await seedCompany({ enforceAgentOwnership: true });
      const agentId = await seedAgent(companyId);
      await grantOwner(companyId, agentId, "the-owner");

      // Inject a fault at the exact query boundary `agentOwnershipEnforcementEnabled`
      // itself reads, rather than breaking the whole `companies` table. A
      // table-wide fault (e.g. renaming `companies`) would trip on ANY query
      // that touches `companies` anywhere in the `decide()` call graph, so it
      // can't distinguish a correctly-scoped 42703-only catch from a bug
      // where the catch was accidentally widened into a catch-all (e.g. a
      // bare `catch { return false }`) -- that bug would still let the same
      // error code surface from elsewhere in the graph and pass this
      // assertion. Using a code that is deliberately NOT 42703 (55000,
      // object_not_in_prerequisite_state) on this narrow surface proves the
      // catch block only special-cases undefined_column and rethrows
      // everything else untouched.
      const fakeDriverError = Object.assign(new Error("simulated postgres failure"), { code: "55000" });
      const fakeQueryError = Object.assign(new Error("query failed"), { cause: fakeDriverError });
      const faultyDb = dbThatFailsEnforcementColumnQuery(db, fakeQueryError);

      await expect(
        authorizationService(faultyDb).decide({
          actor: boardActor(companyId, "some-other-member"),
          action: "agent:wake",
          resource: { type: "agent", companyId, agentId },
        }),
      ).rejects.toMatchObject({ cause: { code: "55000" } });
    });

    it("warns only once per companyId across repeated 42703 occurrences, and debug-logs the rest", async () => {
      const companyId = await seedCompany({ enforceAgentOwnership: false });
      const agentId = await seedAgent(companyId);
      await grantOwner(companyId, agentId, "the-owner");

      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
      const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => logger);

      await db.execute(sql`alter table companies drop column enforce_agent_ownership`);
      try {
        const first = await authorizationService(db).decide({
          actor: boardActor(companyId, "some-other-member"),
          action: "agent:wake",
          resource: { type: "agent", companyId, agentId },
        });
        const second = await authorizationService(db).decide({
          actor: boardActor(companyId, "some-other-member"),
          action: "agent:wake",
          resource: { type: "agent", companyId, agentId },
        });

        // Both invocations still correctly fall back to enforcement-disabled
        // behavior (allowed), not just the first one.
        expect(first.allowed).toBe(true);
        expect(second.allowed).toBe(true);

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            companyId,
            postgresErrorCode: "42703",
            column: "companies.enforce_agent_ownership",
          }),
          expect.any(String),
        );

        // The second occurrence is suppressed at warn level but must still
        // produce a debug-level signal -- it must not be silent.
        expect(debugSpy).toHaveBeenCalledTimes(1);
        expect(debugSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            companyId,
            postgresErrorCode: "42703",
            column: "companies.enforce_agent_ownership",
          }),
          expect.any(String),
        );
      } finally {
        warnSpy.mockRestore();
        debugSpy.mockRestore();
        await db.execute(
          sql`alter table companies add column enforce_agent_ownership boolean not null default false`,
        );
      }
    });
  });

  describe("responsibleUserId ownership check (bug fix)", () => {
    async function seedUser(id: string) {
      await db.insert(authUsers).values({
        id,
        name: id,
        email: `${id}@example.com`,
        emailVerified: true,
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    it("off: an agent asserting any responsibleUserId with an active membership is unaffected", async () => {
      const companyId = await seedCompany({ enforceAgentOwnership: false });
      const agentId = await seedAgent(companyId);
      await seedUser("responsible-user");
      await activeMembership(companyId, "responsible-user", "member");

      const decision = await authorizationService(db).decide({
        actor: {
          type: "agent",
          agentId,
          companyId,
          source: "agent_jwt",
          onBehalfOfUserId: "responsible-user",
        },
        action: "company_scope:read",
        resource: { type: "company", companyId },
      });

      expect(decision.allowed).toBe(true);
    });

    it("on: denies asserting a responsibleUserId with no ownership grant on the acting agent", async () => {
      const companyId = await seedCompany({ enforceAgentOwnership: true });
      const agentId = await seedAgent(companyId);
      await seedUser("responsible-user");
      await activeMembership(companyId, "responsible-user", "member");
      // No ownership grant links "responsible-user" to this agent.

      const decision = await authorizationService(db).decide({
        actor: {
          type: "agent",
          agentId,
          companyId,
          source: "agent_jwt",
          onBehalfOfUserId: "responsible-user",
        },
        action: "company_scope:read",
        resource: { type: "company", companyId },
      });

      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe("AGENT_OWNERSHIP_REQUIRED");
    });

    it("on: allows asserting a responsibleUserId who holds an active grant on the acting agent", async () => {
      const companyId = await seedCompany({ enforceAgentOwnership: true });
      const agentId = await seedAgent(companyId);
      await seedUser("responsible-user");
      await activeMembership(companyId, "responsible-user", "member");
      await grantOwner(companyId, agentId, "responsible-user");

      const decision = await authorizationService(db).decide({
        actor: {
          type: "agent",
          agentId,
          companyId,
          source: "agent_jwt",
          onBehalfOfUserId: "responsible-user",
        },
        action: "company_scope:read",
        resource: { type: "company", companyId },
      });

      expect(decision.allowed).toBe(true);
    });
  });

  describe("companyService.update: refuse to enable over unowned agents", () => {
    it("refuses to flip enforceAgentOwnership on while any agent has zero active owner grants", async () => {
      const companyId = await seedCompany({ enforceAgentOwnership: false });
      const ownedAgentId = await seedAgent(companyId, "Owned");
      const unownedAgentId = await seedAgent(companyId, "Unowned");
      await grantOwner(companyId, ownedAgentId, "the-owner");

      const svc = companyService(db);
      await expect(svc.update(companyId, { enforceAgentOwnership: true })).rejects.toMatchObject({
        status: 422,
      });

      try {
        await svc.update(companyId, { enforceAgentOwnership: true });
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).message).toContain("Unowned");
        expect((err as HttpError).message).toContain(unownedAgentId);
      }

      const reloaded = await svc.getById(companyId);
      expect(reloaded?.enforceAgentOwnership).toBe(false);
    });

    it("allows enabling once every agent has an active owner grant", async () => {
      const companyId = await seedCompany({ enforceAgentOwnership: false });
      const agentId = await seedAgent(companyId);
      await grantOwner(companyId, agentId, "the-owner");

      const svc = companyService(db);
      const updated = await svc.update(companyId, { enforceAgentOwnership: true });
      expect(updated?.enforceAgentOwnership).toBe(true);
    });

    it("allows updating unrelated fields without re-triggering the ownership check", async () => {
      const companyId = await seedCompany({ enforceAgentOwnership: false });
      await seedAgent(companyId, "Unowned"); // no grant at all

      const svc = companyService(db);
      const updated = await svc.update(companyId, { name: "Renamed Co" });
      expect(updated?.name).toBe("Renamed Co");
      expect(updated?.enforceAgentOwnership).toBe(false);
    });
  });

  describe("buildEnforcementDryRunReport", () => {
    it("reports unowned agents and, for owned agents, which non-viewer members would lose access", async () => {
      const companyId = await seedCompany({ enforceAgentOwnership: false });
      const ownedAgentId = await seedAgent(companyId, "Owned");
      const unownedAgentId = await seedAgent(companyId, "Unowned");
      await grantOwner(companyId, ownedAgentId, "the-owner");
      await activeMembership(companyId, "the-owner", "member");
      await activeMembership(companyId, "another-member", "member");
      await activeMembership(companyId, "a-viewer", "viewer");

      const report = await agentOwnershipService(db).buildEnforcementDryRunReport(companyId);

      expect(report.readyToEnable).toBe(false);
      expect(report.unownedAgents.map((a) => a.id)).toEqual([unownedAgentId]);

      const ownedEntry = report.impactedAgents.find((a) => a.agentId === ownedAgentId);
      expect(ownedEntry).toBeDefined();
      expect(ownedEntry?.ownerUserId).toBe("the-owner");
      // "the-owner" holds a grant, so only "another-member" would lose access.
      // Viewers are excluded because they never had run-triggering access to
      // begin with.
      expect(ownedEntry?.wouldLoseAccess.map((row) => row.userId)).toEqual(["another-member"]);
    });

    it("is ready to enable and reports no impacted members once every agent is owned and every member has a grant", async () => {
      const companyId = await seedCompany({ enforceAgentOwnership: false });
      const agentId = await seedAgent(companyId);
      await grantOwner(companyId, agentId, "the-owner");
      await activeMembership(companyId, "the-owner", "member");

      const report = await agentOwnershipService(db).buildEnforcementDryRunReport(companyId);

      expect(report.readyToEnable).toBe(true);
      expect(report.unownedAgents).toEqual([]);
      expect(report.impactedAgents).toEqual([]);
    });
  });
});
