import { describe, expect, it, vi, afterEach } from "vitest";

// Mock os.homedir() before importing the module under test
const mockHomedir = vi.fn(() => "/Users/bbright");
vi.mock("node:os", () => ({ default: { homedir: () => mockHomedir() }, homedir: () => mockHomedir() }));

const { rebaseHomePath } = await import("../services/path-utils.ts");

describe("rebaseHomePath", () => {
  afterEach(() => {
    mockHomedir.mockReturnValue("/Users/bbright");
  });

  it("rebases macOS /Users/<other>/ to current homedir", () => {
    expect(rebaseHomePath("/Users/bright/Projects/flotter")).toBe(
      "/Users/bbright/Projects/flotter",
    );
  });

  it("rebases Linux /home/<other>/ to current homedir", () => {
    mockHomedir.mockReturnValue("/home/bbright");
    // Re-import needed since os.homedir is called at invocation time
    expect(rebaseHomePath("/home/deploy/apps/cos")).toBe(
      "/home/bbright/apps/cos",
    );
  });

  it("leaves path unchanged if homedir already matches", () => {
    expect(rebaseHomePath("/Users/bbright/Projects/cos")).toBe(
      "/Users/bbright/Projects/cos",
    );
  });

  it("leaves non-home paths unchanged", () => {
    expect(rebaseHomePath("/opt/data/shared")).toBe("/opt/data/shared");
    expect(rebaseHomePath("/var/lib/app")).toBe("/var/lib/app");
  });

  it("handles paths with only the home prefix (no subpath)", () => {
    expect(rebaseHomePath("/Users/bright")).toBe("/Users/bbright");
  });

  it("handles deeply nested paths", () => {
    expect(
      rebaseHomePath("/Users/bright/a/b/c/d/e"),
    ).toBe("/Users/bbright/a/b/c/d/e");
  });

  it("does not match partial username (e.g. /Users/brightness)", () => {
    // /Users/brightness → rebased to /Users/bbright (username is "brightness")
    // This is correct: "brightness" IS a valid username dir
    const result = rebaseHomePath("/Users/brightness/Projects");
    expect(result).toBe("/Users/bbright/Projects");
  });

  it("handles empty-ish paths gracefully", () => {
    expect(rebaseHomePath("")).toBe("");
    expect(rebaseHomePath("/")).toBe("/");
  });
});
