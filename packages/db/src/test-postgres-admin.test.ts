import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import {
  __setEmbeddedPostgresCtorProviderForTests,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const previousAdmin = process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL;
const previousTemplate = process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
let server: EmbeddedPostgresTestDatabase;
const databases: EmbeddedPostgresTestDatabase[] = [];
const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("shared PostgreSQL fixtures", () => {
  beforeAll(async () => {
    server = await startEmbeddedPostgresTestDatabase("paperclip-admin-regression-");
    process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL = server.connectionString;
  }, 90_000);

  afterEach(async () => {
    __setEmbeddedPostgresCtorProviderForTests(null);
    process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL = server.connectionString;
    if (previousTemplate === undefined) delete process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
    else process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE = previousTemplate;
    while (databases.length) await databases.pop()!.cleanup();
  });

  afterAll(async () => {
    await server?.cleanup();
    if (previousAdmin === undefined) delete process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL;
    else process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL = previousAdmin;
    if (previousTemplate === undefined) delete process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
    else process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE = previousTemplate;
  });

  it("uses one server for isolated databases and closes clients before dropping them", async () => {
    __setEmbeddedPostgresCtorProviderForTests(async () => { throw new Error("Must not start another PostgreSQL server"); });
    expect(await getEmbeddedPostgresTestSupport()).toEqual({ supported: true });
    const first = await startEmbeddedPostgresTestDatabase("ignored-"); databases.push(first);
    const second = await startEmbeddedPostgresTestDatabase("ignored-"); databases.push(second);
    expect(first.connectionString).not.toBe(second.connectionString);
    const a = createDb(first.connectionString), b = createDb(second.connectionString);
    await a.$client`CREATE TABLE isolated_probe (id integer)`;
    expect((await b.$client`SELECT to_regclass('isolated_probe') AS name`)[0]?.name).toBeNull();
    await first.cleanup();
    await first.cleanup();
    const control = createDb(server.connectionString);
    try {
      const name = new URL(first.connectionString).pathname.slice(1);
      expect(await control.$client`SELECT datname FROM pg_database WHERE datname = ${name}`).toHaveLength(0);
      expect((await b.$client`SELECT 1 AS value`)[0]?.value).toBe(1);
    } finally { await control.$client.end(); }
  }, 90_000);

  it("rejects unavailable configured servers rather than reporting support", async () => {
    process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL = "postgres://paperclip:paperclip@127.0.0.1:1/postgres";
    await expect(getEmbeddedPostgresTestSupport()).rejects.toThrow();
  });

  it("rejects unsafe templates and treats zero as a disabled template", async () => {
    process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE = 'postgres"; DROP DATABASE postgres; --';
    await expect(startEmbeddedPostgresTestDatabase("ignored-")).rejects.toThrow("Invalid disposable test template name");
    process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE = "0";
    databases.push(await startEmbeddedPostgresTestDatabase("ignored-"));
  }, 90_000);

  it("applies pending migrations when a supplied database template is not current", async () => {
    const template = `paperclip_test_template_${randomUUID().replaceAll("-", "")}`;
    const control = createDb(server.connectionString);
    await control.$client.unsafe(`CREATE DATABASE "${template}"`);
    try {
      process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE = template;
      const database = await startEmbeddedPostgresTestDatabase("ignored-");
      databases.push(database);
      const db = createDb(database.connectionString);
      expect((await db.$client`SELECT to_regclass('companies') AS name`)[0]?.name).toBe("companies");
    } finally {
      await control.$client.unsafe(`DROP DATABASE "${template}"`);
      await control.$client.end();
    }
  }, 90_000);

});
