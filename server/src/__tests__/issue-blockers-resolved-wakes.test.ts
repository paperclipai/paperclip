import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildIssueBlockersResolvedIdempotencyKey,
  findDeliveredIssueBlockersResolvedWake,
} from "../services/issue-blockers-resolved-wakes.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue-blockers-resolved wake dedup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue_blockers_resolved wake dedup", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-blockers-resolved-wakes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "DedupTester",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("builds a stable key per (dependent, blocker) pair", () => {
    const key = buildIssueBlockersResolvedIdempotencyKey({
      dependentIssueId: "dep-1",
      resolvedBlockerIssueId: "blk-1",
    });
    expect(key).toBe("issue_blockers_resolved:dep-1:blk-1");
    // A different blocker for the same dependent produces a different key, so
    // the next blocker-done transition can still wake the dependent.
    const otherBlockerKey = buildIssueBlockersResolvedIdempotencyKey({
      dependentIssueId: "dep-1",
      resolvedBlockerIssueId: "blk-2",
    });
    expect(otherBlockerKey).not.toBe(key);
  });

  it("returns a delivered wake row only when one already exists for the pair", async () => {
    const { companyId, agentId } = await seedAgent();
    const idempotencyKey = buildIssueBlockersResolvedIdempotencyKey({
      dependentIssueId: "dependent-issue-id",
      resolvedBlockerIssueId: "blocker-issue-id",
    });

    expect(
      await findDeliveredIssueBlockersResolvedWake(db, { companyId, idempotencyKey }),
    ).toBeNull();

    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: "dependent-issue-id", resolvedBlockerIssueId: "blocker-issue-id" },
      status: "completed",
      idempotencyKey,
      finishedAt: new Date(),
    });

    const delivered = await findDeliveredIssueBlockersResolvedWake(db, {
      companyId,
      idempotencyKey,
    });
    expect(delivered).not.toBeNull();
    expect(delivered?.status).toBe("completed");
  });

  it("treats queued and deferred wakes as delivered so the re-fire skips them", async () => {
    const { companyId, agentId } = await seedAgent();
    const idempotencyKey = buildIssueBlockersResolvedIdempotencyKey({
      dependentIssueId: "dep-q",
      resolvedBlockerIssueId: "blk-q",
    });

    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: "dep-q", resolvedBlockerIssueId: "blk-q" },
      status: "queued",
      idempotencyKey,
    });

    const queued = await findDeliveredIssueBlockersResolvedWake(db, {
      companyId,
      idempotencyKey,
    });
    expect(queued?.status).toBe("queued");
  });

  it("does not treat skipped or cancelled wakes as delivered", async () => {
    const { companyId, agentId } = await seedAgent();
    const idempotencyKey = buildIssueBlockersResolvedIdempotencyKey({
      dependentIssueId: "dep-s",
      resolvedBlockerIssueId: "blk-s",
    });

    // Simulate a wake that was suppressed before delivery (e.g. by an active
    // tree hold or a dependencies-still-blocked check). It must not block a
    // legitimate later re-fire from completing the dependent's wake path.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_tree_hold_active",
      payload: { issueId: "dep-s", resolvedBlockerIssueId: "blk-s" },
      status: "skipped",
      idempotencyKey,
      finishedAt: new Date(),
    });

    expect(
      await findDeliveredIssueBlockersResolvedWake(db, { companyId, idempotencyKey }),
    ).toBeNull();
  });

  it("scopes lookups to the requested company so cross-company wakes do not collide", async () => {
    const first = await seedAgent();
    const second = await seedAgent();
    const idempotencyKey = buildIssueBlockersResolvedIdempotencyKey({
      dependentIssueId: "shared-dependent-id",
      resolvedBlockerIssueId: "shared-blocker-id",
    });

    await db.insert(agentWakeupRequests).values({
      companyId: first.companyId,
      agentId: first.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: "shared-dependent-id", resolvedBlockerIssueId: "shared-blocker-id" },
      status: "completed",
      idempotencyKey,
      finishedAt: new Date(),
    });

    expect(
      await findDeliveredIssueBlockersResolvedWake(db, {
        companyId: second.companyId,
        idempotencyKey,
      }),
    ).toBeNull();
    expect(
      await findDeliveredIssueBlockersResolvedWake(db, {
        companyId: first.companyId,
        idempotencyKey,
      }),
    ).not.toBeNull();
  });
});
