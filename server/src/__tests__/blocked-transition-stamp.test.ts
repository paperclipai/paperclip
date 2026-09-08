import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { isProspectiveBlockedTransition } from "../services/routable-blocked.js";

// Regression coverage: every write site that can leave an issue row in
// `status: "blocked"` must stamp `blockedTransitionAt` (fix shape: a single
// funnel helper, `deriveBlockedEntryPatch` / `BLOCKED_EXIT_PATCH` in
// routable-blocked.ts), and every write site that takes a row *out* of
// `blocked` must clear `unblockDescriptor` / `blockedTransitionAt` /
// `blockedOwnerNotifiedAt` together.
//
// One test per write site named in the audit, plus the
// already-blocked-then-descriptor-added case that motivated the funnel
// helper over per-call-site stamping, plus a re-entry case proving the
// stamp always advances on a fresh transition into blocked even when a
// stale stamp survived an earlier exit.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocked-transition-stamp tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("blocked transition stamp funnel", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-transition-stamp-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix = "BTS") {
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

  async function readIssue(id: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, id));
    return row;
  }

  it("create(): a row born directly as status:'blocked' gets stamped (routes/issues.ts createChild/decomposeAcceptedPlan reach this)", async () => {
    const { companyId } = await createCompany("BTC");
    const before = new Date();

    const created = await svc.create(companyId, {
      title: "Born blocked",
      status: "blocked",
    });

    expect(created.status).toBe("blocked");
    expect(created.blockedTransitionAt).not.toBeNull();
    expect(created.blockedTransitionAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(isProspectiveBlockedTransition(created as unknown as { status: string; blockedTransitionAt: Date | null })).toBe(true);
  });

  it("create(): a non-blocked row is unaffected — no spurious stamp", async () => {
    const { companyId } = await createCompany("BTN");
    const created = await svc.create(companyId, { title: "Not blocked", status: "todo" });
    expect(created.blockedTransitionAt).toBeNull();
  });

  it("importIssues(): a row imported directly as status:'blocked' gets a best-effort stamp from its preserved timestamps, not left null", async () => {
    const { companyId } = await createCompany("BTI");
    const issueId = randomUUID();
    const preservedUpdatedAt = new Date("2026-06-01T00:00:00.000Z");

    await svc.importIssues(companyId, [
      {
        id: issueId,
        ref: "ref-1",
        projectId: null,
        projectWorkspaceId: null,
        title: "Imported blocked",
        description: null,
        assigneeAgentId: null,
        status: "blocked",
        priority: "medium",
        billingCode: null,
        assigneeAdapterOverrides: null,
        executionWorkspaceSettings: null,
        labelIds: [],
        monitorNotes: null,
        monitorScheduledBy: null,
        updatedAt: preservedUpdatedAt,
      },
    ]);

    const row = await readIssue(issueId);
    expect(row?.status).toBe("blocked");
    expect(row?.blockedTransitionAt).toEqual(preservedUpdatedAt);
  });

  it("importIssues(): a non-blocked row still gets no stamp", async () => {
    const { companyId } = await createCompany("BTJ");
    const issueId = randomUUID();
    await svc.importIssues(companyId, [
      {
        id: issueId,
        ref: "ref-2",
        projectId: null,
        projectWorkspaceId: null,
        title: "Imported open",
        description: null,
        assigneeAgentId: null,
        status: "todo",
        priority: "medium",
        billingCode: null,
        assigneeAdapterOverrides: null,
        executionWorkspaceSettings: null,
        labelIds: [],
        monitorNotes: null,
        monitorScheduledBy: null,
      },
    ]);
    const row = await readIssue(issueId);
    expect(row?.blockedTransitionAt).toBeNull();
  });

  it("update(): self-heals a row that was born blocked (null stamp) and later receives an unblockDescriptor with no status change — the case per-call-site stamping cannot fix", async () => {
    const { companyId, agentId } = await createCompany("BTS2");
    // Simulate the born-blocked defect directly (bypassing create()'s own
    // fix) so this test proves update()'s self-heal branch specifically,
    // independent of whether create() is also fixed.
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${companyId.slice(0, 4)}-1`,
      title: "Born blocked, unstamped",
      status: "blocked",
      priority: "medium",
      blockedTransitionAt: null,
    });

    const updated = await svc.update(issueId, {
      unblockDescriptor: { owner: { agentId }, action: "Rule on this" },
    });

    expect(updated?.status).toBe("blocked");
    expect(updated?.blockedTransitionAt).not.toBeNull();
    expect(
      isProspectiveBlockedTransition(updated as unknown as { status: string; blockedTransitionAt: Date | null }),
    ).toBe(true);
  });

  it("update(): leaving blocked clears unblockDescriptor, blockedTransitionAt and blockedOwnerNotifiedAt together", async () => {
    const { companyId, agentId } = await createCompany("BTS3");
    const created = await svc.create(companyId, {
      title: "Will be unblocked via update()",
      status: "blocked",
      unblockDescriptor: { owner: { agentId }, action: "Do the thing" },
    });
    await db.update(issues).set({ blockedOwnerNotifiedAt: new Date() }).where(eq(issues.id, created.id));

    const updated = await svc.update(created.id, { status: "todo" });

    expect(updated?.status).toBe("todo");
    expect(updated?.unblockDescriptor).toBeNull();
    expect(updated?.blockedTransitionAt).toBeNull();
    expect(updated?.blockedOwnerNotifiedAt).toBeNull();
  });

  it("checkout(): leaving blocked via the raw re-assignment write also clears all three fields — the bug that stranded a live unblockDescriptor on a non-blocked row", async () => {
    const { companyId, agentId } = await createCompany("BTS4");
    const created = await svc.create(companyId, {
      title: "Parked pending a decision, then blocker resolves",
      status: "blocked",
      unblockDescriptor: { owner: { agentId }, action: "Rule on the fix shape" },
    });
    await db.update(issues).set({ blockedOwnerNotifiedAt: new Date() }).where(eq(issues.id, created.id));

    // Mirrors issue_blockers_resolved re-dispatch: checkout() accepts
    // "blocked" in expectedStatuses and moves the row to in_progress.
    const checkedOut = await svc.checkout(created.id, agentId, ["todo", "backlog", "blocked"], null);

    expect(checkedOut?.status).toBe("in_progress");
    expect(checkedOut?.unblockDescriptor).toBeNull();
    expect(checkedOut?.blockedTransitionAt).toBeNull();
    expect(checkedOut?.blockedOwnerNotifiedAt).toBeNull();

    // Before the fix this row would have kept status:"blocked"'s descriptor
    // while status flipped to in_progress — a shape routes/issues.ts's own
    // PATCH validation refuses to create, but this internal path could.
    const row = await readIssue(created.id);
    expect(row?.status).toBe("in_progress");
    expect(row?.unblockDescriptor).toBeNull();
  });

  it("checkout() is a no-op on the blocked fields for a row that was never blocked", async () => {
    const { companyId, agentId } = await createCompany("BTS5");
    const created = await svc.create(companyId, { title: "Plain todo", status: "todo" });

    const checkedOut = await svc.checkout(created.id, agentId, ["todo"], null);

    expect(checkedOut?.status).toBe("in_progress");
    expect(checkedOut?.unblockDescriptor).toBeNull();
    expect(checkedOut?.blockedTransitionAt).toBeNull();
  });

  it("update(): a fresh transition into blocked always advances the stamp, even when a stale stamp from an earlier cycle survived on the row", async () => {
    // Reproduces a defect this suite's other exit-side tests otherwise miss:
    // a row exits blocked through some path that doesn't clear
    // blockedTransitionAt, so a stale stamp is still sitting on the row when
    // it re-enters blocked. deriveBlockedEntryPatch is idempotent (no-op
    // when a stamp already exists) and is the wrong helper for this branch
    // specifically because blockedTransitionAt is the wake *cycle key*
    // (issue-dependency-wakeups.ts): reusing the stale stamp would let a
    // completed wake from the old cycle match the new cycle's key and
    // silently suppress the new issue_blockers_resolved wake.
    const { companyId } = await createCompany("BTS6");
    const created = await svc.create(companyId, { title: "Cycle one", status: "todo" });

    const staleStamp = new Date("2026-01-01T00:00:00.000Z");
    await db
      .update(issues)
      .set({ status: "blocked", blockedTransitionAt: staleStamp })
      .where(eq(issues.id, created.id));
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, created.id));
    // Row is now back to todo but still carries the stale stamp — this
    // instance's live audit found rows in exactly this shape.
    const beforeReentry = await readIssue(created.id);
    expect(beforeReentry?.status).toBe("todo");
    expect(beforeReentry?.blockedTransitionAt).toEqual(staleStamp);

    const reentered = await svc.update(created.id, { status: "blocked" });

    expect(reentered?.status).toBe("blocked");
    expect(reentered?.blockedTransitionAt).not.toBeNull();
    expect(reentered!.blockedTransitionAt!.getTime()).not.toEqual(staleStamp.getTime());
    expect(reentered!.blockedTransitionAt!.getTime()).toBeGreaterThan(staleStamp.getTime());
  });

  it("release(): self-heals a row released back onto status:'blocked' (not in_progress) that was never stamped", async () => {
    // release() only re-queues in_progress work to todo; a blocked row's
    // status is preserved as-is. That makes release() a self-heal site per
    // the funnel helper's own docblock.
    const { companyId, agentId } = await createCompany("BTS7");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${companyId.slice(0, 4)}-1`,
      title: "Born blocked, unstamped, then assigned+released",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      blockedTransitionAt: null,
    });

    const released = await svc.release(issueId, agentId, null);

    expect(released?.status).toBe("blocked");
    expect(released?.blockedTransitionAt).not.toBeNull();
    expect(
      isProspectiveBlockedTransition(released as unknown as { status: string; blockedTransitionAt: Date | null }),
    ).toBe(true);
  });

  it("release(): is a no-op on the stamp for a blocked row that already has one", async () => {
    const { companyId, agentId } = await createCompany("BTS8");
    const created = await svc.create(companyId, {
      title: "Blocked with a live stamp",
      status: "blocked",
    });
    const stampBefore = created.blockedTransitionAt;

    await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, created.id));
    const released = await svc.release(created.id, agentId, null);

    expect(released?.status).toBe("blocked");
    expect(released?.blockedTransitionAt).toEqual(stampBefore);
  });
});
