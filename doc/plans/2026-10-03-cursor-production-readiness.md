# Cursor production readiness — 2026-10-03

The release scope is Cursor CLI `2026.09.26-dd393fe` on macOS ARM64, macOS x64,
and Linux x64 (including Daytona). Qualification uses the explicitly selected
`gpt-5.6-luna[context=272k,reasoning=medium,fast=false]`. Native AskQuestion and
authoritative per-run USD accounting are excluded from certification. Semantic
Paperclip questions remain the supported question path. Unknown usage is unknown.

The proposed release supports authenticated Paperclip tools, semantic questions,
native plan decisions, permission control, rich activity, file delivery, durable
responses, cancellation and warm continuation. The matrix below records the
completed local and fresh Daytona proof for those capabilities.
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

## Bounded declaration cleanup — 2026-10-06

The PR audit found duplicated release tuples in Rust descriptor validation,
duplicated model rules in Rust session validation, and independent pins in the
TypeScript profile registry, provider-pack builder, server pack verifier, and
Cursor installation code. `packages/paperclip-runner/acpx-profiles.json` now owns
the release/profile declarations; generated TypeScript and named Rust structs
share them. Following review, all ACPX harnesses now accept any explicit model ID;
the native provider must acknowledge that exact selection before prompting.
The release manifest and generated runtime declarations contain no model names
or model allowlists. Qualification choices live only in evaluation fixtures.
Server admission calls the same resolver. Existing Claude/Grok product defaults
are named separately; Cursor and Codex ACP still require explicit selection.
Cursor closure pins are generated from the existing distribution manifest.
Build and typecheck reject declaration drift, including mismatches with the
Cursor release attestation and installed dependencies.

The former Codex ACP and Pi single-model restrictions are removed, including
the redundant restriction in the developer test-drive UI and server. Provider
rejections and effective-model mismatches still fail without a fallback. Pi and
Copilot remain pending providers; their operator-scoped qualification gates are
unchanged. This change does not claim live qualification of additional models.

All provider versions, digests, and recovery identity fields retain their previous
meaning. A regression check pins the pre-cleanup
Cursor recovery digest. Historical rejection fixtures and evidence keep their
original identities. Cursor launch flags, credential names, and native extension
translation remain provider-adapter responsibilities; generic mode, lifecycle,
permission, and transport contracts retain the earlier cleanup.

This is a source cleanup after the live qualification recorded below. Its checks
do not relabel the earlier package/image as a build of this source, and no further
paid qualification or release is implied.

## Final installed-release qualification — 2026-10-06

This qualification follows the generic mode and provider lifecycle cleanup. Its
frozen application source is `d7b696f9b8f79095233e9e3d56d23e6a6018dd48`.
The public controller packages use source `3d0c9b7761c61eb56628ea1778b1f3ca50fe817f`;
that source adds only a fixture correction. Fixture commits through `646795e8f` change qualification
fixtures and documentation, with no changes to `cli/src`, `server/src`, `ui/src`
or `packages` relative to the frozen application. Historical results below retain
their original source and artifact identities.

The tested public version is `0.0.0-cursor-verify.3d0c9b7761c6`. Cursor CLI
`2026.09.26-dd393fe`, profile v11, patch `paperclip-cursor-usage-v4`, and explicit
model `gpt-5.6-luna[context=272k,reasoning=medium,fast=false]` stayed fixed.
The native distribution/profile digest is
`sha256:2feb50c7b0a317dff454c00115a5bbe4d5c757189691586577be9c80234d477e`.
The resolved build-lock SHA-256 is
`89e5164aa79945655d253f30540c86a620e9df434299af4f1325727dbf5edf47`.
The tracked lockfile was not changed.

| Packaged artifact | SHA-256 |
| --- | --- |
| macOS ARM64 daemon | `816c6603b4ef05ab29cc22a8b6cae9989469a8233bdedc3c97aae22a0c1c6abc` |
| macOS x64 daemon | `372524b322f1200f1708288d0497195477ecf984e21dd32f3ddc2f2038465199` |
| Linux x64 daemon | `d5a22554c922087f122ceeb0e7527529221c41af171b37315469c838dede0288` |
| Public `paperclipai` tarball | `14a96c7de0c20cde231782f54ce0df76c1d6a81512f0c5b38a08ec8e8786631a` |
| Public server tarball | `6e66d37c3ee4d61b66bbc5f2515550a246d8afc8a10b5425c064f5ec3f661d66` |
| Public Daytona plugin tarball | `a6cf4e9070503757be0505d6a1a8df219dca493f801831b3cc1ca83a185d07db` |

The immutable qualification image is
`ghcr.io/paperclipai/paperclip-daytona-runner@sha256:d6259b6bba094702c13fc2283bd85550849c1c53145b656fb2746778f9fa1747`.
Its Linux provider-pack digest is
`sha256:1916578945ba709e00904688792e50bedf505d45d69cc2023a4c95235c86cb18`.
The complete extracted pack passed verification. Anonymous registry inspection
confirmed the published OCI index and amd64 image. This publication does not
publish an npm release or deploy production.

