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
