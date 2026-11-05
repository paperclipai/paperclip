import { describe, expect, it } from "vitest";
import {
  classifyProviderToolFailure,
  describeGitHubAppPermissionDenial,
  GITHUB_APP_PERMISSION_DENIED_REASON,
} from "./github-permission-errors.js";

const createRepo403 =
  "failed to create repository: POST https://api.github.com/user/repos: 403 Resource not accessible by integration []";

describe("GitHub App permission errors", () => {
  it("explains a repository-create refusal with next steps and keeps GitHub's text", () => {
    for (const upstreamToolName of ["create_repository", "create-repository"]) {
      const message = describeGitHubAppPermissionDenial({ message: createRepo403, upstreamToolName });
      expect(message).toMatch(/not allowed to create repositories/);
      expect(message).toContain("https://github.com/new");
      expect(message).toContain("Refresh access");
      expect(message).toContain(createRepo403);
    }
  });

  it("gives generic guidance for other GitHub App permission refusals", () => {
    const raw = "failed to create issue: POST https://api.github.com/repos/o/r/issues: 403 Resource not accessible by integration []";
    const message = describeGitHubAppPermissionDenial({ message: raw, upstreamToolName: "create_issue" });
    expect(message).toMatch(/does not have the GitHub permission it needs/);
    expect(message).not.toMatch(/create repositories/);
    expect(message).toContain(raw);
  });

  it("leaves unrelated provider errors unchanged", () => {
    for (const raw of [
      "failed to get repository info: GET https://api.github.com/repos/o/r: 404 Not Found []",
      "Validation Failed",
      "403 Forbidden",
    ]) {
      expect(classifyProviderToolFailure({ message: raw, reasonCode: "tool_error", upstreamToolName: "create_repository" }))
        .toEqual({ message: raw, reasonCode: "tool_error" });
    }
    expect(classifyProviderToolFailure({ message: createRepo403, reasonCode: "tool_execution_failed", upstreamToolName: "create_repository" }).reasonCode)
      .toBe(GITHUB_APP_PERMISSION_DENIED_REASON);
  });
});
