# Supported remote ingestion fixture

This test assembly selects the production remote execution path through a
normal plugin installation, sandbox environment and agent `defaultEnvironmentId`.
The first-party `@paperclipai/plugin-fake-sandbox` plugin executes separate OS
processes in private temporary directories on the **same physical host**. It
simulates provisioning; it does not simulate the Runner, PRP connection,
PostgreSQL append path, WebSocket delivery or browser.

Use a Linux host. Current remote process supervision requires a Linux boot ID
and process start ticks; matching a Darwin daemon's binary architecture alone
does not qualify a Darwin remote environment. The fixture does not weaken this
identity check.

Build and independently install the application normally. The server stamp must
equal the application's exact source revision. The application must include the
built fake-sandbox plugin and matching native Runner daemon. The separate H3
checkout supplies driver tooling and fixture files only.

```sh
PAPERCLIP_INGESTION_TRANSPORT=sandbox-remote \
PAPERCLIP_INGESTION_SMOKE=1 \
PAPERCLIP_INGESTION_APP_ROOT="$APP_ROOT" \
PAPERCLIP_INGESTION_EVIDENCE_DIR="$NEW_EVIDENCE_DIR" \
PAPERCLIP_E2E_PORT="$OWNED_FREE_PORT" \
node node_modules/@playwright/test/cli.js test \
  --config tests/e2e/playwright-native-ingestion.config.ts
```

Run this from the test-driver checkout. Smoke emits the original 16-event case
and exercises Stop separately. It is functional qualification, never performance
acceptance. Omit the smoke flag only after the complete protocol, application
revisions, paired-run commands and acceptance rules have been frozen.

The test-only server assembly:

- Generates a private two-day CA and a signed server certificate with
  `CA:FALSE`, server authentication usage, and `127.0.0.1`/`localhost` subject
  alternative names, and terminates verified TLS in front of
  the compiled HTTP server using the existing Runner reverse-proxy contract.
- Sets the normal `PAPERCLIP_RUNNER_PUBLIC_URL`,
  `PAPERCLIP_RUNNER_CA_BUNDLE_PATH`, `PAPERCLIP_RUNNER_REMOTE_BINARY_PATH` and
  `PAPERCLIP_RUNNER_REMOTE_CODEX_PATH` inputs. Artifact staging, version checks,
  checksum checks, transport authentication and process identity remain owned
  by production code.
- Stages a deterministic Codex wrapper with an absolute Node executable and
  absolute fixture path, because staging relocates the wrapper into the remote
  runtime. Provenance records the wrapper, Node, provider fixture, daemon and CA
  hashes. Private keys are not included in provenance.
- Gives the normal environment an explicit `PATH` containing the recorded Node
  directory and fixed system directories. The fake provider's default Unix PATH
  does not contain Homebrew Node; this does not override a command resolver.

Remote mode removes the local Codex command-resolver test hook. It never forces
`controllerPersistence`, changes local raw journaling or disables certificate
verification. Before releasing each common emission epoch, a separate raw
PostgreSQL connection verifies the actual run's company/environment lease and
database controller checkpoint header in a read-only repeatable-read snapshot.
The connection reads the actual owned postmaster port, closes before the epoch,
and neither inserts fixture outcomes nor changes state. Lease verification after
timed settlement also uses the normal API.

All existing event counts, rates, marker clocks, payload caps, independent delta
checks, reload, Stop and timing gates remain. Before any Linux remote or paired
timings, the lead registered **300 seconds** for shared pre-epoch remote setup
and **900 seconds** for the whole test, allowing normal plugin/daemon staging.
The local failed protocol retains its original 180/600-second limits. Streaming,
terminal drainage and Stop acknowledgement keep their original 120/180/30-second
timeouts. Post-timing lease cleanup has a separate 30-second verification bound.
Reports record these exact values and the comparator rejects other budgets.
Remote setup and the complete 100-run workload still require qualification before
paired measurements; these resource allowances establish no latency success.

Two excluded Mac setup attempts are retained locally:

- `native-ingestion-remote-smoke-ahjnfjv3`: normal plugin/environment installation
  passed; agent verification failed before a provider turn. The launch shell's
  plain Node command was independently shown to exit 127 under the fake
  provider's default PATH. The API exposed `runner_remote_process_launch_failed`.
- `native-ingestion-remote-smoke-atl7nu5j`: explicit normal environment PATH fixed
  that missing executable; verification still failed before a provider turn.
  Static process supervision requires Linux `/proc` fingerprints, so no further
  Mac attempts or identity bypass were made. The exact second runtime cause is
  not promoted beyond the retained lifecycle failure.

Both original reports remain failures. Their owned app, TLS and actual
PostgreSQL ports were independently checked closed, known lease processes were
absent, and only their recorded temporary homes were removed. No Linux native
turn has yet passed this fixture at the time of this initial recipe.

The exact certificate-generation block passed a separate local TLS check:
the matching CA authorized the connection, an untrusted connection failed, and
an incorrect hostname failed with `ERR_TLS_CERT_ALTNAME_INVALID`. This qualifies
certificate assembly only. It does not qualify the remote Runner or any timing.
