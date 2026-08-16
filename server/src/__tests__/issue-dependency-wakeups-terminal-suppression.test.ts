import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb } from "@paperclipai/db";
import {
  DEPENDENCY_WAKE_TERMINAL_SUPPRESSION_MS,
  buildIssueBlockersResolvedWakeIdempotencyKey,
  findExistingIssueBlockersResolvedWakeForAnyKey,
} from "../services/issue-dependency-wakeups.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("blockers-resolved wake terminal suppression (TSMC-20923)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dep-wake-suppression-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedWake(input: { status: string; createdAt: Date }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const dependentIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const idempotencyKey = buildIssueBlockersResolvedWakeIdempotencyKey({
      dependentIssueId,
      resolvedBlockerIssueId: blockerIssueId,
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: dependentIssueId, resolvedBlockerIssueId: blockerIssueId },
      status: input.status,
      idempotencyKey,
      createdAt: input.createdAt,
      finishedAt: input.createdAt,
    });

    return { companyId, idempotencyKey };
  }

  it("without terminalSuppressionMs a cancelled wake does not count as existing (original semantics)", async () => {
    const { companyId, idempotencyKey } = await seedWake({ status: "cancelled", createdAt: new Date() });
    const found = await findExistingIssueBlockersResolvedWakeForAnyKey(db, {
      companyId,
      idempotencyKeys: [idempotencyKey],
    });
    expect(found).toBeNull();
  });

  it("a freshly cancelled wake suppresses re-emission within the window", async () => {
    const { companyId, idempotencyKey } = await seedWake({ status: "cancelled", createdAt: new Date() });
    const found = await findExistingIssueBlockersResolvedWakeForAnyKey(db, {
      companyId,
      idempotencyKeys: [idempotencyKey],
      terminalSuppressionMs: DEPENDENCY_WAKE_TERMINAL_SUPPRESSION_MS,
    });
    expect(found?.idempotencyKey).toBe(idempotencyKey);
    expect(found?.status).toBe("cancelled");
  });

  it("a freshly skipped wake also suppresses re-emission within the window", async () => {
    const { companyId, idempotencyKey } = await seedWake({ status: "skipped", createdAt: new Date() });
    const found = await findExistingIssueBlockersResolvedWakeForAnyKey(db, {
      companyId,
      idempotencyKeys: [idempotencyKey],
      terminalSuppressionMs: DEPENDENCY_WAKE_TERMINAL_SUPPRESSION_MS,
    });
    expect(found?.status).toBe("skipped");
  });

  it("a cancelled wake older than the window does not block a new resolution", async () => {
    const stale = new Date(Date.now() - DEPENDENCY_WAKE_TERMINAL_SUPPRESSION_MS - 60_000);
    const { companyId, idempotencyKey } = await seedWake({ status: "cancelled", createdAt: stale });
    const found = await findExistingIssueBlockersResolvedWakeForAnyKey(db, {
      companyId,
      idempotencyKeys: [idempotencyKey],
      terminalSuppressionMs: DEPENDENCY_WAKE_TERMINAL_SUPPRESSION_MS,
    });
    expect(found).toBeNull();
  });

  it("a live queued wake is found in both modes", async () => {
    const { companyId, idempotencyKey } = await seedWake({ status: "queued", createdAt: new Date() });
    const plain = await findExistingIssueBlockersResolvedWakeForAnyKey(db, {
      companyId,
      idempotencyKeys: [idempotencyKey],
    });
    const suppressing = await findExistingIssueBlockersResolvedWakeForAnyKey(db, {
      companyId,
      idempotencyKeys: [idempotencyKey],
      terminalSuppressionMs: DEPENDENCY_WAKE_TERMINAL_SUPPRESSION_MS,
    });
    expect(plain?.idempotencyKey).toBe(idempotencyKey);
    expect(suppressing?.idempotencyKey).toBe(idempotencyKey);
  });
});
