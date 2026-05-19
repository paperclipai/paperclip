import { describe, expect, it } from "vitest";

import {
  buildMobileSummary,
  normalizeAgentStatus,
  normalizeIssueStatus,
} from "./status.js";
import type { MobileIssueRow } from "./types.js";

describe("normalizeIssueStatus", () => {
  it.each(["in_progress", "running", "active"])(
    "maps %s to running",
    (status) => {
      expect(normalizeIssueStatus(status)).toBe("running");
    },
  );

  it.each(["blocked", "error"])("maps %s to blocked", (status) => {
    expect(normalizeIssueStatus(status)).toBe("blocked");
  });

  it.each(["done", "closed", "completed"])("maps %s to done", (status) => {
    expect(normalizeIssueStatus(status)).toBe("done");
  });

  it.each(["review", "review_needed", "todo", "", null, undefined])(
    "maps %s to review_needed by default",
    (status) => {
      expect(normalizeIssueStatus(status)).toBe("review_needed");
    },
  );
});

describe("normalizeAgentStatus", () => {
  it.each(["running", "working"])("maps %s to running", (status) => {
    expect(normalizeAgentStatus(status)).toBe("running");
  });

  it.each(["error", "failed"])("maps %s to error", (status) => {
    expect(normalizeAgentStatus(status)).toBe("error");
  });

  it("maps blocked to blocked", () => {
    expect(normalizeAgentStatus("blocked")).toBe("blocked");
  });

  it.each(["idle", "paused", "unknown", "", null, undefined])(
    "maps %s to idle by default",
    (status) => {
      expect(normalizeAgentStatus(status)).toBe("idle");
    },
  );
});

describe("buildMobileSummary", () => {
  const issue = (
    id: string,
    status: MobileIssueRow["status"],
  ): MobileIssueRow => ({
    id,
    title: `Issue ${id}`,
    status,
    priority: "medium",
    assigneeName: null,
    updatedAt: "2026-05-16T00:00:00.000Z",
    risk: null,
  });

  it("counts issue rows by mobile status and leaves latestReport null", () => {
    expect(
      buildMobileSummary([
        issue("1", "running"),
        issue("2", "review_needed"),
        issue("3", "review_needed"),
        issue("4", "blocked"),
        issue("5", "done"),
      ]),
    ).toEqual({
      health: "degraded",
      counts: {
        running: 1,
        reviewNeeded: 2,
        blocked: 1,
        done: 1,
      },
      latestReport: null,
    });
  });

  it("sets health ok when no issue is blocked", () => {
    expect(buildMobileSummary([issue("1", "running"), issue("2", "done")])).toEqual({
      health: "ok",
      counts: {
        running: 1,
        reviewNeeded: 0,
        blocked: 0,
        done: 1,
      },
      latestReport: null,
    });
  });
});
