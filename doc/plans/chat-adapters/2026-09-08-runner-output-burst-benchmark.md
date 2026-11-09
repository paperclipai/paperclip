# Native runner final-output burst benchmark — 2026-09-08

## Result and scope

A credential-free provider fixture emits 16, 128, or 512 ordered output deltas
and completes immediately after one accepted semantic completion. The real
Rust runner and TypeScript controller persist, acknowledge, replay, and close
that turn. There is no model, provider network call, App database, or App
semantic-completion grace period in this benchmark.

Batching only the provider queue acknowledgement for an already-durable prefix
of at most 128 events reduced median provider-completion-to-visible-terminal
time by 18–26%. Every individual PRP outbox save remains in place. Controller
event commits, wire acknowledgements, authority checks, and exact suspension
proof are unchanged. This is isolated benchmark evidence, **not a live chat
latency or model-quality qualification**.

## Measurements

All values are milliseconds, shown as median [minimum–maximum], with **n = 3
per size per binary**. Baseline repetitions ran first, then candidate repetitions
on the same Mac. CPU scheduling, background work, filesystem caches, and I/O
load were not controlled. These ranges are observations, not confidence bounds
or p95 estimates.

| Deltas | Baseline: provider complete → visible terminal | Candidate: provider complete → visible terminal | Median reduction |
| ------ | ---------------------------------------------- | ----------------------------------------------- | ---------------- |
| 16     | 796 [787–815]                                  | 653 [642–655]                                   | 18.0%            |
| 128    | 5,486 [5,417–5,639]                            | 4,214 [4,125–4,222]                             | 23.2%            |
| 512    | 18,658 [18,633–19,102]                         | 13,745 [13,554–14,275]                          | 26.3%            |

| Deltas | Baseline: safe close | Candidate: safe close | Baseline: visible + close | Candidate: visible + close |
| ------ | -------------------- | --------------------- | ------------------------- | -------------------------- |
| 16     | 116 [110–116]        | 109 [109–109]         | 912 [903–925]             | 762 [751–764]              |
| 128    | 179 [169–179]        | 159 [155–173]         | 5,665 [5,596–5,808]       | 4,369 [4,284–4,395]        |
| 512    | 4,122 [4,061–4,355]  | 4,057 [3,868–4,604]   | 23,013 [22,755–23,163]    | 17,802 [17,422–18,879]     |

The fixture emits its burst in 0–2 ms. At 512 deltas, the median Rust terminal
emission delay changed from 16,706 to 11,814 ms. Controller cursor commits and
committed event counts remain 24 / 136 / 520 at the three sizes; observed
controller saves remain 42 / 154 / 540. The benchmark does not instrument Rust
save counts or exact wire ACK counts and reports those as unknown.

The roughly four-second 512-delta close tail remains. The total median
visibility-plus-close reduction is 22.6% at that size; this patch does not solve
all cumulative controller/wire-ACK work. Drain and suspend receipt intervals
can overlap, so they must not be added together as independent serial costs.

## Artifacts and reproduction

Implementation and fixture:

- `packages/paperclip-runner/src/live/runnerd-final-output-burst.benchmark.test.ts`
- `packages/paperclip-runner/test/fixtures/fake-final-burst-codex-app-server.mjs`
- Production change: `packages/paperclip-runner/runner/crates/runner-core/src/durable/runner.rs`, `poll_executor_events`.

Measured binary SHA-256 digests:

- Baseline: `e33d464cba6766becf9fb536182976c0359a78e4250301a5c86874f8212c9963`
- Candidate: `8a61219d5b492b8bdff55600d25a8da818e5f66b095e68fbac40a8a9e7013370`

The baseline is retained locally at
`/tmp/paperclip-final-burst-cargo.YoIBsw/baseline-paperclip-runnerd`; the candidate
is `/tmp/paperclip-final-burst-cargo.YoIBsw/release/paperclip-runnerd`.
These temporary binaries are not repository artifacts. The candidate used the
optimized release profile in this isolated Cargo target, never the live target
or staging script. The live staged binary retained the baseline digest after
the comparison.

