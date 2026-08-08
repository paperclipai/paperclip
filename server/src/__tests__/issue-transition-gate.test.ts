/**
 * Tests for Gate 1: working-transition and deadline-before-mutation gates (8b616780)
 */

import { describe, expect, it } from "vitest";
import {
  isValidStatusTransition,
  issueTransitionGateService,
} from "../services/issue-transition-gate.js";

// ---------------------------------------------------------------------------
// Unit tests: isValidStatusTransition
// ---------------------------------------------------------------------------

describe("isValidStatusTransition", () => {
  it("allows backlog → todo", () => {
    expect(isValidStatusTransition("backlog", "todo")).toBe(true);
  });

  it("allows backlog → cancelled", () => {
    expect(isValidStatusTransition("backlog", "cancelled")).toBe(true);
  });

  it("denies backlog → done (skip)", () => {
    expect(isValidStatusTransition("backlog", "done")).toBe(false);
  });

  it("allows todo → in_progress", () => {
    expect(isValidStatusTransition("todo", "in_progress")).toBe(true);
  });

  it("allows todo → blocked", () => {
    expect(isValidStatusTransition("todo", "blocked")).toBe(true);
  });

  it("allows todo → cancelled", () => {
    expect(isValidStatusTransition("todo", "cancelled")).toBe(true);
  });

  it("denies todo → done (skip)", () => {
    expect(isValidStatusTransition("todo", "done")).toBe(false);
  });

  it("allows in_progress → in_review", () => {
    expect(isValidStatusTransition("in_progress", "in_review")).toBe(true);
  });

  it("allows in_progress → blocked", () => {
    expect(isValidStatusTransition("in_progress", "blocked")).toBe(true);
  });

  it("allows in_progress → done", () => {
    expect(isValidStatusTransition("in_progress", "done")).toBe(true);
  });

  it("allows in_progress → cancelled", () => {
    expect(isValidStatusTransition("in_progress", "cancelled")).toBe(true);
  });

  it("denies in_progress → backlog (regression)", () => {
    expect(isValidStatusTransition("in_progress", "backlog")).toBe(false);
  });

  it("allows in_review → in_progress (send back)", () => {
    expect(isValidStatusTransition("in_review", "in_progress")).toBe(true);
  });

  it("allows in_review → done", () => {
    expect(isValidStatusTransition("in_review", "done")).toBe(true);
  });

  it("allows in_review → blocked", () => {
    expect(isValidStatusTransition("in_review", "blocked")).toBe(true);
  });

  it("allows blocked → todo", () => {
    expect(isValidStatusTransition("blocked", "todo")).toBe(true);
  });

  it("allows blocked → in_progress", () => {
    expect(isValidStatusTransition("blocked", "in_progress")).toBe(true);
  });

  it("allows blocked → cancelled", () => {
    expect(isValidStatusTransition("blocked", "cancelled")).toBe(true);
  });

  it("denies blocked → done (skip review)", () => {
    expect(isValidStatusTransition("blocked", "done")).toBe(false);
  });

  it("allows done → in_progress (re-open)", () => {
    expect(isValidStatusTransition("done", "in_progress")).toBe(true);
  });

  it("denies done → todo (re-open to start)", () => {
    expect(isValidStatusTransition("done", "todo")).toBe(false);
  });

  it("denies done → backlog", () => {
    expect(isValidStatusTransition("done", "backlog")).toBe(false);
  });

  it("allows cancelled → todo (un-cancel)", () => {
    expect(isValidStatusTransition("cancelled", "todo")).toBe(true);
  });

  it("denies cancelled → in_progress (skip todo)", () => {
    expect(isValidStatusTransition("cancelled", "in_progress")).toBe(false);
  });

  it("denies cancelled → done", () => {
    expect(isValidStatusTransition("cancelled", "done")).toBe(false);
  });

  // Fail-closed: unknown status
  it("fail-closed: unknown current status → always denied", () => {
    expect(isValidStatusTransition("unknown_status", "todo")).toBe(false);
    expect(isValidStatusTransition("unknown_status", "done")).toBe(false);
  });

  it("fail-closed: known status → unknown target denied", () => {
    expect(isValidStatusTransition("todo", "unknown_target")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: assertValidTransition
// ---------------------------------------------------------------------------

describe("issueTransitionGateService.assertValidTransition", () => {
  const gate = issueTransitionGateService({} as any);

  it("does not throw for valid transition", () => {
    expect(() =>
      gate.assertValidTransition({
        companyId: "c1",
        issueId: "i1",
        currentStatus: "todo",
        targetStatus: "in_progress",
      }),
    ).not.toThrow();
  });

  it("throws forbidden for invalid transition", () => {
    expect(() =>
      gate.assertValidTransition({
        companyId: "c1",
        issueId: "i1",
        currentStatus: "done",
        targetStatus: "todo",
      }),
    ).toThrow();
  });

  it("throws with correct error code for invalid transition", () => {
    try {
      gate.assertValidTransition({
        companyId: "c1",
        issueId: "i1",
        currentStatus: "done",
        targetStatus: "backlog",
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.status).toBe(403);
      expect(err.details?.code).toBe("invalid_status_transition");
    }
  });

  it("throws for unknown current status (fail-closed)", () => {
    expect(() =>
      gate.assertValidTransition({
        companyId: "c1",
        issueId: "i1",
        currentStatus: "nonexistent",
        targetStatus: "todo",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Unit tests: assertDeadlineBeforeMutation
// ---------------------------------------------------------------------------

describe("issueTransitionGateService.assertDeadlineBeforeMutation", () => {
  const gate = issueTransitionGateService({} as any);

  it("passes when no dueDate", () => {
    expect(() =>
      gate.assertDeadlineBeforeMutation({
        companyId: "c1",
        issueId: "i1",
        dueDate: null,
        mutationKind: "title",
      }),
    ).not.toThrow();
  });

  it("passes when dueDate is in the future", () => {
    const future = new Date(Date.now() + 86400000).toISOString(); // +1 day
    expect(() =>
      gate.assertDeadlineBeforeMutation({
        companyId: "c1",
        issueId: "i1",
        dueDate: future,
        mutationKind: "title",
      }),
    ).not.toThrow();
  });

  it("passes for status mutation on overdue issue", () => {
    const past = new Date(Date.now() - 86400000).toISOString(); // -1 day
    expect(() =>
      gate.assertDeadlineBeforeMutation({
        companyId: "c1",
        issueId: "i1",
        dueDate: past,
        mutationKind: "status",
      }),
    ).not.toThrow();
  });

  it("passes with overrideDeadline=true on overdue issue", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    expect(() =>
      gate.assertDeadlineBeforeMutation({
        companyId: "c1",
        issueId: "i1",
        dueDate: past,
        mutationKind: "title",
        overrideDeadline: true,
      }),
    ).not.toThrow();
  });

  it("blocks non-status mutation on overdue issue (fail-closed)", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    expect(() =>
      gate.assertDeadlineBeforeMutation({
        companyId: "c1",
        issueId: "i1",
        dueDate: past,
        mutationKind: "description",
      }),
    ).toThrow();
  });

  it("blocks assignee change on overdue issue", () => {
    const past = new Date(Date.now() - 3600000).toISOString(); // -1 hour
    expect(() =>
      gate.assertDeadlineBeforeMutation({
        companyId: "c1",
        issueId: "i1",
        dueDate: past,
        mutationKind: "assignee",
      }),
    ).toThrow();
  });

  it("throws with correct error code for overdue block", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    try {
      gate.assertDeadlineBeforeMutation({
        companyId: "c1",
        issueId: "i1",
        dueDate: past,
        mutationKind: "title",
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.status).toBe(403);
      expect(err.details?.code).toBe("overdue_issue_mutation_blocked");
    }
  });

  it("passes when dueDate is unparseable (graceful)", () => {
    expect(() =>
      gate.assertDeadlineBeforeMutation({
        companyId: "c1",
        issueId: "i1",
        dueDate: "not-a-date",
        mutationKind: "title",
      }),
    ).not.toThrow();
  });
});
