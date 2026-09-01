import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { blockedOwnerNotificationReconcilerService } from "../services/blocked-owner-notification-reconciler.js";
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

  it("skips a board-owned descriptor — that owner is covered live by the attention feed, not this sweep", async () => {
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
    expect(result).toMatchObject({ scanned: 1, notified: 0, skipped: 1 });
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
});
