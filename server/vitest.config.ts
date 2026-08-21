import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Each server suite boots + tears down its own embedded Postgres in
    // beforeAll/afterAll. Under the loaded serial shard (maxWorkers=1) the
    // graceful shutdown can occasionally cross vitest's default 10s hookTimeout,
    // producing flaky "Hook timed out in 10000ms" afterAll failures on CI. Give
    // the boot/teardown hooks generous headroom; 30s is far above the observed
    // worst-case teardown yet still catches a genuinely hung hook. teardownTimeout
    // mirrors it for the same reason.
    hookTimeout: 30000,
    teardownTimeout: 30000,
    // RBR-954: every suite in this project is DB-backed — a single `it` does real
    // Postgres work (insert fixtures, run service transactions, read rows back),
    // so vitest's 5000ms default `testTimeout` was never a sane budget here. It
    // was simply never set: RBR-912 governed *hook* budgets and correctly left
    // this alone, so the gap predates it.
    //
    // Why it had to change: `issue-thread-interactions-telemetry.test.ts` ->
    // "emits accepted suggested-task telemetry with created and skipped task
    // counts" produced three different outcomes from identical bytes, purely by
    // machine load — 1938ms (quiet) pass, 12266ms FAIL at the 5000ms default when
    // run alongside the other DB suites, 3032ms pass again in isolation. A ~6x
    // spread with no code change. Under `maxWorkers: 1` the whole shard shares one
    // cluster, so a loaded box stretches every test uniformly; a budget tuned to
    // the quiet case is a load-sensitive flake waiting for CI.
    //
    // Why 30000: it is ~2.4x the slowest observed loaded run (12266ms) and ~15x
    // the quiet-case cost, so it absorbs the measured load spread with headroom,
    // while still being short enough to fail a genuinely hung query rather than
    // hang a CI job. Matching `hookTimeout`/`teardownTimeout` also means there is
    // one number to reason about for DB work instead of three.
    //
    // Do NOT reintroduce inline `it(fn, ms)` / `beforeAll(fn, ms)` budgets to fix
    // a slow test: an inline argument silently overrides both this value and the
    // `--testTimeout`/`--hookTimeout` CLI flags, which is precisely the trap that
    // hid ~56 tests in RBR-912. Config level only.
    testTimeout: 30000,
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: ["./src/__tests__/setup-supertest.ts"],
  },
});
