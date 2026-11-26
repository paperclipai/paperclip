import { describe, expect, it } from "vitest";
import {
  findUnreachableManagedGitHubTarget,
  githubAccessDeniedInstructions,
  githubAccessError,
  githubAccessErrorInstructions,
  projectGitHubActionResult,
} from "./github-access-errors.js";

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
      expect(text).toMatch(/until GitHub access is repaired/);
      expect(text).toContain("https://github.com/new");
      expect(text).toContain("Refresh access");
      expect(text).toContain("Add More Repos on GitHub");
      expect(text).toMatch(/personal account/i);
      expect(text).toMatch(/organization argument/i);
      expect(text).toMatch(/does not.*personal account/i);
      expect(text).not.toMatch(/replace.*token|Administration|classic token/i);
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

  it("classifies 403 denials on external orgs outside managed GitHub App installations separately from installed-org denials", () => {
    const githubGrant = {
      login: "octocat",
      installationOwnerLogins: ["acme"],
      repositories: [{ id: "10", fullName: "acme/app", installationId: "9" }],
    };
    expect(githubAccessError(
      "github",
      "POST https://api.github.com/repos/external-org/public-repo/issues: 403 Resource not accessible by integration []",
      {
        connectionMethodKey: "managed",
        githubGrant,
        toolName: "mcp.github:create_issue",
        parameters: { owner: "external-org", repo: "public-repo", title: "Bug" },
      },
    )).toEqual({ errorCode: "github_repo_outside_app_installations" });

    // Accessible org missing a specific repo selection remains github_access_denied.
    expect(githubAccessError(
      "github",
      "POST https://api.github.com/repos/acme/unselected-repo/issues: 403 Resource not accessible by integration []",
      {
        connectionMethodKey: "managed",
        githubGrant,
        toolName: "mcp.github:create_issue",
        parameters: { owner: "acme", repo: "unselected-repo", title: "Bug" },
      },
    )).toEqual({ errorCode: "github_access_denied" });

    // User's own personal account remains repairable via Manage GitHub access.
    expect(githubAccessError(
      "github",
      "POST https://api.github.com/repos/octocat/personal-repo/issues: 403 Resource not accessible by integration []",
      {
        connectionMethodKey: "managed",
        githubGrant,
        toolName: "mcp.github:create_issue",
        parameters: { owner: "octocat", repo: "personal-repo", title: "Bug" },
      },
    )).toEqual({ errorCode: "github_access_denied" });

    // PAT connections and missing snapshots keep github_access_denied.
    expect(githubAccessError(
      "github",
      "POST https://api.github.com/repos/external-org/public-repo/issues: 403 Resource not accessible by personal access token []",
      {
        connectionMethodKey: "mcp-key",
        githubGrant,
        toolName: "mcp.github:create_issue",
        parameters: { owner: "external-org", repo: "public-repo", title: "Bug" },
      },
    )).toEqual({ errorCode: "github_access_denied" });
    expect(githubAccessError(
      "github",
      "POST https://api.github.com/repos/external-org/public-repo/issues: 403 Resource not accessible by integration []",
      {
        connectionMethodKey: "managed",
        githubGrant: null,
        toolName: "mcp.github:create_issue",
        parameters: { owner: "external-org", repo: "public-repo", title: "Bug" },
      },
    )).toEqual({ errorCode: "github_access_denied" });
  });

  it("pre-checks managed GitHub writes against installed accounts without blocking installed orgs, personal accounts, or upstream fork sources", () => {
    const githubGrant = {
      login: "octocat",
      installationOwnerLogins: ["Acme"],
    };
    const unreachable = findUnreachableManagedGitHubTarget({
      sourceTemplateKey: "github",
      connectionMethodKey: "managed",
      githubGrant,
      toolName: "mcp.github:add_issue_comment",
      parameters: { owner: "vercel", repo: "next.js", issue_number: 1, body: "hi" },
    });
    expect(unreachable).toMatchObject({ owner: "vercel", repo: "next.js" });
    expect(unreachable?.message).toContain("vercel/next.js");
    expect(unreachable?.message).toMatch(/not installed/i);
    expect(unreachable?.message).not.toMatch(/select Refresh access|Add More Repos on GitHub/i);

    // repository: "owner/repo" format is also detected.
    expect(findUnreachableManagedGitHubTarget({
      sourceTemplateKey: "github",
      connectionMethodKey: "managed",
      githubGrant,
      toolName: "mcp.github:create_issue",
      parameters: { repository: "external-org/public-repo", title: "Bug" },
    })).toMatchObject({ owner: "external-org", repo: "public-repo" });

    // Installed org (case-insensitive) and user's own personal account are allowed.
    expect(findUnreachableManagedGitHubTarget({
      sourceTemplateKey: "github",
      connectionMethodKey: "managed",
      githubGrant,
      toolName: "mcp.github:create_issue",
      parameters: { owner: "acme", repo: "other-repo", title: "Bug" },
    })).toBeNull();
    expect(findUnreachableManagedGitHubTarget({
      sourceTemplateKey: "github",
      connectionMethodKey: "managed",
      githubGrant,
      toolName: "mcp.github:create_issue",
      parameters: { owner: "OctoCat", repo: "my-repo", title: "Bug" },
    })).toBeNull();

    // fork_repository reads from owner/repo and writes to organization (or personal account).
    expect(findUnreachableManagedGitHubTarget({
      sourceTemplateKey: "github",
      connectionMethodKey: "managed",
      githubGrant,
      toolName: "mcp.github:fork_repository",
      parameters: { owner: "vercel", repo: "next.js", organization: "acme" },
    })).toBeNull();
    expect(findUnreachableManagedGitHubTarget({
      sourceTemplateKey: "github",
      connectionMethodKey: "managed",
      githubGrant,
      toolName: "mcp.github:fork_repository",
      parameters: { owner: "vercel", repo: "next.js", organization: "other-org" },
    })).toMatchObject({ owner: "other-org" });

    // PAT connections and missing snapshots are not pre-blocked.
    expect(findUnreachableManagedGitHubTarget({
      sourceTemplateKey: "github",
      connectionMethodKey: "mcp-key",
      githubGrant,
      toolName: "mcp.github:create_issue",
      parameters: { owner: "vercel", repo: "next.js" },
    })).toBeNull();
    expect(findUnreachableManagedGitHubTarget({
      sourceTemplateKey: "github",
      connectionMethodKey: "managed",
      githubGrant: { login: "octocat", installationOwnerLogins: [] },
      toolName: "mcp.github:create_issue",
      parameters: { owner: "vercel", repo: "next.js" },
    })).toBeNull();
  });

  it("gives accurate non-refresh instructions for github_repo_outside_app_installations", () => {
    const text = githubAccessErrorInstructions(
      "github_repo_outside_app_installations",
      "mcp.github:create_issue",
      "managed",
      { owner: "external-org", repo: "public-repo" },
    );
    expect(text).toMatch(/Do not retry/);
    expect(text).toMatch(/not installed/i);
    expect(text).toMatch(/directly on GitHub|personal access token/i);
    expect(text).toMatch(/install the Paperclip GitHub App.*refresh access.*retry/i);
    expect(text).not.toMatch(/select Refresh access|Add More Repos on GitHub/i);
  });

  it("preserves suspended installations as repairable access with unsuspend guidance instead of install advice", () => {
    const githubGrant = {
      login: "octocat",
      installationIds: ["102"],
      installationOwnerLogins: ["octocat"],
      suspendedInstallationOwnerLogins: ["paperclipai"],
      repositories: [{ id: "2", fullName: "octocat/b", installationId: "102" }],
    };
    // Pre-check must NOT classify a suspended owner as outside installations.
    expect(findUnreachableManagedGitHubTarget({
      sourceTemplateKey: "github",
      connectionMethodKey: "managed",
      githubGrant,
      toolName: "mcp.github:create_issue",
      parameters: { owner: "paperclipai", repo: "a", title: "Bug" },
    })).toBeNull();
    // Runtime 403 on suspended owner classifies as github_app_installation_suspended (not outside installations).
    expect(githubAccessError(
      "github",
      "POST https://api.github.com/repos/paperclipai/a/issues: 403 Resource not accessible by integration []",
      {
        connectionMethodKey: "managed",
        githubGrant,
        toolName: "mcp.github:create_issue",
        parameters: { owner: "paperclipai", repo: "a", title: "Bug" },
      },
    )).toEqual({ errorCode: "github_app_installation_suspended" });
    // Unsuspend guidance points operators to unsuspend and then Refresh access (with or without explicit owner).
    const guidance = githubAccessErrorInstructions(
      "github_app_installation_suspended",
      "mcp.github:create_issue",
      "managed",
      null,
      undefined,
      { suspendedOwner: "paperclipai" },
    );
    expect(guidance).toMatch(/suspended/i);
    expect(guidance).toMatch(/unsuspend/i);
    expect(guidance).toContain("paperclipai");
    expect(guidance).toContain("Refresh access");
    const genericSuspendedGuidance = githubAccessErrorInstructions(
      "github_app_installation_suspended",
      "mcp.github:create_issue",
      "managed",
    );
    expect(genericSuspendedGuidance).toMatch(/suspended/i);
    expect(genericSuspendedGuidance).toMatch(/unsuspend/i);
    expect(genericSuspendedGuidance).toContain("Refresh access");
  });

  it("handles create_repository omitted organization and falls back to github_access_denied on webhook-invalidated snapshots", () => {
    const singleOrg = { login: "octocat", installationOwnerLogins: ["acme"] };
    const multiOrg = { login: "octocat", installationOwnerLogins: ["acme", "globex"] };
    // Omitted organization (personal fallback) and injected single-org default both stay reachable.
    expect(findUnreachableManagedGitHubTarget({
      sourceTemplateKey: "github",
      connectionMethodKey: "managed",
      githubGrant: singleOrg,
      toolName: "mcp.github:create_repository",
      parameters: { name: "site", organization: "acme" },
    })).toBeNull();
    expect(findUnreachableManagedGitHubTarget({
      sourceTemplateKey: "github",
      connectionMethodKey: "managed",
      githubGrant: multiOrg,
      toolName: "mcp.github:create_repository",
      parameters: { name: "site" },
    })).toBeNull();
    expect(findUnreachableManagedGitHubTarget({
      sourceTemplateKey: "github",
      connectionMethodKey: "managed",
      githubGrant: singleOrg,
      toolName: "mcp.github:create_repository",
      parameters: { name: "site", organization: "external-org" },
    })).toMatchObject({ owner: "external-org" });

    // Webhook-invalidated snapshot (bindingSync present / repositories cleared) skips pre-check
    // AND keeps runtime 403 as github_access_denied so newly installed orgs get Refresh access guidance.
    const webhookSnapshot = {
      login: "octocat",
      installationIds: ["9", "11"],
      installationOwnerLogins: ["acme"],
      repositories: undefined,
      bindingSync: { id: "sync-1", removeInstallationIds: [] },
    };
    expect(findUnreachableManagedGitHubTarget({
      sourceTemplateKey: "github",
      connectionMethodKey: "managed",
      githubGrant: webhookSnapshot,
      toolName: "mcp.github:create_issue",
      parameters: { owner: "newly-installed-org", repo: "public-repo" },
    })).toBeNull();
    expect(githubAccessError(
      "github",
      "POST https://api.github.com/repos/newly-installed-org/public-repo/issues: 403 Resource not accessible by integration []",
      {
        connectionMethodKey: "managed",
        githubGrant: webhookSnapshot,
        toolName: "mcp.github:create_issue",
        parameters: { owner: "newly-installed-org", repo: "public-repo" },
      },
    )).toEqual({ errorCode: "github_access_denied" });
  });
});
