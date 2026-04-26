import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REQUIRED_SECTIONS,
  hasAllRequiredSections,
  scaffoldDescription,
  getSpecEnforceMode,
} from "./issue-template-scaffold.js";

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

// ============================================================================
// REQUIRED_SECTIONS
// ============================================================================

describe("REQUIRED_SECTIONS", () => {
  it("contains exactly three sections", () => {
    expect(REQUIRED_SECTIONS).toHaveLength(3);
  });

  it("includes Objective, Scope, and Verification", () => {
    expect(REQUIRED_SECTIONS).toContain("## Objective");
    expect(REQUIRED_SECTIONS).toContain("## Scope");
    expect(REQUIRED_SECTIONS).toContain("## Verification");
  });
});

// ============================================================================
// hasAllRequiredSections
// ============================================================================

describe("hasAllRequiredSections", () => {
  it("returns false for null", () => {
    expect(hasAllRequiredSections(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(hasAllRequiredSections(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasAllRequiredSections("")).toBe(false);
  });

  it("returns false when only some sections are present", () => {
    expect(hasAllRequiredSections("## Objective\n## Scope")).toBe(false);
  });

  it("returns true when all three sections are present", () => {
    const desc = "## Objective\n\ncontent\n\n## Scope\n\ncontent\n\n## Verification\n\n- [ ] done";
    expect(hasAllRequiredSections(desc)).toBe(true);
  });

  it("returns false when a section is present but differently cased", () => {
    const desc = "## objective\n## scope\n## verification";
    expect(hasAllRequiredSections(desc)).toBe(false);
  });

  it("returns false for a description missing Verification only", () => {
    expect(hasAllRequiredSections("## Objective\n## Scope")).toBe(false);
  });
});

// ============================================================================
// scaffoldDescription
// ============================================================================

describe("scaffoldDescription", () => {
  it("returns a description with all sections unchanged when complete", () => {
    const desc = "## Objective\n\nfoo\n\n## Scope\n\nbar\n\n## Verification\n\n- [ ] done";
    expect(scaffoldDescription(desc)).toBe(desc);
  });

  it("appends missing sections when description is empty", () => {
    const result = scaffoldDescription("");
    expect(result).toContain("## Objective");
    expect(result).toContain("## Scope");
    expect(result).toContain("## Verification");
  });

  it("appends missing sections when description is null", () => {
    const result = scaffoldDescription(null);
    expect(result).toContain("## Objective");
  });

  it("appends missing sections when description is undefined", () => {
    const result = scaffoldDescription(undefined);
    expect(result).toContain("## Verification");
  });

  it("appends only missing sections to an existing description", () => {
    const existing = "## Objective\n\nsome objective\n\n## Scope\n\nsome scope";
    const result = scaffoldDescription(existing);
    expect(result).toContain("## Objective");
    expect(result).toContain("## Scope");
    expect(result).toContain("## Verification");
    // Original content preserved
    expect(result).toContain("some objective");
  });

  it("preserves existing content before appending skeletons", () => {
    const existing = "My description";
    const result = scaffoldDescription(existing);
    expect(result.startsWith("My description")).toBe(true);
  });

  it("does not duplicate a section that already exists", () => {
    const withAll = "## Objective\n\nfoo\n\n## Scope\n\nbar\n\n## Verification\n\n- [ ] done";
    const result = scaffoldDescription(withAll);
    const objectiveCount = (result.match(/## Objective/g) ?? []).length;
    expect(objectiveCount).toBe(1);
  });
});

// ============================================================================
// getSpecEnforceMode
// ============================================================================

describe("getSpecEnforceMode", () => {
  it("returns 'scaffold' by default (no env var set)", () => {
    vi.stubEnv("PAPERCLIP_SPEC_ENFORCE", "");
    expect(getSpecEnforceMode()).toBe("scaffold");
  });

  it("returns 'strict' when PAPERCLIP_SPEC_ENFORCE=strict", () => {
    vi.stubEnv("PAPERCLIP_SPEC_ENFORCE", "strict");
    expect(getSpecEnforceMode()).toBe("strict");
  });

  it("returns 'scaffold' for any other value", () => {
    vi.stubEnv("PAPERCLIP_SPEC_ENFORCE", "lenient");
    expect(getSpecEnforceMode()).toBe("scaffold");
  });
});
