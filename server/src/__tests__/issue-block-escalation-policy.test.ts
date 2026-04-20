import { describe, expect, it } from "vitest";
import {
  DEFAULT_BLOCK_ESCALATION_OPEN_STATUSES,
  parseIssueBlockEscalationConfig,
} from "../routes/issues.js";

describe("parseIssueBlockEscalationConfig", () => {
  it("returns null unless the policy is explicitly enabled", () => {
    expect(parseIssueBlockEscalationConfig(null)).toBeNull();
    expect(parseIssueBlockEscalationConfig({})).toBeNull();
    expect(parseIssueBlockEscalationConfig({ enabled: false, targetRole: "cto" })).toBeNull();
  });

  it("uses default open statuses when the opt-in policy omits them", () => {
    expect(parseIssueBlockEscalationConfig({ enabled: true, targetRole: "cto" })).toEqual({
      targetRole: "cto",
      openStatuses: DEFAULT_BLOCK_ESCALATION_OPEN_STATUSES,
    });
  });

  it("preserves explicit target role and reusable statuses", () => {
    expect(
      parseIssueBlockEscalationConfig({
        enabled: "true",
        targetRole: "qa_tester",
        openStatuses: ["todo", "in_progress"],
      }),
    ).toEqual({
      targetRole: "qa_tester",
      openStatuses: "todo,in_progress",
    });
  });
});
