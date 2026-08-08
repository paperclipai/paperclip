import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
  agentOwnershipGrants,
  agentOwnershipTransfers,
  agents,
  companies,
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
