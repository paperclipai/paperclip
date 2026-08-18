// Single source of truth for the Vitest hook budget of suites that boot an
// embedded PostgreSQL cluster in `beforeAll`.
//
// RBR-918: this used to be an inline third argument on every `beforeAll` that
// called `startEmbeddedPostgresTestDatabase` — 151 of them, most at `20_000`.
// The real cost of booting embedded Postgres and applying migrations is ~92s on
// developer hardware, so those budgets were below the floor and the hooks could
// not complete. An inline hook budget also wins over the `--hookTimeout` CLI
// flag, so the drift could not be corrected from CI configuration.
//
// Keep the budget here and let every project's `vitest.config.ts` read it. Do
// not reintroduce inline hook budgets on embedded-Postgres hooks; the audit in
// `scripts/audit-embedded-postgres-hook-budgets.mjs` fails the build if you do.

/**
 * Hook budget (ms) for suites that boot embedded Postgres. Sized well above the
 * observed ~92s boot + migrate cost so a loaded CI runner still completes the
 * hook, while a genuinely hung hook is still caught.
 */
export const EMBEDDED_POSTGRES_HOOK_TIMEOUT_MS = 180_000;

/**
 * Teardown budget (ms). `stopEmbeddedPostgresBounded` already caps the graceful
 * stop at 5s, so this only needs headroom for the data-dir reclaim.
 */
export const EMBEDDED_POSTGRES_TEARDOWN_TIMEOUT_MS = 60_000;

/**
 * Floor used by the audit. Any inline hook budget on an embedded-Postgres hook
 * below this value is a defect, because the hook cannot finish inside it.
 */
export const EMBEDDED_POSTGRES_MIN_HOOK_BUDGET_MS = 120_000;
