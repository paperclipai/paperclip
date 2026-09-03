import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  blockedOwnerNotificationReconcilerService,
  DELIVERY_FAILURE_BASE_COOLDOWN_MS,
  MAX_BLOCKED_OWNER_NOTIFICATION_CANDIDATES,
} from "../services/blocked-owner-notification-reconciler.js";
import { ROUTABLE_BLOCKED_ROLLOUT_AT } from "../services/routable-blocked.js";

// deliverAgentUnblockNotification has exactly one call site
// (routes/issues.ts, guarded by the not-blocked -> blocked write edge). A row
// that reaches status:"blocked" with a stamp any other way (a historical
// backfill, one of the deriveBlockedEntryPatch self-heal branches, an
// import, a restore) never crosses that edge and is
// otherwise permanently unnotifiable. This reconciler is the fix: it
// re-evaluates the same predicate on the heartbeat scheduler tick instead of
// only at the edge, reusing deliverAgentUnblockNotification's own
// idempotency so it is always safe to run.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocked-owner-notification-reconciler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("blocked-owner notification reconciler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-owner-notification-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix = "BON") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${prefix} Agent`,
      role: "engineer",
      status: "idle",
    });
    return { companyId, agentId };
  }

  async function insertBlockedIssue(input: {
    companyId: string;
    title: string;
    unblockDescriptor: { owner: { agentId: string } | { userId: string } | "board"; action: string } | null;
    blockedTransitionAt: Date | null;
    blockedOwnerNotifiedAt?: Date | null;
    status?: string;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      title: input.title,
      status: input.status ?? "blocked",
      unblockDescriptor: input.unblockDescriptor,
      blockedTransitionAt: input.blockedTransitionAt,
      blockedOwnerNotifiedAt: input.blockedOwnerNotifiedAt ?? null,
    });
    return id;
  }

  async function readIssue(id: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, id));
    return row;
  }

  it("notifies a row stamped outside the write edge — a historical backfill shape", async () => {
    const { companyId, agentId } = await createCompany("BOA");
    const stampedByBackfill = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1000);
    const issueId = await insertBlockedIssue({
      companyId,
      title: "Backfilled blocked row, never crossed the write edge",
      unblockDescriptor: { owner: { agentId }, action: "Rule on the four options" },
      blockedTransitionAt: stampedByBackfill,
    });

    const wakeup = vi.fn(async () => undefined);
    const reconciler = blockedOwnerNotificationReconcilerService(db, { wakeup });
    const result = await reconciler.reconcileBlockedOwnerNotifications({ companyId });

    expect(result).toMatchObject({ scanned: 1, notified: 1, skipped: 0, failed: 0 });
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: "issue_unblock_requested",
      idempotencyKey: `issue-unblock:${issueId}:${stampedByBackfill.toISOString()}`,
    }));

    const row = await readIssue(issueId);
    expect(row?.blockedOwnerNotifiedAt).not.toBeNull();
  });

  it("is idempotent — a second sweep does not re-notify the same row", async () => {
    const { companyId, agentId } = await createCompany("BOB");
    const stampedByBackfill = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1000);
    await insertBlockedIssue({
      companyId,
      title: "Backfilled blocked row",
      unblockDescriptor: { owner: { agentId }, action: "Rule on the four options" },
      blockedTransitionAt: stampedByBackfill,
    });

    const wakeup = vi.fn(async () => undefined);
    const reconciler = blockedOwnerNotificationReconcilerService(db, { wakeup });
    await reconciler.reconcileBlockedOwnerNotifications({ companyId });
    const second = await reconciler.reconcileBlockedOwnerNotifications({ companyId });

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ scanned: 0, notified: 0 });
  });

  // A board-owned descriptor is now excluded by the candidate query itself,
  // not scanned and then skipped in the loop. The behaviour that matters is
  // unchanged — no wake, never marked notified — but the row no longer takes
  // up a slot in the batch, which is what let these rows starve deliverable
  // ones (Greptile finding 2 on #12734).
  it("excludes a board-owned descriptor — that owner is covered live by the attention feed, not this sweep", async () => {
    const { companyId } = await createCompany("BOC");
    const issueId = await insertBlockedIssue({
      companyId,
      title: "Board-owned blocked row",
      unblockDescriptor: { owner: "board", action: "Board decides" },
      blockedTransitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1000),
    });

    const wakeup = vi.fn(async () => undefined);
    const reconciler = blockedOwnerNotificationReconcilerService(db, { wakeup });
    const result = await reconciler.reconcileBlockedOwnerNotifications({ companyId });

    expect(wakeup).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 0, notified: 0, skipped: 0 });
    const row = await readIssue(issueId);
    expect(row?.blockedOwnerNotifiedAt).toBeNull();
  });

  it("excludes an already-notified row from the candidate query", async () => {
    const { companyId, agentId } = await createCompany("BOD");
    await insertBlockedIssue({
      companyId,
      title: "Already notified",
      unblockDescriptor: { owner: { agentId }, action: "Already handled" },
      blockedTransitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1000),
      blockedOwnerNotifiedAt: new Date(),
    });

    const wakeup = vi.fn(async () => undefined);
    const reconciler = blockedOwnerNotificationReconcilerService(db, { wakeup });
    const result = await reconciler.reconcileBlockedOwnerNotifications({ companyId });

    expect(wakeup).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 0, notified: 0 });
  });

  it("excludes a non-blocked row and a blocked row with no unblockDescriptor", async () => {
    const { companyId, agentId } = await createCompany("BOE");
    await insertBlockedIssue({
      companyId,
      title: "Not blocked",
      status: "in_progress",
      unblockDescriptor: { owner: { agentId }, action: "n/a" },
      blockedTransitionAt: null,
    });
    await insertBlockedIssue({
      companyId,
      title: "Blocked with no descriptor",
      unblockDescriptor: null,
      blockedTransitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1000),
    });

    const wakeup = vi.fn(async () => undefined);
    const reconciler = blockedOwnerNotificationReconcilerService(db, { wakeup });
    const result = await reconciler.reconcileBlockedOwnerNotifications({ companyId });

    expect(wakeup).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 0, notified: 0 });
  });

  it("does not cross company boundaries when scoped by companyId", async () => {
    const { companyId: companyA } = await createCompany("BOF");
    const { companyId: companyB, agentId: agentB } = await createCompany("BOG");
    await insertBlockedIssue({
      companyId: companyB,
      title: "Other company's blocked row",
      unblockDescriptor: { owner: { agentId: agentB }, action: "Not company A's business" },
      blockedTransitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1000),
    });

    const wakeup = vi.fn(async () => undefined);
    const reconciler = blockedOwnerNotificationReconcilerService(db, { wakeup });
    const result = await reconciler.reconcileBlockedOwnerNotifications({ companyId: companyA });

    expect(wakeup).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 0, notified: 0 });
  });
  // Greptile finding 1 on #12734: the completion write matched on id and
  // companyId alone, so a row that moved between the select and the write had
  // the *current* cycle stamped notified by a wake built for the previous one.
  it("does not mark a new blocked cycle notified with a wake built for the old one", async () => {
    const { companyId, agentId } = await createCompany("BOF");
    const firstCycle = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1000);
    const secondCycle = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 90_000);
    const issueId = await insertBlockedIssue({
      companyId,
      title: "Re-enters blocked while the wake is in flight",
      unblockDescriptor: { owner: { agentId }, action: "Rule on the four options" },
      blockedTransitionAt: firstCycle,
    });

    // The row exits and re-enters blocked while the wake is being delivered.
    const wakeup = vi.fn(async () => {
      await db
        .update(issues)
        .set({ blockedTransitionAt: secondCycle, blockedOwnerNotifiedAt: null })
        .where(eq(issues.id, issueId));
    });
    const reconciler = blockedOwnerNotificationReconcilerService(db, { wakeup });
    const result = await reconciler.reconcileBlockedOwnerNotifications({ companyId });

    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      idempotencyKey: `issue-unblock:${issueId}:${firstCycle.toISOString()}`,
    }));
    expect(result).toMatchObject({ notified: 0, skipped: 1 });

    // The new cycle must stay eligible, not be written off as notified.
    const row = await readIssue(issueId);
    expect(row?.blockedOwnerNotifiedAt).toBeNull();
    expect(row?.blockedTransitionAt?.toISOString()).toBe(secondCycle.toISOString());
  });

  it("does not mark a row notified when its unblock owner changed during delivery", async () => {
    const { companyId, agentId } = await createCompany("BOG");
    const { agentId: newOwnerId } = await createCompany("BOH");
    const stamp = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1000);
    const issueId = await insertBlockedIssue({
      companyId,
      title: "Owner reassigned while the wake is in flight",
      unblockDescriptor: { owner: { agentId }, action: "Rule on the four options" },
      blockedTransitionAt: stamp,
    });

    const wakeup = vi.fn(async () => {
      await db
        .update(issues)
        .set({ unblockDescriptor: { owner: { agentId: newOwnerId }, action: "Rule on the four options" } })
        .where(eq(issues.id, issueId));
    });
    const reconciler = blockedOwnerNotificationReconcilerService(db, { wakeup });
    const result = await reconciler.reconcileBlockedOwnerNotifications({ companyId });

    expect(result).toMatchObject({ notified: 0, skipped: 1 });
    const row = await readIssue(issueId);
    expect(row?.blockedOwnerNotifiedAt).toBeNull();
  });

  // Greptile finding 2 on #12734: the candidate query was unordered and did
  // not exclude rows the delivery helper permanently no-ops on, so a full
  // batch of those rows starved every deliverable row behind them.
  it("does not let permanently undeliverable rows starve a deliverable one", async () => {
    const { companyId, agentId } = await createCompany("BOI");
    const oldStamp = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1000);

    // Fill the whole batch with board-owned rows: always a no-op, forever.
    for (let i = 0; i < MAX_BLOCKED_OWNER_NOTIFICATION_CANDIDATES; i += 1) {
      await insertBlockedIssue({
        companyId,
        title: `Board-owned, never deliverable ${i}`,
        unblockDescriptor: { owner: "board", action: "Board decides" },
        blockedTransitionAt: oldStamp,
      });
    }
    // One deliverable row, stamped later so an unordered or oldest-first scan
    // over the undeliverable rows would reach it last.
    const deliverableId = await insertBlockedIssue({
      companyId,
      title: "Agent-owned and deliverable",
      unblockDescriptor: { owner: { agentId }, action: "Rule on the four options" },
      blockedTransitionAt: new Date(oldStamp.getTime() + 60_000),
    });

    const wakeup = vi.fn(async () => undefined);
    const reconciler = blockedOwnerNotificationReconcilerService(db, { wakeup });
    const result = await reconciler.reconcileBlockedOwnerNotifications({ companyId });

    expect(result.notified).toBe(1);
    expect(result.notifiedIssueIds).toEqual([deliverableId]);
    expect(wakeup).toHaveBeenCalledTimes(1);
    const row = await readIssue(deliverableId);
    expect(row?.blockedOwnerNotifiedAt).not.toBeNull();
  });
  // Greptile finding 1 on a6562cd: the fence matched the owner agent id but
  // not the action, so an action change during delivery was marked notified
  // against a wake that carried the old action.
  it("does not mark a row notified when only its unblock action changed during delivery", async () => {
    const { companyId, agentId } = await createCompany("BOJ");
    const stamp = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1000);
    const issueId = await insertBlockedIssue({
      companyId,
      title: "Action rewritten while the wake is in flight",
      unblockDescriptor: { owner: { agentId }, action: "Rule on the four options" },
      blockedTransitionAt: stamp,
    });

    // Same owner, same stamp — only the action changes.
    const wakeup = vi.fn(async () => {
      await db
        .update(issues)
        .set({ unblockDescriptor: { owner: { agentId }, action: "Rule on the six options instead" } })
        .where(eq(issues.id, issueId));
    });
    const reconciler = blockedOwnerNotificationReconcilerService(db, { wakeup });
    const result = await reconciler.reconcileBlockedOwnerNotifications({ companyId });

    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      payload: expect.objectContaining({ action: "Rule on the four options" }),
    }));
    expect(result).toMatchObject({ notified: 0, skipped: 1 });

    // The rewritten action must stay eligible: nobody has been told about it.
    const row = await readIssue(issueId);
    expect(row?.blockedOwnerNotifiedAt).toBeNull();
  });

  // Greptile finding 2 on a6562cd: ordering oldest-first made a permanently
  // failing row hold the head of the batch on every tick, which starved the
  // rows behind it deterministically.
  it("advances past a candidate whose delivery keeps failing", async () => {
    const { companyId, agentId } = await createCompany("BOK");
    const oldest = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1000);
    const brokenId = await insertBlockedIssue({
      companyId,
      title: "Owner agent is uninvokable",
      unblockDescriptor: { owner: { agentId }, action: "Never deliverable" },
      blockedTransitionAt: oldest,
    });
    const healthyId = await insertBlockedIssue({
      companyId,
      title: "Perfectly deliverable, but younger",
      unblockDescriptor: { owner: { agentId }, action: "Rule on the four options" },
      blockedTransitionAt: new Date(oldest.getTime() + 60_000),
    });

    let clock = Date.now();
    const wakeup = vi.fn(async (_agentId: string, opts: { payload?: { issueId?: string } }) => {
      if (opts.payload?.issueId === brokenId) throw new Error("agent is not invokable");
      return undefined;
    });
    const reconciler = blockedOwnerNotificationReconcilerService(db, {
      wakeup: wakeup as never,
      now: () => new Date(clock),
    });

    const first = await reconciler.reconcileBlockedOwnerNotifications({ companyId });
    expect(first).toMatchObject({ failed: 1, notified: 1 });
    expect(first.notifiedIssueIds).toEqual([healthyId]);

    // Immediately after, the broken row is in cooldown and is not re-attempted.
    const second = await reconciler.reconcileBlockedOwnerNotifications({ companyId });
    expect(second).toMatchObject({ scanned: 0, failed: 0 });

    // Once the cooldown expires it is retried — the backoff defers it, it does
    // not drop it.
    clock += DELIVERY_FAILURE_BASE_COOLDOWN_MS + 1000;
    const third = await reconciler.reconcileBlockedOwnerNotifications({ companyId });
    expect(third).toMatchObject({ scanned: 1, failed: 1 });
    expect(third.failedIssueIds).toEqual([brokenId]);
  });
});
