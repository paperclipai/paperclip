# Pi production readiness — 2026-10-02

The release target is Pi 1.0.0 through the native Runner. Readiness is a finite
set of release gates. Pi remains a candidate until every required gate passes.
Keep behavioral qualification on the accepted fixtures. Do not expand it to
widgets, images, Cursor or Copilot qualification. The existing draft stack must be reviewed in dependency order.

## Current delivery scope — 2026-10-08

**The two requested core paths pass.** The user narrowed delivery to normal task
completion and human controls. Accounting and the broad release matrix remain
deferred. No provider/platform expansion or local Docker is part of this work.

All seven fresh cloud cases pass canonically on shipping source
`10dc43c9ec65d88c2f782d62afb296d09494f215`, committed harness
`1a4408a48cfb5a1f094a311141c257c92cd7a893` and immutable image
`ghcr.io/paperclipai/paperclip-daytona-runner@sha256:5b3a775b383591bda1b0c1889e509acc70ce7f37c53f09733c81d59037f02280`. The accepted fixture uses
`openrouter/anthropic/claude-sonnet-4.6` with native low thinking. Production
accepts the caller's explicit native model; no allowlist, hardcoded default or
fallback is added. Pi profile 19 has command digest
`sha256:b7647ebf97f802ca053ec3384c912bf0e8d18eba308d27397bb1d95a37220825`.

An initial master integration checkpoint used Pi profile 20 (`sha256:465ae72460f05cae961873f09cd7cd3652dc3a6949930b7ee16303925cd3dd0e`). It bound the Codex-only sandbox change. This checkpoint is retained as history and is superseded by profile 21 before merge.

The dependency correction checkpoint uses Pi profile 21 (`sha256:514cbf86e70c1eaedebdf924bc0f3de4753c7a9e0313a0bb38614b6b9481a9a1`). It restores master's explicit task-environment projection and patches the bundled `brace-expansion` dependency from 5.0.9 to the official 5.0.12 payload. Pi 1.0.0, pi-acp 0.0.33, Node 24.21.0, wrapper, helper, extension, native question/control delivery, model selection and recovery identity remain unchanged. The original three closure hashes were reproduced before calculating the patched ones. The dependency patch is hash-pinned, is included in installed setup tooling, and is checked against the complete locked package graph. The seven live results retain their original profile-19 source and are not relabeled as fresh profile-21 runs. Profile-21 integration and the narrow security correction require current-head tests, package materialization and CI before merge. Cursor keeps its existing qualified status. Copilot stays pending; its new profile-17 attestation only binds master's updated shared protocol validation sources.

The assembled merge uses **Pi profile 22** (`sha256:e92078bee3c23bec4100aa589013a44613d054cd686826534025d8019e9f39a9`). Profile 21 remains a historical declaration. Version 22 changes only the version and credential-policy source hashes: general AWS IAM keys are excluded from both static and custom provider credentials, selected task-environment projections, and the Pi sidecar launch. `AWS_BEARER_TOKEN_BEDROCK` remains supported. The dependency closures, model selection, wrapper, helper, extension and question/control behavior are unchanged from profile 21. Rust admission uses the current declaration and rejects previous profiles. Current-head tests and CI must pass before merge; the profile-19 paid proof is not relabeled.

| Core path | Canonical campaign | Retained evidence |
| --- | --- | --- |
| Four typed questions, browser reconnects and exact saved answers | `pi-core19-0-1791477277` | 42 files; SHA256 `5c0c5fdfeca97b689a0f299935fd5cb62d65c38a056b8ff4f2dfc888cd795b24` |
| Pending question survives controller restart on the same native run | `pi-core19-1-1791477493` | 33 files; SHA256 `85b5db8c528c339b611ecf1fc2173135aa6403184e6c47a52978cc3f69c00f86` |
| File edit, one validation command, registered download, Done and copy-back | `pi-core19-2-1791477756` | 23 files; SHA256 `95731673cdba4b8373085a743d5570cae645059d5339f20337a4df55c97bba80` |
| Three follow-up turns preserve native session/process/workspace | `pi-core19-3-1791477969` | 23 files; SHA256 `9b43a3edd76b4ea71e1611c5f623da6f88ec13184a89411983a582e66168568a` |
| Browser plan approval resumes work and completion | `pi-core19-4-1791478363` | 22 files; SHA256 `a3b197d7c9b15ee962865c1c04588a51d29e96f64561d3e2ff36f9b8888ef3c3` |
| Same-turn browser steering and permission denial without effect or replay | `pi-core19-5-1791478652` | 39 files; SHA256 `763bcf72a1be3b78d911376c2ed01ed433ecf7d3043379c0f6717afeecaf1317` |
| Stop during pending permission cancels and retires the owned runtime | `pi-core19-6-1791478869` | 33 files; SHA256 `4b2b7c91e29ce8245750fbac37fe69495bbc8f99021b92f6e74619953f697d95` |

All 215 canonical files (28,868,813 bytes) are independently
hash-verified. Every canonical cleanup check passes. Independent inspection
finds no owned runtime process or temporary root after each case. Automatic
retries are zero. The owned cloud host stops normally after retention. No live
result from an older shipping runtime is reused.

Native definition 23 has SHA256
`90f2e901d7f39bfb6bbadcf63bc78e410a3b071af980f3a23979747e3d5f2021`;
controls definition 10 has SHA256
`00639f572e16e25e9945124d91d55a7c98aa9d36c1aa6493842ea7605ff7fcb8`.
File/plan definition 5 retains SHA256
`5de4fac78d4d581bc0954f07b5cf2df2862d37f8b0205325eede6d9ef6d9f5e6`;
warm definition 2 retains SHA256
`331b88d9538a132670789fb7864df7df5f4bf294ae19b62f53d8a02f901774f0`.

Hosted Linux build/public-install job `37802923302` passes. Its 20 retained
normal archives match their source-bound hashes. A fresh cloud consumer passes
normal installation and lifecycle, profile-19 setup, full package/managed-asset
checks, normal companion import, the actual production pack reader, and
installed CLI health/UI startup. The matching build includes normal plugin
prepack and the separate private eval SDK. All 54 applicable CI checks pass on
harness head `1a4408a48`, with two expected skips and clear current-head review.
Focused checks pass: 345 cloud core/observer controls, 47 extension/installation
checks with one expected platform skip, 50 recovery decoder checks, 22 local
native backend tests, generated profile drift and whitespace checks. Repository
typecheck, tests and build use the normal CI dependency graph; the isolated
public consumer lacks source-only development declarations.

The production correction exposes native question field types at the schema
root and preserves every method-specific constraint and runtime validator.
Empty arguments, stringified options and cross-method fields remain invalid.
All three previous closure hashes are reproduced from the retained full
manifest and reviewed Node pins; only `extensions/paperclip.js` changes.
Historical Pi profile-18 decoding retains its exact stored identity; current
launch admission still rejects it. Later changes are tests, harness and docs.
Shipping packages and image stay frozen at the source above.

### Preserved failed attempts

- `pi-core-0-1791470050` keeps its definition-4 candidate failure. The task editor
  escaped an unfenced validation command, causing one failed Bash invocation
  before a corrected invocation. Definition 5 fences the unchanged exact
  command; the one-command grader stays unchanged. All 41 canonical files
  (91,468,056 bytes) are retained with SHA256
  `065146a206da9f29b50999b5d931b54402edd5d30a516895a7ab8fb95e8a6029`.
- `pi-core-2-1791471416` keeps its profile-18 failure and original
  `transient_infrastructure` classification. Empty question arguments and two
  stringified option arrays are rejected before the 120-second native timeout.
  All 45 files (177,803,509 bytes) are retained with SHA256
  `66c801596d81b909ac2ad8004d885ddf69b7478d9ab9a0cce11a52ebfe8a6e28`.
- `pi-core19-0-1791475984` keeps its definition-22 `cleanup_failure`. All four
  real browser questions are answered and the one native run succeeds with the
  task Done, but independent terminal evidence records `process_sample_failed`.
  All 60 files (116,725,310 bytes) are retained with SHA256
  `a44d87624b57e995d19617886f27ad742f8afb29aff7578774f6a84d6048cc8f`.
  The original observer lacks a narrower cause. Linux proc-exit read races are
  an inferred cause. Definition 23 separately confirms proc-entry absence
  after an unexpected read failure. Existing unreadable processes, identity
  drift and all incomplete evidence still fail. Closed causes distinguish
  reads, stat shape, runtime binding and terminal sealing. The full private
  recovery state is retained with SHA256
  `90ae92b0ee5107145342bcbace6d6df7b17d629ea1c52eafb1220363d9376e49`;
  only its backed-up disposable scratch root is removed after verifying no
  owned process and the exact original sandbox's absence. No original grade
  changes or partial results qualify a complete path.

Cloud builds `37799803269` and `37800625049` are superseded before any model
call. The normal install probe needed profile-19 synchronization, then stored
profile-18 decoding needed preservation. Their handles and reasons remain
retained. The frozen build above includes both corrections.

### Historical profile-18 core passes

These earlier passes remain bound to runtime `b696e131ae32a82418e570b32f4727b5adb14e49`,
harness `ee3b094d35719e4dd7cbc791d1924205c4fa474f` and immutable image
`sha256:ce622e03c606cb93eedda824133b791449f7be752d85e220a2e316f825f37226`.
Their canonical results and independent cleanup pass; their host stops normally.
They do not substitute for the seven fresh profile-19 results above.

The earlier profile-20 merge checkpoint is retained above as history; current merge verification uses profile 22.

| Core path | Canonical campaign | Retained evidence |
| --- | --- | --- |
| File edit, one exact successful command, authenticated public download, registered deliverable, finish, Done and finalized copy-back | `pi-core-0-1791470879` | 23 files; archive SHA256 `9a1c41e2ccad75f89a069ff571a3aa9f8cb94ae80c1bd397f7c886338b9a09bd`; definition 5 |
| Three browser follow-up turns retain native session/process/workspace identity and append the earlier work | `pi-core-1-1791471072` | 23 files; archive SHA256 `d10310a2720a0d6c0636ce389fc6cc5faa887cc5c95bd697cdf0172619973609`; definition 2 |
| Human plan approval resumes work and completion through the public product | `pi-core-3-1791472300` | 22 files; archive SHA256 `8c069ff176cb94166429901957f80e8b22c36ddf0f2047193889c4b7059aedf3`; definition 5 |
| Same-turn browser steering and human denial stay on the original run | `pi-core-4-1791472621` | 39 files; archive SHA256 `ce1f35ceaa66e2edaed070a26d25fcb24251be72726fb4372d057ab36425e1c3`; controls definition 9 |
| Stop during pending native permission cancels work and retires the owned runtime | `pi-core-5-1791472865` | 33 files; archive SHA256 `771f132bdc192d08a106b2b35322ade1c8baafc837949770d76ea60e571770a5`; controls definition 9 |

## Correct cloud memory-read authority — 2026-10-08

Frozen runtime/image `b696e131ae32a82418e570b32f4727b5adb14e49` passes all
54 applicable PR checks and cloud image/public-install job `37777555436`.
The job retains the exact 20 normal archives and their source-bound hash
manifest. Its immutable image is
`ghcr.io/paperclipai/paperclip-daytona-runner@sha256:ce622e03c606cb93eedda824133b791449f7be752d85e220a2e316f825f37226`.
A fresh cloud consumer passes normal install and lifecycle, complete package
archive and managed-Pi verification, normal companion import, the actual
installed production pack reader, and installed CLI health/UI startup. The
reader repair therefore reaches a real paid native Pi turn on Sonnet 4.6.

Definition-21 campaign `pi-sonnet-memory-b696-daytona-1791464677` retains its
canonical candidate failure at `native-memory-write-verification`. Pi actually
writes the requested 33 bytes, performs one complete native read with the exact
nonce plus LF, receives the expected cross-root denial, saves the exact bytes
through the public managed-file API, and retires cleanly. The grader wrongly
requires a null projected target for cloud agent files. The remote projection
correctly names `.paperclip-runtime/agent-files/<agent-id>/<run-id>/memory/pi-native.txt`;
local private-root reads remain withheld. This is a grader-authority mismatch,
not evidence of wrong file content. Restart and the fresh task were not reached.

All 45 canonical files, 93,697,980 bytes, are retained and independently
verified. Archive SHA256 is
`59a746148b786e16442200fe4a525e189d168849a3fde5bc3c480c5a7421dcd5`.
Cleanup passes with no owned runtime processes or temporary roots. The
historical canonical grade is unchanged.

Definition 22 requires the exact cloud target derived from the independently
known fixture agent and current run IDs. It keeps the completed, untruncated,
read-only native receipt, exact text/LF, duplicate-read rejection and no-shell
checks. Null or wrong agent/run targets cannot qualify a cloud read. Native
local behavior still requires the withheld target. Add controls for another
agent, a prior run, another file, truncated/wrong contents, and shell execution.
Only harness tests and this plan change. The production tree and normal
package/image bytes remain frozen at `b696e131ae32a82418e570b32f4727b5adb14e49`.
Committed harness `da8d4454ae165b557ff11730e9fe018c9b1cd9b9` passes free
calibration against the retained actual cloud read and public file bytes. Wrong
agent, wrong run and wrong content controls fail. Calibration does not regrade
the original failed campaign.

Fresh definition-22 campaign `pi-sonnet-memory-native22-daytona-1791465718`
passes canonically on Sonnet 4.6 in 197,083 ms. Both native read receipts, exact
33-byte saved memory, public file-save receipt, controller restart, an independent
fresh task with an undisclosed nonce, remote readback, unchanged parent seed,
cross-root denial and both independent retirements pass. Automatic retries are
zero. No local Docker, BYOK or fallback model is used. This qualifies the cloud
memory cell for these exact runtime, image, harness and definition bytes.

All 31 canonical files, 4,556,238 bytes, are retained and independently verified
file by file. Archive SHA256 is
`1718750f0484b47a5181f8cee988e91c2e889b5135ccb29282c5220b964017b5`.
No owned runtime process or temporary root remains. The owned qualification
host is stopped normally after retention. The dedicated key retains its $5
lifetime cap within the approved $100 cumulative token ceiling; credit snapshots
remain provisional and do not prove zero cost. The remaining 25 Product cells
and seven Runner cells still need current-freeze qualification. Strict Runner
cost accounting remains unresolved. Pi is not production-qualified.

All 173 focused cloud unit tests pass, including local and remote memory,
wrong-path/byte controls, incomplete terminal evidence and cleanup retention.
Definition-22 SHA256 is
`44167a91fac42d4af03187c4cd94412923502c7c26125ae06a0bf67120396195`.
The cloud source typecheck cannot pass with the production-only dependency
graph: source-only server dev types, chat and the private Runner source link
are absent. Its errors do not name the changed memory files. Use the normal
PR CI dependency graph for repository typecheck and build.

## Retain cloud-built packages for the changed reader — 2026-10-08

Reader fix `111082ad429c3d21ba74e9241d1375da6e82a7cd` passes all 54
applicable PR checks, with two intentional skips and no unresolved review
threads. Cloud build `37774605672` also passes its normal source build,
18-package clean npm installation, lifecycle isolation and Pi profile-18
admission. Its immutable image is
`ghcr.io/paperclipai/paperclip-daytona-runner@sha256:098bd31be64612dd15490f2507ae0cdc08875cc6e35ce6fe5e2ef87fce7d0d69`.
These are credential-free checks; they do not qualify the live cloud memory
case or the remaining Product and Runner cases.

The public installation verifier previously deleted its normal archive set
with its temporary consumer. The existing hosted Linux image job now opts in
to retaining those exact public archives, plus the normally prepacked Daytona
plugin and separately built private Runner eval SDK. The manifest binds all
archive hashes to the actual server build stamp and git revision. Existing
retained output cannot be replaced. Temporary package stages and caches are
removed; source manifests stay unchanged. Nine focused Node tests pass,
including actual plugin prepack and source/destination identity controls.

Run the image job once on the new head to retain one matching image and
20-package set. Install that set normally on an owned cloud host, freeze its
full installed graphs, import the matching image companion through the public
CLI, and call the actual installed provider-pack reader before any paid turn.
Then run one cloud memory case with Sonnet 4.6 and zero automatic retries.
No local Docker is used. The earlier canonical failures and passes stay bound
to their original source and definition versions.

## Sonnet memory verification and cloud reader repair — 2026-10-08

The user approved `openrouter/anthropic/claude-sonnet-4.6` as the explicit
qualification model. Production still accepts caller-selected native models and
custom providers. Native low thinking, case deadlines, permissions and cleanup
requirements remain unchanged.

The content-bound definition-21 local memory case passes on harness
`3017852e9472130d1f14ec42d50b589556512083` and installed shipping source
`06a3d9739f402baa7f8be7aaa29dda6db7354bfb`. Its two native reads contain the exact
33-byte nonce and final LF. Public file bytes, controller restart, fresh-task
persistence, denied cross-root write and independent cleanup pass. Its canonical
23-file evidence set contains 4,156,756 bytes and is retained with archive SHA256
`2763bda9dd460aecce56af1a6030d8810c3b02c1701520f4ac3a16299a5f55cd`.
All 172 focused checks and all 54 applicable CI gates on that harness pass, with
two expected skips and zero unresolved review threads.

The cloud memory case fails before a provider turn with
`runner_remote_provider_artifact_incompatible: invalid candidate identity`.
Its original grade and 43-file, 70,371,196-byte evidence set remain retained;
cleanup passes. The image builder publishes Pi in both qualified `providers`
and `candidateProviders`, but the server reader only permits Cursor in
`providers`. The reader now admits qualified Pi there using its existing exact
field, qualification, path, digest and asset-tree checks. Regression coverage
uses the normal builder shape through both complete and metadata-only readers.

Free calibration reproduces the rejection against the actual immutable image
and accepts its complete asset tree with the corrected source reader. Four
malformed Pi declarations still fail. This is source-fragment calibration, not a
fresh packaged runtime or live cloud qualification pass. The server unit run on
the restored qualification host could not load its missing `supertest` dev
dependency; full server tests, typecheck and build must run in CI. A fresh normal
Linux package set and image must include this production reader correction.
The prior source, installation and image receipts retain their exact identities.

Cloud preparation also restored the test SDK dependency, ran the original
Daytona plugin prepack hook and used normal `runtime import-remote` installation.
All 60 compiled plugin files remain unchanged. The original 80,151 runtime files,
16,441 plugin files and separately declared 24,992-entry companion inventory
pass verification. The cloud account limits each host to 10 GB. Owned
copy-on-write staging and disposable npm cache cleanup let normal verified
import complete with 3.9 GB free. Failed imports and original package metadata
remain retained. No local Docker, production environment override, fallback
model, BYOK or automatic retry is used.

Runner qualification remains 0/7: its first Sonnet case passes semantic checks
but fails strict cost coverage because the evaluation SDK lacks priced Sonnet
accounting. Unknown provider spend remains unknown. Do not insert a price row
without validating fresh input, cache-read and cache-write counter semantics.

## Historical repairs before the current shipping freeze — 2026-10-07

Pi 1.0.0 uses immutable profile 18. Production models remain caller-selected;
the accepted OpenRouter model and low thinking are fixture inputs. The new
Runner snapshot-retirement repair requires fresh normal Linux packages, a cloud
image and all 33 accepted live cases. Provider wrapper, closure, profile and
model-selection declarations are unchanged by this host-lifecycle repair.
Current-source normal Linux, native ARM Mac and native Intel Mac admission pass.
Historical Mac evidence does not qualify the current shipping source.
The following repair stages are historical;
the release-gate table below and exact shutdown-source section record current
admission. Do not repeat completed builds or count passes on older artifacts.

Source `6a393093411caa9c5f6f543340e63805311678e8` completed normal native Linux
workspace/public builds, normal public npm installation and lifecycle hooks,
full installed-graph verification, Pi setup, Chromium and real server/UI admission.
All 20 qualification archives and integrity receipts are retained. The free
public-install probe initially rejected the stale profile-17 pin; verifier-only
commit `9cd363d28d1560dcfeffb408be876b49869c486c` corrected it and admitted the
same installed bytes. The original rejection remains retained.

That installed source passed Stop, same-turn steering and native questions with
canonical results and independent process cleanup. The persisted-agent-file case
then failed because the owned cloud host ran out of disk while writing durable
Runner state. Its original canonical failure and trace are retained; the fixture
reports cleanup passed. Inspection found native distribution snapshot directories
left after completed provider runs, including partial copies. Command retirement
returned immediately once its launch was consumed, leaving asynchronous snapshot
deletion unfinished when the Runner exited.

Command retirement now waits for exact-child exit and complete snapshot deletion.
A surviving child produces a bounded failure after 10 seconds while its bytes
remain retained; it cannot hold the complete cleanup outcome indefinitely.
Deletion failures remain visible and owned for a bounded cleanup retry. It never
removes a live child's native bytes. A delayed-deletion regression fails on the
old code and passes with the correction; live-child and cleanup-failure regressions
also pass. No paid cases resume before rebuilding and admitting this repair.
The three passes on the previous Runner source do not qualify changed host bytes.

