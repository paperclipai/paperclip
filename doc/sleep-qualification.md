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

The helper records its exact symlink targets in
`server/node_modules/.paperclip-sleep-otel-links.json`. If an owned temporary prefix
disappears, rerunning repairs only those matching recorded symlinks. Existing
matching packages are left alone. An unrecorded dangling link or other entry is
preserved with a recovery error; its pathname is not evidence of ownership.
`node scripts/sleep-qualification/setup-otel.mjs --cleanup` unlinks only matching
owned links. It preserves foreign replacements and keeps temporary install
prefixes for setup evidence. Remove those owned prefixes separately when their
receipts are no longer needed.

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
polling. A passive listener on the actual app HTTP server counts incoming requests
and WebSocket upgrades, including direct clients outside the harness API helper.
It requires the app's existing request and upgrade handlers before installing;
it cannot become the sole upgrade listener and change unsupported-upgrade handling.
IPC snapshots record its capture identity, installation/validity, cumulative safe-integer
counts and observation times. Both snapshots must enclose the complete quiet interval,
remain valid and yield an exact zero delta. No URL, headers or body are recorded;
snapshot reads themselves make no HTTP requests or SQL queries. Missing or detached
capture, malformed counts and the legacy empty `observerRequests` list cannot prove
quiet. The passive protocol proxy separately measures database effects. It obtains
two owned signed safety reports after the window and preserves fixture history.
After ordinary API reactivation it waits another full real ten-minute cooldown,
measures another 90 seconds of quiet and requests fresh owned eligibility proof.
The helper keeps its legacy defaults for existing maintenance tests.

Announcements are enabled and the actual route/feed service validates and caches
the known fixture. An owned test-child module wrapper injects the existing feed
transport seam for the exact default HTTPS URL; unmatched requests fail. Startup
fails if the wrapper did not intercept the actual app constructor. The receipt
requires one named fetch and no subsequent calls during quiet. Browser mode also
requires the fixture copy to render. The production DNS/HTTPS address guard stays
unchanged and is not exercised in this combined case; its owning tests cover that
boundary separately. Active user activity can legitimately keep an instance awake.

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
The digest uses `logicalSleepConfiguration(configuration)`: explicit backup interval
and checkpoint policy, announcements, telemetry activation, OTLP activation/protocol,
and UI activation in a fixed order. It excludes ephemeral loopback ports. Compute
the expected logical contract independently before starting the fixture; the
evaluator recomputes the receipt digest. Keep actual `collectorOrigins.telemetry`
and `.otel` separately, matching the actual configuration and optional expected
origin bindings.

Configured coverage must also have recorded observations. Announcements require
actual interception, a request for the expected feed, and no unmatched URL.
`signalObservation` records telemetry requests, trace requests, actual OTLP span
records and the named qualification span separately. Metric, log, malformed-trace
and unexpected request counts must be explicitly zero. The assembled case freezes
these observations after each quiet window; feature booleans are derived from
them and the observed backup checkpoint. Missing or malformed counts fail local
qualification even when a feature flag claims success.

Before the normal cooldown, a signed diagnostic-only inventory saves both raw
reports. It explicitly expects the active API cooldown aggregate and the skipped
backup diagnostic; every other reported blocker must be absent. Aggregate local
probes cannot identify which probe is present, so this early inventory never
proves eligibility. Its hold is released before the full unchanged cooldown.
After quiet, raw ordinary reports are saved before assertions; a refusal also saves
a diagnostic report under that hold.

