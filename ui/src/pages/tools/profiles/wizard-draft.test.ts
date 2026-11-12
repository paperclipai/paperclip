import { describe, expect, it } from "vitest";
import { readWizardMeta, resumeStep, withWizardMeta } from "./wizard-draft";

describe("readWizardMeta", () => {
  it("reads a stored step and template", () => {
    expect(readWizardMeta({ metadata: { wizard: { lastCompletedStep: 2, template: "everyday" } } })).toEqual({
      lastCompletedStep: 2,
      template: "everyday",
    });
  });

  it("returns null for missing or malformed metadata", () => {
    expect(readWizardMeta(null)).toBeNull();
    expect(readWizardMeta({ metadata: null })).toBeNull();
    expect(readWizardMeta({ metadata: { wizard: { lastCompletedStep: 9 } } })).toBeNull();
  });
});

describe("withWizardMeta", () => {
  it("merges progress without dropping other metadata keys", () => {
    expect(withWizardMeta({ other: 1 }, { lastCompletedStep: 1, template: null })).toEqual({
      other: 1,
      wizard: { lastCompletedStep: 1, template: null },
    });
  });
});

describe("resumeStep", () => {
  it("resumes at the first unfinished step after step 1", () => {
    expect(resumeStep({ lastCompletedStep: 1, template: null })).toBe(2);
  });

  it("caps at the final step", () => {
    expect(resumeStep({ lastCompletedStep: 3, template: null })).toBe(3);
  });

  it("starts at step 1 with no saved progress", () => {
    expect(resumeStep(null)).toBe(1);
  });
});
