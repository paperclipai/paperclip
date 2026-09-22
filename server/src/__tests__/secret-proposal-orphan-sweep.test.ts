import { randomUUID } from "node:crypto";
import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySecretProposals,
  companySecrets,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import {
  SECRET_PROPOSAL_CARD_LOST_REASON,
  SECRET_PROPOSAL_CARD_SUPERSEDED_REASON,
  createSecretProposalsService,
} from "../services/secret-proposals.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const LAPSED_REASON = "Pending proposal expired";

describeEmbeddedPostgres("secret proposal orphan sweep", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("secret-proposal-orphan-sweep");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companySecretProposals);
    await db.delete(companySecrets);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const heartbeatRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Orphan sweep",
      issuePrefix: `O${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Proposer",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
      status: "idle",
    });
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "user-1",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Needs credential",
      identifier: "ORP-1",
      status: "in_progress",
      responsibleUserId: "user-1",
      executionRunId: heartbeatRunId,
    });
    const secretId = randomUUID();
    await db.insert(companySecrets).values({
      id: secretId,
      companyId,
      key: "soak-database-url",
      name: "soak/database-url",
    });
    return { companyId, agentId, heartbeatRunId, issueId, secretId };
  }

  async function insertProposal(
    fixture: Awaited<ReturnType<typeof seed>>,
    overrides: {
      interactionId?: string | null;
      expiresAt?: Date;
      configPath?: string;
      proposerAgentId?: string;
    } = {},
  ) {
    const id = randomUUID();
    await db.insert(companySecretProposals).values({
      id,
      companyId: fixture.companyId,
      kind: "binding",
      status: "pending",
      justification: "Soak env for the resident runner",
      secretId: fixture.secretId,
      targetType: "agent",
      targetId: overrides.proposerAgentId ?? fixture.agentId,
      configPath: overrides.configPath ?? "env.THARSIA_DATABASE_URL",
      proposedByAgentId: overrides.proposerAgentId ?? fixture.agentId,
      originIssueId: fixture.issueId,
      originRunId: fixture.heartbeatRunId,
      interactionId: overrides.interactionId ?? null,
      valueCiphertext: { v: 1, alg: "aes-256-gcm", iv: "iv", tag: "tag", data: "ciphertext" },
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    });
    return id;
  }

  async function insertCard(
    fixture: Awaited<ReturnType<typeof seed>>,
    input: {
      status: string;
      proposalId?: string;
      createdAt?: Date;
      prompt?: string;
    },
  ) {
    const id = randomUUID();
    const linked = input.proposalId
      ? {
          secretProposal: {
            version: 1,
            proposalId: input.proposalId,
            sourceSecretLabel: "soak/database-url",
            configPath: "env.THARSIA_DATABASE_URL",
            targetAgentId: fixture.agentId,
            targetAgentName: "Proposer",
            justification: "Soak env for the resident runner",
            expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
          },
        }
      : {};
    await db.insert(issueThreadInteractions).values({
      id,
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      kind: "request_confirmation",
      status: input.status,
      continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      effectiveResolverPolicySource: "governed_action",
      createdByAgentId: fixture.agentId,
      idempotencyKey: `secret-proposal:${input.proposalId ?? id}`,
      payload: {
        version: 1,
        prompt: input.prompt ?? "Bind secret to Proposer?",
        ...linked,
      },
      createdAt: input.createdAt ?? new Date(),
      updatedAt: input.createdAt ?? new Date(),
    });
    if (input.proposalId) {
      await db
        .update(companySecretProposals)
        .set({ interactionId: id })
        .where(eq(companySecretProposals.id, input.proposalId));
    }
    return id;
  }

  async function proposalRow(proposalId: string) {
    return db
      .select()
      .from(companySecretProposals)
      .where(eq(companySecretProposals.id, proposalId))
      .then((rows) => rows[0] ?? null);
  }

  // The detector from the issue: zero rows where a pending proposal's card is
  // already terminal. It must hold after every sweep run.
  async function pendingProposalsBehindDeadCards() {
    const rows = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count
      FROM company_secret_proposals p
      JOIN issue_thread_interactions i
        ON i.id = p.interaction_id AND i.company_id = p.company_id
      WHERE p.status = 'pending' AND i.status IN ('expired', 'cancelled')
    `);
    return Number(rows[0]?.count ?? 0);
  }

  it("expires a pending proposal whose approval card already expired", async () => {
    const fixture = await seed();
    const proposalId = await insertProposal(fixture);
    await insertCard(fixture, { status: "expired", proposalId });

    const secretProposals = createSecretProposalsService(db as never);
    expect(await pendingProposalsBehindDeadCards()).toBe(1);

    expect(await secretProposals.sweepOrphaned()).toBe(1);

    const proposal = await proposalRow(proposalId);
    expect(proposal).toMatchObject({
      status: "expired",
      resolutionReason: SECRET_PROPOSAL_CARD_LOST_REASON,
    });
    expect(proposal?.ciphertextScrubbedAt).not.toBeNull();
    expect(proposal?.valueCiphertext).toBeNull();
    expect(await pendingProposalsBehindDeadCards()).toBe(0);
    // Re-running is a no-op: the proposal is terminal, not pending.
    expect(await secretProposals.sweepOrphaned()).toBe(0);
  });

  it("expires a pending proposal whose card was cancelled", async () => {
    const fixture = await seed();
    const proposalId = await insertProposal(fixture);
    await insertCard(fixture, { status: "cancelled", proposalId });

    const secretProposals = createSecretProposalsService(db as never);
    expect(await secretProposals.sweepOrphaned()).toBe(1);
    expect((await proposalRow(proposalId))?.status).toBe("expired");
  });

  it("leaves a proposal alone while its card is still open", async () => {
    const fixture = await seed();
    const proposalId = await insertProposal(fixture);
    await insertCard(fixture, { status: "pending", proposalId });

    const secretProposals = createSecretProposalsService(db as never);
    expect(await secretProposals.sweepOrphaned()).toBe(0);
    expect((await proposalRow(proposalId))?.status).toBe("pending");
  });

  it("leaves a proposal that never had a card alone", async () => {
    const fixture = await seed();
    const proposalId = await insertProposal(fixture, { interactionId: null });

    const secretProposals = createSecretProposalsService(db as never);
    expect(await secretProposals.sweepOrphaned()).toBe(0);
    expect((await proposalRow(proposalId))?.status).toBe("pending");
  });

  it("resolves the linked proposal when the supersede sweep expires its card", async () => {
    const fixture = await seed();
    const older = new Date("2026-07-01T12:00:00.000Z");
    const newer = new Date("2026-07-01T13:00:00.000Z");
    const proposalId = await insertProposal(fixture);
    const cardId = await insertCard(fixture, { status: "pending", createdAt: older, proposalId });
    await insertCard(fixture, { status: "pending", createdAt: newer, prompt: "Re-raised ask" });

    const interactions = issueThreadInteractionService(db as never);
    await expect(interactions.sweepSupersededPendingRequestConfirmations()).resolves.toEqual({ expired: 1 });

    const [card] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, cardId));
    expect(card).toMatchObject({ status: "expired", result: { outcome: "superseded_by_newer_request" } });

    const proposal = await proposalRow(proposalId);
    expect(proposal).toMatchObject({
      status: "expired",
      resolutionReason: SECRET_PROPOSAL_CARD_SUPERSEDED_REASON,
    });
    expect(await pendingProposalsBehindDeadCards()).toBe(0);
  });

  it("resolves the proposal when a plain sibling request supersedes its card", async () => {
    const fixture = await seed();
    const proposalId = await insertProposal(fixture);
    const cardId = await insertCard(fixture, { status: "pending", proposalId });

    const interactions = issueThreadInteractionService(db as never);
    // The new card carries no proposal of its own, so only the sibling filter
    // (same agent, same issue, same kind) reaches the secret-proposal card.
    await interactions.create(
      { id: fixture.issueId, companyId: fixture.companyId },
      {
        kind: "request_confirmation",
        title: "Merge the linked pull request?",
        summary: null,
        payload: { version: 1, prompt: "Merge the linked pull request?" },
      },
      { agentId: fixture.agentId },
    );

    const [card] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, cardId));
    expect(card).toMatchObject({ status: "expired", result: { outcome: "superseded_by_newer_request" } });
    expect(await proposalRow(proposalId)).toMatchObject({
      status: "expired",
      resolutionReason: SECRET_PROPOSAL_CARD_SUPERSEDED_REASON,
    });
    expect(await pendingProposalsBehindDeadCards()).toBe(0);
  });

  // The product caps one agent at 20 pending proposals, so a backlog that
  // outgrows the sweep page needs more than one proposer. The sweep itself is
  // company-wide and does not care which agent asked.
  async function insertExtraAgents(fixture: Awaited<ReturnType<typeof seed>>, extra: number) {
    const ids: string[] = [];
    for (let index = 0; index < extra; index += 1) {
      const id = randomUUID();
      await db.insert(agents).values({
        id,
        companyId: fixture.companyId,
        name: `Proposer ${index + 1}`,
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
        permissions: {},
        status: "idle",
      });
      ids.push(id);
    }
    return ids;
  }

  it("drains an orphan backlog larger than one sweep page in a single call", async () => {
    const fixture = await seed();
    const proposers = [fixture.agentId, ...(await insertExtraAgents(fixture, 5))];
    const orphanTotal = 101;
    for (let index = 0; index < orphanTotal; index += 1) {
      const proposalId = await insertProposal(fixture, {
        configPath: `env.THARSIA_BULK_${index}`,
        proposerAgentId: proposers[index % proposers.length],
      });
      await insertCard(fixture, { status: "cancelled", proposalId });
    }
    expect(await pendingProposalsBehindDeadCards()).toBe(orphanTotal);

    const secretProposals = createSecretProposalsService(db as never);
    // One call is one scheduler tick. A single page of 100 would leave a row
    // pending past the interval the invariant promises.
    expect(await secretProposals.sweepOrphaned()).toBe(orphanTotal);

    expect(await pendingProposalsBehindDeadCards()).toBe(0);
    const stillPending = await db
      .select({ value: count() })
      .from(companySecretProposals)
      .where(eq(companySecretProposals.status, "pending"));
    expect(Number(stillPending[0]?.value ?? 0)).toBe(0);
  });

  it("records card loss when the lapse and the card death are both eligible", async () => {
    const fixture = await seed();
    const proposalId = await insertProposal(fixture, { expiresAt: new Date(Date.now() - 60_000) });
    await insertCard(fixture, { status: "cancelled", proposalId });

    const secretProposals = createSecretProposalsService(db as never);
    // Production starts both sweeps in the same tick, the lapse sweep first.
    // The eligibility sets are disjoint, so the recorded reason does not depend
    // on which one wins.
    expect(await secretProposals.sweepExpired()).toBe(0);
    expect(await secretProposals.sweepOrphaned()).toBe(1);

    expect(await proposalRow(proposalId)).toMatchObject({
      status: "expired",
      resolutionReason: SECRET_PROPOSAL_CARD_LOST_REASON,
    });
    expect(await pendingProposalsBehindDeadCards()).toBe(0);
  });

  it("keeps a superseded card's proposal resolvable when a human already approved it", async () => {
    const fixture = await seed();
    const older = new Date("2026-07-01T12:00:00.000Z");
    const proposalId = await insertProposal(fixture);
    const cardId = await insertCard(fixture, { status: "pending", createdAt: older, proposalId });
    await db
      .update(companySecretProposals)
      .set({ status: "approved", resolvedByUserId: "user-1", resolvedAt: older })
      .where(eq(companySecretProposals.id, proposalId));
    await insertCard(fixture, {
      status: "pending",
      createdAt: new Date("2026-07-01T13:00:00.000Z"),
      prompt: "Re-raised ask",
    });

    const interactions = issueThreadInteractionService(db as never);
    // The card still expires; the approved proposal is not resurrected and the
    // sweep does not roll back the whole pass over it.
    await expect(interactions.sweepSupersededPendingRequestConfirmations()).resolves.toEqual({ expired: 1 });
    expect((await proposalRow(proposalId))?.status).toBe("approved");
  });

  it("records a card death and a human lapse under different reasons", async () => {
    const fixture = await seed();
    const orphanProposalId = await insertProposal(fixture, { configPath: "env.THARSIA_NATS_URL" });
    await insertCard(fixture, { status: "expired", proposalId: orphanProposalId });
    const lapsedProposalId = await insertProposal(fixture, {
      configPath: "env.THARSIA_TEST_NATS_URL",
      expiresAt: new Date(Date.now() - 60_000),
    });
    // A lapsed proposal keeps a live card; a human could still have decided it.
    await insertCard(fixture, { status: "pending", proposalId: lapsedProposalId });
    expect(await pendingProposalsBehindDeadCards()).toBe(1);

    const secretProposals = createSecretProposalsService(db as never);
    // Production order: the lapse sweep runs first on the same tick.
    expect(await secretProposals.sweepExpired()).toBe(1);
    expect(await secretProposals.sweepOrphaned()).toBe(1);

    const orphan = await proposalRow(orphanProposalId);
    const lapsed = await proposalRow(lapsedProposalId);
    expect(orphan?.resolutionReason).toBe(SECRET_PROPOSAL_CARD_LOST_REASON);
    expect(lapsed?.resolutionReason).toBe(LAPSED_REASON);
    expect(new Set([
      SECRET_PROPOSAL_CARD_LOST_REASON,
      SECRET_PROPOSAL_CARD_SUPERSEDED_REASON,
      LAPSED_REASON,
    ]).size).toBe(3);
    expect(await pendingProposalsBehindDeadCards()).toBe(0);
  });
});
