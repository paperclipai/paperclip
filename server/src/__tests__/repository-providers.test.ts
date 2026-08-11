import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createGitHubProvider,
  FakeRepositoryProvider,
  signConnectionState,
  verifyConnectionState,
} from "../services/repository-providers/index.js";
import {
  FakeGitHubTransport,
  makeGitHubRepository,
} from "./helpers/fake-github-transport.js";
import {
  runProviderConformance,
  type ProviderConformanceWorld,
} from "./helpers/repository-provider-conformance.js";

describe("connection state signing", () => {
  const secret = "state-secret";
  const base = {
    companyId: randomUUID(),
    userId: randomUUID(),
    provider: "github",
    secret,
    ttlMs: 1000,
    nonce: "nonce-1",
  };

  it("round-trips a signed state and binds company/user", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const { state } = signConnectionState({ ...base, now });
    const payload = verifyConnectionState({ state, provider: "github", secret, now });
    expect(payload.companyId).toBe(base.companyId);
    expect(payload.userId).toBe(base.userId);
  });

  it("rejects expired state", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const { state } = signConnectionState({ ...base, ttlMs: 1000, now });
    expect(() => verifyConnectionState({
      state,
      provider: "github",
      secret,
      now: new Date(now.getTime() + 2000),
    })).toThrow(/expired/i);
  });

  it("rejects a tampered signature and wrong provider/secret", () => {
    const { state } = signConnectionState({ ...base });
    expect(() => verifyConnectionState({ state: `${state}x`, provider: "github", secret })).toThrow(/signature/i);
    expect(() => verifyConnectionState({ state, provider: "github", secret: "other" })).toThrow(/signature/i);
    expect(() => verifyConnectionState({ state, provider: "gitlab", secret })).toThrow(/different provider/i);
  });
});

describe("fake provider conformance", () => {
  runProviderConformance((): ProviderConformanceWorld => {
    const provider = new FakeRepositoryProvider({ provider: "fake", host: "fake.example.com", pageSize: 2 });
    const companyId = randomUUID();
    const userId = randomUUID();
    const installationId = "inst-fake-1";
    const accountName = "acme";
    const seedState = { repos: [] as Array<{ providerRepositoryId: string; owner: string; name: string }> };
    const apply = () => provider.setInstallation({
      installationId,
      accountId: "acct-1",
      accountName,
      repositories: seedState.repos.map((r) => ({ ...r })),
    });
    apply();
    return {
      connector: provider.connector(),
      companyId,
      userId,
      installationId,
      accountName,
      seed(repos) {
        seedState.repos = repos.map((r) => ({ ...r }));
        apply();
      },
      rename(providerRepositoryId, next) {
        provider.rename(installationId, providerRepositoryId, next);
      },
    };
  });
});

describe("github.com provider conformance", () => {
  runProviderConformance((): ProviderConformanceWorld => {
    const transport = new FakeGitHubTransport();
    const provider = createGitHubProvider({
      transport,
      config: { appSlug: "paperclip", stateSecret: "gh-state-secret" },
    });
    const companyId = randomUUID();
    const userId = randomUUID();
    const installationId = "42";
    const accountName = "acme";
    const applyInstallation = (repos: Array<{ providerRepositoryId: string; owner: string; name: string }>) => {
      transport.setInstallation(
        { id: installationId, account: { id: 1000, login: accountName, type: "Organization" }, app_slug: "paperclip" },
        repos.map((r) => makeGitHubRepository({ id: r.providerRepositoryId, owner: r.owner, name: r.name })),
      );
    };
    applyInstallation([]);
    return {
      connector: provider,
      companyId,
      userId,
      installationId,
      accountName,
      seed(repos) {
        applyInstallation(repos);
      },
      rename(providerRepositoryId, next) {
        transport.rename(installationId, providerRepositoryId, next);
      },
    };
  });
});

