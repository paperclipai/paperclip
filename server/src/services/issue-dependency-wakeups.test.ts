import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  buildIssueBlockersResolvedWakeIdempotencyKey,
  buildIssueBlockersResolvedWakeStateKey,
  buildIssueBlockersResolvedWakeStateKeyWithoutCycle,
  findRecentCompletedWakeForResolvedBlockerSet,
  findExistingIssueBlockersResolvedWakeForReadyState,
} from "./issue-dependency-wakeups.js";

const dependentIssueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const blockerIssueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const companyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const firstCycle = new Date("2026-04-01T12:00:00.000Z");
const secondCycle = new Date("2026-08-01T09:30:00.000Z");

type WakeRow = {
  id: string;
  status: string;
  idempotencyKey: string | null;
  requestedAt: Date;
};

function dbWithWakes(rows: WakeRow[]): Db {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve(rows);
            },
          };
        },
      };
    },
  } as unknown as Db;
}

describe("buildIssueBlockersResolvedWakeStateKey", () => {
  it("is identical for the same dependent, blockers, and blockedTransitionAt", () => {
    const first = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: firstCycle,
    });
    const second = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: firstCycle.toISOString(),
    });
    expect(first).toBe(second);
    expect(first).toContain(dependentIssueId);
  });

  it("changes when blockedTransitionAt changes", () => {
    const first = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: firstCycle,
    });
    const second = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: secondCycle,
    });
    expect(first).not.toBe(second);
  });

  it("hashes a null cycle as none and differs from any timestamp", () => {
    const noneKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: null,
    });
    const omittedKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const datedKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: firstCycle,
    });
    expect(noneKey).toBe(omittedKey);
    expect(noneKey).not.toBe(datedKey);
    expect(noneKey).not.toBe(
      buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
        dependentIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    );
  });
});

describe("findExistingIssueBlockersResolvedWakeForReadyState", () => {
  const readyState = {
    companyId,
    dependentIssueId,
    blockerIssueIds: [blockerIssueId],
    blockedTransitionAt: secondCycle,
  };

  it("suppresses a completed wake on the cycle-aware state key", async () => {
    const cycleKey = buildIssueBlockersResolvedWakeStateKey(readyState);
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-cycle",
          status: "completed",
          idempotencyKey: cycleKey,
          requestedAt: secondCycle,
        },
      ]),
      readyState,
    );
    expect(existing?.id).toBe("wake-cycle");
  });

  it("does not let a completed old-key wake from a previous blocked cycle suppress", async () => {
    const oldKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-old-previous-cycle",
          status: "completed",
          idempotencyKey: oldKey,
          requestedAt: firstCycle,
        },
      ]),
      readyState,
    );
    expect(existing).toBeNull();
  });

  it("suppresses a completed old-key wake requested at or after blockedTransitionAt", async () => {
    const oldKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-old-same-cycle",
          status: "completed",
          idempotencyKey: oldKey,
          requestedAt: secondCycle,
        },
      ]),
      readyState,
    );
    expect(existing?.id).toBe("wake-old-same-cycle");
  });

  it("suppresses a completed old-key wake when blockedTransitionAt is null", async () => {
    const oldKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-old-no-cycle",
          status: "completed",
          idempotencyKey: oldKey,
          requestedAt: firstCycle,
        },
      ]),
      {
        companyId,
        dependentIssueId,
        blockerIssueIds: [blockerIssueId],
        blockedTransitionAt: null,
      },
    );
    expect(existing?.id).toBe("wake-old-no-cycle");
  });

  it("suppresses an in-flight old-key wake across a later blocked cycle", async () => {
    const oldKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-old-queued",
          status: "queued",
          idempotencyKey: oldKey,
          requestedAt: firstCycle,
        },
      ]),
      readyState,
    );
    expect(existing?.id).toBe("wake-old-queued");
  });

  it("keeps legacy per-edge matching in-flight only", async () => {
    const legacyKey = buildIssueBlockersResolvedWakeIdempotencyKey({
      dependentIssueId,
      resolvedBlockerIssueId: blockerIssueId,
    });
    const inFlight = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-legacy-claimed",
          status: "claimed",
          idempotencyKey: legacyKey,
          requestedAt: firstCycle,
        },
      ]),
      readyState,
    );
    expect(inFlight?.id).toBe("wake-legacy-claimed");

    const completed = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-legacy-completed",
          status: "completed",
          idempotencyKey: legacyKey,
          requestedAt: firstCycle,
        },
      ]),
      readyState,
    );
    expect(completed).toBeNull();
  });
});

type CompletedWakeRow = {
  id: string;
  status: string;
  payload: Record<string, unknown> | null;
  requestedAt: Date;
  finishedAt?: Date | null;
};

