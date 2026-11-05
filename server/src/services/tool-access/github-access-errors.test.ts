import { describe, expect, it } from "vitest";
import { githubAccessDeniedInstructions, githubAccessError, projectGitHubActionResult } from "./github-access-errors.js";

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
    expect(projectGitHubActionResult("notion", result)).toBe(result);
    expect(projectGitHubActionResult(undefined, result)).toBe(result);
    expect(projectGitHubActionResult("github", null)).toBeNull();
  });

  it.each(["tool_error", "tool_execution_failed"])("projects historical %s errors using verified provider identity", errorCode => {
    const result = { version: 1 as const, outcome: "accepted" as const, toolAction: {
      version: 1 as const, status: "failed" as const, errorCode,
      errorMessage: "403 Resource not accessible by integration", updatedAt: new Date().toISOString(),
    } };
    expect(projectGitHubActionResult("github", result)).toMatchObject({ toolAction: { errorCode: "github_access_denied" } });
  });

  it("gives repository-create recovery steps for both GitHub tool name spellings", () => {
    for (const toolName of ["mcp.github:create-repository", "mcp.github:create_repository"]) {
      const text = githubAccessDeniedInstructions(toolName, "managed");
      expect(text).toMatch(/Do not retry/);
      expect(text).toContain("https://github.com/new");
      expect(text).toContain("Refresh access");
    }
    const other = githubAccessDeniedInstructions("mcp.github:create_issue", "managed");
    expect(other).toMatch(/Do not retry/);
    expect(other).not.toContain("github.com/new");
  });

  it("gives token and unknown connections their own repair steps", () => {
    const token = githubAccessDeniedInstructions("mcp.github:create_repository", "mcp-key");
    expect(token).toMatch(/token.*permissions/i);
    expect(token).toMatch(/replace.*token/i);
    expect(token).not.toMatch(/GitHub App|Refresh access|github\.com\/new/);
    const unknown = githubAccessDeniedInstructions("mcp.github:create_repository");
    expect(unknown).toMatch(/authentication method/);
    expect(unknown).not.toMatch(/GitHub App|Refresh access/);
  });
});
