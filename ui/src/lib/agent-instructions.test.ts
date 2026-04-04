import { describe, expect, it } from "vitest";
import { instructionsBundleHasFile } from "./agent-instructions";

describe("instructionsBundleHasFile", () => {
  it("treats the configured entry file as existing even when it is missing from file metadata", () => {
    expect(instructionsBundleHasFile({
      bundleMatchesDraft: true,
      currentEntryFile: "AGENTS.md",
      selectedFile: "AGENTS.md",
      fileOptions: ["HEARTBEAT.md"],
    })).toBe(true);
  });

  it("does not treat unrelated missing files as existing", () => {
    expect(instructionsBundleHasFile({
      bundleMatchesDraft: true,
      currentEntryFile: "AGENTS.md",
      selectedFile: "TOOLS.md",
      fileOptions: ["HEARTBEAT.md"],
    })).toBe(false);
  });

  it("returns false while the visible bundle no longer matches the persisted draft", () => {
    expect(instructionsBundleHasFile({
      bundleMatchesDraft: false,
      currentEntryFile: "AGENTS.md",
      selectedFile: "AGENTS.md",
      fileOptions: ["AGENTS.md"],
    })).toBe(false);
  });
});
