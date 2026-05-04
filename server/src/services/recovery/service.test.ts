import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { recoveryService } from "./service.js";

const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockAddComment = vi.fn();

vi.mock("../issues.js", () => ({
  issueService: () => ({
    create: mockCreate,
    update: mockUpdate,
    addComment: mockAddComment,
    getRelationSummaries: vi.fn().mockResolvedValue([]),
  }),
}));

vi.mock("../activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../issue-tree-control.js", () => ({
  issueTreeControlService: () => ({}),
}));

// Minimal drizzle-ORM chain mock:
//   .select([cols]).from(t).where(c).limit(n) → Promise<rows>
//   .select([cols]).from(t).where(c).orderBy(...).limit(n).then(cb) → Promise
//   .select([cols]).from(t).innerJoin(t2,c).where(c).then(cb) → Promise
//   .select([cols]).from(t).where(c).then(cb) → Promise
function makeSelectChain(rows: unknown[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const thenable: Record<string, any> = {
    limit: () => Promise.resolve(rows),
    then: (cb: (r: unknown[]) => unknown) => Promise.resolve(cb(rows)),
    orderBy: () => thenable,
  };
  const chain: Record<string, () => unknown> = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => thenable,
  };
  return chain;
}

function makeDb(selectResponses: unknown[][]): Db {
  let callCount = 0;
  return {
    select: vi.fn(() => makeSelectChain(selectResponses[callCount++] ?? [])),
    insert: vi.fn(() => ({ values: () => Promise.resolve([]) })),
  } as unknown as Db;
}

describe("ensureStrandedIssueRecoveryIssue status gate (ELE-32)", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockUpdate.mockReset().mockResolvedValue(null); // returns null → escalate returns early
    mockAddComment.mockReset().mockResolvedValue(undefined);
  });

  // bemsas review (blocking): when fresh DB status is inert, escalation must
  // ALSO short-circuit BEFORE calling issuesSvc.update — otherwise the
  // status=blocked update would resurrect a done/cancelled source.
  // DB call order for the inert path inside escalateStrandedAssignedIssue:
  //   1. ensureStrandedIssueRecoveryIssue: re-fetch source → inert status → return { skipReason: 'inert_status' }
  //   (no further DB calls; caller early-returns before existingUnresolvedBlockerIssueIds)
  const inertStatuses = ["blocked", "cancelled", "done"] as const;

  for (const sourceStatus of inertStatuses) {
    it(`does NOT call issuesSvc.create OR issuesSvc.update when fresh DB status is '${sourceStatus}'`, async () => {
      const db = makeDb([
        [{ id: "src-1", status: sourceStatus }], // re-fetch in ensureStrandedIssueRecoveryIssue
      ]);

      const svc = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(undefined) });

      const fakeIssue = {
        id: "src-1",
        companyId: "co-1",
        status: "in_progress", // stale; DB re-fetch returns inert
        originKind: null,
        identifier: "ELE-19",
        title: "Test issue",
        priority: "medium",
        projectId: null,
        goalId: null,
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        billingCode: null,
        hiddenAt: null,
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      await svc.escalateStrandedAssignedIssue({
        issue: fakeIssue,
        previousStatus: "in_progress",
        latestRun: null,
        comment: "recovery escalation",
      });

      expect(mockCreate).not.toHaveBeenCalled();
      // Critical for bemsas-blocking #1: update MUST NOT fire on inert source.
      expect(mockUpdate).not.toHaveBeenCalled();
      // Exactly 1 select call = freshSource only; the early-return in the caller
      // prevents any subsequent queries (existingUnresolvedBlockerIssueIds etc).
      expect((db.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    });
  }
});

