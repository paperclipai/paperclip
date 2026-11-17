# Runner startup latency evidence

## Master reconciliation — 2026-10-19

The user authorized updating PR #16493 to current `origin/master`, passing its
checks, and merging it. The performance changes now stand alone on master
`f3cd3f4ea8`; the unmerged Claude protocol, default, and platform PRs remain
separate. Master's concurrent native-artifact preparation and provider verification
remain intact. The stale stacked-branch workflow assertion is excluded.

The original branch is preserved as
`archive/claude-startup-latency-pre-master-20261019` at
`ca3833fe8e4ca8f9fcc47e66041cb0f3cbab3b31`. The dated evidence below describes
its tested deployments, not a deployment of the rebased source. Fresh local verification passed 44 archive/provider tests and all token gates.
Review found that custom hosts with incompatible tar or no checksum utility
could enter archive staging and fail. Both archive formats now check the full
extraction tool set before staging. Six isolated-PATH regressions cover BSD tar,
older GNU tar, and missing sha256sum; unsupported hosts retain directory staging.
The first cloud policy job used the old stacked base from its push event and
incorrectly counted master's lockfile changes; a new push after retargeting uses
the current master base. Fresh source
verification is recorded in [PR #16493](https://github.com/paperclipai/paperclip/pull/16493).
Docker and Rust builds remain in cloud CI. No new paid provider runs, deployment,
or fleet image changes are part of this merge request.

### Startup latency delivery — 2026-10-15

Owner: this chat, isolated `codex/claude-startup-latency` worktree based on
`6bb6159cdfe088bb2cc5ee5adad5de829f576c15` (runtime `15e37379e94535fd9692a4f0c4d3fadd2595b188`).
The user requested trace-led diagnosis and a fix on the dedicated test workspace.
This remains within the $50 qualification ceiling; Docker/Rust builds stay remote.
No merge, production rollout, or fleet-wide image change is authorized by this work.

| Acceptance | Baseline | Required evidence |
| --- | --- | --- |
| Fresh sandbox startup | 133.446s native startup; 122.117s pack upload | Under 30s to prompt admission; timing/trace from exact serving source |
| Follow-up in a new sandbox | 136.285s resume; 125.798s pack upload | Under 30s, same provider session, successful artifact revision |
| Runtime admission | Older managed snapshot; verified pack fallback uploads | Exact pack/daemon identities, full integrity/architecture checks retained |
| Correctness | Two downloaded versions verified | Independently download new outputs and verify revision plus session continuity |
| Regressions | Shared native transport, staged/preinstalled/upload paths | Focused existing tests including corrupt/mismatched pack rejection; applicable CI |
| Deployment | Dedicated test organization only | Recorded startup spans and healthy target, usable preview, reviewable delivery |

The first experiment makes no paid Claude prompt: separate archive creation,
transfer, and extraction, inspect the snapshot's preinstalled identity, and test
the verified preinstalled path. Existing run-log spans already locate the critical
path. Honeycomb had no matching exported trace for the first run; local native
spans provide before/after measurement without changing the operator endpoint.
Evidence directory: `/private/tmp/claude-startup-20261015/`.

The owned no-prompt snapshot probe confirmed a preinstalled pack from source
`4a8178e9cf40bf77d1a22a2dc6ddc1a7d5189eae`, not the serving runtime. The pack
occupies 2.0 GiB. A bounded cloud compression experiment over 2,125,271,040 tar
bytes measured gzip 66.409s / 763,211,573 bytes and zstd 17.687s / 711,973,704
bytes. These isolate compression on the sandbox CPU, not the exact controller's
historical phase breakdown. Both owned probe sandboxes were deleted; no provider
prompts were issued. The first benchmark approval was rejected under the mistaken
assumption that it uploaded the pack. Inspection established that only a 1,640-byte
script was uploaded and all pack/archive bytes stayed in the sandbox; re-review
approved that same command.

The optional Honeycomb export setup would require refreshing an expired AWS
secret-store login. The user questioned that need; this work proceeds without it.
Existing native startup spans remain the before/after acceptance authority.

The matching image build passed all 22 CLI/runtime identity checks in cloud run
[38803382803](https://github.com/paperclipai/paperclip-cloud/actions/runs/38803382803).
Candidate `fleet-sandbox-image-1791979001546`, snapshot
`fleet-sbx-040bf1ccbc2a-c19a1bc17412`, uses exact app image
`ghcr.io/paperclipai/paperclip@sha256:733f5cafb09c3d743b86fc2bdecf38077bde7db5cc55eb35ce017c1cd720e7ca`.
It remains unpromoted: current sandbox-image campaigns require fleet-wide default
promotion before targeting a stack. Avoid widening this task's rollout. Instead,
the runtime fix precompresses the app-owned pack at build time and uses its
hash-bound archive for the existing upload fallback. This improves the dedicated
workspace without a global image promotion. Actual deployed latency is pending.

The actual fallback transport was then measured without model prompts using a
public qualified pack from `557c3064a30779e86e1ae312eab3d1d42c3a8b8d`.
Prebuilt gzip: 0.878s controller verification, 4.184s transfer, 16.340s extraction,
0.482s artifact verification. Prebuilt zstd through the actual Daytona
`performSyncIn` implementation: 0.788s verification, 0.076s capability probe,
6.009s transfer, 7.767s extraction, 0.412s artifact verification. All declared
artifact hashes matched; both owned sandboxes were deleted. Receipts are
`transfer-result.json` and `transfer-zstd-result.json` in the evidence directory.
These are transport probes, not a deployed application startup claim.

The implementation uses build-time zstd with an explicit remote capability
probe. Missing archives or missing remote zstd retain directory staging;
malformed or corrupt archives fail closed. Source/custom installations and
verified staged/preinstalled pack selection retain their existing behavior.
The compressed sidecar adds approximately 0.98 GB to this measured image's
uncompressed layers; it trades one build/pull cost for every fresh sandbox's
repeated CPU work. Actual target image size will be recorded after the build.
Eleven archive contract tests pass. The focused native selection/transport suite
passes 56 selected tests. Local full server typecheck has fourteen pre-existing
missing/stale dependency errors; broad verification runs in a clean cloud job.

Performance PR: [16493](https://github.com/paperclipai/paperclip/pull/16493),
stacked on the existing platform PR. Review identified redundant compression in
the shared Daytona file mapper and a missing zstd test-host gate. The mapper now
recognizes gzip/zstd content headers without relying on filenames. Thirty real
file-sync tests and eleven archive tests pass. Broad source verification and the
single-target deployment are running remotely; the first deployment watcher was
stopped before rollout so the reviewed candidate can replace it. No fleet default
or production setting was changed.


### First startup optimization deployed; follow-up threshold not met — 2026-10-15

Serving source `0215a521fd17ed18ff159f2f13da1e1d98647df2`, image
`ghcr.io/paperclipai/paperclip@sha256:e73177f4cb4158efb97678452041eae4506ad2a1e956eb6a1752fa9bbe5264f9`,
was deployed only to the dedicated QA tenant by
[38811327131](https://github.com/paperclipai/paperclip-cloud/actions/runs/38811327131).
Image build [38807675425](https://github.com/paperclipai/paperclip/actions/runs/38807675425)
ran in the cloud; the retained image artifact is 4,372,269,316 bytes.

The strict 48-step user journey on [CLA-3](https://claude-runner-default-qa-oct-15.test.paperclip.app/CLA/issues/CLA-3)
produced two successful useful files and preserved the provider session.
Performance acceptance remains **failed**: the follow-up exceeded the unchanged
30-second native-startup target. No paid retries were started.

| Turn | Run | Native startup | Archive transfer / extract | Task duration | API estimate |
| --- | --- | --- | --- | --- | --- |
| First | `d77d718b-810b-4244-bff5-3f7366199108` | 26.594s | 6.474s / 5.545s | 1m35s | $0.2166 |
| Follow-up | `50d643e2-82a1-44f9-93c2-b416ada77eeb` | 48.388s | 21.469s / 6.242s | 1m55s | $0.1475 |

These startup spans exclude task preparation (9.155s / 17.504s) and model
response time. They must not be presented as time from click to first response.
The original 133.446s / 136.285s startup baseline remains retained.
Both new runs use provider session `67c358c5-cc9a-4155-a391-3fde8afabe9a`.
Independent browser-download checks confirm five original checklist items remain,
v2 adds Recovery, and downloading v1 again yields identical bytes.
V1 SHA-256: `7f7fe25076e182ee4a0994b8d4870a3bd621d3f3c367a08156dbbce88e8df408` (974 bytes);
v2: `fbdc337a1ff34c34936672f44d9cd29aae50bd4e9d062680c64572eb43e3ddb6` (1,421 bytes).
Evidence: `/private/tmp/claude-startup-user-20261015/`, including the ended journey,
HTML screenshot report, and independent-verification.json. The agent is paused
again. This pair adds $0.3641 estimated API usage; project lifetime usage is about
$0.7192 under its existing $2 cap, within the aggregate $50 qualification ceiling.

Current main PR CI passes, Greptile is 5/5 with zero unresolved threads, and
Paperclip Review remains queued. The separate broad harness passed typecheck,
build, token gates, and runner typecheck, but its 15-minute full-test limit timed
out and three runner-eval support tests failed. A longer existing verification
run is in progress; no full-harness pass is claimed. Next experiment: quantify
hash-matched files already in the stale image to remove the large network transfer
without relaxing admission or changing fleet-wide sandbox defaults.


The second no-prompt experiment verified 2,012,177,122 bytes of identical large
files already present in the stale image (48 files; 3.548s hash inspection).
The v2 transport now builds a small-file overlay and separate large-file layers,
copies matching image files into a private directory, hashes the copies, and
transfers only missing layers. Required frames are concatenated without
recompression into one upload; all transferred hashes and final pack admission
remain enforced. Historical v1 transport remains readable.

The actual Daytona mapper probe with the same public qualified pack measured:
0.031s receipt/overlay check, 0.065s capability check, 3.507s copy/hash reuse,
0.560s required-layer verification/batching, 1.293s transfer, 2.283s extraction,
and 0.469s declared-artifact verification. Upload fell from 978,057,504 bytes to
289,942,911 bytes. Receipt: `layer-probe-output.json` in the existing evidence
directory. The sandbox was deleted, and no provider prompt was sent. This is
a transport experiment, not acceptance evidence for the deployed app.
Twenty-four archive tests pass, including corruption, source/target symlinks,
private-copy isolation, historical readers, and missing-file transfer. The stale
workflow-security assertion now reflects the platform branch's trusted release
consumer checkout; all twelve focused security assertions pass. No workflow was
changed. The next cloud image will qualify the integrated source on the QA tenant.

### Layered transport deployed; remaining resume latency — 2026-10-15

Serving source `81235a33604ccf9744077924bdef3db75b80e22d` is verified on the
dedicated QA workspace. The immutable image is
`ghcr.io/paperclipai/paperclip@sha256:85dbeb3ba1dc241a5772f416e1f0f9b9964d6f567157a90fbd1ddc97591c090a`.
[Cloud image build](https://github.com/paperclipai/paperclip/actions/runs/38814943155)
retained a 4,544,726,788-byte image artifact.
[Single-workspace deployment](https://github.com/paperclipai/paperclip-cloud/actions/runs/38817414740)
verified that source at 22:33:54 UTC, request
`d47ba355-9f90-4499-92cb-9bd5ce350c93`. No local Docker or Rust build was used.

The 39-step ordinary-UI journey on
[CLA-4](https://claude-runner-default-qa-oct-15.test.paperclip.app/CLA/issues/CLA-4)
completed both tasks, independently downloaded both files, checked the original
again, and reloaded the saved result. Correctness passed. Performance acceptance
is still **failed** against the unchanged target of both startup spans below 30s.

| Turn | Run | Native startup | Pack selection | Transfer / extract | Task duration | API estimate |
| --- | --- | --- | --- | --- | --- | --- |
| First | `40da6e01-e114-4244-886d-1dd159f6233f` | 20.017s | 12.461s | 2.066s / 2.762s | 1m12s | $0.2097 |
| Follow-up | `a4de4222-542d-468e-9016-69e883cfa15a` | 37.834s | 23.512s | 10.500s / 3.202s | 1m43s | $0.1582 |

Relative to the original pair, native startup fell by 85.0% and 72.2%. These are
startup spans, not click-to-response times. Task preparation was 8.218s / 19.035s;
provider first-event latency after startup was 1.849s / 2.624s. The follow-up
created a replacement sandbox, restored its checkpoint, and retained session
`fc794198-95b6-4666-b228-a30cbd6cb5e6`. Both runs recorded `keep=false` cleanup.

Independent checks: v1 is 801 bytes, SHA-256
`1013d26f2fdb441d7c60ec500fa95c739ee94fe0f801eed59f96df67491ca973`;
v2 is 1,082 bytes, SHA-256
`b64625202dbe68898a3d538fa640561643ae4bdde342477b29a02aa5d093001b`.
All five original checklist items remain verbatim, v2 adds two Recovery items,
and the second download of v1 is byte-identical. The agent is paused and timer
heartbeats remain disabled. This pair adds $0.3679 estimated API usage, for about
$1.0871 on the existing $2 project cap. No unknown-charge hold was released and
no automatic paid retry was started. The remaining balance is below the existing
$1 run reservation; another run must not be started without budget reconciliation.

Evidence is retained at `/private/tmp/claude-startup-user-20261015-layers/` and
attached to the task:

- [Screenshot report](https://claude-runner-default-qa-oct-15.test.paperclip.app/api/attachments/25f950a0-257e-4a66-97d0-f30bb6094983/content?download=1)
- [Journey JSON](https://claude-runner-default-qa-oct-15.test.paperclip.app/api/attachments/20e42fc1-0466-4e5c-9c6a-91bc5e3c3f4b/content?download=1)
- [Independent checks](https://claude-runner-default-qa-oct-15.test.paperclip.app/api/attachments/fa3a1f36-445a-4205-a3de-bb144d167ab9/content?download=1)

The rendered report and gallery navigation were visually checked. It records
the failed performance target, including the earlier recorder binding error and
the actual UI friction; the ended journal has not been rewritten as a pass.

The residual delay remains predominantly provider-pack preparation. A bounded
no-prompt content-reuse audit found another 138,023,392 matching bytes at different
paths, but scanning the old image took 8.985s and hashed 2.59 GB. That is not a
credible speed improvement, so no speculative content scan was added. Its owned
sandbox was deleted (`content-reuse-probe-output.json`). The matching image
already passed 22 runtime checks, but Cloud's supported sandbox-image campaign
requires it to be the fleet default first. Applying it only to this QA workspace
requires a scoped image-canary capability; neither a fleet-wide promotion nor a
managed-config bypass was performed. That image rollout is the next path to
removing transfer entirely, and it still needs fresh task/follow-up acceptance.

[Main CI](https://github.com/paperclipai/paperclip/actions/runs/38814748461)
passed all 56 checks on the deployed source, including typecheck, sharded tests,
build, and token gates. Greptile reviewed that source at 5/5 with no unresolved
threads. Paperclip Review's separate task is blocked by its chat connection;
it is not counted as a passed review. The additional unsharded verification jobs
remain separately tracked; no full unsharded-harness pass is claimed. No AWS
login or Honeycomb configuration change was needed for this diagnosis.
