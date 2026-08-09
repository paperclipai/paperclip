import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentOwnershipGrants,
  agentOwnershipTransfers,
  agents,
  companies,
  companyMemberships,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { agentOwnershipService } from "../services/agent-ownership.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent ownership tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent ownership (TECH-4929 stage 1: data model + write-on-create)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-ownership");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentOwnershipTransfers);
    await db.delete(agentOwnershipGrants);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedActiveMembership(companyId: string, userId: string) {
    await db.insert(companyMemberships).values({
      id: randomUUID(),
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
    });
  }

  async function activeOwnerRows(agentId: string) {
    return db
      .select()
      .from(agentOwnershipGrants)
      .where(
        and(
          eq(agentOwnershipGrants.agentId, agentId),
          eq(agentOwnershipGrants.role, "owner"),
          isNull(agentOwnershipGrants.revokedAt),
        ),
      );
  }

  it("writes an owner on every svc.create call that supplies ownerUserId, including the agent-created-agent path", async () => {
    const companyId = await seedCompany();
    const svc = agentService(db);
    const humanUserId = `user-${randomUUID()}`;
    const agentActorUserId = `run-responsible-user-${randomUUID()}`;

    const humanCreated = await svc.create(
      companyId,
      {
        name: "Human-Created Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      },
      { ownerUserId: humanUserId, ownershipSource: "agent_create" },
    );

    const agentCreatedAgent = await svc.create(
      companyId,
      {
        name: "Agent-Created Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      },
      { ownerUserId: agentActorUserId, ownershipSource: "agent_created_default" },
    );

    const humanOwnerRows = await activeOwnerRows(humanCreated.id);
    expect(humanOwnerRows).toHaveLength(1);
    expect(humanOwnerRows[0]).toMatchObject({ principalId: humanUserId, principalType: "user" });

    const agentOwnerRows = await activeOwnerRows(agentCreatedAgent.id);
    expect(agentOwnerRows).toHaveLength(1);
    expect(agentOwnerRows[0]).toMatchObject({
      principalId: agentActorUserId,
      source: "agent_created_default",
    });
  });

  it("refuses to write ownership without a resolvable owner user id", async () => {
    const companyId = await seedCompany();
    const svc = agentService(db);
    await expect(
      svc.create(
        companyId,
        {
          name: "No Owner Agent",
          role: "engineer",
          status: "idle",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
          spentMonthlyCents: 0,
          lastHeartbeatAt: null,
        },
        { ownerUserId: "   " },
      ),
    ).rejects.toThrow();
  });

  it("enforces exactly one active owner per agent at the database level", async () => {
    const companyId = await seedCompany();
    const svc = agentService(db);
    const agent = await svc.create(
      companyId,
      {
        name: "Owned Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      },
      { ownerUserId: `user-${randomUUID()}` },
    );

    // A second concurrent "active owner" row for the same agent must be
    // rejected by the partial unique index, not merely by application code.
    await expect(
      db.insert(agentOwnershipGrants).values({
        id: randomUUID(),
        companyId,
        agentId: agent.id,
        principalType: "user",
        principalId: `user-${randomUUID()}`,
        role: "owner",
        source: "manual_grant",
      }),
    ).rejects.toThrow();
  });

  it("ownership transfer requires acceptance and never leaves a zero-owner window", async () => {
    const companyId = await seedCompany();
    const svc = agentService(db);
    const ownership = agentOwnershipService(db);
    const fromUserId = `user-${randomUUID()}`;
    const toUserId = `user-${randomUUID()}`;

    const agent = await svc.create(
      companyId,
      {
        name: "Transfer Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      },
      { ownerUserId: fromUserId },
    );

    const transfer = await ownership.proposeTransfer({
      companyId,
      agentId: agent.id,
      toUserId,
      proposedByUserId: fromUserId,
    });
    expect(transfer.status).toBe("pending");

    // Ownership has NOT moved yet -- proposing alone must not change who
    // owns the agent.
    const ownerBeforeAccept = await ownership.getActiveOwner(agent.id);
    expect(ownerBeforeAccept?.principalId).toBe(fromUserId);

    // A non-recipient cannot accept on the recipient's behalf.
    await expect(
      ownership.acceptTransfer({ transferId: transfer.id, acceptingUserId: fromUserId }),
    ).rejects.toThrow();

    await ownership.acceptTransfer({ transferId: transfer.id, acceptingUserId: toUserId });

    const ownerAfterAccept = await ownership.getActiveOwner(agent.id);
    expect(ownerAfterAccept?.principalId).toBe(toUserId);

    // Exactly one active owner at all times -- never zero, never two.
    const activeOwners = await activeOwnerRows(agent.id);
    expect(activeOwners).toHaveLength(1);

    // The outgoing owner's grant is revoked, not deleted.
    const allGrants = await db
      .select()
      .from(agentOwnershipGrants)
      .where(eq(agentOwnershipGrants.agentId, agent.id));
    const revokedGrant = allGrants.find((row) => row.principalId === fromUserId);
    expect(revokedGrant).toBeTruthy();
    expect(revokedGrant?.revokedAt).not.toBeNull();
  });

  it("revocation of a non-owner role sets revoked_at rather than deleting the row", async () => {
    const companyId = await seedCompany();
    const svc = agentService(db);
    const ownership = agentOwnershipService(db);
    const ownerUserId = `user-${randomUUID()}`;
    const memberUserId = `user-${randomUUID()}`;

    const agent = await svc.create(
      companyId,
      {
        name: "Role Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      },
      { ownerUserId },
    );

    const granted = await ownership.setRole({
      companyId,
      agentId: agent.id,
      principalType: "user",
      principalId: memberUserId,
      role: "user",
      grantedByUserId: ownerUserId,
    });

    await ownership.revokeRole({
      agentId: agent.id,
      principalType: "user",
      principalId: memberUserId,
      revokedByUserId: ownerUserId,
    });

    const rows = await db
      .select()
      .from(agentOwnershipGrants)
      .where(eq(agentOwnershipGrants.id, granted.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].revokedAt).not.toBeNull();

    // Owner role can never be revoked through this path.
    await expect(
      ownership.revokeRole({
        agentId: agent.id,
        principalType: "user",
        principalId: ownerUserId,
        revokedByUserId: ownerUserId,
      }).then(async () => activeOwnerRows(agent.id)),
    ).resolves.toHaveLength(1);
  });

  it("role changes are recorded as a new transition row, not an overwrite of the old one", async () => {
    const companyId = await seedCompany();
    const svc = agentService(db);
    const ownership = agentOwnershipService(db);
    const ownerUserId = `user-${randomUUID()}`;
    const memberUserId = `user-${randomUUID()}`;

    const agent = await svc.create(
      companyId,
      {
        name: "Transition Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      },
      { ownerUserId },
    );

    const asUser = await ownership.setRole({
      companyId,
      agentId: agent.id,
      principalType: "user",
      principalId: memberUserId,
      role: "user",
      grantedByUserId: ownerUserId,
    });
    const asAdmin = await ownership.setRole({
      companyId,
      agentId: agent.id,
      principalType: "user",
      principalId: memberUserId,
      role: "admin",
      grantedByUserId: ownerUserId,
    });

    expect(asAdmin.transitionFromGrantId).toBe(asUser.id);

    const rows = await db
      .select()
      .from(agentOwnershipGrants)
      .where(eq(agentOwnershipGrants.id, asUser.id));
    expect(rows[0].revokedAt).not.toBeNull();
    expect(rows[0].revokedReason).toBe("role_change");
  });

  describe("forceTransferByInstanceAdmin (instance-admin break-glass)", () => {
    it("atomically moves ownership, leaving exactly one active owner before and after", async () => {
      const companyId = await seedCompany();
      const svc = agentService(db);
      const ownership = agentOwnershipService(db);
      const fromUserId = `user-${randomUUID()}`;
      const toUserId = `user-${randomUUID()}`;
      const instanceAdminUserId = `admin-${randomUUID()}`;

      const agent = await svc.create(
        companyId,
        {
          name: "Break Glass Agent",
          role: "engineer",
          status: "idle",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
          spentMonthlyCents: 0,
          lastHeartbeatAt: null,
        },
        { ownerUserId: fromUserId },
      );

      const ownersBefore = await activeOwnerRows(agent.id);
      expect(ownersBefore).toHaveLength(1);
      expect(ownersBefore[0].principalId).toBe(fromUserId);

      const result = await ownership.forceTransferByInstanceAdmin({
        companyId,
        agentId: agent.id,
        toUserId,
        instanceAdminUserId,
        reason: "offboarding",
      });

      expect(result.grant.principalId).toBe(toUserId);
      expect(result.grant.role).toBe("owner");
      expect(result.grant.isInstanceAdminOverride).toBe(true);
      expect(result.transfer.status).toBe("forced");
      expect(result.transfer.fromUserId).toBe(fromUserId);
      expect(result.transfer.toUserId).toBe(toUserId);
      expect(result.transfer.forcedByInstanceAdminUserId).toBe(instanceAdminUserId);

      // Exactly one active owner after the override -- never zero, never two.
      const ownersAfter = await activeOwnerRows(agent.id);
      expect(ownersAfter).toHaveLength(1);
      expect(ownersAfter[0].principalId).toBe(toUserId);

      // The outgoing owner's grant is revoked (not deleted) and linked via
      // transitionFromGrantId, and reason is recorded for audit purposes.
      const allGrants = await db
        .select()
        .from(agentOwnershipGrants)
        .where(eq(agentOwnershipGrants.agentId, agent.id));
      const revokedGrant = allGrants.find((row) => row.principalId === fromUserId);
      expect(revokedGrant?.revokedAt).not.toBeNull();
      expect(revokedGrant?.revokedReason).toBe("offboarding");
      expect(result.grant.transitionFromGrantId).toBe(revokedGrant?.id);
    });

    it("throws when the agent has no active owner to override", async () => {
      const companyId = await seedCompany();
      const svc = agentService(db);
      const ownership = agentOwnershipService(db);
      const toUserId = `user-${randomUUID()}`;
      const instanceAdminUserId = `admin-${randomUUID()}`;

      const agent = await svc.create(
        companyId,
        {
          name: "Ownerless Target Agent",
          role: "engineer",
          status: "idle",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
          spentMonthlyCents: 0,
          lastHeartbeatAt: null,
        },
        { ownerUserId: `user-${randomUUID()}` },
      );
      const currentOwner = await ownership.getActiveOwner(agent.id);
      await db
        .update(agentOwnershipGrants)
        .set({ revokedAt: new Date(), revokedReason: "test_setup" })
        .where(eq(agentOwnershipGrants.id, currentOwner!.id));

      await expect(
        ownership.forceTransferByInstanceAdmin({
          companyId,
          agentId: agent.id,
          toUserId,
          instanceAdminUserId,
        }),
      ).rejects.toThrow();
    });

    it("does NOT validate that the caller is an instance admin -- that is the route guard's job, not this function's", async () => {
      // This documents the contract, not an accident of the current
      // implementation: forceTransferByInstanceAdmin trusts
      // `instanceAdminUserId` completely and performs the override for
      // *any* string passed in, including one that holds no role on the
      // agent (or any agent) at all. Authorization ("is this caller
      // actually an instance admin?") is enforced exclusively by
      // `assertInstanceAdmin` in the route handler
      // (routes/agents.ts, POST /agents/:id/ownership/force-transfer)
      // before this function is ever called. If a future refactor makes
      // this function start rejecting non-admin callers, that is a
      // deliberate defense-in-depth change, and this test should be
      // updated deliberately alongside it -- it must not pass by accident.
      const companyId = await seedCompany();
      const svc = agentService(db);
      const ownership = agentOwnershipService(db);
      const fromUserId = `user-${randomUUID()}`;
      const toUserId = `user-${randomUUID()}`;
      const unrelatedCallerId = `not-an-admin-${randomUUID()}`;

      const agent = await svc.create(
        companyId,
        {
          name: "Unvalidated Caller Agent",
          role: "engineer",
          status: "idle",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
          spentMonthlyCents: 0,
          lastHeartbeatAt: null,
        },
        { ownerUserId: fromUserId },
      );

      const result = await ownership.forceTransferByInstanceAdmin({
        companyId,
        agentId: agent.id,
        toUserId,
        instanceAdminUserId: unrelatedCallerId,
      });

      expect(result.grant.principalId).toBe(toUserId);
      expect(result.transfer.forcedByInstanceAdminUserId).toBe(unrelatedCallerId);
    });
  });

  describe("bootstrapOwnership (instance-admin one-time backfill)", () => {
    async function seedUnownedAgent(companyId: string) {
      const svc = agentService(db);
      const ownership = agentOwnershipService(db);
      const agent = await svc.create(
        companyId,
        {
          name: "Pre-TECH-4929 Agent",
          role: "engineer",
          status: "idle",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
          spentMonthlyCents: 0,
          lastHeartbeatAt: null,
        },
        { ownerUserId: `user-${randomUUID()}` },
      );
      // Simulate an agent that predates write-on-create: revoke its only
      // owner grant so it has zero active owner rows, matching exactly
      // what `listUnownedAgents` selects for.
      const currentOwner = await ownership.getActiveOwner(agent.id);
      await db
        .update(agentOwnershipGrants)
        .set({ revokedAt: new Date(), revokedReason: "test_setup_simulate_legacy_unowned" })
        .where(eq(agentOwnershipGrants.id, currentOwner!.id));
      return agent;
    }

    it("creates the first owner grant for a genuinely unowned agent", async () => {
      const companyId = await seedCompany();
      const ownership = agentOwnershipService(db);
      const ownerUserId = `user-${randomUUID()}`;
      const instanceAdminUserId = `admin-${randomUUID()}`;
      const agent = await seedUnownedAgent(companyId);
      await seedActiveMembership(companyId, ownerUserId);

      expect(await activeOwnerRows(agent.id)).toHaveLength(0);

      const grant = await ownership.bootstrapOwnership({
        companyId,
        agentId: agent.id,
        ownerUserId,
        instanceAdminUserId,
      });

      expect(grant.role).toBe("owner");
      expect(grant.principalId).toBe(ownerUserId);
      expect(grant.isInstanceAdminOverride).toBe(true);
      expect(grant.source).toBe("instance_admin_bootstrap");

      const ownersAfter = await activeOwnerRows(agent.id);
      expect(ownersAfter).toHaveLength(1);
      expect(ownersAfter[0].id).toBe(grant.id);
    });

    it("refuses to bootstrap an agent that already has an active owner", async () => {
      const companyId = await seedCompany();
      const svc = agentService(db);
      const ownership = agentOwnershipService(db);
      const existingOwnerUserId = `user-${randomUUID()}`;
      const agent = await svc.create(
        companyId,
        {
          name: "Already Owned Agent",
          role: "engineer",
          status: "idle",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
          spentMonthlyCents: 0,
          lastHeartbeatAt: null,
        },
        { ownerUserId: existingOwnerUserId },
      );

      // The passed ownerUserId is intentionally NOT a seeded company member.
      // That's fine here: the existing-owner check (409) runs before the
      // membership check (422), so this call fails on the existing-owner
      // branch regardless of the candidate owner's membership status --
      // this test is not implicitly relying on membership seeding being
      // optional in general, just on this specific check ordering.
      await expect(
        ownership.bootstrapOwnership({
          companyId,
          agentId: agent.id,
          ownerUserId: `user-${randomUUID()}`,
          instanceAdminUserId: `admin-${randomUUID()}`,
        }),
      ).rejects.toThrow(/already has an active owner/);

      // The pre-existing owner is untouched -- this is a refusal, not a
      // silent takeover of an already-owned agent.
      const ownersAfter = await activeOwnerRows(agent.id);
      expect(ownersAfter).toHaveLength(1);
      expect(ownersAfter[0].principalId).toBe(existingOwnerUserId);
    });

    it("requires a non-empty ownerUserId", async () => {
      const companyId = await seedCompany();
      const ownership = agentOwnershipService(db);
      const agent = await seedUnownedAgent(companyId);

      await expect(
        ownership.bootstrapOwnership({
          companyId,
          agentId: agent.id,
          ownerUserId: "   ",
          instanceAdminUserId: `admin-${randomUUID()}`,
        }),
      ).rejects.toThrow(/ownerUserId is required/);
    });

    it("refuses to bootstrap to a user who is not an active member of the company", async () => {
      const companyId = await seedCompany();
      const ownership = agentOwnershipService(db);
      const agent = await seedUnownedAgent(companyId);

      await expect(
        ownership.bootstrapOwnership({
          companyId,
          agentId: agent.id,
          ownerUserId: `not-a-member-${randomUUID()}`,
          instanceAdminUserId: `admin-${randomUUID()}`,
        }),
      ).rejects.toThrow(/active, non-viewer member of this company/);

      expect(await activeOwnerRows(agent.id)).toHaveLength(0);
    });

    it("refuses to bootstrap to a user whose membership is inactive", async () => {
      const companyId = await seedCompany();
      const ownership = agentOwnershipService(db);
      const agent = await seedUnownedAgent(companyId);
      const revokedMemberUserId = `user-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        id: randomUUID(),
        companyId,
        principalType: "user",
        principalId: revokedMemberUserId,
        status: "revoked",
      });

      await expect(
        ownership.bootstrapOwnership({
          companyId,
          agentId: agent.id,
          ownerUserId: revokedMemberUserId,
          instanceAdminUserId: `admin-${randomUUID()}`,
        }),
      ).rejects.toThrow(/active, non-viewer member of this company/);
    });

    it("refuses to bootstrap to a viewer-role member", async () => {
      const companyId = await seedCompany();
      const ownership = agentOwnershipService(db);
      const agent = await seedUnownedAgent(companyId);
      const viewerUserId = `user-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        id: randomUUID(),
        companyId,
        principalType: "user",
        principalId: viewerUserId,
        status: "active",
        membershipRole: "viewer",
      });

      await expect(
        ownership.bootstrapOwnership({
          companyId,
          agentId: agent.id,
          ownerUserId: viewerUserId,
          instanceAdminUserId: `admin-${randomUUID()}`,
        }),
      ).rejects.toThrow(/active, non-viewer member of this company/);
    });

    it("accepts a non-NULL, non-viewer membershipRole (the ne() branch's accept side, distinct from the pre-existing NULL-role happy path)", async () => {
      const companyId = await seedCompany();
      const ownership = agentOwnershipService(db);
      const agent = await seedUnownedAgent(companyId);
      const operatorUserId = `user-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        id: randomUUID(),
        companyId,
        principalType: "user",
        principalId: operatorUserId,
        status: "active",
        membershipRole: "operator",
      });

      const grant = await ownership.bootstrapOwnership({
        companyId,
        agentId: agent.id,
        ownerUserId: operatorUserId,
        instanceAdminUserId: `admin-${randomUUID()}`,
      });

      expect(grant.principalId).toBe(operatorUserId);
    });

    it("deterministically hits the 23505-to-conflict() catch branch (not just the pre-check SELECT)", async () => {
      // The concurrent-calls test below proves the *invariant* holds under
      // real concurrency, but per its own comment does not reliably
      // exercise this specific catch branch -- the pre-check SELECT usually
      // wins the race in a single-threaded test process. This test pins the
      // catch branch directly with a hand-built fake `db` whose INSERT
      // rejects with a real Postgres 23505 shape, so a future change that
      // breaks or removes the catch (letting the raw error propagate) fails
      // this test even if the real-concurrency test above stays green.
      const companyId = randomUUID();
      const agentId = randomUUID();
      const ownerUserId = `user-${randomUUID()}`;
      const instanceAdminUserId = `admin-${randomUUID()}`;
      // Real Promises throughout, not hand-rolled thenables: the production
      // code calls `.then(onFulfilled)` with no `onRejected` argument (e.g.
      // `.returning().then((rows) => rows[0])`), so a rejection has to come
      // from an actual Promise.reject to propagate correctly -- a thenable
      // whose `.then` only receives one callback has no way to signal
      // rejection to that call shape.
      // Dispatches by call ORDER, not by which table is queried -- this
      // assumes bootstrapOwnership's implementation queries existingOwner
      // first and membership second (see agent-ownership.ts). If that
      // order is ever swapped, this fake returns the wrong shape for each
      // call and this test fails with an unrelated-looking TypeError rather
      // than a clear assertion diff -- update this dispatch to match if the
      // production code's query order ever changes.
      let selectCallCount = 0;
      const pgUniqueViolation = Object.assign(
        new Error('duplicate key value violates unique constraint "agent_ownership_grants_one_active_owner_idx"'),
        { code: "23505" },
      );
      const fakeTx = {
        select: () => ({
          from: () => ({
            where: () => {
              selectCallCount += 1;
              if (selectCallCount === 1) {
                // existingOwner pre-check -- awaited directly, no .for() call.
                return Promise.resolve([]);
              }
              // membership check -- chained with .for("update").
              return { for: () => Promise.resolve([{ id: "membership-1" }]) };
            },
          }),
        }),
        insert: () => ({
          values: () => ({
            returning: () => Promise.reject(pgUniqueViolation),
          }),
        }),
      };
      const fakeDb = {
        transaction: (cb: (tx: typeof fakeTx) => Promise<unknown>) => cb(fakeTx),
      };
      const ownership = agentOwnershipService(fakeDb as unknown as Db);

      await expect(
        ownership.bootstrapOwnership({ companyId, agentId, ownerUserId, instanceAdminUserId }),
      ).rejects.toMatchObject({
        message: "Agent already has an active owner -- use the transfer flow to change it.",
        status: 409,
      });
    });

    it("under concurrent calls for the same unowned agent, exactly one succeeds and the other gets a conflict -- the invariant holds regardless of whether the pre-check SELECT or the partial unique index catches it", async () => {
      // The pre-check SELECT is not a lock -- both calls can pass it before
      // either INSERT commits, in which case the partial unique index
      // (`agent_ownership_grants_one_active_owner_idx`) is what actually
      // prevents two active owners, and the try/catch around the INSERT
      // translates its violation to the same `conflict()` the pre-check
      // throws. This test asserts the invariant (exactly one owner, one
      // caller rejected with 409), not which of the two code paths caught
      // it -- in a single-threaded Node test against embedded Postgres, the
      // pre-check SELECT usually wins the race, so this does not by itself
      // pin the try/catch branch specifically.
      const companyId = await seedCompany();
      const ownership = agentOwnershipService(db);
      const agent = await seedUnownedAgent(companyId);
      const instanceAdminUserId = `admin-${randomUUID()}`;
      const ownerUserIdA = `user-a-${randomUUID()}`;
      const ownerUserIdB = `user-b-${randomUUID()}`;
      await seedActiveMembership(companyId, ownerUserIdA);
      await seedActiveMembership(companyId, ownerUserIdB);

      const results = await Promise.allSettled([
        ownership.bootstrapOwnership({
          companyId,
          agentId: agent.id,
          ownerUserId: ownerUserIdA,
          instanceAdminUserId,
        }),
        ownership.bootstrapOwnership({
          companyId,
          agentId: agent.id,
          ownerUserId: ownerUserIdB,
          instanceAdminUserId,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already has an active owner/);
      expect((rejected[0] as PromiseRejectedResult).reason.status).toBe(409);

      const ownersAfter = await activeOwnerRows(agent.id);
      expect(ownersAfter).toHaveLength(1);
    });
  });

  describe("declineOrCancelTransfer", () => {
    async function createPendingTransfer() {
      const companyId = await seedCompany();
      const svc = agentService(db);
      const ownership = agentOwnershipService(db);
      const fromUserId = `user-${randomUUID()}`;
      const toUserId = `user-${randomUUID()}`;

      const agent = await svc.create(
        companyId,
        {
          name: "Decline/Cancel Agent",
          role: "engineer",
          status: "idle",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
          spentMonthlyCents: 0,
          lastHeartbeatAt: null,
        },
        { ownerUserId: fromUserId },
      );

      const transfer = await ownership.proposeTransfer({
        companyId,
        agentId: agent.id,
        toUserId,
        proposedByUserId: fromUserId,
      });

      return { companyId, ownership, agent, fromUserId, toUserId, transfer };
    }

    it("lets the recipient decline a pending transfer", async () => {
      const { ownership, transfer, toUserId } = await createPendingTransfer();

      await ownership.declineOrCancelTransfer({
        transferId: transfer.id,
        byUserId: toUserId,
        action: "decline",
      });

      const rows = await db
        .select()
        .from(agentOwnershipTransfers)
        .where(eq(agentOwnershipTransfers.id, transfer.id));
      expect(rows[0].status).toBe("declined");
      expect(rows[0].respondedByUserId).toBe(toUserId);
    });

    it("throws when someone other than the recipient tries to decline", async () => {
      const { ownership, transfer } = await createPendingTransfer();
      const impersonator = `user-${randomUUID()}`;

      await expect(
        ownership.declineOrCancelTransfer({
          transferId: transfer.id,
          byUserId: impersonator,
          action: "decline",
        }),
      ).rejects.toThrow();

      // The transfer must remain pending -- a rejected decline attempt must
      // not mutate state.
      const rows = await db
        .select()
        .from(agentOwnershipTransfers)
        .where(eq(agentOwnershipTransfers.id, transfer.id));
      expect(rows[0].status).toBe("pending");
    });

    it("lets the proposing owner cancel a pending transfer", async () => {
      const { ownership, transfer, fromUserId } = await createPendingTransfer();

      await ownership.declineOrCancelTransfer({
        transferId: transfer.id,
        byUserId: fromUserId,
        action: "cancel",
      });

      const rows = await db
        .select()
        .from(agentOwnershipTransfers)
        .where(eq(agentOwnershipTransfers.id, transfer.id));
      expect(rows[0].status).toBe("cancelled");
      expect(rows[0].respondedByUserId).toBe(fromUserId);
    });

    it("throws when someone other than the proposing owner tries to cancel", async () => {
      const { ownership, transfer, toUserId } = await createPendingTransfer();

      // The recipient is not the proposer and must not be able to cancel.
      await expect(
        ownership.declineOrCancelTransfer({
          transferId: transfer.id,
          byUserId: toUserId,
          action: "cancel",
        }),
      ).rejects.toThrow();

      // The transfer must remain pending -- a rejected cancel attempt must
      // not mutate state. (Mirrors the equivalent assertion on the
      // decline-side sibling test above.)
      const rows = await db
        .select()
        .from(agentOwnershipTransfers)
        .where(eq(agentOwnershipTransfers.id, transfer.id));
      expect(rows[0].status).toBe("pending");
    });

    it("throws when trying to decline or cancel a transfer that is no longer pending", async () => {
      const { ownership, transfer, fromUserId, toUserId } = await createPendingTransfer();

      await ownership.acceptTransfer({ transferId: transfer.id, acceptingUserId: toUserId });

      await expect(
        ownership.declineOrCancelTransfer({
          transferId: transfer.id,
          byUserId: toUserId,
          action: "decline",
        }),
      ).rejects.toThrow();

      await expect(
        ownership.declineOrCancelTransfer({
          transferId: transfer.id,
          byUserId: fromUserId,
          action: "cancel",
        }),
      ).rejects.toThrow();
    });
  });
});
