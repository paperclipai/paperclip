import { describe, expect, it } from "vitest";
import {
  buildInteractionAwaitingHumanHandoffStatus,
  formatAwaitingHumanProviderLabel,
} from "../services/awaiting-human-bridge-status.js";

const now = new Date("2026-05-22T12:00:00.000Z");

function makeRow(overrides: Partial<{
  status: "pending_delivery" | "waiting_for_human" | "closed" | "failed";
  nextPollAt: Date | null;
  lastPolledAt: Date | null;
  closeOutcome: "approved" | "rejected" | "expired" | "superseded" | "cancelled" | null;
  lastError: string | null;
}>) {
  return {
    id: "bridge-1",
    companyId: "company-1",
    issueId: "issue-1",
    interactionId: "interaction-1",
    agentId: "agent-1",
    provider: "clickup",
    status: "waiting_for_human" as const,
    closeOutcome: null,
    externalThreadId: "thread-1",
    externalMessageId: "message-1",
    nextPollAt: new Date("2026-05-22T11:59:00.000Z"),
    lastPolledAt: new Date("2026-05-22T11:58:00.000Z"),
    closedAt: null,
    closeReason: null,
    lastError: null,
    createdAt: new Date("2026-05-22T11:55:00.000Z"),
    updatedAt: new Date("2026-05-22T11:58:00.000Z"),
    ...overrides,
  };
}

describe("formatAwaitingHumanProviderLabel", () => {
  it("formats clickup for display", () => {
    expect(formatAwaitingHumanProviderLabel("clickup")).toBe("ClickUp");
  });
});

describe("buildInteractionAwaitingHumanHandoffStatus", () => {
  it("uses user-facing copy when a check is due", () => {
    const status = buildInteractionAwaitingHumanHandoffStatus(makeRow({}), now);
    expect(status.phase).toBe("checking");
    expect(status.isCheckingNow).toBe(true);
    expect(status.label).toBe("Checking ClickUp for your reply");
    expect(status.detail).toContain("Last checked 2m ago");
  });

  it("uses listening copy when the next check is scheduled", () => {
    const status = buildInteractionAwaitingHumanHandoffStatus(
      makeRow({ nextPollAt: new Date("2026-05-22T12:00:30.000Z") }),
      now,
    );
    expect(status.phase).toBe("listening");
    expect(status.isCheckingNow).toBe(false);
    expect(status.label).toBe("Waiting in ClickUp");
    expect(status.detail).toContain("Next check in 30s");
  });

  it("describes sending and terminal states", () => {
    expect(buildInteractionAwaitingHumanHandoffStatus(
      makeRow({ status: "pending_delivery", nextPollAt: null }),
      now,
    )).toMatchObject({
      phase: "sending",
      label: "Sending to ClickUp",
    });

    expect(buildInteractionAwaitingHumanHandoffStatus(
      makeRow({ status: "closed", closeOutcome: "approved" }),
      now,
    )).toMatchObject({
      phase: "completed",
      label: "Approved in ClickUp",
    });

    expect(buildInteractionAwaitingHumanHandoffStatus(
      makeRow({ status: "failed", lastError: "missing-credential" }),
      now,
    )).toMatchObject({
      phase: "failed",
      label: "Couldn't reach ClickUp",
      detail: "missing-credential",
    });
  });

  it("returns a not-started message when no bridge exists", () => {
    const status = buildInteractionAwaitingHumanHandoffStatus(null, now);
    expect(status.phase).toBe("none");
    expect(status.label).toBe("External handoff not started");
  });
});