Clean public-package installation passed on macOS ARM64, macOS x64 through
Rosetta, and Linux x64. Normal npm lifecycle scripts ran; Cursor remained absent
until explicit `paperclipai runtime setup cursor`. Setup verified the pinned
closure, and normal resolution launched each platform's packaged daemon without
candidate or asset overrides. The x64 Mac proof covers installation and daemon
startup under Rosetta, not a separate native Intel live campaign. The public
Daytona plugin was built, packed and installed with its own dependencies. Its
version matches the controller packages. Live cells use that installed CLI and
plugin, company secret bindings, ordinary production admission, and the immutable
image. Repository loaders and qualification overrides are absent.

### Post-qualification mainline reconciliation

Mainline `16b7db35ffa0f9a95913c8cbdeea3d595435691f` was merged after the
frozen campaign. The only conflicts were the fixture catalog count (now 504)
and flow dispatch in `tests/runner-e2e/runner.spec.ts`; both retain the Cursor
coverage and mainline's plan-task cases. The native selected-response consistency
wait remains intact. This reconciliation does not rebuild or relabel the tested
artifacts. Final PR checks validate the combined source separately. Release the
qualified package/image pair above; any later package or image needs release
verification against its own identity.

The first CI run of the merged source lost five workers to simultaneous runner
shutdowns. A single infrastructure repeat recovered four jobs; the remaining
server shard hit a 10-second override in the legacy Cursor sandbox command test.
That unchanged file passed all five cases in a focused local run. The test now
inherits the server suite's existing 15-second limit, as its adjacent explicit
command case already does. Assertions and production code are unchanged. The
shutdowns and timeout remain recorded; they are separate from the live campaign.

### Final live acceptance matrix

All 18 required cells passed, including cleanup: nine local and nine Daytona.
These are real Cursor sessions through the installed product. Each cell used
the same frozen runtime, explicit model and normal company credential path.
There were 23 attempts; the five failed attempts remain recorded below.

Campaign IDs have prefix `cursor-v11-final-d7-installed-`, followed by
`<environment>-<case>-<attempt>`. The table gives the passing attempt number.

| Case | Local | Daytona | Cleanup |
| --- | --- | --- | --- |
| `hello-complete` | Pass (02) | Pass (01) | Both passed |
| `file-edit-validate` | Pass (01) | Pass (01) | Both passed |
| `structured-question-restart-resume` | Pass (01) | Pass (01) | Both passed |
| `native-plan-reject-revise-accept` | Pass (01) | Pass (01) | Both passed |
| `native-plan-cancel` | Pass (02) | Pass (01) | Both passed |
| `native-write-deny-reconnect` | Pass (03) | Pass (01) | Both passed |
| `pending-permission-stop` | Pass (01) | Pass (01) | Both passed |
| `warm-three-turn` | Pass (01) | Pass (02) | Both passed |
| `pending-permission-provider-loss` | Pass (01) | Pass (01) | Both passed |

Questions survived controller restart and consumed the answer once. Native plans
verified rejection, revision, acceptance and cancellation; accepted planning runs
succeeded while tasks remained open awaiting explicit direction. Denied writes
stayed absent. Stop cancelled the real pending permission and retired owned
processes. Warm continuation preserved three turns and selected persisted replies.
Provider loss expired undeliverable input without automatic mutation replay.
Changed file bytes, validation results and accessible artifacts were independently
verified. Every selected result has complete evidence and no reported evidence
leaks or missing evidence.

### Retained failures and bounded fixture repairs

Every paid attempt ran serially with automatic retries disabled. Four local attempts and one Daytona attempt remain failed; none is relabeled or removed:

- `local-hello-complete-01`: the old task-creation helper expected the removed
  title field. It failed before creating a task or starting a provider. The
  repaired helper uses the prompt-only composer and captures the real creation
  response ID. Its diagnosed repeat passed.
- `local-native-plan-cancel-01`: native cancellation, exact decision delivery,
  terminal task/run state, workspace immutability, and cleanup passed. The model
  inserted `PLAN` into the requested exact summary marker. This remains a
  model/provider behavior failure. One repeat with the identical prompt and
  assertions passed; the repeat does not erase the original failure.
- `local-native-write-deny-reconnect-01`: the provisional task title caused an
  earlier task-naming permission request. The strict fixture waited for its
  exact write command and timed out. Native permission fixtures now create an
  explicit title through Search's public creation action before starting the
  provider. No policy or provider prompt changed. The original full cleanup
  grade remains failed because denial proof was incomplete. Its complete process
  journal was empty, a later identity check confirmed all ten owned processes
  were gone, and the continuous watcher recorded no target mutation.
