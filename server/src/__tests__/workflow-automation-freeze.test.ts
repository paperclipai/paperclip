import { describe, expect, it } from "vitest";
import {
  isBoardFreezeDirectiveComment,
  isBoardUnfreezeDirectiveComment,
  resolveBoardFreezeState,
} from "../services/workflow-automation.js";

describe("queue-aging freeze detection", () => {
  it("detects explicit board freeze directives", () => {
    expect(
      isBoardFreezeDirectiveComment({
        authorUserId: "local-board",
        body: "Keep this task frozen for now.",
      }),
    ).toBe(true);
  });

  it("detects agent notes that explicitly reference board freeze policy", () => {
    expect(
      isBoardFreezeDirectiveComment({
        authorUserId: null,
        body: "Paused by board directive from [Issue OTTAA-61](/issues/OTTAA-61).",
      }),
    ).toBe(true);
  });

  it("does not treat generic non-board pause comments as frozen lanes", () => {
    expect(
      isBoardFreezeDirectiveComment({
        authorUserId: null,
        body: "Temporarily paused while waiting for dependency.",
      }),
    ).toBe(false);
  });

  it("detects explicit board unfreeze directives", () => {
    expect(
      isBoardUnfreezeDirectiveComment({
        authorUserId: "local-board",
        body: "Pause lifted. Resume work now.",
      }),
    ).toBe(true);
  });

  it("does not misread freeze phrasing as unfreeze", () => {
    expect(
      isBoardUnfreezeDirectiveComment({
        authorUserId: "local-board",
        body: "No execution work will resume until explicit board reactivation.",
      }),
    ).toBe(false);
  });
});

describe("resolveBoardFreezeState", () => {
  it("tracks freeze then unfreeze transitions per issue", () => {
    const issueId = "issue-1";
    const stateByIssue = resolveBoardFreezeState([
      {
        issueId,
        authorUserId: "local-board",
        body: "Keep this task frozen for now.",
        createdAt: new Date("2026-03-05T10:00:00.000Z"),
      },
      {
        issueId,
        authorUserId: "local-board",
        body: "Pause lifted. Resume work now.",
        createdAt: new Date("2026-03-05T11:00:00.000Z"),
      },
    ]);

    expect(stateByIssue.get(issueId)).toMatchObject({
      isFrozen: false,
      lastFreezeAt: new Date("2026-03-05T10:00:00.000Z"),
      lastUnfreezeAt: new Date("2026-03-05T11:00:00.000Z"),
    });
  });
});
