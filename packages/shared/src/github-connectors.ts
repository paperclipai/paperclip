export const GITHUB_CONNECTOR_PROFILE_IDS = ["github.code"] as const;

export type GitHubConnectorProfileId = (typeof GITHUB_CONNECTOR_PROFILE_IDS)[number];

export const GITHUB_CONNECTOR_PROFILES: Readonly<Record<GitHubConnectorProfileId, {
  appSlug: "github";
  serverUrl: string;
  scopes: readonly string[];
  writeTools: readonly string[];
}>> = {
  "github.code": {
    appSlug: "github",
    serverUrl: "https://api.githubcopilot.com/mcp/",
    // GitHub App permissions are configured on the App registration. GitHub
    // returns an empty OAuth scope string for user-to-server tokens.
    scopes: [],
    writeTools: [],
  },
};

export function isGitHubConnectorProfileId(value: string): value is GitHubConnectorProfileId {
  return Object.prototype.hasOwnProperty.call(GITHUB_CONNECTOR_PROFILES, value);
}
