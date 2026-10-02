import { describe, expect, it, vi } from "vitest";
import { activityLog, pubsubActivityReceipts, type Db } from "@paperclipai/db";
import { startPubsubActivityWorker } from "../services/pubsub-activity.js";

// Journal fixtures captured from the live research instance (read-only):
//  - route updates (issues 6cb1cbdc FLE-4 probe and d2ecad07 FLE-1) journal
//    `changes.status` plus `_previous.status`;
//  - the native status committer journals `fromStatus`/`toStatus`
//    (status-decision-committer.ts, persistActivity details);
//  - plugin issue updates journal `patch` plus `_previous.status`
//    (plugin-host-services.ts, issue update activity).

function workerHarness(rows: Array<Record<string, unknown>>) {
  const getSql = () => ({ sql: "select 1", nativeParameters: [] as unknown[], parameters: [] as unknown[] });
  const live = new Set(rows);
  // The base receipt (created/updated/comment_added, never completed/blocked)
  // excludes the row from later scans, mirroring the notExists receipt filter.
  const db = {
    select: (_fields?: unknown) => ({
      from: (_table?: unknown) => ({
        where: (_where?: unknown) => ({
          getSQL: getSql,
          orderBy: (..._order: unknown[]) => ({ getSQL: getSql, limit: async () => [...live] }),
          limit: async () => [...live],
        }),
      }),
    }),
  } as unknown as Db;
  const publishActivity = vi.fn(async (eventId: string, input: unknown) => {
    const topic = (input as { topic: string }).topic;
    if (!topic.endsWith("completed") && !topic.endsWith("blocked")) {
      for (const row of rows) if (row.id === eventId) live.delete(row);
    }
    return { id: eventId, queued: 0 };
  });
  const pubsub = { publishActivity } as unknown as Parameters<typeof startPubsubActivityWorker>[1];
  return { db, pubsub, publishActivity };
}


