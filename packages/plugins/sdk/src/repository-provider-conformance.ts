/**
 * Repository provider conformance harness.
 *
 * A trusted extension that declares `repositoryProviders[]` and implements the
 * `onRepositoryProvider*` hooks must pass this suite before the host will treat
 * it as a first-class provider. It is the executable half of the contract: the
 * host's bridge runs it against a fake worker, and an extension package (e.g.
 * the Paperclip EE GitHub Enterprise provider) runs the identical checks
 * against its own handlers.
 *
 * Deliberately framework-agnostic — it returns named checks instead of calling
 * `it()`/`expect()` — so the SDK stays free of a test-runner dependency and the
 * same suite runs under vitest, jest, or `node:test`:
 *
 * ```ts
 * import { repositoryProviderConformanceChecks } from "@paperclipai/plugin-sdk/repository-provider-conformance";
 *
 * describe("github enterprise provider", () => {
 *   for (const check of repositoryProviderConformanceChecks(makeWorld)) {
 *     it(check.name, check.run);
 *   }
 * });
 * ```
 */
import type {
  PluginRepositoryConnectionSnapshot,
  PluginRepositoryProviderBeginInstallationParams,
  PluginRepositoryProviderBeginInstallationResult,
  PluginRepositoryProviderCompleteInstallationParams,
  PluginRepositoryProviderCompleteInstallationResult,
  PluginRepositoryProviderDisconnectParams,
  PluginRepositoryProviderDiscoverParams,
  PluginRepositoryProviderDiscoverResult,
  PluginRepositoryProviderRefreshMetadataParams,
  PluginRepositoryProviderRefreshMetadataResult,
  PluginRepositoryProviderResolveCloneCredentialParams,
  PluginRepositoryProviderResolveCloneCredentialResult,
  PluginRepositoryProviderSyncParams,
  PluginRepositoryProviderSyncResult,
} from "./protocol.js";

/**
 * The handler surface under test. Matches the correspondingly named
 * `onRepositoryProvider*` hooks on a plugin definition, so an extension can
 * pass its definition object straight through.
 */
export interface RepositoryProviderConformanceHandlers {
  onRepositoryProviderBeginInstallation(
    params: PluginRepositoryProviderBeginInstallationParams,
  ): Promise<PluginRepositoryProviderBeginInstallationResult>;
  onRepositoryProviderCompleteInstallation(
    params: PluginRepositoryProviderCompleteInstallationParams,
  ): Promise<PluginRepositoryProviderCompleteInstallationResult>;
  onRepositoryProviderDiscover(
    params: PluginRepositoryProviderDiscoverParams,
  ): Promise<PluginRepositoryProviderDiscoverResult>;
  onRepositoryProviderRefreshMetadata(
    params: PluginRepositoryProviderRefreshMetadataParams,
  ): Promise<PluginRepositoryProviderRefreshMetadataResult>;
  onRepositoryProviderSync(
    params: PluginRepositoryProviderSyncParams,
  ): Promise<PluginRepositoryProviderSyncResult>;
  onRepositoryProviderResolveCloneCredential(
    params: PluginRepositoryProviderResolveCloneCredentialParams,
  ): Promise<PluginRepositoryProviderResolveCloneCredentialResult>;
  onRepositoryProviderDisconnect?(
    params: PluginRepositoryProviderDisconnectParams,
  ): Promise<void>;
}

export interface ConformanceSeedRepository {
  providerRepositoryId: string;
  owner: string;
  name: string;
}

export interface RepositoryProviderConformanceWorld {
  handlers: RepositoryProviderConformanceHandlers;
  /** Declared provider key under test. */
  providerKey: string;
  /** Declared, normalized provider host under test. */
  host: string;
  companyId: string;
  userId: string;
  installationId: string;
  accountName: string;
  /** Replace the repository set visible to the installation. */
  seed(repos: ConformanceSeedRepository[]): void;
  /** Rename/transfer a repository, keeping its provider id stable. */
  rename(providerRepositoryId: string, next: { owner: string; name: string }): void;
}

