import { afterEach, describe, expect, it } from "vitest";
import { buildActivityNotification } from "../services/push-triggers.js";
import { pruneEndpoints, upsertSubscription, type StoredPushSubscription } from "../services/push-subscription-store.js";
import {
  __resetPushConfigForTests,
  getVapidPublicKey,
  isPushConfigured,
  sendPushToSubscriptions,
} from "../services/push-notifications.js";
import type { LogActivityInput } from "../services/activity-log.js";

function activity(partial: Partial<LogActivityInput>): LogActivityInput {
  return {
    companyId: "c1",
    actorType: "agent",
    actorId: "a1",
    action: "issue.updated",
    entityType: "issue",
    entityId: "11111111-1111-1111-1111-111111111111",
    ...partial,
  };
}

describe("buildActivityNotification", () => {
  it("returns null for events that should not push", () => {
    expect(buildActivityNotification(activity({ action: "issue.updated" }))).toBeNull();
    expect(buildActivityNotification(activity({ action: "issue.read_marked" }))).toBeNull();
  });

  it("maps approval, interaction, comment, assignment, and escalation events", () => {
    expect(buildActivityNotification(activity({ action: "approval.created" }))?.title).toBe("Approval needed");
    expect(buildActivityNotification(activity({ action: "issue.thread_interaction_created" }))?.title).toBe(
      "Input needed",
    );
    expect(buildActivityNotification(activity({ action: "issue.comment.created" }))?.title).toBe("New comment");
    expect(buildActivityNotification(activity({ action: "issue.comment_added" }))?.title).toBe("New comment");
    expect(buildActivityNotification(activity({ action: "issue.assignment_wakeup_requested" }))?.title).toBe(
      "Issue assigned",
    );
    expect(buildActivityNotification(activity({ action: "issue.monitor_escalated_to_board" }))?.title).toBe(
      "Escalated to board",
    );
  });

  it("specializes the interaction body by kind", () => {
    const ask = buildActivityNotification(
      activity({ action: "issue.thread_interaction_created", details: { interactionKind: "ask_user_questions" } }),
    );
    expect(ask?.body).toContain("questions");
    const confirm = buildActivityNotification(
      activity({ action: "issue.thread_interaction_created", details: { interactionKind: "request_confirmation" } }),
    );
    expect(confirm?.body).toContain("confirmation");
  });

  it("deep-links to the issue identifier when present, else falls back", () => {
    expect(
      buildActivityNotification(activity({ action: "approval.created", details: { identifier: "TON-1234" } }))?.url,
    ).toBe("/issues/TON-1234");
    // entity is an issue but no identifier in details -> uses entityId
    expect(buildActivityNotification(activity({ action: "approval.created" }))?.url).toBe(
      "/issues/11111111-1111-1111-1111-111111111111",
    );
    // non-issue entity with no identifier -> root
    expect(
      buildActivityNotification(activity({ action: "approval.created", entityType: "agent", entityId: "x" }))?.url,
    ).toBe("/");
  });
});

describe("subscription store pure helpers", () => {
  const sub = (endpoint: string, userId = "u1"): StoredPushSubscription => ({
    userId,
    endpoint,
    keys: { p256dh: "p", auth: "a" },
    createdAt: "2026-06-09T00:00:00.000Z",
  });

  it("upsert dedupes by endpoint (newest wins)", () => {
    const list = [sub("https://push/1"), sub("https://push/2")];
    const updated = upsertSubscription(list, sub("https://push/1", "u2"));
    expect(updated).toHaveLength(2);
    expect(updated.filter((s) => s.endpoint === "https://push/1")).toHaveLength(1);
    expect(updated.find((s) => s.endpoint === "https://push/1")?.userId).toBe("u2");
  });

  it("prune removes only the listed endpoints", () => {
    const list = [sub("https://push/1"), sub("https://push/2"), sub("https://push/3")];
    expect(pruneEndpoints(list, ["https://push/2"]).map((s) => s.endpoint)).toEqual([
      "https://push/1",
      "https://push/3",
    ]);
    expect(pruneEndpoints(list, [])).toHaveLength(3);
  });
});

describe("push transport is a safe no-op when unconfigured", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_VAPID_PUBLIC_KEY;
    delete process.env.PAPERCLIP_VAPID_PRIVATE_KEY;
    __resetPushConfigForTests();
  });

  it("reports not configured and sends nothing without VAPID keys", async () => {
    delete process.env.PAPERCLIP_VAPID_PUBLIC_KEY;
    delete process.env.PAPERCLIP_VAPID_PRIVATE_KEY;
    __resetPushConfigForTests();

    expect(isPushConfigured()).toBe(false);
    expect(getVapidPublicKey()).toBeNull();

    const result = await sendPushToSubscriptions(
      [{ userId: "u1", endpoint: "https://push/1", keys: { p256dh: "p", auth: "a" }, createdAt: "x" }],
      { title: "t", body: "b" },
    );
    expect(result.expiredEndpoints).toEqual([]);
  });
});
