# Hermes native runner implementation

Status (updated 2026-10-07): implementation candidate; **not qualified**.
Current branch: `codex/hermes-qualification`; stacked on
`codex/hermes-native-runner` and `codex/hermes-routines`.

## Accepted outcome

Run the pinned Hermes ACP agent through the existing Paperclip Runner/ACPX
boundary. Use existing Connections for models, credentials, subscriptions and
custom endpoints. Preserve incremental reasoning/text/tools, attachments,
native questions, explicit active steering, controller-owned queued work,
strict session recovery, per-agent memory/learned skills and Paperclip routines.
Keep the existing Hermes local/gateway adapters compatible.

## Delivery sequence

- [x] Built-in provider, reproducible provisioning, verified launch and shared connection projections.
- [x] Streaming, multimodal input, questions, steering, cancellation and strict restore implementation.
- [x] Managed memory/skills, per-turn lifecycle and real routine-service binding.
- [x] UI/configuration/contracts, documentation and package distribution.
- [x] Focused TS/Python tests and production-path macOS execution with a deterministic model server.
- [x] Complete final Rust/regression checks and resolve or classify failures.
- [ ] Browser acceptance, Linux/Daytona execution and connection-method qualification.
- [x] Reviewable draft PR stack, green CI and fresh Greptile 5/5 on the implementation heads.
- [x] Complete the final local aggregate test invocation and classify its failures.
- [ ] Complete live release qualification.

## Qualification evidence

Source baseline: Hermes `v2026.9.24`, commit
`f97608f178d1ffeca59860195ab7da295f7c8e5f`; ACPX `0.13.1`.
The native Hermes process has run through the real production runner against a
deterministic no-auth local HTTP model server. This proves the transport and
native callback path; it does not qualify a paid model, subscription, browser
journey or remote environment. Do not enable the production profile merely
because fixtures pass.

## Implemented scope

- Pinned Python 3.12.14, ACP SDK 0.9.0, MCP and provider extras from upstream's
  lockfile; uv 0.12.17 provisioning; byte-verified relocatable runtime; packaged
  bridge/provisioner and candidate provider-pack support. Both platform closures
  reproduce from fresh provisioning.
- `hermes_runner` projection through existing Connections, pools, account
  selection, ephemeral credential staging, refresh ownership and session
  compatibility. API, subscription, custom protocol and Bedrock projections
  have focused tests. Provider authentication is still unqualified live.
- Native execution v7 with backward parsing for v1–v5 and recorded Hermes v6, authorized typed image
  and text attachments through TypeScript/Rust/sidecar, and bounded frames.
  Ordinary semantic-result limits remain unchanged.
- Native incremental reasoning/text/tool events, question forms, acknowledged
  active steering, controller-owned queued work, cancellation, strict history
  restore and compaction-head tracking. No SQLite polling or gateway daemon.
- Per-conversation runtime state, managed agent memory/learned skills,
  protected assigned skills, native tool middleware and child-process policy.
  macOS uses sandbox-exec; Linux requires working bubblewrap namespaces and
  rejects unsupported hosts before credential staging.
- Real self-assigned routine create/update/pause/resume with the existing
  service, revision checks, run-bound idempotency and activity publication.
  Native cron and gateway messaging are disabled.
- Pending Hermes choice in existing runner configuration; existing connection,
  model, permission and transcript components. Ten Product E2E candidate cells
  (five local, five Daytona) are registered. All five local cases have passing
  paid attempts across different heads; the complete release matrix has not passed.

## Evidence and outstanding release gates

The production-path native fixtures pass on macOS arm64: incremental reasoning
and text, image bytes at the selected endpoint, an actual terminal command,
native clarification, assigned MCP round trip, active steering, cancellation,
memory collection, process restart and missing-history rejection. The Rust PRP
fixture also verifies authorized image delivery and semantic task completion.
These tests use real Hermes and a simulated model endpoint.

The branch was rebased onto `03cf6a6ecb0caf5e6f9c4e6af87dc723e5e3bca2`.
Hermes uses the new shared ACP profile manifest. The shared extension fix also
updates Cursor's ACPX patch attestation and profile identity to revision 15;
the Cursor usage, delegation and model-selection package contracts pass.

Historical post-rebase checks (superseded where newer results appear below):

| Check | Result |
| --- | --- |
| `pnpm -r typecheck` | Pass |
| `pnpm build` | Pass |
| Rust workspace suite | 651 passing test executions; two ignored |
| Runner ACPX/native contracts and control plane | 1,008 passed; seven skipped |
| Native server input, execution and file handoff | 639 passed |
| Connection projection and routine authority | 38 passed (14 connection, 24 authority) |
| ACP package contracts and provider-pack argument checks | 35 passed |
| Product E2E catalog/fixture support | 74 passed; live journeys not run |
| Native Hermes production-path fixtures | Two passed; deterministic model server |
| UI token gates | Pass |

Python bridge tests pass (15); the Python bridge bytes did not change in the
rebase. Transport coverage includes the unchanged ordinary semantic-result
bound and attachment-sized encrypted frames.

Before the rebase, full repository `pnpm test:run` ran with 15,612 passing, two failing and 91
skipped tests. Both failures pass on targeted reruns: the managed listener
failure was a port collision, and the complete 28-test legacy OpenClaw
comment-wake file passes. That wake file also passes against the original
source baseline. The aggregate invocation itself was not green; no product
change was made to hide either failure.

The clean npm consumer passes its contract checks and independently provisions
the same Hermes runtime hash. Both native fixtures then pass from that
installed package (not workspace imports). The candidate provider-pack
materializer also verifies the copied runtime. Both native execution targets
are still pending real model and product qualification.

Historical pre-review runtime closure SHA-256:

| Target | Closure digest |
| --- | --- |
| macOS arm64 | `898f2e80e11320b3abb68b7d521776fd71b015102c3caf8b2159f6726f35d746` |
| Linux amd64 | `619c2cf33f52f3db4aa0c8c7005b104c0562ba903f79fae0e46a835fd8cfd70d` |

Release blockers remain explicit:

1. Complete the paid Connection/account matrix. An OpenRouter qualification key
   and xAI API key are now available. Other API, subscription, custom endpoint,
   and Bedrock methods still need live qualification resources.
2. Qualify a Linux amd64 host with the required sandbox support, then actual
   Daytona. Docker's emulated Linux container rejected namespace setup. The
   implementation does not bypass protected-path or process isolation to pass.
3. Run the complete browser journeys and per-method connection matrix,
   including refresh/revocation/concurrent ownership, permission prompts,
   questions across reconnect, steering/queue/stop, remote recovery,
   cross-task learned skills, routine firing and cost attribution.
4. Complete the full live qualification before promoting the candidate.
   Implementation CI and review are green; they do not replace live proof.
   Default production selection remains disabled.

## Review handoff

The routine service binding is a separate review on
`codex/hermes-routines`. The native integration is stacked on it on
`codex/hermes-native-runner`, within the 100-file review limit. Changes are
committed. The generated root lockfile is excluded as required by the
repository. The Daytona Dockerfile requires the caller to provide the SHA-256
of its resolved lock and verifies the copied lock before installing dependencies.

