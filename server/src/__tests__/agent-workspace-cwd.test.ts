import { describe, expect, it } from "vitest";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import {
  isPaperclipFallbackWorkspaceCwd,
  preferProjectPrimaryWorkspaceCwd,
} from "../services/agent-workspace-cwd.js";

const wrapperWorkspaceCwd = path.resolve(
  resolvePaperclipInstanceRoot(),
  "workspaces",
  "project-wrapper",
);

describe("isPaperclipFallbackWorkspaceCwd", () => {
  it("classifies wrapper workspace paths under the Paperclip instance workspaces root as fallback", () => {
    expect(
      isPaperclipFallbackWorkspaceCwd({
        cwd: wrapperWorkspaceCwd,
      }),
    ).toBe(true);
  });

  it("does not classify arbitrary non-instance workspaces as fallback", () => {
    expect(
      isPaperclipFallbackWorkspaceCwd({
        cwd: "/Users/test/code/custom-checkout",
      }),
    ).toBe(false);
  });
});

describe("preferProjectPrimaryWorkspaceCwd", () => {
  it("replaces wrapper cwd with the project primary workspace and preserves relative instructions paths", () => {
    const result = preferProjectPrimaryWorkspaceCwd({
      adapterType: "codex_local",
      adapterConfig: {
        cwd: wrapperWorkspaceCwd,
        instructionsFilePath: "agents/founding-engineer/AGENTS.md",
      },
      projectPrimaryWorkspaceCwd: "/Users/test/code/polybot",
    });

    expect(result).toEqual({
      cwd: "/Users/test/code/polybot",
      instructionsFilePath: path.resolve(
        wrapperWorkspaceCwd,
        "agents/founding-engineer/AGENTS.md",
      ),
    });
  });

  it("does not replace intentionally pinned non-project checkouts", () => {
    const adapterConfig = {
      cwd: "/Users/test/code/another-repo",
      instructionsFilePath: "/Users/test/code/another-repo/AGENTS.md",
    };
    expect(
      preferProjectPrimaryWorkspaceCwd({
        adapterType: "codex_local",
        adapterConfig,
        projectPrimaryWorkspaceCwd: "/Users/test/code/polybot",
      }),
    ).toEqual(adapterConfig);
  });
});
