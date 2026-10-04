# Cursor production readiness — 2026-10-03

The release scope is Cursor CLI `2026.09.26-dd393fe` on macOS ARM64, macOS x64,
and Linux x64 (including Daytona). Qualification uses the explicitly selected
`gpt-5.6-luna[context=272k,reasoning=medium,fast=false]`. Native AskQuestion and
authoritative per-run USD accounting are excluded from certification. Semantic
Paperclip questions remain the supported question path. Unknown usage is unknown.

The proposed release supports authenticated Paperclip tools, semantic questions,
native plan decisions, permission control, rich activity, file delivery, durable
responses, cancellation and warm continuation. The matrix below records the
current proof for those capabilities; it does not certify pending remote cells.
Accepted planning succeeds while the task waits for explicit user direction.
Acceptance does not start implementation.

Install with `paperclipai runtime setup cursor`. Configure company secret bindings
for `CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN` and select the model explicitly.
Agent is the default mode; Plan and Ask are explicit alternatives. Missing assets,
credentials, model availability and entitlement are diagnosed without substituting
a model. A new managed-login experience is outside this release.

Image-input delivery, detailed native diffs and deeper child transcripts remain
follow-ups. Partial counters are diagnostics; they do not establish measured
spend or enforceable per-run dollar accounting. Native AskQuestion is implemented
defensively but is not advertised or certified. See the
[Cursor capability contract](../architecture/runner-cursor-capabilities.md).

## Current release checkpoint

