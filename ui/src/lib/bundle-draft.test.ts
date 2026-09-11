import { describe, expect, it } from "vitest";
import { resolveBundleDraft, type BundleDraft } from "./bundle-draft";

const persisted: BundleDraft = {
  mode: "managed",
  rootPath: "/agents/cto/instructions",
  entryFile: "AGENTS.md",
};

describe("resolveBundleDraft", () => {
  it("initializes from persisted state when current is null", () => {
    const result = resolveBundleDraft(null, persisted);
    expect(result).toEqual(persisted);
  });

  it("re-syncs when draft matches persisted state (no unsaved edits)", () => {
    // Draft matches what was persisted — user didn't edit anything
    const current: BundleDraft = { ...persisted };
    const result = resolveBundleDraft(current, persisted);
    expect(result).toEqual(persisted);
    expect(result).not.toBe(current); // new object, not stale reference
  });

  it("preserves draft when user changed mode", () => {
    const current: BundleDraft = { ...persisted, mode: "external" };
    const result = resolveBundleDraft(current, persisted);
    expect(result).toBe(current);
  });

  it("preserves draft when user changed rootPath", () => {
    const current: BundleDraft = { ...persisted, rootPath: "/custom/path" };
    const result = resolveBundleDraft(current, persisted);
    expect(result).toBe(current);
  });

  it("preserves draft when user changed entryFile", () => {
    const current: BundleDraft = { ...persisted, entryFile: "CUSTOM.md" };
    const result = resolveBundleDraft(current, persisted);
    expect(result).toBe(current);
  });

  it("re-syncs when all draft fields match persisted", () => {
    const current: BundleDraft = {
      mode: "managed",
      rootPath: "/agents/cto/instructions",
      entryFile: "AGENTS.md",
    };
    const result = resolveBundleDraft(current, persisted);
    expect(result).toEqual(persisted);
    expect(result).not.toBe(current); // fresh object
  });

  it("returns a new object (not a reference to persisted)", () => {
    const result = resolveBundleDraft(null, persisted);
    expect(result).not.toBe(persisted);
  });
});
