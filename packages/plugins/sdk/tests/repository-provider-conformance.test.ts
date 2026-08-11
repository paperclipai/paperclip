import { createHmac, timingSafeEqual } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  PluginRepositoryProviderBeginInstallationParams,
  PluginRepositoryProviderCompleteInstallationParams,
  PluginRepositoryProviderDiscoverParams,
  PluginRepositoryProviderRefreshMetadataParams,
  PluginRepositoryProviderResolveCloneCredentialParams,
  PluginRepositoryProviderSyncParams,
} from "../src/protocol.js";
import {
  repositoryProviderConformanceChecks,
  runRepositoryProviderConformance,
  type RepositoryProviderConformanceHandlers,
  type RepositoryProviderConformanceWorld,
} from "../src/repository-provider-conformance.js";

/**
 * Reference extension used to prove the harness accepts a correct provider and
 * rejects the specific ways one can be wrong. An EE package implements the same
 * hooks against a real API; this fake keeps the contract executable in the SDK.
 */
const HOST = "github.acme-corp.example";
const PROVIDER = "github-enterprise";
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const INSTALLATION_ID = "install-1";
const STATE_SECRET = "conformance-state-secret";

interface FakeRepo {
  providerRepositoryId: string;
  owner: string;
  name: string;
}

function signState(payload: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", STATE_SECRET).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verifyState(state: string) {
  const [body, mac] = state.split(".");
  if (!body || !mac) throw new Error("invalid state");
  const expected = createHmac("sha256", STATE_SECRET).update(body).digest("base64url");
  const provided = Buffer.from(mac);
  const computed = Buffer.from(expected);
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    throw new Error("invalid state signature");
  }
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
    companyId: string;
    userId: string;
    exp: number;
  };
  if (payload.exp <= Date.now()) throw new Error("state expired");
  return payload;
}

function createFakeWorld(
  overrides: Partial<RepositoryProviderConformanceHandlers> = {},
): RepositoryProviderConformanceWorld {
  let repos: FakeRepo[] = [];
  let tokenCounter = 0;

  const cloneUrl = (repo: FakeRepo) => `https://${HOST}/${repo.owner}/${repo.name}.git`;

  function assertScope(params: { companyId: string; connection?: { companyId: string } }) {
    if (params.connection && params.connection.companyId !== params.companyId) {
      throw new Error("connection belongs to another company");
    }
  }

  const handlers: RepositoryProviderConformanceHandlers = {
    async onRepositoryProviderBeginInstallation(params: PluginRepositoryProviderBeginInstallationParams) {
      const expiresAt = new Date(Date.now() + 10 * 60_000);
      const state = signState({
        companyId: params.companyId,
        userId: params.userId,
        exp: expiresAt.getTime(),
      });
      return {
        installUrl: `https://${HOST}/github-apps/acme/installations/new?state=${encodeURIComponent(state)}`,
        state,
        expiresAt: expiresAt.toISOString(),
      };
    },

    async onRepositoryProviderCompleteInstallation(params: PluginRepositoryProviderCompleteInstallationParams) {
      const payload = verifyState(params.state);
      if (payload.companyId !== params.companyId) throw new Error("state company mismatch");
      return {
        companyId: payload.companyId,
        userId: payload.userId,
        installationId: params.installationId,
        accountId: "account-1",
        accountName: "acme",
        host: HOST,
        providerMetadata: { account_login: "acme" },
      };
    },

    async onRepositoryProviderDiscover(params: PluginRepositoryProviderDiscoverParams) {
      assertScope(params);
      const pageSize = params.pageSize ?? 2;
      const page = params.cursor ? Number.parseInt(params.cursor, 10) : 1;
      if (!Number.isFinite(page) || page < 1) throw new Error("invalid cursor");
      const query = params.query?.trim().toLowerCase();
      const matches = repos.filter((repo) => !query || `${repo.owner}/${repo.name}`.toLowerCase().includes(query));
      const start = (page - 1) * pageSize;
      const slice = matches.slice(start, start + pageSize);
      return {
        items: slice.map((repo) => ({
          providerRepositoryId: repo.providerRepositoryId,
          owner: repo.owner,
          name: repo.name,
          cloneUrl: cloneUrl(repo),
          webUrl: `https://${HOST}/${repo.owner}/${repo.name}`,
          defaultBranch: "main",
          visibility: "private",
          archived: false,
          metadata: { owner: repo.owner },
        })),
        nextCursor: start + pageSize < matches.length ? String(page + 1) : null,
        total: matches.length,
      };
    },

    async onRepositoryProviderRefreshMetadata(params: PluginRepositoryProviderRefreshMetadataParams) {
      assertScope(params);
      const repo = repos.find((entry) => entry.providerRepositoryId === params.providerRepositoryId);
      return {
        repository: repo
          ? {
            providerRepositoryId: repo.providerRepositoryId,
            cloneUrl: cloneUrl(repo),
            defaultBranch: "main",
            visibility: "private",
            state: "active",
            providerMetadata: { owner: repo.owner, name: repo.name },
          }
          : null,
      };
    },

    async onRepositoryProviderSync(params: PluginRepositoryProviderSyncParams) {
      assertScope(params);
      return {
        repositories: repos.map((repo) => ({
          providerRepositoryId: repo.providerRepositoryId,
          cloneUrl: cloneUrl(repo),
          defaultBranch: "main",
          visibility: "private",
          state: "active",
        })),
        cursor: null,
      };
    },

    async onRepositoryProviderResolveCloneCredential(
      params: PluginRepositoryProviderResolveCloneCredentialParams,
    ) {
      assertScope(params);
      tokenCounter += 1;
      const token = `ghs_conformance_${tokenCounter}`;
      return {
        username: "x-access-token",
        token,
        authenticatedCloneUrl:
          `https://x-access-token:${token}@${params.repository.host}/${params.repository.owner}/${params.repository.name}.git`,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        audit: { installationId: params.connection.installationId },
      };
    },
  };

  return {
    handlers: { ...handlers, ...overrides },
    providerKey: PROVIDER,
    host: HOST,
    companyId: COMPANY_ID,
    userId: USER_ID,
    installationId: INSTALLATION_ID,
    accountName: "acme",
    seed(next) {
      repos = next.map((repo) => ({ ...repo }));
    },
    rename(providerRepositoryId, next) {
      const repo = repos.find((entry) => entry.providerRepositoryId === providerRepositoryId);
      if (!repo) throw new Error(`unknown repository ${providerRepositoryId}`);
      repo.owner = next.owner;
      repo.name = next.name;
    },
  };
}

