import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { RepositoryConnection } from "@paperclipai/shared";
import type { RepositoryProviderConnector } from "../../services/repository-providers/provider-contract.js";

/**
 * Reusable provider conformance harness. Any {@link RepositoryProviderConnector}
 * implementation — the in-memory fake or the real GitHub.com provider backed by
 * a fake transport — must pass this suite. It asserts installation lifecycle,
 * signed-state validation, searchable/paginated discovery, metadata refresh,
 * rename/transfer convergence via sync, and short-lived clone credential
 * resolution (secret-free audit).
 */

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
  /** Replace the repository set visible to the installation. */
  seed(repos: ConformanceSeedRepo[]): void;
  /** Rename/transfer a repo, keeping its provider id stable. */
  rename(providerRepositoryId: string, next: { owner: string; name: string }): void;
}

export type ConformanceWorldFactory = () => ProviderConformanceWorld;

function connectionFromMetadata(
  world: ProviderConformanceWorld,
  meta: { installationId: string; accountId: string | null; accountName: string | null; host: string; providerMetadata: Record<string, unknown> | null },
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

/**
 * Registers the conformance `it` blocks. Call inside a `describe`. The factory
 * must return a fresh, isolated world per invocation.
 */
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

    const allIds = [...page1.items, ...page2.items].map((r) => r.providerRepositoryId).sort();
    expect(allIds).toEqual(["1", "2", "3"]);

    const searched = await world.connector.discover({ connection, query: "beta", pageSize: 10 });
    expect(searched.items.map((r) => r.name)).toEqual(["beta"]);
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
    expect(await world.connector.refreshMetadata({ connection, providerRepositoryId: "does-not-exist" })).toBeNull();
  });

  it("converges idempotently across sync and reflects rename/transfer by stable id", async () => {
    const world = makeWorld();
    world.seed([
      { providerRepositoryId: "10", owner: "acme", name: "one" },
      { providerRepositoryId: "11", owner: "acme", name: "two" },
    ]);
    const connection = await install(world);

    const first = await world.connector.sync({ connection, cursor: null });
    expect(first.repositories.map((r) => r.providerRepositoryId).sort()).toEqual(["10", "11"]);

    const second = await world.connector.sync({ connection, cursor: null });
    expect(second.repositories.map((r) => r.providerRepositoryId).sort()).toEqual(["10", "11"]);

    world.rename("10", { owner: "acme-new", name: "one-renamed" });
    const afterRename = await world.connector.sync({ connection, cursor: null });
    const renamed = afterRename.repositories.find((r) => r.providerRepositoryId === "10");
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
    // The audit record must never carry the token or the authenticated URL.
    const auditJson = JSON.stringify(result.audit);
    expect(auditJson).not.toContain(result.token);
    expect(result.audit).toMatchObject({ repositoryId: "repo-uuid", connectionId: connection.id });
  });
}
