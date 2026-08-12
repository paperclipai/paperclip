import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { RepositoryConnection } from "@paperclipai/shared";
import type {
  GitHubAppTransport,
  GitHubInstallation,
  GitHubInstallationToken,
  GitHubRepository,
} from "../../services/repository-providers/github-provider.js";
import type { RepositoryProviderConnector } from "../../services/repository-providers/provider-contract.js";

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

export interface ConformanceSeedRepo {
  providerRepositoryId: string;
  owner: string;
  name: string;
}

export interface ProviderConformanceWorld {
  connector: RepositoryProviderConnector;
  companyId: string;
  userId: string;
  installationId: string;
  accountName: string;
  seed(repos: ConformanceSeedRepo[]): void;
  rename(providerRepositoryId: string, next: { owner: string; name: string }): void;
}

export type ConformanceWorldFactory = () => ProviderConformanceWorld;

function connectionFromMetadata(
  world: ProviderConformanceWorld,
  meta: {
    installationId: string;
    accountId: string | null;
    accountName: string | null;
    host: string;
    providerMetadata: Record<string, unknown> | null;
  },
): RepositoryConnection {
  const now = new Date();
  return {
    id: randomUUID(),
    companyId: world.companyId,
    provider: world.connector.provider,
    host: meta.host,
    installationId: meta.installationId,
    accountId: meta.accountId,
    accountName: meta.accountName,
    status: "active",
    syncStatus: "idle",
    syncCursor: null,
    syncError: null,
    lastSyncedAt: null,
    providerMetadata: meta.providerMetadata,
    disconnectedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Registers reusable conformance cases for any provider connector. */
export function runProviderConformance(makeWorld: ConformanceWorldFactory) {
  async function install(world: ProviderConformanceWorld): Promise<RepositoryConnection> {
    const begin = await world.connector.beginInstallation({ companyId: world.companyId, userId: world.userId });
    expect(begin.installUrl).toContain("state=");
    expect(begin.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const meta = await world.connector.completeInstallation({
      state: begin.state,
      installationId: world.installationId,
      companyId: world.companyId,
    });
    expect(meta.installationId).toBe(world.installationId);
    expect(meta.accountName).toBe(world.accountName);
    return connectionFromMetadata(world, meta);
  }

  it("completes installation with a valid signed state and rejects tampered/mismatched state", async () => {
    const world = makeWorld();
    world.seed([{ providerRepositoryId: "1", owner: "acme", name: "alpha" }]);
    const begin = await world.connector.beginInstallation({ companyId: world.companyId, userId: world.userId });

    await expect(world.connector.completeInstallation({
      state: `${begin.state}tampered`,
      installationId: world.installationId,
      companyId: world.companyId,
    })).rejects.toMatchObject({ status: 422 });

    await expect(world.connector.completeInstallation({
      state: begin.state,
      installationId: world.installationId,
      companyId: "00000000-0000-0000-0000-000000000000",
    })).rejects.toMatchObject({ status: expect.any(Number) });

    const meta = await world.connector.completeInstallation({
      state: begin.state,
      installationId: world.installationId,
      companyId: world.companyId,
    });
    expect(meta.companyId).toBe(world.companyId);
    expect(meta.userId).toBe(world.userId);
  });

  it("discovers repositories with pagination and search", async () => {
    const world = makeWorld();
    world.seed([
      { providerRepositoryId: "1", owner: "acme", name: "alpha" },
      { providerRepositoryId: "2", owner: "acme", name: "beta" },
      { providerRepositoryId: "3", owner: "acme", name: "gamma" },
    ]);
    const connection = await install(world);

    const page1 = await world.connector.discover({ connection, pageSize: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.total).toBe(3);

    const page2 = await world.connector.discover({ connection, pageSize: 2, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const allIds = [...page1.items, ...page2.items].map((repository) => repository.providerRepositoryId).sort();
    expect(allIds).toEqual(["1", "2", "3"]);

    const searched = await world.connector.discover({ connection, query: "beta", pageSize: 10 });
    expect(searched.items.map((repository) => repository.name)).toEqual(["beta"]);
  });

  it("maps discovery items to importable snapshots with stable provider ids", async () => {
    const world = makeWorld();
    world.seed([{ providerRepositoryId: "77", owner: "acme", name: "delta" }]);
    const connection = await install(world);
    const discovered = (await world.connector.discover({ connection, pageSize: 10 })).items;
    expect(discovered[0]).toMatchObject({ providerRepositoryId: "77", owner: "acme", name: "delta" });
    expect(discovered[0]!.cloneUrl).toContain("acme/delta");
  });

  it("refreshes metadata for a known repository and returns null for unknown ids", async () => {
    const world = makeWorld();
    world.seed([{ providerRepositoryId: "5", owner: "acme", name: "epsilon" }]);
    const connection = await install(world);
    const refreshed = await world.connector.refreshMetadata({ connection, providerRepositoryId: "5" });
    expect(refreshed).toMatchObject({ providerRepositoryId: "5" });
    expect(await world.connector.refreshMetadata({
      connection,
      providerRepositoryId: "does-not-exist",
    })).toBeNull();
  });

  it("converges idempotently across sync and reflects rename/transfer by stable id", async () => {
    const world = makeWorld();
    world.seed([
      { providerRepositoryId: "10", owner: "acme", name: "one" },
      { providerRepositoryId: "11", owner: "acme", name: "two" },
    ]);
    const connection = await install(world);

    const first = await world.connector.sync({ connection, cursor: null });
    expect(first.repositories.map((repository) => repository.providerRepositoryId).sort()).toEqual(["10", "11"]);

    const second = await world.connector.sync({ connection, cursor: null });
    expect(second.repositories.map((repository) => repository.providerRepositoryId).sort()).toEqual(["10", "11"]);

    world.rename("10", { owner: "acme-new", name: "one-renamed" });
    const afterRename = await world.connector.sync({ connection, cursor: null });
    const renamed = afterRename.repositories.find((repository) => repository.providerRepositoryId === "10");
    expect(renamed?.cloneUrl).toContain("acme-new/one-renamed");
  });

  it("resolves a short-lived clone credential without leaking secrets into the audit record", async () => {
    const world = makeWorld();
    world.seed([{ providerRepositoryId: "9", owner: "acme", name: "zeta" }]);
    const connection = await install(world);
    const result = await world.connector.resolveCloneCredential({
      connection,
      repository: {
        id: "repo-uuid",
        providerRepositoryId: "9",
        owner: "acme",
        name: "zeta",
        host: connection.host,
        cloneUrl: `https://${connection.host}/acme/zeta.git`,
      },
    });
    expect(result.token).toBeTruthy();
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.authenticatedCloneUrl).toContain(result.token);
    const auditJson = JSON.stringify(result.audit);
    expect(auditJson).not.toContain(result.token);
    expect(result.audit).toMatchObject({ repositoryId: "repo-uuid", connectionId: connection.id });
  });
}