The integration is in draft PR [#15075](https://github.com/paperclipai/paperclip/pull/15075).
Production admission remains disabled. The frozen runtime is
`d0b90756e3abe9e7516caded784036f01e76ad25`; the latest controller and fixture
repairs are `473206cd9d5c7e4399b03869b42a9e9f6ba96c09`. Cursor profile v11,
patch `paperclip-cursor-usage-v4`, CLI version and explicit Luna model remain fixed.

| Required case | Current local proof | Fresh Daytona proof |
| --- | --- | --- |
| Completion through authenticated tools | `hello-complete-01`: passed, cleanup passed | Pending |
| File edit, validation and registered download | `file-edit-validate-02`: passed, cleanup passed | Pending |
| Semantic question after controller restart | `structured-question-restart-resume-01`: passed, cleanup passed | Pending |
| Semantic plan approval and completion | `plan-approve-complete-01`: passed, cleanup passed | Pending |
| Native reject, revise and accept | `native-plan-reject-revise-accept-01`: passed, cleanup passed | Pending |
| Native plan cancellation | `native-plan-cancel-01`: passed, cleanup passed | Pending |
| Denied write after reconnect | `native-write-deny-reconnect-01`: passed, cleanup passed | Pending |
| Stop during pending permission | `pending-permission-stop-01`: passed, cleanup passed | Pending |
| Three warm turns | `warm-three-turn-01`: passed, cleanup passed | Pending |
| Pending permission followed by provider loss | `pending-permission-provider-loss-01`: passed, cleanup passed | Pending |

Each local identity has prefix `cursor-v11-d0b907-local-`. Results live under
`tests/runner-e2e/results/<identity>/<suite>/runner-acpx-cursor/local/<case>/attempt-1/result.json`.
The file repeat uses controller/fixture 473206; the other cases use 5e6c16.
All ten cases use runtime d0b907. Automatic retries are zero.

All seven Runner semantic cases passed on this frozen runtime with owned
processes retired. Their campaign identities have prefix `cursor-v11-d0b907-`
and suffix `-01`: `get-task-context`, `context-before-action`,
`create-task-document`, `finish-task`, `request-human-confirmation`,
`workflow-context-document-progress`, and `workflow-governed-wait`.
Every strict score remains `accounting_failure` for
`provider_budget_coverage_unknown`; per-run USD is null. These failures are not
included in the semantic pass count.

| Platform | Provider-pack manifest digest | Daemon SHA-256 |
| --- | --- | --- |
| macOS ARM64 | `9e3312c292a5cf9705c75cf2ae6d7435222547e749bf210330be0e7f5d09b822` | `70174bb6f293bb5348ea638e3052abbdc69689b5b4635827c3b7d50e23a2b8e0` |
| macOS x64 | `51a146a4013fcf4de05254509cb6056356e60c9f825feec648a347310953899e` | `0efe9ca359b961d429a475354473c462c31b95c6670a1d9ce50be601568c80c8` |
| Linux x64 | `7c7bdec69c69e890c5ae3da7d8f80026412c397436adec8aa074f3653ff852c2` | `34d1b96550669613e91b3df75752164609ddfbeec70ea821e540558f8a96ddb6` |

The qualification image is built locally at
`sha256:16c7be3610f45e409f67873dd4bd829f9a1e0e5f017c8826d01db4bb05720f97`.
Automatic approval review requires explicit authorization to publish it to
`ghcr.io/paperclipai/paperclip-daytona-runner:cursor-qualification-d0b90756e3ab`.
That approval is pending; the fresh remote matrix has not started.

The isolated public package verifier passed at source 473206: 18 public packages,
enabled lifecycle hooks, no implicit Cursor provisioning, explicit pinned setup,
all three packaged daemon targets, and an ordinary installed Linux daemon launch.
The consumer image is `node:24-trixie@sha256:be40f6a87b9b22215ddb20da0a2320a5c6d583fe3ee3b0024d9fa4f05b40c8fd`.
Package version is `0.0.0-cursor-verify.473206cd9d5c`; provider calls were zero.

MacOS release assembly re-signs copied daemon inodes. The exact packaged hashes
are ARM64 `33bb9276b4d79be33f77c89a76ab71946808583500c6200a144b324479fbd9d8`,
x64 `1bcd1bdc015f15a8321c9564d008284fd105da4f019632ff81ba0c9f75ae28d7`,
and Linux x64 `34d1b96550669613e91b3df75752164609ddfbeec70ea821e540558f8a96ddb6`.
The source daemon hashes remain as listed above.

All 53 applicable CI checks passed at 473206, with four skipped. Greptile reported
5/5 with no new blocker. Local default-suite coverage is complete through the
original general-server run, its affected repeats, the remaining workspace groups
and the serialized route files. Original failed attempts keep their failed status;
the complete default command was not repeated.
Recursive typecheck, full build, token gates, four native launch/selection tests,
1,568 Vitest harness checks and 128 Node harness checks passed. The combined
harness wrapper exits nonzero because it includes three Node suites as Vitest
files; their separate Node execution passed. The final installed task smoke,
production promotion and final certification remain required.

## Source-to-port map

| Source | Destination / decision |
| --- | --- |
| Mainline `dd868ed125cd709506dd9b29fca640a44d580501` | Branch `codex/cursor-production-readiness`; preserve its recovery, completion, and managed warm-directory ownership |
| Combined snapshot `22c78242a4e0c2369fecf0c2dc4e7600fbad6706` | Cursor installation, native isolation/instructions/modes, extensions, tool evidence and partial usage |
| Same snapshot, shared ACP transport | Permission identity, delivery acknowledgement, cancellation, canonical tool lifecycle and recovery-mode binding |
| Same snapshot, controller | Accepted-plan wait proof, status arbitration/commit/recovery, durable cancellation request ownership |
| Same snapshot, Product E2E | Cursor native interactions, active Stop, warm continuity, remote observers and owned cleanup |
| Mainline warm agent-files work | Retained instead of importing the older competing warm-copy implementation; extend its ACP applicability when qualified |
| New public installation work | CLI `runtime setup cursor`, bundled provisioner and default provider-pack assets |
| Pi/Copilot source and campaign | Excluded; existing pending providers retain mainline identities and admission gates |

Historical proofs retain their original profile/build identities. In particular,
the v10 Stop result at source `22c78242` and the earlier plan/warm/Daytona completion
results do not certify this assembled candidate. Strict accounting failures are
preserved; semantic behavior is assessed separately.

## Readiness checklist

- [x] Create the branch from the agreed mainline base.
- [x] Port Cursor and necessary shared implementation without replacing newer controller files wholesale.
- [x] Complete targeted tests and make the consolidated branch buildable with admission disabled.
- [x] Ship and verify explicit public runtime setup; npm lifecycle must not download Cursor.
- [x] Include Cursor in ordinary provider-pack and Daytona image builds.
- [x] Verify company secret bindings, exact model diagnostics and Agent/Plan/Ask configuration.
- [x] Preserve successful accepted planning runs as open tasks awaiting explicit user direction.
- [x] Show unavailable accounting explicitly and keep partial counters diagnostic-only.
- [x] Freeze candidate source/profile/patch/pack/image identities and build all three platforms.
- [x] Reconcile the remaining campaign budget; run paid cells serially within the existing account cap.
- [ ] Qualify normal setup/completion locally and on Daytona.
- [ ] Qualify file editing, independently checked bytes/validation and accessible artifacts on both targets.
- [ ] Qualify semantic questions/restart with exactly-once answer consumption on both targets.
- [ ] Qualify native plan reject/revise/accept/cancel and correct task/run states on both targets.
- [ ] Qualify denied writes and Stop during pending approval, including owned process retirement, on both targets.
- [ ] Qualify three warm turns with stable session/workspace/agent-files ownership and no duplicate output on both targets.
- [ ] Qualify provider loss, input expiry and actionable errors without mutation replay or false success.
- [x] Run seven semantic Runner cases; retain strict accounting results separately.
- [ ] Promote Cursor consistently only after the candidate passes; leave other pending providers gated.
- [x] Run contracts/replay, token gates, recursive typecheck, full tests and build; retain failed local attempts and verify affected repeats separately.
- [ ] Repeat a clean normal-install smoke with qualification overrides absent.
- [ ] Deliver exact identities, capability limits and completed acceptance matrix; prepare focused template-based PR.

Production merge/deployment is a separate final action. Rollback disables new
Cursor admission while preserving records, valid committed plan waits and recovery
inspection.

## Consolidation verification

The assembled workspace build and recursive typecheck pass. Focused Cursor
normalization/installation tests, controller settlement tests, CLI setup containment,
and 19 native ACP backend tests pass. The 65 protocol/package contract checks pass.
Full-suite failures remain retained for diagnosis; these narrow results are not a
production certification. All three pinned Cursor distribution closures were
materialized and verified afresh. macOS ARM64 ordinary provider-pack preparation
passed without candidate flags.

The resolved campaign lockfile remains local because repository policy gives
GitHub Actions ownership of lockfile commits. Its SHA-256 is
`70af8ab3d7051c85fc1a55c11e9afe8887d9711232e3c6e97666006562217e5f`;
retain these exact resolved bytes with candidate artifacts and pass their digest
to the immutable image build.

## Qualification preparation and demonstrated repairs

Candidate `9ba53fced5de6dabd1e931b7438d9dd118e45f0f` passed local
completion, semantic question continuation, and file-edit/validation Product E2E
cells with the explicit Luna model, serial execution, no retries, and successful
cleanup. Their original campaign identities remain unchanged. Measured per-run
dollar usage is unavailable, not zero. The existing Cursor account-cycle cap is
counted once against the reconciled campaign envelope.

Fresh ordinary provider packs were built for macOS ARM64 and x64; the Linux x64
Daytona image also built successfully. These are preparation artifacts, not a
completed release certification.

Public-package inspection found that setup derived the standalone runner layout
when embedded in the server's vendored layout. The provisioner now selects its
contained public asset root explicitly and rejects an unbundled source invocation.
Three containment checks pass. `node scripts/verify-cursor-npm-install.mjs`
packages the actual public CLI/server dependency graph and verifies installation,
enabled npm hooks, explicit setup, and the installed Cursor execution closure in
an isolated consumer. It retains evidence under its printed temporary directory
and makes no model calls. npm hooks may fetch normal platform dependencies;
Cursor provisioning must remain absent until the public setup command runs.

The new explicit-only `native-provider-loss` Product E2E suite covers the missing
transport-loss gate locally and on Daytona. It loses only the observed per-turn
run owner while a native mutation is awaiting permission, then requires a visible
failed run, an unanswerable stale approval, an open task, no automatic replay,
no changed target, and retirement of the owned process tree. The remote fault uses
a Linux pidfd bound to the retained start ticks and boot ID.

The initial full test run retained resource/startup failures. Targeted reruns
passed 43 boundary/file-handoff checks, 196 real-runner checks, and 1,742 of 1,744
remaining server checks. The two remaining assertions compare macOS `/var` aliases
against canonical `/private/var` paths; no unrelated test repair is ported.

## Historical candidate and qualification checkpoint

The runtime candidate is `ccae835581923876ad5ac0ef12bf763e54958db9`,
rebased onto mainline `569c7203aa24b95440682983ce7940ba1d4247bd`.
Commit `d3dd596c77a9032da639201f1b05dc6891479e68` changes only verification
fixtures: public-install probing and the provider-loss oracle/admission. It does
not change the candidate runtime. Product results retain their runtime source and
catalog fingerprints; the verification commit is an additional harness identity.

Cursor profile v11 binds command digest
`sha256:2feb50c7b0a317dff454c00115a5bbe4d5c757189691586577be9c80234d477e`.
The native patch remains `paperclip-cursor-usage-v4`.
The ordinary macOS ARM64 pack digest is
`sha256:7443adb3ab1d2fbd7081532923bcc6eaf8d9f511aff22fac6836c647ac6a3c8e`.
Both macOS targets were built with official standalone Node 24.21.0; the x64
daemon also executes under Rosetta. Linux image preparation retains its own
manifest identity; the remotely pulled digest must be recorded before a live cell.

| Required behavior | Local candidate result | Daytona candidate result |
| --- | --- | --- |
| Ordinary installation and completion | Public setup/closure verified; final full verifier and normal product smoke pending | Pending |
| File editing, validation, accessible artifacts | Earlier `9ba53f` preflight passed; assembled-candidate repeat pending | Pending |
| Semantic question with controller restart | Passed `structured-question-restart-resume-01` on `ccae835` | Pending |
| Semantic plan acceptance | Passed `plan-approve-complete-01` on `ccae835` | Pending |
| Native reject, revise, accept | Passed `native-plan-reject-revise-accept-01` on `ccae835` | Pending |
| Native plan cancellation | First attempt failed during fixture migration/startup before Cursor ran; affected repeat pending | Pending |
| Denied write and pending-permission Stop | Pending | Pending |
| Three warm turns | Pending | Pending |
| Owned provider loss with pending permission | Passed `pending-permission-provider-loss-03` with clean retirement, stale-answer refusal, blocked open task, failed run, and no mutation | Pending |

All attempts are serial and have zero automatic retries. The original campaign
envelope has $52.919619376 remaining after its prior committed upper bound.
The existing $25 Cursor account-cycle cap is counted once; per-run USD is null.
Remote runtime estimates and reservations remain separate from missing model spend.

The seven authored Runner cases remain byte-identical to eval revision
`08ae9d4a231e52fc54af0821564cded3d3ec7f37`. A fingerprinted diagnostic
overlay binds the v11 profile and adds a closed projection of durable delivery
receipts for failure diagnosis. The strict accounting grader remains unchanged.
Successful semantic checks do not make an accounting-failure score green.

The canonical-temporary-path full local test rerun accumulated startup, filesystem,
and timing failures under host contention. It was interrupted before completion;
the partial log is retained. Earlier recursive typecheck, build, contracts/replay,
token gates, and focused runtime checks passed. Full CI and the complete acceptance
matrix are required before promotion. Cursor production admission remains disabled.

## Review blockers and mainline integration

The branch now preserves mainline `2a8a99e4a`, including stock-harness cleanup
checks and the updated skill semantic contract. Earlier candidate results retain
their original source identities; this rebase requires fresh artifact identities
and affected qualification.

Two production blockers found by review were repaired. Unsupported Cursor targets
omit the provider field rather than hashing an undefined field that disappears
when the manifest is written. Disk JSON round-trip digest checks cover all three
supported targets, Linux ARM64, and Windows x64.

Accepted-plan proof reads now budget 1,000 control events and 20,000 tool-progress
events separately, retaining every event hash and the terminal event. A single
bounded read includes an overflow row and fails closed beyond either budget.
Historical unbound committed proofs retain their original event selection and
1,000-row limit. Long-plan tests also reject foreign tools, changed sessions,
tampered digests, and progress after completion; no later work is hidden by
removing progress from the proof.

The first new denied-write attempt retained a native permission for a different
command: Cursor escaped the literal's underscores. The original target stayed
absent and the observed process tree retired, but the exact command/denial gate
correctly failed. The fixture now uses a hyphenated literal while retaining exact
command digest, tool, request, run, and turn checks. This changes the fixture
identity and does not qualify the failed attempt retroactively.

CI found an imported editable-default question test without its corresponding
contract. Editable defaults are outside this Cursor release and their partial
import was removed instead of extending all question surfaces. Cursor question
handling and plans remain intact. Configuration rejects unavailable Pi/Copilot selections explicitly, preserving
the selected provider and model rather than substituting Claude. Cursor retains
its explicit model and mode selection.

At source `ae24f0981221dc0b5694120f9bb46ff6c8859e07`, all CI build,
typecheck, Rust, unit, and browser jobs passed. Automated review found a remaining
provider fallback and a build-timeout test reading an excluded Pi file. Both are
repaired with focused coverage; no Pi implementation was added.

The `cursor-v11-ae24f0-local-native-write-deny-reconnect-01` attempt delivered
the exact Reject once, observed no target mutation, and retired the owned process
tree. Its original result remains failed: the fixture incorrectly required a
failed native tool and a subsequent Stop. Cursor reported transport completion
and ended the turn; Paperclip correctly failed missing semantic finalization and
kept the task unfinished. The repaired oracle preserves exact request/tool/turn/
command identity, delivered rejection, all six independent samples, a complete
continuous watcher, and actual process retirement. It additionally requires the
correlated terminal and the failed semantic finalization. It does not certify
operator cancellation; pending-permission Stop remains a separate required gate.
The affected live denial repeat passed on the frozen candidate below.

### Frozen v11 checkpoint: `5623ff9505a8284301dd5cbd20e07f3c0596355f`

All ten required local Product E2E cells passed with cleanup, including exact
write denial, pending-permission Stop, warm three-turn continuation, questions
after controller restart, native plan revision/acceptance/cancellation, and owned
provider loss. The denial's first attempt failed during PostgreSQL bootstrap;
its second attempt passed. Other local cells passed on their first attempt.

All seven authored Runner semantic cases passed with independent owned-process
retirement. Strict accounting failed all seven cases with
`provider_budget_coverage_unknown`; per-run USD remains unavailable. Definitions
retain provenance to eval revision `08ae9d4a231e52fc54af0821564cded3d3ec7f37`.
Latest-head CI completed with 53 successful and four skipped checks. Greptile
reported 5/5. An unchanged chat timing failure was diagnosed and rerun once.

The actual Linux image is
`ghcr.io/paperclipai/paperclip-daytona-runner@sha256:b5d4a95d7b4c2291a3a133afdf475846569e16588e4ae9f4bb6fde326756946c`.
Its entire extracted provider pack was verified, and anonymous registry access
was confirmed. All three platform packs bind source `5623ff` and Cursor v11.

The first Daytona attempt failed before remote allocation during local database
bootstrap. The second timed out in sandbox allocation before Cursor started;
its original cleanup failure remains recorded. Subsequent ownership-filtered
inspection found no sandbox for that run. A bounded infrastructure-only probe
started this exact image in under one second and confirmed deletion of its
verified allocation. That establishes current allocation health, without
retroactively qualifying the failed attempt or establishing its cleanup receipt.

The harness now retains its owner-only private recovery database when process
or remote cleanup is unconfirmed. This repairs the demonstrated loss of the
failed-create journal after the controller exited. It changes the harness only;
the provider packs, daemon, and Linux image remain frozen at `5623ff`. Remote
qualification and promotion are still pending.

### Demonstrated remote blockers after allocation recovered

The third remote denial attempt reached the native request and delivered the
exact rejection. The target stayed absent and the remote process observer proved
retirement. Its overall result remains failed: Cursor announced an empty read
card before streaming the bootstrap file path, and the strict single-file proof
could not attest that origin. The controller then applied generic missing-result
recovery after the denied turn ended, making two failed session-resume attempts.

The blocker repair completes only an entirely empty pending read origin from a
full single-path shape update before execution progress. Every attested notice
retains that same digest; late, changed, multi-path, and unsafe input stays
unproven. This changes passive evidence, not provider permissions or file access.
Committed Cursor permission declines followed by a completed turn without a
semantic result now fail the run once, block the unfinished task, and assign recovery to
the operator with no automatic wake. Other missing-result recovery remains intact.
The decision proof binds company, agent, run, turn, normalized session, source,
request, and strict event order. It does not assert response delivery or absence
of effects; those remain separate live requirements.

Focused verification passed: 534 controller tests, 43 Cursor runtime tests, and
43 fixture evidence tests, plus affected typechecks. The provider CLI pin,
native patch, and command/profile digest remain unchanged; the candidate source
and Node pack identities must be rebuilt before repeating affected qualification.

The first local repeat at `c45cf9` confirmed the named permission-declined failure
without another provider attempt. It remains failed because the fixture expected
In Progress while canonical failure recovery projected Blocked. The release
contract now requires Blocked for the new explicit permission-declined failure;
historical generic missing-result evidence retains its prior status contract.
Exact delivery, a single terminal, absent effects and process retirement remain
mandatory. A reproduced Stop-precedence race is also repaired: acknowledged
operator and reassignment cancellation wins over the new typed decline error.
The frozen v11 runtime packs and image remain at `c45cf9`; these follow-up changes
touch the controller and harness only, and their distinct source identity is
recorded with subsequent results.

Review found three recovery gaps. Permission-decline lookup now scopes the query to the exact turn, session and runner before applying its event budget, so earlier turns cannot hide a committed denial. Cleanup retention reads raw results before packaging and records resource admission before any test provisioning; an unpublished result or worker crash can no longer discard uncertain allocation state. Confirmed pre-allocation bootstrap failures retain their original classification without an invented cleanup failure.

The second local denial repeat passed its behavioral and cleanup assertions but failed a browser assertion because the Blocked status label includes the current blocker count. The assertion now checks the actual Blocked status while allowing that displayed count. This failed attempt retains its original result; the affected repeat remains required.

Review-fix verification passed: 538 controller tests and 38 fixture tests, server and fixture typechecks, and production verification of the actual Linux pack. The first controller test invocation hit sandbox denial for its default checkpoint directory; the isolated-home repeat passed. The immutable c45cf9 qualification image is `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:1344d8168f15b8c1102ffbf60bf518f278b1804c9672135fb7f10642499e70ec`. All three actual platform packs now bind runtime source c45cf9.

Both affected local repeats passed on runtime c45cf9 with controller/harness df1c65. The first new Daytona denied-write case also passed, including a completed read attestation, exact delivered denial, no automatic resume, continuous absent effects, owned retirement and confirmed sandbox deletion.

Remote Stop reached the exact pending-callback cancellation and stale-answer refusal, with a complete remote no-effect watcher and an empty final process journal. Its overall result remains failed: the flow also applied a local API-PID identity check to remote execution, where the controller-command PID legitimately becomes the sandbox runner PID. The repaired flow uses local PID tracking only for local execution. Remote proof still requires the same company/run/lease/sandbox, root boot/start-tick identity, retained descendant journal and continuous watcher. No remote retirement requirement is removed. The failed case and private recovery journal remain retained; only Stop is repeated before continuing the remaining cells.

The affected remote Stop repeat passed. Remote warm three-turn continuation and normal completion also passed with cleanup. The first remote file case verified exact bytes, successful validation, an accessible registered deliverable and final task/run success. Its overall result remains failed because the automatically generated artifact-preparation comment used the provider-selected file title, which duplicated the completion marker. The fixture now requests the actual filename as its deliverable title and reserves the marker for completion. Exact byte, validation, accessible-output and single-completion checks remain intact; only the file case is repeated before continuing.

A provider-free normal-install probe also exposed a packaging blocker: the earlier npm consumer had a macOS ARM64 daemon in the universal server package and could not launch it on Linux (exec-format exit 126). Explicit Cursor provisioning itself passed, but that does not certify the installed product. Release packaging must include verified platform-specific daemons for all three promised targets and select the correct bundled daemon without an override. This release fix and the final installed product smoke remain required.

The remote file repeat and semantic question/restart case passed with cleanup. The
next semantic-plan approval case remains failed. The controller admitted its
completion report, but returning feedback to the provider's pending semantic
tool call was rejected. Shutdown did not prove a settled provider checkpoint;
the identity fence correctly prevented recovery. The failure is retained and is
not counted as a successful planning continuation.

Evaluation also found that the shared app-server checkpoint parser discarded
Cursor's observed mode. It now preserves Agent/Plan/Ask, with round-trip and
mismatched-mode recovery tests. Missing historical mode bindings remain fenced.
Retired provider tool callbacks have a closed diagnostic category; private
provider text is never copied into error identity. Remote checkpoint failures
now distinguish unconfirmed exit, unsettled turns and mode binding through
closed categories without weakening admission.

Public release packaging now selects the daemon beside its own compiled module,
including the server's vendored layout, and verifies its actual executable
architecture. Release assembly requires one source revision and all three
independently built daemons. Run
`pnpm --filter @paperclipai/paperclip-runner stage:release-binaries /path/to/manifest.json`
with a JSON manifest containing `sourceRevision` and `platforms`, whose exact
keys are `darwin-arm64`, `darwin-x64`, and `linux-x64`; each entry contains an
absolute artifact `path` and `sha256:<64 hex digits>` digest. Assembly verifies
all inputs before staging and records source and packaged hashes in
`dist/bin/release-manifest.json`. Rebuild the server after assembly so its
vendored distribution contains the entire verified platform set. The ordinary
public-install verifier requires this manifest at an ancestor of the current source, requires unchanged Runner source since
that frozen runtime, and checks all three packaged identities before launching the normally resolved Linux
daemon. The actual installed task smoke remains a separate required gate.

Focused repair verification: 42 checkpoint/binary-selection tests, nine durable
provider-state tests, 43 sidecar tests, and three closed Rust diagnostic tests
passed. The first sidecar invocation timed out in the sandbox; the unrestricted
local IPC repeat passed. Runtime source changed, so the next affected live
attempt requires refreshed platform packs and Linux image identities. Existing
results retain their original runtime/controller identities.


The rebuilt d0b907 runtime passed all ten local Product E2E workflows with confirmed cleanup. Controller/harness source for those results is 5e6c16. Its seven Runner cases also passed every semantic check with owned processes retired; all seven strict accounting results remain failures (`provider_budget_coverage_unknown`, per-run USD unknown). The exact attempt identities are `cursor-v11-d0b907-local-<case>-01` and `cursor-v11-d0b907-<runner-case>-01`. No automatic retries were used.

Review then repaired the installed server's independent daemon lookup to use the Runner's verified platform selector. The public npm probe now verifies both selectors agree. Harness diagnostic retention follows the final verdict and preserves incomplete publication; remote-admission uncertainty is marked only for Daytona. The file gate now additionally downloads the registered run-attributed artifact and verifies its exact bytes and stored hash. The earlier local file result retains its original oracle and identity; an affected repeat is required for the new download proof. These repairs do not change the frozen Runner source.

The d0b907 Linux qualification image built successfully and its extracted provider pack passed manifest and command verification. Publishing `ghcr.io/paperclipai/paperclip-daytona-runner:cursor-qualification-d0b90756e3ab` was rejected by automatic approval review because explicit authorization for that payload and registry destination is required. The image remains local at `sha256:16c7be3610f45e409f67873dd4bd829f9a1e0e5f017c8826d01db4bb05720f97`; an approval request is pending. The fresh Daytona matrix has not started. Production admission remains disabled.

The current public npm proof is `/tmp/cursor-public-npm-install-473206.log`; its provider-free report remains at the task-owned consumer root printed there. The file-download repeat is `cursor-v11-d0b907-local-file-edit-validate-02`, with status and cleanup passed. The seven Runner proof summary is `/tmp/cursor-production-20261003/runner-results/semantic-summary-d0b907.json`. Private provider traces and databases are not published.

At 473206, the explicit Runner protocol, Rust, conformance and replay stages passed. The final authority stage passed 1,851 of 1,852 checks; its single failing test could not start embedded PostgreSQL after five attempts and did not reach its stale-question assertion. That attempt is retained at `/tmp/cursor-runner-contract-replay-473206.log`. Repeat only the affected `runner-api.integration.test.ts` stale source-run question case after the full test run releases its databases.

The default full local command stopped after its general-server group: 15,207 tests passed, four failed and 88 were skipped, with one additional suite setup failure. The failures were two embedded PostgreSQL startup errors, socket resets and a 500-request Git-scan join count of 497 instead of 498. All five affected files then passed in isolation (123 tests), including the authority-stage stale-question case. Original failures remain retained. The workspace and serialized groups skipped by the stopped command are being run separately; no passing general-server coverage is repeated. No unrelated source or test repair was made.


## Final local verification at code source 473206

All required default Vitest groups were exercised. The original default command
failed in its first group and remains failed in the record. Passing coverage was
completed through its remaining groups and isolated repeats, without rerunning
the already passing general-server cases:

- General-server: 15,207 passed in the original run; all five affected files passed
  in the diagnosed isolated repeat (123 tests). This includes the authority-stage
  stale-question assertion that previously failed during database setup.
- UI: 7,282 passed. CLI: 504 passed initially; the one worktree-seed PostgreSQL
  startup failure passed in isolation.
- Shared and skills-catalog groups passed. Database: 116 passed initially; both
  migration startup failures passed serially with other database groups idle.
- All nine remaining default adapter/plugin projects passed with two workers.
- All 150 serialized route/auth files were exercised. The earlier built-in-agent
  socket-reset case passed during resumption. Two later cross-company socket/
  timeout failures passed in the final isolated repeat. Their original failed
  records remain retained.
- Runner protocol, Rust, conformance and replay checks passed. The authority
  stage's one database-startup failure was covered by the passing isolated
  stale-question test; its other 1,851 checks passed in the original stage.

No unrelated source or test repair was made. Targeted final logs are
`/tmp/cursor-targeted-failures-473206.log`,
`/tmp/cursor-cli-seed-repeat-473206.log`,
`/tmp/cursor-db-migration-repeat-473206.log`, and
`/tmp/cursor-route-repeat-473206.log`. The exact resumed coverage is recorded in
`/tmp/cursor-production-20261003/workspaces-b-remaining-summary-473206.json` and
`/tmp/cursor-production-20261003/serialized-remainder-summary-473206.json`.

The remaining critical path is unchanged: approve the exact qualification-image
registry publication; qualify the frozen candidate on Daytona; apply Cursor-only
production admission; assemble and verify the final package/image combination;
run the real installed task smoke without qualification overrides; then prepare
the PR for production review. Native AskQuestion and complete per-run dollar
accounting remain excluded. Production merge/deployment remains a separate action.