Source `b061f31242a29374910b5c02b595e90d21e7fae9` then passed normal Linux
workspace/public builds, all installation hooks, graph audits, Pi setup and real
server/UI startup. All 20 archives are hash-verified and retained. Its hosted image
build, anonymous OCI admission and actual credential-free Daytona guest probe
passed; probe deletion was confirmed. Current-head CI passed 54 applicable checks,
with two expected skips and zero new Greptile comments or open review threads.

The first Stop run on that source passed its unchanged canonical Product grader,
including process cleanup. Independent inspection nevertheless found two native
snapshot directories: one complete 547 MB distribution and one partial 20 MB
copy. The original canonical pass, failed independent cleanup observation, trace,
manifest and every remaining file hash are retained. Paid cases halted; this run
does not qualify the release. Only those two exact, quiescent owned directories
were reclaimed after rechecking their retained identities and bytes.

Free regressions reproduce both remaining boundaries: native acquisition ignored
cancellation, and the Rust process-group supervisor killed Pi cleanup after only
two seconds. The new repair propagates a command-owner cancellation signal into
Pi snapshot acquisition, stops admitting copies on cancellation and drains all
admitted reads before deleting the partial tree. Pi gets a finite 30-second
sidecar shutdown grace; process-group KILL and inherited lifetime-fence proofs
remain authoritative. Normal cleanup still waits for exact-child exit.
The repair passes 271 focused TypeScript tests, one existing skip, all 16 Rust
transport tests and Runner typecheck. A credential-free Linux probe against the actual installed 15,671-entry, 540 MB
Pi closure takes 4.22 seconds to copy and 1.38 seconds to delete. Cancellation
during an admitted read drains and deletes the partial copy in 0.28 seconds; no
snapshots remain. This free repair-engine proof does not qualify packaged Runner
bytes. The source must be rebuilt and admitted before another paid attempt. All
33 release cases belonged to the earlier full-release scope.

### Historical profile-18 release-gate snapshot

The table below preserves the older full-release scope and its source-specific
evidence. It is historical. The current delivery gates are the seven passing
profile-19 daily-use and human-control paths in the opening section. Accounting
and the wider acceptance matrix are deferred; the old package/image freeze and
remaining case counts below are not current delivery instructions.

