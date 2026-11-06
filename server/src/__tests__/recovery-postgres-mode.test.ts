import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  migrations: vi.fn(async (_url: string) => {}),
  closeRegistered: vi.fn(async (_url: string, _options: { scope: string }) => {}),
  unsafe: vi.fn(async (_query: string) => []),
  end: vi.fn(async () => {}),
  createDb: vi.fn(),
  support: vi.fn(async () => ({ supported: true })),
  embedded: vi.fn(),
}));
vi.mock("@paperclipai/db", () => ({
  applyPendingMigrations: mocks.migrations, closeRegisteredClients: mocks.closeRegistered, createDb: mocks.createDb,
}));
vi.mock("./helpers/embedded-postgres.js", () => ({
  getEmbeddedPostgresTestSupport: mocks.support, startEmbeddedPostgresTestDatabase: mocks.embedded,
}));

const recoveryUrl = "postgresql://paperclip@127.0.0.1:55448/recovery_modes_test";
beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  vi.stubEnv("PAPERCLIP_TEST_DATABASE_URL", undefined);
  vi.stubEnv("PAPERCLIP_RECOVERY_TEST_DATABASE_URL", recoveryUrl);
  mocks.createDb.mockReturnValue({ $client: { unsafe: mocks.unsafe, end: mocks.end } });
});
afterEach(() => { vi.unstubAllEnvs(); });

it("keeps separate fixture allocations when a recovery URL belongs to another explicitly opted-in caller", async () => {
  const firstCleanup = vi.fn(async () => {}), secondCleanup = vi.fn(async () => {});
  mocks.embedded
    .mockResolvedValueOnce({ connectionString: "postgresql://paperclip@127.0.0.1:55448/first_owned_test", cleanup: firstCleanup })
    .mockResolvedValueOnce({ connectionString: "postgresql://paperclip@127.0.0.1:55448/second_owned_test", cleanup: secondCleanup });
  const { startRecoveryPostgres } = await import("./helpers/recovery-postgres.js");
  const first = await startRecoveryPostgres("first-fixture-");
  const second = await startRecoveryPostgres("second-fixture-");
  expect(first.connectionString).not.toBe(second.connectionString);
  expect(first.connectionString).not.toBe(recoveryUrl);
  expect(second.connectionString).not.toBe(recoveryUrl);
  expect(mocks.embedded.mock.calls).toEqual([["first-fixture-"], ["second-fixture-"]]);
  expect(mocks.migrations).not.toHaveBeenCalled();
  expect(mocks.createDb).not.toHaveBeenCalled();
  expect(mocks.support).not.toHaveBeenCalled();
  await first.cleanup(); await second.cleanup();
  expect(firstCleanup).toHaveBeenCalledOnce(); expect(secondCleanup).toHaveBeenCalledOnce();
  expect(mocks.closeRegistered).not.toHaveBeenCalled();
});

it("uses the exact dedicated database only when the owning caller passes its explicit option", async () => {
  vi.stubEnv("PAPERCLIP_TEST_DATABASE_URL", "postgresql://paperclip@127.0.0.1:55448/postgres");
  const { startRecoveryPostgres } = await import("./helpers/recovery-postgres.js");
  const fixture = await startRecoveryPostgres("owned-fixture-", { dedicatedDatabaseUrl: recoveryUrl });
  expect(fixture.connectionString).toBe(recoveryUrl);
  expect(mocks.migrations).toHaveBeenCalledExactlyOnceWith(recoveryUrl);
  expect(mocks.embedded).not.toHaveBeenCalled(); expect(mocks.createDb).not.toHaveBeenCalled();
  expect(mocks.support).not.toHaveBeenCalled();
  await fixture.cleanup();
  expect(mocks.closeRegistered).toHaveBeenCalledExactlyOnceWith(recoveryUrl, { scope: "database" });
});

it("retains fresh external database allocation and matching cleanup for existing non-dedicated callers", async () => {
  const admin = "postgresql://paperclip@127.0.0.1:55448/postgres";
  vi.stubEnv("PAPERCLIP_TEST_DATABASE_URL", admin);
  const { startRecoveryPostgres } = await import("./helpers/recovery-postgres.js");
  const first = await startRecoveryPostgres("first-fixture-");
  const second = await startRecoveryPostgres("second-fixture-");
  expect(first.connectionString).not.toBe(second.connectionString);
  expect(first.connectionString).not.toBe(recoveryUrl);
  expect(second.connectionString).not.toBe(recoveryUrl);
  const firstName = new URL(first.connectionString).pathname.slice(1);
  const secondName = new URL(second.connectionString).pathname.slice(1);
  expect(mocks.unsafe.mock.calls.map(([query]) => query)).toEqual([
    `create database "${firstName}"`, `create database "${secondName}"`,
  ]);
  expect(mocks.migrations.mock.calls.map(([url]) => url)).toEqual([first.connectionString, second.connectionString]);
  await first.cleanup(); await second.cleanup();
  expect(mocks.closeRegistered.mock.calls).toEqual([
    [first.connectionString, { scope: "database" }], [second.connectionString, { scope: "database" }],
  ]);
  expect(mocks.unsafe.mock.calls.map(([query]) => query)).toEqual([
    `create database "${firstName}"`, `create database "${secondName}"`,
    `drop database "${firstName}"`, `drop database "${secondName}"`,
  ]);
  expect(mocks.createDb.mock.calls).toEqual([[admin], [admin], [admin], [admin]]);
  expect(mocks.end).toHaveBeenCalledTimes(4);
  expect(mocks.embedded).not.toHaveBeenCalled(); expect(mocks.support).not.toHaveBeenCalled();
});
