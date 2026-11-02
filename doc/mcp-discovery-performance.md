# MCP discovery resource bounds

Tool discovery shares policy inputs for one listing and projects context IDs in SQL.
It does not load task descriptions or run results to decide access. The cache ends
with the listing. Tool execution reads current policy and current rate counters.

The control-plane process admits two whole listings at a time and queues at most
32 more. Excess requests receive HTTP 503 with `tool_discovery_busy`. Disconnected
listing requests leave the queue or stop scheduling new decisions. Already-started
reads drain before the admission slot is released. This applies only to read-only
discovery; a disconnected tool invocation is not automatically cancelled.

Discovery audit rows retain the visible tool count and a SHA-256 digest of sorted
names. They do not retain the full name list. Named gateway tokens expire normally;
startup and scheduler sweeps delete at most 500 expired tokens per pass using the
expiry index. Tokens with no expiry and unexpired tokens remain available. The
separate access and activity audit records remain available.
Audit inserts resolve the token reference atomically and lock a surviving token
row for that statement. If cleanup already removed it, the reference is null and
the original token ID remains in audit details. An admitted request can complete;
later requests still fail authentication after expiry.

The stateless gateway and runtime-tools MCP endpoints return HTTP 405 with
`Allow: POST` for GET instead of returning JSON as if it were an SSE stream.
The runtime-tools endpoint still validates its caller before that response.
See the [MCP transport contract](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports).

## New-tool review projection

Pending-tool review builds covered application and connection sets from each
profile's include rules. An included catalog entry covers its connection and its
non-null application only while that entry exists in the supplied catalog.
Explicit application selectors retain null application matching. A second index
records all exact selectors, including exclusions, so already reviewed tools do
not appear as new. The catalog filter retains its order, status check, strict
review watermark, and returned metadata.

The indexes live only for one projection. Profile listings, new-tool review, and
app attention still read current company-scoped database state on each request.
This replaces nested catalog-by-rule scans with linear indexing and filtering.
It changes neither database query counts nor response contracts.

The PostgreSQL reproduction uses 200 selected profiles, 1,900 active tools, and
76,000 rules. Profiles alternate between 65 and 695 rules. Half reference 695
removed catalog entries, while half select current tools. This exercises both
scope checks and explicit-review checks. It compares complete ordered results
from the real profile listing and app-attention services before timing them.

Save baseline `profiles/projection.ts`, `profiles/service.ts`, and
`catalog/attention.ts` beside their current versions as `.baseline-projection.ts`,
`.baseline-service.ts`, and `.baseline-attention.ts`. Change the two baseline
consumers' projection imports to `.baseline-projection.js` with the same relative
path. Then run from `server/`:

```sh
node --expose-gc --import tsx scripts/benchmark-profile-review-projection.ts --baseline-profiles "$PWD/src/services/tool-access/profiles/.baseline-service.ts" --baseline-attention "$PWD/src/services/tool-access/catalog/.baseline-attention.ts"
```

Remove the three baseline files after the comparison. The probe alternates five
samples per implementation and reports process CPU, elapsed time, actual query
count, and returned rows. No provider calls or hosted traffic are generated.

## Reproduce the measurements

Build workspace dependencies, then run from `server/`:

```sh
node --expose-gc --max-old-space-size=4096 --import tsx scripts/benchmark-tool-gateway-listing.ts --tools 50,300,900 --parallel 1,16 --repeat 3
node --expose-gc --max-old-space-size=4096 --import tsx scripts/benchmark-tool-gateway-listing.ts --tools 900 --connections 4 --parallel 16 --repeat 3
```

The harness uses a throwaway embedded PostgreSQL database. It makes no model or
provider calls. Each fixture has a 400 KB run snapshot, 140 KB result, approximately
5 KB input schemas, 15 KB connection configurations, one selector per catalog tool,
and 373 policies. Use `--implementation /absolute/path/to/tool-gateway.ts` to replay
an earlier implementation, with its corresponding policy-service import.