// Base issue used by ELE-36 gate tests.
// assigneeAgentId and createdByAgentId are null so resolveStrandedIssueRecoveryOwnerAgentId
// only does one role-candidates select before returning null (no owner → no create).
const ele36BaseIssue = {
  id: "src-1",
  companyId: "co-1",
  status: "in_progress",
  originKind: null,
  identifier: "ELE-19",
  title: "Test issue",
  priority: "medium",
  projectId: null,
  goalId: null,
  assigneeAgentId: null,
  assigneeUserId: null,
  createdByAgentId: null,
  billingCode: null,
  hiddenAt: null,
  parentId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe("ensureStrandedIssueRecoveryIssue sibling-time-window gate (ELE-36)", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockUpdate.mockReset().mockResolvedValue(null);
    mockAddComment.mockReset().mockResolvedValue(undefined);
  });

  // bemsas review (blocking): when an OPEN recovery sibling exists within the 5-min
  // window, the gate suppresses creation AND returns the sibling so the caller can
  // link source.blockedByIssueIds → sibling.id (preserves the pre-iter-2 race-conflict
  // catch-block invariant).
  // DB call order:
  //   1. freshSource → in_progress
  //   2. sibling check → [open sibling found] → return { recovery: sibling, skipReason: 'recent_sibling' }
  //   3. existingUnresolvedBlockerIssueIds (caller proceeds to update)
  //   4. (issuesSvc.update is mocked; no extra DB call)
  it("returns OPEN sibling for linkage when a recovery sibling was created 4 min ago", async () => {
    const db = makeDb([
      [{ id: "src-1", status: "in_progress" }],                    // freshSource
      [{ id: "sib-1", status: "in_progress", hiddenAt: null }],   // open sibling
      [],                                                            // existingUnresolvedBlockerIssueIds
    ]);

    mockUpdate.mockResolvedValueOnce({ id: "src-1" }); // simulate successful update so caller proceeds

    const svc = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(undefined) });
    await svc.escalateStrandedAssignedIssue({
      issue: ele36BaseIssue,
      previousStatus: "in_progress",
      latestRun: null,
      comment: "recovery escalation",
    });

    expect(mockCreate).not.toHaveBeenCalled();
    // Caller MUST link source.blockedByIssueIds to the open sibling's id.
    expect(mockUpdate).toHaveBeenCalledWith(
      "src-1",
      expect.objectContaining({
        status: "blocked",
        blockedByIssueIds: ["sib-1"],
      }),
    );
    expect((db.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
  });

  // bemsas review (blocking): a CLOSED sibling within the window must NOT be
  // linked (linking source to a `done` recovery is misleading). Gate still
  // suppresses creation — debounce semantics — but recoveryIssue is null,
  // so blockedByIssueIds stays empty.
  it("suppresses creation but does NOT link when sibling within window is closed", async () => {
    const db = makeDb([
      [{ id: "src-1", status: "in_progress" }],                    // freshSource
      [{ id: "sib-1", status: "done", hiddenAt: null }],           // closed sibling
      [],                                                            // existingUnresolvedBlockerIssueIds
    ]);

    mockUpdate.mockResolvedValueOnce({ id: "src-1" });

    const svc = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(undefined) });
    await svc.escalateStrandedAssignedIssue({
      issue: ele36BaseIssue,
      previousStatus: "in_progress",
      latestRun: null,
      comment: "recovery escalation",
    });

    expect(mockCreate).not.toHaveBeenCalled();
    // Critical: blockedByIssueIds must be EMPTY — closed sibling is not a valid blocker.
    expect(mockUpdate).toHaveBeenCalledWith(
      "src-1",
      expect.objectContaining({
        status: "blocked",
        blockedByIssueIds: [],
      }),
    );
    expect((db.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
  });

  // Hidden sibling (hiddenAt set) is treated the same as closed — no linkage.
  it("suppresses creation but does NOT link when sibling within window is hidden", async () => {
    const db = makeDb([
      [{ id: "src-1", status: "in_progress" }],
      [{ id: "sib-1", status: "in_progress", hiddenAt: new Date() }], // open status, but hidden
      [],
    ]);

    mockUpdate.mockResolvedValueOnce({ id: "src-1" });

    const svc = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(undefined) });
    await svc.escalateStrandedAssignedIssue({
      issue: ele36BaseIssue,
      previousStatus: "in_progress",
      latestRun: null,
      comment: "recovery escalation",
    });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith(
      "src-1",
      expect.objectContaining({ blockedByIssueIds: [] }),
    );
  });

  // DB call order when sibling is outside window (allowed path):
  //   1. freshSource → in_progress
  //   2. sibling check → [] (6 min is outside 5-min window)
  //   3. [FOR OPS] check → []
  //   4. findOpenStrandedIssueRecoveryIssue → []
  //   5. roleCandidates (CTO/CEO) → [] → no owner → return null
  //   6. existingUnresolvedBlockerIssueIds
  it("proceeds past sibling gate when the only sibling was created 6 min ago", async () => {
    const db = makeDb([
      [{ id: "src-1", status: "in_progress" }], // freshSource
      [],                                         // sibling check → empty (outside window)
      [],                                         // [FOR OPS] check
      [],                                         // findOpenStrandedIssueRecoveryIssue
      [],                                         // roleCandidates → no owner → return null
      [],                                         // existingUnresolvedBlockerIssueIds
    ]);

    const svc = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(undefined) });
    await svc.escalateStrandedAssignedIssue({
      issue: ele36BaseIssue,
      previousStatus: "in_progress",
      latestRun: null,
      comment: "recovery escalation",
    });

    expect(mockCreate).not.toHaveBeenCalled(); // no owner found, not a gate skip
    // 6 select calls confirms the function reached findOpenStrandedIssueRecoveryIssue
    expect((db.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(6);
  });
});

