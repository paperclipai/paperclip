import { afterEach, describe, expect, it } from "vitest";
import { resolveExternalTestDatabaseUrl } from "./external-test-database.js";

const originalUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const originalOptIn = process.env.PAPERCLIP_ALLOW_EXTERNAL_TEST_DATABASE;

function approvedUrl(databaseName: string): string {
  return `postgresql://user:pw@db.example:5432/${databaseName}`;
}

afterEach(() => {
  if (originalUrl === undefined) delete process.env.PAPERCLIP_TEST_DATABASE_URL;
  else process.env.PAPERCLIP_TEST_DATABASE_URL = originalUrl;
  if (originalOptIn === undefined)
    delete process.env.PAPERCLIP_ALLOW_EXTERNAL_TEST_DATABASE;
  else process.env.PAPERCLIP_ALLOW_EXTERNAL_TEST_DATABASE = originalOptIn;
});

describe("resolveExternalTestDatabaseUrl", () => {
  it("returns null when the URL is unset", () => {
    delete process.env.PAPERCLIP_TEST_DATABASE_URL;
    delete process.env.PAPERCLIP_ALLOW_EXTERNAL_TEST_DATABASE;
    expect(resolveExternalTestDatabaseUrl()).toBeNull();
  });

  it("returns null without the explicit opt-in", () => {
    process.env.PAPERCLIP_TEST_DATABASE_URL = approvedUrl("paperclip_test");
    delete process.env.PAPERCLIP_ALLOW_EXTERNAL_TEST_DATABASE;
    expect(resolveExternalTestDatabaseUrl()).toBeNull();
  });

  it("returns an approved test database URL", () => {
    process.env.PAPERCLIP_TEST_DATABASE_URL = approvedUrl("paperclip_test");
    process.env.PAPERCLIP_ALLOW_EXTERNAL_TEST_DATABASE = "1";
    expect(resolveExternalTestDatabaseUrl()).toBe(
      approvedUrl("paperclip_test"),
    );
  });

  it("rejects a near-miss production database name", () => {
    process.env.PAPERCLIP_TEST_DATABASE_URL = approvedUrl("production-test");
    process.env.PAPERCLIP_ALLOW_EXTERNAL_TEST_DATABASE = "1";
    expect(() => resolveExternalTestDatabaseUrl()).toThrow(/_test/);
  });

  it("rejects a production database name", () => {
    process.env.PAPERCLIP_TEST_DATABASE_URL = approvedUrl("production");
    process.env.PAPERCLIP_ALLOW_EXTERNAL_TEST_DATABASE = "1";
    expect(() => resolveExternalTestDatabaseUrl()).toThrow(/_test/);
  });

  it("rejects a non-PostgreSQL connection URL", () => {
    process.env.PAPERCLIP_TEST_DATABASE_URL = "mysql://user:pw@db.example:3306/app_test";
    process.env.PAPERCLIP_ALLOW_EXTERNAL_TEST_DATABASE = "1";
    expect(() => resolveExternalTestDatabaseUrl()).toThrow(/PostgreSQL/);
  });

  it("rejects a malformed URL", () => {
    process.env.PAPERCLIP_TEST_DATABASE_URL = "not a url";
    process.env.PAPERCLIP_ALLOW_EXTERNAL_TEST_DATABASE = "1";
    expect(() => resolveExternalTestDatabaseUrl()).toThrow(
      /valid PostgreSQL connection URL/,
    );
  });
});