## Verification on 2026-10-01

Node 26.4.0 on macOS; forced GC before each measurement; heap/RSS sampled every
2 ms. Baseline: `f2e0f196308629ef05c7f65782243e1713b208f0`.
[Raw measurements](benchmarks/2026-10-01-mcp-discovery.json) retain every sample.

| Scenario | Queries | Peak extra heap | Elapsed time |
| --- | ---: | ---: | ---: |
| Baseline, 900 tools, one listing | 11,489 | 1,680–1,698 MiB | 3.54–3.63 s |
| Fixed, 900 tools, one listing | 36 | 37–37 MiB | 0.24–0.24 s |
| Fixed, 900 tools, 16 listings | 576 total | 169–187 MiB | 3.63–3.65 s |
| Fixed, 900 tools, four connections, 16 listings | 624 total | 146–174 MiB | 3.69–3.72 s |

Before the listing optimization, the 50-versus-500-tool regression test failed
with 722 versus 6,422 statements. The connection-row duplication test also failed.
The follow-up regressions failed for full run-row discovery reads, abandoned
requests, full name-list audit records, and expired named tokens. They pass with
the fixes. HTTP coverage exercises initialize, GET/SSE rejection, 16 concurrent
500-tool listings, an allowed remote call, policy revocation after discovery, and
the denied subsequent call. The remote provider response is deterministic.

The eight runnable MCP browser stories pass against a throwaway production UI
and server, including governed execution and approval journeys.

These are fixture measurements, not a replay of the incident database. RSS
includes module/runtime overhead and can stay high after V8 frees objects. Query
counts depend on connection/profile sets; uncached rate-limit checks add queries.
Catalog payload memory and policy-matching CPU still grow with the catalog.
The measurements do not establish a safe production heap limit or the share of
active installations affected. Verify restart bursts and sustained traffic on the
actual deployment before reducing its temporary heap allowance.

## Profile selector matching

Effective profile resolution and profile summaries index each profile's include
and exclude selectors once per decision. Catalog rows then use exact set
membership checks for application, connection, catalog entry, tool name, and
risk level. Exclusions still take precedence within a profile; effective profiles
still contribute the union of their allowed tools. Null application selectors
retain their exact-match behavior.

These indexes live only for the current computation. Each resolver call still
reads current company-scoped bindings, profiles, and rules. Query counts and
returned database rows are unchanged. This reduces JavaScript matching work when
a profile selects many individual tools; it does not cache authorization or
remove the runtime assignment digest check.

For a real PostgreSQL comparison, save `projection.ts` and `resolution.ts` from
the baseline commit beside their current versions as `.baseline-projection.ts`
and `.baseline-resolution.ts`. Change only the baseline resolver's projection
import to `./.baseline-projection.js`. Then run from `server/`:

```sh
node --import tsx scripts/benchmark-tool-profile-matching.ts --baseline "$PWD/src/services/tool-access/profiles/.baseline-resolution.ts"
```

Remove the two baseline files afterward. The probe uses 1,890 catalog tools,
1,575 individual include/exclude rules, one effective profile, and 12 agents. It
checks full assignment-result equality, warms both versions, and alternates
seven samples of ten resolutions. It reports actual query and returned-row
counts, process CPU, and elapsed time. The installation dependency returns an
empty list for this fixture, which has no installed connections. It does not
measure provider work, whole-run latency, or hosted performance.


## Local profile comparison on 2026-11-02