Exact local evidence filenames, under the ignored
`.paperclip-runtime/chat-adapters-live/runner-output-burst-benchmark-20260908/`:

- `baseline.metrics.jsonl`: selected closed metric fields exported from captured
  `FINAL_BURST_BENCHMARK` stdout, execution session `62858`, 9/9 passed.
- `candidate.metrics.jsonl`: the corresponding export from execution session
  `96555`, 9/9 passed.

These are metric exports, **not full shell/Vitest logs**. Full Vitest results
were captured by the execution tool: baseline 103.48 s, candidate 83.97 s.

Run from `packages/paperclip-runner`:

```sh
PAPERCLIP_FINAL_BURST_BENCHMARK=1 PAPERCLIP_FINAL_BURST_REPETITIONS=3 PAPERCLIP_FINAL_BURST_BINARY=/tmp/paperclip-final-burst-cargo.YoIBsw/baseline-paperclip-runnerd pnpm exec vitest run src/live/runnerd-final-output-burst.benchmark.test.ts
PAPERCLIP_FINAL_BURST_BENCHMARK=1 PAPERCLIP_FINAL_BURST_REPETITIONS=3 PAPERCLIP_FINAL_BURST_BINARY=/tmp/paperclip-final-burst-cargo.YoIBsw/release/paperclip-runnerd pnpm exec vitest run src/live/runnerd-final-output-burst.benchmark.test.ts
```

Without `PAPERCLIP_FINAL_BURST_BINARY`, the test selects the existing staged
runner (or the existing debug runner if none is staged). It never builds one.
Every invocation copies the selected binary into a private fixture directory,
checks its SHA before and after, and uses an explicit empty Codex home and no
provider credentials. Without the opt-in flag, all three cases are skipped.
Repetitions are bounded to 1–5.

## Preserved invariants and checks

- All synthetic deltas arrive in exact order, with no loss or duplicates.
- The declared semantic completion handler executes once.
- Durable committed source sequences are contiguous, logical effects occur
  once, and runner/controller ACK cursors agree.
- Safe close requires the exact six-field identity in durable suspended state
  plus a completed suspension command; the close deadline is unchanged.
- Reopening the same run does not execute the semantic tool again.
- A successor authority can reopen/read the same provider thread and close
  with its exact identity. **It does not execute a second provider turn**:
  the fixture's turn count remains one. Live consecutive-turn qualification is
  separate. The output names this `sameProviderAuthorityReopen` and explicitly
  reports `successorTurnExecuted: false`.
- An oversized or identity-conflicting suffix acknowledges only the prior
  durable prefix. A failed durable save authorizes no ACK. An ACK failure
  retains replayable receipts; if commit and ACK both fail, the original commit
  error remains observable. No same-memory retry can treat an unsaved receipt
  as durable.

Regression evidence: the original loop failed three of four focused batch
tests; the candidate passed all 18 durable-runner tests and all 217 Rust
library tests. The expanded crash/replay test also covers changed event data
after controller ACK removed the outbox copy. Independent review found no
blocker. Runner no-emit TypeScript checking, fixture syntax, formatting, and
`git diff --check` passed. The no-emit production configuration excludes test
files; actual benchmark executions provide the test-path verification.

```sh
cargo test --manifest-path runner/Cargo.toml --locked --offline --target-dir /tmp/paperclip-final-burst-cargo.YoIBsw -j 2 -p paperclip-runner-core --lib durable::runner::tests
cargo test --manifest-path runner/Cargo.toml --locked --offline --target-dir /tmp/paperclip-final-burst-cargo.YoIBsw -j 2 -p paperclip-runner-core --lib -- --test-threads=2
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

Next validation is a root-coordinated staged build and real native chat
comparison. Any future controller ACK/persistence optimization needs its own
crash-boundary and replay proof; this change provides no authority to relax
durable receipt, ordering, or suspension requirements.