| Historical release gate | Historical evidence |
| --- | --- |
| Offline cancellation proof | Profile 18 passes all 49 Pi ACP protocol checks. Historical profile 17 remains decodable; exact launch requires profile 18. |
| Snapshot retirement proof | Shipping source `06a3d9739` passes 271 focused TypeScript tests, one existing skip, 16 Rust transport tests and Runner typecheck. Actual installed native copy, cancellation and deletion probes pass. All six actual live attempts have independent zero-snapshot cleanup. Installed real Pi RPC recovery and pending cancellation also pass with exact-child retirement. |
| Normal Linux build and public installation | Source `b696e131ae32a82418e570b32f4727b5adb14e49` passes the normal hosted Linux build, clean 18-package npm install, lifecycle isolation and 20-archive retention in job `37777555436`. A fresh cloud consumer passes full public/plugin graph audits, normal Pi setup and companion import, the actual installed pack reader and server/UI startup before the definition-22 memory pass. |
| Normal ARM Mac installation | [Native hosted ARM check](https://github.com/paperclipai/paperclip/actions/runs/37694650556) passes on shipping `06a3d9739`: normal workspace/public builds, npm lifecycle, graph audits, Pi setup and packaged admission. All 18 archives and logs are retained and hash-verified; no provider prompts. |
| Normal Intel Mac installation | [Native Intel continuation](https://github.com/paperclipai/paperclip/actions/runs/37700732418) passes normal npm lifecycle, Pi setup, signed native daemon, graph audits and closed admission in 24,770 ms using the exact 18 retained archives. The original cancelled attempt remains retained; no Rosetta or provider prompts. |
| Final Product acceptance | Current-freeze Sonnet 4.6 coverage is 1/26 on installed runtime/image `b696e131ae32a82418e570b32f4727b5adb14e49` and harness `da8d4454ae165b557ff11730e9fe018c9b1cd9b9`: the definition-22 cloud memory cell passes both native reads, exact LF, controller restart, fresh-task readback, cross-root denial and independent cleanup. All 31 canonical files are retained and independently hash-verified. The remaining 25 Product cells need current-freeze qualification. The definition-21 local pass on `06a3d9739` and both historical cloud failures retain their original source and grades. Earlier Sonnet and DeepSeek receipts are historical evidence only. |
| Final Runner acceptance | Current-freeze coverage remains 0/7. Historical Sonnet coverage is 0/7 on definitions `bf8c509d`. The first get-task-context attempt passed all semantic assertions but retained canonical `accounting_failure/provider_budget_coverage_unknown`: the installed evaluation SDK has no Sonnet 4.6 price entry. The six remaining cases did not run. Native low, 120-second limits and scoring rules remain required; no automatic retries. |
| Cloud image | [Hosted Linux build and retained packages](https://github.com/paperclipai/paperclip/actions/runs/37777555436) pass for `b696e131ae32a82418e570b32f4727b5adb14e49`. Immutable image `sha256:ce622e03c606cb93eedda824133b791449f7be752d85e220a2e316f825f37226` passes normal companion import and installed pack admission, then the real definition-22 cloud memory case. Guest retirement and owned qualification-host stop are confirmed. Earlier image receipts remain historical. No local Docker is used. |
| PR CI and review | Frozen runtime source `b696e131ae32a82418e570b32f4727b5adb14e49` passes all 54 applicable checks with two skips. Memory harness `da8d4454ae165b557ff11730e9fe018c9b1cd9b9` passes 173 focused regressions and the live cloud case. Current-head CI and review remain required PR gates; a passing memory case does not qualify the full release. Prerequisite #14921 retains the valid premature-admission finding. No merge, release or rollout is authorized. |

The earlier cancellation defect and all failed attempts remain retained. Pi omits
service-failure metadata only for its authoritative cancelled terminal, preserving
partial usage and ordinary provider failures. ACPX and server failure handling,
exact bytes, final line-feed, permissions, run attribution and cleanup grading
remain strict. Task creation binds the explicit public creation-response issue ID.

The dedicated OpenRouter key retains its $5 lifetime cap inside the approved $100
total token ceiling, with no reset, BYOK, account-key fallback or unchanged paid
retry. The post-Stop key snapshot on 2026-10-08 records $1.59509009 lifetime usage and
$3.40490991 remaining; this is a key-wide total, not a per-case invoice. Billing snapshots are provisional. Reclaim only inspected,
quiescent resources from the owned qualification host after retaining their evidence;
require disk headroom and zero leaked native snapshots before subsequent paid cases.

## Exact shutdown source qualification — 2026-10-07

Production and installed packages are frozen at
`06a3d9739f402baa7f8be7aaa29dda6db7354bfb`; protocol definitions are frozen at
`d38ebc674d9138b941908d5128321e91db05a3a8`. Normal workspace/public builds,
consumer installation and lifecycle hooks, strict graphs, Pi setup and real
server/UI admission pass. All 20 archives are hash-verified and retained.
[Hosted image build](https://github.com/paperclipai/paperclip/actions/runs/37676853634)
passes. Image `sha256:5e62c8e294cd9d663316ba09b0aae1d7358a8938fe37d17936ef394cf1723ab2`
passes anonymous Linux admission and an actual credential-free Daytona probe;
probe deletion is confirmed. Current-source CI passes 54 checks with two skips.
Nine simultaneous runner shutdowns are retained as infrastructure interruptions;
a single failed-job rerun passes. Both PRs had zero unresolved review threads at shipping-source admission.
Fixture head `56d1e03ac` also passes 54 checks with two skips; its new review
finds the stale table corrected in this documentation update.

Stop, same-turn steering and native questions pass on these installed bytes.
Independent cleanup after each finds zero native snapshots, temporary roots,
owned runtime processes or credential input files. The fresh memory case then
fails its unchanged exact-byte grader: the native read and public managed-file
API both return the expected 32-character value without its required line feed.
The original 38 MB of canonical evidence and failure classification are retained;
the sequence halts with no subsequent paid dispatch or automatic retry.

A free probe against the actual installed Pi write/read modules proves that
32-byte and 33-byte inputs are written and read unchanged, with no newline
insertion or trimming. The task JSON independently decodes to the correct
33-byte value. The supported cause is model behavior, separate from the original
canonical candidate-failure classification. The only fixture correction explains
that write never appends a newline and complete read preserves it. Original
JSON, exact-byte graders, cross-root denial, model, low thinking, deadlines,
permissions and production profile 18 remain unchanged. Qualification must use
a recorded new harness revision for this changed prompt; shipping artifacts
remain frozen at `06a3d9739`.

The owned 10 GB build host is resumed after its unsupported disk-resize endpoint
rejected a request. Four exact checksum-verified toolchain download caches are
reclaimed after rechecking all 20 package archives and daemon bytes. Installed
tools and all canonical evidence remain retained. The 2 GB disk admission floor,
finite host lifetime and independent zero-snapshot cleanup stay in force.
No local Docker is used and no rollout, release or merge is authorized.

Harness `56d1e03acdb8f951436d66f56c8f0b74a3c5c423` changes only the memory
prompt clarification, its documentation and this plan. Cloud verification proves
all production trees unchanged from shipping `06a3d9739`; all 26 catalog
fingerprints remain identical. Fixture typecheck, nine focused fixture suites and
all seven definition validations pass with zero provider calls. The three
unaffected prior passes retain their original harness revision and exact archive
identities; they are not relabelled.

The clarified memory attempt also fails the original exact-byte grader. Its
native complete read and public managed-file API agree on 32 bytes without the
required final line feed; the run succeeds and produces a durable save receipt.
The 31 MB canonical report, full trace and original failure remain retained.
Independent inspection again finds no snapshots, temporary roots, runtime
processes or credential inputs. The free installed-tool probe preserves both
32-byte and 33-byte arguments exactly. No supported production-code change is
identified. Paid qualification is held for a decision on the frozen fixture model;
no unchanged retry or subsequent paid case ran.

An earlier launch of this clarified harness was rejected by the unchanged 2 GB
disk preflight before billing, a model call or a case claim. After verifying local
retained copies and remote hashes, only duplicate evidence files and writable
compile caches were retired. The root-owned image cache was left untouched.
The actual memory attempt began with 2,050,457,600 bytes free. The original
preflight rejection and both cache-reclamation diagnostics remain retained;
none is reclassified as a live qualification attempt.

## Frozen-model memory encoding correction — 2026-10-07

The active goal keeps `openrouter/deepseek/deepseek-v4-flash-0731` and native
low thinking. The proposed replacement qualification model is not applied.
Shipping packages and the admitted image remain frozen at `06a3d9739`; no
production input or runtime profile changes.

The existing real Pi RPC warm-recovery test passes against the exact installed
profile-18 wrapper. Its fragmented JSON write preserves the final LF on disk,
a fresh wrapper restores the session and agent home, and both owned Pi children
close. External sockets are denied before connect; responses come from an
owned synthetic loopback fixture. This is diagnostic proof, not live coverage.

Pi native definition 17 changes the authoritative write JSON's LF encoding from
`\n` to `\u000a`. Both decode to the same 33 UTF-8 bytes; the final byte remains
10. The installed native write/read probe preserves that Unicode-escaped content
and an unchanged 32-byte negative control exactly. The original model failures
remain retained. No grader, permission, deadline, case ID or production behavior
changes. The new suite fingerprint must be recorded; prior native definition-16
passes remain their original measurements. Unchanged controls retain their
original fingerprints and installed identities.

Run the free harness checks against an exact new harness revision, then permit
one explicitly selected changed memory attempt under the same $5 key lifetime
cap and $100 campaign ceiling. Keep zero automatic retries, no BYOK or fallback,
and the same 2 GB disk floor. Stop and retain canonical and independent cleanup
evidence on any failure. An encoding change does not itself establish reliability
or production readiness.

Documentation head `3fee270de` passes all 54 applicable CI checks with two skips
after one failed-job rerun of two simultaneous runner shutdowns. Original logs
remain retained. Its Greptile review is 5/5 with no unresolved threads; this new
harness change requires fresh current-head CI and review. All remaining Product,
Runner and platform installation gates remain required. Do not merge or release.

## Current qualification disposition — 2026-10-07

**Not production ready.** Shipping packages and image remain frozen at
`06a3d9739f402baa7f8be7aaa29dda6db7354bfb`. Product harness
`5ccb4a346298351af5247cc8095e6cf8e2e0a539` uses Pi-native definition 17,
`e60021e6959cb2ed9b50b3d5b734b6ad5a78bafc7aca1ea1fca456fb3191f318`;
its catalog is `3827956ef849a665969254dda075e51f02d014c62f9f4de3e290ef05c5191800`.
All 201 focused fixture tests, harness typecheck, catalog capture and seven
Runner definition validations pass without provider calls. The initial free
fixture check's stale definition hash is retained; the corrected pin passes.

The one selected changed memory attempt failed. It made eight native writes,
one read and three shell calls, still observed 32 bytes without the required LF,
and reached the unchanged 120-second native deadline. Preserve its canonical
`transient_infrastructure` classification separately from the tool timeline,
which supports repeated model behavior rather than a stopped transport.
The actual raw write arguments were not retained and their supplied bytes are
not asserted. All 18 canonical evidence files, totaling 49,717,073 bytes, and
their original hashes are retained. Original independent inspection confirms
launcher exit, zero temporary roots and credential-input removal within its
recorded coverage. Its process scan omitted executables in Pi snapshot roots.
A supplemental scan at 22:53:48 UTC covers those paths too and finds no owned
runtime processes or temporary roots; launcher 7869 and observed sidecar 8466
are absent. This proves current quiescence and does not retroactively broaden
the original receipt. No subsequent paid case or automatic retry ran in that
qualification sequence.

After the user's request to get qualification working, one separately named
input-boundary diagnostic ran on a fresh cloud host against those same packages,
harness, model, low thinking and graders. The original host had been automatically
deleted. The restored consumer's 391 packages and 80,151 files match the frozen
runtime inventory; four declared native-build configuration files regenerated.
Registry drift was corrected using the original dependency versions and retained
integrities before the diagnostic. No shipping inputs changed.

That diagnostic retained actual Pi session tool inputs: all eight writes supplied
32-byte content without LF. Observed memory-file hashes matched the supplied
content hashes. This rules out newline removal by native write/storage for those
inspected calls; upstream raw provider SSE was not captured. The unchanged
120-second deadline still failed, and its canonical `transient_infrastructure`
grade remains intact. Cleanup passed, with no owned runtime processes or temporary
roots in the independent scan. All 42 canonical files, totaling 130,691,700 bytes,
were retained and hash-verified locally. Its provisional key-usage delta is
$0.004511326; cumulative key usage is $0.585187764 against the unchanged $5 lifetime
cap inside the approved $100 campaign ceiling. There were no automatic retries.

On 2026-10-08 the user approved switching qualification to
`openrouter/anthropic/claude-sonnet-4.6` and requested the memory-test repair.
Pi native definition 18 uses one ordinary JSON write and exact complete read,
with all byte, persistence, permission and restart assertions retained. Native
low thinking and zero automatic retries remain required. Sonnet coverage starts
at 0/26 Product cells and 0/7 Runner cells; previous DeepSeek measurements remain
historical. Production model selection remains caller-controlled. The frozen
shipping source, packages and cloud image do not change for these test inputs.

The owned Daytona host is now stopped normally after a fresh broad process/root
scan and renewed local verification of all six canonical attempts: 120 files,
127,249,447 bytes, plus all 20 Linux package archives. Original evidence remains
retained. Its configured 30-minute automatic deletion is unchanged; no idle
qualification host is kept running while the memory failure is unresolved.

The actual installed Pi wrapper also passes the existing synthetic RPC recovery
and pending-cancellation scenarios. Two diagnostic variants split every JSON
character into separate provider SSE argument events, for both `\n` and
`\u000a`; both preserve the required 33-byte value on disk. The read-feedback
variant also verifies the exact LF-bearing text in the subsequent provider
request. Network connections outside the owned loopback fixture are denied
before connect, owned children close and shipping sources remain unchanged.
These checks identify no supported production correction and do not count as
live qualification passes. The approved Sonnet qualification keeps native low
thinking. Do not substitute a passing surrogate or weaken exact-byte grading.

Native hosted ARM installation on the same shipping source passes normal npm
lifecycle, Pi setup, full graph hashes, native signed daemon identity and closed
public admission in 22,245 ms. Its daemon is
`sha256:89a972407fd78bf5c9ac6faa5046afd4d15cb9da17e2595ea96946738702f0af`.
All 18 archives and step logs are retained and independently hash-verified.
Build lock and platform-specific graph/archive identities remain attached to
that platform receipt; they are not substituted for the Linux member's bytes.
The original [native Intel job](https://github.com/paperclipai/paperclip/actions/runs/37694650556)
was cancelled by the agent based on a stale live log. Its retained receipt proves
the workspace/public builds, all 18 archives, normal npm installation and native
signature check had passed; cancellation interrupted Pi setup. Preserve the
original receipt and all hash-verified archives. The
[continuation](https://github.com/paperclipai/paperclip/actions/runs/37700732418)
binds that original receipt and artifact, uses the same package bytes on native
Intel hardware and emits synchronous progress. It passes normal npm lifecycle,
Pi setup, signature verification, complete installed-graph audits and closed
admission in 24,770 ms. The native Intel daemon is
`sha256:1918f0e8524abaa8ae454db7c1431e2f5437a587a4e0fe61b55c67047f8aaaa6`;
all 18 original archive hashes and both runs' completed step logs are verified.
Keep the final consumer graph identity with this platform receipt. Both runs
repeat maintainer authorization and immutable source checks on a separate
temporary orchestration branch. No shipping source, local Docker, provider
credentials or prompts are involved. All three normal platform installation
gates are now satisfied for shipping `06a3d9739`.

Current coverage is 2/26 Product passes, one failed cell and 23 unexecuted cells,
plus Runner 0/7. The definition-16 native-question pass remains historical.
Prerequisite #14921 still has one valid production-admission finding; the other
three prerequisite PRs have no unresolved threads. The post-attempt key snapshot
is $0.561888353 usage with $4.438111647 remaining under the unchanged $5 lifetime
cap inside the approved $100 campaign ceiling. Settlement is provisional.
Keep paid execution halted until a concrete correction addresses the observed
memory failure. Keep the full remaining scope and do not merge, release or deploy.

## Final fixture reconciliation — 2026-10-07

Fresh Linux CI passed the server, database, UI and package checks. It exposed
the remaining stale Pi profile-15 fixtures in the native backend, provisioning
suite and public-install probe. Those checks now bind profile 16. Thinking
changes are rejected while the unchanged identity can still attach successfully.
The Rust and TypeScript instruction composers now share master's current-turn
`AGENT_HOME` guidance; the shared positive and negative suffix fixtures remain
the attachment authority.

The corrected native backend passes 22 integration tests, the Rust core passes
350 unit tests, and the shared instruction/provisioning suites pass 13 tests.
Recursive typecheck and the full workspace build pass. Product E2E free checks
pass 2,479 Vitest tests and 128 native completion checks, and token gates pass.
The final complete Rust run and fresh Linux CI are still required. Local
PostgreSQL integration remains blocked by this host's shared-memory capacity;
the corresponding Linux CI lanes passed before this fixture-only update.
The complete Rust run exposed two attachment fixtures sharing a temporary
directory namespace. Each provider now uses its own name; all three attachment
tests pass together. The final complete suite is being rerun after this fix.

The dedicated qualification key's fresh read records $0.430881296 lifetime usage
and $4.569118704 remaining under its $5 cap, with no reset or BYOK usage. The
signed-in Default Workspace has all 72 BYOK providers unconfigured. These
account observations made zero model calls. Current-source installed admission,
the real task, and all 26 Product plus seven Runner cases remain unqualified.

## Master safety restoration — 2026-10-07

The earlier merge retained obsolete accounting code and removed master budget
reservations, usage receipts, fractional billed amounts and cancellation policy
fences. Restore those implementations and their database/shared/API/UI contracts
from master. Reconcile the heartbeat and native executor with a three-way merge
so Pi warm instruction copies, thinking identity and remote companion selection
coexist with current accounting. Restore the native accounting regression tests
and the usage completeness marker that durable replay requires.

Remove the obsolete Cursor-only plan receipt implementation. Recovery fixtures
now use master's provider-owned plan receipt path while preserving historical
Cursor6 authority. Local PostgreSQL integration verification is held because
this host exhausts System V shared memory during database bootstrap. No changes
to global host limits or other running databases are part of this task.

Free checks pass 91 source-only server boundary tests, 78 native usage/accounting
tests, 11 Rust callback-resolution tests, and both public setup boundary tests.
The Linux canary exposed a separate setup bug: the provisioner wrote Pi assets
at the server root while discovery requires its vendored Runner directory. The
provisioner now publishes to that same fixed directory. Its packaged-layout
regression verifies corrupt installed bytes fail before any download or child.
A fresh Linux public install is still required.

Qualification will use a fixed master integration at
`b67db12d90c1bd191f99975e35cc5c84137858e4`. No paid calls were made for these
repairs. Current-source Linux installation, exact-head CI/review and all 33 live
cases remain release gates; prior live evidence does not transfer.

## Startup and merge repairs — 2026-10-07

The real sidecar process now accepts all four explicit Pi thinking levels in
`session.open`; invalid levels, foreign-provider levels and unknown fields still
fail before launch. Runtime identity verification independently checks thinking
level and retires rejected admissions without prompting. Regression tests run
with no ambient provider credentials and a caller-selected custom model.

The empty ACPX patch hunk that broke GNU patch and Linux release packaging is
removed. Current profile 16 identities and Cursor's patch declaration are
regenerated; historical identities remain unchanged. Master-merge regressions
in historical plan receipts, duplicated Cursor controls and outdated tests are
reconciled. The PR's lockfile matches its dependency branch; CI resolves the
updated manifests under the repository's lockfile policy.

The startup/host suites pass 136 tests, the targeted provider/receipt/environment
suites pass 187, the configuration/permission suites pass 71, the native Runner
unit suite passes 342, and packaging checks pass 16. These are free regression
checks. Production remains held until current-source CI, normal Linux package
installation, a real Pi task and the accepted live cases have passed. Mac work
remains deferred and no prior-source live result transfers to this candidate.

## Master integration and model selection — 2026-10-06

This branch merges `origin/master` through `a9a20fb5c6c080884ced7ee0a4e3b04f9cbf3a6e`.
The original integration point was `a6306ba606eb87c89b9ef0344e9fe8e0025580f9`;
two additional master commits are included in the final merge.
Pi accepts the operator's explicit provider/model ID without a Paperclip model
allowlist. Catalog discovery does not gate selection. Exact native model
acknowledgment remains required before prompting. API credentials for built-in
providers and explicit native custom-provider configurations remain session-bound.
Custom-provider configuration changes also fence session recovery.

Pi profile 16 binds the updated ACPX patch and configuration/recovery sources.
Runtime and native distribution pins remain Pi 1.0.0. Historical profile 15
fixtures are preserved. This integration does not transfer prior live passes to
the new source. The task acceptance below belongs to source
`46ffa7aa3a8b219f5508448cffe297c09e38d810`. No paid model calls or platform
qualification runs are part of this merge. Mac coverage remains deferred.

Merge validation runs in an independent checkout because this worktree's
node_modules links belong to a different checkout. Recursive typecheck, full
build, generated-profile parity and UI token gates pass. The complete Runner
suite passes 3,363 tests and reports five stale transport fixture expectations;
those fixtures are corrected and all 11 selected transport regressions pass.
All 2,473 offline Product harness tests pass after the final master merge.
The two new server test files pass 10 tests with one skip. The final focused Pi model,
credential, installation and session suite passes 280 tests, with one skip.
The repo-wide test command did not complete: its pre-fix run was stopped after
24 minutes. Targeted directory and session-identity regressions pass on the
corrected source. No full-repository green-suite claim is made.

## Immediate execution focus — 2026-10-06

The operator has re-centered this work on getting Pi to run through the new
Runner. Use the already admitted native Linux package/image path for real task
acceptance. Additional Mac installation coverage is deferred to a separate
follow-up. It does not block work on this Linux path. Keep the remaining scope
on accepted task behavior, permissions, recovery and cleanup. Preserve all
failed evidence and the frozen model, low thinking, budget caps and zero
automatic retries.

## Real Linux Pi task acceptance — 2026-10-06

The current installed runtime passes
`extended-harnesses.runner-acpx-pi.local.file-edit-validate` in **52.680 seconds**.
It uses native Pi 1.0.0 with the frozen model and low thinking. Pi reads the
seeded file, performs one native edit, runs the exact validation command once,
registers a real downloadable attachment, and finishes the task. Independent
workspace and downloaded bytes match, including the newline. All seven
canonical matchers and the strict file-evidence grader pass. The validation
has a native structured output receipt with exit code zero; the distinct typed
exit-code field remains null and is not invented.

The durable events contain `turn.completed`, an accepted completion claim, and
a genuine `run.terminal` with state `succeeded`. Canonical cleanup passes.
Independent SDK checks confirm that the launcher, recorded Runner and Pi
provider processes, temporary fixture root, and uploaded credential file are
absent. The attempt has zero automatic retries. No held failed case is retried.

The Linux task-acceptance freeze is
`sha256:ac66edb3a6c1804dfea1ce9c58cb2fcf1aced9170e84b7da5868a334f2290d8f`.
It binds current source, all 18 installed public archives, the immutable Linux
image, unchanged grading definitions, full package graphs and credential-free
admission. It does not certify other platforms or transfer historical passes.
The canonical result hash is
`8f75adabe5bdc4a4c2dba98775b52fd14622abe338b9f0910084aa838926adda`;
the strict file receipt records matching workspace and download hash
`83bfa78170b1bdd48a58ec2172e95c212b8fab4e0edead571ac18367507b8f77`.

Current qualified coverage is **1/26 Product and 0/7 Runner**. Pi demonstrably
runs on this path; the remaining accepted behavioral cases still need evidence
before a full production-readiness claim. The later key snapshot reports
provisional total usage of **$0.383058202**, **$4.616941798** remaining, no reset
and zero BYOK usage. The observed increase for this attempt is $0.003865352;
it is not a final invoice. The $5 key cap and $100 campaign ceiling remain.

## Current corrected source — 2026-10-06

Shipping source `46ffa7aa3a8b219f5508448cffe297c09e38d810` contains the
durable cleanup correction below. Full build, recursive typecheck and Product
harness typecheck pass. All 288 environment tests pass. Exact-head CI has 53
successful checks and two optional skips. Greptile completes successfully;
the review-thread audit finds no unresolved threads or omitted pages.

All 18 public archives are freshly packed and installed with verified integrity.
The public-payload audit excludes credentials, databases and run evidence. The
source-bound image is
`ghcr.io/paperclipai/paperclip-daytona-runner@sha256:e8c38507c99db401a23d62c680cea888c58ee213c3edc3b85bf3ff04e3e26090`.
Anonymous access and source/content labels pass. Normal native Linux CLI
installation, Pi setup and offline admission pass with lifecycle scripts and
the packaged daemon, without a binary override or model key. Admission takes
7.701 seconds, confirms profile 15 and Pi 1.0.0, and exits the Runner cleanly.
The temporary sandbox is deleted; an independent SDK lookup returns 404.

Normal ARM Mac npm installation passes, but Pi setup cancels before admission.
Its failed grade remains preserved. The installation process, setup lock and
temporary setup directory are absent; no ARM runtime is admitted. The host log
records repeated thermal-emergency sleeps during this attempt. That correlation
does not prove which cancellation source fired. The original setup deadlines
remain unchanged, and no unchanged retry runs. Darwin x64 compilation passes;
normal x64 installation and physical Intel hardware proof remain outstanding.
These Mac observations are historical installation work. Additional Mac
coverage is deferred under the immediate execution focus above.

Prerequisite #14922 now has 52 successful checks. Prerequisites #14923 and
#14924 each have 53 successful checks and two skips. Only their specific
cancelled jobs and dependent checks were resumed at verified, unchanged heads;
the original cancelled attempts remain preserved. All three have no open
review threads. The premature-admission finding on #14921 remains open until
the complete live qualification proves readiness.

The new set now has **1/26 Product and 0/7 Runner qualified passes**, through
the real Linux task above. Additional platform coverage is deferred. Prior-set
8/26 Product and 5/7 Runner passes remain historical. The corrections and
installation checks use no model calls; the task above is the one new paid
attempt. Memory, steering, semantic tool-call and terminal failures
still require their own evidence-backed corrections before retries. Keep the
dedicated key's $5 lifetime cap and the $100 campaign ceiling. The frozen
model and low thinking remain unchanged. Production, merge and release remain
held.

## Failed reusable-lease deletion correction — 2026-10-06

Review of `fc661a364` identifies a further crash window: issue/workspace
closure calls provider destruction before recording `pending_cleanup`. The
correction now shares one durable, scoped cleanup claim with environment
deletion. The atomic claim re-checks company, environment, issue/workspace,
lease policy, current status and holding-run liveness. It records an attempt
identity and renewable cleanup ownership before provider work, preventing
concurrent closures or sweeps from destroying the same resource. A failed
provider call or settlement retains the handle for recovery. Controller loss
leaves bounded ownership which the sweep can reclaim after expiry.

All 288 environment tests and the complete server typecheck pass with this
correction, without provider credentials or changed test deadlines. Six new
regressions fail semantically on the preceding shipping source: two closure
paths lack the durable record, environment teardown lacks exclusive cleanup
ownership, and queued, scheduled-retry and running transitions bypass the stale
closure live-run check. The failed log hash is
`3e87d913a7ecfadf5a5e8988526b6f8236d602d18edc32d28aeb5406e370b203`;
the corrected suite hash is
`9a21949740b6cdc6055950bb847eae546a071dc7e4ce9dc5c410a3cf0d88f30b`.
The first free regression also contains two test-spy restoration failures;
that output remains preserved. Correcting only spy restoration permits the
six semantic failures above; no assertion or deadline changes.

The preceding `fc661a364` revision completes full build, recursive typecheck,
Product harness typecheck and all 1,847 Product unit tests. All 18 freshly
packed archives install with verified integrity and its Darwin x64 binary
compiles. Its intermediate image is
`ghcr.io/paperclipai/paperclip-daytona-runner@sha256:4238d570faac69149ab718bc0a336876b2afbef6924ab2c1eccbaddb2a347d65`.
That exact head has 52 successful checks, two skips and one failed Greptile
cleanup review. These artifacts and checks stay historical for the new claim
correction; do not admit or qualify them as the final shipping set. No paid
attempt runs during these corrections.

An independent check finds the Daytona pending-permission Stop child still
started after the canonical case passes and environment deletion returns 200.
The fixture environment and child labels match the actual run. Its canonical
pass is preserved, but it supplies no qualified pass. Exact-owned manual
teardown deletes the child; a new SDK lookup returns 404. The launcher,
temporary root and uploaded credential file are independently absent. The
actual retirement proof records `qualification: false`. Its canonical result
hash is `9154d3eed0cf909cb2299bc56dfd32d8275f8d9c333a81266005114f6ec50385`.
The lease's final database state is not retained, so this observation alone
does not establish the underlying lease transition.

A separate free database regression proves a concrete deletion gap. A failed
run can successfully stop a reusable sandbox and record its lease as `failed`.
That lease still holds the provider handle, but the deletion preview, atomic
delete guard and scoped teardown all omit it. The original source fails three
regression cases. The correction includes failed reusable leases in all three
paths. It preserves explicit destruction consent, exact provider scope, the
live-run fence and the durable `pending_cleanup` claim before provider work.
All 279 environment service, runtime and route tests pass without provider
credentials or changed deadlines. The failed regression log hash is
`441f3d39f33f74c2b323b8bc63993f660a4b48016dc31cc88847ee3dc7b65682`;
the corrected-suite log hash is
`c809d93df9e104ad8eb865694cbb9817cd65a768ceeded44e0dd246d4283d977`.

This changes shipping inputs. Rebuild every public archive and the Linux image,
then freeze and qualify that set. The previous `c0eba7f4d` set has 8/26 Product
and 5/7 Runner passes, including fresh Daytona hello-complete. Those passes
remain historical for this correction. The Daytona Stop case remains held
until a fresh corrected-set attempt proves cleanup without manual intervention.
The memory, steering and Runner terminal/tool-call failures still need their
own proven corrections; this cleanup change does not authorize their retries.
All 26 Product and seven Runner cases remain required on the final set.

Review also identifies the issue/workspace closure path, which omitted failed
reusable leases. The follow-up includes them there while retaining company and
issue/workspace scope and the live-run check. All 282 environment tests pass,
including failed-lease closure for each scope and rejection of another company.
The complete server typecheck passes with all corrected services and tests.
The corrected-suite log hash is
`9b965b9cf0acc1dc49340f85d4efb5588f6f59b3bc2522df7ec96d3bb515443a`.
The first filtered review regression reaches its unchanged database startup
hook timeout before any test executes. That failure stays preserved and its
owned Postgres process is independently confirmed absent. It proves no semantic
regression result.

Two unchanged pinned-runtime controls also pass with no provider credentials:
native agent-file write/read preserves the exact final LF, and serialized RPC
warm recovery preserves that memory across both sessions and reaches both
terminal turns at low thinking. The synthetic server supplies six requests;
external socket connections are denied before connect. The log hash is
`b902ea76b2d0ee377dc28c42e7fe96d91e9e92671060380fe2dd87901b801797`.
These controls narrow the failing live memory/terminal investigation. They do
not attest its missing raw write arguments or regrade either live failure.

The first cleanup revision `3f6b11a1e` passes full build, recursive typecheck and
Product harness typecheck. Its qualification-only Linux image is built and
published at
`ghcr.io/paperclipai/paperclip-daytona-runner@sha256:ab05e949af8ccff1a1f94317272ce5d934398a9548b6197de273bfb942bf74a4`.
The issue/workspace follow-up changes shipping inputs again, so that intermediate
image is historical and is not admitted or qualified. Preserve its receipts.
No new paid attempts run in either correction. Latest-head CI and review remain
required. The first cleanup head fails its connection-intent browser scenario:
its continuation reaches `cancelled` where the unchanged test requires
`succeeded`. Keep that failure and inspect the actual run before changing code.
The first local diagnosis cannot launch Chromium from its isolated home.
Supplying the exact cached Chromium revision passes the unchanged scenario
with a full trace: both runs succeed, the provider is called once more, and
the task is done. This does not regrade the failed CI run or prove its cause.
The fresh `fc661a364` CI browser shard and aggregate subsequently pass.


## Linux process-birth correction — 2026-10-06

The prior-set local pending-question restart failed before controller shutdown because the
unchanged ownership guard rejects the public run's daemon birth receipt. Its
canonical failed grade and passed cleanup remain preserved. Actual SDK inspection
proves the launcher and temporary fixture root absent before releasing the claim.

A zero-provider Linux control reproduces a concrete mismatch: production records
`/proc/PID` directory ctime, while the strict restart guard observes actual birth
through `ps`. The installed daemon's ctime is `18:46:34.102Z`, but its kernel
birth is `18:46:33.800Z`. The same unchanged guard rejects the former and accepts
the latter. It also rejects a deliberately wrong birth receipt. The daemon's
identity stays stable through delayed inspection and its process is retired.
The proof is hash-bound at
`32580fe4f97a9799049ae887ff5652f4b5243cc53c3c2e77404bb13e0c40f32e`.

The correction shares a kernel-tick birth reader between server process receipts
and retained Runner maintenance. Malformed metadata fails closed. PID, group,
ancestry, role and cleanup checks stay intact. Parser, hot-restart, native-recovery
and process-owner checks pass 94 tests; one Linux-only parser integration is
skipped on Mac and the separate installed Linux daemon proof passes. Runner,
server and Product E2E typechecks pass. The rebuilt vendor-boundary set now
passes the corrected local restart and the fresh Daytona restart measurement,
with all six unchanged matchers in each case. Both preserve the original native
question and turn through controller restart. Canonical cleanup passes; actual
SDK observations prove owned launchers, temporary roots and uploaded credential
files absent. The Daytona child sandbox independently returns 404. The prior
set's 1/26 and 6/7 passes remain historical. Its canonical full Linux command
finishes with one failure caused by the driver forcing `GIT_CONFIG_GLOBAL`
into a test that expects the normal unset variable. Omitting that driver-only
setting passes the same unchanged test file without provider calls. The full
Linux command remains failed; the narrow correction does not regrade it.
The missing-LF memory failure and finish-task stream timeout still need a proven
correction. Production remains held.

The first birth-reader build at `9fdcefcc3` passes full build, recursive
typecheck and harness typecheck, and all 18 packages are repacked. Its normal ARM
install and Pi setup pass, but offline admission fails because the server imports
the private Runner package instead of its bundled vendor boundary. The browser
CI shards and company-import test show the same missing-module error. Those
failed receipts and image remain preserved and supply no qualification evidence.
The follow-up routes the import through the existing vendor shim and mirrors the
compiled Runner export there. All 39 hot-restart and native-recovery tests pass
with that correction. The artifacts from this follow-up are rebuilt and admitted.
The exact nine Linux birth-reader tests also pass on Linux without skips or
provider calls. The 2026-10-06 18:58:24 UTC key snapshot records provisional
usage of $0.358793129 of $5, with $4.641206871 remaining and zero BYOK usage.

The corrected vendor-boundary source is
`c0eba7f4d94e01bd74e4342a258842a2b10d798b`. Full build, recursive typecheck,
harness typecheck and all 1,847 Product fixture tests pass. All 18 public package
archives are freshly packed and integrity-verified. Normal ARM Mac, Darwin x64
under Rosetta, and native Linux install, Pi setup and offline admission pass
without provider credentials or a binary override. Physical Intel hardware
remains unverified. Independent SDK observation confirms the Linux admission
sandbox absent, and the superseded Product controller is retired after both its
jobs finish and every runner process is absent. Their evidence stays preserved.

The rebuilt immutable image is
`ghcr.io/paperclipai/paperclip-daytona-runner@sha256:6029b52f8266a64b84160b51b1cd68914b7ea42657896fa30358834254aab071`.
Anonymous digest/source-label verification passes. The freeze manifest is
`sha256:e15b2b70cad3890555e422a82e62718d1eadf55c3557920a662d6108b596cf2b`.
The evaluation consumer verifies 722 packages and 79,367 files with zero
mismatches. Its installed Runner matches all 1,334 freshly packed distribution
files. All seven pre-service Runner admission checks pass, with profile 14
rejected. This rebuild and admission work makes zero model calls. Frozen-set
qualification on that source is Product **8/26** and Runner **5/7**. Local hello-complete,
human permission denial, restrictive denial, native controller restart, pending-permission Stop and native questions pass;
Daytona native controller restart and hello-complete pass. The packaged Runner task-context, context-before-action, document creation, context/document/progress and governed-wait
cases pass every unchanged check with native-confirmed low thinking, no retained
session and independent absence checks for each launcher, daemon and provider. Canonical
results, archives and actual cleanup proofs are hash-bound in
`qualified-cases-c0eba7f4d.json`. Historical passes do not qualify this set.
The canonical `pnpm test:run` finishes with 14,976 passes, two failed tests
and one additional failed suite. PostgreSQL startup and two timeouts fail.
A separate credential-free check preserves all three files and their deadlines.
It passes the PostgreSQL and managed-auth suites (71 tests). The Git streaming
suite still exceeds its original five-minute Mac deadline, then reports
`ENOTEMPTY` during fixture removal. Both failed commands remain failed.
The full log hash is `0b0b3f24808fbac4bb2139bfa00d89f4d9a408551f7dafae3c4a41c5f3bdfc7b`;
the isolated log hash is `13cfe5815aa26cbcc1bb008c05df085824150fec2a271c4f5d92744157772e4b`.

Shipping head `c0eba7f4d` has 53 successful CI checks and two skips. Review
head `568b7023b` finishes CI with one browser scenario failure and a failed
aggregate; its other 45 CI jobs pass. The chat-retry fixture clicks during UUID
to canonical-agent navigation, which reloads the agent query and can discard
the retry mutation. Waiting for that existing redirect before clicking preserves
all denial, authority and navigation assertions. All nine unchanged retry
scenarios pass against the normal installed frozen UI without provider
credentials, changed deadlines or retries. This free browser fixture correction
changes no packaged runtime or Pi case definitions. Review head `7b674113efa1e927dcb3d29f3fd84d1f1cbd0e4a` passes 53 CI
checks with two skips. Greptile reports 5/5 on that exact head, and #14956 has
no unresolved review threads. Later evidence-only heads need their own checks
and review. Prerequisite #14921 retains its valid premature-admission finding. The missing-LF memory and finish-task stream failures stay
held for a proven correction. The historical memory request has no provider I/O
log, and its canonical archive contains no database or provider session file; raw
write arguments remain unattested. Keep the strict graders, model, low thinking
and budget caps. Drain active native Linux runs before updating or rolling back across the
process-birth change; never rewrite a live receipt to force adoption. Do not
merge or release.

## Closed qualification failures — 2026-10-06

The fresh Runner human-confirmation case reaches its original 120-second
provider-turn deadline before any control-plane operation or human interaction.
The native transcript contains a DSML invocation of
`mcp__paperclip__request_human_input` as assistant text, followed by a claim that
a card was created. The mock state records no such operation or card. There is
no terminal turn. Provider metadata records Inceptron HTTP 499 after 119.7 seconds
at 5.3 tokens/second. This observation narrows the failure to native tool-call
output and cancellation; it does not establish which component produced that
text. Preserve the failed score and verified process retirement. Do not parse
assistant text into an authorized operation or repeat the attempt unchanged.
The artifact hash is
`310717c7af7dd031e7db79f09d61ec5cc86ae6828a2e1958112dd027c325df44`.

The fresh local same-turn steering case fails before steering begins. Pi starts
`bash` and requests permission for `Pi bash`, despite the fixture requiring one
native `write` and forbidding bash. The required write permission never appears.
The native session reaches its unchanged 120-second deadline. The canonical
cleanup assertion remains failed because its required Stop/no-effect sequence
is incomplete. Separate SDK checks prove launcher, runner, provider, temporary
root and uploaded credential file absent. That retirement proof does not regrade
the failed case. Hold it against unchanged retries. Its canonical hash is
`7d8f15e1d5e96693b28853608337be540fd8725b9a59a51a7766befe9152d585`.

The installed native SDK write/read control preserves both a 33-byte LF input
and a 32-byte no-LF input exactly. Source inspection shows the managed file
materializer writes buffers and the checkpoint copies byte chunks. Neither
control attests the historical model's raw write arguments, which remain
unavailable. The missing-LF failure still needs a proven correction.

The 2026-10-06 21:01:14 UTC pre-attempt key snapshot records provisional usage of
$0.378666789 of $5, with $4.621333211 remaining and zero BYOK usage. Fresh signed
browser observations show all 72 providers unconfigured and the same key's $5
TOTAL cap. Keep the $100 campaign ceiling, no reset, no fallback key/model and
zero automatic retries. Physical Intel installation remains unverified; the
existing repository workflows do not expose an Intel Mac installation lane.

## Previous frozen-set measurements — 2026-10-06

The rebuilt `7f66a30ad` package/image set has Product **1/26** and Runner
**6/7** verified passes. The Daytona controller-restart case passes all six
unchanged matchers: the same unanswered native request survives the restart,
the browser supplies its exact answer once, the original native turn completes,
and independent retirement and canonical cleanup pass. Actual SDK observation
also proves the child sandbox, launcher and temporary fixture root absent.
The former restart failure remains unchanged; its canonical hash is retained.

The new local memory measurement fails. Its first invocation stops before any
provider construction because Daytona-only plugin pins were supplied to a local
selection. Removing only those invocation pins passes actual installed CLI
admission plus positive and negative local/Daytona controls without tokens or
shipping/grader changes. The single corrected measurement then reaches the
provider and fails at the original 120-second native-session deadline. Closed
native shell output independently reports 32 bytes without LF before the timeout;
the provider also used an extra shell inspection. Cleanup passes, its launcher
and temporary root are verified absent, and its failure stays failed. The raw
write arguments are not attested, so the location where LF was lost remains
unproven. Do not infer a transport defect or repeat the paid attempt unchanged.

The native packaged Runner passes task context, context-before-action, document
creation, human confirmation, context/document/progress and governed-wait
workflows on this same freeze, model and low thinking.
Every measured case has one attempt, a canonical score, verified native identity,
no retained session and no raw-key leak. The historical finish-task timeout remains
held pending a concrete correction; a successful task mutation alone is
insufficient terminal evidence.

The new Linux controller completes all free admission: its consumer graph checks
722 packages and 101,216 files with zero mismatches, the public plugin graph
checks 191 packages and 16,365 files with zero mismatches, actual Linux observer
controls and browser arguments pass, and all 26 cells collect. Local execution
cells may run on this Linux controller; their `local` driver, real server,
native provider and unchanged graders remain in use. Mac installation evidence
is separate from the controller platform.

Documentation head `99e823164` has 53 successful checks, two skips and no open
#14956 review threads. The corrected source already passes full build,
recursive typecheck, harness typecheck and 1,847 Product fixture tests. The old
canonical Linux full test command completes with 15,077 passes and 57 skips in
its first lane, but later fails because `npm` is absent from the test PATH. The
normal installed npm CLI is added only to the owned test tools; the exact failed
packaging test passes on current source. The subsequent storage preflights remain
failed records. Two orphan HTTP fixture processes are retired only after their
exact process identities and old test-root bindings are verified. One closed
test root is fully archived before removal, restoring the original disk reserve;
the second root remains intact. Current-source recursive typecheck and full build pass. The canonical full
workspace tests run on their retained session with unchanged deadlines. Never
stop or restart a live handle based on an observation timeout.

The release gates remain open. Keep the `$100` campaign and `$5` lifetime key
caps, 72 unconfigured BYOK providers, frozen model and low thinking. That earlier
measurement recorded provisional key usage of $0.357317585 of $5, with zero
BYOK usage; the newer snapshot above supersedes that accounting. The count
above contains only current artifact measurements; historical passes do not
qualify changed shipping inputs. Keep rollout held and do not merge or release.

## Sandbox GitHub housekeeping correction — 2026-10-06

The shipping correction moves sandbox GitHub launchers, upload locks and
per-command configuration below `.paperclip-runtime/paperclip-runner/github`.
One shared path now binds staging, the native callback bridge and cleanup.
Local and SSH locations keep their existing behavior. The native watcher,
excluded subtree, exact byte grades, timeouts and lifecycle assertions do not
change. Shipping inputs change, so rebuild and freeze packages and the Linux
image before any further paid qualification. The new set starts at Product
0/26 and Runner 0/7; do not carry passes across changed shipping inputs.

The corrected shipping source is `7f66a30ad7723c1fbcb6ef64b3281eaebddada29`.
All 18 public package archives are rebuilt and frozen. The immutable Linux image
is `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:8e744211ded7c19015aececeb87da4e1ee994ca9d85c6fbbebcd916682425231`.
Anonymous pull, source labels, Daytona import and normal Linux installation,
Pi setup and offline admission pass; the admission sandbox is deleted. Normal
ARM Mac and x64 Node under Rosetta install/setup/admission also pass. Physical
Intel hardware remains unverified. The evaluation consumer checks 722 packages
and 79,363 files against public archives with zero mismatches. A separate normal
ARM native-build reproducibility diagnostic retains differing generated bytes;
that failed proof supplies no qualification evidence.

The freeze manifest digest is
`3ec8199c8a933fb887920cfab60e4c6883fee04874b823b20d0413609b3638b7`.
All 1,847 Product fixture tests, harness typecheck, full build and recursive
typecheck pass on the corrected source. That commit has 53 successful CI checks,
two skips, Greptile 5/5 and no open findings on #14956. Later documentation heads
still require their own CI and review. The superseded owned Product controller
is verified absent after all its processes retire. A new controller prepares the
frozen corrected packages, companion and browser environment without provider
credentials. Its free admission and exact live restart measurement remain open.
No paid attempts run during this rebuild; the new counts remain 0/26 and 0/7.

The retained `0cff2b20b` set has Product 1/26 and Runner 3/7 passes. Its corrected
memory case writes exactly 33 bytes with LF, durably saves them and reads them
from a fresh task after server restart. Runner context, context-before-action
and document creation pass. The finish-task case applies exactly one successful
task mutation but never reaches a terminal turn before its unchanged 120-second
deadline. Read-only provider metadata shows the post-mutation stream cancelled
without a finish reason near that deadline. Its cause remains unproven. The
corrected Linux restart retains its
pending request and accepts the exact browser answer, but still fails terminal
evidence and canonical cleanup. Its new closed diagnostic is
`unwatched_directory`; all observed runner processes have retired. Independent
cleanup proves the child sandbox, controller process and temporary root absent.
Neither failure is regraded or retried unchanged.

Two zero-model Linux controls identify a concrete housekeeping defect. Restaging
the same launcher bytes creates temporary upload locks outside the excluded
runtime and reproduces `unwatched_directory` with 22 workspace mutations. A Git
command creates the same failure with five mutations. Both processes retire.
With the correction, the unchanged actual Linux observer returns complete
terminal evidence for both controls; launcher bytes and user files stay intact.
All 35 affected Linux lifecycle and launcher tests pass, including the real
watcher regression and its outside-runtime negative control. All 60 affected
Mac launcher, credential and native-session lifecycle tests pass; the Linux
inotify regression is platform-specific. Shared and adapter-utils compile.
This proves the correction, not the cause of an unrecorded path in an older
failure. A fresh live restart measurement is still required after the rebuild.

The old-set Linux build and recursive typecheck pass. Its full test command
retains 15,076 passes, 57 skips and one disk-reserve failure. Removing only the
unused owned pnpm download store restores space without changing installed
files, source or assertions. The failed test then passes, and the canonical
full test command runs again with its unchanged 90-minute deadline. The owned
sandbox retention covers that command; host settings and unrelated services
remain untouched. Latest-head checks and the complete commands must also pass
for the newly committed source. Keep all old results as historical evidence.

No paid attempt runs during this correction. The last provisional dedicated-key
accounting is $0.34323782 used of its $5 lifetime cap. The signed-in default
workspace still has 72 unconfigured BYOK providers. Keep the approved $100
campaign cap, frozen model, low thinking and zero automatic paid retries.
Rollout remains held. Do not merge or release.

## Historical rebuilt candidate and exact write arguments — 2026-10-06

Shipping source is now `0cff2b20b5ea785880ad119dde59e6f011a3f9e1`.
All 18 public workspace tarballs are freshly packed from that source. The Linux
image is `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:f8cfc51909edbc728063e815a2c81ce9169ab58784d1f7c26f7a9f422b3f718f`.
Anonymous pull, source labels, immutable Daytona import and normal Linux npm
installation, Pi setup and admission pass. Its owned admission sandbox is deleted.
Normal npm lifecycle installation, Pi setup and admission also pass on ARM Mac
and with x64 Node under Rosetta on ARM Mac. The latter proves the Intel package
path under emulation; it is not a physical Intel hardware test.

Pi native definition v15 is
`d4fdf90fbed8741f53f2cbea921ef1b86d181f63f00c10beb999cf40f2e43578`.
The memory prompt now supplies native write arguments directly. Only the
AGENT_HOME path prefix may change; content keeps its JSON newline escape.
The exact 33-byte/LF grade, one write/read, cross-root denial, fresh-task readback,
deadlines and zero automatic retries remain unchanged. The failed live input
was not retained, so the prompt correction still needs a new live measurement.
Free installed Pi parser/agent-loop/permission/native-tool calibration takes the
new argument object: 33 bytes stay 33 and the 32-byte negative still fails.

All 1,847 Product E2E fixture tests across 93 files and harness typecheck pass.
The first broad run retains one failure in an existing Copilot fixture: its
compound prohibition on publication and attachment triggered the production
delivery gate. Separate prohibitions fix the fixture; a requested attachment
still triggers that same gate. Copilot definitions advance to v9 and remain
pending. No production delivery rule or qualification grader changes.

Build and recursive typecheck pass at the shipping source. Fixture head
`6c09e4c87` has 53 successful GitHub checks, two skips, Greptile 5/5 and no
unresolved review threads. The first full local workspace run retains 15,042
passes, 87 skips and five plugin auto-build failures. Its launcher globally set
`PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD=1`. Removing that test-environment flag makes
all 11 affected tests pass with unchanged source and assertions. The corrected
full `pnpm test:run` child reaches terminal failure after its launcher was
interrupted: 12,920 passes, 2,210 skips, four failed tests and 36 failed files.
The terminal log and process retirement are retained separately from its stale
launcher receipt. PostgreSQL startup failures account for many failed hooks;
three other tests fail on timing/socket recovery. Read-only inspection finds all
32 host shared-memory slots occupied. A separate owned bootstrap probe passes,
so resource pressure is not an established cause of every failure. Host settings
and unrelated services remain untouched. A separate native Linux full check
starts only after Mac retirement, using the frozen image, exact private dependency
lock and Rust 1.97.0. Its initial missing-header and header-permission failures
remain retained. Installing all 2,810 matching official Node development headers
in the owned test sandbox leaves Node bytes unchanged. The canonical build,
typecheck and full tests now run there with unchanged source and assertions.
Fixture-only edits do not change package or image build inputs.

The fresh Linux controller passes installed CLI startup, health and browser
checks. Its exact consumer graph checks 722 packages and 101,216 files; its plugin
graph checks 191 packages and 16,365 files. Both have zero mismatches. The real
observer calibration keeps the absent-parent and old inside-memory scratch
controls failed. Seeded memory, native sync and corrected outside-memory fallback
have complete terminal evidence and retired processes. All native memory writes
retain 33 bytes and LF. The current browser POST has the same complete native
argument object, public parent setup leaves the target absent, and owned cleanup
passes. Fixture checks and collection of all 26 Product cases pass. The failed
browser helper path and subsequent write-once log collision remain retained;
the corrected free phase reuses its already passing graph and observer controls.

Private Runner definitions are now `dc97fdcbef5de3ea061bc1f0a3b68af6e617f0bc`
in draft [Evals PR #44](https://github.com/paperclipai/paperclip-evals/pull/44).
They bind native profile 15 and its platform closure digests. All 76 admission,
roster and campaign tests pass with supported Python. All seven requests pass the
actual installed CLI checks before provider construction; profile 14 is still
rejected there. The normal Runner tar matches all 1,330 compiled files in the
frozen installed server. Case and roster hashes, scoring function bodies, model,
low thinking and limits are unchanged. The final correction names the matching
profile 15 pack in the run guide. Latest-head CI passes, Greptile gives 5/5 and
the guide finding is resolved. These free checks do not qualify a model.
No new paid attempts have run. Current qualified counts remain Product 0/26 and
Runner 0/7. Keep rollout held for the live newline/restart proof, all 33 cases,
complete checks and prerequisite review. Do not merge or release.

## Restart transfer correction — 2026-10-06

The current source changes shipping inputs. The `f5024863e` packages and image
remain historical evidence; rebuild and freeze a new set before any live
qualification. No new paid attempt has run. Current qualified counts remain
Product 0/26 and Runner 0/7.

A credential-free regression reproduces the fallback restore defect after
controller recovery: file bytes survive, but transfer creates a reserved
`.paperclip-runtime/agent-files` directory inside native `AGENT_HOME`. The
product's complete agent-directory probe rejects that directory. Transfer
scratch now lives in the original materialization's host runtime area, outside
native memory. Both staging and recovery use the same lease-confined path.
Owned cleanup removes that path with the corresponding agent copy. The strict
probe, byte checks and qualification graders are unchanged. The actual fallback
regression fails before this correction and passes afterward. This identifies
a product defect and matches the prior Linux watch calibration; it does not
regrade or identify the missing reason in the original v13 restart receipt.

A stronger free byte calibration exercises the installed OpenRouter stream
parser, Pi agent loop, real RPC serializer, permission extension/bridge and
native write/read. A synthetic response split at every argument character
preserves 33 bytes and LF through each boundary. Its 32-byte negative control
stays 32 bytes and fails the exact grade. It makes no network requests or model
calls and does not qualify the model. The retained Mac and Linux run logs have
no native argument fields, so neither failed live input's byte count is known.
The earlier statement below about 33-byte native input is corrected to describe
the task specification. A live newline correction is still required.

The initial database tests could not start because the owned dependency copy
omitted its pinned Postgres package's library-symlink postinstall. Restoring its
17 declared links fixes `initdb --version`; no binary, host setting, unrelated
service or shipping dependency changes. Preserve the failed test logs. Keep
rollout held until the new package/image set, all 33 cases, platform installs,
full checks and prerequisite reviews pass. No merge or release is authorized.

All 92 memory/probe/cleanup tests and 146 sandbox transport controls pass.
Adapter-utils and server typechecks pass. Broad transport discovery also ran
stale compiled tests from `dist/`; its failures remain retained. The canonical
stable runner excludes `**/dist/**`. The source-only run has 1,421 passes,
11 skips and one crash-helper failure. Its helper launched the holder through
the `tsx` CLI. Direct Node with an imported loader binds SIGKILL and exit to
the actual holder; all 12 lock controls then pass. The original broad failures
remain retained. A complete rerun on the final source is still required.
New-head CI, full build/typecheck/tests and new distribution proof remain open.

## Case corrections — 2026-10-05

The historical profile-14 proofs are **28/33: Product 21/26 and
Runner 7/7**. They do not qualify the current profile-15 runtime. The two corrected
Runner prompts pass at private definitions revision `7b112ffe3` with unchanged
graders, one attempt per correction and zero automatic retries. Their original
failures remain retained. The Mac file-edit correction also passes.

### Current fixture corrections and remaining failures — 2026-10-05

Shipping runtime remains `f5024863e`; these changes affect only fixtures and
documentation. Pi native definition v14 is
`8a93306b6df0008ff10b5398049fad7b4bfa7a7cbf4f4ee0dedfe76eed6f0111`.
The model, profile 15, low thinking, byte grades, deadlines and automatic retry
count remain unchanged. All 693 Pi fixture tests across 20 files and the final
harness typecheck pass.

The diagnostic-storage regression also reproduces a review finding: a failed
diagnostic write replaced the original incomplete-terminal error. Both the main
flow and cleanup now preserve that original error. Failed diagnostic writes
remain eligible for another save during cleanup. Successful saves stay unique.
The regression fails before the correction and passes afterward; this evidence
fix does not authorize a paid retry.

The two explicit v13 attempts at harness `b3318d6be` remain failed. Restart
retains the original question, run, turn, session and producer and accepts the
exact browser answer. Its provider run succeeds, but the observer is incomplete
and canonical cleanup fails after lease release. The memory attempt also
completes its provider turn. Its retained public managed-file response has
32 bytes without LF, so the exact 33-byte assertion fails before the fresh
task. Its observer and canonical cleanup also fail. Both evidence manifests
have no missing files or reported leaks. Independent cleanup verifies both
owned child sandboxes absent. Original grades and receipt hashes are unchanged.

The observer now retains bounded, closed failure reasons. A valid terminal
receipt can close the observer without a second RPC after lease release only
when it proves captured processes retired and has complete evidence or known
filesystem-watch failures. Unknown causes, reused process identities and live
attached processes still require cleanup proof. An incomplete filesystem
receipt still fails qualification and cannot supply qualified file bytes.
The released-lease regression fails before this correction and passes afterward.

Before memory-task admission, the fixture uses the public managed-file API to
create `memory/.pi-e2e-parent.txt`. The actual memory target remains absent.
Both turns must preserve the setup file. This avoids a new directory racing
strict watcher installation. Actual Linux observer calibration reproduces the
failure with an absent parent and passes with the seeded parent. Installed Pi
native write preserves 33 bytes in both controls. Generic transfer scratch
creation also reproduces an unwatched-directory failure; native sync avoids it.
This supports a restart-path hypothesis, but the v13 receipt does not identify
the actual restart cause. No speculative shipping correction is made.

Normal installed Mac startup, the public parent API and actual browser prompt
submission now pass with zero model calls and cleanup passing. The submitted
JSON content contains all 33 bytes, including LF. The initial Mac startup
failure remains recorded: shared-memory capacity was exhausted. Capacity later
freed without host setting changes or stopping unrelated services. The Linux
parent API check also passes; its combined auxiliary browser probe remains
failed because it selected an unavailable browser cache. Earlier installed
Linux browser proof remains a separate passing receipt.

The live v13 memory tool input is unavailable after owned temporary-root
cleanup. The saved 32-byte file does not prove whether the model omitted LF or
a product boundary removed it. Parent setup and cleanup corrections do not
address that byte failure and do not permit an unchanged paid memory retry.
Keep both live cases held until a concrete correction addresses the observed
failure. Then run one explicit attempt per correction, with zero automatic
retries. Fresh full Product 26/26 and Runner 7/7 proof, Intel installation,
complete workspace tests, latest-head CI/review and prerequisite disposition
remain required. Current-runtime qualified counts remain zero.

Final read-only key accounting observes $0.324966594 used, $4.675033406 remaining,
zero BYOK usage and the unchanged $5 lifetime cap without reset. Billing remains
provisional. The $100 campaign ceiling and no-merge/no-release instruction remain.

### Prior v13 boundary corrections — 2026-10-05

The next fixture correction preserves the same `f5024863e` shipping inputs.
The observer now accepts a directory notification only for the same device/inode
with an already registered recursive watch; every event still counts. An actual
generated-observer regression fails before the correction and passes afterward,
including nested transient writes. New directories, replacement inodes, symlinks,
unknown notifications, and recycled process identities remain failures.
This reproduces a fixture defect, but does not identify the missing original
restart terminal snapshot's exact cause. A corrected live result is still needed.

Pi native definition v13 removes the competing bare nonce from the memory
instructions. Its sole JSON content specification still decodes to 33 bytes with
one final LF. Frozen native parser/validator/write/read preserve those bytes
without provider calls. The failed run's task specification contained 33 bytes;
its native input was not retained. Its native read returned 32; original managed
content was not captured. No byte
conversion was found in the wrapper or public file API. The prompt correction
addresses a copying ambiguity; it does not establish a product byte-loss cause.
The missing-LF negative control and exact saved/readback assertions stay in place.
All 207 focused fixture regressions and the harness typecheck pass. One unrelated
Copilot bootstrap prompt assertion remains a preserved failure in the broader
support run. The affected live cases remain pending until their new receipts close.

Current shipping artifacts are bound to `f5024863e9ed014e2661e6d7f23fc0e6b32e0911`
and profile 15. The normal public ARM graph verifies 722 packages and 79,373
files with zero mismatches. Full build and recursive typecheck pass. Normal
Linux public install, companion import, native admission and browser startup
pass against immutable image
`ghcr.io/paperclipai/paperclip-daytona-runner@sha256:20c7fffddeee4298830ead1ea3f0b70819f61e549279588b605440d1155f7260`.
Its controller passes 342 fixture checks, 21 native fault checks and collection
of all 26 Product cells with zero model calls. An installed-UI intercepted POST
proves one fenced prompt with valid JSON, all 33 content bytes and no duplicate.

The canonical-root Mac attempt uses shipping runtime `f5024863e` and harness
`df748c997`; the recorded diff contains only fixture infrastructure and the plan.
The provider now completes its first turn and writes to the correct native
agent directory. Its native read returns the 32-character nonce without LF.
The exact managed-byte assertion fails; canonical cleanup passes. The public
description independently contains one valid JSON content value of 33 bytes.
The original managed-file response was not retained before that assertion, so
its exact returned bytes cannot be claimed from the saved evidence. A free
check of the frozen Pi JSON parser, argument validator, native write and native
read preserves all 33 bytes. There is no proven byte-trimming product defect.
Do not weaken the byte grade, add a newline in the product, or repeat this paid
attempt without a concrete correction.

The next Linux restart attempt retains the same native request, turn, run,
session and producer across controller restart and accepts the exact browser
answer. The original run succeeds. Its independent observer returns incomplete
terminal evidence; canonical cleanup also fails after public lease release.
Both owned child and controller are separately verified absent, and the active
campaign claim is closed. The canonical result stays failed. The missing
incomplete receipt prevents a precise observer-cause attribution; do not claim
that public run success proves the final independent file or cleanup grades.
The initial controller preparation also fails before provider calls because
consumer and plugin shared-package archives collide by basename. Separating
their staging namespaces fixes preparation with every archive digest unchanged.

The fixture now records the managed-file response before grading and retains a
closed, validated summary of an incomplete terminal receipt before rethrowing.
It omits raw RPC content and file bodies. A missing-LF regression fails before
the capture-order correction and still fails the byte grade afterward while
retaining the response. These are evidence-only changes; no runtime input,
model, timeout, assertion or original result changes. They do not justify a
paid rerun solely to collect diagnostics.
All 207 affected fixture tests pass with filesystem-watch access, and the
harness typecheck passes. The initial sandbox run retains three failed watch
observations; it is not reported as a passing run.

At `df748c997`, 53 CI checks pass with two skips. This is source-bound CI, not
proof for a later evidence-only commit. Current-source live qualification is
still incomplete: neither failed attempt qualifies its case, and historical
profile-14 or earlier profile-15 passes cannot certify this runtime. Review and
the complete workspace unit command remain held. Last read-only dedicated-key
usage is $0.319832563 against its $5 lifetime cap; the immediate restart delta
of $0.000785504 is provisional. No merge or release is authorized.

The next explicit Mac attempt at `f5024863e` confirms that the description is
no longer duplicated, but still times out with cleanup passing. Its runtime
context advertises `/tmp/.../live`, while the native Pi grant binds the physical
`/private/tmp/.../live` directory. The fixture now canonicalizes its owned temp
root before configuring the instance and validates cleanup against that same
physical parent. A symlink-ancestor regression fails before the change. The
normal installed Pi policy rejects the old advertised alias, accepts the
corrected physical root, and continues to deny an unrelated root, with zero
model calls. The byte and timeout assertions remain unchanged. This correction
only changes the harness; shipping runtime artifacts remain `f5024863e`.

The explicit version-12 Mac memory attempt at `867fa4711` still times out
at the unchanged native-session limit; cleanup passes. Its valid fenced JSON
arrives in a duplicated description: the Markdown paste capture inserts the
parsed content, then Lexical inserts the same plain text. The editor now stops
that handled paste before it reaches the inner editor. A regression fails on
the old propagation, and all 51 editor tests pass after the fix, including an
ordinary-text paste control. The token gates pass. This is a new shipping input;
the previous image and live result remain bound to `867fa4711`, and neither
is qualification of the corrected editor. No paid retry is justified until a
zero-model browser check verifies one submitted prompt with intact JSON bytes.

Normal public installs of runtime `b012b3aebe` admit profile 15 on Mac ARM,
Mac Intel (through Rosetta), and native Linux. The native Linux image is
`sha256:3279d92405a59b4654cb6af5de27bfacffee73a2c57311bf5f2d5ff9272b9b67`.
The corrected remote provider-death case passes all six matchers and cleanup;
the native-questions case passes all 16 matchers and cleanup. These two passes
are source-bound evidence, not qualification of the whole shipping roster.

The next Mac memory attempt fails at the unchanged 120-second native-session
limit, with cleanup passing. Its public description contains invalid JSON:
the shared issue validator converts the fenced content's literal `\\n` into a
real newline. Browser `.fill()` also exports an escaped paragraph instead of
a Markdown code fence. A credential-free actual installed-UI probe reproduces
that second boundary and confirms that Markdown paste retains the valid JSON
and all 33 content bytes. Both task submissions are intercepted, so neither
can create provider work. The shared validator now preserves real multiline
bodies; legacy single-line self-escaped descriptions retain their recovery.
The exact old/new validator proof fails before and preserves 33 bytes afterward.
All 837 shared tests pass using the canonical `/private/tmp` directory.

The next remote restart attempt fails during controller process cleanup with
`Owned process group identity became uncertain`, before any replacement
controller starts. Its independently observed remote run retirement passes;
canonical cleanup remains failed. The exact owned child sandbox is separately
deleted and verified absent. A regression reproduces rejection of a replacement
group member whose ancestry still belongs to a separately validated owner.
Cleanup now admits only that proven ancestry; recycled groups and mixed live
ownership still fail before signaling. All 31 ownership/restart tests pass,
including a negative control for a recycled controller ancestry anchor.
This addresses a reproducible cleanup condition; the original failure lacks
the process table needed to attribute its exact uncertain group.

`pi-native` definition version 12 records the prompt transport and cleanup
changes. The nonce-plus-LF, cross-root denial, fresh-task persistence, native
request identity, and deadline assertions are unchanged. Fresh installed
artifacts and explicit corrected live attempts remain required. The previous
`5a23ef659` head's 53 CI checks pass with two skips; this is not CI proof for
the new boundary changes. No merge or release is authorized.

The provider-death fixture now admits the production runner's stable symlink
while still checking the resolved bytes, live Node inode and exact Pi-child
pidfd. All 21 Linux fault tests and 297 Linux fixture checks pass. The next live
attempt signals the correct Pi child and passes cleanup, but exposes a runtime
bug: its provider-loss expiry creates a durable question fallback that the
server mistakes for successful yielded completion.

The runtime correction preserves that fallback while preventing governed-wait
settlement after provider loss. The Runner emits `turn.failed` for the lost
provider instead of `turn.interrupted`. The regression fails before the fix;
169 Runner tests and all 574 native-server tests pass afterward. This changes
shipping runtime inputs. Existing `0bd040093` artifacts and paid passes do not
qualify the corrected runtime; fresh public artifacts and source-bound live
qualification remain required.

The memory prompt now states its nonce-plus-final-LF contract in plain text and
bounds the native write/read sequence. A free call to the frozen Pi tools
retains all 33 bytes, including the LF. The corrected local live attempt still
times out after native policy rejects paths outside the assigned roots.
Cleanup passes. Both failed corrected local attempts remain failed; the memory
case is not qualified. No byte assertion, timeout, model or permission boundary
is relaxed. Production remains held; no merge or release is authorized.

The corrected Linux native-questions attempt delivers the first three typed
answers, then its editor call fails with `Pi question has unsupported fields`.
The original schema advertises fields that the selected method cannot accept.
The schema correction separates the four method contracts while retaining
strict handler validation. All 37 Pi extension tests pass. A credential-free
calibration proves that the installed old schema accepts an editor placeholder
that its handler rejects, while the corrected schema rejects that input before
execution. This correction also requires fresh runtime artifact qualification.

The corrected Linux controller-restart attempt preserves the original pending
question and accepts the actual browser answer, then fails with
`native_remote_recovery_lease_mismatch`. Recovery was acquiring another sandbox
under the admitted ephemeral lease policy. The source correction reads and
validates the original active lease before any provider acquisition, retaining
the downstream process-generation and authenticated PRP identity checks.
The focused recovery suite passes 630 tests and the source-bound server
typecheck passes. The canonical cleanup failure remains failed; a separate
owned-resource check confirms the original sandbox is absent.

The ordered local memory attempt reaches its registered directory and records
the expected cross-root denial, but completion rejects personal memory as an
unpublished file. Its qualifier was separated from the write by another
sentence, and its denial wording did not match the existing internal-file
rule. The fixture correction places the qualifier immediately after the write,
uses the recognized native-denial instruction, supplies a fenced JSON content
value with the final LF, and names the required objective `evidenceRefs` field.
The installed frozen server's free classifier check rejects the original
prompt, accepts this correction, and still requires publication of a separate
requested report. This failed attempt stays failed. All five remaining cells
and qualification of the new shipping artifacts remain outstanding.

The first new Linux image build fails closed at the unchanged profile-14
closure pin because the question extension changed. The profile-15 declaration
now binds that exact extension and all three regenerated platform closure pins.
Each regeneration verifies the retained manifest against its independent
profile-14 source pin and changes only the extension entry; actual new normal
installation on all three platforms remains required. The historical profile
fixtures remain intact. Profile 14 results cannot qualify profile 15. Pi 1.0.0,
pi-acp 0.0.33, ACPX 0.13.1, Node 24.21.0, the model and native low do not change.

The first normal profile-15 ARM/Linux admission probes reject the descriptor
before any prompt: Rust still binds profile 14 while TypeScript sends profile
15. Those failed artifact proofs remain failed; the owned Linux admission
sandbox is deleted. The correction synchronizes Rust admission and its current
fixtures, adds a published-identity regression that fails before the correction,
and retains explicit rejection of profile 14. The remote-memory unit fixture
now parses the fenced JSON and independently checks all 33 bytes. Full build
and recursive typecheck pass at the prior source; new artifacts and all live
qualification remain required after this binding correction.

The source-bound `b012b3aeb` artifacts now pass normal public profile-15
admission on ARM Mac (8.618 seconds) and native Linux (8.498 seconds). The new
immutable image is
`ghcr.io/paperclipai/paperclip-daytona-runner@sha256:3279d92405a59b4654cb6af5de27bfacffee73a2c57311bf5f2d5ff9272b9b67`.
Anonymous pull, source identity, normal companion import, and Linux installed
server health/browser startup pass with zero provider calls. The temporary
image-admission sandbox is deleted. The Linux qualification controller remains
owned and bounded. Mac installed server startup fails before a model call;
its stderr-free database failure is still unexplained, and a fresh direct
initdb probe succeeds. Intel admission and fresh live qualification remain
outstanding.

Current-head CI exposes two fixture races. The lease test constructs a second
timestamped fixture instead of comparing with the saved lease; all 37 tests
pass after retaining that fixture. A GitHub callback fixture reproduces its
failure when the root finishes before callback replay. Waiting for durable
admission and draining the subsequently scheduled work makes both orderings
pass without changing production worker code, assertions, or timeouts. These
test-only changes do not relabel the frozen runtime artifacts. Their new head
requires fresh CI. The prior full local test command remains failed; complete
local tests and release review are still required.

## Frozen target

- Pi: `@earendil-works/pi-coding-agent@1.0.0`.
- Wrapper: `pi-acp@0.0.33`; ACPX: `0.13.1`; Node: `24.21.0`.
- Current candidate: Pi profile 18. Historical profiles through 17 remain
  decodable; only the exact current profile can launch.
- Current wrapper cancellation preserves partial usage and suppresses service
  failure metadata for an acknowledged cancelled terminal. Ordinary failures
  remain failures. Copilot profile 16 and Cursor profile 15 remain unchanged.
- Fixture model: `openrouter/deepseek/deepseek-v4-flash-0731`, native-confirmed
  low thinking. Production models remain caller-selected, without fallback.
- Record exact source, definitions, installed package graph, daemon, image,
  environment, cleanup and cost evidence for each attempt.

## Release gates

The qualification table at the top of this document is authoritative. The
profile-18 candidate requires new normal Linux installation, all 26 Product
cells and seven Runner cases, exact-head CI/review and a matching cloud image.
Retained older results are historical. They do not authorize launching or
qualifying an older profile. Read-only key usage at 2026-10-07 17:44 UTC is
$0.471827388 of $5, with no reset or BYOK usage; snapshots remain provisional.
All 73 visible BYOK provider rows are unconfigured. No merge, release or rollout
is authorized. The cloud builds use GitHub hosted Linux and an isolated Linux
package-build sandbox; Docker does not run on the developer Mac.

## Bounded execution

Run one explicit failed lifecycle cell after a specific source correction, with
zero automatic retries. Keep each failed attempt, its machine grade and its
cause. Do not regrade a failed attempt as a pass or rerun an unchanged failure.
After restart and warm continuity pass, run the remaining exact cells against
the fixed candidate. Use the canonical Product E2E and Runner report pipelines.

Pi paid qualification uses the existing dedicated OpenRouter key with a $5
lifetime credit limit. Do not reset the limit or fall back to an account key.
Check remaining credit and that BYOK usage stays zero before and after each
attempt. API key deltas are provisional billing observations. Pi model-catalog
prices are estimates. Unpriced usage must stay unpriced in the ledger and UI.

## Historical qualification snapshot — 2026-10-05, before corrected passes

This retained snapshot predates the completed corrections reported above.
At that point all 33 required cells were attempted: **25 pass and eight fail**, with none running or unattempted.
Product has 20 passes and six failures; Runner has five passes and two failures.
Remaining failures are local agent-files and file-edit; Daytona native questions,
agent-files, native controller restart and provider death; and Runner
context-before-action and finish-task. Preserve every original grade and source.

The corrected Daytona file-edit attempt at harness `baaf444ed` passes all seven
matchers and canonical cleanup on extended definitions 3. Native identity proves
profile 14, the frozen model and effective low thinking. Its child sandbox is
verified absent, all four controller commands are terminal, the uploaded key
file is absent and the owned controller is deleted. Its corrected free preflight
passes 297 fixture tests, including 17 native Linux fault cases, and all 13
browser-case collections. The initial 296-pass/one-failure command stays failed.

The equivalent Mac correction is held before paid dispatch. Normal installed Pi
admission and 175 focused fixture tests pass. A complete audit verifies 101,216
consumer files and all 24,352 imported companion entries. Fresh installed server
startup fails. A separate owned `initdb` probe explicitly reports SysV
shared-memory exhaustion, with all 32 host slots in use. That probe does not
retrospectively classify the earlier stderr-free failure. Use a Mac with capacity
for a fresh owned database. Do not repeat unchanged startup, delete shared
resources, change host limits or stop unrelated servers. No paid Mac correction
attempt has been dispatched.

A network-blocked native Pi/Runner calibration uses one fixed loopback response
and zero real model calls. It reaches the unanswered `elicitation/create`
question with matching thread/turn/request bindings. The unchanged observer
signals only the exact Pi child through pidfd and seals complete retirement
without target effects. All 15 scoped strict checks pass. Its synthetic
controller records `runner did not durably suspend before checkpoint` on close;
production qualification and paid retry remain held. Two earlier calibrations
fail to reach the question and remain failed. The first wrapper's premature
success label is corrected by its strict verdict. All three owned sandboxes are
deleted. The original paid rejection stage remains unproven.

Prerequisite fixes preserve every previous commit. The latest heads are
#14921 `7f452cbd7`, #14922 `b7e692f48`, #14923 `cca38f29a`, and #14924
`c2e2e39db`. They carry the scoped UI/profile assertions and notice-display
corrections. The first prerequisite also receives the existing package-local
Runner probe import repair and remaining admission assertions already present
downstream. The complete repair includes both public probe export surfaces.
At `89f444850`, all 91 affected server tests and 75 sidecar tests pass, and
the complete Runner TypeScript package typechecks. A real, unmocked shim import
verifies all three probe function identities without invoking any probes.
The later ancestry merges retain identical tracked source trees to the
`0a3f265c3`/`30410cf2b`/`26802337c` 166-test proofs. No provider calls occur. The earlier
`f8bbeeb4c`/`c057c5746`/`78b02e6ba` heads pass 42 focused UI/live tests each;
`cee5c3fc6` passes 92. Their previous source-bound UI token checks pass. Retain
those source labels. Earlier commands with stale linked builds, incomplete
verification aliases, an incorrect config path, or a missing child Node path
remain failed or insufficient evidence. The corrected private verification uses
exact source aliases and the pinned Node directory; no repository configuration
changes occur.

The preceding readiness integration `146f578c0` completes 53 successful CI
checks, two skips and a current-head 5/5 review. The new additive integration
changes only the six scoped installer/fixture/documentation files before this
plan update. The preceding `aef3b84ce` completes 53 successful
CI checks and two skips after one bounded rerun of the serialized sidebar job.
All six sidebar tests also pass locally. The original HTTP 500 cause remains
unproven; the failed log is retained. The earliest prerequisite's original
signoff-policy browser failure is separate: its issue-bound heartbeat run does
not become available. The intervening `337ca6bd1` CI retains a hosted-runner shutdown/cancellation
and a ten-second timeout in an unchanged Cursor fixture. All five current-source
Cursor tests pass locally; the original timeout cause remains unproven. The
partial import repair at `32b5e275d` also retains its three missing-export build
errors; the complete repair above supplies those exports. New-head CI and review
require their own terminal results. Old passes do not qualify a new head.
No repeated unchanged rerun is authorized.

Pi execution inputs, profile 14, model/low and suite fingerprints are unchanged.
The public installer is corrected separately below; original installation
artifacts do not become proof of the updated bytes.
The source still declares Pi qualified: the production hold is the draft/release
gate, not a closed code admission gate. That admission review remains open.
No GitHub PR merge, release, automatic paid retry, fallback key or model change
occurs.

## Public installer review corrections — 2026-10-05

The SDK fixture now derives the publication version from the actual SDK
manifest instead of pinning 0.3.1. Exact dependency identity, byte seals,
canonical roots and all existing ambient-Node negative fixtures stay enforced.

The explicit CLI setup child and its bundled provisioner now preserve the same
closed allowlist: `PATH`, fixed `LANG`, optional `LC_ALL`, `HTTP_PROXY`,
`HTTPS_PROXY`, `NO_PROXY`, their lowercase equivalents, `SSL_CERT_FILE`, `SSL_CERT_DIR` and
`NODE_EXTRA_CA_CERTS`. The CLI enables Node's environment proxy handling before
the helper starts. Provider keys, `HOME`, npm configuration, `NODE_OPTIONS`,
`NODE_PATH` and TLS-validation bypass remain excluded. These settings apply to
explicit public downloads; the Pi execution closure and profile do not change.

At prerequisite #14922 `fcef1eae9`, six CLI tests, eight installed-plugin tests
and two bundled boundary tests pass with zero provider calls/downloads. The
real CLI child verifies proxy activation and credential exclusion. The actual
bundled provisioner verifies its post-sanitization environment and rejects a
corrupt cache with network/child creation denied. At #14924 `5120ddc8f`, all
18 focused checks pass, including the two pre-existing ambient-Node negative
fixtures. The corrections are forwarded through additive merges. An initially
over-broad SDK whole-file equality guard is retained as a local verification
failure; the exact correction delta and preserved negative tests then pass.
Local missing-Commander and incomplete Product source-alias setup failures are
retained separately; no repository test configuration changes occur.

Fresh review at `5120ddc8f` identifies omitted lowercase proxies. The scoped
follow-up at #14922 `b7e692f48` preserves `http_proxy`, `https_proxy` and
`no_proxy` through the CLI, provisioner and npm-download allowlists. All seven
CLI tests, eight SDK fixtures and two bundled checks pass there. Additive merges
preserve the later prerequisites' distinct runtime/build pins; their bundled
checks also pass. The overly broad whole-materializer equality guard remains a
local verification failure; exact six-file correction deltas pass afterward.

A separate loopback-only calibration at #14924 `c2e2e39db` exercises the actual
bundled CLI and generated provisioner. Without its owned custom CA, the TLS
certificate is rejected before any archive request. With that CA, lowercase
proxies carry exactly one GET for the pinned Node archive; the owned endpoint
returns a deliberate 503 before any package is installed. Both children retire,
setup staging/locks disappear, the owned proxy/certificate fixture is removed
and no outside networking, real credentials or model calls occur. This is a
limited setup-boundary calibration with a private egress-denial prefix, not a
normal public artifact/install proof. The two earlier private calibration
startup failures remain retained after their shebang/guard repairs.

Normal updated CLI/server tar installation and setup on ARM Mac, Intel Mac and
Linux remain required before releasing these installer bytes. Original
`0bd040093` artifacts and all 33 paid grades retain their exact source labels.
Current production results remain 25 passes and eight failures. No paid retry,
model/profile change, lockfile edit, workflow edit, merge or release occurs.

## Accepted corrections — 2026-10-04

The operator accepts the scoped Product E2E fixture corrections and authorizes
necessary corrected attempts within the existing approved campaign limit.
The dedicated Pi key retains its existing lifetime cap. Automatic paid retries,
fallback keys, new models, GitHub Actions edits and lockfile commits remain
excluded. The previously rejected SDK-corrected attempt remains undispatched
and preserved; the new authorization applies to a separate explicit phase.

The canonical-closure fixture correction is committed at `585b43d3a`. All 14
native Linux fault tests pass, including ownership/pidfd and malformed metadata
calibration. That head has 53 successful CI checks, two expected skips and no
unresolved root review findings. These free checks do not qualify provider death.

A fresh owned Linux controller passes normal public installation, normal Pi
setup and admission in 7.207 seconds. Installed startup passes health/UI with
zero companies and cleanup. Complete audits pass 101,226 consumer files and
16,356 plugin files. All 13 Daytona browser cases collect, and the pinned SDK
constructor passes without credentials or provider calls. The two expired
controllers remain absent. The rejected 30 GiB allocation created no sandbox;
the prepared controller uses the account's 10 GiB limit and a finite lifetime.

The restrictive fixture correction approves only the exact published setup-file
read through the public operator API after observer arming. It retains the
completed read, resolution and unchanged file hash. All tested write permissions,
Stop/steering/denial assertions and retirement/no-effect proofs remain required.
Controls definitions advance to 7 and native definitions to 5. Prior attempt
fingerprints and grades remain unchanged. All 112 targeted native Linux tests
pass, including positive Stop/steering settlement and negative setup approvals.
The browser selectors require exactly one visible card with a pending decline
button, allowing the resolved setup-read receipt to remain in the transcript.
Two actionable cards still fail before any control or denial is sent; the
public native request and exact browser POST checks remain required.
The local pure oracle tests pass; the local ownership flows still fail their
unchanged file-watch completeness gate. Local Product typecheck is blocked by
stale dependency declarations in the existing linked build. Fresh CI must verify
the committed head. Live proof on the new definitions is still required.

Head `e22a8dfb7` completes 50 successful checks and two skips, while the browser
aggregate/shard and Greptile checks fail. Greptile identifies the resolved setup
card count corrected above. The separate agent-run retry feedback test passes
unchanged in a retained credential-free native Linux browser trace against the
installed frozen server. Its CI failure remains preserved; this diagnostic does
not establish its cause or make the failed CI check pass.

Private receipts retain credential and provisional spend checks. Paid dispatch
requires fresh checks under the approved bounded execution phase. No paid
provider attempt occurs during this resumed preparation.

## Corrected live attempts — 2026-10-05

The latest retained matrix has **24 passed cells and nine failed cells**, with
all 33 cells attempted and none running. The first four separately bounded live
attempts retain frozen shipping source
`0bd040093`, exact harness source `14c48ff40`, profile 14/model/low and zero
automatic retries. The original campaign, grades and receipts remain unchanged.
Human permission denial passes all nine canonical matchers and cleanup. Its
independent journal proves no target effect through exact provider retirement;
public native identity confirms the frozen model and low thinking.

Agent-files reaches successful native work and a durable managed-file save, but
the saved content lacks the required final newline. The exact-byte assertion
fails before fresh-task readback. Its cleanup separately fails on an expired
lease; the owned child sandbox is subsequently verified absent. Provider-death
reaches the unchanged unanswered native input but its one-shot fault returns an
incomplete observer response. Independent retirement and canonical cleanup
pass, while the case remains failed and expiry/stale-answer proof is unreached.
Neither case has an unchanged retry.

The corrected Stop attempt closes the exact permission under the operator's
Stop and rejects a stale response, but its cleanup oracle reports a process
identity change. Retained public responses show `processStartedAt` changing
between launch annotations for the same PID. All three independent Linux
snapshots instead retain the same PID, boot ID and start ticks; the final seal
has no live processes and a complete zero-mutation journal. The owned child
sandbox is deleted after evidence collection, without regrading failed cleanup.

The fixture correction uses the bound independent remote birth identity already
required by the remote oracle. Local process-authority checks remain intact.
Controls definitions advance to 8 and explicitly name PID/start-ticks/boot-ID
identity. Two timestamp-drift regressions fail before the correction and pass
afterward; actual remote birth rotation and local authority changes still fail.
All four new local regressions and nine selected remote flow tests pass without
provider calls. The synchronized fixture head `04f639eeb` passes all 116 targeted
native Linux tests and all 13 browser-case collections. One corrected Stop
attempt passes all five matchers and cleanup; the first steering attempt passes
all eight matchers and cleanup on controls definitions 8. Both retain the frozen
model, native-confirmed low thinking and original failure evidence. All six
resumed attempts are terminal, and their phases are retired. No further first
attempt remains. Every failed paid case still requires a concrete correction.

The owned Linux controller passes normal public installation, Pi admission in
6.949 seconds, complete 101,226-file consumer and 16,356-file plugin audits,
all 13 browser-case collections and 112 targeted free native Linux tests.
These preparation checks do not qualify a live behavior. Last verified root
head `4f2300d5b` has 53 successful checks, two skips, Greptile 5/5 and no open
root review threads; this fixture follow-up requires its own completed checks.
Prerequisite reviews/standalone CI and the remaining failed production gates
stay open. Rollout remains held; no merge or release occurs.

A later credential-free audit identifies another concrete fault-fixture
incompatibility. The production native bootstrap launches the wrapper through
its held executable FD 7 (or FD 3 without lifetime/credential fences). Linux
retains `/proc/self/fd/N` in its argv, while the fault helper requires the
physical snapshot Node pathname. The existing direct-path calibration misses
that launch form. A network-blocked native Linux regression rejects both actual
descriptor launches before the correction with `wrapper_parent`. The correction
requires the corresponding held descriptor and wrapper executable to match the
sealed snapshot Node inode, while retaining every other ownership check. All
17 fault tests pass afterward, including both real descriptor launches and
foreign/missing-descriptor negatives. The probe uses only synthetic owned
processes, no provider credentials or model calls, and its sandbox is deleted.
Native definitions advance from 5 to 6; their new fingerprint is
`6511c44fd0997ba56b8627d788d04d7e4924b8992b4c2a3085d5ee9aa56cd56b`.
The local helper/catalog tests pass. The broader local remote-observer suite
still fails its unchanged transient filesystem-watch test; its other 76 tests
pass. Preserve that failed command. This is a concrete fixture correction for a
separately bounded provider-death attempt after fresh preparation and guards;
no new paid attempt has occurred. The previous live error does not retain its
internal rejection stage, so complete live qualification remains unproven.
The retained production matrix stays 24 passes and nine failures. All six
earlier resumed attempts and their phases are terminal. Their controller and
child sandboxes are deleted with canonical evidence retained.

## Free fault calibration and file-prompt correction — 2026-10-05

Head `b224e4338` completes 53 successful checks and two skips, including the
full Linux build and typecheck, with Greptile 5/5 and no unresolved root review
threads. The separately guarded descriptor-corrected provider-death attempt is
terminal and failed: its unchanged native question appears, but the observer
returns incomplete evidence without a fault-signal receipt. Cleanup separately
fails on a closed observer socket. The third failed attempt, both prior failures
and their source fingerprints are retained. Its owned child and controller are
deleted after collection. The matrix remains **24 passes and nine failures**;
none are running or unattempted. Production remains held.

Four subsequent network-blocked Linux calibrations use no provider credentials
or model prompts. Both actual Pi-wrapper launches pass inspection: direct
held-FD launch and production lifetime fences. The real Rust Runner then admits
the frozen native model/low profile and passes exact child inspection. Finally,
the unchanged observer successfully performs its one-shot pidfd-bound Pi-child
fault and seals complete retirement. Every owned calibration sandbox is deleted.
These calibrations use a synthetic controller/lease caller and an idle provider;
they do not prove the paid pending-input journey, regrade that failure, establish
its missing rejection stage, or authorize an unchanged paid retry.

Both original file-edit attempts complete the exact edit, validation and public
artifact, then fail the required single-Bash-execution oracle after an additional
metadata command. The old prompt specifies an exact validation command but does
not explicitly forbid other Bash calls. The correction states exactly one Bash
call for the whole task and directs registration to use the supplied byte size
and hash after exact-byte validation. The grader remains unchanged. Negative
calibration rejects extra metadata executions both before and after validation,
even when file and download bytes are correct. Extended definitions advance
from 2 to 3; original paid attempts retain their definitions and failed grades.
Free fixture verification, exact-source Linux preparation and fresh spend guards
must complete before separately bounded corrected file-edit attempts. No paid
attempt occurs during this correction, and its live outcome is unproven.
Both focused file/catalog files pass all 103 local tests. The broader name
selection also includes an unchanged report-catalog test that fails on a missing
generated result; its failed command remains retained. Local Product typecheck
still fails on six stale linked Runner/adapter declarations. Fresh latest-head
CI must verify typecheck, tests and build before a PR-ready handoff. The new
extended-suite fingerprint is
`121f4cf75267bcdb003e5ed59e165755b2ac0c3d31c82dc217a62c8abe3d1b4d`.

The first expanded Linux preflight at `120eb7f01` passes 296 tests and fails
one cross-suite coverage assertion that still expects extended definitions 2.
Normal public install, Pi admission, startup, graph audits and all 13 browser
collections pass. Its failed test command is retained. The follow-up synchronizes
that assertion's version and fingerprint with definitions 3 without changing the
task or oracle. All three focused local files then pass 175 tests. The same owned
controller requires a separate corrected preflight before any paid dispatch.
Head `120eb7f01` completes 53 successful CI checks and two skips, with Greptile
5/5 and no unresolved root review threads. This test synchronization requires
fresh checks on its own head. No paid attempt occurs during either preparation.

## Qualification snapshot — 2026-10-03

The October 3 ledger has 21 passes, ten failed cells, two unattempted cells and
zero running cases across the required 26 Product and seven Runner gates.
The original failed warm attempt remains preserved. No production admission
is claimed. No automatic paid retry, fallback key, model change, workflow edit,
or lockfile commit occurs.

Normal installed Mac-to-Linux authority now passes the documented
`paperclipai runtime import-remote` path. The companion comes from immutable
image `sha256:342f1fd5cb8cabfa2242f38f4f686608b28b6536aa879c54b0cb0da6fba9ef47`,
contains 24,352 inventoried entries, and has manifest SHA256
`2c9d337c7d3753db6b8c44c5b347e195a2544b574670af7f32e5dfaffc0b4017`.
The installed runtime selects its exact Linux daemon/provider pack without
binary or pack environment overrides. Extraction never starts its container;
import and selection make no provider calls. This qualification copy is not
release publication: retain the companion and trusted manifest digest with the
release as described in `doc/architecture/runner-pi-capabilities.md`.

Historical corrections and evidence as of October 3:

- Local agent-files and Runner context-before-action reach successful tools,
  then exceed the unchanged 120-second terminal bound. No supported product
  correction is identified yet; both paid failures stay held. A fresh
  read-only power-log audit places the original Runner context timeout between
  a full wake and the next sleep, with no state event during its 11:54–11:57 UTC
  attempt. The separate workflow-context/document sleep correction does not
  establish a correction for this failure.
- Runner finish-task reports the run through `paperclip_finish` without invoking
  the advertised `finish_task` mutation. Preserve the mock authority distinction
  and the failed behavior grade. The actual failed attempt advertises and
  authorizes `finish_task`; runtime instructions already explain the distinction.
  A missing-tool or permission-denial correction is not established.
- Local file-edit edits, validates and publishes the correct downloadable bytes,
  but an extra shell command obtains artifact metadata. The frozen exactly-one
  native validation-execution gate fails. Do not relax that gate or retry without
  a correction.
- Daytona Stop initially lacks the controller companion. After normal import,
  one explicit corrected retry starts Pi but waits on permission to read the
  operator setup file. Restrictive native-read delegation is deliberate. A
  scoped bootstrap operator approval must preserve the pending write and all
  original Stop assertions; production permissions must not be broadened.
  Steering and human-denial first attempts are held for the same known setup
  gap. Both Stop failure grades remain; their sandboxes are separately retired.
- Daytona native-questions fails a remote command transport/deadline during
  observer setup with the existing unrestricted fixture policy. Canonical
  cleanup passes. Preserve this separate failure; investigate remote command
  readiness before another paid attempt or remaining first-attempt dispatch.
- A credential-free diagnostic executes the exact frozen observer readiness RPC
  against the immutable image three times in 0.48–0.64 seconds, within the
  unchanged 12-second RPC budget. Its sandbox is deleted. This proves current
  transport availability; it does not regrade or authorize a retry of the failed
  native-questions case.
- Daytona hello-complete passes its canonical grade, public native state,
  screenshots and cleanup. The next controller-restart first attempt fails the
  observer receipt deadline after a long preparation gap; its public cancel
  request also exceeds its bound. That canonical cleanup failure stays failed.
  Its separately identified sandbox is subsequently deleted. Normal installed
  companion selection verifies all 24,352 entries in 34.6 seconds in a free
  measurement; this does not prove the cause of the original longer gap.
- Daytona question-resume, plan-approve and structured-question restart/resume
  pass their canonical grades, native profile-14/low checks, hash-bound
  screenshots and cleanup. These are first attempts with the frozen installed
  runtime/image and unchanged Product definitions; the descendant harness at
  `6cc13a7f3` differs only in the recorded documentation and two ordinary test
  files. They do not regrade the separate native controller-restart failure or
  authorize a retry of any failed case. The subsequent key snapshot reports
  $4.8004 remaining with zero BYOK usage; billing deltas remain provisional.
- Daytona warm continuity fails in 8.780 seconds before a browser test worker
  starts: the fresh installed Mac controller cannot initialize PostgreSQL. No
  native run or API-state snapshot is produced; canonical cleanup is
  `not_started`. The absent initdb stderr leaves the underlying cause
  unclassified. Preserve this failed grade. Prepare a separate owned native
  Linux installed controller and prove credential-free health/UI/admission
  before a paid correction attempt. Do not infer a Pi continuity failure from
  this controller-startup failure.
- A separately installed native Linux controller passes normal public Pi
  admission in 6.702 seconds. Its image-derived companion retains every file
  byte and link target across 24,352 entries. Linux symlink modes differ from
  the recorded Mac copy, so its normal native companion uses its own manifest
  digest `0907c5be08ed804e4a02b0016703d261a4142c21db6e66f3a01dcca6e775b0cc`;
  the original Mac digest remains unchanged. Normal import passes. Preserve
  both explicit `ERR_PNPM_ENOSPC` dependency failures at the 10 GiB limit.
  Removing only unused owned staging and failed tool dependencies permits
  the smaller unchanged-harness dependency installation and normal Chromium
  setup. A later credential-free startup identifies a skipped standard
  PostgreSQL lifecycle: required native library links are absent and initdb
  exits 127. Standard `npm rebuild @embedded-postgres/linux-x64` repairs those
  links without changing archived bytes. The real installed launcher then
  passes health/UI with zero companies, zero provider calls and full scratch
  cleanup in 12.101 seconds. Strict complete installed audits pass 101,213
  controller files and 16,356 plugin files; the importer authority receipt is
  validated exactly. Normal CLI/plugin admission and all 13 Daytona catalog
  configurations pass with frozen profile 14/model/low. This prepares a
  healthy controller; it is not a paid qualification pass. Fresh BYOK/billing
  guards and an explicit one-case Linux execution phase remain required.
- Daytona agent-files retains two failed setup attempts: collection initially
  cannot resolve the declared shared helper, then the one corrected attempt
  cannot resolve the declared Daytona SDK. Source-only dependency links to the
  reviewed installed shared package and SDK 0.203.0 repair both resolutions.
  All 13 unchanged Daytona cases collect, and the SDK constructor passes without
  credentials or provider calls. Automatic approval review rejects a further
  agent-files attempt because the proposed retry guard exceeds the bounded
  correction authorization. That rejected attempt stays held and unchanged; no
  key was read or remote work dispatched by that action. The October 4 human
  authorization now permits a separate corrected attempt after fresh guards.
- Daytona provider-death reaches a real unanswered native question, then fails
  its exact-child fault observer receipt. Canonical independent retirement and
  cleanup pass; provider-loss and stale-answer assertions are not reached.
  The unchanged Linux fault calibration passes all nine tests, including a real
  pidfd signal. A separate free image inspection finds raw metadata file hash
  `a82188d45ef98396c50880c1352a0dc77e81283ccaefe587156b3468d34e8c0b`,
  while admitted profile 14 pins the canonical entries hash
  `2957c0ec20ca1ace64d1a2b10c4a99f47f59e0c5c33a89161c1d5b48341c2b25`.
  The unchanged production parser accepts all 15,671 entries in that exact
  image-derived metadata. The fixture incorrectly compares the raw file hash
  to the canonical entries pin, so its closure check rejects correct metadata.
  The image's closure is valid; the fixture's hash representation needs repair.
  The original observer error masks its
  specific internal cause; this diagnosis does not regrade that failure.
  The accepted canonical-closure correction passes 14 free Linux tests: nine exact-child
  ownership/pidfd calibrations and five actual-metadata, formatting and negative
  pin regressions. The operator accepts the scoped fixture correction on October 4; those free
  tests do not qualify the failed paid case.
- The unrestricted Daytona file-edit first attempt edits and publishes the
  correct file and passes cleanup, but performs extra native shell executions.
  It fails the unchanged exactly-one validation-execution gate. Both platform
  failures remain held without a supported correction; supplied artifact hashes
  and the exact validation command were already included in the request.
- One explicit warm-continuity correction attempt now uses the proven native
  Linux controller after normal PostgreSQL lifecycle repair. The frozen
  runtime, profile/model/low, image and matchers stay unchanged. The phase permits
  only one correction after the one original failed attempt, with zero automatic
  retries and fresh BYOK/billing guards. The attempt passes all nine canonical
  matchers and cleanup in 298 seconds. Three turns preserve the native session,
  Runner instance, provider session, Runner PID and process-start identity;
  lease acquisition is created/resumed/resumed with one provider lease and
  execution workspace. All three retained event streams independently confirm
  the native session and Runner instance. The retained API snapshot has fewer
  full native run records, so retrospective reinspection of the other identity
  fields is limited to the live canonical checks. Removing only its unused
  owned pnpm store restores 1.65 GiB
  free after checking all 1,181 symlinks and finding no installed reference into
  the store. Installed graph identities and all original evidence are preserved.
- A free counterexample with the unchanged controls oracle proves that an
  approved bootstrap read followed by the pending write creates two permissions
  and is rejected. An external approval alone cannot repair the gate. The operator
  now accepts scoped Product E2E fixture/oracle corrections. GitHub Actions and
  production permissions need no change.
- The previously unexecuted workspace-A group passes 7,176 tests and fails one
  save-navigation assertion. The API update is already observed, but navigation
  follows asynchronous query invalidation. Waiting for the same form-close
  assertion corrects the test race; all 32 targeted tests and token gates pass.
  The corrected full UI suite then passes all 7,177 tests. Workspace A reaches
  the CLI suite, which passes 505 tests and fails one archive-inflation test at
  its unchanged five-second limit. That suite passes all 17 tests in isolation.
  Workspace B passes shared (836 tests) and skills catalog (20 tests), then
  fails the database recovery-migration case with an explicit System V
  `shmget` allocation error (`No space left on device`, 56-byte segment). This
  proves host shared-memory exhaustion for that new failure; it does not
  retrospectively classify the earlier stderr-free initdb failure. Subsequent
  projects and serialized groups remain unexecuted. Use an isolated test
  environment rather than repeating database checks on the exhausted host.
  Every original failed grade and the full-command failure remain unchanged.
- The protected full local command passes 15,018 tests, but one suite hook cannot
  initialize embedded PostgreSQL after five attempts. Its 31 tests then pass in
  isolation. Host shared-memory usage is near its 32-slot limit; missing initdb
  stderr prevents proving the original cause. Do not regrade the full command,
  change host limits, or stop unrelated servers as part of that inference.

The October 3 snapshot above is historical. The current release-gate table and
October 5 results record 24 passes, nine failures and no unattempted cells.
Corrected Stop, steering and human denial are complete; do not dispatch them
as new first attempts. Failed paid cases require a concrete correction before
retry. Latest-head CI/review and prerequisite dispositions remain required.
Keep rollout held until every release gate is proven.

## Evidence so far

- At `dc2b053f3`, the fresh installed profile-14 steering journey receives a
  canonical pass in 52 seconds, including cleanup. It proves the exact browser
  comment, one acknowledgement, denial of the original native write, the hidden
  instruction in the persisted final comment, succeeded/Done, process retirement
  and continuous no-effect evidence through cleanup. The original failed grades
  stay unchanged. No automatic retry or fallback key occurs.
- Final controls definitions advance to version 6. Steering now requires both
  linked control-plane records, the matching accepted result, and succeeded/
  completed/done terminal values. Stop keeps its separate cancellation contract.
  Missing, foreign, duplicate, premature and contradictory records fail. All
  129 controls/flow/catalog tests and Product E2E typecheck pass. The successful
  installed receipt also passes this stricter replay, with no provider call.
  The version-5 canonical pass remains version-5 evidence; the full final-source
  matrix remains a release gate.

- At `603ad3726`, the installed steering journey posts Steer (HTTP 200) and
  Deny (HTTP 202) to the original request. The provider consumes the hidden
  instruction, produces its exact final marker, and reaches succeeded/Done.
  Its canonical grade remains failed: the oracle rejects the legitimate
  `run.result.accepted` and `run.terminal` control-plane records as non-runner
  events. All seven journalled provider processes retire with no target effect.
  The corrected oracle validates those two records against the same run, turn,
  session and linked control producer, after the one native terminal. It still
  rejects foreign, duplicate, reordered and premature records. All 121 controls,
  flow and catalog tests pass, as does Product E2E typecheck. Replaying the exact
  retained public evidence passes the corrected oracle; replay does not regrade
  the original attempt or prove a fresh cleanup receipt. Controls definitions
  advance to version 5. A fresh installed journey remains the qualification gate.
- At `603ad3726`, public profile-14 setup passes on ARM and Intel Mac. The
  first ARM closed-admission probe rejects with `provider_lifetime_owned`;
  a separate credential-free diagnostic with retained state passes in 35.0
  seconds. Preserve both observations; ownership contention remains unclassified.
  Intel closed admission passes in 54.1 seconds. Neither host submits a prompt.
- Full workspace build passes at `3728bb45f`; only the tested UI request-order
  correction changes executable code afterward. Workspace typecheck and UI
  build pass at `603ad3726`. All 282 UI/projection/performance tests and token
  gates pass. Core native tests pass 333 cases. The broader local native
  integration run fails one Codex interrupt recovery case with `provider startup
  ownership remains unadmitted`; isolated diagnosis reproduces it. Do not count
  that broader run as passing.
- At `603ad3726`, 52 CI checks pass and Greptile is 5/5 with both findings
  resolved. Linux Canary is the one failed check: `session_handshake_timeout`.
  The local exact-source Linux build compiles but exceeds its fixed 30-minute
  deadline during image import. It produces no verified usable image. Its
  task-owned builder is stopped, its cache and failed receipt remain, and no
  provider credentials or calls occur. Linux and Daytona remain held.
- At `342287678`, installed steering proves delivery and one acknowledgement,
  but the UI marks the still-pending permission cancelled and hides Deny. The
  correction uses whole-run lifecycle state, carries pending cards to the live
  tail, and leaves closed cards at their original position. Older carried cards
  precede newer requests. The real widget regression clicks Deny for the
  original run, request and provider turn. The paid failure stays failed.
- At `36e712104`, installed steering returns HTTP 200 and the native command
  journal records accepted delivery. The public API retains the correct
  correlation-bound acknowledgement at source sequence 65 and also a
  rehydrated transport echo at 66. The exact-one acknowledgement gate rejects
  that duplicate before permission denial. A regression using the actual
  rehydration function reproduces both items; suppressing the transport echo
  retains the one authoritative item. The interrupted attempt remains failed.
- The shared ACPX patch also requires portable hunk metadata and new byte-bound
  identities. Pi advances to 14, Cursor to pending 11, and Copilot to pending
  15. Historical fixtures remain immutable, and old installed identities fail
  closed. The corrected patch passes all 16 packaging checks; identity and
  steering regressions pass 244 tests. No other provider qualification expands.
- The credential-free Intel public installation at `36e712104` passes closed
  admission in 44 seconds. Its Greptile review is 5/5, but CI is held by the
  stale patch-bound profiles, portable patch metadata and Linux admission.
  The paid attempt and task-owned Linux build were stopped when that identity
  mismatch was found. Their evidence is retained; the owned server and database
  processes are retired. Qualification must use newly installed profile 14.
- At `4237bc369`, the native turn-binding correction advances the steering
  journey past `steering_stale_turn`, but the provider boundary still rejects
  delivery. The real patched ACPX client lacks `requestExtension`: its types
  and runtime callers declare it, while its implementation omits it. A real
  package regression fails with that exact TypeError before the correction,
  then passes steering and follow-up during an unanswered prompt afterward.
  This is a separate runtime correction and needs a fresh installed journey.
- The corrected Intel public package at `4237bc369` passes credential-free
  closed startup in 37.8 seconds. Its CI typecheck, build, native tests and
  browser shards pass. CI retains two failures: a resumed durability test
  inherits the deliberately killed attempt's 500 ms timeout; the Linux public
  Pi probe reaches `session_handshake_timeout`. The former gets an explicit
  resumed-turn bound. The latter remains an admission blocker; accepting a
  timeout as successful installation would weaken the release gate.
- The local Linux image build at `4237bc369` fails before a provider starts
  because the committed lock does not match the source patch configuration.
  The official image workflow already regenerates its private build lock;
  local builds must do the same and record that resolved lock's digest.
  No repository lockfile or workflow changes are required.

- `2b50801b2`: installed restart failed before native answer delivery. The
  durable request turn ID differs from the provider turn ID. The browser's
  issue-identifier route also differed from the matcher's UUID route.
- `780471702`: the exact retained browser answer was delivered and the original
  run reached Done with the correct independent file. The attempt still failed
  because recovery emitted a second `runtime_request.created`. The oracle
  correctly requires one creation. The next change restores the ledger without
  repeating its creation event.
- `f5f57e380`: the fresh installed restart journey passes all six matchers,
  including one native creation/resolution, the original process and turn, exact
  browser answer, independent file and cleanup. The revised three-turn warm
  journey also passes all nine matchers with the same native process/session.
  Earlier failed attempts remain unchanged.
- The full workspace typecheck, 332 native core tests and 58 focused governance,
  cost and session tests pass. The PR's Linux timestamp precision finding is
  fixed with positive and negative calibration and the real process fixture.
- Credential-free ARM startup through the installed CLI, server and database
  passed. Normal Pi setup verifies the profile-13 closure. Full transport and
  recovery regressions at `780471702` passed 216 tests.
- At `f5f57e380`, the explicit Runner `get-task-context` case passes. The next
  case, `context-before-action`, times out after 120 seconds: four context tools
  succeed, but the requested progress mutation and terminal do not arrive.
  Its canonical timeout grade remains unchanged; no automatic retry occurred.
- The local pending-permission Stop attempt at `f5f57e380` fails. Retained
  Product events contain the native write and pending permission. The oracle
  incorrectly rejects legitimate earlier null paths while arguments stream,
  so it never sends Stop. The correction admits those partial rows only until
  the same execution proves the exact path. Missing/conflicting/lost paths and
  foreign executions still fail. All 66 control calibrations pass; the failed
  paid attempt stays failed and requires a fresh journey after the correction.
- The public-install verifier now packs the public CLI as well as the server,
  runs normal explicit Pi setup in its isolated consumer, then proves closed
  startup offline. Its standalone ARM probe passes in 7.9 seconds with no
  credentials, prompts, binary override or borrowed workspace package.
- Draft #14956 at `2b3d7ff0a` has a fresh Greptile 5/5, the Linux finding is
  resolved, and its CI checks pass. Subsequent changes require a fresh review.
- At `03dd6ef93`, fresh pending-permission Stop passes: the original callback is
  cancelled, a stale decline is rejected, the owned processes retire and the
  continuous watcher records no file effect. The subsequent steering attempt
  retains its failed grade. Its browser successfully posts one queued comment,
  but the oracle compares plain input with the editor's Markdown-escaped body
  and never clicks Steer. The correction binds to the exact browser POST body;
  67 calibrations include escaped content and rejection of an altered queue.
- The `03dd6ef93` full build passes. The broad unit run reports 14,984 passes
  and one HTTP socket failure; all 12 tests in that unchanged suite pass in
  isolation. Fresh review is 5/5. CI's public installer reaches Pi setup but
  exhausts its 256 MiB scratch mount. Pi assembly now gets at most 2048 MiB,
  retaining the same unprivileged, read-only sandbox and 3 GiB memory limit.
  All seven sandbox checks pass. CI's separate legacy signoff browser failure
  received one diagnostic shard rerun; it is not counted as passing yet.
- Earlier evidence in `doc/architecture/runner-pi-capabilities.md` is historical
  and must not be counted as qualification of a new source revision.
- At `2a6107c04`, normal public Pi setup and closed admission pass on ARM and
  Intel Mac (7.5 and 29.5 seconds). Intel uses a fresh compiled x64 daemon,
  packaged before installation through the normal public CLI/server graph.
- The fresh steering attempt at `2a6107c04` reaches the real public Steer API
  but receives `409 steering_stale_turn`. Rust checks the durable command ID
  against the live provider turn even though the facade supplies a separate
  `providerTurnId`. The correction uses that explicit provider binding, rejects
  malformed bindings without fallback and keeps the existing live-turn fence.
  All 333 core tests and 68 control calibrations pass. The browser fixture now
  ends immediately on a rejected steering POST before sending any denial.
- Linux CI now completes normal Pi setup with bounded larger scratch space.
  Its offline launch probe still returns an unclassified startup rejection;
  the verifier gives that launch's private runtime snapshots the same bounded
  scratch capacity. This is not counted as a passing Linux receipt yet.

## Resumed goal — 2026-10-02 21:50 CDT

- Current-head `6cfc79b50` CI completes with two failures: Linux Canary
  admission and a 15-second issue-document route test timeout. Runner, build,
  typecheck and the browser shards pass. The prerequisite stack remains open.
- The Linux admission failure is reproduced through normal public packages.
  Pi setup verifies profile 14, then admission times out in 37.3 seconds.
  A credential-free direct native RPC response arrives in 2.4 seconds.
  The actual Docker scratch mount reports `noexec`; executing the verified
  snapshot fails with `EACCES`. The offline runtime probe now uses executable
  scratch. Lifecycle and download probes explicitly retain `noexec`.
  The same installed Linux packages then pass the unchanged public admission
  assertions in 17.2 seconds, with clean Runner exit and zero prompts.
  This receipt uses historical shipping source `dc2b053f3` and native inputs
  from `3728bb45f`. It diagnoses and validates the sandbox correction; it does
  not qualify the new native source or the final Daytona image.
- A provider-free regression proves that receipt-limit deadline settlement
  attempted to restart the provider when polling terminal evidence. The run
  now closes permanently at that deadline. Existing startup admission fences
  remain intact. All 333 native core tests and all 90 enabled native provider
  integration tests pass after the correction; two pre-existing tests remain
  ignored. The accepted-deadline fixture now expects the closed lifecycle and
  checks that polling from both controllers adds no provider resume. The core
  regression also retains unacknowledged terminal evidence across reconnect.
  The earlier broader failure and its stale lifecycle assertion remain in
  private evidence; they are not regraded.
- Runner progress evidence contains four successful reads and continued model
  output before the 120-second cutoff, including unrelated fixture notes.
  Bounded direct-eval instructions now ask for the minimum context needed,
  the requested action, then turn completion. Case assertions and timeout
  stay unchanged. All 35 Runner session-contract tests and TypeScript
  typecheck pass. The retained paid failure remains unchanged. Fresh exact
  source packaging and profile-14 eval definitions must precede a paid retry.
- No paid call, key reset, fallback credential, workflow change, lockfile
  commit, merge or release occurs in this resumed diagnosis.

## Qualification update — 2026-10-02 22:50 CDT

- All 55 CI checks pass at `df424c902`. Linux Canary proves normal public
  CLI/server installation, profile-14 setup and credential-free closed admission
  in 8.036 seconds, with clean Runner exit. ARM public admission passes in
  7.988 seconds at the same source. Intel public admission passes in 34.059
  seconds at `666cb3ecc`; the next commit changes only Rust test formatting.
  These receipts do not prove the immutable Daytona image or the full matrix.
- Installed Runner qualification uses exact source `df424c902`, private eval
  definitions `a9e0e7e0`, frozen Pi profile 14, the exact model and low thinking.
  Context-before-action, get-task-context, create-task-document, finish-task,
  request-human-confirmation and workflow-context-document-progress all pass.
  Each has one attempt and zero infrastructure retries. Original failures
  remain unchanged.
- Workflow-governed-wait creates its requested approval and wake and completes
  the provider turn without finishing the mock task. Its canonical grade is
  `infrastructure_failure`: cleanup never proves durable Runner suspension.
  Retained stderr proves provider drain and semantic tool settlement, with zero
  pending provider events; suspension alone fails. The owned Runner is killed.
  The eval program deletes its temporary workspace, limiting further diagnosis.
  No paid retry is authorized by an unchanged failure; investigate and correct
  the close boundary first.
- The two #14924 notice findings are reproduced and corrected downstream.
  Error severity retains the Error label even with informational status.
  Distinct notices share one compact category so work and a later error remain
  visible. All 44 focused UI tests, token gates, isolated UI typecheck and UI
  build pass. Root UI dependency links point to a different frozen checkout;
  validation uses this task's own dependency-complete private source.
- The existing image-only run 37092761291 remains queued for EC2 job
  111116414966. It uses no provider credentials or prompts. Do not dispatch a
  duplicate on an observation timeout. Its authorization binds `df424c902`;
  source changes require new exact-source qualification evidence.
- The dedicated key's latest API observation is $0.092409367 lifetime usage,
  $4.907590633 remaining, and zero BYOK usage. The $5 lifetime cap and $100
  campaign limit remain. Billing observations are provisional, not invoices.
  Paid work is held until a concrete governed-wait correction and fresh
  exact-source packaging. The full 26 Product cells remain required.

## Idle suspension correction — 2026-10-03 00:05 CDT

- The original governed-wait failure remains unchanged. A credential-free,
  digest-bound native fixture reproduces a close-budget defect: `turn.stop`
  reports an idle Pi provider already settled, leaving an eight-second RPC close
  for a suspension phase that reserves only 2.5 seconds. The original regression
  fails after 8.55 seconds. The corrected regression passes in 0.62 seconds.
- Close preparation now stops idle Pi through its exact native process owner.
  Native code rejects an active turn or pending callback on the idle path, proves
  release of the original inherited lifetime fence, and retains the attested
  identity. Drain and suspension still require their durable receipts. Native
  suspension and the TypeScript checkpoint gate both reject unconfirmed exits.
  A held-quorum regression verifies the non-reusable boundary and unchanged
  state after polling. Remote Pi uses the same native guard before checkpoint.
- The complete native suite passes with no failures and two pre-existing ignored
  tests. All 236 transport and eval-session tests pass; Runner typecheck passes.
  Earlier test failures remain in private evidence, including a corrected
  negative-test expectation: safe polling returns no events and preserves the
  unconfirmed state rather than requiring an exception.
- Typed native suspension failures now retain allowlisted command/lifecycle/
  identity diagnostics in eval artifacts and stay non-retryable. Diagnostic
  collection reuses the barrier observation without extending the close bound.
- All 55 CI checks and Greptile 5/5 pass at `00c7a4510`, with no new finding.
  The subsequent native correction requires fresh-head review and CI. The
  superseded image run 37092761291 is terminal/cancelled; its queue state and
  cancellation reason remain. No duplicate or replacement image is dispatched.
- The paid campaign remains held for fresh exact-source packaging. Its launcher
  now rejects a mismatched or dirty harness and unpinned definitions before any
  provider call. Only the recorded private resolved build lock may differ.
  The next paid call is one explicit governed-wait retry after this correction;
  the original failure is not regraded. All seven final-source Runner cases,
  all 26 Product cells, platform receipts and the immutable image remain gates.

## Frozen candidate qualification — 2026-10-03 00:45 CDT

- Runtime and Product harness are frozen at `b148b73ea`. The public server build
  stamp, CLI/server package integrity, installed native digest and separate
  Runner tar are verified. The Runner tar's daemon, eval CLI and transport bytes
  equal the normal server-vendored files. Reused workspace package inputs are
  unchanged from their retained tar source. The private resolved build lock is
  recorded and is not committed.
- `3d75626bf` changes only the held-lifetime test. Linux's port-zero allocation
  can fall below the identity contract's allowed dynamic-port range. The fixture
  now reserves three valid distinct ports; it keeps the production validation
  intact. All 22 backend tests and Rust formatting pass. Shipping and harness
  inputs are unchanged.
- All seven installed Runner cases pass, including governed-wait in 35.7 s.
  The original failed attempt is preserved. Every case reports profile 14 and
  effective low thinking; all use the same package and native digests. The
  canonical scrubbed Evalbook renders seven attempts with zero rendering
  provider calls. Real Chromium verifies the report's chat, read-only controls,
  navigation, reload and narrow viewport. Its $0.008861636 aggregate estimate
  is not an authenticated bill; all seven provider-dollar receipts are unpriced.
- Normal ARM, Intel and Linux public installations pass in 8.043, 37.681 and
  5.698 s respectively. Each uses the normal installed daemon, verifies profile
  14, submits no prompt and observes clean Runner exit. Workspace build and
  typecheck pass. The broad local Vitest attempt completes with 47 failed files,
  533 passed files and 163 skipped files. Private Postgres library symlinks are
  missing, and the restricted test PATH omits macOS lsof. Both setup causes are
  corrected only in the task-owned dependency environment. The focused DB and
  process-owner checks pass 95 tests with three existing skips. The corrected
  broad run completes with 738 passed files, four skipped files, 14,984 passed
  tests and 84 skips. One native integration suite cannot start because Cargo
  is absent from the restricted PATH. With the pinned Rust toolchain added,
  that native Codex result/resume integration test passes. Both failed broad
  logs remain intact; neither is a passing full-command claim. The final-source
  run must include the pinned Rust toolchain from the start.
- The local Product controller-restart cell passes with canonical evidence.
  The next cell, warm-three-turn, completes turn 1 but fails before turn 2
  provider work: native `run.attach` reaches its 30-second command timeout.
  Canonical disposition remains `transient_infrastructure`, and cleanup passes.
  No automatic retry occurs; the campaign closes immediately. Eleven remaining
  local cells and all 13 Daytona cells are still unexecuted.
- A separate installed no-prompt warm-admission diagnostic opens Pi in 7.2 s,
  then rejects attachment with `session_resume_required`. It is not a replay
  of the completed-turn failure and does not qualify warm continuity. Its strict
  cleanup receipt fails even though native state reports suspended and Runner
  exits cleanly; both observations are retained. No model prompt is submitted.
- A free completed-turn regression proves the warm-admission mismatch. It
  finishes turn 1 through the native semantic bridge, checkpoints the sidecar,
  and delays the replacement's exact-identity admission by 32 s. The unchanged
  controller times out at `run.attach` and strict suspension fails. The corrected
  controller uses Pi's existing absolute 60 s cold-process admission budget for
  warm attachment and aborts admission on close. The same fixture then completes
  turn 2, retains one Runner, starts exactly two sidecars without a retry, and
  passes strict cleanup. TypeScript, all 201 transport tests, and 37 eval-session
  contract/entrypoint tests pass. The native 60 s bound and profile-14 bytes are unchanged.
  The paid three-turn failure remains failed. Fresh exact-source packaging and
  one explicit paid retry are still required; no live resolution is claimed.
- The corrected shipping candidate at `0d65753fe` passes full build and typecheck,
  normal public CLI/server packaging and fresh Runner pack/vendor equivalence.
  ARM, Intel and Linux public installation pass in 7.788, 31.185 and 8.071 s.
  The prior candidate manifests and Runner tar are preserved.
- All 55 CI checks and Greptile 5/5 are terminal at `96a0e329b`. Greptile is
  also 5/5 at `0d65753fe`; all 55 current-head CI checks are terminal and green. The superseded
  immutable image job 37099122706 is canceled because shipping inputs changed.
  Its one replacement, 37102904889, is authorized and queued for the corrected
  source. Track this exact handle without another dispatch. Qualification,
  prerequisites and image/companion gates still hold production.

## Qualification follow-up — 2026-10-03 02:15 CDT

- The explicitly authorized corrected-source warm retry at `0d65753fe` passes
  all nine matchers with three succeeded turns, one Runner process and session,
  exact independent file bytes, and strict cleanup. The original `b148b73ea`
  warm timeout stays failed. No automatic paid retry occurs.
- The final-source local matrix then passes controller restart,
  pending-permission Stop, same-turn steering, and native questions. Its next
  agent-files attempt fails with `native_session_interrupted` after the unchanged
  120-second bound; cleanup passes. The canonical grade remains
  `transient_infrastructure`. Retained tool outcomes prove the managed-memory
  write/read and expected cross-root denial succeeded. Completion is rejected
  because the server incorrectly recognizes these internal/negative-test
  instructions as a requested downloadable output. The provider continues after
  that rejection until the timeout. Treat the completion false positive as the
  observed product cause; preserve the machine classifier separately.
- The campaign closes after that failure. Its held coordinator is retired only
  after the provider attempt is terminal and cleanup has passed. The key keeps
  its $5 lifetime cap, zero BYOK usage and about $4.87 remaining. Its API deltas
  remain provisional. Five local passes are retained, without regrading the
  agent-files failure. No paid retry is authorized by a presentation-only change.
- The prerequisite #14921 exit/catch notice finding is reproduced through the
  actual extension-turn binding: two identical failure inputs produce two
  canonical notices. The first correction at `f62b8510a` changes the frozen
  notice-projection source hash, so its 115 focused passes do not qualify it.
  Restore that source byte-for-byte and coalesce only the board's consecutive
  identical display rows, scoped to the complete run, turn and session. Both raw
  PRP facts remain. Different reasons/severity, retry activity and later turns
  remain observable. The frozen binding/extension tests pass 11 cases (one
  optional host probe skipped); UI projection tests pass 145 cases. Token gates
  pass. No profile, wrapper, deadline, terminal or approval-authority change occurs.
- The completion regression reproduces four false positives without model calls:
  file-tool names, managed personal memory, an explicitly internal assertion
  file, and an expected denied native-write attempt. The correction preserves
  actual downloadable output requirements, mixed requests, and publication
  evidence enforcement. The first correction passes 59 tests, but fresh review
  identifies two mixed-output publication bypasses. Restrict the internal
  qualifier and denied-attempt scope; 64 tests pass. At `1a8900958`, fresh review
  identifies two valid instruction variants that this narrowing still rejects.
  Bind each file object to its own creation verb instead. An internal qualifier
  applies only to a single requested file across the preceding sentence, even
  if a later clause checks it. All 68 unit/database integration tests pass,
  including both publication bypasses and both internal/denied variants. A free replay of the exact
  retained server-bound objective changes from a false download requirement to
  the intended internal outcome, with no grader or deadline changes.
- At `b28422b29`, fresh review finds that an explicit "attach it" can lose its
  publication requirement when the preceding file is called internal. The free
  unit/database regressions reproduce that bypass. The correction preserves
  attachment/export references; 74 completion tests pass. Fresh review at
  `53923e5ad` finds that inferring publication from "return it" also blocks an
  explicit inline response. Remove that extra inference. Explicit attachment/
  export directives still require publication, while internal contents returned
  in chat do not. All 76 completion tests pass; the exact failed agent-files
  objective still needs no download. Wait for clean source review before
  rebuilding public packages again.
- At `fef9e8456`, review identifies a missing explicit "send it" delivery
  requirement. Preserve delivery references to the preceding file, including
  across sentences, while explicit inline/chat content remains inline.
  Attachment/export directives always retain publication requirements. All 84
  completion tests pass, including both delivery and inline instructions. The
  exact failed agent-files objective still needs no download; no paid retry runs
  on these intermediate candidates.
- At `062902cea`, review identifies an inline code-block response that the
  delivery rule still treats as a download. Recognize explicit response/reply,
  code-block and plain-text formats as inline content. An actual attachment
  named in that same response still requires publication. All 89 completion
  tests pass, including the database-bound reviewed example. Keep the paid
  campaign closed until clean review and fresh installed qualification.
- The subsequent download-link finding does not reproduce at `63e5d6443`.
  Its existing `download` object matching requires publication for the exact
  reported objective, even when the link belongs in a response. Free replay
  returns true and the database completion gate rejects missing delivery
  evidence. Add both as regressions: all 91 completion tests pass. No runtime
  change is needed for this finding; retain the failed review as evidence.
- The `0d65753fe` broad local suite is terminal with 736 passed files, four
  skipped files, 14,982 passed tests and three failures: a Git scan load
  single-flight count (497 versus 498) and two HTTP socket resets. One associated
  unhandled socket rejection is retained. This is not a passing full-command
  claim. The two socket-reset suites pass in isolation. The Git load failure repeats
  (496 joins versus 498). Its fixture creates 500 ephemeral listeners; the
  correction sends all 500 concurrent requests through one listening server and
  handles every rejection during teardown. The unchanged assertions then prove
  500 HTTP 200 responses, two scans, 498 joins and 2.4 ms health p99. All 138
  load/redaction/recovery tests pass. The full failed command remains retained.
- Image run 37102904889 is terminal/cancelled after the shipping source changes.
  Its successor 37106313185 remains queued and pins `f62b8510a` in its completed
  authorization job. It cannot qualify the corrected source. Retain this handle
  and supersede once the tested correction is frozen. No workflow edit, lockfile
  commit, new model, fallback key, merge or release occurs.

## Broader release follow-ups — deferred for current delivery

1. Cloud memory acceptance is complete for the frozen `b696e131ae32a82418e570b32f4727b5adb14e49`
   runtime/image and definition-22 harness `da8d4454ae165b557ff11730e9fe018c9b1cd9b9`.
   Both native reads, exact LF, controller restart, fresh-task bytes, denied
   cross-root write and cleanup pass. All 31 files are retained and verified.
   The earlier local pass and cloud failures remain source-bound history.
   All 173 focused memory, bootstrap and installed CLI/plugin checks pass.
2. Complete the remaining 25 Product and seven Runner cases on Sonnet 4.6 with native low
   thinking and the frozen profile-18 package/image set. Definition source
   `bf8c509df49a40e72509e8732b77516aea02bbbd` changes only qualification model,
   its matching test declaration and estimated pricing; all seven case bodies,
   scoring rules and 120-second limits remain unchanged. Seven free definitions
   and 63 eval-program/roster tests pass. Current-freeze definition-22 Product coverage is one cloud memory pass out of
   26 cells. Definition-21 local and cloud receipts remain historical. Resolve strict Runner price/counter accounting before
   more Runner calls;
   historical model/fixture passes are not transferred. Preserve spending caps,
   zero automatic retries and independent cleanup. Normal Linux, native ARM and
   native Intel installation already pass for shipping `06a3d9739`; their own
   immutable identities stay attached.
3. Close the valid prerequisite #14921 premature-admission finding with
   source-specific qualification; #14922–14924 currently have no unresolved
   threads. Finish latest-head typecheck, tests, build, CI and review. Follow the
   rollout/rollback procedure only after all gates pass and separate release
   authorization is given. No merge, release or rollout is authorized here.

## Historical execution sequence

The following command results and counts describe earlier source-bound snapshots.
They are retained history, not the current remaining-case roster.

1. Preserve the completed full native Linux typecheck, test and build evidence.
   Keep the original Mac command failures and the unclassified
   OAuth socket failure. The first Linux command compiles the Runner but fails
   staging because the check wrapper sets Cargo's target outside the staging
   script's expected path. Correcting that owned check environment permits one
   credential-free repeat; it does not change source or regrade the failure.
   That command passes typecheck, server (15,054 tests), UI (7,177), CLI (507)
   and shared (836), then fails the skills-catalog pack test because npm is
   absent from the closed PATH. Restore the immutable image npm path and
   preserve that failed command. The next repeat fails six suites after free
   disk drops below the unchanged workspace reserve. Reclaiming only the unused
   owned pnpm store restores 2.75 GiB; all 75 tests in those six suites pass
   unchanged. The current full repeat passes typecheck and all tests: 29,447
   passes and 69 skips across 164 groups, including every serialized suite.
   Build then fails immediately on missing Node headers. The complete official
   Node 24.21.0 archive verifies against its checksum and contains the identical
   pinned executable. Installing it only in the owned build tools supplies the
   matching headers without changing the sealed provider pack. The corrected
   build then exits 137; the kernel records one OOM kill and a peak at the
   8 GiB cap. The resize request fails with an unavailable API endpoint.
   The full native Linux CI build independently passes `pnpm build` across all
   35 build projects using Node 24.21.0 and Rust 1.97.1. [Job 111317358779](https://github.com/paperclipai/paperclip/actions/runs/37162051919/job/111317358779)
   checks out `5e36276bd`; its complete Git tree exactly equals PR head `e90143a5c`.
   Shipping inputs also match the frozen artifacts. This proves the required
   full build command without regrading either failed Daytona build or claiming
   a passing combined Daytona wrapper.
   Normal ARM/Intel/native-Linux installation and immutable Daytona import now
   pass; retain their exact-source receipts and original failures.
2. Correct the nine remaining failed gates on the frozen shipping artifacts.
   All 26 Product cells and seven Runner cases have been attempted. Product has
   19 passes and seven failures; Runner has five passes and two failures. The
   total is 24 passes, nine failures, zero unattempted and zero running cells.
   Local agent-files and file-edit remain failed. Daytona native-questions,
   native controller-restart, agent-files, provider-death and file-edit remain
   failed. Runner context-before-action and finish-task remain failed.
   Stop, steering and human denial are complete. Preserve their original
   failed attempts; do not redispatch them as first attempts.
   Every failed paid case remains held until a concrete correction addresses
   its observed failure. A documentation change or unrelated fixture correction
   does not permit retry. Keep zero automatic retries and reuse only evidence
   whose executable inputs, definitions and recorded source match.

3. Finish prerequisite dispositions and latest-head CI/review. Four findings
   have downstream corrections; premature production admission remains held
   until all 33 cases pass. Preserve the original Codex interruption failures
   and corrected integration evidence. Apply the recorded operator rollout
   only after qualification. No merge or release is authorized here.

## Rollout and rollback

These are operator instructions for a later authorized release. Production
remains held until all 33 qualification cases, integration checks and prerequisite
reviews pass. This goal does not publish, merge or deploy the candidate.

Failed reusable leases retain provider resources until destruction succeeds.
Before removing an environment, inspect its deletion preview and request the
normal consented reusable-resource teardown. A live holding run or
`pending_cleanup` lease must continue blocking deletion. Let the recorded,
attempt-fenced cleanup finish; do not clear its status or bypass the guard.
After controller loss, cleanup ownership can take up to 15 minutes to expire
before the sweep reclaims it. Confirm actual provider absence independently of
the database status. Drain or recover recorded cleanup before rolling back to
a release that cannot interpret its metadata, and preserve the provider handle
and receipts throughout that operation.

1. Record `paperclipai --version`, the prior CLI/server package versions, the
   current company configuration and the exact retained package set. Run
   `paperclipai db:backup --json` against the intended instance. Retain the
   reported backup path and size. Record the backup file SHA256 before updating.
   Drain active native runs on every platform before updating. On Linux, also
   drain before crossing between ctime-based and kernel-birth receipts. Never
   rewrite an active identity to force adoption.
2. Use the exact qualified published version. For a managed npm installation,
   preview and apply the pinned update below. The operator must supply
   `PI_RELEASE_VERSION` after publication. Keep the default pre-update backup.
   A managed Git installation follows its recorded Git reference; use its
   separately reviewed install procedure rather than this npm version command.

   ```sh
   paperclipai update --version "$PI_RELEASE_VERSION" --dry-run --json
   paperclipai update --version "$PI_RELEASE_VERSION"
   paperclipai runtime setup pi
   ```

3. For Daytona, select the exact image in the completed release qualification
   record. The candidate image in the current gate table is not yet qualified.
   Do not select a historical image from this plan. Obtain the
   matching Linux companion and its trusted `companion.json` SHA256 from the
   same release. The operator must supply both values below. Use the normal
   import path; retain its receipt. The importer validates the server build,
   profile and complete inventory. The qualification copies and their
   platform-specific manifest digests are evidence, not published release assets.

   ```sh
   paperclipai runtime import-remote "$PI_RELEASE_COMPANION" --sha256 "$PI_RELEASE_COMPANION_SHA256"
   ```

4. After all release gates pass, begin with one operator-owned Linux Pi company using profile 18,
   the accepted qualification model `openrouter/anthropic/claude-sonnet-4.6`
   and explicit low thinking. This canary input is not a production model
   allowlist: later companies may select any model acknowledged by their native
   provider or explicit custom-provider configuration. Check normal startup, one question and answer, Stop, three warm turns,
   terminal task state and usage visibility before expanding. Preserve the
   existing company permissions and budget hard stop. Record the installed
   package, runtime, companion and image identities with each canary run.
   Verify an exact memory write with its final LF and read it in a fresh task.
   Current-artifact exact-byte memory acceptance must pass before expansion;
   historical memory results do not satisfy this canary or qualification gate.
   Verify controller recovery while a native question is pending: answer the
   original question once, retain the original run and producer identities, and
   prove complete terminal evidence and cleanup. Stop expansion if either fails.

On any failed qualification gate, keep admission held. On a rollout regression,
stop new Pi dispatch and retire active work through the control-plane Stop path.
For a managed installation, verify that the preview names the recorded prior
payload before applying rollback:

Complete the owned Stop path before rolling native Runner payloads back on any
platform. On Linux, also drain before crossing the process-birth format change.
Preserve terminal and cleanup evidence.

```sh
paperclipai update --rollback --dry-run --json
paperclipai update --rollback
```

The CLI restores the retained prior managed payload and restarts an active
managed service. It does not reverse database migrations. If the prior version
cannot use the current database, stop the service and restore the verified
pre-update backup through the instance's database recovery procedure before
resuming. Preserve post-backup run evidence separately. Non-managed installations
must restore the recorded prior published CLI/server set through their install
method; `--rollback` is supported only for managed installations.

Restore the recorded company configuration and verify service health before
enabling dispatch. Reopen incompatible sessions. Do not replay uncertain provider
actions or present expired callbacks as live questions. Preserve run history and
all failed release evidence.

## Native image and frozen-artifact qualification — 2026-10-03 07:16 CDT

- Shipping artifacts remain frozen at `0bd040093dd33b5a31cd0ecd1f170f0d94600fce`,
  with profile 14, the same model, and native-confirmed low thinking. Documentation
  and fixture-only follow-ups must record their exact diff and prove shipping
  inputs unchanged. They do not relabel artifacts or permit an unchanged failed
  paid-case retry. Any shipping-input change needs fresh package/image evidence.
- The local direct registry export publishes the exact-source immutable image
  listed above. Anonymous inspection verifies its source/content labels, digest
  and Linux AMD64 platform. Actual Daytona import, normal public CLI/server
  installation, Pi setup and closed admission pass in 8.699 seconds. The Linux
  daemon is `sha256:af4bb4b2934c01891f7f916e0f33bcce4fac2d59ee7d74c8e832ef8720154938`.
  All 18 archive integrities pass. The derived server archive changes only the
  public Linux binary; normal repacking omits six bundled changelogs. All other
  retained files match byte-for-byte. Public-source provenance and credential/
  user-state exclusion are checked before upload. The sandbox is deleted.
- Public graph audits pass 722 CLI packages and 79,360 files, the 150-package Pi
  closure, and 191 Daytona plugin packages with 16,356 files. The separately
  packed Runner matches all 1,330 vendored distribution files. Installed browser
  startup passes health/UI with zero companies, credentials or provider calls.
- The local AMD64 Docker admission failures persist across bind-mounted and
  native-volume installs. The process observer sees Rosetta executable ownership.
  Native Linux succeeds with the exact-source image. Rosetta is a supported
  diagnostic explanation to investigate, not a regrade of any failed attempt.
- The latest local agent-files failure completes bash and native memory write,
  but neither native read nor finalization. Its earlier completion-publication
  rejection is absent. No supported product correction is identified from this
  attempt yet. Its cleanup passes, and the original failure remains unchanged.
- Two first-attempt Runner cases use the frozen installed package and definitions
  `a9e0e7e025152e9941cca08e54d97c54f6490908`: get-task-context passes;
  context-before-action times out after successful context and progress tools.
  Native config/process metadata confirms low thinking, and Runner exits cleanly.
  There is one attempt per case and no automatic retry. The sequence stops.
  The strict shipping ledger is one pass, two failures and 30 unexecuted cases.
- The first full local command fails a comment-wake timeout and setup-token
  socket hang-up. Both suites pass all 58 tests in isolation. The controlled
  repeat fails a close-progress reaction assertion and an OAuth socket hang-up;
  its earlier failures pass. Each command stops in the first server group with
  737 suites passed, four skipped, 15,026 test passes and 83 skips. Neither is a
  complete workspace test pass. Seven selected cases then pass in isolation;
  instrumented diagnostic copies of both suites pass all 1,431 tests.
- A controlled deferred-worker fixture reproduces the close assertion with one
  late removal belonging to `setup-follow-up`, not the working message. The
  correction settles that exact setup receipt before measuring working-run
  removals. All four prompt/state cases pass under the same deferred-worker
  condition, and all 28 close-progress cases pass with normal scheduling. The
  original assertions and production worker code remain unchanged. A complete
  local command with this fixture correction remains required; the OAuth socket
  cause is unproven, and no speculative socket workaround is added.
- The key retains its $5 lifetime cap without reset or BYOK; its last pre-Runner
  snapshot has $4.862597588 remaining. Immediate usage deltas remain provisional.
  All 72 account BYOK provider rows are unconfigured. The campaign retains its
  $100 budget, frozen model/profile and failed-case holds. Recorded rollout/rollback
  remains conditional on every release gate passing.


## Native Linux admission and Pi credential forwarding — 2026-10-07

- Frozen runtime `efd4df03d5c472dc8051461f38e16b5f3b62ce01` was built natively
  with Node 24.21.0 and Rust 1.97.1 on an owned disposable Linux host. Normal
  public CLI/server packages installed and `runtime setup pi`, installed graph
  verification, public daemon admission/retirement, health and browser onboarding
  passed. External probe source is `f332f79e6e9fc40fa69fbf8d9dfc544acc531e7f`;
  its change is probe metadata only. Pi remains profile 16, thinking low.
- Latest `f332f79e` PR checks were 54 successful, two skipped, no failures, with
  an exact-head Greptile 5/5 review and no unresolved review threads. The normal
  Canary public-install probe passed; its merge source is distinct from `efd4`.
- The first real `extended-harnesses.runner-acpx-pi.local.file-edit-validate`
  attempt failed during `session.open`, with independently confirmed cleanup
  and no token usage observed. Before/after key usage was USD 0.445246261, BYOK
  zero, lifetime limit USD 5. No unchanged paid retry was made.
- A separate invalid-key diagnostic reproduced the startup rejection. Captured
  runtime context and the Rust-projected dynamic tool catalog were valid. Direct
  installed-sidecar startup exposed `ENOSPC` while copying the verified Pi
  distribution. Removing only the completed npm download cache reclaimed
  1,116,352 KiB without changing installed packages or archived package bytes.
  Direct admission with the captured context then passed with no prompt. A full
  installed diagnostic subsequently reached the provider turn and failed with
  the expected invalid-key service error; startup and cleanup both succeeded.
  These diagnostics are not qualification passes.
- The Rust sidecar launcher had an independent production restriction: Pi
  forwarded only `OPENROUTER_API_KEY`. This change forwards bounded credential
  names from the authenticated controller's Pi session binding, including native
  provider keys and explicit custom provider references. The sidecar retains its
  exact session/configuration validation. Process-control variables and malformed
  bindings fail closed. No model allowlist, model fallback or new default is added.
- A real child-process regression passes OpenRouter, Gemini and custom-provider
  bindings while excluding unrelated credentials; malformed/duplicate bindings
  and process-control names are rejected. Full Rust validation passed 687
  tests (two ignored), plus the final binding guard and 15 process-transport
  tests. The follow-up above aligns reserved names with the controller contract.
  Runtime declarations and fixture
  membership are unchanged; the new shipping source must be frozen and rebuilt.
- The owned image workflow `37621428993`, pinned to `efd4`, remained unassigned
  on the EC2 fleet. A concrete GitHub-hosted Linux fallback patch is prepared,
  preserving maintainer authorization and source pins. The explicit workflow
  exception approval remains pending; no workflow edit, merge or deployment was
  performed. Real accepted Product/Runner qualification still needs 26 + 7
  passes on the corrected installed artifact set. Historical passes do not transfer.