The profile and app-attention paths were re-profiled together after
[#18681](https://github.com/paperclipai/paperclip/pull/18681) and
[#18673](https://github.com/paperclipai/paperclip/pull/18673). Both fixes replace
nested selector scans with indexes that live for one computation.

The comparison used Node 24.22.2 on macOS arm64. Service modules were compiled
as ES modules for Node 24 before measurement. No TypeScript loader ran during
measurement. All variants used the same database, fixture, and database client.
Only the service and projection implementation changed between variants.
The fixture had 200 profiles, 1,900 active tools, 695 removed tools, 76,000
rules, and 12 agents. Complete ordered responses matched before timing.

Baseline: `1f8f2e195f4897cd1c237bdc068de95780ab0c3c`. The pending-review fix was
`fd59c0183ce64c44696f79604516f4d51ca5662b`. The summary fix was
`e20165b6eb871c29e504a3837e8fe92a17ef969f`; its later benchmark helper change
does not change production code. Five unprofiled samples alternated order,
with forced GC before each operation. Values below are medians.
[All samples](benchmarks/2026-11-02-profile-projection.json) retain each measurement
and the pending-review-only treatment.

| Service | Baseline CPU | Combined CPU | Baseline elapsed | Combined elapsed |
| --- | ---: | ---: | ---: | ---: |
| `listProfiles` | 3,164 ms | 385 ms | 3,045 ms | 215 ms |
| `listAppsNeedingAttention` | 2,466 ms | 221 ms | 2,378 ms | 159 ms |

Each version made seven queries per service. Profile listing returned 78,114
database rows; app attention returned 78,101. These counts did not change.
The gains came from less JavaScript work after the reads.

Separate Inspector CPU captures used a 1 ms sampling interval. The baseline
showed `profileCoversCatalogScope` and `summarizeProfile` as major CPU costs.
Their repeated scans were absent from the combined capture. Residual work
included pending projection, row conversion, and garbage collection.
Profile capture time was excluded from the timing samples above.

The committed harness is in `server/scripts/profile-tool-projection/`.
Use Node 24.22.2, install workspace dependencies, and run these commands from
the repository root in a disposable worktree. The compile step writes local
`dist/` output. It is not the full application build. The Git history must
contain the baseline and pending-fix commits named above.

```sh
git fetch https://github.com/paperclipai/paperclip.git refs/pull/18681/head
pnpm install --frozen-lockfile
node server/scripts/profile-tool-projection/compile.mjs
node --expose-gc --import ./server/scripts/profile-tool-projection/register.mjs server/scripts/profile-tool-projection/benchmark.mjs --output-dir /tmp/paperclip-tool-projection --repeat 5
node --expose-gc --import ./server/scripts/profile-tool-projection/register.mjs server/scripts/profile-tool-projection/responsiveness.mjs --output-dir /tmp/paperclip-tool-projection
```

The compile step writes the baseline and pending-only owner modules beside
the current compiled modules. A build manifest records the current Git HEAD
and the SHA-256 hashes of the four current owner source files. The benchmark
records this manifest, validates complete output equality, then measures
`profiles` and `attention` separately for `baseline`, `pending`, and `combined`.
It writes `measurements.json` and six separate `.cpuprofile` files to the
output directory. The HTTP probe writes `responsiveness.json` there. Keep
CPU profiles private because they contain local source paths. Rebuild and
rerun if the owner files change. Serialize these commands with other heavy
builds and benchmarks on the same host.

A separate process also sent simple HTTP requests every 20 ms while each
real service operation ran. The local liveness handler shared the service's
Node event loop. There was at most one outstanding probe request. Across
three alternating trials, the median largest probe delay fell from 3,008 ms
to 78 ms during profile listing, and from 2,103 ms to 64 ms during app
attention. All 48 probe requests completed without error.

These are synthetic service measurements on a shared developer machine.
They are not a full application build, a browser test, or hosted acceptance.
The liveness handler is a minimal test handler, not the application's health
route. Workload, JIT warmup, and host activity affect absolute timings. The
comparison does not establish a page-load percentage or production capacity.
Use a matched deployment window to confirm the effect on user requests.

Both benchmark scripts use the test database helper. Set
`PAPERCLIP_TEST_POSTGRES_ADMIN_URL` to use a local PostgreSQL server; otherwise
they create and remove an embedded test database. The helper creates a unique
disposable database and removes it afterward. Benchmark setup and fixture
insertion are outside the timing samples.
