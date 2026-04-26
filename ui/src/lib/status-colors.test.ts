import { describe, expect, it } from "vitest";
import {
  issueStatusIcon,
  issueStatusIconDefault,
  issueStatusText,
  issueStatusTextDefault,
  statusBadge,
  statusBadgeDefault,
  agentStatusDot,
  agentStatusDotDefault,
  priorityColor,
  priorityColorDefault,
} from "./status-colors.js";

const ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"] as const;
// Statuses tested in statusBadge (superset); agentStatusDot uses a subset.
const AGENT_STATUSES = ["active", "running", "paused", "idle", "error", "terminated", "pending_approval"] as const;
// agentStatusDot only covers the subset of statuses that have dot indicators.
const AGENT_DOT_STATUSES = ["active", "running", "paused", "idle", "error", "pending_approval", "archived"] as const;
const PRIORITIES = ["critical", "high", "medium", "low"] as const;

// ============================================================================
// issueStatusIcon
// ============================================================================

describe("issueStatusIcon", () => {
  for (const status of ISSUE_STATUSES) {
    it(`has a non-empty class string for status '${status}'`, () => {
      expect(typeof issueStatusIcon[status]).toBe("string");
      expect(issueStatusIcon[status].length).toBeGreaterThan(0);
    });
  }

  it("issueStatusIconDefault is a non-empty string", () => {
    expect(typeof issueStatusIconDefault).toBe("string");
    expect(issueStatusIconDefault.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// issueStatusText
// ============================================================================

describe("issueStatusText", () => {
  for (const status of ISSUE_STATUSES) {
    it(`has a non-empty class string for status '${status}'`, () => {
      expect(typeof issueStatusText[status]).toBe("string");
      expect(issueStatusText[status].length).toBeGreaterThan(0);
    });
  }

  it("issueStatusTextDefault is a non-empty string", () => {
    expect(typeof issueStatusTextDefault).toBe("string");
    expect(issueStatusTextDefault.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// statusBadge — covers agent and issue statuses
// ============================================================================

describe("statusBadge", () => {
  it("has entries for all agent statuses", () => {
    for (const status of AGENT_STATUSES) {
      expect(statusBadge[status], `statusBadge missing key: ${status}`).toBeDefined();
    }
  });

  it("has entries for core issue statuses", () => {
    for (const status of ISSUE_STATUSES) {
      expect(statusBadge[status], `statusBadge missing key: ${status}`).toBeDefined();
    }
  });

  it("statusBadgeDefault is a non-empty string", () => {
    expect(typeof statusBadgeDefault).toBe("string");
    expect(statusBadgeDefault.length).toBeGreaterThan(0);
  });

  it("each badge class is a non-empty string", () => {
    for (const [key, value] of Object.entries(statusBadge)) {
      expect(typeof value).toBe("string");
      expect(value.length, `statusBadge['${key}'] is empty`).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// agentStatusDot
// ============================================================================

describe("agentStatusDot", () => {
  for (const status of AGENT_DOT_STATUSES) {
    it(`has a class for agent status '${status}'`, () => {
      expect(agentStatusDot[status]).toBeDefined();
    });
  }

  it("agentStatusDotDefault is a non-empty string", () => {
    expect(typeof agentStatusDotDefault).toBe("string");
    expect(agentStatusDotDefault.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// priorityColor
// ============================================================================

describe("priorityColor", () => {
  for (const priority of PRIORITIES) {
    it(`has a non-empty class for priority '${priority}'`, () => {
      expect(typeof priorityColor[priority]).toBe("string");
      expect(priorityColor[priority].length).toBeGreaterThan(0);
    });
  }

  it("priorityColorDefault is a non-empty string", () => {
    expect(typeof priorityColorDefault).toBe("string");
    expect(priorityColorDefault.length).toBeGreaterThan(0);
  });
});
