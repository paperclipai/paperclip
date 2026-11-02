# Sleep configuration qualification

This opt-in harness boots the actual server against an explicitly supplied fresh
test database. It measures local SQL, connection and network quiet. A local pass
does not establish Railway or Neon suspension. Keep a separate verdict for each
layer: quiet, eligibility, database suspension, host suspension, backup persistence,
inbound wake, timed wake and return to idle.

## Local configured services

Use a reviewed integrated source containing the incoming-wake and domain-deadline
contracts. Provision and migrate a fresh dedicated PostgreSQL database ending in
`_test` through the normal test operator. The suite does not allocate a database,
start embedded PostgreSQL or delete a database. It preserves its fixture rows.
Never supply a live tenant database.

The configured exporter needs the exact optional peer versions already declared
in `server/package.json`. With Node 24 and npm available, explicitly install the
fixture peers into a new temporary prefix and link only missing packages in this
checkout:

```sh
node scripts/sleep-qualification/setup-otel.mjs
```

The setup leaves application manifests and lockfiles unchanged. Retain the printed
setup receipt and temporary package lock. A version mismatch fails without
replacing an installed package. An opt-in CI job must run the same setup command;
setting an OTLP endpoint alone does not qualify an exporter.

Set `PAPERCLIP_SLEEP_CONFIGURED_ACCEPTANCE=1`,
`PAPERCLIP_SLEEP_ACCEPTANCE_TEST_DATABASE_URL` to the owned migrated fixture and
`PAPERCLIP_SLEEP_CLOUD_SHA` to the exact reviewed Cloud source SHA. Set
`PAPERCLIP_SLEEP_CLOUD_CHECKOUT` to that built private checkout; the suite verifies
its HEAD and imports its production broker adapter without copying private source.
Retain artifacts
with `PAPERCLIP_MAINTENANCE_KEEP_ARTIFACTS=1`. Run the two scoped Vitest files with
one worker and no file parallelism:

```sh
pnpm exec vitest run server/src/__tests__/sleep-otel-export.test.ts \
  server/src/__tests__/sleep-configuration-acceptance.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

The first case requires a successful named span at the real local OTLP collector
and no metric or log export during 90 real seconds, beyond the SDK's default
60-second metric cadence. It fails if the production SDK falls back to no-op.
The assembled case keeps
normal automatic backups, announcements, first-party telemetry and OTel enabled.
It creates an agent, useful completed process execution, API credential and future
routine through normal APIs. It waits the real ten-minute authenticated-use
cooldown, then measures at least 90 real seconds without tenant HTTP/SQL observer
polling. IPC snapshots and the passive protocol proxy measure effects. It obtains
two owned signed safety reports after the window and preserves fixture history.
After ordinary API reactivation it waits another full real ten-minute cooldown,
measures another 90 seconds of quiet and requests fresh owned eligibility proof.
The helper keeps its legacy defaults for existing maintenance tests.

Announcements are enabled in the assembled closed-browser case. That observation
establishes absence of background server fetches. It does not claim that a remote
feed request succeeded. Feed request/cache behavior is covered by the owning
`announcement-feed.test.ts`; it injects the named remote HTTP boundary without
weakening the production address guard. Loaded background tabs and foreground
active use need their own browser evidence. Active user activity can legitimately
keep an instance awake.

The assembled scenario includes real tool approval rejection/delivery retirement
and signed chat-webhook completion followed by ordinary endpoint removal. That
removed-endpoint subcase is separate from the retained enabled GitHub connection:
the latter uses actual encrypted user credentials, refresh/continuity owners,
signed broker bindings and the production event delivery worker. The host wake
capability comes from the production connector store. Local in-memory broker
storage and synthetic GitHub HTTP responses remain explicit external boundaries;
this does not establish deployed broker durability or host suspension. These
assembled paths require a successful run against the reviewed integration before
their receipts can qualify them; source presence alone is not evidence.
Unknown plugins, persistent provider sessions, unfinished delivery/accounting,
uncertain writes and cleanup remain real blockers. Every inventory family needs
an explicit disposition before claiming all configurations qualified.

## Evaluate a receipt

```sh
pnpm exec vitest run server/scripts/sleep-qualification.test.mjs --maxWorkers=1
node scripts/sleep-qualification/evidence.mjs receipt.json expected.json report.json
```

`expected.json` binds `appSha`, `cloudSha`, `target` and a SHA-256 `configDigest`.
The evaluator rejects mismatched identities and chronology. Missing evidence stays
`INCONCLUSIVE`; a measured failed condition is `NOT VERIFIED`. It does not produce
provider proof from local counters, fake time, a registry sleep flag or a successful
control response. Preserve original failures and their raw logs after a retry.

## Deployed boundary

No deployment target is authorized by this document. The private Cloud companion
provides a gated read-only provider observer. An operator must first approve one
exact owned disposable staging target, revisions, configuration, provider refs,
fixture operations and finite observation deadline. A named connector or shared
QA workspace is not that authorization.

Capture app/Cloud identity and effective policy while awake. Use only provider and
central control-plane metadata during sleep; tenant health/API/SQL probes can wake
the target. Confirm the exact Neon endpoint is idle and all owned Railway services
have stopped deployments. Observe ordinary authorized API, broker and deadline
wake cycles separately. Verify useful persisted results and return to idle.
Automatic backup persistence additionally requires an exact attached volume
covering the configured home/backup directory and a fsynced sentinel/archive
continuity receipt across the owned stop/wake. A writable local fallback directory
is insufficient. Missing live access leaves these layers `INCONCLUSIVE`.

For actual foreground/background browser coverage, first build the shipped UI into
`server/ui-dist` in the same reviewed checkout. Install the normal Playwright
Chromium runtime and run on a display-capable worker. Set
`PAPERCLIP_SLEEP_BROWSER_ACCEPTANCE=1` for the configured suite. The harness loads
the actual UI, records an ordinary active reload, opens another real foreground
tab and requires Chromium to report the app tab hidden. It observes 90 real
seconds without app API traffic, then closes the browser before the server quiet
window. Failure to establish real visibility fails that mode; it never substitutes
a fake visibility event or frozen page. Without this explicit mode, the receipt
claims closed-browser coverage only.
