import { describe, expect, it } from "vitest";
import type {
  RequestConfirmationInteraction,
  RequestConfirmationResult,
} from "@/lib/issue-thread-interactions";
import {
  interactionThreadAnchorMs,
  isSuppressedThreadInteraction,
} from "./interaction-thread-order";

function confirmation(
  overrides: Partial<RequestConfirmationInteraction> = {},
): RequestConfirmationInteraction {
  return {
    id: "confirmation-1",
    companyId: "company-1",
    issueId: "issue-1",
    kind: "request_confirmation",
    title: "Approve the plan",
    summary: null,
    status: "pending",
    continuationPolicy: "wake_assignee",
    resolverPolicy: "board_only",
    requestedResolverPolicy: "board_only",
    effectiveResolverPolicy: "board_only",
    createdByAgentId: "agent-1",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:00:00.000Z"),
    resolvedAt: null,
    payload: { version: 1, prompt: "Approve?" },
    result: null,
    ...overrides,
  };
}

function result(outcome: RequestConfirmationResult["outcome"]): RequestConfirmationResult {
  return { version: 1, outcome };
}

const CREATED_MS = new Date("2026-04-06T12:00:00.000Z").getTime();
const RESOLVED_MS = new Date("2026-04-06T12:05:00.000Z").getTime();

describe("isSuppressedThreadInteraction", () => {
  it("hides withdrawn confirmations", () => {
    expect(
      isSuppressedThreadInteraction(
        confirmation({ status: "cancelled", result: result("withdrawn") }),
      ),
    ).toBe(true);
  });

  it("hides confirmations superseded by a comment or a newer request", () => {
    expect(
      isSuppressedThreadInteraction(
        confirmation({ status: "expired", result: result("superseded_by_comment") }),
      ),
    ).toBe(true);
    expect(
      isSuppressedThreadInteraction(
        confirmation({ status: "expired", result: result("superseded_by_newer_request") }),
      ),
    ).toBe(true);
  });

  it("keeps accepted, rejected, and still-pending confirmations", () => {
    expect(isSuppressedThreadInteraction(confirmation())).toBe(false);
    expect(
      isSuppressedThreadInteraction(
        confirmation({ status: "accepted", result: result("accepted") }),
      ),
    ).toBe(false);
    expect(
      isSuppressedThreadInteraction(
        confirmation({ status: "rejected", result: result("rejected") }),
      ),
    ).toBe(false);
  });

  it("only suppresses confirmation-family kinds, not questions or suggestions", () => {
    const superseded = { version: 1, outcome: "superseded_by_comment" } as never;
    expect(
      isSuppressedThreadInteraction(
        confirmation({ kind: "ask_user_questions", result: superseded } as never),
      ),
    ).toBe(false);
    expect(
      isSuppressedThreadInteraction(
        confirmation({ kind: "suggest_tasks", result: superseded } as never),
      ),
    ).toBe(false);
  });
});

describe("interactionThreadAnchorMs", () => {
  it("keeps a pending card at its request-time fallback", () => {
    expect(interactionThreadAnchorMs(confirmation(), CREATED_MS)).toBe(CREATED_MS);
  });

  it("re-anchors a resolved card to its resolution time", () => {
    const resolved = confirmation({
      status: "accepted",
      result: result("accepted"),
      resolvedAt: new Date(RESOLVED_MS),
    });
    expect(interactionThreadAnchorMs(resolved, CREATED_MS)).toBe(RESOLVED_MS);
  });

  it("never drags a resolved card above its own request slot", () => {
    // Clock skew: resolvedAt reads earlier than the handoff/created fallback.
    const resolved = confirmation({
      status: "accepted",
      result: result("accepted"),
      resolvedAt: new Date(CREATED_MS - 60_000),
    });
    expect(interactionThreadAnchorMs(resolved, CREATED_MS)).toBe(CREATED_MS);
  });

  it("falls back when a resolved card has no resolvedAt yet", () => {
    const resolved = confirmation({ status: "accepted", result: result("accepted") });
    expect(interactionThreadAnchorMs(resolved, CREATED_MS)).toBe(CREATED_MS);
  });
});
