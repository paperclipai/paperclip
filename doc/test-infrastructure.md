# Test infrastructure

Internals of the local and CI test tooling, plus the benchmarks and live smoke tests. For everyday commands, see [DEVELOPING.md](DEVELOPING.md#test-commands).

## Runner transport suite

The Runner transport suite keeps attachment recovery, warm attachment, live
adoption, and suspension in separate test files. Vitest can schedule these
independent fixtures on its existing file workers; cases within each file stay
serial. The package sequencer starts the ten files measured above 50 seconds in
the November 4, 2026 AWS run first, ordered by approximate duration. This includes
transport deadlines, settlement, provider launch, recovery, and streaming waits,
so fresh CI runners do not have to infer duration from file size. Package CI uses
up to four workers, bounded by available CPUs; local runs retain Vitest defaults.
Vitest's file selection and shard membership are unchanged. Real lease/deadline
waits and assertions are unchanged. Run the complete
family, including the separate deadline and settlement regressions, with:

```sh
pnpm --filter @paperclipai/paperclip-runner exec vitest run runnerd-codex-transport
```

## Embedded Postgres template cache

To run the suite with one owned PostgreSQL server and a separate disposable
database for each fixture, use:

```sh
node cli/node_modules/tsx/dist/cli.mjs packages/db/src/test-postgres-command.ts
node cli/node_modules/tsx/dist/cli.mjs packages/db/src/test-postgres-command.ts -- pnpm exec vitest run --project @paperclipai/db
```

The command starts an embedded server, prepares a migrated database template,
passes it to the child command, and waits for server shutdown before returning.
It preserves the child command's exit status. On cancellation it stops and waits
for the test process group before shutting down PostgreSQL. Database, server,
and CLI fixtures all use the common implementation. Tests of embedded startup itself continue to
start dedicated clusters.

To reuse a disposable server that you already manage, set
`PAPERCLIP_TEST_POSTGRES_ADMIN_URL` to its administrative PostgreSQL URL. The role
must be able to create databases. Each fixture creates a random database and
closes only its clients before dropping it. It never stops the external server.
`DATABASE_URL` does not select this test path. The optional
`PAPERCLIP_TEST_POSTGRES_TEMPLATE` can name an existing migrated database with
the form `paperclip_test_template_<hex>`; `0` disables template reuse.

On a supported platform, PostgreSQL startup failures fail test collection.
Resource exhaustion, unavailable configured servers, and broken native binaries
do not make integration tests skip. A genuinely unsupported platform or CPU can
still skip embedded PostgreSQL coverage. Startup retries apply only to port
collisions. Teardown waits for process exit, requests fast shutdown first, and
uses immediate PostgreSQL shutdown if needed. A failed stop fails the hook and
retains its data directory. Worker termination also requests owned server
shutdown. A forced `SIGKILL` can bypass these handlers; the separate host cleanup
job remains the backstop for stale macOS semaphore sets.
Database and CLI hooks use the same 30-second deadline as server hooks. This
allows the ten-second shutdown protocol and client/database cleanup to finish
before the test runner ends a worker. A shutdown timeout still fails the hook.
Template publication uses `pg_ctl` to request clean fast shutdown on every
supported platform and allows thirty seconds for it. A template is never
published after immediate shutdown or a crash. Cancelling the shared-server
command also waits for its owned cluster-directory cleanup after the test
processes and PostgreSQL exit. Direct worker termination stops PostgreSQL but
retains its disposable files for inspection; the synchronous exit guard cannot
await directory removal.
Stopped cluster directories are removed asynchronously, and cleanup awaits their
removal. Large suites can leave many relation files; deleting them must not block
the worker's event loop. The idle-sleep suite uses the existing 90-second fixture
budget for its final directory cleanup after hundreds of table truncations.

Suites that call `startEmbeddedPostgresTestDatabase` (from `@paperclipai/db`)
without an administrative URL get their own embedded Postgres cluster. The first such suite on a host builds
one fully migrated cluster and publishes its data directory under
`$TMPDIR/paperclip-embedded-postgres-templates-<uid>/<key>`. Every later suite
copies that template and starts Postgres on the copy instead of running
`initdb` and all migrations again, and the `getEmbeddedPostgresTestSupport`
probe reuses it instead of starting a throwaway cluster. The key hashes the
embedded-postgres version, the initdb flags, and every migration file, so a
changed migration builds a new template. Each suite still runs
`applyPendingMigrations` on its copy, which is a no-op when the template is
current. Templates for other keys are removed after seven days without use.

A template is a Postgres data directory, and starting it executes its
configuration, so the cache is private to the current OS user: the root is
created with mode `0700` and is only used when it is a real directory (not a
symlink) owned by the current user with no group or world write bit, and each
template is checked the same way before it is copied. A root that fails those
checks (for example one pre-created by another user in a shared `/tmp`) is left
alone and every suite in that process uses a fresh cluster.

Set `PAPERCLIP_TEST_POSTGRES_TEMPLATE=0` to bypass the cache and give every
suite a fresh `initdb`, for example when debugging cluster startup itself. A
failure on the template path (root checks, build, copy, start, or publish)
falls back to the fresh path automatically, so the cache can make a suite
slower but never fail it or skip it: a migration that cannot apply still fails
the suite on the fresh path.

## Seeded database statistics and teardown

After seeding a large population, run `ANALYZE` on the populated tables before
measuring or exercising it. The empty template has no statistics for those rows,
and waiting for automatic analysis can cause slow query plans and test timeouts.
The census and review-attention equivalence suites retain their full populations
and original deadlines while analyzing their fixture tables before the checks.

Tests that exercise route-triggered heartbeats must await
`drainActiveRunExecutions()` before deleting fixture rows. A completed HTTP
response can still have wake admission in flight; draining only run executions
would leave that writer racing with deletion.

Setup destination admission uses `NO KEY UPDATE` on the endpoint. It serializes
competing admissions while permitting `KEY SHARE` from resource foreign-key
checks. The concurrency regression uses the real `ensureResource` write and
connector invalidation triggers, with barriers to force the endpoint/agent lock
order. Restoring `FOR UPDATE` produces PostgreSQL deadlock code `40P01`.

## Typecheck memory

TypeScript 7 is a native binary, so `NODE_OPTIONS=--max-old-space-size` does not
limit `tsc`. Its peak memory depends on how much source one process checks and on
the number of checkers, because each checker keeps its own copy of the types.

`pnpm --filter @paperclipai/server typecheck` does not check one program.
`server/scripts/typecheck-layers.mjs` reads the import graph and runs one `tsc`
process per layer. Each layer reads the earlier layers as declarations:

| Layer | Files |
| --- | --- |
| `below` | Files the largest import cycle depends on, and unrelated files |
| `cycle` | The largest import cycle |
| `above` | Files that depend on the cycle |
| `tests` | Test files outside `src/__tests__` |
| `test-tree-0` to `test-tree-2` | `src/__tests__`, in shards |

The generated configs and declarations go in
`server/node_modules/.cache/paperclip-typecheck`. You do not maintain a layer list.
`server/tsconfig.json` remains the single program for editors and `pnpm build`.
The server typecheck builds only the Runner's TypeScript output. Use
`pnpm --filter @paperclipai/paperclip-runner build` when a local check needs the
Runner binary.

`node server/scripts/typecheck-layers.mjs --layer <name>` checks one layer
against the configs and declarations that an earlier `--declarations-only` run
left in that directory. It does not write them again. Stale declarations pass
silently, so use it only straight after `--declarations-only` on the same commit.

If a compiler child terminates on a signal, the wrapper reports the signal,
layer, command, and working directory on stderr, then stops with a nonzero exit.
Compiler stdout and stderr remain visible. A signal such as `SIGKILL` alone does
not establish that the process ran out of memory.

`src/__tests__/tsconfig.json` holds the options for the test-tree layers, so an
editor and the typecheck report the same errors. Server tests reach Daytona plugin
source, but the root install does not install that plugin's dependencies. So this
config maps `@daytonaio/sdk` to `server/scripts/typecheck-stubs/daytona-sdk.d.ts`.
The plugin's own project checks that source against the real package.

If the memory available to the task is limited, use this command:

```sh
node scripts/typecheck-low-memory.mjs
```

It peaks at about 3.8 GiB, against about 5.5 GiB for `pnpm -r typecheck` on 16
cores. It also takes about twice as long.

It checks one package at a time and uses one thread for the server layers and the
UI. Do not add `GOMEMLIMIT` to this path. It saves at most 300 MiB here, and it
slows `tsc` by up to 20 times when the live heap goes above the limit.
`pnpm build` uses `server/tsconfig.build.json` for the production server compile.
It excludes colocated test modules and the top-level test helper tree. The source
typecheck still includes the tests. Compiler memory use depends on the runtime
source graph and checker count; excluding tests does not set a memory limit.
The Docker image sets `PAPERCLIP_TSC_EMIT_ONLY=1` for that build, which emits
JavaScript without checks or declarations.

Test projects outside `pnpm -r` import server source through relative paths. Each
project's `tsconfig.layers.json` reads that source as layer declarations. This
command builds the declarations and then checks every project:

```sh
node scripts/typecheck-test-projects.mjs
```

Name a project to check only that project. `pnpm test:e2e:runner:typecheck` and
`pnpm test:lifecycle-baseline:typecheck` do this for their projects. If the memory
available to the task is limited, add `--low-memory`, or set
`PAPERCLIP_TYPECHECK_LOW_MEMORY=1` for the pnpm commands.

The command fails if a project loads server source, because that is what makes
these programs large. It does not limit memory. CI runs it with
`--reuse-declarations` after the server declarations of the same run, so it does
not build the declarations again. Do not use that option when the declarations
can be stale.

Add each new test project that imports server source to `PROJECTS` in
`scripts/typecheck-test-projects.mjs`.

Keep the project references out of each project's `tsconfig.json`. Vitest reads
that file, and it fails when a referenced config does not exist yet. The
`tsconfig.json` files remain single programs for editors, and
`tests/runner-e2e/native-completion-checks.mjs` still checks that project as one
program. That program peaks at about 15 GiB at default settings and about 8 GiB on
one thread.

## Typecheck test files outside the build

Most package tsconfigs exclude tests, and Vitest strips types, so a type error in
one of those tests fails nothing. `scripts/typecheck-test-programs.mjs` reads them
through separate programs, usually a `tsconfig.test.json` beside the package's
`tsconfig.json`:

```sh
node scripts/typecheck-test-programs.mjs --low-memory
node scripts/typecheck-test-programs.mjs packages/paperclip-runner/tsconfig.test.json
```

The first form runs in the required `Typecheck + Release Registry` job, split in
two: `--prepare-only` installs the sandbox providers and builds what the programs
read, and `--skip-prepare` then only checks. It checks
one program at a time and the largest peaks below 2 GiB. It then fails if a tracked
`*.test.ts(x)` or `*.spec.ts(x)` file is in no program. The compiler's file list
decides that, because `include` silently drops `foo.test.tsx` when `foo.test.ts`
exists.

To add a test directory, add it to the `include` of the package's
`tsconfig.test.json`. To add a package, add a program to `PROGRAMS` in the script.

Sandbox providers are outside the root workspace, so the root install has none of
their SDKs. `scripts/typecheck-sandbox-providers` is a small workspace that lists
them and holds one lockfile. Its install replaces any standalone `node_modules` in
those providers. After you change a provider's `package.json`, do not refresh or
commit that lockfile. `typecheck:test-programs` resolves a stale lockfile in place
for the run, and the lockfile refresh workflow commits the new one after merge (see
[Dependency Lockfile Policy](ci-workflows.md#dependency-lockfile-policy)).

Do not add a lockfile inside a provider.
`scripts/build-standalone-public-packages.mjs` uses a frozen install when one
exists, which changes what a release resolves. Daytona already has one; the
release build resolves it in place when it is stale.

Daytona is the one exception: it commits its own lockfile, so the workspace
leaves it out and the script installs it from that lockfile (`LOCKED_PROVIDERS`).
The same rule applies to it: do not refresh or commit that lockfile. The script
resolves a stale one in place for the run, and the lockfile refresh workflow
commits the new one after merge.

Dependabot updates the providers through this workspace (see
`.github/dependabot.yml`), and Daytona through a second entry. Dependabot does
not expand a workspace glob that starts with `../`, so
`scripts/typecheck-sandbox-providers/pnpm-workspace.yaml` lists each provider by
its full path. When you add a provider, add it there and to `SANDBOX_PROVIDERS`
in `scripts/typecheck-test-programs.mjs`. A test checks that the two lists match.

## Sandbox provider tests

`pnpm test:run` does not reach the sandbox providers, because they are outside the
root workspace. `scripts/test-sandbox-providers.mjs` installs them the same way as
the typecheck above, then runs every provider's `pnpm test`, four at a time:

```sh
node scripts/test-sandbox-providers.mjs
```

The required `Sandbox provider tests` job runs it when a pull request changes a
provider, the plugin SDK, or `packages/shared`, which the SDK imports. Those paths
are the `//#ci:sandbox-providers` inputs in `turbo.json`. Global CI inputs, such as
`scripts/**` or a `package.json`, select every job. If the SDK gets a new workspace
dependency, add that package to the inputs. A test in
`.github/scripts/tests/ci-plan.test.mjs` fails until you do.

Some Daytona file-sync tests need GNU `tar` and coreutils. They skip on macOS
unless those tools are on `PATH`, so they run only on Linux. The job turns off
core dumps: a core file in an exported directory changes the transferred file count.

## Reused Runner build in the server build

The server build vendors `packages/paperclip-runner/dist`, so its
`prepare:runner-vendor` step has to make sure that directory is a current
build. It used to run the Runner's full `build` every time. Now the Runner's
`build` brackets itself with `scripts/record-build-inputs.mjs`: `--begin`, its
first step, forgets the previous stamp and records a digest of the build's
inputs (every file under `packages/paperclip-runner` except `dist`,
`dist-browser`, `runner/target`, `provider-assets` (written by the build), `node_modules` and dot-directories; every
file under `packages/paperclip-eval-kernel` except `dist` and `node_modules`;
every file under the root `patches` directory, which the acpx profile check
hashes and the provider entrypoint bundler copies into `dist`; and the root
`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` and
`tsconfig.base.json`). `--finish`, its last step, recomputes the digest and
writes the stamp
`packages/paperclip-runner/node_modules/.cache/paperclip-runner-build-inputs.json`
only if the inputs are still the ones the build began with, together with the
path and size of every file under `dist`. An edit that lands while the build
runs leaves no stamp, so the next consumer rebuilds.
`node server/scripts/prepare-runner-vendor.mjs` reuses the build when the
stamp is for this platform, every recorded output is still there at its
recorded size, and the current digest matches. Anything else (no stamp, a
changed input, a deleted or truncated output, a stamp from another platform)
runs `pnpm --filter @paperclipai/paperclip-runner build` exactly as before, so
a standalone `pnpm --filter @paperclipai/server build` on a fresh checkout
still builds the Runner itself. Inside `pnpm build` the Runner has just been
built by the same command, and the step skips a 12-16s rebuild. The step
prints one `paperclip.runner-vendor.timing.v1` line saying which it did.

Set `PAPERCLIP_RUNNER_VENDOR_REBUILD=1` to rebuild regardless of the stamp. A
stamp is only written after a Runner build that passed every step, and both
the Runner's first build step and the prepare step remove any existing stamp
before a rebuild starts, so a build that stops partway never leaves a stamp
that vouches for it.

Set `PAPERCLIP_RUNNER_VENDOR_REQUIRE_CURRENT=1` when the Runner under
`packages/paperclip-runner/dist` was built elsewhere and this build must not
build it again, for example because it has no Rust toolchain. The step then
reuses a current build as usual. When the build is not current it prints the
reason and fails, without starting a rebuild and without removing the stamp.
Setting both variables fails. The `build` stage of the `Dockerfile` sets it:
that stage copies `dist` and the stamp out of the `runner-artifacts` stage
(see "Runner image" in `doc/DOCKER.md`).

## Task search evaluation

The task search relevance rubric and regression corpus are documented in
[SEARCH.md](SEARCH.md). Run the real PostgreSQL relevance suite with:

```sh
pnpm exec vitest run server/src/__tests__/task-search-quality.test.ts
```

Set `SEARCH_EVAL_SCALE=1` to additionally measure a disposable 10,000-task,
30,000-comment dataset. `SEARCH_EVAL_REPORT=/tmp/search-quality.json` saves
per-query results and latency measurements; scale measurements are opt-in.

## Native skill preparation benchmark

Measure native skill preparation through the production service, real PostgreSQL,
and an in-memory OpenTelemetry exporter:

```sh
pnpm --filter @paperclipai/server exec tsx scripts/benchmark-native-skill-preparation.ts
```

The default fixture has a 208-file repository of about 10.8 MB. The report includes
cold and warm resolution, a fresh service instance, detailed phase timings, and
regular-pool SQL statement counts (excluding the separate cache-lock connection).
Every delivered file is checked outside the timed section. No provider is started.
`--snapshot-file=/absolute/path/snapshot.json --entrypoint=skills/example/SKILL.md`
uses a captured repository file inventory instead. `--network-delay-ms=25` adds
25 ms in each direction through a local TCP relay; this is simulated transport
latency, not a measurement of a hosted database.

`--actor=agent` adds a real agent, run, and responsible user, then records version
pins through the same callback boundary as execution. `--staging-shape=true`
seeds 14 projects, 10 sources, 8 bindings, and 156 other skills. These match one
observed staging inventory's counts; their content is synthetic. Combine these
options to include authorization and unselected library rows in the measurement.

By default, spans stay in memory. `--export-otlp=true` also exports them using
the operator's `OTEL_EXPORTER_OTLP_ENDPOINT`, protocol, and headers. Keep header
values out of command arguments and reports. The report records source hashes,
the export mode, and trace IDs. Exported traces identify this local diagnostic
in their service version; they are not evidence of staging performance.

If creating another embedded cluster is impractical, `--postgres-port=55448
--postgres-user=paperclip` uses an existing **local** server. It creates and migrates
a uniquely named disposable database and drops that database afterward; it does
not reuse an application database.

## Repository workspace admission benchmark

Measure a fresh checkout with and without the repository object cache:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-repository-object-cache.ts
```

This uses a synthetic 32 MiB repository and the real `file://` Git transport.
It reports cache priming separately, then alternates five fresh checkouts per
mode. Git's pack trace records received bytes. Each checkout has independent
objects and passes `git fsck`. There is no injected latency or hosted network
measurement.

Measure cold sandbox staging with a disposable 10,000-file Git repository:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-workspace-staging.ts --baseline-ref=origin/master
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-workspace-staging.ts --baseline-ref=origin/master --transfer-delay-ms=3000
```

The benchmark alternates the baseline and current implementations. Both pack,
verify, copy and extract real archives, then compare the resulting tree and Git
HEAD. It retains dirty, deleted and untracked-file semantics and excludes ignored
files. The transport is a local copy. The optional delay models a slow transfer;
it does not measure hosted network or agent latency. The report contains every
sample, whole-staging wall time, archive bytes and phase durations. Seed
verification and upload can overlap, so do not sum their durations. The script
temporarily imports baseline source beside the current source and removes it on
exit. Run without other repository edits or heavy I/O for a useful comparison.

Measure the real repository preparation service with a disposable embedded
PostgreSQL database and synthetic history, without invoking an agent:

```sh
pnpm perf:workspace-admission
pnpm perf:workspace-admission -- --realpath-delay-ms 2.3
pnpm perf:workspace-admission -- --distinct-cwds --realpath-delay-ms 2.3
```

Defaults model 8,516 workspaces, 27,971 provenance records and 28 retained
readers on the shared root. The first command measures ordinary local I/O;
the others inject filesystem metadata latency for sensitivity comparisons.
Injected latency does not establish the actual latency of a hosted volume.
`--distinct-cwds` creates separate folders to exercise bounded concurrent I/O.
`--service /absolute/path/to/baseline/server/src/services/execution-workspace-repositories.ts`
compares another checkout, which needs its workspace dependencies installed.
The JSON report times only the service call, counts filesystem lookups and SQL
statements, and verifies retained source identities. Setup and cleanup are
excluded. Source tasks and permissions are synthetic; this is not an end-to-end
agent latency measurement.

## OpenClaw Join Smoke Test

Run the end-to-end OpenClaw join smoke harness:

```sh
pnpm smoke:openclaw-join
```

What it validates:

- invite creation for agent-only join
- agent join request using `adapterType=openclaw_gateway`
- board approval + one-time API key claim semantics
- callback delivery on wakeup to a dockerized OpenClaw-style webhook receiver

Required permissions:

- This script performs board-governed actions (create invite, approve join, wakeup another agent).
- In authenticated mode, run with board auth via `PAPERCLIP_AUTH_HEADER` or `PAPERCLIP_COOKIE`.

Optional auth flags (for authenticated mode):

- `PAPERCLIP_AUTH_HEADER` (for example `Bearer ...`)
- `PAPERCLIP_COOKIE` (session cookie header value)

## PostHog MCP Live Smoke Test

The PostHog smoke targets an already-running authenticated Paperclip instance.
It is deliberately separate from `pnpm test` and `pnpm test:e2e` because it
uses a live vendor OAuth flow and creates a short-lived connection plus one
fresh-run proof issue.

```sh
INTEGRATIONS_POSTHOG_PAPERCLIP_E2E_EMAIL=operator@example.test \
INTEGRATIONS_POSTHOG_PAPERCLIP_DEV_LOGIN_PASSWORD='<environment-delivered>' \
INTEGRATIONS_POSTHOG_POSTHOG_PROJECT_ID=483530 \
pnpm smoke:posthog-live https://paperclip.example.test
```

The command fails before browser launch unless all three integration bindings
are present, and never prints their values. A Paperclip heartbeat derives the
target origin from its injected `PAPERCLIP_API_URL`; the positional URL (or
`--base-url <url>`) selects the running instance for a manual invocation. It
creates no trace, video, or HAR, begins
screenshots only after OAuth returns to Paperclip, enables read actions only,
installs the connection on `CodexCoderPro` only, runs `project-get` with `{}`
from the board Test panel and a fresh agent run, then removes the connection.
Sanitized JSON and PNG evidence defaults to `PAPERCLIP_RUN_SCRATCH_DIR` when the
command runs in a heartbeat; set `POSTHOG_EVIDENCE_DIR` for a different output
directory.

Run the focused harness checks without contacting Paperclip or PostHog:

```sh
node --test scripts/smoke/posthog-live.test.mjs
```

## OpenClaw Docker UI One-Command Script

To boot OpenClaw in Docker and print a host-browser dashboard URL in one command:

```sh
pnpm smoke:openclaw-docker-ui
```

This script lives at `scripts/smoke/openclaw-docker-ui.sh` and automates clone/build/config/start for Compose-based local OpenClaw UI testing.

Pairing behavior for this smoke script:

- default `OPENCLAW_DISABLE_DEVICE_AUTH=1` (no Control UI pairing prompt for local smoke; no extra pairing env vars required)
- set `OPENCLAW_DISABLE_DEVICE_AUTH=0` to require standard device pairing

Model behavior for this smoke script:

- defaults to OpenAI models (`openai/gpt-5.2` + OpenAI fallback) so it does not require Anthropic auth by default

State behavior for this smoke script:

- defaults to isolated config dir `~/.openclaw-paperclip-smoke`
- resets smoke agent state each run by default (`OPENCLAW_RESET_STATE=1`) to avoid stale provider/auth drift

Networking behavior for this smoke script:

- auto-detects and prints a Paperclip host URL reachable from inside OpenClaw Docker
- default container-side host alias is `host.docker.internal` (override with `PAPERCLIP_HOST_FROM_CONTAINER` / `PAPERCLIP_HOST_PORT`)
- if Paperclip rejects container hostnames in authenticated/private mode, allow `host.docker.internal` via `npx paperclipai allowed-hostname host.docker.internal` and restart Paperclip

## Sidebar badge run-query benchmark

The badge query keeps the newest 200 runs of nonterminated same-company agents.
It selects each agent's first observed run before status or Mine filters. An
observation ordinal preserves equal-time input order. Per-agent ranking orders
by full creation time first, then that ordinal for exact ties. SQL returns only failure
IDs, issue bindings, and creation times. Dismissals and fresh issue authorization
still run in the service.

Run the synthetic PostgreSQL comparison with a pinned pre-change revision:

```sh
PAPERCLIP_LOG_LEVEL=error SIDEBAR_REQUIRE_BYTE_REDUCTION=1 pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-sidebar-badges.ts --baseline-ref=bf3ef12f3a78d0b15a32ad57f7e16520fbf6cd5e
```

The harness starts disposable embedded PostgreSQL by default. To use an existing
isolated test database with current migrations, set
`PAPERCLIP_SIDEBAR_TEST_DATABASE_URL` to a dedicated database whose name ends in
`_test`. The harness removes only its own synthetic company fixtures. Do not use
a development or hosted company database.

The report includes service-generated SQL, complete badge equality, candidate
bindings, alternating warm samples, plans, and UTF-8 response-value bytes before
Drizzle decoding. This byte count excludes protocol framing. The mixed fixture
covers shared agents, superseding successes, timestamp ties, Mine users,
dismissal equality, private and deleted issues, and more than 200 runs. The
all-failed, all-succeeded, and empty controls expose neutral or slower paths.
Timings describe local SQL work and do not establish hosted request latency.

## Dedicated native recovery test database

The native idle continuation fixture reads `PAPERCLIP_RECOVERY_TEST_DATABASE_URL`
and passes it through `nativeRestartFixture({ dedicatedDatabaseUrl })`. The URL
must name a dedicated PostgreSQL database ending in `_test`, without database-name
or connection-option overrides. This explicit option applies pending migrations
and closes registered clients at cleanup; it does not create or drop that
database. Its provisioning owner remains responsible for disposal. The environment
variable alone does not opt other `startRecoveryPostgres()` callers into shared
storage: they retain their existing fresh-database allocation and cleanup.

The native idle-sleep continuation integration uses a controlled local provider
with the real heartbeat queue, authorized comment wake, native session
checkpoint, files, retained secret encryption and fresh resolution, and owned
idle preflight. Credential resolution through the secret owner does not prove
production backend credential injection. It uses an explicit two-connection
main pool, alongside the production auxiliary pools, and verifies the driver's
actual setting. It does not
exercise the remote Runner harness backup transport or a live provider.

The workspace runtime lifecycle test uses the actual local runtime owner and an
ephemeral HTTP child. Normal run release must remove the original PID, listener,
and service registry entry before the same owner starts another useful service
from the retained workspace files. This is physical local resource retirement
and next-use coverage; it does not establish global tenant quiet.

The plugin idle manager lifecycle test uses a real SDK worker process and a
controlled host state handler that persists worker requests to a temporary file.
It checks the actual manifest generation, refusal of work under the owned hold,
and a second useful write after release. This boundary does not exercise the
production plugin database loader or plugin jobs. Unsupported manifests, active
manual resources, and missing completion receipts remain sleep blockers.

## Database-work test teardown

Database-work tests that intentionally roll back signaled writes must stop their
coordinator and call `reconcileDatabaseWork` for the affected queue during
teardown. Deleting fixture rows does not retire process-local uncertain
transactions; retaining them can add unrelated retry deadlines to the next test.