- `local-native-write-deny-reconnect-02`: the exact write was denied and the task
  became Blocked, but the fixture expected the old Cursor-specific error text.
  The provider lifecycle cleanup correctly emits the provider-neutral diagnostic.
  The fixture now accepts that exact diagnostic and the exact historical one;
  all request, command, turn, terminal, no-replay and no-effect requirements stay
  in place. The original failed cleanup grade remains recorded. Its process
  journal was empty and its continuous watcher recorded no target mutation.
  The subsequent live repeat completed every required assertion and cleanup.

- `daytona-warm-three-turn-01`: all three runs and file updates completed, but
  the fixture stopped its response wait on an earlier deliverable-preparation
  comment. The final marker was persisted 53ms after the final run finished and
  is present with its selected-comment receipt in the retained fallback evidence.
  The original verdict remains failed and cleanup passed. The consistency wait
  now hydrates the native run detail and requires its actual selected comment;
  it cannot substitute a finish summary or a file-preparation message. The
  affected repeat passed with unchanged prompts and continuity assertions.

The shared browser helper also received a review fix for remembered project
selection. Credential-free browser checks create repeated tasks, switch projects,
and verify ordinary and explicit-title creation in standard, planning and ask work modes with
paused agents. All three checks pass without provider runs. Fixture typecheck,
1,627 Vitest checks (one skip), and 128 Node checks passed; the final diagnostic
repair passed 150 focused native lifecycle checks. A failing provider-free search
probe remains retained; the corrected probe scopes the exact phrase to tasks.

The existing seven Runner semantic passes and seven strict accounting failures
remain historical results under their original build identities. This campaign
is the focused 18-cell installed-release selection, not a rerun of the full
catalog. Native AskQuestion and authoritative per-run dollar accounting remain
excluded. Per-run USD remains unknown. The original $100 total budget is bounded
by the existing $25 account-cycle cap plus retained commitments and infrastructure
reservations. The conservative committed/reserved total is $88.080380624, leaving
$11.919619376 unreserved; these are spending bounds, not measured provider spend.

<details>
<summary>Exact result receipts for all 23 attempts</summary>

Each result lives under `tests/runner-e2e/results/<campaign>/<suite>/runner-acpx-cursor/<environment>/<case>/attempt-1/result.json`.
The full campaign prefix is defined above. The SHA-256 identifies the original
result file; later diagnoses do not rewrite its verdict.

| Campaign suffix | Verdict / cleanup | Result SHA-256 |
| --- | --- | --- |
| `local-hello-complete-01` | failed / passed | `59d8dc9194ee74fe1cd9827103f2734abb5e14d81232280d80ffdb5f6dede9e7` |
| `local-hello-complete-02` | passed / passed | `e4c0839d417ee7de3d79d5c5898d7ad05fbe1c66103979cdea470a422ec1a0d2` |
| `local-file-edit-validate-01` | passed / passed | `d45f3b2975c9ac359e969940b2209f47096cfdcebd3302c6ab42d1933e1df351` |
| `local-structured-question-restart-resume-01` | passed / passed | `0ad49f9833236998b597a245de05ca7c05208865c0c5f50d944607b07242b2f9` |
| `local-native-plan-reject-revise-accept-01` | passed / passed | `07d83d372061894812e6751679fa4f3dfb1754989aaa63a4ca6828578504ca91` |
| `local-native-plan-cancel-01` | failed / passed | `dd22d0cfd3366fbebf041807401d16ff327e92b05e08521b220613df68fc2b1e` |
| `local-native-plan-cancel-02` | passed / passed | `a4b06aefec7570af8f818e2a2705f100e10f2e8bd26fa5a500e25a6f7dc85c11` |
| `local-native-write-deny-reconnect-01` | failed / failed | `aa27b5df8b1220dfa936934666c708f899d663d2b1c3a15faf19de3842af4c4d` |
| `local-native-write-deny-reconnect-02` | failed / failed | `066dbfef92e151b87c31a62f6a8f825af0bbcab8d791b4c0aa448e30e90e3066` |
| `local-native-write-deny-reconnect-03` | passed / passed | `33f8fedad38789d37874e7622e7bcb15227fa2412b8aa2b6ef919a03d3903988` |
| `local-pending-permission-stop-01` | passed / passed | `b8101e2155f4b6bce481ee0cddb6b1c34af71dbe20798081d8821eef2dc4fbe2` |
| `local-warm-three-turn-01` | passed / passed | `65c64e282ef0cb667c89b329c4b0f22104fd0d12c811aa450638bd093d04f2b5` |
| `local-pending-permission-provider-loss-01` | passed / passed | `f8e7dc15fa051081f38f5a08292eeec7c83713964b9fb26304a5a9d2dd6edfb5` |
| `daytona-hello-complete-01` | passed / passed | `787dd287c2d29350b9ad8e48fee73bdaecbdd059342bed44bc9304e5965bbe01` |
| `daytona-file-edit-validate-01` | passed / passed | `bdb575c04162a1a24fc6354a2a284fb156665ea02de2e69be7c250bd211a2bf5` |
| `daytona-structured-question-restart-resume-01` | passed / passed | `d72536f01147e8b7b77c1e82ed34c0faf0c99176700f7c101c95b0b5665d01df` |
| `daytona-native-plan-reject-revise-accept-01` | passed / passed | `3cdb6ef262788f949d44d7d1b84c258d0494968949fb6c010c4496cc07442e5e` |
| `daytona-native-plan-cancel-01` | passed / passed | `48190c0c3338c741aac319cd356dacfe1af011f8bdcea6fbf10d571fe6110211` |
| `daytona-native-write-deny-reconnect-01` | passed / passed | `d89dd8794c5866c3612ab9a60f023dd136740a8525fd0c93feacc7bd0e17f90a` |
| `daytona-pending-permission-stop-01` | passed / passed | `fc7aae403d32d1a587c4caf711bf9cba61cb7206f8c24bfac02175293874ce07` |
| `daytona-warm-three-turn-01` | failed / passed | `528145330b803d21dc25937d3ef768c6dda3bb6583ba35030d69112e8cefbe1a` |
| `daytona-warm-three-turn-02` | passed / passed | `e3e3c295714679ee5e7040f52ebeaf95e9f860bde1b5698fbd2566588a0e161a` |
| `daytona-pending-permission-provider-loss-01` | passed / passed | `e9d15896ae5fe72e239b4fff8dd4fc8743eb309fef084ad46275e681671f7821` |

