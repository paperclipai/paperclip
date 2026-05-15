import { describe, expect, it } from "vitest";
import {
  DEFAULT_ISSUE_CONSTITUTION_BODY,
  DEFAULT_ISSUE_WORKFLOW_CLASS,
} from "./issue-default-description.js";

describe("DEFAULT_ISSUE_CONSTITUTION_BODY", () => {
  it("includes the seven constitution-backed issue fields with Normal as the default workflow class", () => {
    expect(DEFAULT_ISSUE_WORKFLOW_CLASS).toBe("Normal");
    expect(DEFAULT_ISSUE_CONSTITUTION_BODY).toContain("## Workflow class");
    expect(DEFAULT_ISSUE_CONSTITUTION_BODY).toContain("\nNormal\n");
    expect(DEFAULT_ISSUE_CONSTITUTION_BODY).toContain("## Objective");
    expect(DEFAULT_ISSUE_CONSTITUTION_BODY).toContain("## Source of truth");
    expect(DEFAULT_ISSUE_CONSTITUTION_BODY).toContain("## Current state");
    expect(DEFAULT_ISSUE_CONSTITUTION_BODY).toContain("## Acceptance criteria");
    expect(DEFAULT_ISSUE_CONSTITUTION_BODY).toContain("## Required artifacts");
    expect(DEFAULT_ISSUE_CONSTITUTION_BODY).toContain("## Human gate owner");
  });
});
