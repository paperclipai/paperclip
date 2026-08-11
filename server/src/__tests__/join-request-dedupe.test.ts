import { describe, expect, it } from "vitest";
import {
  collapseDuplicatePendingHumanJoinRequests,
  findReusableHumanJoinRequest,
} from "../lib/join-request-dedupe.js";

describe("findReusableHumanJoinRequest", () => {
  it("reuses the newest pending request for the same user", () => {
    const rows = [
      {
        id: "pending-new",
        requestType: "human",
        status: "pending_approval",
        requestingUserId: "user-1",
        requestEmailSnapshot: "person@example.com",
      },
      {
        id: "pending-old",
        requestType: "human",
        status: "pending_approval",
        requestingUserId: "user-1",
        requestEmailSnapshot: "person@example.com",
      },
      {
        id: "other-user",
        requestType: "human",
        status: "pending_approval",
        requestingUserId: "user-2",
        requestEmailSnapshot: "other@example.com",
      },
    ] as const;

    expect(
      findReusableHumanJoinRequest(rows, {
        requestingUserId: "user-1",
        requestEmailSnapshot: "person@example.com",
      })?.id
    ).toBe("pending-new");
  });

  it("falls back to email matching when the user id is unavailable", () => {
    const rows = [
      {
        id: "approved-existing",
        requestType: "human",
        status: "approved",
        requestingUserId: null,
        requestEmailSnapshot: "Person@Example.com",
      },
      {
        id: "agent-request",
        requestType: "agent",
        status: "pending_approval",
        requestingUserId: null,
        requestEmailSnapshot: null,
      },
    ] as const;

    expect(
      findReusableHumanJoinRequest(rows, {
        requestingUserId: null,
        requestEmailSnapshot: "person@example.com",
      })?.id
    ).toBe("approved-existing");
  });
});

describe("collapseDuplicatePendingHumanJoinRequests", () => {
  it("keeps only the newest pending human row per requester", () => {
    const rows = [
      {
        id: "human-new",
        requestType: "human",
        status: "pending_approval",
        requestingUserId: "user-1",
        requestEmailSnapshot: "person@example.com",
      },
      {
        id: "human-old",
        requestType: "human",
        status: "pending_approval",
        requestingUserId: "user-1",
        requestEmailSnapshot: "person@example.com",
      },
      {
        id: "approved-history",
        requestType: "human",
        status: "approved",
        requestingUserId: "user-1",
        requestEmailSnapshot: "person@example.com",
      },
      {
        id: "agent-pending",
        requestType: "agent",
        status: "pending_approval",
        requestingUserId: null,
        requestEmailSnapshot: null,
      },
    ] as const;

    expect(collapseDuplicatePendingHumanJoinRequests(rows).map((row) => row.id))
      .toEqual(["human-new", "approved-history", "agent-pending"]);
  });
});