describe("repository provider conformance harness", () => {
  for (const check of repositoryProviderConformanceChecks(() => createFakeWorld())) {
    it(check.name, check.run);
  }

  it("fails a provider that accepts tampered installation state", async () => {
    const failures = await runRepositoryProviderConformance(() => createFakeWorld({
      async onRepositoryProviderCompleteInstallation(params) {
        // Trusts whatever the callback echoed back — the classic forged-state bug.
        return {
          companyId: params.companyId,
          userId: USER_ID,
          installationId: params.installationId,
          accountId: "account-1",
          accountName: "acme",
          host: HOST,
          providerMetadata: null,
        };
      },
    }));
    expect(failures.map((failure) => failure.name)).toContain(
      "rejects tampered and cross-company installation state",
    );
  });

  it("fails a provider that leaks its credential into the audit trail", async () => {
    const failures = await runRepositoryProviderConformance(() => createFakeWorld({
      async onRepositoryProviderResolveCloneCredential(params) {
        const token = "ghs_leaked_token";
        return {
          username: "x-access-token",
          token,
          authenticatedCloneUrl: `https://x-access-token:${token}@${params.repository.host}/a/b.git`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          audit: { installationId: token },
        };
      },
    }));
    expect(failures.map((failure) => failure.name)).toContain(
      "resolves a short-lived clone credential with a secret-free audit trail",
    );
  });

  it("fails a provider that serves a connection from another company", async () => {
    const failures = await runRepositoryProviderConformance(() => createFakeWorld({
      async onRepositoryProviderDiscover() {
        return { items: [], nextCursor: null, total: 0 };
      },
    }));
    expect(failures.map((failure) => failure.name)).toContain(
      "rejects calls for a connection belonging to another company",
    );
  });

  it("passes cleanly for the reference implementation", async () => {
    const failures = await runRepositoryProviderConformance(() => createFakeWorld());
    expect(failures).toEqual([]);
  });
});