describe("github.com provider specifics", () => {
  function setup() {
    const transport = new FakeGitHubTransport();
    const provider = createGitHubProvider({
      transport,
      config: { appSlug: "paperclip", stateSecret: "gh-state-secret" },
    });
    const companyId = randomUUID();
    const userId = randomUUID();
    return { transport, provider, companyId, userId };
  }

  async function connect(ctx: ReturnType<typeof setup>, installationId: string, repos = [] as ReturnType<typeof makeGitHubRepository>[]) {
    ctx.transport.setInstallation(
      { id: installationId, account: { id: 7, login: "acme", type: "Organization" }, app_slug: "paperclip", repository_selection: "selected" },
      repos,
    );
    const begin = await ctx.provider.beginInstallation({ companyId: ctx.companyId, userId: ctx.userId });
    const meta = await ctx.provider.completeInstallation({ state: begin.state, installationId, companyId: ctx.companyId });
    const now = new Date();
    const connection = {
      id: randomUUID(),
      companyId: ctx.companyId,
      provider: "github",
      host: meta.host,
      installationId: meta.installationId,
      accountId: meta.accountId,
      accountName: meta.accountName,
      status: "active" as const,
      syncStatus: "idle" as const,
      syncCursor: null,
      syncError: null,
      lastSyncedAt: null,
      providerMetadata: meta.providerMetadata,
      disconnectedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    return { meta, connection };
  }

  it("builds an install URL bound to the app slug and a signed state", async () => {
    const ctx = setup();
    const begin = await ctx.provider.beginInstallation({ companyId: ctx.companyId, userId: ctx.userId });
    expect(begin.installUrl).toContain("github.com/apps/paperclip/installations/new");
    expect(begin.installUrl).toContain("state=");
  });

  it("surfaces installation account metadata without persisting secrets", async () => {
    const ctx = setup();
    const { meta } = await connect(ctx, "100");
    expect(meta).toMatchObject({ installationId: "100", accountName: "acme", accountId: "7", host: "github.com" });
    expect(JSON.stringify(meta.providerMetadata)).not.toMatch(/token|secret|private/i);
  });

  it("archived provider repositories import as unavailable", async () => {
    const ctx = setup();
    const { connection } = await connect(ctx, "101", [
      makeGitHubRepository({ id: 1, owner: "acme", name: "live" }),
      makeGitHubRepository({ id: 2, owner: "acme", name: "old", archived: true }),
    ]);
    const synced = await ctx.provider.sync({ connection, cursor: null });
    const old = synced.repositories.find((r) => r.providerRepositoryId === "2");
    expect(old?.state).toBe("unavailable");
    expect(old?.unavailableReason).toMatch(/archived/i);
  });

  it("paginates a full sync across multiple pages", async () => {
    const ctx = setup();
    const repos = Array.from({ length: 150 }, (_, i) => makeGitHubRepository({ id: i + 1, owner: "acme", name: `repo-${i + 1}` }));
    const { connection } = await connect(ctx, "102", repos);
    const synced = await ctx.provider.sync({ connection, cursor: null });
    expect(synced.repositories).toHaveLength(150);
  });

  it("resolves a short-lived installation clone credential and redacts it from audit", async () => {
    const ctx = setup();
    const { connection } = await connect(ctx, "103", [makeGitHubRepository({ id: 5, owner: "acme", name: "secure" })]);
    const result = await ctx.provider.resolveCloneCredential({
      connection,
      repository: { id: "r-1", providerRepositoryId: "5", owner: "acme", name: "secure", host: "github.com", cloneUrl: "https://github.com/acme/secure.git" },
    });
    expect(result.token).toMatch(/^ghs_/);
    expect(result.authenticatedCloneUrl).toBe(`https://x-access-token:${result.token}@github.com/acme/secure.git`);
    expect(JSON.stringify(result.audit)).not.toContain(result.token);
  });

  it("propagates provider token-mint failures for revoked installations", async () => {
    const ctx = setup();
    const { connection } = await connect(ctx, "104", [makeGitHubRepository({ id: 6, owner: "acme", name: "revoked" })]);
    ctx.transport.failTokenMint = new Error("installation suspended");
    await expect(ctx.provider.resolveCloneCredential({
      connection,
      repository: { id: "r-2", providerRepositoryId: "6", owner: "acme", name: "revoked", host: "github.com", cloneUrl: "https://github.com/acme/revoked.git" },
    })).rejects.toThrow(/suspended/);
  });
});
