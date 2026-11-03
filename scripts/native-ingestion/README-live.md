# Live-provider ingestion acceptance

These helpers accompany the separate live-provider functional journey. They do
not generate performance acceptance measurements. The deterministic paired
experiment and profile-only tools are documented in the shared `README.md`.

## Exact helper provenance

The following files are byte-for-byte copies of the successful November 3, 2026
helpers. Paths in this table describe their original temporary locations.

| File | Original in `/private/tmp/` | SHA256 |
| --- | --- | --- |
| `live-launch.mjs` | `native-ingestion-live-launch.mjs` | `353a1b1cf2ee38551349617e91c95cdfb4d0021abf55be62e7058319b8e5b6bd` |
| `live-browser.mjs` | `native-ingestion-live-browser.mjs` | `cf34b0f7bb8a4f84786a38f1c90b750e7a336b126e6e2bc25647095c1eac9fab` |

The successful environment was macOS arm64, Node 26.4.0, compiled revision
`6afeba4edafd47120e8117f736641d5424b27d4a`, local embedded PostgreSQL,
OpenCode 1.18.34, and `openrouter/deepseek/deepseek-v4-flash-0731`. The launcher
deliberately retains its macOS `/private/tmp/` data-directory prefix and that
provider/model selection. It is not a qualified portable launcher. It reads
`PAPERCLIP_PI_QUALIFICATION_OPENROUTER_API_KEY` from the environment and provisions
an encrypted instance secret through the normal test-drive API bootstrap.
Supply the credential privately; do not put it in arguments, logs or evidence.

## Repeating the functional journey

Use an independently installed and normally built application checkout. Its
source revision and compiled build stamp must equal the explicit expected
revision. The launcher uses the normal onboarding configuration boundary and
explicitly starts `server/dist/index.js` with the shipped static UI. It imports
source CLI configuration/bootstrap helpers through the existing TSX loader; it
does not start the source server or Vite.

Choose a new owned evidence directory. `TOOLS_CHECKOUT` contains these helpers;
`APP_CHECKOUT` contains the compiled application being tested. In the first
terminal:

```sh
node --import "$APP_CHECKOUT/server/node_modules/tsx/dist/loader.mjs" \
  "$TOOLS_CHECKOUT/scripts/native-ingestion/live-launch.mjs" \
  "$APP_CHECKOUT" "$EXPECTED_REVISION" "$LIVE_EVIDENCE_DIR"
```

Wait for its ready receipt. In a second terminal:

```sh
node --import "$APP_CHECKOUT/server/node_modules/tsx/dist/loader.mjs" \
  "$TOOLS_CHECKOUT/scripts/native-ingestion/live-browser.mjs" \
  "$LIVE_EVIDENCE_DIR/live-launch.json"
```

The browser uses ordinary visible controls to create a task, requires an
ordinary stored delta to match visible text while the run is running, observes
a native tool/result, reloads, and independently reads the run events through
the API. A second task clicks Stop during a running `bash` command, requires
cancellation acknowledgement, and reloads to check settlement. Trace, video
and screenshots are intentional functional evidence here; none enter the paired
performance measurements.

While the owned app/database remain available, run the independent verifier
below. Afterwards, gracefully stop only the launcher process, confirm its HTTP
and database ports and provider processes are gone, and remove only its recorded
credential-bearing `dataDir`. Keep cleanup results separately. The exact copied
launcher retains the directory, so process exit alone is not data cleanup.
Before publishing retained browser artifacts, scan the files and decompressed
trace archive for the actual qualification credential without printing it.

The historical successful journey verified success run
`212cf2b8-8e8f-42e0-9fa3-4139d84d4e11` and Stop run
`9607febf-864e-4ddd-b82a-95ea4420821e`; both temporary databases are now removed.
Its direct database proof recorded 105/73 global rows and 84 canonical source
digests. The observed 1,978 ms Stop acknowledgement is one functional sample.
The earlier observer failure remains excluded and retained in the task evidence.

