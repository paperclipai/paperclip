import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // RBR-912: embedded Postgres boots ONCE per run in this globalSetup, and
    // suites clone a pre-migrated template database from it. That is what makes
    // the hook budget below payable — before this, every suite paid a ~50-90 s
    // cluster boot inside its own `beforeAll`.
    globalSetup: ["./src/__tests__/global-setup-embedded-postgres.ts"],
    // Suite hooks now only clone/drop a database, but under the loaded serial
    // shard (maxWorkers=1) a graceful Postgres shutdown or a slow template copy
    // can still cross vitest's default 10s hookTimeout, producing flaky "Hook
    // timed out in 10000ms" failures on CI. 30s is far above the observed
    // worst-case yet still catches a genuinely hung hook. teardownTimeout
    // mirrors it for the same reason.
    //
    // Do NOT reintroduce inline `beforeAll(fn, ms)` budgets in suites: an inline
    // argument silently overrides both this value and `--hookTimeout` on the
    // CLI, which is precisely the trap RBR-912 documents.
    hookTimeout: 30000,
    teardownTimeout: 30000,
    // RBR-945: every suite in this project is DB-backed — a single `it` does real
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
    // The shared cluster boot is charged to globalSetup, not to a test file, and
    // it can take ~90s on a cold machine.
    globalSetupTimeout: 300000,
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