</details>

## Historical merge-readiness refresh — 2026-10-05

The branch incorporates mainline `72ff3a9f2` without replacing the qualified
Cursor CLI, profile v11, patch or explicit model. Mainline's newer Codex, Claude
and OpenCode pins remain intact. Its global sandbox Cursor CLI is separate from
the native provider's verified 2026.09.26 distribution. Mainline completion
feedback keeps current, company-scoped document links and blocker guidance;
Cursor's explicit final-response format still takes precedence. Both regression
suites are retained. The combined Runner fixture catalog contains 492 cases.

The combined-source recursive typecheck and full build passed. Completion
feedback passed nine regression tests; native completion source/build contracts
passed 128 tests; token gates passed. Runner fixtures passed 90 files and failed
one cleanup timing test. An unchanged isolated repeat reproduced its 100ms race.
The test now waits for the intended inspection failure before releasing its
child; all 13 tests in that affected file passed. Both failed attempts remain
recorded. This changes fixture synchronization, not production cleanup behavior.
The full default suite and fresh final-head CI/review gates run before merge.

The resolved dependency lock for this combined source has SHA-256
`d3c4cffe7d127d99789cf354c5275246526f5396d2a86ce0d387352f68a2394b`.
The image build verifies that digest before installation. The repository lockfile
matches mainline because Actions owns lockfile updates. The artifact and live
qualification identities below remain historical; they are not relabeled as
new builds. A later release must assemble and verify matching packages and images
from its release source. Merging this PR does not publish or deploy that release.

An additional manual trial used the ordinary installed public package on macOS,
the real local Cursor ACP executable and normal encrypted company credentials.
Cursor generated a 1,777-byte counter page, validated it, registered its deliverable
and finished the task through authenticated tools. The task and run reached
`done` and `succeeded`. Independent download matched the workspace bytes and
SHA-256 `0db0ddc7bcd33aed5fe7e74b2551f1c13403d3a6175239f544cab9a45ad0891e`.
The page rendered in the browser and incremented from 0 to 1 to 2 without console
errors. Native approval requests were approved through Paperclip. The reviewer
did not create or edit the page. This trial uses the previously qualified public
package; it is additional live proof, not a new certification identity.

## Historical qualified release candidate — before generic cleanup