## Reconstructed independent database verifier

`verify-database.mjs` is a new, independently implemented reproducible utility.
It is not the historical command that produced those 84 digest checks and cannot
retroactively verify a deleted database. It imports only the raw `postgres`
dependency resolved from the supplied repository. No application service,
Drizzle schema, production payload decoder or digest helper is imported.

Supply `PAPERCLIP_NATIVE_INGESTION_VERIFY_DATABASE_URL` privately with a bare
`postgres://` or `postgresql://` URL for the disposable loopback database. Only
`127.0.0.1`, `localhost` and `::1` are accepted. Query-string/fragment overrides
are rejected, preventing a URL option from replacing that host. The URL is
never printed. The utility expects the additive cursor schema to be installed.

```sh
node "$TOOLS_CHECKOUT/scripts/native-ingestion/verify-database.mjs" \
  --repository="$APP_CHECKOUT" --company-id="$COMPANY_ID" \
  --run-id="$SUCCESS_RUN_ID" --run-id="$STOP_RUN_ID" \
  --require-current-projection --output="$LIVE_EVIDENCE_DIR/independent-database-proof-new.json"
```

All SQL is parameterized and scoped to the explicit company and run bindings.
The utility opens one `READ ONLY`, `REPEATABLE READ` transaction and confirms
those settings before reading. It reads the raw JSONB representation with
`payload::text`, independently restores the lossless reserved envelope, and
recomputes each PRP event's sorted-key canonical SHA256. It checks source/global
identity uniqueness, column/envelope agreement, run/agent/company binding, and
the complete global sequence allocation. It does not use API-returned objects
as its database evidence.

When the projection marker equals `next_event_seq - 1`, the utility reconstructs
each source's contiguous prefix and disjoint received ranges from stored positive
source sequences and compares both derived tables. With a stale marker it skips
both projection queries/reconstruction and reports `projectionChecked: false`;
`--require-current-projection` makes that situation fail. A sparse Stop source
may correctly retain a gap and a higher pending range. That does not imply all
raw wire-acknowledged output was durably committed.

This utility expects the complete history of a disposable fixture. Retention or
manual deletion can legitimately remove historical rows and makes this complete
fixture proof unsuitable. It reads all selected event rows within one snapshot;
it is a verification tool, not a bounded ingestion worker or a performance test.
Output contains counts, bindings and cursor/range summaries, not raw transcript
payloads or connection credentials. Successful output is emitted only after
the database connection is closed; an output file is created exclusively with
mode `0600` and never overwritten. Controlled validation codes are printed on
failure; unexpected driver error details are suppressed to protect connection
information.

The embedded self-test exercises independently specified canonical digest
fixtures, NUL/reserved-key restoration, numeric object-key ordering, multiple
sparse sources, stale-marker behavior, identity conflicts and projection
conflicts without opening a database:

```sh
node "$TOOLS_CHECKOUT/scripts/native-ingestion/verify-database.mjs" --self-test
```

Its self-test and syntax checks passed during packaging. The actual CLI was also
qualified against an owned minimal PostgreSQL 18.1 fixture: five global rows,
four losslessly encoded canonical events, and two sparse sources verified; a
persisted bad digest and a persisted bad cursor each caused the expected
failure. PostgreSQL's own log recorded `BEGIN ISOLATION LEVEL REPEATABLE READ
READ ONLY`. Restoring the fixture passed again. The cluster was stopped, its
port independently verified closed, and its data directory removed.

The initial synthetic fixture accidentally passed an already serialized JSON
string to an inferred JSONB parameter and the verifier rejected it as
`payload_not_an_object`. That failed receipt remains retained. Correcting the
private fixture to use the raw driver's explicit JSON object wrapper produced
the successful qualification without changing verifier code. This is fixture
qualification evidence, not a repeated live-provider journey. Every future real
database invocation must retain its own revision/environment/cleanup receipt.
