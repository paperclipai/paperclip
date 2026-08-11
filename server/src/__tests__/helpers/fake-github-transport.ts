import type {
  GitHubAppTransport,
  GitHubInstallation,
  GitHubInstallationToken,
  GitHubRepository,
} from "../../services/repository-providers/github-provider.js";

/**
 * Controllable in-memory GitHub App transport for provider tests. It stands in
 * for GitHub's HTTP API + App JWT/installation-token exchange so the GitHub.com
 * provider's own logic (state, discovery, pagination, snapshot mapping,
 * rename/transfer convergence, credential resolution) can be exercised without
 * a live GitHub. No real app private key is involved.
 */
export class FakeGitHubTransport implements GitHubAppTransport {
  readonly host = "github.com";
  readonly apiBaseUrl = "https://api.github.com";
  private readonly installations = new Map<string, GitHubInstallation>();
  private readonly repositories = new Map<string, GitHubRepository[]>();
  private tokenCounter = 0;
  private clock: () => Date;
  tokenTtlMs = 60 * 60 * 1000;
  /** Set to force token minting to fail (e.g. revoked installation). */
  failTokenMint: Error | null = null;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  setInstallation(installation: GitHubInstallation, repositories: GitHubRepository[]) {
    this.installations.set(String(installation.id), installation);
    this.repositories.set(String(installation.id), [...repositories]);
  }

  setRepositories(installationId: string, repositories: GitHubRepository[]) {
    this.repositories.set(installationId, [...repositories]);
  }

  rename(installationId: string, providerRepositoryId: string, next: { owner: string; name: string }) {
    const repos = this.repositories.get(installationId) ?? [];
    const repo = repos.find((r) => String(r.id) === providerRepositoryId);
    if (!repo) throw new Error(`fake github repo ${providerRepositoryId} not found`);
    repo.owner = { ...repo.owner, login: next.owner };
    repo.name = next.name;
    repo.full_name = `${next.owner}/${next.name}`;
    repo.clone_url = `https://github.com/${next.owner}/${next.name}.git`;
    repo.html_url = `https://github.com/${next.owner}/${next.name}`;
  }

  async getInstallation(installationId: string): Promise<GitHubInstallation | null> {
    return this.installations.get(installationId) ?? null;
  }

  async createInstallationAccessToken(installationId: string): Promise<GitHubInstallationToken> {
    if (this.failTokenMint) throw this.failTokenMint;
    if (!this.installations.has(installationId)) throw new Error("installation not found");
    this.tokenCounter += 1;
    return {
      token: `ghs_faketoken${this.tokenCounter}`,
      expiresAt: new Date(this.clock().getTime() + this.tokenTtlMs),
    };
  }

  async listRepositories(input: {
    installationId: string;
    page: number;
    perPage: number;
    query?: string | null;
  }): Promise<{ totalCount: number | null; items: GitHubRepository[] }> {
    const repos = this.repositories.get(input.installationId) ?? [];
    const query = input.query?.trim().toLowerCase();
    const matches = query
      ? repos.filter((r) => r.full_name.toLowerCase().includes(query))
      : repos;
    const start = (input.page - 1) * input.perPage;
    return {
      totalCount: matches.length,
      items: matches.slice(start, start + input.perPage),
    };
  }

  async getRepository(input: {
    installationId: string;
    providerRepositoryId: string;
  }): Promise<GitHubRepository | null> {
    const repos = this.repositories.get(input.installationId) ?? [];
    return repos.find((r) => String(r.id) === input.providerRepositoryId) ?? null;
  }
}

export function makeGitHubRepository(overrides: Partial<GitHubRepository> & { id: number | string; owner: string; name: string }): GitHubRepository {
  const owner = overrides.owner;
  const name = overrides.name;
  return {
    id: overrides.id,
    name,
    full_name: `${owner}/${name}`,
    owner: { login: owner, id: overrides.id, type: "Organization" },
    clone_url: `https://github.com/${owner}/${name}.git`,
    html_url: `https://github.com/${owner}/${name}`,
    default_branch: "main",
    private: true,
    visibility: "private",
    archived: false,
    fork: false,
    ...overrides,
  };
}
