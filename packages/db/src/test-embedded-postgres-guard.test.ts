import { afterEach, describe, expect, it } from "vitest";
import {
  ALLOW_SKIP_EMBEDDED_POSTGRES_ENV,
  __setEmbeddedPostgresCtorProviderForTests,
  __resetEmbeddedPostgresSupportForTests,
  getEmbeddedPostgresTestSupport,
} from "./test-embedded-postgres.js";
import { sharedEmbeddedPostgresDatabaseUrl } from "./test-embedded-postgres-shared.js";

// RBR-912 AC4. Two server suites reported all 58 of their tests as `skipped`
// because a failed embedded-Postgres fixture selected `describe.skip`. A fixture
// that cannot run must be a hard red, never a silent green.
describe("getEmbeddedPostgresTestSupport (AC4 loud-failure guard)", () => {
  afterEach(() => {
    __setEmbeddedPostgresCtorProviderForTests(null);
    __resetEmbeddedPostgresSupportForTests();
    delete process.env[ALLOW_SKIP_EMBEDDED_POSTGRES_ENV];
  });

  function installFailingCluster() {
    class AlwaysFailingEmbeddedPostgres {
      async initialise(): Promise<void> {}
      async start(): Promise<void> {
        throw new Error("simulated: embedded Postgres cannot start here");
      }
      async stop(): Promise<void> {}
    }
    __setEmbeddedPostgresCtorProviderForTests(async () => AlwaysFailingEmbeddedPostgres);
  }

  it("throws instead of reporting unsupported, so suites cannot silently skip", async () => {
    installFailingCluster();

    await expect(getEmbeddedPostgresTestSupport()).rejects.toThrow(
      /Embedded Postgres is required by this test suite but is unavailable/,
    );
  });

  it("names the opt-out variable in the failure so the trap is discoverable", async () => {
    installFailingCluster();

    const error = await getEmbeddedPostgresTestSupport().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(ALLOW_SKIP_EMBEDDED_POSTGRES_ENV);
    // The real Postgres reason survives, so the failure is diagnosable.
    expect((error as Error).message).toContain("simulated");
  });

  it("still allows a deliberate, explicitly opted-in skip", async () => {
    installFailingCluster();
    process.env[ALLOW_SKIP_EMBEDDED_POSTGRES_ENV] = "1";

    const support = await getEmbeddedPostgresTestSupport();

    expect(support.supported).toBe(false);
    expect(support.reason).toContain("simulated");
  });
});

// RBR-912 AC3. Per-suite databases are cloned off the run's shared cluster, so
// the per-suite connection string is the shared admin URL with only the database
// swapped — credentials, host and port must survive untouched.
describe("sharedEmbeddedPostgresDatabaseUrl", () => {
  it("swaps only the database name", () => {
    const admin = "postgres://paperclip:paperclip@127.0.0.1:54321/postgres";

    const cloned = sharedEmbeddedPostgresDatabaseUrl(admin, "paperclip_test_abc123");

    const url = new URL(cloned);
    expect(url.pathname).toBe("/paperclip_test_abc123");
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.port).toBe("54321");
    expect(url.username).toBe("paperclip");
    expect(url.password).toBe("paperclip");
  });
});
