import { describe, it, expect } from "vitest";
import { matchesT1, matchesT2, matchesT3 } from "../src/transitions.js";
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

  it("does not fire when already blocked", () => {
    const prev = state({ status: "blocked" });
    const next = state({ status: "blocked" });
    expect(matchesT3(prev, next)).toBe(false);
  });
});
