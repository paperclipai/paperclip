import { describe, expect, it, vi } from "vitest";
import type { GitAuthInvocation, GitRemoteAuthProvider } from "./git-credentials.js";
import { assertProjectGitConnection } from "./project-git-connection-policy.js";

const managedGitHubAuth = (token = "synthetic-github-token"): GitAuthInvocation => ({
  configArgs: [],
  env: { PAPERCLIP_GIT_TOKEN: token },
  source: "managed_connection",
  secretName: null,
});

const managedAzureAuth = (url: string): GitAuthInvocation => ({
  configArgs: [],
  env: {},
  source: "managed_connection",
  secretName: null,
  repositoryAuthority: { provider: "azure-devops", url },
});

describe("project Git connection policy", () => {
  it.each([
    "https://github.com/org/repo.git",
    "https://www.github.com/org/repo.git",
    "ssh://git@github.com/org/repo.git",
    "git@github.com:org/repo.git",
    "git@www.github.com:org/repo.git",
  ])("requires managed authorization for supported GitHub remote %s", async (repoUrl) => {
    const auth = managedGitHubAuth();
    const resolve = vi.fn<GitRemoteAuthProvider>().mockResolvedValue(auth);
    await expect(assertProjectGitConnection(repoUrl, resolve)).resolves.toBe(auth);
    expect(resolve).toHaveBeenCalledWith(repoUrl);
  });

  it.each([
    ["missing authorization", null],
    ["legacy company secret", { ...managedGitHubAuth(), source: "company_secret" as const }],
    ["server environment token", { ...managedGitHubAuth(), source: "server_env" as const }],
    ["missing token", { ...managedGitHubAuth(), env: {} }],
    ["empty token", { ...managedGitHubAuth(), env: { PAPERCLIP_GIT_TOKEN: "" } }],
  ])("rejects GitHub authorization with %s", async (_label, auth) => {
    await expect(assertProjectGitConnection("https://github.com/org/repo.git", async () => auth))
      .rejects.toThrow(/GitHub connection authorization is unavailable/);
  });

  it("does not expose a resolver failure or token in GitHub authorization errors", async () => {
    const secret = "do-not-leak-this-token";
    let error: unknown;
    try {
      await assertProjectGitConnection("git@github.com:org/repo.git", async () => {
        throw new Error(`resolver failed with ${secret}`);
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).toMatch(/GitHub connection authorization is unavailable/);
  });

  it("requires authorization bound to the exact Azure HTTPS repository", async () => {
    const repoUrl = "https://dev.azure.com/org/project/_git/repo";
    const expectedAuthority = new URL(repoUrl).href.replace(/\/$/, "");
    const auth = managedAzureAuth(expectedAuthority);
    await expect(assertProjectGitConnection(repoUrl, async () => auth)).resolves.toBe(auth);
  });

  it("rejects missing, failing, or differently bound Azure authorization without leaking errors", async () => {
    const repoUrl = "https://dev.azure.com/org/project/_git/repo";
    const secret = "azure-secret-token";
    const unavailable = /Azure DevOps connection authorization is unavailable/;
    await expect(assertProjectGitConnection(repoUrl, async () => null)).rejects.toThrow(unavailable);
    await expect(assertProjectGitConnection("git@ssh.dev.azure.com:v3/org/project/repo", async () => null))
      .rejects.toThrow(unavailable);
    await expect(assertProjectGitConnection(repoUrl, async () => { throw new Error(`failed ${secret}`); }))
      .rejects.toThrow(unavailable);
    await expect(assertProjectGitConnection(repoUrl, async () => managedAzureAuth("https://dev.azure.com/org/other/_git/repo")))
      .rejects.toThrow(unavailable);
    try {
      await assertProjectGitConnection(repoUrl, async () => { throw new Error(`failed ${secret}`); });
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it.each([
    "https://gitlab.com/org/repo.git",
    "https://github.example.com/org/repo.git",
    "/workspace/local-repository",
  ])("bypasses authorization resolution for other providers and local paths (%s)", async (repoUrl) => {
    const resolve = vi.fn<GitRemoteAuthProvider>();
    await expect(assertProjectGitConnection(repoUrl, resolve)).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
});