async function runSweep(db: Db, pubsub: Parameters<typeof startPubsubActivityWorker>[1], expectedCalls: number) {
  // The worker is interval-driven; fake timers keep the sweep deterministic.
  vi.useFakeTimers();
  try {
    const stop = startPubsubActivityWorker(db, pubsub);
    const calls = (pubsub.publishActivity as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    for (let tick = 0; tick < 4 && calls.length < expectedCalls; tick++) {
      await vi.advanceTimersByTimeAsync(250);
    }
    await stop();
  } finally {
    vi.useRealTimers();
  }
}

function callsByTopic(mock: { mock: { calls: Array<[string, { topic: string }]> } }) {
  return mock.mock.calls.map(([, input]) => input.topic);
}
function journalCall(mock: { mock: { calls: unknown[][] } }, index: number) {
  // Vitest records mock arguments as unknown; the journal contract shape is
  // asserted here, not trusted from the mock.
  const input = mock.mock.calls[index]?.[1];
  if (typeof input !== "object" || input === null) throw new Error(`journal call ${index} missing`);
  const { topic, payload } = input as { topic: string; payload: Record<string, unknown> };
  if (typeof topic !== "string" || typeof payload !== "object" || payload === null) throw new Error(`journal call ${index} malformed`);
  return { topic, payload };
}
describe("PubSub activity journal transition normalization", () => {
  it("emits completed for the route update shape journaled on FLE-4", async () => {
    // Real row captured live: blocked -> done via the API update route.
    const row = {
      id: "32a34562-9d17-45df-ae8c-72a32a0acbca",
      companyId: "00000000-0000-4000-8000-0000000000f4",
      action: "issue.updated", entityType: "issue", entityId: "6cb1cbdc-ce14-4149-a55c-babd1e042cdc",
      actorType: "board", actorId: "board",
      createdAt: new Date("2026-09-30T06:44:45.757Z"),
      details: {
        status: "done",
        changes: {
          status: { to: "done", from: "blocked" },
          completedAt: { to: "2026-09-30T06:44:45.757Z", from: null },
          statusVersion: { to: 2, from: 1 },
        },
        _previous: { status: "blocked", statusVersion: 1 },
        identifier: "FLE-4",
        authorizationReason: "allow_board_actor",
      },
    };
    const { db, pubsub, publishActivity } = workerHarness([row]);
    await runSweep(db, pubsub, 2);
    expect(callsByTopic(publishActivity)).toEqual(["fleet.task.completed", "fleet.task.updated"]);
    const completedInput = journalCall(publishActivity, 0);
    expect(completedInput.topic).toBe("fleet.task.completed");
    expect(completedInput.payload).toMatchObject({
      issueId: "6cb1cbdc-ce14-4149-a55c-babd1e042cdc",
      review: "none",
      details: { status: "done", previousStatus: "blocked" },
    });
    // The base journal event keeps the compact reference shape, no review marker.
    const baseInput = journalCall(publishActivity, 1);
    expect(baseInput.topic).toBe("fleet.task.updated");
    expect(baseInput.payload).not.toHaveProperty("review");
  });

  it("emits completed for the native committer fromStatus/toStatus shape", async () => {
    // Shape journaled by commitNativeStatusDecision: no `changes`, no `_previous`.
    const row = {
      id: "d0000000-0000-4000-8000-000000000001",
      companyId: "00000000-0000-4000-8000-0000000000f4",
      action: "issue.updated", entityType: "issue", entityId: "6cb1cbdc-ce14-4149-a55c-babd1e042cdc",
      actorType: "system", actorId: "native-status-committer",
      createdAt: new Date("2026-09-30T06:50:00.000Z"),
      details: {
        source: "native_status_decision",
        assessmentId: "a1111111-1111-4111-8111-111111111111",
        decisionId: "b2222222-2222-4222-8222-222222222222",
        fromStatus: "in_progress",
        toStatus: "done",
        reasonCode: "work_completed",
        effectCount: 0,
      },
    };
    const { db, pubsub, publishActivity } = workerHarness([row]);
    await runSweep(db, pubsub, 2);
    expect(callsByTopic(publishActivity)).toEqual(["fleet.task.completed", "fleet.task.updated"]);
    const completedInput = journalCall(publishActivity, 0);
    expect(completedInput.payload).toMatchObject({
      issueId: "6cb1cbdc-ce14-4149-a55c-babd1e042cdc",
      review: "none",
      details: { status: "done", previousStatus: "in_progress" },
    });
  });

  it("emits blocked for the plugin patch shape", async () => {
    // Shape journaled by the plugin issue-update host service: patch + _previous.
    const row = {
      id: "d0000000-0000-4000-8000-000000000002",
      companyId: "00000000-0000-4000-8000-0000000000f4",
      action: "issue.updated", entityType: "issue", entityId: "d2ecad07-6cf4-4b22-a6ad-df1db2132c2d",
      actorType: "agent", actorId: "27a2770a-37ce-440d-8365-8e6bc9f6c6a8",
      createdAt: new Date("2026-09-30T06:52:00.000Z"),
      details: {
        identifier: "FLE-1",
        patch: { status: "blocked" },
        _previous: { status: "todo", assigneeAgentId: null, assigneeUserId: null },
      },
    };
    const { db, pubsub, publishActivity } = workerHarness([row]);
    await runSweep(db, pubsub, 2);
    expect(callsByTopic(publishActivity)).toEqual(["fleet.task.blocked", "fleet.task.updated"]);
    const blockedInput = journalCall(publishActivity, 0);
    expect(blockedInput.topic).toBe("fleet.task.blocked");
    expect(blockedInput.payload).toMatchObject({
      issueId: "d2ecad07-6cf4-4b22-a6ad-df1db2132c2d",
      review: "none",
      details: { status: "blocked", previousStatus: "todo" },
    });
    expect(journalCall(publishActivity, 1).payload).not.toHaveProperty("review");
  });

  it("emits cancelled for the route update shape", async () => {
    // in_progress -> cancelled via the API update route: same journal shape as
    // the FLE-4 completion, terminal coverage must include cancelled.
    const row = {
      id: "d0000000-0000-4000-8000-000000000003",
      companyId: "00000000-0000-4000-8000-0000000000f4",
      action: "issue.updated", entityType: "issue", entityId: "6cb1cbdc-ce14-4149-a55c-babd1e042cdc",
      actorType: "board", actorId: "board",
      createdAt: new Date("2026-09-30T07:00:00.000Z"),
      details: {
        status: "cancelled",
        changes: {
          status: { to: "cancelled", from: "in_progress" },
          cancelledAt: { to: "2026-09-30T07:00:00.000Z", from: null },
        },
        _previous: { status: "in_progress" },
        identifier: "FLE-4",
      },
    };
    const { db, pubsub, publishActivity } = workerHarness([row]);
    await runSweep(db, pubsub, 2);
    expect(callsByTopic(publishActivity)).toEqual(["fleet.task.cancelled", "fleet.task.updated"]);
    const cancelledInput = journalCall(publishActivity, 0);
    expect(cancelledInput.topic).toBe("fleet.task.cancelled");
    expect(cancelledInput.payload).toMatchObject({
      issueId: "6cb1cbdc-ce14-4149-a55c-babd1e042cdc",
      review: "none",
      details: { status: "cancelled", previousStatus: "in_progress" },
    });
    const baseInput = journalCall(publishActivity, 1);
    expect(baseInput.topic).toBe("fleet.task.updated");
    expect(baseInput.payload).not.toHaveProperty("review");
  });

  it("emits only the base topic for non-transition and non-update journal rows", async () => {
    const rows = [
      // Live FLE-1 row: top-level status without changes (recovery resolution).
      {
        id: "5c6a8306-026b-4197-be1c-91e9d8510989",
        companyId: "00000000-0000-4000-8000-0000000000f4",
        action: "issue.updated", entityType: "issue", entityId: "d2ecad07-6cf4-4b22-a6ad-df1db2132c2d",
        actorType: "system", actorId: "execution-recovery",
        createdAt: new Date("2026-09-30T06:53:00.000Z"),
        details: {
          source: "recovery_action_resolution",
          status: "todo",
          _previous: { status: "blocked" },
          identifier: "FLE-1",
          recoveryActionId: "bd4104b1-a04d-4b00-b8c6-75a0ac08f27b",
        },
      },
      // Live FLE-4 row: created, no transition.
      {
        id: "be2c3eba-6cf9-41b4-bd6e-99509ab6c455",
        companyId: "00000000-0000-4000-8000-0000000000f4",
        action: "issue.created", entityType: "issue", entityId: "6cb1cbdc-ce14-4149-a55c-babd1e042cdc",
        actorType: "board", actorId: "board",
        createdAt: new Date("2026-09-30T06:44:40.000Z"),
        details: { title: "cutover probe", status: "backlog", identifier: "FLE-4" },
      },
    ];
    const { db, pubsub, publishActivity } = workerHarness(rows);
    await runSweep(db, pubsub, 2);
    expect(callsByTopic(publishActivity)).toEqual(["fleet.task.updated", "fleet.task.created"]);
  });
});