Automatic backup coverage requires a new archive from the normal idle checkpoint,
not an enabled flag. After quiet counters freeze, the harness reads every new
owned gzip through its trailer, hashes compressed bytes, checks nonempty SQL for
the fixture identifier without retaining contents, and observes the wake marker
and absence of backup failure markers. This local evidence carries no provider
volume or restore claim. The owning backup suite separately qualifies restoration.
Archive provenance uses a positive finite opened-file birthtime, falling back to
positive finite content mtime only when the filesystem reports birthtime as zero.
The selected timestamp and its source are recorded. Existing names, old positive
birthtimes, malformed timestamps and future chronology remain disqualifying.
Original receipts are retained as produced; the new evidence fields are not
retroactively added to earlier runs.
The historical Full Y at `487e450b` and short composition at `57744f4e` wrote an
unmeasured empty observer-request list. Their recorded SQL, connection, outbound,
browser and producer observations remain pinned to those runs, but that list does
not meet the corrected inbound-observation contract. A new combined qualification
requires both real cooldowns and quiet windows with the installed incoming counter;
a short injected-poll regression cannot retroactively establish observer absence.
Receipt finalization follows all observations and runs the same evaluator before
writing the final receipt. A return-to-idle claim also needs explicit in-run quiet
start/end timestamps spanning at least 90 real seconds after the latest wake;
a duration field alone cannot prove it.
The evaluator rejects mismatched identities and chronology. Missing evidence stays
`INCONCLUSIVE`; a measured failed condition is `NOT VERIFIED`, including an
identity-verified active Neon endpoint or exact Railway service with running deployments. It does not produce
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

The browser uses a fresh owned Chromium profile and loopback debugging endpoint.
It attaches with `connectOverCDP({ noDefaults: true })` to the native default
context. Normal Playwright contexts install focus emulation that kept real
background tabs visible in the measured failure. This path avoids that override.
The receipt includes native window IDs, initial/final visibility and passive
visibility events for the entire 90-second interval. An intervening activation
fails the observation. Cleanup disconnects, terminates only the owned process and
removes its temporary profile. It never attaches to a user's existing browser.


## Managed fixture preflight

Configured qualification uses the supported managed authenticated profile. The
actual app runs on loopback, with a lifetime-stable fixture vault key and the
normal managed configuration. A fixture Cloud front door supplies trusted tenant
headers to invoke the real primary-company/user/membership provisioning path;
ordinary company creation remains forbidden. Bearer-key and signed-control
requests omit tenant headers. Native browser headers can reach only the owned
app origin; foreign HTTP/WebSocket transports are blocked and fail qualification.

Managed application storage requires S3. A bounded loopback protocol fixture
supplies the remote object service for actual SDK requests; unsupported operations,
framing and conditional requests fail closed. This establishes neither provider
IAM nor durable S3 storage. The instance home and database archives remain real
local filesystem paths. Normal managed migration, historical cleanup and routine
owners remain enabled. The logical digest binds managed activation, auth mode and
storage provider; actual ephemeral transport origins are recorded separately.

Before another long campaign, run the opt-in `sleep-managed-preflight.test.ts` on
its own root-leased fresh external database using
`PAPERCLIP_SLEEP_MANAGED_PREFLIGHT=1` and an explicit dedicated
`PAPERCLIP_SLEEP_MANAGED_PREFLIGHT_TEST_DATABASE_URL`. Retain artifacts with
`PAPERCLIP_MAINTENANCE_KEEP_ARTIFACTS=1`. It uses the same profile and negotiated
broker receiver, provisions real authority, admits and completes one process run,
and proves real key activity through signed diagnostics. It performs no browser,
ten-minute wait or quiet-window claim. No embedded allocation or automatic drop.
Loopback execution requires the host tool's explicit network/runtime permission.

Setup and successful browser receipts are written immediately before later
assertions. Early diagnostics first use the existing owner-settled contract; they
reject durable blockers immediately and retry only observed local in-flight /
generation inspection incompleteness, up to three rounds. Every attempt is saved.
Both accepted reports must be strict, complete, structurally matching and under
the exact live hold, with each internal `inspection.generation=none` and no active
work before/after. Real HTTP authentication itself changes the global work
counter, so equality across deliberate observer requests is not asserted.

A fresh successful opaque-key request anchors the later full real cooldown.
Neither setup stabilization nor the fast preflight substitutes for both real
600100ms cooldowns, both untouched 90000ms windows and useful reactivation. S3
observations are saved before and after owned app cleanup, including failures;
cleanup preserves the original error. Full provider sleep remains a separate
unqualified layer until an exact deployed target is authorized and observed.
