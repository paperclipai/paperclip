import { describe, expect, it } from "vitest";
import {
  matchProjectIdByRepoReference,
  normalizeRepoIdentity,
} from "../services/issue-project-inference.ts";

describe("normalizeRepoIdentity", () => {
  it("folds every remote form of the same repo onto one identity", () => {
    const expected = "github.com/zannis/paperclip";
    expect(normalizeRepoIdentity("https://github.com/zannis/paperclip")).toBe(expected);
    expect(normalizeRepoIdentity("https://github.com/zannis/paperclip.git")).toBe(expected);
    expect(normalizeRepoIdentity("https://github.com/zannis/paperclip/")).toBe(expected);
    expect(normalizeRepoIdentity("http://github.com/Zannis/Paperclip")).toBe(expected);
    expect(normalizeRepoIdentity("git@github.com:zannis/paperclip.git")).toBe(expected);
    expect(normalizeRepoIdentity("ssh://git@github.com/zannis/paperclip.git")).toBe(expected);
    expect(normalizeRepoIdentity("https://user:token@github.com/zannis/paperclip")).toBe(expected);
    expect(normalizeRepoIdentity("https://www.github.com/zannis/paperclip")).toBe(expected);
  });

  it("keeps non-GitHub hosts distinct", () => {
    expect(normalizeRepoIdentity("https://gitlab.com/zannis/paperclip")).toBe(
      "gitlab.com/zannis/paperclip",
    );
  });

  it("rejects anything that is not an owner/repo remote", () => {
    expect(normalizeRepoIdentity("")).toBeNull();
    expect(normalizeRepoIdentity("   ")).toBeNull();
    expect(normalizeRepoIdentity("https://github.com/zannis")).toBeNull();
    expect(normalizeRepoIdentity("not a url")).toBeNull();
    expect(normalizeRepoIdentity("/paperclip/agents/repos/actual")).toBeNull();
  });
});

describe("matchProjectIdByRepoReference", () => {
  const workspaces = [
    { projectId: "project-actual", repoUrl: "https://github.com/zannis/actual", cwd: "/paperclip/agents/repos/actual" },
    { projectId: "project-shove", repoUrl: "https://github.com/zannis/shove", cwd: "/paperclip/agents/repos/shove" },
    { projectId: "project-paperclip", repoUrl: "git@github.com:zannis/paperclip.git", cwd: null },
    { projectId: "project-no-repo", repoUrl: null, cwd: null },
  ];

  it("returns null when nothing in the text names a repo", () => {
    expect(
      matchProjectIdByRepoReference({ text: "Tidy up the onboarding copy", workspaces }),
    ).toBeNull();
  });

  it("matches a remote URL against a workspace repoUrl", () => {
    expect(
      matchProjectIdByRepoReference({
        text: "The regression is in https://github.com/zannis/shove/blob/main/src/main.rs",
        workspaces,
      }),
    ).toBe("project-shove");
  });

  it("matches across differing remote forms", () => {
    expect(
      matchProjectIdByRepoReference({
        text: "Clone git@github.com:zannis/paperclip.git and reproduce",
        workspaces,
      }),
    ).toBe("project-paperclip");
  });

  it("matches an absolute path that is the workspace cwd", () => {
    expect(
      matchProjectIdByRepoReference({
        text: "Uncommitted work is stranded in /paperclip/agents/repos/actual",
        workspaces,
      }),
    ).toBe("project-actual");
  });

  it("matches an absolute path underneath the workspace cwd", () => {
    expect(
      matchProjectIdByRepoReference({
        text: "See `/paperclip/agents/repos/actual/packages/loot-core/src/index.ts` for the call site.",
        workspaces,
      }),
    ).toBe("project-actual");
  });

  it("does not match a path that only shares a prefix with the cwd", () => {
    expect(
      matchProjectIdByRepoReference({
        text: "The stray checkout at /paperclip/agents/repos/actual-backup is unrelated",
        workspaces,
      }),
    ).toBeNull();
  });

  it("prefers the most specific cwd when workspaces nest", () => {
    expect(
      matchProjectIdByRepoReference({
        text: "Broken file: /repos/mono/packages/api/src/app.ts",
        workspaces: [
          { projectId: "project-mono", repoUrl: null, cwd: "/repos/mono" },
          { projectId: "project-api", repoUrl: null, cwd: "/repos/mono/packages/api" },
        ],
      }),
    ).toBe("project-api");
  });

  it("returns null when two different projects are referenced", () => {
    expect(
      matchProjectIdByRepoReference({
        text: "Port the fix from https://github.com/zannis/shove into /paperclip/agents/repos/actual",
        workspaces,
      }),
    ).toBeNull();
  });

  it("stays on one project when several of its own workspaces are referenced", () => {
    expect(
      matchProjectIdByRepoReference({
        text: "https://github.com/zannis/actual and /paperclip/agents/repos/actual are the same repo",
        workspaces,
      }),
    ).toBe("project-actual");
  });

  it("ignores workspaces that carry neither a repo nor a cwd", () => {
    expect(
      matchProjectIdByRepoReference({ text: "project-no-repo", workspaces }),
    ).toBeNull();
  });

  it("does not treat a bare project name as a repo reference", () => {
    expect(
      matchProjectIdByRepoReference({ text: "shove needs a security review", workspaces }),
    ).toBeNull();
  });

  it("tolerates markdown punctuation around the reference", () => {
    expect(
      matchProjectIdByRepoReference({
        text: "Fixed in [#120](https://github.com/zannis/shove/pull/120).",
        workspaces,
      }),
    ).toBe("project-shove");
  });
});
