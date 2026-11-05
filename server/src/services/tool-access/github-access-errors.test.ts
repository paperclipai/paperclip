import { describe, expect, it } from "vitest";
import { githubAccessError, projectGitHubActionResult } from "./github-access-errors.js";

describe("GitHub tool access failures", () => {
  it.each(["integration", "personal access token"])("classifies GitHub's %s permission denial", kind => {
    expect(githubAccessError("github", `GET https://api.github.com/repos/example/private: 403 Resource not accessible by ${kind} []`))
      .toEqual({ errorCode: "github_access_denied" });
  });

  it("does not confuse rate limits, missing resources or another provider with a GitHub access denial", () => {
    for (const message of ["403 API rate limit exceeded", "404 Not Found", "Repository created successfully", "Bad credentials",
      "403 ".repeat(10_000), "x".repeat(4000) + "403 Resource not accessible by integration"])
      expect(githubAccessError("github", message)).toBeNull();
    expect(githubAccessError("notion", "403 Resource not accessible by integration")).toBeNull();
  });

  it("keeps unrelated saved decisions and provider errors unchanged", () => {
    const result = { version: 1 as const, outcome: "accepted" as const, toolAction: {
      version: 1 as const, status: "failed" as const, errorCode: "tool_error",
      errorMessage: "403 Resource not accessible by integration", updatedAt: new Date().toISOString(),
    } };
    expect(projectGitHubActionResult({ version: 1, prompt: "Confirm?" }, result)).toBe(result);
    expect(projectGitHubActionResult({ version: 1, prompt: "Confirm?" }, null)).toBeNull();
  });
});