describe("ensureStrandedIssueRecoveryIssue [FOR OPS]-active gate (ELE-36)", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockUpdate.mockReset().mockResolvedValue(null);
    mockAddComment.mockReset().mockResolvedValue(undefined);
  });

  // DB call order when ops issue found (skipped path):
  //   1. freshSource → in_progress
  //   2. sibling check → []
  //   3. [FOR OPS] check → [found] → early return null
  //   4. existingUnresolvedBlockerIssueIds
  it("does NOT call issuesSvc.create when an open [FOR OPS] issue mentions source.identifier", async () => {
    const db = makeDb([
      [{ id: "src-1", status: "in_progress" }], // freshSource
      [],                                         // sibling check → empty
      [{ id: "ops-1" }],                         // [FOR OPS] check → found → skip
      [],                                         // existingUnresolvedBlockerIssueIds
    ]);

    const svc = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(undefined) });
    await svc.escalateStrandedAssignedIssue({
      issue: ele36BaseIssue,
      previousStatus: "in_progress",
      latestRun: null,
      comment: "recovery escalation",
    });

    expect(mockCreate).not.toHaveBeenCalled();
    // 4 select calls confirms early return from [FOR OPS] gate
    expect((db.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
  });

  // Closed [FOR OPS] issue is filtered out by notInArray(status, ['done','cancelled'])
  // so the DB returns [] and the gate does not fire.
  it("proceeds past [FOR OPS] gate when the matching issue is closed (done/cancelled)", async () => {
    const db = makeDb([
      [{ id: "src-1", status: "in_progress" }], // freshSource
      [],                                         // sibling check → empty
      [],                                         // [FOR OPS] check → empty (closed issues filtered)
      [],                                         // findOpenStrandedIssueRecoveryIssue
      [],                                         // roleCandidates → no owner
      [],                                         // existingUnresolvedBlockerIssueIds
    ]);

    const svc = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(undefined) });
    await svc.escalateStrandedAssignedIssue({
      issue: ele36BaseIssue,
      previousStatus: "in_progress",
      latestRun: null,
      comment: "recovery escalation",
    });

    expect(mockCreate).not.toHaveBeenCalled(); // no owner found, not a gate skip
    expect((db.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(6);
  });

  // [FOR OPS] issue exists but description does not mention source.identifier so ilike fails
  // → DB returns [] and gate does not fire.
  it("proceeds past [FOR OPS] gate when no [FOR OPS] issue mentions source.identifier", async () => {
    const db = makeDb([
      [{ id: "src-1", status: "in_progress" }], // freshSource
      [],                                         // sibling check → empty
      [],                                         // [FOR OPS] check → empty (ilike no match)
      [],                                         // findOpenStrandedIssueRecoveryIssue
      [],                                         // roleCandidates → no owner
      [],                                         // existingUnresolvedBlockerIssueIds
    ]);

    const svc = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(undefined) });
    await svc.escalateStrandedAssignedIssue({
      issue: ele36BaseIssue,
      previousStatus: "in_progress",
      latestRun: null,
      comment: "recovery escalation",
    });

    expect(mockCreate).not.toHaveBeenCalled(); // no owner found, not a gate skip
    expect((db.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(6);
  });
});