Cursor admission is enabled in [PR #15075](https://github.com/paperclipai/paperclip/pull/15075).
All ten local and ten fresh Daytona gates passed, including cleanup. The final
ordinary installed-product local and Daytona smokes also passed. Pi and Copilot
remain gated. Production merge and deployment are separate actions; the PR must
have green final-head checks before merge.

The frozen native runtime is `d0b90756e3abe9e7516caded784036f01e76ad25`. Cursor
profile v11, patch `paperclip-cursor-usage-v4`, CLI and exact Luna model remain
fixed. The native command digest is
`sha256:2feb50c7b0a317dff454c00115a5bbe4d5c757189691586577be9c80234d477e`;
the ACPX patch SHA-256 is `bd5393058a218040d217fa85449d59a6f30507de54cd645bf0ef21422823f85e`.
Promotion and matching provider packs use source
`630ed8613191b6875ad448ecdfe067089f3696d9`. The public controller includes the
installed-readiness repair at `2684979803dee739563eb6db9e6137c3755dd320`.
All three source daemons and all three Cursor native closures match the qualified
artifacts byte for byte. Release assembly re-signs copied macOS daemon inodes;
the table below records the resulting packaged hashes. These source roles do not replace historical identities.

| Required case | Local proof | Fresh Daytona proof |
| --- | --- | --- |
| Completion through authenticated tools | `hello-complete-01`: pass, cleanup pass | `hello-complete-01`: pass, cleanup pass |
| File edit, validation and registered download | `file-edit-validate-02`: pass, cleanup pass | `file-edit-validate-01`: pass, cleanup pass |
| Semantic question after controller restart | `structured-question-restart-resume-01`: pass, cleanup pass | `structured-question-restart-resume-01`: pass, cleanup pass |
| Semantic plan approval and completion | `plan-approve-complete-01`: pass, cleanup pass | `plan-approve-complete-02`: pass, cleanup pass |
| Native reject, revise and accept | `native-plan-reject-revise-accept-01`: pass, cleanup pass | `native-plan-reject-revise-accept-01`: pass, cleanup pass |
| Native plan cancellation | `native-plan-cancel-01`: pass, cleanup pass | `native-plan-cancel-02`: pass, cleanup pass |
| Denied write after reconnect | `native-write-deny-reconnect-01`: pass, cleanup pass | `native-write-deny-reconnect-01`: pass, cleanup pass |
| Stop during pending permission | `pending-permission-stop-01`: pass, cleanup pass | `pending-permission-stop-01`: pass, cleanup pass |
| Three warm turns | `warm-three-turn-01`: pass, cleanup pass | `warm-three-turn-01`: pass, cleanup pass |
| Pending permission followed by provider loss | `pending-permission-provider-loss-01`: pass, cleanup pass | `pending-permission-provider-loss-01`: pass, cleanup pass |

Local identities start `cursor-v11-d0b907-local-`; remote identities start
`cursor-v11-d0b907-daytona-`. Results are under
`tests/runner-e2e/results/<identity>/<suite>/runner-acpx-cursor/<environment>/<case>/attempt-1/result.json`.
The local file repeat uses controller/fixture 473206; the other local cases use
5e6c16. The remote semantic plan repeat and native decision case use 473206;
remaining remote cases use AFE diagnostics. All use the frozen native runtime.
Automatic retries are zero. The file gates independently download the registered,
run-attributed attachment and verify its bytes, size and SHA-256.

All seven Runner semantic cases passed with owned processes retired:
`get-task-context`, `context-before-action`, `create-task-document`, `finish-task`,
`request-human-confirmation`, `workflow-context-document-progress`, and
`workflow-governed-wait`. Their identities start `cursor-v11-d0b907-` and end `-01`.
All seven strict scores remain `accounting_failure` for
`provider_budget_coverage_unknown`; per-run USD is null. They are semantic passes
and accounting failures. Native AskQuestion and complete accounting are excluded
from certification.

### Exact final artifacts and ordinary installation

| Platform | Final provider-pack manifest digest | Packaged daemon SHA-256 |
| --- | --- | --- |
| macOS ARM64 | `40377a1641a434785109a12895af74dbde4ff978a510b126059039306fdd2e6a` | `33bb9276b4d79be33f77c89a76ab71946808583500c6200a144b324479fbd9d8` |
| macOS x64 | `a7ba83592a05546ca0aa327b188d8c6991b32d764dc02565b78a8102e7ea76d1` | `1bcd1bdc015f15a8321c9564d008284fd105da4f019632ff81ba0c9f75ae28d7` |
| Linux x64 | `6a32a7955c56f7eec26272cde996faa20e678146480ffb95bc909abe25fd0adb` | `34d1b96550669613e91b3df75752164609ddfbeec70ea821e540558f8a96ddb6` |

The final image is
`ghcr.io/paperclipai/paperclip-daytona-runner@sha256:681b56d2e2fcbde12f6677fbd54c617bfcc66df43a02c267bb355d46e16e7caf`.
Its source is 630ed. Publication returned this registry OCI index digest;
independent registry inspection confirmed it. The image's provider-pack file
SHA-256 is `723451cf01d4538693884bc37ece71ff31e64dfc2254e4b8fd5386bf23fb81da`.
The complete extracted tree passed manifest verification before publication.
The public server ships that exact manifest as its expected Linux image identity.
A macOS controller uses its packaged Linux daemon. A mismatched image fails before
provider launch; it does not stage borrowed assets or download a replacement.

The tested public package version is `0.0.0-cursor-verify.2684979803de`.
CLI tarball SHA-256: `e67396bf8baa9d4e2d2298d1064a24f495730e84ac428016ab32554906ca25ad`.
Server tarball SHA-256: `f3dbc5dd00a45bbd668fd23b36bebd069feaa54b2e6209d87618a7037f8583cc`.
The separately installed public Daytona plugin uses the same test version;
its tarball SHA-256 is `e991dfc10804c2ec08c9f0a7ed99b0b59761c2edc4d6fa4e1c8540e23b21ca61`.
Its dependencies are isolated as in the product plugin installer.
The complete resolved build lock SHA-256 is
`70af8ab3d7051c85fc1a55c11e9afe8887d9711232e3c6e97666006562217e5f`.
Repository policy leaves lockfile commits to Actions.

The public verifier passed for 18 packages on the isolated consumer image
`node:24-trixie@sha256:be40f6a87b9b22215ddb20da0a2320a5c6d583fe3ee3b0024d9fa4f05b40c8fd`.
It enabled npm lifecycle hooks, verified the lifecycle sentinel, proved Cursor
was absent after npm installation, ran public pinned setup, verified all three
daemon targets, launched the installed Linux daemon, and passed the installed
Cursor configuration probe. Provider calls were zero. A fresh macOS consumer
installed the same tarballs with normal lifecycle hooks and public setup; its
installed configuration probe also passed without credentials.

| Final ordinary installed smoke | Fixture source | Outcome | Result SHA-256 |
| --- | --- | --- | --- |
| `cursor-v11-268497-installed-local-file-edit-validate-01` | `b9a0180c1a96cf0fd0448cc69d6f47a5de8d258e` | 8/8 matchers, cleanup pass | `26cdd34a8b7c3dc19f0afd3cf94c22e1700bad217d2af92877aeb10dbe1f58bc` |
| `cursor-v11-268497-installed-daytona-hello-complete-02` | `327f6df095d38f0e2213cb4572376e01d4629946` | 6/6 matchers, cleanup pass | `7f2f23d1c5dec8e030866781cc09e06990d5149758c0d467df49e63366b29dd1` |

These launch the actual installed `paperclipai/dist/index.js` from its consumer
root. The server removes qualification admission, native binary paths, provider
pack overrides, repository executables and TypeScript loader injection. Credentials
use company secret bindings. The Daytona plugin is a compiled public npm package
installed through the normal plugin API. Image selection uses the normal
environment configuration surface. Task results were reloaded and inspected.
The local gate verified the registered download independently. Remote cleanup
confirmed destruction of the owned environment lease.

### Retained failures, validation and budget

The qualification image was
`ghcr.io/paperclipai/paperclip-daytona-runner@sha256:16c7be3610f45e409f67873dd4bd829f9a1e0e5f017c8826d01db4bb05720f97`.
Its registry push and independent inspection confirmed that OCI index, with Linux
amd64 manifest `sha256:c70f25e76503ce2d9cc1f87ed5a221f8e423f4a45f5519e8aa0581b033be353e`.
Docker's local containerd store uses the same index identity; it is not an inferred
registry digest. All twenty matrix cells retain the frozen artifact identities.

Remote semantic-plan attempt 01 failed before a provider call because seven empty
directories were absent from the controller extraction. Every file byte matched
the image; restoring its exact directory inventory passed the unchanged manifest.
The failed result and successful cleanup remain recorded. Native cancellation
attempt 01 lacked a complete terminal observer receipt and failed its cleanup
gate. Independent deletion of its owned sandbox was confirmed. Diagnostic-only
AFE fixture changes retained all proof requirements; attempt 02 passed with
cleanup. This does not establish a product bug fix or erase the original failure.

The first installed remote smoke used the workspace plugin and failed before a
run or sandbox allocation, with cleanup passed. The fixture now validates a public
compiled plugin in its own installed dependency directory; the affected repeat
passed. A separate credential-free public probe exposed a development-only Runner
import in the installed configuration check. The production fix uses the vendored
boundary, and the stronger public verifier and both installed smokes pass.
The final fixture also checks the selected public plugin's release version and all
compiled entries. A credential-free repeat against the exact installed plugin
above passed; missing or mismatched version tests reject stale artifacts. This
adds an admission check without changing the certified plugin or provider behavior.

Promotion checks passed: recursive typecheck, full build, token gates (1,129 files),
Runner contract/replay checks, 164 focused Runner tests, executor/profile/runtime-mode coverage,
56 readiness-probe tests, 5 vendored dependency tests, 29 installed/admission fixture
tests, 56 plan-wait tests, fixture typecheck and 9 UI option tests. The new plan-wait
case preserves valid v11 waits saved with pre-promotion admission metadata;
incompatible profile identities remain fenced. Original failed test attempts are
retained separately from their affected successful repeats. The latest default
local command passed all general groups and 107 serialized route suites, then
failed on a socket hang up in `issue-thread-interaction-routes.test.ts`. The
isolated affected repeat and all remaining 43 suites passed with unchanged source,
completing all 150 serialized suites. The failed command remains failed. No
unrelated route repair was made. Final recursive typecheck passed again. Repeated
assembly exposed a read-only manifest overwrite failure; assembly now replaces
that manifest atomically, and the server copy can replace an existing read-only
inode. Two isolated assemblies preserved all three packaged daemon hashes and the
exact Linux manifest SHA-256/mode. The affected full build and its unchanged
repeat passed. The PR's live
checks show final-head CI; green checks are required before handoff. Historical
verification below retains its original source and outcomes.

The user reconfirmed all remaining work on 2026-10-04 within the original $100 total
ceiling. Prior committed upper bounds total $47.080380624; the remaining envelope
is $52.919619376. Infrastructure reserves total $29, including diagnosed repeats,
normal installed qualification and uncertain allocation. There are 26 recorded
remote attempts and no active paid cells at this checkpoint. The existing $25
Cursor account-cycle cap is counted once, not added again. Reservations are not
measured spend. Per-run Cursor USD remains null.

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
- [x] Qualify normal setup/completion locally and on Daytona.
- [x] Qualify file editing, independently checked bytes/validation and accessible artifacts on both targets.
- [x] Qualify semantic questions/restart with exactly-once answer consumption on both targets.
- [x] Qualify native plan reject/revise/accept/cancel and correct task/run states on both targets.
- [x] Qualify denied writes and Stop during pending approval, including owned process retirement, on both targets.
- [x] Qualify three warm turns with stable session/workspace/agent-files ownership and no duplicate output on both targets.
- [x] Qualify provider loss, input expiry and actionable errors without mutation replay or false success.
- [x] Run seven semantic Runner cases; retain strict accounting results separately.
- [x] Promote Cursor after the complete local and Daytona matrix; leave other pending providers gated.
- [x] Run contracts/replay, token gates, recursive typecheck, full tests and build; retain failed local attempts and verify affected repeats separately.
- [x] Repeat clean normal-install local and Daytona smokes with qualification and runtime overrides absent.
- [x] Deliver exact identities, capability limits and completed acceptance matrix; prepare focused template-based PR.

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


## Provider-neutral mode boundary (2026-10-05)

The pre-release implementation put `CursorMode` / `cursorMode` into shared Rust,
native execution, sidecar and recovery contracts. The production port now carries
an opaque bounded `mode` identifier through those contracts. Rust does not define
Cursor's Agent/Plan/Ask vocabulary or enforce Cursor-only mode selection.
The provider mode capability registry delegates supported values, defaults, native
translation and acknowledgement to the Cursor adapter. Other adapters must qualify
mode support before registering it; unsupported selections still fail before a
provider prompt. Product configuration remains `acpxSessionMode` with Agent as the
Cursor default. Session lifecycle and permission policy remain separate controls.

Exact mode equality remains part of the immutable session key, observed identity,
warm continuation, suspension checkpoint and controller recovery checks. Generic
transport tests also cover non-Cursor identifiers such as `architect` and
`custom/build`. Missing or changed observed modes cannot recover an existing
mode-bound session. The pre-release `cursorMode` input and checkpoint format is
fenced rather than silently converted or defaulted. Only inspection of an already
committed accepted-plan wait may read its old field. That path verifies the original
unchanged acceptance proof and preserves task history; it cannot admit a new wait
from an old field. A regression covers both preservation and attempted rewriting.

Validation of the updated source: recursive typecheck, full build, all Rust Runner
checks (646 passing test invocations, including conformance/replay repeats), 254
focused Runner TypeScript tests and 584 focused server tests passed. The complete
Runner TypeScript run passed 67 package contracts and 2,587 Vitest cases, with one
failure and ten skips. Its sole failure selected a preserved pre-release daemon
from the old three-platform staging directory: that daemon expected OpenCode
1.18.32, while current source expects 1.18.34. The historical platform set and
manifest were preserved separately; the current-source daemon remained staged.
The affected case and all 15 ACPX transport cases passed on a focused repeat
against that daemon. The original failed run remains retained. New-head PR checks
and review must complete before merge. No new paid provider cells were run for this architecture change.
Historical live qualification, image, package and review identities above remain
historical evidence and are not relabeled as certification of this new source.
Release assembly must build matching daemon, sidecar and controller artifacts.
Auto-merge is disabled while the updated boundary receives review.

## Bounded provider-boundary cleanup (2026-10-06)

The shared ACPX event decoder validates bounded parent-tool identities and the
event's run/turn scope. Native RPC recognition stays in the Cursor adapter before
sidecar emission. The runner's authenticated-run-grant attachment policy is now
an explicit, runner-owned provider capability selected after pinned-profile
validation. Cursor remains the only provider opted into that policy. Its identity,
authority, pending-work and unknown-context-field checks are unchanged.

The controller settles accepted plans and permission declines through a provider
lifecycle adapter. Cursor owns the native method names, mode interpretation,
accepted revision interpretation and qualified-profile recognition. Shared code
owns committed event correlation, delivery acknowledgement, tool lifecycle,
status arbitration, receipt hashes and recovery suppression. No other provider
gains these settlement capabilities. New receipts use `native_plan_wait` and
`planWait`; a separate read-only decoder retains exact committed Cursor receipts,
including the earlier unbound-tool profile. Mixed or relabeled receipt formats
are rejected. Legacy receipts cannot authorize new waits or implementation work.

Historical profile-version compatibility now lives in provider metadata. The
generic live-session handler delegates optional notice validation to a provider
adapter. Cursor's partial counters retain their closed diagnostic format and
never become measured usage or spend.

Focused checks cover normal and historical plan-wait replay, tampering, foreign
scope, unsupported adapters, permission declines, optional diagnostics and Rust
event projection. No new paid provider cells are part of this bounded cleanup.
Historical live results keep their original build identities; new release
artifacts still require matching source and qualification.

## Model selection and activity adapters (2026-10-06)

The bundled ACPX dependency still checked model discovery catalogs after the
Paperclip allowlists were removed. The package now forwards an explicit model ID
unchanged, including IDs absent from the catalog. It does not expand Cursor IDs
into advertised variants. A native selection response must acknowledge the exact
ID. New connections recheck the selected model after session load; rejection,
mismatch, or missing model controls prevent prompting without a fallback.

Fourteen package-level regressions exercise the real installed ACPX manager and
ACP wire with offline provider fixtures. They cover all six adapters, startup,
loaded-session continuation, incomplete catalogs, rejection, missing controls,
mismatched acknowledgements, and Cursor alias handling. These are dependency
integration tests, not paid model calls or new live qualification.

The shared driver and sidecar obtain native tool identity, evidence, and optional
usage projection through provider activity hooks. Cursor owns those hooks and its
partial usage receipt parser. Capability metadata no longer describes Codex or Pi
models as `exact-qualified`. Generic backend fixtures resolve the release profile
instead of duplicating package versions and hashes.

Cursor profile v13 binds the changed ACPX patch. The generator verifies both the
patch hash and the canonical release-attestation digest before emitting TypeScript
and Rust declarations. Historical profile revisions remain decodable, but a new
launch requires current release identity. The pre-manifest recovery fixture keeps
its original profile and digest; committed plan-wait records remain inspectable.
Existing v11 live evidence and platform artifacts retain their original identities
and do not certify this source revision. The PR verification section records the
repository checks and any outstanding release verification for this follow-up.

## Apex review fixes (2026-10-06)

Apex reviewed `beadd3654bcb1de79c203fb8ddccca714429372b` and returned 3/5
with two release-path findings. Explicit setup now installs the pinned runtime
under the OS account's cache, independently of npm package ownership. Setup and
execution resolve the same closure-keyed path even when the provider has an
isolated HOME. Image-owned assets remain authoritative. Setup must run as the
Paperclip service account; it does not make root-owned private assets public.

Release assembly requires the Linux image manifest and verifies its canonical
payload digest, source revision, ACPX profiles and Cursor version/profile/closure
against current source pins before writing staged assets. The controller also
checks current Cursor identity in both normal and legacy inventories. Rehashing
an old manifest cannot authorize it. These checks use existing release metadata;
they introduce no model catalog or model restriction.

Verification: 12 installer-layout and release-assembly Node checks, 656 ACPX
tests (seven skips), and all 530 native-session executor tests passed. Recursive
typecheck and the full build passed. Initial sandbox runs failed on host IPC and
private runtime-directory permissions; the same suites passed with those host
facilities available. A fresh built provisioner installed the real pinned Cursor
distribution from a read-only public server package layout on macOS ARM64. The
ESM repeat verified the same cache, and runtime admission verified a private
execution snapshot without spawning a provider or sending a model request.
The package stayed read-only and contained no downloaded runtime. Historical
live matrices retain their original identities; these fixes do not certify a
new v13 package/image combination. Follow-up Apex and CI results belong to the
PR head reported by GitHub.

The second Apex pass scored 4/5 and found that the Linux public-install smoke
still used the old package-owned path. Its sandbox now supplies an unprivileged
passwd entry and a persistent account home. Setup and the offline probe mount
the installed package read-only; the probe expects the source-pinned closure in
the account cache. Both npm lifecycle execution and explicit setup must leave
the package without Cursor assets. The 137 release-registry checks pass,
including eight sandbox checks. A focused Linux x64 container run downloaded
the real pinned distribution, repeated setup offline, and verified the private
runtime snapshot with provider HOME redirected. It used no repository mount,
credentials, or model calls. This exercises the corrected installer/cache path;
it is not a new full public-package graph, daemon, or live-provider qualification.

## Mainline reconciliation after Apex (2026-10-06)

The merge preserves mainline's revised child-completion wake and finalization
checks together with Cursor's committed plan-wait authority. Provider selection
uses the current shared Select control while retaining Cursor admission and mode
binding. Browser fixtures preserve attachment completion, project focus handling,
and exact creation-response identities; they do not recover task IDs by generated
names. The merged catalog contains both Cursor and connection acceptance cases.

Cursor profile v14 binds the combined ACPX patch: mainline's ACP resource-not-found
response for missing files plus the reviewed exact-model and Cursor lifecycle
changes. It adds no model restriction. TypeScript and Rust release declarations
are regenerated from the existing source manifest. Earlier v11 live results and
v13 Apex results retain their original identities. The merged artifacts still
need their own release qualification before publication.
