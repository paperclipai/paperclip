# Remote streaming and original local Stop fixture (H4)

The five streaming workloads select the production remote execution path through
normal plugin installation, a sandbox environment and agent `defaultEnvironmentId`.
The first-party `@paperclipai/plugin-fake-sandbox` executes separate OS processes
in private temporary directories on the **same physical host**. Provisioning is
simulated; Runner, authenticated PRP, PostgreSQL ingestion, live WebSocket delivery
and the shipped browser UI are real.

The unchanged 512-event, 100-ms operator Stop workload uses the instance's normal
local environment and a separate control agent. This retains the original local
performance coverage. It does not qualify remote Stop. **A separate real Daytona
Stop journey is an additional required acceptance gate**, with the shared Stop
acknowledgement, a provider-bound termination receipt and independent provider SDK
state. A fake-plugin void return never supplies that authority.

Use Linux. Normal remote supervision requires its boot ID and process start ticks;
a Darwin artifact alone does not satisfy that contract. Each measured app needs
its own frozen source, locked dependencies, matching compiled server stamp, built
fake-sandbox plugin including cleanup repair `b9e4679e39c4cbe0d0c6b64f51487f011d28fb9d`,
and matching native daemon. H4 owns separate driver tooling and fixtures.

```sh
PAPERCLIP_INGESTION_TRANSPORT=sandbox-remote-with-local-stop \
PAPERCLIP_INGESTION_SMOKE=1 \
PAPERCLIP_INGESTION_APP_ROOT="$APP_ROOT" \
PAPERCLIP_INGESTION_EVIDENCE_DIR="$NEW_EVIDENCE_DIR" \
PAPERCLIP_E2E_PORT="$OWNED_FREE_PORT" \
node node_modules/@playwright/test/cli.js test \
  --config tests/e2e/playwright-native-ingestion.config.ts
```

Run from the driver checkout with `DATABASE_URL` and `PAPERCLIP_RUNNER_STATE_DIR`
unset. Smoke runs 16 remote events and the original local Stop case. It qualifies
functionality only. Full 100-run readiness and the frozen protocol must pass before
A/A; five alternating matched pairs and all existing noise/latency/throughput gates
still apply. Omit the smoke flag only after the lead freezes exact revisions,
protocol hashes and commands. Do not mix H3 or the failed local protocol into H4.

The assembly generates a private two-day CA and signed server certificate with
`CA:FALSE`, server authentication and loopback subject alternative names, then
fronts the compiled HTTP app with verified TLS. It supplies normal
`PAPERCLIP_RUNNER_PUBLIC_URL`, `PAPERCLIP_RUNNER_CA_BUNDLE_PATH`,
`PAPERCLIP_RUNNER_REMOTE_BINARY_PATH` and `PAPERCLIP_RUNNER_REMOTE_CODEX_PATH`.
Production code retains artifact staging, version/hash verification,
authentication and process ownership. The remote wrapper uses absolute Node and
fixture paths; the normal sandbox environment includes Node's directory in PATH.
Provenance hashes the daemon, Node, wrappers, fixture, certificates and built
plugin assets, without private keys or checkpoint contents.

The existing test-only local command loader changes one Codex executable leaf.
Normal remote staging passes its explicit `codexCommand`, which short-circuits
that resolver. Each actual wrapper exports its own launcher identity and PID
before exec; the provider's pre-epoch clock hello validates the PID against
`process.pid`. The strict observer requires `staged-remote` for every streaming
participant and `host-local` for Stop. Emission timestamps, normalized payloads,
event counts, compact marker bounds and the original two-frame browser observer
remain unchanged. The standalone protocol qualification verifies the new hello
and the unchanged held-clock Stop and terminal behavior.

Before every common epoch, an independent READ ONLY REPEATABLE READ PostgreSQL
snapshot binds every actual run/company/agent/environment/lease. Remote cases
require database controller checkpoint headers. Local Stop instead verifies the
actual owned host-file journal's identity and hash, its original raw-event policy,
and server-authored process identity. Its PRP environment identity binds to the
actual admitted `binding.executionWorkspaceId` read from the run snapshot;
the normal environment bookkeeping lease is validated separately. Only scalar metadata is recorded. The
connection closes before emission. No fixture outcomes are inserted and no
controller persistence policy is overridden.

After terminal and Stop timing stamps are retained, normal lease APIs verify
cleanup. Local Stop additionally checks cancelled/acknowledged database state,
matching process ownership and independent runner PID, process-group and provider
PID absence. Cleared mutable identities require the actual server-authored local
process-stop receipt. Remote streaming requires released/expired/failed leases
with successful cleanup; those void provider responses make no remote Stop claim.

Prospectively registered budgets stay **300 seconds** for shared pre-epoch
readiness and **900 seconds** for the complete test. Streaming, terminal drainage
and Stop acknowledgement remain **120/180/30 seconds**, with **30 seconds** for
post-timing lease verification. These are resource bounds, not latency acceptance.
The comparator preserves all fixed workloads, four-of-five beyond-noise wins,
sparse-stream, paint-gap, Stop and final-drainage gates, and rejects wrong transport
or missing authority/provenance.

H3's first Linux attempt preserved all 16 deltas and committed native finalization,
but correctly failed real provider cleanup on sealed `0555` context directories;
Stop was not reached. That failed evidence remains unchanged. The isolated cleanup
repair has real-filesystem red/green tests and preserves void receipts. **H4 runtime,
100-run readiness, A/A, comparisons and separate real cloud Stop remain pending**
until their fresh evidence passes; source checks alone qualify none of them.
