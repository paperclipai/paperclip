// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { IssueAssignmentRouting } from "@paperclipai/shared";
import {
  canAutoAssignIssue,
  formatAssignmentScore,
  formatIssueAssignmentRouting,
  parseCapabilityTags,
  readAutoAssignmentDraft,
  runtimeConfigWithAutoAssignment,
} from "./agent-assignment";

const agentA = "11111111-1111-4111-8111-111111111111";

describe("agent assignment helpers", () => {
  it("reads a missing or invalid profile as disabled", () => {
    expect(readAutoAssignmentDraft(undefined)).toEqual({ enabled: false, capabilities: [] });
    expect(readAutoAssignmentDraft({ enabled: true, quality: 9 })).toEqual({ enabled: false, capabilities: [] });
    expect(readAutoAssignmentDraft({ enabled: true, capabilities: ["SQL"], quality: 4 })).toEqual({ enabled: true, capabilities: ["sql"], quality: 4 });
  });

  it("parses comma-separated tags as trimmed, lowercase, unique values", () => {
    expect(parseCapabilityTags(" Frontend, sql,,SQL , docs ")).toEqual(["frontend", "sql", "docs"]);
    expect(parseCapabilityTags("a, b, c", 2)).toEqual(["a", "b"]);
    expect(parseCapabilityTags("")).toEqual([]);
  });

  it("restores the saved runtime config when the draft matches it again", () => {
    const saved = { heartbeat: { enabled: true } };
    const enabled = runtimeConfigWithAutoAssignment(saved, undefined, { enabled: true, capabilities: ["sql"], quality: 3 });
    expect(enabled.autoAssignment).toEqual({ enabled: true, capabilities: ["sql"], quality: 3 });
    expect(runtimeConfigWithAutoAssignment(saved, enabled, { enabled: false, capabilities: [] }))
      .toEqual({ heartbeat: { enabled: true }, aiConnection: undefined });
  });

  it("offers auto-assign only for unassigned tasks in an open status", () => {
    expect(canAutoAssignIssue({ assigneeAgentId: null, assigneeUserId: null, status: "todo" })).toBe(true);
    expect(canAutoAssignIssue({ assigneeAgentId: agentA, assigneeUserId: null, status: "todo" })).toBe(false);
    expect(canAutoAssignIssue({ assigneeAgentId: null, assigneeUserId: "user-1", status: "todo" })).toBe(false);
    expect(canAutoAssignIssue({ assigneeAgentId: null, assigneeUserId: null, status: "done" })).toBe(false);
  });

  it("formats the decision summary and marks unknown scores as neutral", () => {
    const routing: IssueAssignmentRouting = {
      mode: "auto", status: "assigned", strategy: "cost", requiredCapabilities: [], tier: null,
      selectedAgentId: agentA, decidedAt: "2026-11-17T00:00:00.000Z", fallback: null,
      candidates: [{ agentId: agentA, name: "Builder", eligible: true, excludedReasons: [], scores: null, total: 0.7, rank: 1 }],
    };
    expect(formatIssueAssignmentRouting(null)).toBe("Auto-assign");
    expect(formatIssueAssignmentRouting(routing)).toBe("Auto: Builder · Cost");
    expect(formatIssueAssignmentRouting({ ...routing, status: "no_candidate", selectedAgentId: null })).toBe("Auto: no match · Cost");
    expect(formatAssignmentScore({ value: 0.5, source: "unknown", detail: null })).toBe("unknown (neutral 0.50)");
    expect(formatAssignmentScore({ value: 0.42, source: "observed", detail: null })).toBe("0.42 · observed");
  });
});
