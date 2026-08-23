import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb } from "@paperclipai/db";
import {
  DEPENDENCY_WAKE_ESCALATING_SUPPRESSION_BASE_MS,
  DEPENDENCY_WAKE_ESCALATING_SUPPRESSION_MAX_MS,
  DEPENDENCY_WAKE_TERMINAL_SUPPRESSION_MS,
  buildIssueBlockersResolvedWakeIdempotencyKey,
  buildIssueBlockersResolvedWakeStateKey,
  computeDependencyWakeEscalatingSuppressionMs,
  findExistingIssueBlockersResolvedWakeForAnyKey,
  findExistingIssueBlockersResolvedWakeForReadyState,
  findStillBlockedDependencyWakeSuppression,
  isPermanentHoldDependencyWakeCancelError,
} from "../services/issue-dependency-wakeups.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("blockers-resolved wake terminal suppression (TSMC-20923 / TSMC-21321)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dep-wake-suppression-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedWake(input: {
    status: string;
    createdAt: Date;
    error?: string | null;
    idempotencyKey?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const dependentIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const idempotencyKey =
      input.idempotencyKey ??
      buildIssueBlockersResolvedWakeIdempotencyKey({
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
      error: input.error ?? null,
      idempotencyKey,
      createdAt: input.createdAt,
      finishedAt: input.createdAt,
    });

    return { companyId, idempotencyKey, dependentIssueId, blockerIssueId };
  }

  it("without terminalSuppressionMs a fresh cancelled wake still suppresses via escalating cooldown (TSMC-21321)", async () => {
    const { companyId, idempotencyKey } = await seedWake({ status: "cancelled", createdAt: new Date() });
    const found = await findExistingIssueBlockersResolvedWakeForAnyKey(db, {
      companyId,
      idempotencyKeys: [idempotencyKey],
    });
    // Escalating cooldown always applies (route-time + backstop). A fresh non-permanent
    // cancel holds the slot; null only after the escalate window expires.
    expect(found?.idempotencyKey).toBe(idempotencyKey);
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

  it("a cancelled wake older than the fixed window still suppresses via escalating cooldown (count=2)", async () => {
      // Two cancels → escalate hold = 30m. Newest at 16m ago is still inside the hold.
      const older = new Date(Date.now() - 40 * 60_000);
      const newer = new Date(Date.now() - 16 * 60_000);
      const { companyId, idempotencyKey } = await seedWake({
        status: "cancelled",
        createdAt: older,
        error: "Cancelled by control plane",
      });
      const agentId = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .then((rows) => rows[0]!.id);
      await db.insert(agentWakeupRequests).values({
        id: randomUUID(),
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_blockers_resolved",
        payload: {},
        status: "cancelled",
        error: "Cancelled by control plane",
        idempotencyKey,
        createdAt: newer,
        finishedAt: newer,
      });
      const found = await findExistingIssueBlockersResolvedWakeForAnyKey(db, {
        companyId,
        idempotencyKeys: [idempotencyKey],
        terminalSuppressionMs: DEPENDENCY_WAKE_TERMINAL_SUPPRESSION_MS,
        now: new Date(),
      });
      expect(found?.status).toBe("cancelled");
    });

  it("a cancelled wake older than the window does not block a new resolution when escalate also expired", async () => {
    const stale = new Date(Date.now() - DEPENDENCY_WAKE_TERMINAL_SUPPRESSION_MS - 60_000);
    // Only one cancel, hold=15m, created 16m+ ago → null
    const { companyId, idempotencyKey } = await seedWake({
      status: "cancelled",
      createdAt: stale,
      error: "Process lost -- child pid gone",
    });
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

  it("classifies aggregate-ceiling cancel errors as permanent holds", () => {
    expect(
      isPermanentHoldDependencyWakeCancelError(
        "Cancelled before model dispatch: the issue already recorded 2,679,799 weighted aggregate input tokens (cache reads at 0.1); board disposition is required before more generation.",
      ),
    ).toBe(true);
    expect(isPermanentHoldDependencyWakeCancelError("Cancelled by a board operator")).toBe(false);
    expect(isPermanentHoldDependencyWakeCancelError(null)).toBe(false);
  });

  it("escalating suppression doubles per terminal wake and caps", () => {
    expect(computeDependencyWakeEscalatingSuppressionMs(0)).toBe(0);
    expect(computeDependencyWakeEscalatingSuppressionMs(1)).toBe(
      DEPENDENCY_WAKE_ESCALATING_SUPPRESSION_BASE_MS,
    );
    expect(computeDependencyWakeEscalatingSuppressionMs(2)).toBe(
      DEPENDENCY_WAKE_ESCALATING_SUPPRESSION_BASE_MS * 2,
    );
    expect(computeDependencyWakeEscalatingSuppressionMs(3)).toBe(
      DEPENDENCY_WAKE_ESCALATING_SUPPRESSION_BASE_MS * 4,
    );
    expect(computeDependencyWakeEscalatingSuppressionMs(100)).toBe(
      DEPENDENCY_WAKE_ESCALATING_SUPPRESSION_MAX_MS,
    );
  });

  it("TSMC-21321: aggregate-ceiling cancelled wake suppresses forever for the same ready state", async () => {
    const dependentIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const stateKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    // 3 hours ago — far past the old 15m terminal window
    const stale = new Date(Date.now() - 3 * 60 * 60_000);
    const { companyId } = await seedWake({
      status: "cancelled",
      createdAt: stale,
      idempotencyKey: stateKey,
      error:
        "Cancelled before model dispatch: the issue already recorded 999,025 weighted aggregate input tokens (cache reads at 0.1); board disposition is required before more generation.",
    });

    const found = await findExistingIssueBlockersResolvedWakeForReadyState(db, {
      companyId,
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      terminalSuppressionMs: DEPENDENCY_WAKE_TERMINAL_SUPPRESSION_MS,
    });
    expect(found?.idempotencyKey).toBe(stateKey);
    expect(found?.status).toBe("cancelled");

    // Without terminalSuppressionMs (route-time path) permanent hold still applies
    const routeTime = await findExistingIssueBlockersResolvedWakeForReadyState(db, {
      companyId,
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    expect(routeTime?.idempotencyKey).toBe(stateKey);
  });

  it("TSMC-21321: permanent-hold does not suppress a different ready-state key", async () => {
    const dependentIssueId = randomUUID();
    const oldBlocker = randomUUID();
    const newBlocker = randomUUID();
    const oldKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [oldBlocker],
    });
    const { companyId } = await seedWake({
      status: "cancelled",
      createdAt: new Date(Date.now() - 60_000),
      idempotencyKey: oldKey,
      error:
        "Cancelled before model dispatch: the issue already recorded 1 weighted aggregate input tokens; board disposition is required before more generation.",
    });

    const found = await findExistingIssueBlockersResolvedWakeForReadyState(db, {
      companyId,
      dependentIssueId,
      blockerIssueIds: [newBlocker],
      terminalSuppressionMs: DEPENDENCY_WAKE_TERMINAL_SUPPRESSION_MS,
    });
    expect(found).toBeNull();
  });

  it("TSMC-21321: still-blocked hold suppresses backstop after a recent completed wake even when digest would change", async () => {
    const dependentIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const stateKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const { companyId } = await seedWake({
      status: "completed",
      createdAt: new Date(Date.now() - 60_000),
      idempotencyKey: stateKey,
    });
    // seedWake payload uses its own dependentIssueId; re-seed with explicit payload issueId
    // by inserting a second wake whose payload.issueId matches the dependent we query.
    const agentId = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.companyId, companyId))
      .then((rows) => rows[0]!.id);
    const wakeAt = new Date(Date.now() - 30_000);
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: dependentIssueId, resolvedBlockerIssueId: blockerIssueId },
      status: "completed",
      error: null,
      idempotencyKey: stateKey,
      createdAt: wakeAt,
      finishedAt: wakeAt,
    });

    const held = await findStillBlockedDependencyWakeSuppression(db, {
      companyId,
      dependentIssueId,
      now: new Date(),
    });
    expect(held?.status).toBe("completed");
  });

  it("TSMC-21321: still-blocked permanent-hold cancel suppresses issue-level backstop forever", async () => {
    const dependentIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const stateKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const { companyId } = await seedWake({
      status: "cancelled",
      createdAt: new Date(Date.now() - 5 * 60 * 60_000),
      idempotencyKey: stateKey,
      error:
        "Cancelled before model dispatch: the issue already recorded 999,025 weighted aggregate input tokens (cache reads at 0.1); board disposition is required before more generation.",
    });
    const agentId = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.companyId, companyId))
      .then((rows) => rows[0]!.id);
    const stale = new Date(Date.now() - 5 * 60 * 60_000);
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: dependentIssueId },
      status: "cancelled",
      error:
        "Cancelled before model dispatch: the issue already recorded 999,025 weighted aggregate input tokens (cache reads at 0.1); board disposition is required before more generation.",
      idempotencyKey: stateKey,
      createdAt: stale,
      finishedAt: stale,
    });

    const held = await findStillBlockedDependencyWakeSuppression(db, {
      companyId,
      dependentIssueId,
      now: new Date(),
    });
    expect(held?.status).toBe("cancelled");
    expect(isPermanentHoldDependencyWakeCancelError(held?.error)).toBe(true);
  });

  it("TSMC-21321: still-blocked hold expires so a later genuine backstop can fire", async () => {
    const dependentIssueId = randomUUID();
    const { companyId } = await seedWake({
      status: "completed",
      // Single completed wake → hold = 15m; 16m+ ago → expired
      createdAt: new Date(Date.now() - DEPENDENCY_WAKE_ESCALATING_SUPPRESSION_BASE_MS - 60_000),
    });
    const agentId = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.companyId, companyId))
      .then((rows) => rows[0]!.id);
    const stale = new Date(Date.now() - DEPENDENCY_WAKE_ESCALATING_SUPPRESSION_BASE_MS - 60_000);
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: dependentIssueId },
      status: "completed",
      error: null,
      idempotencyKey: `issue_blockers_resolved:state:${dependentIssueId}:0:deadbeef`,
      createdAt: stale,
      finishedAt: stale,
    });

    const held = await findStillBlockedDependencyWakeSuppression(db, {
      companyId,
      dependentIssueId,
      now: new Date(),
    });
    expect(held).toBeNull();
  });
});
