import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSpecEnforceMode,
  hasAllRequiredSections,
  REQUIRED_SECTIONS,
  scaffoldDescription,
} from "../issue-template-scaffold.js";

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
    expect(hasAllRequiredSections("## Objective\n\nDo stuff")).toBe(false);
    expect(hasAllRequiredSections("## Objective\n\nDo stuff\n\n## Scope\n\nTouch: foo")).toBe(false);
  });

  it("returns true when all three sections are present", () => {
    const desc = "## Objective\n\nDo stuff\n\n## Scope\n\nTouch: foo\n\n## Verification\n\n- [ ] check";
    expect(hasAllRequiredSections(desc)).toBe(true);
  });

  it("returns true even when extra sections are present", () => {
    const desc =
      "## Context\n\nBackground\n\n## Objective\n\nDo stuff\n\n## Scope\n\nTouch: foo\n\n## Verification\n\n- [ ] check\n\n## Notes\n\nExtra";
    expect(hasAllRequiredSections(desc)).toBe(true);
  });
});

describe("scaffoldDescription", () => {
  it("returns scaffold with all three sections when description is null", () => {
    const result = scaffoldDescription(null);
    for (const section of REQUIRED_SECTIONS) {
      expect(result).toContain(section);
    }
  });

  it("returns scaffold with all three sections when description is undefined", () => {
    const result = scaffoldDescription(undefined);
    for (const section of REQUIRED_SECTIONS) {
      expect(result).toContain(section);
    }
  });

  it("returns scaffold with all three sections when description is empty string", () => {
    const result = scaffoldDescription("");
    for (const section of REQUIRED_SECTIONS) {
      expect(result).toContain(section);
    }
  });

  it("passes through unchanged when all sections are already present", () => {
    const desc = "## Objective\n\nDo stuff\n\n## Scope\n\nTouch: foo\n\n## Verification\n\n- [ ] check";
    expect(scaffoldDescription(desc)).toBe(desc);
  });

  it("appends only the missing sections when description is partial (Objective only)", () => {
    const desc = "## Objective\n\nDo stuff";
    const result = scaffoldDescription(desc);
    expect(result).toContain("## Objective");
    expect(result).toContain("## Scope");
    expect(result).toContain("## Verification");
    // Original content preserved
    expect(result).toContain("Do stuff");
    // Objective section NOT duplicated
    expect(result.indexOf("## Objective")).toBe(result.lastIndexOf("## Objective"));
  });

  it("appends only the missing sections when description has Objective and Scope but not Verification", () => {
    const desc = "## Objective\n\nDo stuff\n\n## Scope\n\nTouch: foo";
    const result = scaffoldDescription(desc);
    expect(result).toContain("## Verification");
    // Objective and Scope are not duplicated
    expect(result.split("## Objective").length).toBe(2);
    expect(result.split("## Scope").length).toBe(2);
  });
});

describe("getSpecEnforceMode", () => {
  const originalEnv = process.env.PAPERCLIP_SPEC_ENFORCE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PAPERCLIP_SPEC_ENFORCE;
    } else {
      process.env.PAPERCLIP_SPEC_ENFORCE = originalEnv;
    }
  });

  it("returns scaffold when env var is not set", () => {
    delete process.env.PAPERCLIP_SPEC_ENFORCE;
    expect(getSpecEnforceMode()).toBe("scaffold");
  });

  it("returns strict when env var is set to strict", () => {
    process.env.PAPERCLIP_SPEC_ENFORCE = "strict";
    expect(getSpecEnforceMode()).toBe("strict");
  });

  it("returns scaffold for any other value", () => {
    process.env.PAPERCLIP_SPEC_ENFORCE = "soft";
    expect(getSpecEnforceMode()).toBe("scaffold");
    process.env.PAPERCLIP_SPEC_ENFORCE = "1";
    expect(getSpecEnforceMode()).toBe("scaffold");
  });
});