export type RepositoryProviderConformanceWorldFactory = () =>
  | RepositoryProviderConformanceWorld
  | Promise<RepositoryProviderConformanceWorld>;

export interface RepositoryProviderConformanceCheck {
  name: string;
  run(): Promise<void>;
}

/** Company id used to prove state is bound to the company that requested it. */
const FOREIGN_COMPANY_ID = "00000000-0000-4000-8000-0000000000ff";

class ConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryProviderConformanceError";
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConformanceError(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new ConformanceError(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

async function assertRejects(operation: () => Promise<unknown>, message: string) {
  let resolved = false;
  try {
    await operation();
    resolved = true;
  } catch {
    return;
  }
  if (resolved) throw new ConformanceError(message);
}

function assertIsoInFuture(value: unknown, message: string) {
  assert(typeof value === "string" && value.length > 0, `${message}: expected an ISO-8601 string`);
  const parsed = Date.parse(value as string);
  assert(Number.isFinite(parsed), `${message}: expected a parseable ISO-8601 string`);
  assert(parsed > Date.now(), `${message}: expected a future timestamp`);
}

function baseParams(world: RepositoryProviderConformanceWorld) {
  return { providerKey: world.providerKey, host: world.host, companyId: world.companyId };
}

function connectionFrom(
  world: RepositoryProviderConformanceWorld,
  meta: PluginRepositoryProviderCompleteInstallationResult,
): PluginRepositoryConnectionSnapshot {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    companyId: world.companyId,
    provider: world.providerKey,
    host: meta.host,
    installationId: meta.installationId,
    accountId: meta.accountId,
    accountName: meta.accountName,
    status: "active",
    syncStatus: "idle",
    syncCursor: null,
    lastSyncedAt: null,
    providerMetadata: meta.providerMetadata ?? null,
  };
}

async function install(world: RepositoryProviderConformanceWorld) {
  const begin = await world.handlers.onRepositoryProviderBeginInstallation({
    ...baseParams(world),
    userId: world.userId,
  });
  const meta = await world.handlers.onRepositoryProviderCompleteInstallation({
    ...baseParams(world),
    state: begin.state,
    installationId: world.installationId,
  });
  return { begin, meta, connection: connectionFrom(world, meta) };
}

/**
 * Builds the conformance checks. The factory must return a fresh, isolated
 * world per invocation — checks mutate their world's repository set.
 */
export function repositoryProviderConformanceChecks(
  makeWorld: RepositoryProviderConformanceWorldFactory,
): RepositoryProviderConformanceCheck[] {
  return [
    {
      name: "begins installation with expiring state bound to the requesting company",
      async run() {
        const world = await makeWorld();
        world.seed([{ providerRepositoryId: "1", owner: "acme", name: "alpha" }]);
        const begin = await world.handlers.onRepositoryProviderBeginInstallation({
          ...baseParams(world),
          userId: world.userId,
        });
        assert(typeof begin.state === "string" && begin.state.length > 0, "beginInstallation must return signed state");
        assert(
          typeof begin.installUrl === "string" && begin.installUrl.startsWith("https://"),
          "beginInstallation must return an https install URL",
        );
        assertIsoInFuture(begin.expiresAt, "beginInstallation expiresAt");
      },
    },
    {
      name: "rejects tampered and cross-company installation state",
      async run() {
        const world = await makeWorld();
        world.seed([{ providerRepositoryId: "1", owner: "acme", name: "alpha" }]);
        const begin = await world.handlers.onRepositoryProviderBeginInstallation({
          ...baseParams(world),
          userId: world.userId,
        });

        await assertRejects(
          () => world.handlers.onRepositoryProviderCompleteInstallation({
            ...baseParams(world),
            state: `${begin.state}tampered`,
            installationId: world.installationId,
          }),
          "completeInstallation must reject tampered state",
        );

        await assertRejects(
          () => world.handlers.onRepositoryProviderCompleteInstallation({
            ...baseParams(world),
            companyId: FOREIGN_COMPANY_ID,
            state: begin.state,
            installationId: world.installationId,
          }),
          "completeInstallation must reject state issued for another company",
        );

        const meta = await world.handlers.onRepositoryProviderCompleteInstallation({
          ...baseParams(world),
          state: begin.state,
          installationId: world.installationId,
        });
        assertEqual(meta.companyId, world.companyId, "completeInstallation must echo the requesting company");
        assertEqual(meta.userId, world.userId, "completeInstallation must echo the initiating user");
        assertEqual(meta.installationId, world.installationId, "completeInstallation must echo the installation id");
        assertEqual(meta.host, world.host, "completeInstallation must report the declared normalized host");
      },
    },
    {
      name: "discovers repositories with pagination and search",
      async run() {
        const world = await makeWorld();
        world.seed([
          { providerRepositoryId: "1", owner: "acme", name: "alpha" },
          { providerRepositoryId: "2", owner: "acme", name: "beta" },
          { providerRepositoryId: "3", owner: "acme", name: "gamma" },
        ]);
        const { connection } = await install(world);

        const page1 = await world.handlers.onRepositoryProviderDiscover({
          ...baseParams(world),
          connection,
          pageSize: 2,
        });
        assertEqual(page1.items.length, 2, "first discovery page must respect pageSize");
        assert(page1.nextCursor != null, "first discovery page must return a next cursor");
        assertEqual(page1.total, 3, "discovery must report the total match count when known");

        const page2 = await world.handlers.onRepositoryProviderDiscover({
          ...baseParams(world),
          connection,
          pageSize: 2,
          cursor: page1.nextCursor,
        });
        assertEqual(page2.items.length, 1, "last discovery page must return the remainder");
        assertEqual(page2.nextCursor, null, "last discovery page must return a null cursor");

        const ids = [...page1.items, ...page2.items].map((item) => item.providerRepositoryId).sort();
        assertEqual(ids.join(","), "1,2,3", "discovery pages must cover every repository exactly once");

        const searched = await world.handlers.onRepositoryProviderDiscover({
          ...baseParams(world),
          connection,
          query: "gamma",
        });
        assertEqual(searched.items.length, 1, "discovery search must filter by owner/name");
        assertEqual(searched.items[0]?.providerRepositoryId, "3", "discovery search must return the matching repository");

        for (const item of page1.items) {
          assert(
            item.cloneUrl.includes(world.host),
            "discovered clone URLs must point at the declared provider host",
          );
        }
      },
    },
    {
      name: "fails closed on an invalid discovery cursor",
      async run() {
        const world = await makeWorld();
        world.seed([{ providerRepositoryId: "1", owner: "acme", name: "alpha" }]);
        const { connection } = await install(world);
        await assertRejects(
          () => world.handlers.onRepositoryProviderDiscover({
            ...baseParams(world),
            connection,
            cursor: "not-a-cursor",
          }),
          "discovery must reject an unparseable cursor instead of silently restarting",
        );
      },
    },
    {
      name: "refreshes metadata for a known repository and reports unknown ones as missing",
      async run() {
        const world = await makeWorld();
        world.seed([{ providerRepositoryId: "1", owner: "acme", name: "alpha" }]);
        const { connection } = await install(world);

        const known = await world.handlers.onRepositoryProviderRefreshMetadata({
          ...baseParams(world),
          connection,
          providerRepositoryId: "1",
        });
        assert(known.repository != null, "refreshMetadata must return a snapshot for a visible repository");
        assertEqual(
          known.repository?.providerRepositoryId,
          "1",
          "refreshMetadata must echo the requested provider repository id",
        );

        const unknown = await world.handlers.onRepositoryProviderRefreshMetadata({
          ...baseParams(world),
          connection,
          providerRepositoryId: "does-not-exist",
        });
        assertEqual(unknown.repository, null, "refreshMetadata must return null for a repository it cannot see");
      },
    },
    {
      name: "converges on rename/transfer without changing provider repository identity",
      async run() {
        const world = await makeWorld();
        world.seed([{ providerRepositoryId: "1", owner: "acme", name: "alpha" }]);
        const { connection } = await install(world);

        const before = await world.handlers.onRepositoryProviderSync({
          ...baseParams(world),
          connection,
          cursor: null,
        });
        assertEqual(before.repositories.length, 1, "sync must enumerate the installation's repositories");
        assert(
          before.repositories[0]?.cloneUrl.includes("alpha"),
          "sync must report the current clone URL",
        );

        world.rename("1", { owner: "acme-renamed", name: "alpha-renamed" });

        const after = await world.handlers.onRepositoryProviderSync({
          ...baseParams(world),
          connection,
          cursor: null,
        });
        assertEqual(after.repositories.length, 1, "sync must stay idempotent across a rename");
        assertEqual(
          after.repositories[0]?.providerRepositoryId,
          "1",
          "provider repository id must survive rename/transfer",
        );
        assert(
          after.repositories[0]?.cloneUrl.includes("alpha-renamed"),
          "sync must report the renamed clone URL",
        );
      },
    },
    {
      name: "resolves a short-lived clone credential with a secret-free audit trail",
      async run() {
        const world = await makeWorld();
        world.seed([{ providerRepositoryId: "1", owner: "acme", name: "alpha" }]);
        const { connection } = await install(world);

        const resolved = await world.handlers.onRepositoryProviderResolveCloneCredential({
          ...baseParams(world),
          connection,
          repository: {
            id: "00000000-0000-4000-8000-0000000000a1",
            providerRepositoryId: "1",
            owner: "acme",
            name: "alpha",
            cloneUrl: `https://${world.host}/acme/alpha.git`,
            host: world.host,
          },
        });

        assert(typeof resolved.token === "string" && resolved.token.length > 0, "clone credential must include a token");
        assert(
          typeof resolved.username === "string" && resolved.username.length > 0,
          "clone credential must include a username",
        );
        assertIsoInFuture(resolved.expiresAt, "clone credential expiresAt");
        assert(
          resolved.authenticatedCloneUrl.includes(resolved.token),
          "authenticated clone URL must carry the transient token",
        );
        assert(
          resolved.authenticatedCloneUrl.includes(world.host),
          "authenticated clone URL must point at the declared provider host",
        );
        assert(
          !JSON.stringify(resolved.audit ?? {}).includes(resolved.token),
          "audit metadata must never contain the credential",
        );

        const second = await world.handlers.onRepositoryProviderResolveCloneCredential({
          ...baseParams(world),
          connection,
          repository: {
            id: "00000000-0000-4000-8000-0000000000a1",
            providerRepositoryId: "1",
            owner: "acme",
            name: "alpha",
            cloneUrl: `https://${world.host}/acme/alpha.git`,
            host: world.host,
          },
        });
        assert(second.token !== resolved.token, "clone credentials must be minted fresh, not cached and replayed");
      },
    },
    {
      name: "rejects calls for a connection belonging to another company",
      async run() {
        const world = await makeWorld();
        world.seed([{ providerRepositoryId: "1", owner: "acme", name: "alpha" }]);
        const { connection } = await install(world);

        await assertRejects(
          () => world.handlers.onRepositoryProviderDiscover({
            ...baseParams(world),
            companyId: FOREIGN_COMPANY_ID,
            connection,
          }),
          "provider calls must reject a company id that does not own the connection",
        );
      },
    },
  ];
}

export interface RepositoryProviderConformanceFailure {
  name: string;
  error: Error;
}

/**
 * Runs every check and resolves with the failures. Convenient for extensions
 * that want a single assertion (`expect(failures).toEqual([])`) or a CLI check.
 */
export async function runRepositoryProviderConformance(
  makeWorld: RepositoryProviderConformanceWorldFactory,
): Promise<RepositoryProviderConformanceFailure[]> {
  const failures: RepositoryProviderConformanceFailure[] = [];
  for (const check of repositoryProviderConformanceChecks(makeWorld)) {
    try {
      await check.run();
    } catch (err) {
      failures.push({ name: check.name, error: err instanceof Error ? err : new Error(String(err)) });
    }
  }
  return failures;
}
