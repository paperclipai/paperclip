import { describe, expect, it } from "vitest";
import { deriveRepoNameFromUrl, formatGitRepoUrl, isGitRepoUrl, isPlainHttpGitRepoUrl } from "./git-repo-url";

describe("isGitRepoUrl", () => {
  it("accepts GitHub HTTPS remotes", () => {
    expect(isGitRepoUrl("https://github.com/org/repo")).toBe(true);
    expect(isGitRepoUrl("https://github.com/org/repo.git")).toBe(true);
  });

  it("accepts self-hosted HTTP and HTTPS remotes", () => {
    expect(isGitRepoUrl("https://git.example.com/org/repo")).toBe(true);
    expect(isGitRepoUrl("http://git.local/org/repo.git")).toBe(true);
    expect(isGitRepoUrl("http://gitea.lan/repo.git")).toBe(true);
    expect(isGitRepoUrl("https://git.example.com/repo")).toBe(true);
  });

  it("rejects empty, non-URL, non-HTTP, and host-only values", () => {
    expect(isGitRepoUrl("")).toBe(false);
    expect(isGitRepoUrl("not a url")).toBe(false);
    expect(isGitRepoUrl("git@github.com:org/repo.git")).toBe(false);
    expect(isGitRepoUrl("https://git.example.com")).toBe(false);
  });

  it("rejects public host profile URLs without a repo segment", () => {
    expect(isGitRepoUrl("https://github.com/myorg")).toBe(false);
    expect(isGitRepoUrl("https://gitlab.com/mygroup")).toBe(false);
    expect(isGitRepoUrl("https://bitbucket.org/workspace")).toBe(false);
  });
});

describe("deriveRepoNameFromUrl", () => {
  it("uses the final path segment without a .git suffix", () => {
    expect(deriveRepoNameFromUrl("https://gitlab.com/org/project.git")).toBe("project");
  });

  it("falls back to a generic label for invalid input", () => {
    expect(deriveRepoNameFromUrl("not a url")).toBe("Git repo");
  });
});

describe("isPlainHttpGitRepoUrl", () => {
  it("only identifies valid plain HTTP Git repo URLs", () => {
    expect(isPlainHttpGitRepoUrl("http://gitea.lan/repo.git")).toBe(true);
    expect(isPlainHttpGitRepoUrl("https://git.example.com/org/repo.git")).toBe(false);
    expect(isPlainHttpGitRepoUrl("http://gitea.lan")).toBe(false);
  });
});

describe("formatGitRepoUrl", () => {
  it("formats nested repo paths without a trailing .git suffix", () => {
    expect(formatGitRepoUrl("https://gitlab.com/group/subgroup/project.git")).toBe("gitlab.com/group/subgroup/project");
  });

  it("keeps single-segment self-hosted repo paths visible", () => {
    expect(formatGitRepoUrl("http://gitea.lan/repo.git")).toBe("gitea.lan/repo");
  });
});
