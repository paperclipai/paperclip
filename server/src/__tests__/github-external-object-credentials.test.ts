import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  companyMemberships,
  companySecrets,
  connectionGrants,
  createDb,
  deliveryPolicies,
  deliveryRepositories,
  externalObjects,
  projects,
  toolApplications,
  toolConnections,
  userSecretDefinitions,
} from "@paperclipai/db";
import { canonicalizeExternalObjectUrl } from "@paperclipai/shared/external-objects-server";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createGitHubExternalObjectProvider } from "../services/github-external-object-provider.js";

/**
 * Secret values are vault-backed in production; these tests exercise only the seam between
 * the object resolver and the governed connection that owns the credential.
 */
const vault = vi.hoisted(() => {
  const legacyCompanies = new Set<string>();
  return {
    legacyCompanies,
    resolveUserSecretValue: vi.fn(async (_companyId: string, input: { definitionId: string }) => ({
      value: `ghp_${input.definitionId}`,
    })),
    resolveSecretValue: vi.fn(async () => "ghp_company_secret"),
    getByName: vi.fn(async (companyId: string, name: string) => (
      name === "GITHUB_TOKEN" && legacyCompanies.has(companyId) ? { id: `${companyId}:github-token` } : null
    )),
  };
});

vi.mock("../services/secrets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/secrets.js")>()),
  secretService: () => vault,
}));

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("GitHub external object credentials", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-external-object-credentials-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(deliveryPolicies);
    await db.delete(deliveryRepositories);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(companySecrets);
    await db.delete(userSecretDefinitions);
    await db.delete(companyMemberships);
    await db.delete(projects);
    await db.delete(companies);
    vault.legacyCompanies.clear();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const userId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 8).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "member",
    });
    return { companyId, userId };
  }

  /** A per-user GitHub connection, as an operator's personal connection is stored. */
  async function seedConnection(input: { companyId: string; userId: string; enabled?: boolean }) {
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const secretId = randomUUID();
    const definitionId = randomUUID();
    await db.insert(toolApplications).values({
      id: applicationId,
      companyId: input.companyId,
      name: applicationId,
      type: "mcp_http",
    });
    await db.insert(userSecretDefinitions).values({
      id: definitionId,
      companyId: input.companyId,
      key: definitionId,
      name: "Personal GitHub",
    });
    await db.insert(companySecrets).values({
      id: secretId,
      companyId: input.companyId,
      key: secretId,
      name: `Personal GitHub ${secretId.slice(0, 8)}`,
      scope: "user",
      ownerUserId: input.userId,
      userSecretDefinitionId: definitionId,
    });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId: input.companyId,
      applicationId,
      name: `GitHub ${connectionId.slice(0, 8)}`,
      uid: connectionId,
      transport: "rest_api",
      authKind: "api_key",
      credentialPolicy: "per_user",
      status: "active",
      enabled: input.enabled ?? true,
      config: { sourceTemplateKey: "github" },
      credentialRefs: [{
        name: "authorization",
        secretId,
        version: "latest",
        placement: "header",
        key: "authorization",
        prefix: "token ",
      }],
    });
    await db.insert(connectionGrants).values({
      id: randomUUID(),
      companyId: input.companyId,
      connectionId,
      kind: "user",
      subjectUserId: input.userId,
      status: "active",
      credentialSecretRefs: [{ secretId, configPath: "authorization", versionSelector: "latest" }],
    });
    return { connectionId, definitionId };
  }

  async function bindRepository(input: {
    companyId: string;
    owner?: string;
    name?: string;
    connectionId: string | null;
  }) {
    const [repository] = await db.insert(deliveryRepositories).values({
      companyId: input.companyId,
      host: "github.com",
      owner: input.owner ?? "acme",
      name: input.name ?? "app",
      connectionId: input.connectionId,
    }).returning();
    return repository!;
  }

  async function bindProjectPolicy(input: {
    companyId: string;
    repositoryId: string;
    connectionId: string;
  }) {
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: input.companyId, name: projectId });
    await db.insert(deliveryPolicies).values({
      companyId: input.companyId,
      projectId,
      repositoryId: input.repositoryId,
      githubConnectionId: input.connectionId,
    });
  }

  function pullRequestObject(owner: string, repo: string, number: number): typeof externalObjects.$inferSelect {
    const canonical = canonicalizeExternalObjectUrl(`https://github.com/${owner}/${repo}/pull/${number}`);
    if (!canonical) throw new Error("expected canonical url");
    return {
      id: randomUUID(),
      companyId: randomUUID(),
      providerKey: "github",
      pluginId: null,
      objectType: "pull_request",
      externalId: `${owner}/${repo}#pull/${number}`,
      sanitizedCanonicalUrl: canonical.sanitizedCanonicalUrl,
      canonicalIdentityHash: canonical.canonicalIdentityHash,
      displayKey: null,
      iconKey: null,
      displayTitle: null,
      statusKey: null,
      statusLabel: null,
      statusIconKey: null,
      statusCategory: "unknown",
      statusTone: "neutral",
      liveness: "unknown",
      isTerminal: false,
      data: {},
      remoteVersion: null,
      etag: null,
      lastResolvedAt: null,
      lastChangedAt: null,
      lastErrorAt: null,
      nextRefreshAt: null,
      refreshStartedAt: null,
      refreshToken: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  /** Records every GitHub request so a test can assert what credential, if any, was sent. */
  function followingFetch(handlers: Record<string, () => Response>) {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      const handler = handlers[url];
      if (!handler) throw new Error(`unexpected GitHub request: ${url}`);
      return handler();
    });
    return { requests, fetchImpl };
  }

  function pullRequestBody(title: string) {
    return () => new Response(JSON.stringify({ state: "open", draft: false, merged: false, title }), {
      status: 200,
      headers: { "content-type": "application/json", etag: '"pr-1"' },
    });
  }

  function resolvePullRequest(
    companyId: string,
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  ) {
    const resolver = createGitHubExternalObjectProvider(db, { fetch: fetchImpl }).resolvers
      .find((entry) => entry.objectType === "pull_request")!;
    return resolver.resolve({ companyId, object: pullRequestObject("Acme", "App", 42) });
  }

  const PULL_URL = "https://api.github.com/repos/Acme/App/pulls/42";
  const REPOSITORY_URL = "https://api.github.com/repos/Acme/App";

  it("reads a private repository through the connection its delivery policy binds", async () => {
    const company = await seedCompany();
    const connection = await seedConnection(company);
    const repository = await bindRepository({ companyId: company.companyId, connectionId: null });
    await bindProjectPolicy({
      companyId: company.companyId,
      repositoryId: repository.id,
      connectionId: connection.connectionId,
    });
    const { requests, fetchImpl } = followingFetch({ [PULL_URL]: pullRequestBody("Private repair") });

    const result = await resolvePullRequest(company.companyId, fetchImpl);

    expect(result).toMatchObject({ ok: true, snapshot: { statusKey: "open", isTerminal: false } });
    expect(requests).toEqual([{ url: PULL_URL, authorization: `token ghp_${connection.definitionId}` }]);
    expect(vault.resolveSecretValue).not.toHaveBeenCalled();
  });

  it("reads through the verified repository binding when no policy pins a connection", async () => {
    const company = await seedCompany();
    const connection = await seedConnection(company);
    await bindRepository({ companyId: company.companyId, connectionId: connection.connectionId });
    const { requests, fetchImpl } = followingFetch({ [PULL_URL]: pullRequestBody("Private repair") });

    const result = await resolvePullRequest(company.companyId, fetchImpl);

    expect(result).toMatchObject({ ok: true, snapshot: { statusKey: "open" } });
    expect(requests).toEqual([{ url: PULL_URL, authorization: `token ghp_${connection.definitionId}` }]);
  });

  it("prefers the policy connection over a repository row bound to an earlier one", async () => {
    const company = await seedCompany();
    const stale = await seedConnection(company);
    const live = await seedConnection(company);
    const repository = await bindRepository({ companyId: company.companyId, connectionId: stale.connectionId });
    await bindProjectPolicy({
      companyId: company.companyId,
      repositoryId: repository.id,
      connectionId: live.connectionId,
    });
    const { requests, fetchImpl } = followingFetch({ [PULL_URL]: pullRequestBody("Private repair") });

    const result = await resolvePullRequest(company.companyId, fetchImpl);

    expect(result).toMatchObject({ ok: true, snapshot: { statusKey: "open" } });
    expect(requests).toEqual([{ url: PULL_URL, authorization: `token ghp_${live.definitionId}` }]);
  });

  it("does not use a connection bound to another company or repository", async () => {
    const owner = await seedCompany();
    const ownerConnection = await seedConnection(owner);
    const ownerRepository = await bindRepository({ companyId: owner.companyId, connectionId: ownerConnection.connectionId });
    await bindProjectPolicy({
      companyId: owner.companyId,
      repositoryId: ownerRepository.id,
      connectionId: ownerConnection.connectionId,
    });

    const stranger = await seedCompany();
    const strangerConnection = await seedConnection(stranger);
    const strangerRepository = await bindRepository({
      companyId: stranger.companyId,
      name: "other",
      connectionId: strangerConnection.connectionId,
    });
    await bindProjectPolicy({
      companyId: stranger.companyId,
      repositoryId: strangerRepository.id,
      connectionId: strangerConnection.connectionId,
    });

    const { requests, fetchImpl } = followingFetch({
      [PULL_URL]: () => new Response("", { status: 404 }),
      [REPOSITORY_URL]: () => new Response("", { status: 404 }),
    });

    const result = await resolvePullRequest(stranger.companyId, fetchImpl);

    expect(requests.map((request) => request.authorization)).toEqual([null, null]);
    expect(result).toMatchObject({
      ok: false,
      liveness: "auth_required",
      errorCode: "github_repository_access_required",
    });
    expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
  });

  it("fails closed when several connections are bound to one repository", async () => {
    const company = await seedCompany();
    const first = await seedConnection(company);
    const second = await seedConnection(company);
    const repository = await bindRepository({ companyId: company.companyId, connectionId: first.connectionId });
    await bindProjectPolicy({ companyId: company.companyId, repositoryId: repository.id, connectionId: first.connectionId });
    await bindProjectPolicy({ companyId: company.companyId, repositoryId: repository.id, connectionId: second.connectionId });
    vault.legacyCompanies.add(company.companyId);

    const { requests, fetchImpl } = followingFetch({
      [PULL_URL]: () => new Response("", { status: 404 }),
      [REPOSITORY_URL]: () => new Response("", { status: 404 }),
    });

    const result = await resolvePullRequest(company.companyId, fetchImpl);

    expect(requests).toEqual([]);
    expect(result).toMatchObject({ ok: false, liveness: "auth_required", errorCode: "github_token_unavailable" });
  });

  it("does not authorize the read through a bound connection that is disabled", async () => {
    const company = await seedCompany();
    const connection = await seedConnection({ ...company, enabled: false });
    vault.legacyCompanies.add(company.companyId);
    const repository = await bindRepository({ companyId: company.companyId, connectionId: null });
    await bindProjectPolicy({
      companyId: company.companyId,
      repositoryId: repository.id,
      connectionId: connection.connectionId,
    });

    const { requests, fetchImpl } = followingFetch({
      [PULL_URL]: () => new Response("", { status: 404 }),
      [REPOSITORY_URL]: () => new Response("", { status: 404 }),
    });

    const result = await resolvePullRequest(company.companyId, fetchImpl);

    expect(requests).toEqual([]);
    expect(result).toMatchObject({ ok: false, liveness: "auth_required", errorCode: "github_token_unavailable" });
  });

  it("treats a private repository masked by a 404 as an access failure, not a missing object", async () => {
    const company = await seedCompany();
    const { requests, fetchImpl } = followingFetch({
      [PULL_URL]: () => new Response("", { status: 404, headers: { etag: '"masked"' } }),
      [REPOSITORY_URL]: () => new Response("", { status: 404 }),
    });

    const result = await resolvePullRequest(company.companyId, fetchImpl);

    expect(requests.map((request) => request.url)).toEqual([PULL_URL, REPOSITORY_URL]);
    expect(result).toMatchObject({
      ok: false,
      liveness: "auth_required",
      errorCode: "github_repository_access_required",
    });
  });

  it("reports a missing object only once the repository itself is readable", async () => {
    const company = await seedCompany();
    const { fetchImpl } = followingFetch({
      [PULL_URL]: () => new Response("", { status: 404, headers: { etag: '"missing"' } }),
      [REPOSITORY_URL]: () => new Response(JSON.stringify({ id: 1, full_name: "acme/app" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });

    const result = await resolvePullRequest(company.companyId, fetchImpl);

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        statusKey: "not_found",
        statusLabel: "Not found",
        statusCategory: "archived",
        isTerminal: true,
        ttlSeconds: 900,
      },
    });
  });

  it("falls back to a well-known company secret when no connection is bound", async () => {
    const company = await seedCompany();
    vault.legacyCompanies.add(company.companyId);
    const { requests, fetchImpl } = followingFetch({ [PULL_URL]: pullRequestBody("Legacy token") });

    const result = await resolvePullRequest(company.companyId, fetchImpl);

    expect(result).toMatchObject({ ok: true, snapshot: { statusKey: "open" } });
    expect(requests).toEqual([{ url: PULL_URL, authorization: "Bearer ghp_company_secret" }]);
  });
});
