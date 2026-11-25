/** Recognize Azure DevOps hosts before deciding whether ambient Git auth is allowed. */
export function isAzureDevOpsRemote(remote: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(remote).hostname.toLowerCase();
  } catch {
    hostname = "";
  }
  if (!hostname) {
    const scp = /^(?:[^@/:\s]+@)?([^/:\s]+):[^\s]+$/.exec(remote);
    if (!scp) return false;
    hostname = scp[1]!.toLowerCase();
  }
  hostname = hostname.replace(/\.+$/, "");
  return hostname === "dev.azure.com" || hostname === "ssh.dev.azure.com" ||
    hostname === "visualstudio.com" || hostname.endsWith(".visualstudio.com");
}

/** Optional anonymous fallback is never sufficient for Azure DevOps repositories. */
export function withAnonymousGitFallback<T extends { configArgs: string[]; env: Record<string, string>; repositoryAuthority?: { provider: string; url: string } }>(
  provider: (remoteUrl: string) => Promise<T | null>,
): (remoteUrl: string) => Promise<T | null> {
  return async (remoteUrl) => {
    let authorization;
    try { authorization = await provider(remoteUrl); }
    catch {
      if (isAzureDevOpsRemote(remoteUrl)) throw new Error("Azure DevOps connection authorization is unavailable");
      return null;
    }
    if (isAzureDevOpsRemote(remoteUrl)) {
      let expected: string;
      try { expected = new URL(remoteUrl).href.replace(/\/$/, ""); } catch { throw new Error("Azure DevOps connection authorization is unavailable"); }
      if (authorization?.repositoryAuthority?.provider !== "azure-devops" || authorization.repositoryAuthority.url !== expected)
        throw new Error("Azure DevOps connection authorization is unavailable");
    }
    return authorization;
  };
}
