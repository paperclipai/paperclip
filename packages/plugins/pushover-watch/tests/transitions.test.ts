import { describe, it, expect } from "vitest";
import { matchesT1, matchesT2, matchesT3, matchesT6 } from "../src/transitions.js";
import type { CachedIssueState } from "../src/config-schema.js";

const CEO = "506c873e-3a40-4483-9a45-0eb0fa1554bb";
const WALTER = "18r34Ghx5N0LHRptMCT6Fp1WaoGqhvc9";

function state(over: Partial<CachedIssueState> = {}): CachedIssueState {
  return {
    status: "in_progress",
    assigneeAgentId: null,
    assigneeUserId: null,
    updatedAt: "2026-05-11T10:00:00.000Z",
    ...over,
  };
}

describe("matchesT1 — CEO/CHO task done", () => {
  it("fires when status moves to done with assignee in topAgentIds", () => {
    const prev = state({ status: "in_progress", assigneeAgentId: CEO });
    const next = state({ status: "done", assigneeAgentId: CEO });
    expect(matchesT1(prev, next, [CEO])).toBe(true);
  });

  it("fires on first-event (prev=null) when next=done with assignee in topAgentIds", () => {
    const next = state({ status: "done", assigneeAgentId: CEO });
    expect(matchesT1(null, next, [CEO])).toBe(true);
  });

  it("does not fire on first-event (prev=null) when assignee is not in topAgentIds", () => {
    const next = state({ status: "done", assigneeAgentId: "other-agent" });
    expect(matchesT1(null, next, [CEO])).toBe(false);
  });

  it("does not fire when status was already done", () => {
    const prev = state({ status: "done", assigneeAgentId: CEO });
    const next = state({ status: "done", assigneeAgentId: CEO });
    expect(matchesT1(prev, next, [CEO])).toBe(false);
  });

  it("does not fire when assignee is not in topAgentIds", () => {
    const prev = state({ status: "in_progress", assigneeAgentId: "other-agent" });
    const next = state({ status: "done", assigneeAgentId: "other-agent" });
    expect(matchesT1(prev, next, [CEO])).toBe(false);
  });

  it("does not fire when status is not done", () => {
    const prev = state({ status: "todo", assigneeAgentId: CEO });
    const next = state({ status: "in_progress", assigneeAgentId: CEO });
    expect(matchesT1(prev, next, [CEO])).toBe(false);
  });
});

describe("matchesT2 — in_review handover to board user", () => {
  it("fires when status moves to in_review with board user as assignee", () => {
    const prev = state({ status: "in_progress" });
    const next = state({ status: "in_review", assigneeUserId: WALTER });
    expect(matchesT2(prev, next, WALTER)).toBe(true);
  });

  it("fires on first-event (prev=null) when next=in_review with board user", () => {
    const next = state({ status: "in_review", assigneeUserId: WALTER });
    expect(matchesT2(null, next, WALTER)).toBe(true);
  });

  it("does not fire when assignee is a different user", () => {
    const prev = state({ status: "in_progress" });
    const next = state({ status: "in_review", assigneeUserId: "other-user" });
    expect(matchesT2(prev, next, WALTER)).toBe(false);
  });

  it("does not fire when status was already in_review", () => {
    const prev = state({ status: "in_review", assigneeUserId: WALTER });
    const next = state({ status: "in_review", assigneeUserId: WALTER });
    expect(matchesT2(prev, next, WALTER)).toBe(false);
  });
});

describe("matchesT3 — blocked transition (mention check is caller's job)", () => {
  it("fires on transition into blocked", () => {
    const prev = state({ status: "in_progress" });
    const next = state({ status: "blocked" });
    expect(matchesT3(prev, next)).toBe(true);
  });

  it("fires on first-event (prev=null) when next=blocked", () => {
    const next = state({ status: "blocked" });
    expect(matchesT3(null, next)).toBe(true);
  });

  it("does not fire when already blocked", () => {
    const prev = state({ status: "blocked" });
    const next = state({ status: "blocked" });
    expect(matchesT3(prev, next)).toBe(false);
  });
});

const SECRETARY = "e24b8d9d-143e-4141-b413-4361aa618771";

describe("matchesT6 — Sekretärin transition", () => {
  it("returns the new status when Sekretärin was assignee and status changes to in_review", () => {
    const prev = state({ status: "in_progress", assigneeAgentId: SECRETARY });
    const next = state({ status: "in_review", assigneeAgentId: null, assigneeUserId: WALTER });
    expect(matchesT6(prev, next, [SECRETARY])).toBe("in_review");
  });

  it("returns 'done' when Sekretärin is still the assignee and status moves to done", () => {
    const prev = state({ status: "in_progress", assigneeAgentId: SECRETARY });
    const next = state({ status: "done", assigneeAgentId: SECRETARY });
    expect(matchesT6(prev, next, [SECRETARY])).toBe("done");
  });

  it("returns 'blocked' on transition into blocked, regardless of comment mention", () => {
    const prev = state({ status: "in_progress", assigneeAgentId: SECRETARY });
    const next = state({ status: "blocked", assigneeAgentId: SECRETARY });
    expect(matchesT6(prev, next, [SECRETARY])).toBe("blocked");
  });

  it("returns null when secretaryAgentIds is empty", () => {
    const prev = state({ status: "in_progress", assigneeAgentId: SECRETARY });
    const next = state({ status: "done", assigneeAgentId: SECRETARY });
    expect(matchesT6(prev, next, [])).toBe(null);
  });

  it("returns null when no Sekretärin was ever involved", () => {
    const prev = state({ status: "in_progress", assigneeAgentId: CEO });
    const next = state({ status: "done", assigneeAgentId: CEO });
    expect(matchesT6(prev, next, [SECRETARY])).toBe(null);
  });

  it("returns null when status did not change", () => {
    const prev = state({ status: "in_review", assigneeAgentId: SECRETARY });
    const next = state({ status: "in_review", assigneeAgentId: SECRETARY });
    expect(matchesT6(prev, next, [SECRETARY])).toBe(null);
  });

  it("returns null when next.status is not one of done/in_review/blocked", () => {
    const prev = state({ status: "todo", assigneeAgentId: SECRETARY });
    const next = state({ status: "in_progress", assigneeAgentId: SECRETARY });
    expect(matchesT6(prev, next, [SECRETARY])).toBe(null);
  });

  it("fires on first-event (prev=null) when Sekretärin issue arrives in a trigger status", () => {
    const next = state({ status: "in_review", assigneeAgentId: SECRETARY });
    expect(matchesT6(null, next, [SECRETARY])).toBe("in_review");
  });
});
