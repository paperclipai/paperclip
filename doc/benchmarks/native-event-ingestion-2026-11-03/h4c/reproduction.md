# Frozen H4c driver handoff — runtime qualification pending

- Commit: `7d7e7a88d562a95a1d407b76474763b666c181f5`
- Branch: `codex/native-ingestion-harness-h4c`
- Immutable annotated tag: `native-ingestion-h4c`
- Tag object: `96b4959d09e9ffd0e0521d17e9f970b63ec30b73`
- Protocol SHA256: `5db4129bbdc1fa38775121aff5d0e68a8a11762519e41cfdf36eacd90ba7256b`
- Comparator SHA256: `01e0de114c886c255aaa7062a63f3e48788d8a83ce50921d672b2d661baef43b`
- Driver lock SHA256: `54a81b2ed3f1f85eaa085c034560ac248e384db34fbc7aba8c5a3846c29b3ce8`
- Approved patch SHA256: `79cacbb7a9ed9b6026d010ffd61c4768c60bd150a54ab4b57da8806829d9d14c`

Root and burst independently reviewed the exact final source. Final gate suite
passed 5/5 (10.78s), targeted noEmit types, Playwright listing, syntax and diff
checks pass. These establish source qualification only. No H4c app or VM run
was executed by this fixture owner. Old H3/H4/H4a/H4b refs and failed raw evidence
remain unchanged; remote verification confirms prior tag targets.

Only the performance owner may stage/run at the NEXT released quiet boundary
after the current source B1 A/A has settled and quiet checks pass. Root release:
run the small qualification below; IF AND ONLY IF it passes, run ONE full B0
functional qualification. No automatic retry. No accepted browser A/A or A/B
starts until root reviews the full functional PASS. Do not put these qualification
runs into accepted performance manifests.

Prepare a NEW driver checkout at the exact immutable pin, with its OWN locked
dependencies. No app source, node_modules or compiled output sharing:

```sh
git fetch origin refs/tags/native-ingestion-h4c:refs/tags/native-ingestion-h4c
git worktree add --detach /home/ubuntu/native-ingestion/harness-h4c 7d7e7a88d562a95a1d407b76474763b666c181f5
cd /home/ubuntu/native-ingestion/harness-h4c
pnpm install --frozen-lockfile --offline --ignore-scripts
```

The driver needs no app build. Select APP_ROOT only after the owner qualifies its
independent locked production build and exact server/dist/build-info.json stamp.
Use new evidence/home/data paths and an independently checked free app port.

Small functional qualification is **remote 3x16 events at 25ms**, one foreground
plus one real two-background activation wave, then the unchanged one-run LOCAL
Stop workload (512 events at 100ms, stopped after at least 3 visible markers).
This is qualificationOnly and cannot qualify performance:

```sh
env -u DATABASE_URL -u PAPERCLIP_RUNNER_STATE_DIR \
  -u PAPERCLIP_INGESTION_SERVER_COMMAND -u PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_DIR \
  -u PAPERCLIP_INGESTION_BROWSER_CAPTURE \
  PAPERCLIP_INGESTION_TRANSPORT=sandbox-remote-with-local-stop \
  PAPERCLIP_INGESTION_SMOKE=1 \
  PAPERCLIP_INGESTION_APP_ROOT="$APP_ROOT" \
  PAPERCLIP_INGESTION_EVIDENCE_DIR="$NEW_EVIDENCE_DIR" \
  PAPERCLIP_E2E_PORT="$OWNED_FREE_PORT" \
  PAPERCLIP_RUNNER_BINARY="$APP_ROOT/packages/paperclip-runner/runner/target/release/paperclip-runnerd" \
  PAPERCLIP_RUNNER_REMOTE_BINARY_PATH="$APP_ROOT/packages/paperclip-runner/runner/target/release/paperclip-runnerd" \
  PAPERCLIP_INGESTION_VARIANT=H4c-small-functional-only \
  PAPERCLIP_INGESTION_DRIVER_DEPENDENCIES='Independent H4c locked offline --ignore-scripts install; no app dependency/source/build sharing' \
  node node_modules/@playwright/test/cli.js test \
    --config tests/e2e/playwright-native-ingestion.config.ts
```

The normal configured server command runs native-ingestion-bootstrap.mjs for
configuration only, then fixtures/native-ingestion-remote-server.mjs with
--compiled-entry=server/dist/index.js. Preserve that normal verified-TLS assembly;
do not replace it with direct server startup. Normal matching local/remote daemon
paths are selected above. Remote provisioning is the first-party fake plugin's
separate OS processes on the SAME physical host; Runner/WSS/DB/browser are real.
Fake-plugin void cleanup does not grant remote Stop authority. Real Daytona Stop
remains an additional separate acceptance gate.

If the small run passes, use the same normal command with a new evidence path and
qualified B0 APP_ROOT, remove PAPERCLIP_INGESTION_SMOKE=1, add
`-u PAPERCLIP_INGESTION_SMOKE` to env, and use variant
`H4c-full-B0-functional-only`. The six FULL measured fixtures are unchanged:
paced1x128@25ms, burst1x16, burst10x128, burst100x512, retained1000+128 across10,
and LOCAL Stop1x512@100ms. Root must inspect the complete full PASS before releasing
fresh accepted A/A. Qualification is not a performance improvement claim.

H4c setup contract:

- Background activation uses waves of TWO normal PATCH requests, each awaiting its
  actual provider GET and clock hello with 50ms observation. The SAME shared
  300-second deadline starts before first background activation. Foreground UI
  activation remains unchanged and its earlier start is now recorded.
- Promise.allSettled drains both wave promises before throwing a failure; later
  waves do not start after failure. No retry or budget extension.
- All actual GETs/hellos, plus the closed READ ONLY REPEATABLE READ authority
  snapshot, precede common epoch creation/release. GET count is rechecked after
  the snapshot. The provider's AbortSignal.timeout(300000) is UNCHANGED.
- Reports use admissionProtocol
  `two-at-a-time-provider-and-clock-readiness-before-common-epoch` and
  setupActivationConcurrency2 at top/case level. Per-case activations record each
  index/issue/token/wave, request/readiness/settlement timestamps and status;
  activationWaves record indices/start/end/statuses. Comparator strictly requires
  that exact policy and matching actual clock/authority observations.
- Payloads/counts/rates/original emission clocks/2RAF/control/durable checks and all
  noise/4-of-5 gates remain unchanged. Budgets stay 300/900 seconds for setup/whole
  run and 120/180/30/30 seconds for stream/terminal/Stop/lease verification.

Previous H4b full setup failure is retained: 100 clock hellos, 99 pending GETs,
no epoch and zero measured emissions; foreground GET began 3.485s before the shared
readiness clock, and the final hello arrived 302.208s after that GET. H4c addresses
that unmeasured setup admission path; fresh runtime evidence is still required.
