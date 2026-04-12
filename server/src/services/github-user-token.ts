let storedToken: { accessToken: string; scope: string; connectedAt: string } | null = null;

export function setGitHubUserToken(accessToken: string, scope: string): void {
  storedToken = { accessToken, scope, connectedAt: new Date().toISOString() };
}

export function getGitHubUserToken(): string | null {
  return storedToken?.accessToken ?? null;
}

export function clearGitHubUserToken(): void {
  storedToken = null;
}

export function isGitHubUserConnected(): boolean {
  return storedToken !== null;
}

export function getGitHubUserTokenInfo(): { connected: boolean; scope?: string } {
  if (!storedToken) return { connected: false };
  return { connected: true, scope: storedToken.scope };
}
