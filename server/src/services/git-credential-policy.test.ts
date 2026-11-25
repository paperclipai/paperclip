import { describe, expect, it } from "vitest";
import { isAzureDevOpsRemote, withAnonymousGitFallback } from "./git-credential-policy.js";
import { azureDevOpsGitInvocation } from "./connectors/azure-devops/git-auth.js";

describe("Azure DevOps remote classification", () => {
  it("recognizes cloud HTTPS, legacy HTTPS and SSH addresses regardless of credentials", () => {
    for (const value of ["https://dev.azure.com/org/project/_git/repo", "https://dev.azure.com./org/project/_git/repo", "https://token@dev.azure.com/org/project/_git/repo", "https://org.visualstudio.com/project/_git/repo", "git@ssh.dev.azure.com:v3/org/project/repo", "git@ssh.dev.azure.com.:v3/org/project/repo", "ssh.dev.azure.com:v3/org/project/repo", "ssh://git@ssh.dev.azure.com/v3/org/project/repo", "git@vs-ssh.visualstudio.com:v3/org/project/repo"]) {
      expect(isAzureDevOpsRemote(value), value).toBe(true);
    }
  });
  it("does not classify other or deceptive hosts as Azure DevOps", () => {
    for (const value of ["https://github.com/org/repo", "https://dev.azure.com.attacker.test/org/repo", "https://notvisualstudio.com/org/repo", "/tmp/checkout", "not a url"]) {
      expect(isAzureDevOpsRemote(value), value).toBe(false);
    }
  });
});

describe("repository credential fallback", () => {
  it("does not allow Azure DevOps to fall back to ambient Git credentials", async () => {
    const azure = "https://dev.azure.com/org/project/_git/repo";
    await expect(withAnonymousGitFallback(async () => null)(azure)).rejects.toThrow(/Azure DevOps/);
    await expect(withAnonymousGitFallback(async () => { throw new Error("unavailable"); })(azure)).rejects.toThrow(/Azure DevOps/);
    const unrelated = { configArgs: [], env: {}, source: "managed_connection" as const, secretName: null };
    await expect(withAnonymousGitFallback(async () => unrelated)(azure)).rejects.toThrow(/Azure DevOps/);
    const authorized = azureDevOpsGitInvocation(azure, { kind: "pat", token: "fixture" });
    await expect(withAnonymousGitFallback(async () => authorized)(azure)).resolves.toBe(authorized);
    await expect(withAnonymousGitFallback(async () => authorized)("https://dev.azure.com/other/project/_git/repo")).rejects.toThrow(/Azure DevOps/);
    await expect(withAnonymousGitFallback(async () => { throw new Error("unavailable"); })("https://github.com/org/repo")).resolves.toBeNull();
  });
});