The user subsequently authorized release qualification and PR verification.
The routine PR is [#15434](https://github.com/paperclipai/paperclip/pull/15434).
The native integration is stacked in
[#15435](https://github.com/paperclipai/paperclip/pull/15435). Both are drafts;
their current implementation heads have green CI and fresh Greptile 5/5.
Qualification fixes use `codex/hermes-qualification`
to retain the under-100-file limit for each review.

## Paid qualification, 2026-10-07

The first local OpenRouter `hello-complete` Product E2E attempt passed through
real Chromium, the isolated server/database, Runnerd, ACPX, native Hermes, and
the paid `deepseek/deepseek-v4-flash-0731` model. It saved one Done transition
and one final answer. Cleanup passed. Native usage reported 56,843 input tokens,
198 output tokens, and 2,560 cached input tokens; billed cost is unavailable.
The initial report has a null source field; the checkout was `2796b80a9` and
only image-identity inputs changed during that attempt. Later campaigns supply
the explicit source SHA and ref.

The next paid question/answer attempt reached the question, but continuation
failed: `run.attach requires the same settled ACPX provider profile and session`.
The saved provider was settled and its native history existed. Its managed
agent-file root changed for the new run, while Rust admitted that authenticated
grant rotation only for Cursor. Hermes now uses the same closed grant-rotation
policy; the cross-run test verifies preserved session identity, refreshed
paths/bindings, and rejected policy or same-run changes for both harnesses.
The campaign was stopped before more paid cases. Its in-flight Plan attempt
remains a failed interruption/cleanup record, not qualification proof.

The Daytona image identity now includes the Hermes provisioner, materializer,
and shared ACP profile manifest, and accepts an explicit Hermes candidate pack.
Eight image contract tests pass. This is packaging coverage, not a Linux or
Daytona live pass.

Private sanitized Product E2E evidence remains in the ignored results directory:
`hermes-local-paid-20261007-first` and
`hermes-local-paid-20261007-continuity` under `tests/runner-e2e/results/`.

No Paperclip issue/run API context was supplied to this local Codex task, so
the implementation record stays in this repository rather than being attached
as an issue work product.


### Review and recovery follow-up, 2026-10-07

The question rerun at `c22d1f422` successfully resumed and reached Done, but
failed the independent browser oracle: saved interruption text was prefixed to
the new answer. ACPX was emitting load/resume history as live turn events.
The dependency patch now retains those updates in the saved projection without
publishing them as new text or tool activity. Native history remains intact.
The additional cancellation/restore fixture also found an exact-route mismatch:
Hermes's HTTP client appended a slash to the recorded base URL. The bridge
accepts only that URL-path normalization while retaining exact model, provider,
protocol, query and the authoritative connection fingerprint checks.
The failed rerun evidence stays in
`tests/runner-e2e/results/hermes-local-paid-20261007-question-fix`.

Review fixes make credential cleanup run even when refresh or learned-file
collection fails. Once the credential fence is released, stale cleanup cannot
read a successor's credential. Unique reserved transfer files are validated and
removed before learned-state inventory; unfinished writes never become skills
or memories. The focused credential/state regressions pass.

Routine edits now remap open description annotations inside the mutation
transaction, with normal activity records. A real-database regression covers
description and timezone/schedule changes, idempotent replay, stale revisions,
and invalid schedule rollback without changes to annotations or receipts.
All 25 routine authority tests pass. Generated operation documentation and
catalog reconciliation expectations now reflect the real routine binding.

Fresh provisioning exposed build-specific uv installation paths in Python
sysconfig and the macOS library identity. The materializer normalizes those
paths and re-signs the changed macOS library with a deterministic ad-hoc
signature. Independently provisioned interpreter paths produce identical
closures; this is distribution proof, not live Linux sandbox qualification.

| Historical review target | Closure digest |
| --- | --- |
| macOS arm64 | `4c89b24335e1869a9faba6996a4e82979337ee5f850d792ab41a838e79afdce3` |
| Linux amd64 | `f9919bd2e812e86e81ecd964d6e1961bb68f96e2154f816c554f31c4f1d78211` |

The qualification stack is
[#15436](https://github.com/paperclipai/paperclip/pull/15436). Runtime
qualification workflows, follow-up fixes and this implementation/evidence record
belong to that PR. The native runtime fixtures belong to #15435. Each review
remains below 100 files. The new shared ACPX
patch has an explicit Cursor profile revision 16, preserving historical
revision decoding. The Docker lock digest is twice reproduced; the root lock
file remains owned by the repository's lock bot.

### Current qualification record, 2026-10-07

Hermes remains **pending qualification**. All three draft implementation PRs
have passing CI and fresh Greptile 5/5 at these
heads: routines `3745f3c5a46bda7778ee132682d1b7ae23b088c1`, native
`6a7a006b0738558a4abb1c030f2b7b11f5afea2c`, and qualification
`09195bb8c8bc564eaa3f5061a7d6b5d685e708a4`. A later native review also found a
standalone image command without the required resolved-lock digest. Both image
guides were corrected in `0dea682031f8e35631faee7a05519ed4dce80d07`, their shell
syntax and checksum ordering were checked, and the addressed thread was
resolved. The qualification commits were rebased onto that fix. Subsequent
documentation heads require fresh checks and review before handoff.

Paid planning exposed two integration defects. Assigned plan-document and
task-title tools were rejected by the native read-only guard before the
controller could apply its task-mode authority. Structured MCP results also
appeared as `null` in the transcript. Assigned workflow tools now reach the
existing controller authorization and configured permission check; native
commands and file writes remain denied in planning mode. Tool results retain
their actual output. A pre-dispatch denial synthesizes a failed call using
Hermes's authoritative call ID exactly once, including overlapping calls.

Managed Hermes restoration now loads the validated native history without
emitting it again as new ACP transcript output. Paperclip owns the persisted
transcript. Standalone, non-negotiated ACP clients retain native history replay.
Missing or unreadable native history still fails restoration.

Current runtime closure SHA-256 (fresh provisioning reproduced both):

| Target | Closure digest |
| --- | --- |
| macOS arm64 | `970f0c48b905d17e616a3b75ef28d91a0e28afba8dbb3218628cd02b3b1e709c` |
| Linux amd64 | `15fc9631318d50a2aafa9c566410b4d486265fb3e58a7981fd0c2525a5fb8f7a` |

Current focused verification: 46 TypeScript permission/sandbox/configuration/
installation tests, 20 pinned Python bridge tests, and both native production
fixtures pass. The ACPX fixture additionally checks planning round trips,
visible write denials, strict cancellation recovery and missing-history
rejection. These fixtures use a deterministic model endpoint. The full Rust
workspace ran 652 passing test executions with two ignored. Repository
typecheck, build, protocol generation checks and UI token gates pass.

The local aggregate test invocation finished with 16,084 passing tests, one
failed test, 216 skipped tests and two failed suite setups. Both suite setups
failed during embedded PostgreSQL bootstrap before their assertions ran. The
real 40,000-file Git streaming test reached its existing five-minute deadline.
These failures remain failures of that invocation; focused reruns and green
sharded CI do not rewrite it as a pass.
The isolated rerun passed both database suites (eight tests). The Git fixture
still reached its five-minute deadline. Its test and shared Git implementation
are unchanged from the source baseline; Linux PR CI passes that coverage. The
local Git timeout remains an explicit verification limitation.

Paid browser attempts used the managed OpenRouter account and exact model
`deepseek/deepseek-v4-flash-0731`, on macOS arm64, through Chromium, the isolated
Paperclip server/database, Rust Runnerd, ACPX and native Hermes:

| Case | Passing campaign | Source provenance | Duration | Cleanup |
| --- | --- | --- | --- | --- |
| Hello/completion | `hermes-local-paid-20261007-first` | Report source null; observed checkout `2796b80a9` with image inputs in progress | 47.63 s | Pass |
| Question/resume | `hermes-local-paid-20261007-question-replay-fix-retry2` | Recorded `74b692bbd8c98bbeda4c39cf8327680245ac2cbf` | 106.90 s | Pass |
| File edit/validation | `hermes-local-paid-20261007-remaining-continuity` | Recorded `0ba0d75511cf9fdf1fa4b21d9e900503078f3620` | 122.28 s | Pass |
| Plan/approve/complete | `hermes-local-paid-20261007-plan-policy-fix` | Recorded `09195bb8c8bc564eaa3f5061a7d6b5d685e708a4` | 134.19 s | Pass |
| Structured question/controller restart/resume | `hermes-local-paid-20261007-restart-resource-retry` | Report source null: invocation used the wrong source-variable names; observed checkout `09195bb8c8bc564eaa3f5061a7d6b5d685e708a4` | 118.72 s | Pass |

All five registered local cases have passing attempts across multiple heads.
This is not a complete final-head campaign or the full requested release
matrix. The restart case proves persistence of the pending question across a
controller restart, submission of its answer, native session reuse, and task
completion. Its resumed run reported 64,166 input and 281 output tokens. The
planning completion run reported 62,268 input, 478 output and 37,888 cached
input tokens. Their interrupted first runs have incomplete usage receipts.
Cost remains unpriced; missing cost is not a zero-cost execution.

The preceding restart attempt failed during test-database bootstrap, before
any model request. Clearing only four confirmed user-owned, unattached,
56-byte shared-memory segments with dead creators allowed the unchanged test
to run. Earlier session-open timeout and transcript failures remain retained
in their own campaign results. No deadline or oracle was weakened.

Private numeric-only budget receipts show the qualification key's $5 hard
limit still has $4.559226202 remaining after these attempts. The shared-key
usage change is an aggregate ceiling, not exact attribution to individual
runs. Sanitized results remain under `tests/runner-e2e/results/`; private native
history, credentials and hidden reasoning are not published as artifacts.

The clean installed-package root/evals/testing conformance check passed on
`09195bb8c8bc564eaa3f5061a7d6b5d685e708a4`. It uses offline packed runtime
dependencies, including the reviewed ACPX patch, rather than unmodified
registry dependencies. The installed package's shipped provisioner reproduced
the current macOS closure. Both native fixtures passed from installed compiled
code, using the published release Runnerd artifact: 29.03 seconds for the Rust
path and 146.75 seconds for the ACPX path. Only fixture import locations and the
explicit Runnerd artifact path were adapted; assertions and deadlines stayed
unchanged. This is clean-package transport proof with a simulated model.

The protected paid workflow now provisions Python, bubblewrap, and the verified
Hermes closure only for an explicit Hermes selection, before credentials enter
the paid step. It must land on `master` before its trusted dispatch can run
paid Linux/Daytona campaigns. No paid remote campaign has been dispatched.
An available development host permits bubblewrap but is Linux arm64; it does
not satisfy the requested Linux amd64 target. The emulated local Linux amd64
container provides provisioning proof and still fails the namespace gate.

Outstanding release proof includes the other API providers, subscriptions,
custom protocols, Bedrock, real vision input, credential refresh/revocation and
concurrent ownership, live steering/queue/stop, lower permission modes,
cross-task memory/learned skills, routine firing and deduplication, and actual
Linux amd64/Daytona execution and restoration. Exact approved Connection names
and a compatible remote execution environment are still needed. The existing
standalone Hermes local/gateway adapters retain their contracts.

### Final-head campaign and startup follow-up, 2026-10-07

The campaign `hermes-local-paid-20261007-final-head` correctly recorded source
`a54d04785b62e2190f4e13647bf75ae510449d98` and passed **1/5** cases. It used
the same managed OpenRouter account, exact model and macOS browser/Runner path:

| Case | Result | Failure or limitation |
| --- | --- | --- |
| Hello/completion | Pass | Done, exact final answer and cleanup passed |
| Question/resume | Fail | `session.open` exceeded its 30-second command deadline; cleanup passed |
| Plan/approve/complete | Fail | Reasoning streamed but the 120-second turn deadline expired; cleanup passed |
| Structured question/restart/resume | Fail | The isolated server hit system `ENFILE`; cleanup failed |
| File edit/validation | Fail | Dispatch was interrupted after the resource failure; process-group cleanup identity was uncertain |

The file case's underlying task later reached success, but its independent
fixture oracle and cleanup did not pass. Its recorded failure is unchanged.
The owned launcher and remaining isolated server/database were retired with
verified exit. Failed private recovery roots remain preserved because their
original cleanup receipts failed. No additional paid campaign was launched.
The numeric budget receipt reports $4.539181805 remaining under the key's $5
limit; this is shared-key accounting, not exact per-run billed cost.

Credential-free production-host probes reproduced variable cold-start latency.
The first verified 445 MB runtime copy took 3.08 seconds. A complete admission
later took 33.69 seconds: 16.54 seconds for the verified private copy and 16.61
seconds for native initialization/ACP handshake. Its no-auth loopback endpoint
received only model/backend metadata probes, with no inference requests.
These measurements reproduce an admission deadline problem; they do not prove
the cause of the host's file-table exhaustion. The read-only host counter still
reported 461,999 open files against a 491,520 limit. No system limit was changed
and no unrelated process was stopped.

Hermes now has a separate 60-second native session-open deadline. The PRP
controller allows 75 seconds around cold admission, recovery, and later-turn
restoration. Ordinary commands and stop retain their prior deadlines, and the
post-acceptance turn-start event deadline remains 30 seconds. The 120-second
Product E2E turn oracle is unchanged. Focused regressions verify delayed startup,
ordinary-command timeout, fail-closed transport reuse and the finite outer
deadline. This addresses admission timing only; the paid planning timeout and
host resource failures still require a new passing campaign on a reliable host.

Startup verification passed seven TypeScript deadline regressions, the complete
193-test controller transport selection, 27 focused Rust session/transport test
executions, and the complete 655-execution Rust workspace suite (two ignored).
Runner TypeScript/Rust typechecks, verified entrypoint builds, release binary
build, workflow authority tests (14), and actionlint pass.
Both rebuilt native production fixtures also pass: 35.98 seconds through Rust
PRP/sidecar and 144.68 seconds through the ACPX host. They use the deterministic
no-auth model fixture and retain their original assertions and deadlines.

The new credential-free `Hermes Native Transport` PR workflow provisions the
pinned Linux amd64 closure and runs both production native fixtures on an
ephemeral Ubuntu host. Provider children receive an empty environment plus the
fixture PATH/home/opt-in flag. No paid environment or credentials are available.
It retains source/runtime provenance and fixture logs as CI artifacts while
excluding private native homes. Its actual execution result must be checked;
the workflow declaration alone is not Linux proof. The protected paid workflow
and its default-branch authorization remain unchanged by this addition.

The first Linux CI attempt provisioned the exact pinned closure and passed the
native ACPX fixture in 94.21 seconds, including native command tools, planning,
images, questions, controls, memory and strict recovery. The Rust fixture failed
before native launch because GitHub's Node interpreter was group-writable.
The workflow now removes only group/world write bits from its own interpreter,
matching the existing paid workflow's setup step. The launch verifier is
unchanged; both native fixtures must pass on a new attempt. The corresponding
ordinary PR run recorded a timeout in the unchanged chat retry denial-feedback
browser test, followed by simultaneous runner shutdowns across other jobs.
Their failures remain recorded and need fresh CI. Repository-wide typecheck
and build pass on startup runtime head `2cf45fa7ff52b08215c726cf10b7d8353e69892a`.

The three draft PRs had green CI and fresh Greptile 5/5 at routines
`3745f3c5a46bda7778ee132682d1b7ae23b088c1`, native
`0dea682031f8e35631faee7a05519ed4dce80d07`, and qualification
`a54d04785b62e2190f4e13647bf75ae510449d98`. That qualification CI initially
failed an unchanged signoff mock-heartbeat browser case; inspection and the
failed-job-only rerun passed. Startup changes require new checks and review.
Hermes remains pending qualification throughout.

### Linux transport proof and master synchronization, 2026-10-07

The follow-up credential-free Linux amd64 run
[37638866523](https://github.com/paperclipai/paperclip/actions/runs/37638866523)
passed both production native fixtures: Rust PRP/sidecar in 17.16 seconds and
ACPX/native in 88.01 seconds. Its
[evidence artifact](https://github.com/paperclipai/paperclip/actions/runs/37638866523/artifacts/11491541694)
records checkout merge SHA `12417c5b911c3102cba3247665e5ba94d632d9d1`, whose
parents are native head `0dea682031f8e35631faee7a05519ed4dce80d07` and
qualification head `689d0fa2cc2201f4643634f0fdb6da91922a7cc3`.
Ubuntu 22.04.5, Node 24.21.0, Python 3.12.14, ACP 0.9.0 and ACPX 0.13.1
reproduced the pinned Hermes Linux closure. No provider credentials or paid
model were used. This proves native transport on Linux; paid browser and
Daytona qualification remain outstanding.

The full ordinary PR run
[37638866778](https://github.com/paperclipai/paperclip/actions/runs/37638866778)
passed on that qualification head, including all browser shards, server and
workspace suites, typecheck, build, native runner checks and canary dry run.
Greptile reviewed that exact head at 5/5 with no open feedback. The first two
PRs also retained green CI and fresh 5/5 at their previously recorded heads.

Master then advanced with task monitors and Claude asset-path restoration,
creating a generated-contract conflict in the routines PR. The stack is being
replayed on master `083073703086dd699f3f2bfd852e56c7150c2d09` before any merge. Combined contracts retain both
live routine management and task monitors (46 live operations, 29 shared,
57 canonical); provider policy retains Claude authenticated asset paths and
Hermes authenticated run grants. Runtime closure pins and qualification
bridge bytes are unchanged. Fresh verification is required for the replayed
heads. Paid failures remain failures, and Hermes stays gated.

Local replay verification passed repository-wide typecheck and build, UI token
gates, 37 catalog/admission tests, and 658 Rust test executions with two ignored.
The routine/service and native authority selection passed 102 tests, with one
stale combined-tool count assertion failing. That assertion was corrected to
40 while retaining explicit membership checks for both operations; its isolated
real-database rerun passed. The full fresh PR CI and reviews remain required.

### Review follow-up and replayed Linux proof, 2026-10-07

The credential-free Linux run
[37642068493](https://github.com/paperclipai/paperclip/actions/runs/37642068493)
passed both native fixtures after master synchronization: Rust PRP/sidecar in
18.69 seconds and ACPX/native in 91.39 seconds. Its
[evidence artifact](https://github.com/paperclipai/paperclip/actions/runs/37642068493/artifacts/11492173396)
records checkout `98d8c1e30f2f69d48fad3ef0785c1adcd82b0ba3`, PR head
`96585ac7ff5a2bc8032ba5213fcd23b230815c20`, the same runtime versions and
pinned Linux closure, and no credentials. This remains transport proof only.

Fresh reviews on the replayed routines and native PRs returned 4/5 and found
three actionable issues. A native routine edit held its execution agent/issue
locks before waiting for the scheduler's routine lock. Routine locking now
uses NOWAIT and returns a retryable 409, rolling back the mutation receipt
before retry. The real scheduled-firing regression exercises contention,
agent-row access, receipt rollback, and exactly-once retry. Local PostgreSQL
failed to start before assertions in two bounded attempts; that regression
still requires a successful CI execution. Server TypeScript compilation passed.
The read-only host counter reported 466,103 files against a 491,520 limit;
the startup failures alone do not establish their cause. No paid macOS rerun
was launched.

The already-tested planning authority, native transcript and restore fixes
were moved into the core native PR so it works independently of the
qualification PR. Text attachments also now count JSON escaping and metadata
at admission, along with the combined message, against a 7 MiB encoded budget.
TypeScript and Rust reject over-budget content before active-turn state changes.
This preserves the 16 MiB encrypted frame limit. Verification passed 28 focused
TypeScript attachment/permission tests, two encrypted-frame tests carrying
accepted images and escaped documents, the Rust admission regression, and
Runner TypeScript compilation. The stack still needs fresh CI and review on
the resulting heads. No merge has occurred, and Hermes remains gated.

The complete affected native tool-authority suite subsequently passed all 26
tests with supported Node 24 and local PostgreSQL permissions. A negative proof
restored only the previous blocking lock temporarily: the concurrency regression
failed at its expected contention timeout. The committed NOWAIT fix was restored
with no remaining worktree changes. All 143 affected ACPX lifecycle tests and
the current generated profile, protocol, sidecar and surface checks also passed.

The qualification review at `c99b2c86748e06600d853adaf5a7483aa16ed8ca` returned
5/5 but noted a native CI trigger coverage gap. The credential-free workflow
now covers shared Runner sources, Rust and build manifests, dependency patches,
and shared workspace inputs. A glob-matching regression verifies those changes
trigger the native fixture. Paid workflow authorization is unchanged. This
follow-up requires another exact-head review and CI run.

### Cloud image and live Linux browser proof, 2026-10-07

The trigger-coverage fix passed fresh CI and Greptile 5/5 at qualification head
`575d3bb665e7eb848f1607797f27635aba2e27f5`. Routines
`f2c047d07147f710b40b2dffcb097a71676dc8f4` and native integration
`45f591120dc78a080f347f3d3e4ad4fd05a19993` also have green checks and fresh
5/5 reviews with no unresolved threads. No PR has been merged. Further fixture
changes require new exact-head checks and review.

The candidate image built successfully in AWS CodeBuild from
`8e31afda4ff3b4c0415bc26f8bb35cec17437741`, whose only change from the above
qualification head selects Hermes in the Dockerfile's candidate-pack default.
Its independently verified immutable digest is
`sha256:b8b8a3279e27a58d6cf5269b7e6480914f34bf036d74abb5d1e65b99996ccd6e`.
The build used a checksum-bound resolved lock, frozen dependencies, no provider
credentials, Python 3.12.14, ACP 0.9.0, ACPX 0.13.1 and the pinned Hermes release.
The image remains private and pending qualification. No local Docker build was
used; Docker Desktop was stopped again when another local process restarted it.

CodeBuild could build the image but its execution filesystem rejected native
bubblewrap with `Can't open source /: Function not implemented`. That failed
credential-free probe is retained. The same image passed its unmodified native
command policy on a disposable EC2 amd64 host, Amazon Linux kernel
`6.1.188-233.386.amzn2023.x86_64`. The qualifier ran as uid 1001 inside an
explicitly privileged cloud container: protected files remained hidden,
assigned skills remained read-only, and allowed workspace writes succeeded.
This establishes this EC2 host's compatibility; it does not qualify Daytona.

All five core Linux Product E2E cells passed through Chromium, an isolated Paperclip
server/database, Runnerd, ACPX, native Hermes and managed OpenRouter model
`deepseek/deepseek-v4-flash-0731`:

| Case | Campaign suffix | Duration | Native runs | Cleanup |
| --- | --- | --- | --- | --- |
| `hello-complete` | `71743c4f328f` | 72.351 seconds | 1 | Passed |
| `question-resume-complete` | `703f08761be6` | 133.251 seconds | 2 | Passed |
| `plan-approve-complete` | `8662152371fd` | 140.890 seconds | 2 | Passed |
| `structured-question-restart-resume` | `87eaa1dd7deb` | 137.277 seconds | 2 | Passed |
| `file-edit-validate` | `758fe67e2613` | 132.001 seconds | 1 | Passed |

All five results bind the exact image-source commit above. The catalog environment
is `local`, with a separately recorded AWS EC2 Linux execution host; these are
not Daytona/remote-target passes. The first case independently verified Done,
one final answer and a successful native run, with a reviewed final screenshot.
The second retained the question and final screenshots and verified the answer
and continuation. The third verified plan approval, continuation and completion,
with two reviewed screenshots. The fourth verified retained question state and
conversation continuation after a real controller restart, with three screenshots.
The file case checked the actual final file bytes and command validation, with
one screenshot. Runtime cost is not metered by that local catalog; external
EC2 cost is separate. Native token usage was available for the completion run
and one of the two runs in each question/approval/restart workflow. Model cost remains unpriced/incomplete, and
shared-key aggregate budget readings do not establish exact per-run cost.

The initial cloud browser attempt failed before server bootstrap because the
disposable controller lacked the compiled plugin SDK. It produced zero agent
runs, and its failed result and budget readings are retained. Setup now builds
the SDK and imports the server before model-credential handoff. Each live cell
has one attempt and no automatic retry. Secrets are passed only after verified
setup through a fresh job-bound encrypted exchange, without plaintext local
credential files. Private proof and campaign archives remain in the task's
restricted S3 evidence prefix with bounded retention; public source/docs contain
no credentials or raw provider traces.

The new explicit-only `hermes-api-connections` matrix declares ten API-account
completion cells with independently graded native account/model attribution.
Each permits one attempt and configures 200-cent company and agent budgets.
Public readback must verify both budgets and their scope before task creation;
unpriced usage stays unknown and does not become an exact billing receipt.
Authenticated OpenAI, Anthropic, xAI and Google catalog reads succeeded without
inference. Those discoveries and the new fixture calibration do not constitute
live provider qualification. The complete original release gates remain open:
the rest of the live controls, attachments, state/routines, credential lifecycle,
subscriptions/custom protocols/Bedrock and actual Daytona proof are still required.

The final API fixture support suite passed 1,833 Vitest tests (one skipped) and
all 128 companion Node assertions. Product E2E TypeScript and `git diff --check`
passed. The five verified encrypted cloud proofs are preserved; the disposable
EC2 instance was terminated and its unused role, instance profile and security
group removed. No local Docker was used. These fixture refinements require
fresh current-head CI and review; they do not complete release qualification.

Fresh review found that the paid workflow did not supply the new Google cells'
required Gemini key. The key is now mapped only when the selected matrix cell
requires it, and the workflow credential-boundary regression covers it. All 15
workflow tests and actionlint pass. Another current-head review and CI run are
required after this correction.

### Managed API account qualification, 2026-10-07

The Google credential mapping subsequently passed all 54 current-head CI checks
(two intentional skips) and fresh Greptile 5/5, with no open threads, at
`ffd6bbc1ebb10c1c8ef0db875bb88d733f64649d`. The following paid account cases
use that controller source and the previously verified image source
`8e31afda4ff3b4c0415bc26f8bb35cec17437741`. Independent tracked-source
comparison proves their production runtime and dependency sources identical;
the changes are qualification fixtures, documentation, workflow credential
mapping, and the image's explicit candidate selection. The runtime-source
fingerprint is `9d9e39d5390de779c619004ebbce55cc57d2c1aeefead36099903d7db1d3e26a`.

| Managed API account | Exact model | Campaign suffix | Result | Duration |
| --- | --- | --- | --- | --- |
| Anthropic | `claude-haiku-4-5-20251001` | `2d55c9944d84` | Passed | 53.780 s |
| OpenAI | `gpt-5.6-luna` | `4953bfa797ea` | Passed | 58.760 s |
| xAI | `grok-4.7` | `83fd6210c933` | Passed | 69.960 s |
| Google | `gemini-2.5-flash` | `ea98e1dd517f` | Failed | 52.511 s |

Each passing case independently verifies six public native-run account/model
checks, both scoped 200-cent budgets before task creation, one successful native
run, one final answer, and cleanup. Each has a reviewed final browser screenshot.
All run on the compatible EC2 Linux amd64 host with catalog environment `local`;
they do not qualify macOS or Daytona. Token receipts are available, but monetary
cost remains unpriced. The final screenshots show the existing budget policy
pausing the test agents after unpriced usage; reported zeros are not free runs.

xAI delivered 41 reasoning deltas and 22 assistant-text deltas before its native
terminal event. Its final screenshot renders a thought card above the answer.
These facts prove event delivery and final rendering, not incremental browser
render timing while the run is active. Raw reasoning is not published.

Google's authenticated catalog listed Gemini 2.5 Flash, but inference returned
404 because the account had not previously used that model. Google's
[access notice](https://ai.google.dev/gemini-api/docs/deprecations) confirms the
restriction. The failed browser attempt, provider error, missing usage, and
successful cleanup remain retained. Hermes made its native HTTP retry attempts
inside that single controller turn; the campaign did not dispatch a new paid
attempt. The fixture now selects `gemini-3.8-flash`, whose authenticated metadata
supports `generateContent`. That metadata is not a live qualification pass.
The model correction passed all 94 affected tests and Product E2E TypeScript;
it requires a new live attempt, fresh CI, and review.

Private proof and campaign archives remain encrypted in the task's restricted
S3 prefix. Credentials are supplied only through a fresh verified job-bound
encrypted handoff. Obsolete encrypted key transfers are removed after evidence
collection. No local Docker is used. Subscription/credential lifecycle, custom
protocols, Bedrock, the remaining interactions/state/routines, final macOS
campaign, clean distribution, and actual Daytona gates remain open. Hermes
continues to be pending qualification.

### API completion results and question-limit correction, 2026-10-07

The remaining API completion cases passed on the same verified AWS Linux image:

| Managed API account | Exact model | Controller source | Campaign suffix | Duration |
| --- | --- | --- | --- | --- |
| OpenRouter | `deepseek/deepseek-v4-flash-0731` | `ffd6bbc1ebb10c1c8ef0db875bb88d733f64649d` | `b530ea3f1d95` | 62.134 s |
| Google | `gemini-3.8-flash` | `f0dca1e1815f767a55e644d2eecc4cc91a166519` | `b819f9665567` | 60.466 s |

Both satisfy the same six native account/model checks, two pre-turn budget checks,
one successful native run, final-answer and cleanup assertions. Their final browser
screenshots were reviewed. Google's earlier 2.5 failure remains retained as a
separate provider/model attempt. All five selected API providers therefore have
completion evidence at those recorded sources; this does not establish the broader
release gates. The private campaign archives remain encrypted and the disposable
host was terminated. Its unused role, instance profile and security group were
removed. The qualification ledger reserves $17 of the authorized $25 cap, including
both Google attempts; reservations do not establish actual spend.

At `f0dca1e1815f767a55e644d2eecc4cc91a166519`, all 54 checks passed with two
intentional skips and fresh Greptile 5/5. A subsequent native-PR review identified
a question-limit mismatch: the canonical form accepted answers exceeding the
bridge's 65,536-character bound. Native commit
`de39c85a7` publishes the bound for text and custom answers and counts UTF-16 code
units consistently with canonical validation. All 21 pinned Python bridge tests,
11 affected TypeScript tests, runner TypeScript and diff checks passed. Boundary
coverage includes overlong answers and astral Unicode in all three answer modes.

The corrected bridge changes the verified runtime bytes. Fresh pinned macOS
provisioning verified closure
`690b3b84a543b04a47a6859969bd613ced61d68776d80b57c85ca424bde31829`.
The Linux closure pin is
`6166fadd24dae41b9fdfd994e6c7bc129e9317ed252b7dabdd777b691ab47771`,
derived by independently verifying every original pinned file and changing only
`bridge.py`. Fresh Linux provisioning/CI and the updated cloud image still require
verification. The earlier image digest and live results retain their original
sources and closure; they are not results for the corrected runtime. The stacked
qualification commits were replayed without changing their patches. Both updated
PR heads require fresh checks and review. Hermes remains pending qualification.

The subsequent qualification review found an independent-user evidence gap:
the original responsible-user check compared two run fields with each other.
That permits a consistent foreign user to pass. New fixture admission reads the
selected account and authenticated caller through the public Connections API
before creating a paid task, verifies company/account/provider/method/ownership
and connected status, and retains the expected owner. Both run fields must equal
that owner; missing, duplicate, foreign-owner and consistent-wrong-run-user cases
are calibrated as failures. The historical API results keep their original
grader provenance; they do not acquire this pre-turn owner receipt retroactively.
An additional assessment of the retained public task records independently
checks the immutable task creator, task responsible user and both run attribution
fields. All five successful API cases pass that comparison with zero provider
calls. This retained-task assessment remains separate from the new fixture's
pre-turn account-owner admission. The correction passed all 106 affected tests,
Product E2E TypeScript and diff checks.

The fresh Linux native CI attempt at the replayed head failed before provisioning
because GitHub returned HTTP 429 for the pinned source archive. No native fixture
or provider execution occurred. This is retained as a download infrastructure
failure; it is not evidence of a closure mismatch. The separate credential-free
AWS build continues against its recorded immutable source.

### Corrected cloud image and Bedrock fixture preparation, 2026-10-07

The corrected credential-free AWS build completed successfully in 11.73 minutes
at source `d389750b90787ea5240d0f8f4e92396a1d9d20a1`. Its immutable image digest is
`sha256:5f457b7aed4dc224c77125edb7b17fd1aedc9e7bad0a9ce92d454cecc660e767`.
The independent collected proof verifies fresh Linux closure
`6166fadd24dae41b9fdfd994e6c7bc129e9317ed252b7dabdd777b691ab47771`
and the original frozen dependency-lock SHA
`f5ee14ee77b1dc7771fe455d619c880fc64b1e62e40a15704addc9f7430e5c50`.
No provider credentials or local Docker were used. This proves the corrected
Linux distribution; it does not prove execution-host namespace compatibility,
browser behavior or Daytona. The ledger reserves $19 of the $25 cap after the
additional $2 cloud-build reservation; actual billing remains incomplete.

The new explicit-only `hermes-bedrock-connections` suite registers two pending
completion cells on local and Daytona. Read-only AWS discovery confirmed the
exact `us.anthropic.claude-haiku-4-5-20251001-v1:0` inference profile is active
in `us-east-1`. The fixture uses an ephemeral region-bound bearer, a public
personal Connections account and its explicitly selected grant. It verifies
the public account's owner, grant, region, protocol, authentication and model
catalog before task creation and after completion, and grades the actual native
run's selected account, grant and exact inference profile. The server inherits
no ambient AWS environment settings. It retains the existing 200-cent company
and agent budget admission and one-attempt policy. All 129 affected fixture and
catalog tests, Product E2E TypeScript, two-cell discovery and diff checks passed.
No Bedrock inference, credential refresh or Daytona execution is claimed from
this fixture preparation. Hermes remains pending qualification.

### Managed subscription walkthrough and public setup, 2026-10-08 UTC

The current macOS arm64 Rust/ACPX/native fixtures passed both tests at source
`bbadcc18a3a3279b8150ea61bb8ff60cd5b3acb6`, with the existing reviewed Python
closure. This was deterministic loopback transport evidence, with no paid model
or subscription inference. The owned Rust build cache was removed afterward;
the verified daemon was retained. Local Docker remains stopped.

The isolated current-source Paperclip app was exercised through Dashboard,
Connectors, Connect Grok, and its fresh personal subscription login controller.
The native device-login reached the official Grok consent page. Consent was not
granted before its bounded process exited; the public check never reported ready
and no subscription connection was saved. The real form showed an expired-attempt
error with Start sign-in again and a disabled Connect action. All four sign-ins
started in this disposable company were cancelled through public APIs, and the
owned app supervisor stopped. This is login/failure-path evidence, not a successful
managed subscription or Hermes turn.

Source inspection during clean-consumer preparation exposed a distribution gap:
the public server vendors only the runner's compiled output, while the original
Hermes provisioner/materializer were declared only in the private runner package.
The public CLI now supports `paperclipai runtime setup hermes`. Its self-contained
ESM/CommonJS setup entrypoints and Python materializer are included in compiled
output. Explicit setup installs the reviewed closure into the execution OS user's
cache, verifies complete bytes before publication, and re-verifies existing state
without overwriting an invalid installation. Runtime discovery retains packaged
assets as authoritative and uses the account cache only when assets are absent;
provider HOME overrides cannot redirect it. Source provisioning and public setup
share the pinned download/materialization operation. Python/ACP/ACPX pins and the
native bridge bytes are unchanged. Provisioning scratch and uv downloads remain
owned temporary files and are removed after settlement.

The focused setup/layout/cache/CLI checks passed 20 tests. Runner and CLI TypeScript
checks, the runner TypeScript build, generated protocol/profile checks and diff
checks passed. An additional package/model selection invocation passed 25 tests
and failed the standalone-boundary check with five violations. An independent
archive of unchanged `bbadcc18` reproduced exactly those same five violations;
none comes from the setup change. That baseline failure is retained, and neither
a whole-package boundary pass nor live clean-consumer setup is claimed here.

The preceding live Bedrock attempt used the exact Haiku 4.5 inference profile
and a region-bound bearer through managed Connections. AWS rejected inference
because Anthropic use-case details had not been submitted for that account.
Paperclip's original failed grade is retained; the native error text's
rate-limit wording is not the AWS cause. Cost remains unavailable. The owned
Linux qualification host and its temporary access were retired. The private
ledger retains $23 reserved against the $25 cap, not $23 measured spending.
Actual Daytona remains blocked on the previously reported token scopes.
Successful managed subscriptions, actual Daytona and the full original live
interaction/state/routine/distribution criteria remain required before promotion.

The clean read-only npm-packed Runner artifact at `b9603a3a` contained both
compiled setup entrypoints and the Python materializer. Fresh Mac setup failed
before publishing any runtime: disabling all uv configuration also removed
Hermes's archive-authenticated resolver settings. Credential-free Linux CI
reported the same failure. The source archive and dependency lock passed their
digest checks; neither the lock nor runtime pins were changed. A separate offline
uv check with an explicit configuration derived only from the authenticated
upstream `[tool.uv]` section passed and left the lock unchanged. Provisioning now
uses that explicit configuration instead of discovering operator/system settings,
retains `--locked`, and checks the lock digest again after dependency installation.

Fresh review of `b9603a3a` also correctly identified that setup validated the
inventory but did not read the installed runtime files. Setup now opens and closes
the same verified native snapshot used at admission before accepting existing
assets or publishing new ones. It never starts Hermes for this check. Regression
tests cover changed bridge bytes, a missing interpreter, and a substituted
entrypoint symlink while keeping the original manifest intact. All 14 focused
Runner Vitest tests and seven provisioner/build Node tests pass; Runner TypeScript
and the pinned-toolchain TypeScript build pass. The earlier failed packed setup
and Linux CI remain failures. Corrected
fresh installation, public server/CLI consumer execution and new-head CI/review
are still required; no release qualification or successful clean-consumer run is
claimed by these corrections.

### 2026-10-07 source recording and current live evidence

At `f884b7806665e6cbc18422937c687597e1767c7b`, corrected fresh setup
from the read-only packed Runner artifact completed on Mac arm64 in 30.354
seconds, with the reviewed closure, 19,248 files and 445,379,309 bytes. Existing
cache verification and independent production-factory admission also passed.
This still leaves the complete public server/CLI installation lifecycle open.
All three stacked PRs had passing checks and fresh 5/5 reviews at their recorded
heads; the qualification head passed 54 checks with two intentional skips.
The current Linux native artifact identifies merge checkout `179f0dd4`, whose
parents independently match native head `de39c85a` and qualification head `f884b780`.
These are credential-free fixtures, not actual Daytona or paid browser proof.

A real Mac OpenRouter completion cell passed in 49.650 seconds at that head,
including twelve independent matchers and cleanup. Its final screenshot shows
one final answer and Done. It also shows a budget pause before fixture teardown.
The settled run reports 61,035 input and 591 output tokens with unpriced cost;
the pause is consistent with Paperclip's existing unpriced-usage hard stop.
Continued use and billing coverage remain unqualified. OpenRouter documents
per-response `usage.cost`; safely collecting it must include retry, compaction
and delegated-call coverage instead of promoting Hermes's displayed estimate.

The Mac result producer omitted standard source metadata. Separate preflight
and launch receipts identify its checkout, and a post-run assessment confirms
clean `f884b780` source, but the original null fields and machine grade remain
unchanged. The launcher now derives the controller SHA/ref from clean Git before
credential loading, rejects explicit source mismatches, and retains a campaign
receipt. Read-only discovery remains available in a dirty checkout. This closes
future source-recording omissions; it does not rewrite or upgrade historical
evidence. Runtime identity still requires separate verification. No Docker,
provider inference, or additional spending is required for this correction.
All 60 affected source/API/Bedrock tests and Product E2E TypeScript passed.
The real launcher rejects a dirty checkout before credentials and still permits
read-only discovery. A separate credential-free localhost probe using the pinned
SDK and Hermes's native stream assembly preserved the synthetic response's
reported cost and upstream-cost breakdown. This proves those fields are available
before the bridge boundary; it does not prove complete agent accounting or live
billing. The initial sandbox socket denial is a separate infrastructure outcome.

Hermes remains pending the full original Mac/Daytona, subscription, connection,
attachment/control/state/routine and public-consumer gates. The ledger still
retains $23 against the $25 cap; unknown charges are not counted as free.

Review of `12098ba3` found that the source check rejected the trusted paid
workflow's resolved target lock. Admission now allows only its unstaged tracked
`pnpm-lock.yaml` replacement after independently hashing the complete regular
file against the workflow's approved SHA-256. The campaign receipt preserves
that digest and reports the actual dirty state instead of calling the working
tree clean. Other edits, staged replacements, missing/mismatched approval,
deletions and symlinks remain rejected. All eighteen source-admission tests and
Product E2E TypeScript pass. The root lockfile itself remains unchanged.

### 2026-10-07 reported-cost qualification work

The source/approved-lock correction at `805d787b` has 54 passing checks, two
intentional skips, a fresh Greptile 5/5 and no open review threads. The live Mac
budget pause above remains historical evidence, not a successful billing result.

The managed bridge now negotiates optional v1 wire billing for the selected
OpenRouter Chat Completions account. It observes the pinned synchronous SDK
without changing its requests or loop. Every inference attempt enters a
turn-owned ledger, including SDK retries and synchronous auxiliary calls.
Completed response `usage.cost` amounts become an exact nine-decimal USD
subtotal. Missing/failed/interrupted attempts, unsupported asynchronous calls
and background delegation keep settlement incomplete. Positive known spend
survives; absent charges never become free work. Other provider/protocol paths
retain unavailable billed cost. Credential/header values do not enter receipts.

The optional closed receipt crosses the ACP extension, both runner drivers,
Rust PRP normalization, replay and controller accounting. The controller binds
it to the selected biller and current turn, keeps cumulative estimates separate,
and rebuilds totals without duplicate charging on replay. Compaction resets of
native counters cannot replace wire totals. No budget safeguard was relaxed.
The public OpenRouter completion oracle now independently requires reported
settled cost and healthy company/agent budget state before cleanup.

Credential-free proof passed: 34 pinned Python tests, 63 focused Runner Vitest
tests, 16 Rust event tests, all 608 native executor tests, 28 Node protocol/build
checks and 87 source/API/Bedrock oracle tests. Runner, server and Product E2E
TypeScript and Rust formatting passed. Both Mac production transport fixtures
passed with the freshly built runner: Rust/image/semantic completion in 33.043
seconds and native streaming/restore/tools/questions/planning/memory/steering/
stop in 82.158 seconds. These use a deterministic loopback model and no
credentials; they are not paid billing or full-stack browser proof.

The reviewed closure changes only the bridge and added billing module. Both
previous platform manifests were authenticated against their committed pins;
the task-owned Mac asset was verified file by file before and after the update.
The new Mac closure is `9f1af058a963305ccd5c4f1555f2828458f72677ceacea2de456ac503f7212de`;
the derived Linux closure is `dd918ec15f5bd8025f3d01c4f2849eac4de8d59e237a520607f9c5f988a94645`.
Fresh Linux materialization, current-head CI/review, live reported-cost browser
proof and broader original release gates remain required. Existing cloud images
and prior results keep their old runtime/source identities. No local Docker,
paid inference or additional reservation was used for these offline checks.

### 2026-10-07 reported-cost live attempt and retry correction

The clean `f4ae618d` Mac browser campaign
`hermes-macos-billing-openrouter-f4ae618d38-20261008` failed its settlement
oracle after 110.244 seconds; cleanup passed. The original failure and its
`cleanup_failure` classification remain unchanged. Its public run receipt
reports `$0.001160247`, 61,157 input and 271 output tokens, with completed
accounting and an idle agent. The public company response omits `pauseReason`;
the oracle incorrectly required it to be null. The corrected predicate uses
the authoritative company status and agent pause state. The final screenshot
shows Done, one final marker, a thought card and an available composer.
Continued use was not tested; this failed attempt is not a qualification pass.

Review identified that a failed HTTP attempt can leave token totals unknown
after a successful SDK retry. The controller now separates final measurement
completeness from provider closure with the optional closed
`paperclip.accounting.settlement/v1` object. A known subtotal can settle once
as unpriced after native finalization. Unknown tokens stay null. Invalid
settlement, unfinished attempts, capture failure and unclosed coordinator state
cannot acknowledge debt. Legacy incomplete receipts retain their old behavior.

Paperclip owns task titles, so the managed profile disables Hermes's paid
background title upgrade while retaining its immediate derived session title.
This avoids title inference after a turn receipt closes. The updated Mac
closure is `ad1e555296e51be6d20a7234daeb7028570c7ee8fee9d27fb88c4f550491a07f`;
the derived Linux closure is `353a942b2a88542db8537611535898ae6088045608b88b4ddab491a6b000b8cf`.
Both predecessor manifests were authenticated, and the task-owned Mac asset
was verified file by file before and after the bridge-only transformation.
The full key reservation remains held because the failed campaign does not
prove complete account or background inference spend. Fresh native, live,
Linux, CI and review proof remain required. No local Docker is used.

The local full Vitest run at `f4ae618d` was interrupted after review required
a source change. Its log is retained and is not a passing full-suite result.
The earlier repository typecheck passed. Full checks must pass at the final
reviewed head before release qualification can complete.

The correction passes all 615 native-executor and durable-receipt checks,
35 pinned Python checks, 19 public settlement-oracle checks, repository-wide
typecheck and the full build. The native ACPX restore/control fixture passes
in 77.361 seconds. The Rust/image/completion fixture passes in 20.061 seconds
after its inference-only assertion was corrected to exclude metadata probes.
The adapter failure-path suite passes all 31 tests after the build completes;
the earlier concurrent-build test failures remain in their original log.
This is offline and deterministic proof. A new clean-head live campaign and
fresh CI/review remain required. Docker is confirmed stopped.

### 2026-10-08 input-yield accounting correction

At `d968e1d002`, all three stacked PRs passed their checks and fresh review.
The Linux native transport job passed against the current closure in 99.743
seconds using a deterministic loopback model. That is Linux transport proof,
not execution in Daytona or paid-provider qualification.

The Mac OpenRouter completion campaign passed 15 checks in 44.170 seconds,
with cleanup and reported settled cost of `$0.000645327`. The question retry
passed six behavioral checks in 91.154 seconds, but its first, input-yield run
had pending unpriced accounting. Its continuation emitted a reported complete
`$0.002543140` wire receipt. The original results remain unchanged; the question
behavioral pass does not qualify billing. An earlier question attempt failed
during provider startup and remains a separate infrastructure failure.

The transcript consumer revokes tool authority at a governed wait before
Hermes emits terminal usage. The per-turn runtime now reads the last bound
usage fact after owned shutdown and notification drainage, then journals it
through the existing accounting path. Session baselines cannot substitute.
Wrong session/run/turn/source, missing receipts and timed-out reads retain
unknown accounting. The versioned extended-harnesses oracle now requires every
run in a Hermes/OpenRouter workflow to settle reported cost with healthy
200-cent budgets before cleanup.

Focused proof passes 258 Runner tests, including shutdown retry and bounded
read failure, and 613 native-executor tests, including duplicate receipts and
wrong biller, plus five durable-journal tests and 64 Codex lifecycle/recovery
regression tests. Product E2E oracle tests pass 88 checks. The production
Rust/image fixture passes in 17.850 seconds using the retained binary. The
Python and ACPX/control/restore fixture passes in 110.567 seconds. Runner,
server and Product E2E TypeScript and generated contracts pass. These use a
deterministic loopback model. Clean-head live question accounting, full cloud
checks and review remain required for this correction. A full API-authority
guard implicitly rebuilt Rust before hitting a loopback sandbox error. Its
failed log is retained, and 828,116,992 bytes of unused cache were removed.
All subsequent full build guards run in cloud CI. Docker remains stopped.
The 29 authenticated Runner API integration tests pass separately with the
retained binary and loopback access. Package-boundary checks pass. Optional
forbidden/tracked-import guards still report existing violations in unchanged
files; their failed logs are retained. These are not passing guard results.
The total reserved amount remains `$23` against the `$25` cap; unknown spend
retains its reservation. Hermes remains pending qualification.

### 2026-10-08 committed-question native stop boundary

The clean `8c6c82a213` Mac question campaign failed after 644.667 seconds.
Its original infrastructure classification and `not_started` cleanup verdict
remain unchanged. Independent public records show that the yielded first run
had pending unpriced accounting. The company paused, so submitting Cobalt
could not launch the continuation. Independent cleanup checks found no owned
process group, server listener or temporary instance directory. These checks
do not replace the original cleanup verdict or establish billing completeness.

A credential-free native reproduction showed two races. Hermes could start
another model request after saving the question. Even after stopping that
request, immediate Runner shutdown could overtake the terminal prompt receipt.
The failed diagnostic logs remain retained.

The bridge now recognizes the authenticated assigned question result and uses
Hermes's native hard interrupt before returning from the completion callback.
It publishes that completion after native finalization and usage provenance.
Both Runner event pumps retain the completed question event until ACPX's final
prompt receipt has been read. Ordinary tools still stream. The deferred result
must be applied, pending, wake the assignee and match the current run. The
controller still validates durable wait and cost authority independently.

Both predecessor manifests were authenticated before the bridge-only update.
The task-owned Mac runtime passed complete file verification before and after
the transformation. Its new closure is
`f443a6867c914f49d7308c7421dbce9ba4a0d024b0c718a41a78845c784a7bd0`.
The derived Linux closure is
`c9879c3b69357d17d375d8fd4897f18496cebb21256c1e8bb9220d779d995921`.
Dependencies and Rust inputs remain unchanged. Fresh cloud materialization,
native regression, clean-head live billing and review proof remain required.
No new paid retry has started. Docker stays stopped, and the full unknown-spend
reservation remains held.

The correction passes 38 pinned Python tests, 108 focused Runner tests and
seven distribution fixtures. Runner TypeScript and generated contracts pass.
All four native fixtures pass in 106.153 seconds. The new Rust-sidecar test
immediately cancels and closes after the question result, observes exactly one
model request and retains the reported 10 input and five output tokens with a
complete turn delta. A provider that has already ended may reject interruption
as `already_terminal`; the test still requires verified owned close and the
receipt. This is deterministic transport proof, not live billing or Daytona
proof. The first focused sidecar run timed out under restricted local IPC;
its failure log is retained separately from the passing authorized IPC retry.

### 2026-10-08 early tool-bridge completion correction

The clean `1f3af78114` question campaign still failed after 644.970 seconds.
Its original infrastructure classification and `not_started` cleanup verdict
remain unchanged. The selected public run was pending and unpriced, and the
company paused before it could continue. Independent checks confirm the owned
process group, server listener and temporary instance directory are gone.
The key's full unknown-spend reservation remains held.

The live trace identifies an earlier event than the first reproduction used:
the control-plane tool bridge emits its own `dynamicToolCall` completion before
returning the tool result to Hermes. The controller parks on that event before
the native callback can finish. The managed Hermes launch policy now defers
that completed fact until the native terminal notification, after final usage.
Its original call identity and structured result remain intact. Other profiles
keep their existing order. Passive cancellation treats the driver's typed
`already_terminal` result as settled; other interruption failures still fail.

The native regression now cancels at that earlier bridge event. All four
fixtures pass in 139.789 seconds, including exactly one model request and a
complete reported token delta surviving immediate shutdown. Shared Runner and
Codex regressions pass 318 checks. The final result-copy and ordering tests pass
51 checks. Runner TypeScript and generated contracts pass. The pinned runtime
and Rust inputs are unchanged from `1f3af78114`. This remains deterministic
proof. Clean-head live billing, fresh cloud CI and review remain required.

### 2026-10-08 governed confirmation correction

The clean `d54a98895c` Mac question workflow passes in 71.476 seconds. A second
workflow preserves the exact pending interaction across a controller restart
and a fresh browser document, then resumes Hermes to completion in 107.945
seconds. Both have zero automatic retries and passing cleanup. Each has two
settled, reported OpenRouter receipts with healthy configured budgets. Their
reported totals are $0.002000649 and $0.001891331. Inspected screenshots show
the pending form, Cobalt answer, thought card, one final response, Done state
and available composer. This proves assigned Paperclip human input, not live
native `clarify_callback`. That head has 54 passing cloud checks, two skips,
and fresh Greptile 5/5 with no unresolved threads. Its credential-free Linux
job verifies the recorded closure and passes four native fixtures.

A separate clean-head planning workflow exposes the same early-stop problem
for `request_confirmation`. The plan is accepted, but its first run remains
pending and unpriced; the company pauses and the wake fails. The owned test
launcher was cancelled after preserving that public state. Its original
243.189-second infrastructure failure and `not_started` cleanup verdict remain
unchanged. Independent checks confirm no owned process group, listener or
temporary instance remains. Unknown spend stays fully reserved.

The bridge and both event boundaries now accept the three closed canonical
human-input kinds: questions, confirmations and checkbox confirmations. Each
must be an applied pending result from assigned `request_human_input`, with
`wake_assignee` and the original identity. Other kinds, tools, resolved results
and prose cannot stop work. This delays the fact only; the controller retains
wait, approval and accounting authority. The internal launch policy is named
for human input. The native regression covers immediate shutdown for each
kind. The bridge-only closure update retains verified dependencies and the
interpreter; the shared account cache is unchanged. Fresh live confirmation
proof, cloud CI and review remain required before claiming this correction
qualified. Actual Daytona and the broader release gates remain pending.

The correction passes 57 focused ordering/cancellation checks, 315 shared
Runner regressions and seven distribution fixtures. Runner TypeScript and
generated protocol/sidecar contracts pass. All six credential-free native
fixtures pass in 87.507 seconds, including 38 pinned Python checks and immediate
shutdown with a complete usage delta for each of the three human-input kinds.
These fixtures do not establish live approval, billing or Daytona proof.

## 2026-10-08 master synchronization

The three implementation branches were replayed onto master
`5717523b9ea7a2d76efbd6eb73414de9c06c6f96`, preserving their original refs and
qualification records. Master now owns Dot native input v6. New Hermes inputs use
v7; the closed reader accepts recorded ACPX Hermes v6 inputs and normalizes them
to v7. Dot v6 keeps its remote binding, empty credential path, and lack of
workspace access. Focused contract tests cover both identities, legacy Hermes
replay, authorized attachments, and rejection of cross-profile fields.

All live results recorded above remain evidence for their original checkout and
runner binary. Master changed Rust inputs, so the retained Mac binary cannot
qualify the synchronized source. Fresh Rust builds run in cloud CI. A new Mac
binary, current image, and the outstanding live matrix remain qualification
requirements. No local Docker or Rust build is used for this synchronization.

The trusted E2E workflow now downloads its checksum-bound build and provider-pack
archives under `RUNNER_TEMP`, outside the controller checkout. Source admission
checks every tracked change and all other untracked files. It excludes only
untracked content inside the generated Mac/Linux Hermes assets and provider-pack
roots; separate verified runtime admission still checks their manifests and
bytes before credentials. A 43-test source/workflow selection passes, including
tracked asset edits, staged/deleted files, root symlinks, neighboring unmanaged
assets, and archive placement. These are fixture checks, not paid workflow proof.

### 2026-10-08 Mac cloud qualification

The native transport workflow now includes standard GitHub-hosted Mac arm64 and
Linux amd64 jobs. Each job checks its platform, builds and stages the release
daemon in the cloud, provisions the reviewed Python closure, and runs the same
credential-free production transport fixtures against the exact staged binary.
Evidence records the PR head, actual checkout and source tree, runtime closure,
OS, Node version, fixture outcome, and tested binary checksum. The downloadable
binary archive preserves executable permissions. Fixture logs and failed-job
provenance remain available; an uploaded binary alone is not a qualification pass.

No local Docker or Rust compilation is needed. A passing cloud Mac fixture is a
prerequisite for current-source local browser qualification, not a substitute
for the live provider, published installation, or actual Daytona release gates.
Local workflow lint and all 44 focused source/security tests pass. Cloud execution
of the new Mac job remains required; this configuration is not a passing result.

The first `f129601d4` cloud Mac job compiles and stages the release daemon, then
fails cold Python provisioning before credentials or fixtures. Its candidate
closure is `253eaee233bd6fa1f5c5209084213e25a2da81b6cff5163f09eedcb15b1a93e2`
with 19,249 files and 445,500,822 bytes, differing from the reviewed Mac pin.
The original failure remains retained. General CI has 54 successful checks and
two skips; the sole failing check is this new Mac qualification job. Fresh review
is 5/5 with no open threads.

The downloaded daemon passes GitHub archive-digest, binary-checksum, architecture,
source-tree and signature admission. Its hash is
`fef7167af720db91537bbc066e3b8129a15d59bb6425dd95efa2b8a1a00b4980`.
On macOS 26.5.2 it passes all six native fixtures in 131.116 seconds, including
38 pinned Python checks against the fully verified existing Mac closure. This
is current-source transport proof with the cloud-built daemon and no local Rust
compilation. It does not make the failed cold installation or live matrix pass.

Cloud diagnostics now retain the candidate file manifest before rejected setup
removes its temporary distribution. The original materializer and closure pin
checks remain unchanged. Exact differing files must be identified and explained
before changing any reviewed runtime pin.

The diagnostic manifest establishes that only `python/lib/libpython3.12.dylib`
differs; the other 19,248 files are identical. Explicitly re-signing a task-owned
copy with 4 KiB pages reproduces the rejected cloud hash
`c592b475f247692c43a3c9de87d999c888adf89456d6986722d781425a402486` and size
18,075,920 bytes. Signing with 16 KiB pages reproduces the reviewed hash
`076cd19d748b2409ba5d82b530b68506f07c8edb4d920ac2cfaa8c34e3311d97` and size
17,970,928 bytes. Both signatures verify; the original runtime is untouched.
The materializer now specifies 16 KiB signing pages explicitly. No runtime pin,
dependency, native code, or credential boundary changes. Fresh cold cloud
provisioning remains required to establish that the correction passes.

### 2026-10-08 current Mac browser and controller evidence

At controller revision `7b2485dc6b0985d05bd4903503c517d8bd003d32`, fresh
cloud Mac arm64 and Linux amd64 qualification passes all six native fixtures
and 38 pinned Python checks on each target. The Mac closure remains
`2230a296b80cb79079f0e6223449e18affb0e9543a476fb5901fb0524f18a0f5`;
the tested Mac daemon remains
`fef7167af720db91537bbc066e3b8129a15d59bb6425dd95efa2b8a1a00b4980`.
This closes the cold signing-page-size prerequisite; it does not qualify a
published package consumer, a current published image, or actual Daytona.

The local managed OpenRouter API completion campaign
`hermes-macos-current-api-openrouter-7b2485dc6b-20261008-corrected1`
passes all 15 matchers and cleanup in 46.794 seconds. The exact model is
`deepseek/deepseek-v4-flash-0731`; the selected public run has settled reported
wire cost of $0.000955196. The screenshot shows the completed task, streamed
reasoning row and one visible final answer. This is one API account/completion
cell, not the remaining connection or interaction matrix.

The first current question/controller-restart campaign fails with its original
`cleanup_failure` grade and unknown cost retained. Its replacement server
crashes on Node 24.19.0's bundled Undici `setTypeOfService EINVAL`, matching
the [upstream issue](https://github.com/nodejs/undici/issues/5544) and
[guard correction](https://github.com/nodejs/undici/pull/5547). A task-scoped,
official checksum-verified Node 26.11.1 installation supplies the fixed
bundled implementation without modifying the original runtime or repository
dependencies. Two credential-free production controller restarts pass under
that runtime. The same pinned Hermes closure and cloud-built daemon then pass
all six exact native fixtures and 38 Python checks locally in 387.260 seconds.
Earlier fixture failures remain retained: a workspace incorrectly placed under
the temporary HOME, a restricted loopback launch, and a missing-history
operation timeout during concurrent controller work. None is relabeled a pass.

The subsequent campaign
`hermes-macos-current-question-restart-7b2485dc6b-20261008-fixed26-corrected1`
preserves the exact pending interaction across a successful controller restart.
It fails before answer submission because the browser driver expects the
literal button label `Submit answers`, while the saved canonical question set
validly supplies `Submit` and the UI renders it. Its original `candidate_failure`
grade remains retained, with cleanup passed and one settled reported run costing
$0.002011867. No resumed provider turn is claimed. The driver now uses the
existing canonical question-presentation helper to select the supplied label;
question identity, answer, exact final output, run-count and accounting checks
remain unchanged. A fresh complete browser run is still required.

These controller-restart cases use the assigned Paperclip `request_human_input`
tool. They do not qualify the Hermes-native `clarify_callback`, subscriptions,
Bedrock, other protocols, attachments with a live vision model, proactive
routines, the broader state/control matrix, or actual Daytona. Hermes remains
pending qualification.

### 2026-10-08 native question transport coverage

At `447eee1a96a3a950e633a1cc907827c776be9338`, the fresh Mac question and
controller-restart campaign passes all twelve matchers and cleanup in
151.621 seconds. Its two native runs restore the same recorded conversation,
submit Cobalt once, produce one final answer and settle reported wire cost of
$0.003527390. Current-head cloud checks pass on Mac arm64 and Linux amd64,
including six native fixtures and 38 pinned Python checks per target. The Mac
job first receives HTTP 429 before source materialization; its one targeted
retry passes. The Linux result retains its original attempt-one execution.
These results prove their stated scope, not the full release matrix.

Three additional native fixtures now cross TypeScript, Rust PRP, the production
sidecar, ACPX and the pinned Hermes `clarify_callback`. A single batch contains
single-choice, multiple-choice, custom and free-text answers. Submission must
produce the exact native tool result once; cancellation must report the native
cancelled batch; Stop during the question must terminate the waiting turn
without another model request or a semantic completion. Every path rejects a
second answer to the original request. The three fixtures pass locally in
48.195 seconds using the unchanged cloud-built daemon and Node 26.11.1, with
no credentials or paid provider calls. The following regression command
executes all nine native fixtures successfully in 183.842 seconds, including
38 pinned Python checks. Fresh cloud execution remains required for this change.

These deterministic fixtures provide native transport evidence. Live native
question forms, reconnect, cancellation and browser behavior still require
their own Product E2E acceptance. Subscriptions, Bedrock, a current published
image, clean public consumers, actual Daytona and the remaining release gates
stay pending. No local Docker or Rust build is used.

At `8cb867c6bfb78b4e927a9885e12a7080d663e014`, the fresh
[cloud native qualification run](https://github.com/paperclipai/paperclip/actions/runs/37777743115)
passes all nine native fixtures and 38 pinned Python checks on each target,
without retries or credentials. The cloud checkout is synthetic merge
`4f4bc382f6d34b68869b60f92e1dc1318b761766`; its tree exactly matches the
qualification branch. Both reviewed cold closure digests are unchanged.

### 2026-10-08 native question browser acceptance fixture

The explicit-only `hermes-native-interactions` Product E2E suite adds one local
and one Daytona cell. One live native `clarify` batch covers single choice,
multiple choice, custom input and free text. The browser reloads while the same
run and callback remain active, then submits the exact answers through the
normal form. The independent oracle requires full native card/run/turn binding,
one ordered post-write delivery receipt, HTTP 409 on a late duplicate answer,
one original successful run and a final reply containing the undisclosed
reviewer text returned by the callback. Assigned Paperclip question tools
cannot satisfy this case.

The fixture keeps the selected managed OpenRouter account/model, public
200-cent company/agent budgets, reported wire settlement, source admission and
normal cleanup. Each cell permits one attempt. Credential-free Product E2E
typecheck and all 1,953 unit tests pass, with one existing skip; discovery lists
exactly the two explicit cells. Native browser acceptance is still pending its
live run. Controller restart, native cancellation/Stop, subscriptions, Bedrock,
actual Daytona and the remaining original release matrix remain separate gates.

The first live native-question browser campaign at
`d35d986aab52d3c132f5dd243d39684b33d8c613` passes eight native card, reconnect,
exact-delivery and duplicate-rejection checks. The native `clarify` tool returns
the submitted batch. Its full attempt still fails with `candidate_failure`,
cleanup passed, after 144.541 seconds. The production delivery guard treats the
fixture's comma-separated negative clause as a file-output request, rejects
`paperclip_finish`, and the provider attempts publication before the configured
120-second native timeout. The original machine grade and unpriced per-run
usage remain retained. A provider-key aggregate read shows $0.172703466 more
usage; this is not a per-run settlement receipt and no budget hold is released.

A credential-free reproduction confirms the guard's interpretation and that
standalone prohibitions admit the same question-only task while preserving
positive file-output requirements. Definition version 2 uses those explicit
prohibitions and the current completion claim shape. An admission test calls the
actual production file/document guard. Product E2E typecheck, all 1,954 Vitest
tests with one existing skip, and exact discovery pass for this correction.
The production guard is unchanged. A fresh live attempt remains required.

### 2026-10-08 — native question browser acceptance and Stop gate

At source `6f08ecceda0afcf3e3d3ae0ba5043d82add96ac7`, corrected campaign
`hermes-macos-native-question-corrected-6f08ecceda-20261008-attempt1` passes all
25 checks and cleanup in 64.270 seconds. One original native run retains a
three-question callback across browser reload, receives the exact single,
multiple, custom and undisclosed text answers once, rejects a late duplicate
with HTTP 409 and completes with the returned text. Public provider-reported
cost is `$0.002484928`. Inspected screenshots and the canonical packaged
evidence have no missing entries or leaks. This is local native question proof.
The earlier failed attempt retains its original grade and unknown per-run cost;
aggregate provider-key usage is not a substitute settlement receipt.

Both current-source cloud native jobs pass nine fixtures and 38 pinned Python
checks without credentials. The cloud merge tree equals the recorded PR head;
55 checks pass with two skips, fresh Greptile 5/5 and no open review threads.
These checks do not qualify subscriptions, Bedrock or actual Daytona.

The next explicit local cell leaves the native question unanswered and clicks
the real browser Stop control. It must retain and bind the pending callback,
require one cancelled request and turn with an audited same-scope Stop receipt,
observe expiration and stale-answer refusal, preserve the unfinished task,
settle cancelled-run reported usage, and prove the public per-turn owner and
observed descendants retire before and through cleanup. This cell is pending
live qualification. Remote Stop still needs its own remote retirement observer.
No local Docker or Rust build is used.

The first local Stop campaign at `6b3c3a6708a2481a98edaffe15b722b6559dac6e`
retains its failed/cleanup-failed machine grade after 58.637 seconds. It captured
one genuine unanswered native batch and seven owned process identities, but the
new driver remained on the task list with Search open and timed out before
clicking Stop. The correction explicitly navigates to the canonical task route
before reading the native form. Cleanup now waits up to five seconds for
observed process retirement before its assertion. A later read-only audit
confirmed none of the seven retained PID/start identities remained. The private
recovery state is retained; original per-run cost is unavailable and its existing
allocation hold remains reserved. This attempt does not qualify native Stop.
Definition version 4 records the corrected navigation and bounded cleanup wait;
the earlier attempt remains a separate failed measurement.

The corrected Stop campaign at `1b16732f9d5be2d59d21139d10ea6f5e11785d55`
reaches the real browser Stop control and a same-scope acknowledged cancellation,
but retains its failed/cleanup-failed grade after 33.304 seconds. Shutdown emits
a provider-loss input expiry. Its durable fallback drops the legacy custom-answer
fields, so shared interaction creation rejects two canonical/legacy mismatches
and the run ends `native_session_interrupted`. The public native receipt reports
31,700 input and 169 output tokens, with unpriced cost and no ready accounting
receipt. All nine observed owned process identities have retired by cleanup.
The private recovery state and unknown-cost hold remain retained.

The form-conversion fix uses the existing shared canonical-to-storage converter
and passes nine focused fallback regressions, including a mixed custom-answer
batch, a synthetic-option ID collision and rejection of a genuinely incomplete
storage form. It preserves the canonical input and keeps shared validation
strict. Intentional Stop still needs investigation of the provider-loss path,
followed by new live acceptance; this fix alone does not qualify Stop.

The controller's native terminal mapper caused that provider-loss expiry: it
expired every pending structured input, including inputs on a confirmed
cancelled turn. A regression using the production driver and a scripted
transport reproduced the cancelled-to-expired conversion. The correction uses
the exact cancelled terminal's turn identity to retire its input once, with a
canonical cancellation outcome. Completed, failed and interrupted terminals
retain their prior non-replayable fallback behavior. All 186 related runtime
and request tests pass, including the four terminal outcomes. Nine fallback
regressions and direct server/runner TypeScript checks pass.

Definition version 5 also passes the cancelled-run expectation into the shared
account and OpenRouter settlement checks after the Stop helper returns. The
earlier definition incorrectly required a successful run at that final shared
boundary. The browser Stop response is now retained before terminal polling,
so a later failure does not discard that original public acknowledgement.
These changes need a fresh paid browser attempt; neither failed attempt is
regraded, and unknown-cost holds remain reserved.

At `6b3c3a6708a2481a98edaffe15b722b6559dac6e`, cloud Mac native fixtures pass.
Cloud Linux provisioning fails with HTTP 429 before fixture execution. The
cloud Docker context check separately fails at Docker Hub's pinned Node image
manifest request with HTTP 502. Original CI failures remain recorded.

The server's composite typecheck unexpectedly invoked its Rust build. That
local build is not qualification evidence. The completed build left no live
compiler; its 850,932,819 bytes of disposable target output were removed and
the staged runner restored to the verified cloud-built binary. Subsequent
checks invoke TypeScript directly and perform no local Rust or Docker build.

At `1bda794003f98bf6e2879cd474c7f84c3e4145a9`, both cloud targets pass nine
native fixtures and 38 pinned Python checks. The verified Mac artifact retains
binary SHA-256 `fef7167af720db91537bbc066e3b8129a15d59bb6425dd95efa2b8a1a00b4980`.
Fresh Greptile reports 5/5; 53 checks pass with two skips. The broader browser
shard fails during an unrelated agent-chat cleanup with a database lock timeout,
then leaves its instance setting enabled for the following test. Its original
failure remains recorded; PR checks are not fully green.

The native Stop fixture now consumes events through the cancelled terminal
instead of closing immediately after the interrupt acknowledgement. It requires
one same-scope cancelled native input, one ordered cancelled terminal, no fallback
or invented completion, retained final prompt usage, and rejection of a late
answer after terminal settlement. The strengthened fixture passes locally in
16.526 seconds against the verified cloud-built Mac daemon, using an empty home
and a deterministic loopback model, with no credentials or paid calls. Earlier
fixture attempts remain separate: one checked the late answer prematurely and
failed during shutdown; another placed the workspace inside its isolated host
home and was rejected before launch. Neither is live-provider proof. A fresh
paid browser Stop campaign and the remaining release gates are still required.


### 2026-10-08 native Stop projection and terminal receipt fixes

The original `759f7bfccd` paid Stop attempt remains failed and is not regraded.
Its native callback and turn cancelled, its audited browser Stop returned HTTP
200, and all nine observed process identities retired. The card stayed pending,
generic stranded-work recovery later blocked the task, and the cancelled run's
cost stayed unpriced. No held reservation is released from these fixes.

The server now projects the exact native input cancellation into its question
card, checking company, task, agent, run, session, runner, turn, item and the
committed creation. The pending-card compare-and-update cannot overwrite an
answer, replay cannot create another expiration, and the transaction locks the
task before the card. Both local and durable PRP observation use this projection.
Unrelated historical questions and provider-loss handoffs retain their lifecycle.
Recovery checks deliberate operator Stop before escalating an uninvokable
assignee, so a later agent pause cannot turn that Stop into stranded work.

The ACP boundary had discarded Hermes's final usage notification once Stop
aborted its control signal. Only that admitted prompt's final usage can now
cross the cancelled boundary, with its exact native session and negotiated turn
token, before prompt settlement. Requests and other activity remain closed.
Stream/process closure ends the receipt window and cannot reopen it. The native
wire ledger and completeness rules are unchanged; missing charges stay unknown.

Credential-free regression evidence: the paused-agent recovery test first failed,
then its full suite passed 79 tests. Native card cancellation first failed seven
checks, then the final suite passed 38 tests, including nine identity denials,
replay, late-answer rejection, preserved historical answers and a concurrent
answer/Stop race. The billing-boundary regression first failed because no receipt
reached its owner; the affected ACP/usage suites passed all 110 tests after repair.
Direct server and Runner TypeScript checks passed. An intermediate implementation
scope error is retained as a failed test attempt; it is not qualification proof.
No local Docker, Rust build, secret access or paid provider call was used for this
repair. A fresh committed-source browser Stop attempt and complete release gates
are still required. The PR stack remains draft and Hermes remains pending.

### 2026-10-08 bounded qualification budget and cleanup verification

Hermes qualification campaigns now accept a pinned company and agent budget
from 1 to 200 cents through `PAPERCLIP_RUNNER_E2E_HERMES_BUDGET_CENTS`. The default
remains 200 cents. Fixture creation, public checks before execution, settlement
checks and definition metadata all use the same captured value; malformed or
larger limits fail before credential handoff. Definition versions advance to
6 for native interactions, 2 for API and Bedrock connections, and 3 for extended
harnesses. Behavioral matchers, account scope and single-attempt policy remain
unchanged. The exact local Stop cell is discoverable with a 100-cent limit.

The earlier `782774e1` launch stopped at its allowance preflight before any model
call: the selected existing key had less than the required $2 available. It did
not start a campaign, modify the reservation ledger or release an unknown-cost
hold. A future 100-cent campaign is a separate measurement with its own pinned
source and definition identity; existing failed attempts retain their grades.

Credential-free verification passes 2,023 Product E2E support tests with one
platform skip, 128 native source checks and the Product E2E TypeScript check.
The first full support run retained one process-shutdown timing failure; the
same suite passes with four concurrent workers. Both cloud native targets pass
at `ec40b1eb`, and the existing PR checks are green at their recorded heads.
These results do not qualify a live provider, a subscription or Daytona.

Two earlier review repairs are also verified: native cancellation accepts the
Rust envelope's omitted action while rejecting conflicting responses (121
database tests), and Hermes releases assigned skill copies after a credential
or state-collection failure only once runtime exit is verified (141 affected
runtime tests). The local TypeScript runtime must be rebuilt from the current
source before the next paid campaign. No local Docker or Rust build is used.

The `36125adb4e` 100-cent Stop campaign retains its failed/cleanup-failed grade
after 300.437 seconds. The browser Stop is acknowledged, one native input and
its turn cancel in order, the question becomes expired, and the task stays in
progress. All nine observed PID/start identities retire. Billing remains
unpriced despite complete reported token accounting (31,665 input and 218
output tokens), so the independent settlement gate correctly fails. The private
recovery state and unknown-cost hold remain retained. This is progress on native
cancellation, not a live Stop qualification pass.

Qualification review identified two independent evidence gaps. Six negative
runner/session identity cases and a local-settings catalog case first failed.
Answer delivery now requires the created request and resolved receipt to name
the same runner and normalized session. The public budget setting is read and
validated before catalog construction and pinned into the child environment;
credentials and other file settings still load at the normal later boundary.
Definitions advance to native version 7, API/Bedrock version 3 and extended
version 4. Earlier measurements retain their source, definition and grade.

Source inspection finds that pinned ACPX also drops extension notifications
when its native elicitation controller is aborted, before Paperclip's outer
cancelled-receipt boundary. Hermes usage now enters through ACPX's public
inbound-message observer, with the same exact native session and negotiated
turn-token checks. The ordinary extension callback excludes that one method
to avoid duplicate delivery. Other notifications and requests retain their
existing admission paths. No ACPX version or dependency lock changes.

The strengthened production transport fixture checks the actual durable PRP
carrier: one owned Hermes usage-provenance notice precedes the cancelled turn,
and both retain their runner, session, run and turn identities. The same fixture
fails with the previous adapter because its receipt is missing, then passes with
the repaired adapter and the verified cloud-built Mac daemon. The comparison
restores the repaired source and bundle byte for byte. An earlier fixture
attempt inspected the normalized lifecycle stream, which does not carry these
informational notices; that failed attempt is retained and is not the regression
proof. This fixture has no provider credentials and proves transport, not paid
OpenRouter charge settlement.

Final local checks pass 184 affected ACP tests, both Runner TypeScript checks,
and 2,035 Product E2E support tests with one platform skip. Product E2E TypeScript
also passes. A fresh committed-source browser Stop, current-head cloud checks,
and the remaining release matrix are still required. No local Docker or Rust
build was used, and no unknown-cost hold was released.

### 2026-10-08 live billing and persisted cancellation receipt

The current-source `a14a752ec8` local Stop attempt retains its original
failed/cleanup-failed grade after 301.128 seconds. The wire repair now delivers
complete provider-reported billing: $0.000973314, 31,673 input tokens and 315
output tokens. Public read-only observations confirm the cancelled run, exact
audited Stop acknowledgement, expired question and unfinished task. All seven
observed owned process identities retire. Evidence has no leaks or missing
entries, and the failure screenshot was inspected. Earlier unknown-cost holds
remain reserved; this measurement is recorded with its known charge.

The remaining wait is an oracle error: the browser fixture requires the expired
card's result to be absent, but native cancellation correctly persists a v1
cancellation receipt with zero answers. Offline analysis of the captured public
state passes the exact native cancellation predicate and rejects only that old
card predicate. The failed campaign is not regraded or replayed as a live pass.

The corrected card oracle requires the original payload, company, task and run
binding; the same card must expire under the owning run, retain no human or
agent answer actor, and contain the exact cancellation receipt with no answers.
The regression first fails the real receipt and incorrectly accepts a missing
receipt. The corrected source passes all 2,057 Product E2E support tests with one
platform skip, 128 native source checks and Product E2E TypeScript. The restricted
full-suite attempt retains its IPC/process-permission failures; the host-access
run passes. Post-hoc comparison passes the corrected oracle on the captured state
without changing the original grade or making any provider call.

Affected definitions advance to native version 8, API/Bedrock version 4 and
extended version 5. Production runtime, dependency locks and execution controls
do not change for this oracle repair. Fresh committed-source browser acceptance
and current-head cloud checks remain required. Hermes is still pending.

The separate `2400ecdb8d` committed-source local Stop campaign passes all 28
matchers and cleanup in 58.852 seconds, with one attempt and no automatic retry.
The browser Stop closes the exact native callback and turn, a late answer gets
HTTP 409, and reload preserves the unfinished task and expired zero-answer card.
All nine observed owned process identities retire through cleanup. Complete
selected-account OpenRouter billing settles at $0.000806592 for 31,687 input
tokens and 291 output tokens; public $1 company and agent budgets remain healthy.
The final screenshot was inspected, and packaged evidence has no leaks or
missing entries. Earlier failed grades and unknown-cost holds remain unchanged.
This qualifies only local native question Stop on the recorded source and model.

Cloud run `37825846189` also passes nine native fixtures and 38 pinned Python
checks on each Mac arm64 and Linux amd64 target at `a14a752ec8`. Its archives are
verified against the recorded source tree and binary checksums; the Mac signature
passes strict verification. The production runtime is byte-identical in the
passing `2400ecdb8d` browser source. Repository CI at the latest head and the
remaining subscription, account/protocol, attachment, state, control, routine,
published-consumer and actual Daytona gates still prevent release qualification.

### 2026-10-08 local file delivery and native image preparation

The `af87a249c1` local `file-edit-validate` campaign passes all 11 matchers and
cleanup in 126.310 seconds, with one attempt and zero automatic retries. Hermes
creates and edits the workspace file, runs a real content verification command,
registers the deliverable and completes the task. Independent workspace and
downloaded artifact checks confirm exact bytes. Complete selected-account
OpenRouter billing settles at $0.006084928; the public $1 company and agent
budgets remain healthy. The final screenshot was inspected, and packaged
evidence has no leaks or missing entries. Persisted events include incremental
text and tools before the terminal receipt; this post-hoc timing observation
does not qualify live browser streaming or hidden reasoning display.

On the same source, cloud run `37830289657` passes nine native transport fixtures
and 38 pinned Python checks on each Mac arm64 and Linux amd64 target. The normal
PR CI run `37830289962` initially fails a five-second slow-CPU chat startup
expectation and loses its canary cloud runner to a shutdown signal. Both
original logs and the browser trace remain preserved. The single allowed
no-source-change failed-job retry succeeds; the latest workflow attempts pass.
Superseded duplicate automatic runs retain their cancellation records. No local
Docker or Rust build is used.

The separate explicit-only `hermes-image-input` suite prepares local and Daytona
image acceptance on an exact vision-capable OpenRouter candidate model. Its PNG
contains an undisclosed eight-character code only in pixels. Browser upload,
exact authorized download bytes, native semantic completion without file/OCR
tool substitution, selected-account billing and cleanup are independent gates.
The code is absent from model text and filenames. The existing text-only
DeepSeek profile and previous campaign grades remain unchanged. Credential-free
support checks pass 2,075 tests with one platform skip, all 128 native source
checks and Product E2E typechecking. Both exact image cells are discoverable;
the fixture PNG was visually inspected. These checks validate preparation;
a fresh committed-source live image run and current-head CI are required before
claiming that coverage.
The remaining full release matrix and actual Daytona proof still gate Hermes.

### 2026-10-08 native image grading review

Review of the image fixture at `9478ead982` finds that its checks are recorded
after the generic matcher gate, allowing wrong downloaded bytes or a forbidden
tool to escape the final verdict. Image definition version 2 explicitly requires
every image check to pass after account and billing evidence is collected.
The attempted version 1 launch stopped during its allowance read with HTTP 401,
before a campaign, model call or new budget reservation. No live image grade
exists to revise. The key refresh and a fresh committed-source version 2 run
remain required; previous passing workflows do not qualify image input.
The correction passes 259 focused image/account/catalog/report tests, 128
native source checks and Product E2E typechecking. These credential-free checks
include plausible wrong image bytes and forbidden-tool evidence; a browser
campaign and fresh cloud CI remain separate requirements.

### 2026-10-08 native permission and route restoration corrections

The restrictive-mode browser exposed two approval boundaries for one native
edit. The managed middleware now covers the native edit requester only within
the same authorized tool invocation. Nested native edits still require their
own policy and permission check. Planning and protected-path checks run before
every operation, including operations with a recorded session grant.

Allow-for-session grants use the closed `paperclip.hermes.permissions.v1`
metadata record. It contains only a scope digest and native tool names. It
preserves grants across provider stops and strict restoration, including native
compaction heads. Changed conversation, model, route, workspace or permission
policy clears the grant. Unknown or unreadable records fail restoration.
Concurrent calls to one tool share a confirmed session grant. Allow once and
deny never create a grant, and cancellation racing a reply prevents execution.

Native Hermes records a named custom provider as `custom`. Restoring through
that bare alias loses its identity. The bridge validates the recorded route,
resolves through the selected configuration's provider name and rejects a
native model or route fallback before starting a turn. Assigned-skill identity
uses bounded, regular-file content hashes and relative names. Replacing an
unchanged disposable skill lease therefore preserves the grant; content changes
invalidate it. Assigned skills remain protected from writes.

The correction passes 50 checks on the pinned Python runtime, 27 focused
TypeScript integrity/recovery/extension checks and seven packaging checks.
The native ACPX fixture verifies actual once/deny/session file effects,
unchanged saved metadata around a provider restart, two same-name tool call
identities, conversation isolation and Stop while approval is unanswered.
The selected scripted model has no authentication or paid calls. This is native
transport coverage, not browser or live-provider acceptance. Earlier failed
fixture attempts retain their verdicts, including a message-separator oracle
error, a lost session grant and its bounded timeout.
The complete local ACPX runtime suite passes all three tests in 106.346 seconds,
including the 50 pinned Python checks and restoration through a newly copied
assigned-skill lease. The native file tool refuses an assigned-skill write even
when it has a session grant. The independently checked skill bytes stay intact.

The reviewed Mac and Linux closure pins change only for the bridge source.
Fresh cloud materialization, current-head native checks and PR verification are
required. No local Docker or Rust build is used. Shared configuration adoption,
routine completion and transcript UI patches remain unapplied outside the fixed
PR file set. Hermes remains pending the full release qualification matrix.

### 2026-10-08 active steering through the production transport

The actual browser journey negotiated Hermes steering and exposed the Steer
action, but the production transport rejected its current target as stale.
ACPX validates controls against the active provider turn; the transport had
sent the durable Paperclip turn that scopes PRP and semantic events. It now
sends the active provider identity for ACPX controls. Other provider mappings
retain their existing contract.

The focused regression crosses TypeScript, Rust PRP, the production sidecar,
ACPX and pinned Hermes with distinct durable and provider turn IDs. It first
reproduced the stale-turn rejection. After that correction it exposed duplicate
steering acknowledgements: item rehydration wrapped the flat Runner receipt,
so the driver could not recognize its transport echo. Preserving that flat
receipt retains durable evidence and emits one bound transcript acknowledgement.

The regression now passes with the verified cloud-built Mac Runner. It verifies
that the native agent receives the correction, the active request is interrupted,
exactly one provider turn and acknowledgement remain, semantic completion
succeeds, and a control after settlement is refused. This is credential-free
native transport evidence. The earlier browser and regression failures remain
failed; a fresh browser acceptance run and cloud checks remain required. No
local Docker or Rust build is used.

### 2026-10-08 Linux tool device access

Current-source cloud qualification passed all 11 Mac native fixtures, but the
Linux run failed overlapping restored-session writes: shell redirects could
not open `/dev/null`, so Hermes fell back to a PID-based temporary name shared
by separate tool PID namespaces. Ordinary bubblewrap bind mounts disable
device access. The native tool sandbox now mounts bubblewrap's minimal `/dev`
before applying the existing protected-path and assigned-skill overlays.
Admission probes the actual character device and read/write redirects before
staging credentials, rather than only executing `true` in a namespace.

A focused policy regression fails before the change and passes afterwards.
Four host-probe tests pass locally. A Linux-only regression exercises 16
concurrent atomic writes, device redirects, hidden protected files and read-only
assigned skills on the real host sandbox. Its live result requires fresh cloud
CI; a Mac skip is not Linux evidence. Candidate closure pins replace only
`tool_process.py` in the previously verified manifests; fresh provisioning must
match them before any runtime is admitted. The prior Linux failure remains
recorded. Both existing PR file sets remain unchanged, and no local Docker or
Rust build is used. Full provider, product and Daytona qualification is pending.