function dbWithCompletedWakes(rows: CompletedWakeRow[]): Db {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                orderBy() {
                  return {
                    limit() {
                      return Promise.resolve(rows);
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Db;
}

describe("findRecentCompletedWakeForResolvedBlockerSet", () => {
  const input = {
    companyId,
    dependentIssueId,
    blockerIssueIds: [blockerIssueId],
  };
  // One minute after the sample wake: inside the default cooldown window.
  const nowInCooldown = new Date(firstCycle.getTime() + 60_000);

  it("matches a completed wake for the same dependent and blocker set, ignoring the cycle", async () => {
    const match = await findRecentCompletedWakeForResolvedBlockerSet(
      dbWithCompletedWakes([
        {
          id: "wake-stale-hold",
          status: "completed",
          payload: {
            issueId: dependentIssueId,
            resolvedBlockerIssueId: blockerIssueId,
            blockerIssueIds: [blockerIssueId],
            mutation: "blocked_dependency_restored",
          },
          requestedAt: firstCycle,
        },
      ]),
      { ...input, now: nowInCooldown },
    );
    expect(match?.id).toBe("wake-stale-hold");
  });

  it("matches regardless of blocker id order and duplicates", async () => {
    const secondBlocker = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const match = await findRecentCompletedWakeForResolvedBlockerSet(
      dbWithCompletedWakes([
        {
          id: "wake-multi",
          status: "completed",
          payload: {
            issueId: dependentIssueId,
            blockerIssueIds: [secondBlocker, blockerIssueId, secondBlocker],
          },
          requestedAt: firstCycle,
        },
      ]),
      { ...input, blockerIssueIds: [blockerIssueId, secondBlocker], now: nowInCooldown },
    );
    expect(match?.id).toBe("wake-multi");
  });

  it("does not suppress once the completed wake is older than the cooldown window", async () => {
    const rows = [
      {
        id: "wake-earlier-episode",
        status: "completed",
        payload: {
          issueId: dependentIssueId,
          blockerIssueIds: [blockerIssueId],
        },
        requestedAt: firstCycle,
        finishedAt: firstCycle,
      },
    ];
    // Terminal-reset style: a much later blocked cycle must still re-wake.
    const later = await findRecentCompletedWakeForResolvedBlockerSet(
      dbWithCompletedWakes(rows),
      { ...input, now: secondCycle },
    );
    expect(later).toBeNull();
    // Just past the default 30-minute window: no longer suppressing.
    const expired = await findRecentCompletedWakeForResolvedBlockerSet(
      dbWithCompletedWakes(rows),
      { ...input, now: new Date(firstCycle.getTime() + 31 * 60_000) },
    );
    expect(expired).toBeNull();
    // Inside the window: suppressed.
    const inside = await findRecentCompletedWakeForResolvedBlockerSet(
      dbWithCompletedWakes(rows),
      { ...input, now: new Date(firstCycle.getTime() + 29 * 60_000) },
    );
    expect(inside?.id).toBe("wake-earlier-episode");
  });

  it("anchors the cooldown on finishedAt when present", async () => {
    const match = await findRecentCompletedWakeForResolvedBlockerSet(
      dbWithCompletedWakes([
        {
          id: "wake-slow-run",
          status: "completed",
          payload: { issueId: dependentIssueId, blockerIssueIds: [blockerIssueId] },
          requestedAt: firstCycle,
          finishedAt: new Date(firstCycle.getTime() + 5 * 60_000),
        },
      ]),
      // now is 34 min after requestedAt (outside the 30-min window) but only
      // 29 min after finishedAt (inside it): the finishedAt anchor must win.
      { ...input, now: new Date(firstCycle.getTime() + 34 * 60_000) },
    );
    expect(match?.id).toBe("wake-slow-run");
  });

  it("does not match a different blocker set", async () => {
    const match = await findRecentCompletedWakeForResolvedBlockerSet(
      dbWithCompletedWakes([
        {
          id: "wake-other-set",
          status: "completed",
          payload: {
            issueId: dependentIssueId,
            blockerIssueIds: ["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"],
          },
          requestedAt: firstCycle,
        },
      ]),
      { ...input, now: nowInCooldown },
    );
    expect(match).toBeNull();
  });

  it("does not match rows without a usable payload blocker set", async () => {
    const match = await findRecentCompletedWakeForResolvedBlockerSet(
      dbWithCompletedWakes([
        { id: "wake-no-payload", status: "completed", payload: null, requestedAt: firstCycle },
        {
          id: "wake-empty-set",
          status: "completed",
          payload: { issueId: dependentIssueId, blockerIssueIds: [] },
          requestedAt: firstCycle,
        },
      ]),
      { ...input, now: nowInCooldown },
    );
    expect(match).toBeNull();
  });

  it("returns null for an empty queried blocker set", async () => {
    const match = await findRecentCompletedWakeForResolvedBlockerSet(
      dbWithCompletedWakes([]),
      { ...input, blockerIssueIds: [] },
    );
    expect(match).toBeNull();
  });
});
