import { describe, expect, it } from "vitest";
import { createProjectWorkspaceSchema, isRepositoryUrl, updateProjectWorkspaceSchema } from "./project.js";

describe("project workspace repoUrl", () => {
  it.each([
    "https://github.com/acme/app",
    "https://github.com/acme/app.git",
    "ssh://git@github.com/acme/app.git",
    "ssh://git@github.com:2222/acme/app.git",
    "file:///srv/git/app.git",
    "git@github.com:acme/app.git",
    "git@github.com-work:acme/app.git",
    "git@gitlab.example.com:group/sub/app.git",
    "deploy@git.example.com:~/app.git",
  ])("accepts the Git remote %s", repoUrl => {
    expect(isRepositoryUrl(repoUrl)).toBe(true);
    expect(createProjectWorkspaceSchema.safeParse({ repoUrl }).success).toBe(true);
    expect(updateProjectWorkspaceSchema.safeParse({ repoUrl }).success).toBe(true);
  });

  it.each([
    "",
    "app",
    "acme/app",
    "git@github.com:",
    "git@github.com://acme/app",
    "git@github.com:acme/app with space",
  ])("rejects %j", repoUrl => {
    expect(isRepositoryUrl(repoUrl)).toBe(false);
    expect(createProjectWorkspaceSchema.safeParse({ cwd: "/repo", repoUrl }).success).toBe(false);
  });

  it("still accepts a null repoUrl", () => {
    expect(updateProjectWorkspaceSchema.safeParse({ repoUrl: null }).success).toBe(true);
  });
});
