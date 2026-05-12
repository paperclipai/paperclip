import { describe, expect, it } from "vitest";
import {
  computeOrphanDeliverableSignal,
  ORPHAN_DELIVERABLE_GRACE_MS,
} from "../services/orphan-deliverable.js";

const startedAt = new Date("2026-05-12T00:00:00.000Z");
const completedAt = new Date("2026-05-12T00:00:00.000Z");
const justAfterGrace = new Date(startedAt.getTime() + ORPHAN_DELIVERABLE_GRACE_MS + 1000);
const insideGrace = new Date(startedAt.getTime() + ORPHAN_DELIVERABLE_GRACE_MS - 1000);

describe("computeOrphanDeliverableSignal", () => {
  it("returns null when status is not in the eligible set", () => {
    for (const status of ["backlog", "todo", "blocked", "cancelled"]) {
      const signal = computeOrphanDeliverableSignal({
        status,
        startedAt,
        completedAt,
        hasNonSystemDocuments: false,
        hasAgentComments: false,
        now: justAfterGrace,
      });
      expect(signal).toBeNull();
    }
  });

  it("returns null when the issue has any non-system document", () => {
    const signal = computeOrphanDeliverableSignal({
      status: "done",
      startedAt,
      completedAt,
      hasNonSystemDocuments: true,
      hasAgentComments: false,
      now: justAfterGrace,
    });
    expect(signal).toBeNull();
  });

  it("returns null when the issue has any agent-authored comment", () => {
    const signal = computeOrphanDeliverableSignal({
      status: "done",
      startedAt,
      completedAt,
      hasNonSystemDocuments: false,
      hasAgentComments: true,
      now: justAfterGrace,
    });
    expect(signal).toBeNull();
  });

  it("returns null inside the grace window", () => {
    const signal = computeOrphanDeliverableSignal({
      status: "in_progress",
      startedAt,
      completedAt: null,
      hasNonSystemDocuments: false,
      hasAgentComments: false,
      now: insideGrace,
    });
    expect(signal).toBeNull();
  });

  it("flags in_progress past grace using startedAt", () => {
    const signal = computeOrphanDeliverableSignal({
      status: "in_progress",
      startedAt,
      completedAt: null,
      hasNonSystemDocuments: false,
      hasAgentComments: false,
      now: justAfterGrace,
    });
    expect(signal).not.toBeNull();
    expect(signal?.status).toBe("in_progress");
    expect(signal?.reason).toBe("no_documents_no_agent_comments");
    expect(signal?.flaggedSince.getTime()).toBe(startedAt.getTime() + ORPHAN_DELIVERABLE_GRACE_MS);
  });

  it("flags in_review past grace using startedAt", () => {
    const signal = computeOrphanDeliverableSignal({
      status: "in_review",
      startedAt,
      completedAt: null,
      hasNonSystemDocuments: false,
      hasAgentComments: false,
      now: justAfterGrace,
    });
    expect(signal?.status).toBe("in_review");
  });

  it("flags done past grace using completedAt", () => {
    const signal = computeOrphanDeliverableSignal({
      status: "done",
      startedAt: null,
      completedAt,
      hasNonSystemDocuments: false,
      hasAgentComments: false,
      now: justAfterGrace,
    });
    expect(signal?.status).toBe("done");
    expect(signal?.flaggedSince.getTime()).toBe(completedAt.getTime() + ORPHAN_DELIVERABLE_GRACE_MS);
  });

  it("returns null when the reference timestamp is missing", () => {
    const signal = computeOrphanDeliverableSignal({
      status: "done",
      startedAt: null,
      completedAt: null,
      hasNonSystemDocuments: false,
      hasAgentComments: false,
      now: justAfterGrace,
    });
    expect(signal).toBeNull();
  });

  it("honors a custom grace period", () => {
    const tightGrace = 1_000;
    const inWindow = new Date(startedAt.getTime() + tightGrace + 500);
    const signal = computeOrphanDeliverableSignal({
      status: "in_progress",
      startedAt,
      completedAt: null,
      hasNonSystemDocuments: false,
      hasAgentComments: false,
      now: inWindow,
      graceMs: tightGrace,
    });
    expect(signal).not.toBeNull();
    expect(signal?.flaggedSince.getTime()).toBe(startedAt.getTime() + tightGrace);
  });
});
