import { describe, expect, it } from "vitest";
import {
  buildProjectWorkspaceInput,
  deriveProjectNameFromRepoUrl,
  deriveWorkspaceNameFromPath,
  looksLikeProjectRepoUrl,
  validateProjectWorkspaceInputs,
} from "./project-workspace";

describe("project workspace helpers", () => {
  it("derives the project name from the repo slug", () => {
    expect(deriveProjectNameFromRepoUrl("https://github.com/paperclipai/paperclip.git")).toBe("paperclip");
    expect(deriveProjectNameFromRepoUrl("https://git.example.com/org/internal-tools")).toBe("internal-tools");
  });

  it("accepts https repo URLs and rejects unsupported ones", () => {
    expect(looksLikeProjectRepoUrl("https://github.com/paperclipai/paperclip")).toBe(true);
    expect(looksLikeProjectRepoUrl("https://git.example.com/org/repo")).toBe(true);
    expect(looksLikeProjectRepoUrl("http://github.com/paperclipai/paperclip")).toBe(false);
    expect(looksLikeProjectRepoUrl("not-a-url")).toBe(false);
  });

  it("builds a primary workspace payload from a repo URL", () => {
    expect(buildProjectWorkspaceInput({ repoUrl: "https://github.com/paperclipai/paperclip.git" })).toEqual({
      name: "paperclip",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      isPrimary: true,
    });
  });

  it("preserves local folder names and validation messages", () => {
    expect(deriveWorkspaceNameFromPath("/Users/test/my-repo/")).toBe("my-repo");
    expect(validateProjectWorkspaceInputs({ localPath: "relative/path" })).toBe(
      "Local folder must be a full absolute path.",
    );
    expect(validateProjectWorkspaceInputs({ repoUrl: "ssh://github.com/org/repo" })).toBe(
      "Repo must use a valid GitHub or GitHub Enterprise repo URL.",
    );
  });
});
