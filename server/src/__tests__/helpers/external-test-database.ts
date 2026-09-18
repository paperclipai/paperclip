/**
 * Resolve an operator-supplied external test database URL for suites that
 * perform destructive mutations.
 *
 * The gate fails closed. An external database is used only when the operator
 * sets both `PAPERCLIP_TEST_DATABASE_URL` and
 * `PAPERCLIP_ALLOW_EXTERNAL_TEST_DATABASE=1`, the URL is a PostgreSQL
 * connection URL, and its database name is an exact approved test-database
 * name ending in `_test` (for example `paperclip_test`). Near-miss production
 * names such as `production-test` or `prod` are rejected. An unconfigured
 * target returns `null` so the suite falls back to its disposable embedded
 * Postgres; a rejected target aborts before any mutation.
 */
const APPROVED_TEST_DATABASE_NAME = /^[a-z0-9]+(?:_[a-z0-9]+)*_test$/i;

export function resolveExternalTestDatabaseUrl(): string | null {
  const raw = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
  if (!raw) return null;
  if (process.env.PAPERCLIP_ALLOW_EXTERNAL_TEST_DATABASE !== "1") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      "PAPERCLIP_TEST_DATABASE_URL must be a valid PostgreSQL connection URL",
    );
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(
      `PAPERCLIP_TEST_DATABASE_URL must be a PostgreSQL connection URL, got "${parsed.protocol}"`,
    );
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!APPROVED_TEST_DATABASE_NAME.test(databaseName)) {
    throw new Error(
      `Refusing to run destructive tests against "${databaseName || "<empty>"}": the database name must end in "_test" (for example "paperclip_test"). Point PAPERCLIP_TEST_DATABASE_URL at an isolated test database, or unset it to use embedded Postgres.`,
    );
  }
  return raw;
}
