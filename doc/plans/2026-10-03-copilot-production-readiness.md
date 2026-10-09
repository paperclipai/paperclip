# GitHub Copilot production readiness

Current release checklist, updated 2026-10-09 (America/Chicago).

## Current shipping gate: publish the actual context origin, then qualify profile 39

The current master baseline is `0726a00e80f392598b17b847a2bb7fa663f25dcd`. Copilot remains pinned to **1.0.88**, with exact **gpt-5.6-luna** for qualification. Pi 22, Cursor 15, and the shared mainline sandbox remain unchanged. Docker images build in the cloud.

Profile 38 source `05bbf940ba609fe3d976da7f08f995304f1582b2` passes application build, runner/server types, native startup/cleanup, both macOS installed smokes and exact authenticated model discovery. Its first local Product attached-command case ran and settled the exact command, retired its processes, then failed the unchanged pre-action evidence oracle. The read happened before the command, but the projector emitted the pending native origin after the receipt. It has **0/20 Product passes** and has not shipped. No profile38 Docker image was built or published.

The narrow follow-up treats explicit `{}` as complete native arguments and publishes the actual pending origin before execution. Only wholly absent arguments can stream later. Missing input and changed arguments still fail correlation; no file-read authority is inferred. The chronological origin regression fails against profile38; the repair passes **72 focused checks**, with one preexisting skip. All oracle and completion assertions remain unchanged. Profile39 must receive fresh live qualification.

Profile 37 source `59aab279f9da6d811406761cb2f94abd03131821` passed full native no-prompt startup/cleanup, macOS ARM64 and Intel installed-runtime smokes, exact authenticated model discovery, and recursive typecheck. Its first local Product attached-command case failed because context evidence was explicitly incomplete; it has **0/20 Product passes**, with cleanup passed. The task's successful status alone does not qualify settlement. The profile37 cloud image was never built or published.

The failure is reproduced offline: Copilot classifies `get_task_context` as a read, and its actual empty `{}` origin was deferred as an unfinished file-read input. The authoritative context receipt then could not match that lost digest. The first repair retained the bounded origin digest and restored receipt matching, but profile38 showed that deferring the origin notice still broke chronological evidence. The profile39 follow-up above corrects that ordering and rejects absent or changed semantic input. The initial regression failed exactly this case; the repair passes 70 focused checks with one preexisting skip. Qualification must restart on the new identity.

Profile 36 source `9769279bb712cec9c5aa1d814e82f369129149bf` passed seven protocol cases and three installed platform smokes, then failed its first Product case before startup because the native manifest/root ownership was inconsistent. Profile37 repaired that root binding with regressions for source, scoped npm, and deployment layouts. Canonical temporary paths preserve owned cleanup. Historical v33 evidence remains historical.

| Next gate | Required evidence |
|---|---|
| Repaired candidate | Mint profile 39; synchronized TypeScript/Rust identity, receipt regressions, native no-prompt startup/cleanup |
| Local Product | Exact attached-command case first, seven unchanged protocol cases, then nine remaining local cells; no automatic behavior retries |
| Daytona | Scan and publish the exact cloud-built repaired image, then ten exact remote cells |
| Ordinary installation | Saved-token setup, save/reopen, metadata-only Test and a completed file task locally and remotely |
| Handoff and shipping | Current-head CI/review, separate code-owner approval, normal merge, and shipped-build canary |

All failed attempts, assertions, and private evidence remain retained. No current release readiness is claimed. The existing approved budget retains historical exposure and audited infrastructure reservations and is not reset. GitHub-attributed native per-run USD remains unknown.

## Completed frozen v33 qualification

The original application source is `024e1422f9c7b43ff1b083e7d8a25e1969dc4acf`; reviewed application execution is `50d54d78e552869cae154d88ade68063191a547e`; native artifacts are `941fbcb664a885eea713e732edc10ac133c62238`. Daytona's reviewed controller/fixture source is `5f9b5e2043c4ec8e5cad667eaa4afbb09f1a9638`, including fixture repair `dc5ebe3f92d405e284b096f5add797864bb0f74e`. Source equivalence proofs retain the selected policies and case definitions; no original grade was relabeled. Copilot **1.0.88**, exact **gpt-5.6-luna**, profile **v33**, and `sha256:482c4e997b4690c7e4a5375dd035560aaad69000f8f5291904d76f8c3a88284a` identify the native campaign.

| Gate | Result |
|---|---|
| Runner protocol | **7/7 pass**, 46 assertions, context-before-action and cleanup included |
| Product local | **10/10 pass**, saved-token grants and exact profile/model verified |
| Product Daytona | **10/10 pass**, native process/sandbox retirement independently verified |
| Platform install/startup | Actual installed ARM64, x64 under Rosetta and Linux x64 under Docker emulation pass; native Linux runs pass on Daytona |
| Ordinary user paths | Both fresh normal installed local and Daytona paths pass without qualification overrides: saved personal token, exact model, save/reopen, metadata-only Test, one task/final response, accepted normalized receipt and downloaded artifact |
| Ordinary remote cleanup | Exact 32 downloaded/synced bytes; native commands exited before completion; all **42** owned sandboxes independently absent. Two intentional setup/runtime-test archives were deleted after verifying exact owned identities |
| Image publication | Approved, published and anonymously verified. Tag `copilot-qualification-22fd2a8ae3414eee317e`; index `sha256:65fc4f30c15b3d744534ce3d7240dfbf3d3ff081da6d51180bd89f2802bd6e56`; Linux manifest `sha256:9606c290372884ee74438408e8115088320979c8614a3dbd9d77be2b548a896e`; scan found zero selected credentials across 225,852 files |
| Shipping | Pending current-master reconciliation/new-build qualification, CI/review, code-owner approval, normal merge and shipped canary |

No automatic behavior retries occurred. The first Daytona attached-command attempt rejected a controller pack before native provider start: extraction omitted seven empty Cursor directories. Image files and Copilot assets matched. Restoring only the verified empty directories fixed the prerequisite; production offline pack validation and the explicit second attempt passed. The original failure remains. Other retained failures include v32 target aliasing, pre-provider startup/admission failures and the first ordinary local file's Markdown escape bytes. The changed hexadecimal local definition passed without relabeling that failure.

Authenticated account reconciliation leaves **$70.50** within the existing approved window, with no active paid hold. Historical result mismatches and missing-closure compensation keep their full contingencies; infrastructure holds remain. Provider per-run USD stays unknown and GitHub-attributed. No billing controls or budget ceiling changed. The machine-readable record is [2026-10-08-copilot-qualification-v33.json](2026-10-08-copilot-qualification-v33.json).

## Historical v32 release attempt

Fresh review identified two release blockers: arbitrary unavailable Copilot models could be saved, and independently decoding transport chunks could corrupt multibyte provider text. Creation, hiring, edits and environment changes now require the existing bounded authenticated metadata probe; the UI accepts only discovered models. The three protocol readers now retain a UTF-8 decoder across chunks.

Current runtime source is `c049102fba12850b755a962d74e22635c8585724`, profile **v32**, `sha256:3dcc8de3034e32001b0a819a614beca345d314266a70a09e0050a9f5f58275fc`, Copilot **1.0.88**, exact **gpt-5.6-luna**. Compared with v31, only the metadata decoder hash, historical revision decoder hash and profile version change in the bound declaration. Earlier results remain historical; they do not qualify changed v32 bytes.

| Current gate | Result |
|---|---|
| Model adoption | 53 setup UI tests and eight focused API cases pass; rejection prevents create/hire/edit, exact available models remain unchanged |
| Split UTF-8 transport | 117 metadata/profile/installation/input tests and 13 credential-free protocol fixtures pass; Runner, server and UI TypeScript checks and token gates pass |
| Maintained master | The stack retains master `d6df12cef69fcaf2d2fe66a393168931d5b8b4e7` and the merged CI-owned dependency prerequisite #15572 |
| Daytona identity contract | Both image input lists reference the active v32 fixture; all nine exact image contract tests pass |
| Fresh CI and review | All four repaired heads require exact-head CI and clean Greptile review; a separate code-owner approval is required for the runtime PR |
| Frozen package and image | Freeze after review, then build and scan the repaired source. The unpublished v31 image request is superseded; it is not the current release image |
| Live release gate | Verify the frozen packaged profile, exact saved-token model, ordinary local and Daytona paths and independent cleanup before rollout |
| Shipping | Pending qualification, code-owner approval, normal merges and shipped canary proof |

The refreshed aggregate account reconciliation leaves **$80.36 within the existing approved allowance** with no active hold. All original attempts, infrastructure reservations and a $5 reporting-delay allowance remain retained. Provider USD stays unknown and GitHub-attributed; no budget reset or billing setting change occurred. The current record is `2026-10-08-copilot-qualification-v32.json`.

## Historical compatibility canary: v31

The following is the retained v31 state before the final review repairs. Its local canary and platform evidence remain valid for those exact bytes; v31 publication and remote launch are superseded by v32.

The normal installed v31 local canary passes on source `d99959f00b62ad2099b5cdaca3f7656dcb88a8e8`, runtime source `4acb084fc5b6805a483bf419c2cdc6de3f7ec13d`, profile `sha256:4a22e4c50fd213c79cd02fd3c5369aef2256ac719762c62f5b70c691cd47e76b`, Copilot 1.0.88 and exact gpt-5.6-luna. Saved-token metadata, UI model selection, save/reopen, one final response, accepted normalized receipt, 30 downloaded bytes and independent process/scratch cleanup pass without qualification overrides. All three installed platform smokes pass; Linux is emulated locally pending the native Daytona canary.

The full v30 campaign below remains immutable historical evidence. Only the saved-prompt compatibility parser and profile admission differ among bound runtime inputs. The current parser reads all 20 captured Product contexts identically and passes the focused recovery checks. No full 20-cell v31 live campaign is claimed.

| Current gate | Result |
|---|---|
| Dependency prerequisite | PR #15572 merged at `941a3fa991aeb97eb1ac390c65b7973b5f6de1ad`; CI-owned lock, current-head CI green, fresh Greptile 5/5 |
| Setup and model discovery | Normal installed local journey passes; first-token refresh and native Runner admission regressions pass with 155 affected UI cases |
| Attached-command review | Both retained live traces prove finish before independent child exit and waiting read after finish; the stronger oracle and regressions enforce both boundaries |
| Cleanup and diagnostics review | Smoke-owned providers ignoring SIGTERM receive bounded SIGKILL with confirmed exit; saved remote diagnostics retain only closed failure codes |
| Focused qualification checks | 214 Product regressions pass, one existing skip; seven smoke cleanup tests and Product typecheck pass |
| Exact v31 image | Credential-free final image is built and scanned; exact public publication approval is pending |
| Ordinary v31 Daytona canary | Next live gate after exact image publication; normal installed plugin is ready |
| Final CI / review / rollout | Remaining four PRs require current-head CI and fresh clean review; production rollout is pending |

The approved budget has $30.68 remaining, with no active reservation. Provider USD remains unknown and attributed to GitHub. No budget reset or billing setting change occurred. The current machine-readable record is `2026-10-08-copilot-qualification-v31.json`.

## Historical completed qualification: v30

Master advanced to `bf9dbd18a8d9a539f79ca2e3ccb10b6df31c6334` on
2026-10-08. Its two fixes merged cleanly into the integration: resumed turns
receive an explicit instruction to obtain fresh accepted completion evidence,
and fresh remote Codex runs resolve compatible models before launch. Copilot
continues to require its exact authenticated model; Codex substitution does not
apply to ACPX providers.

The bound native-execution source changed, so Copilot profile **v30** is newly
minted as `sha256:e21c4a43a937ae84e94726ef93227e8b931fa5547876ff0c5ecff304656d81e9`.
TypeScript/Rust admission and source hashes match. Other provider qualifications
are unchanged. Copilot **1.0.88** and exact **gpt-5.6-luna** remain pinned.
The v29 live results below remain historical evidence; they do not qualify v30.
V29 paid launch and image publication are closed. Its pending image request is
withdrawn; no v29 image was published.

Frozen source is `c4b5d40bcfd51e6cacccc1ea1343305b05735641`; protocol
definitions are `b0ea2ebd2cc07dda180f61362a68662abb96c7d6`. Source hashes, exact
model, all 20 Product definitions and all three platform artifacts are retained
in the v30 freeze. No v29 launch or publication is allowed.

| Current v30 gate | Result |
|---|---|
| Runner protocol | **7/7 pass**, 46 assertions and cleanup; one current attempt per case |
| Protocol launch prerequisite | The copied helper first selected the historical roster. Built-runtime admission rejected it before a provider session or prompt; the failure is retained and only its unused $0.50 reservation was released. Current helpers check the exact roster/config before reserving. |
| Product local / Daytona | **20/20 pass: 10 local and 10 native Daytona**, saved-token binding, exact model/profile and independent cleanup; no automatic behavior retries |
| Build / static checks | Full build, recursive typecheck, token gates, Product typecheck and exact Copilot model isolation pass |
| Product offline | **2,349 Vitest cases pass**, two existing skips, plus maintained Node contracts |
| Runner offline | All selected checks have passing evidence: 3,003 Vitest cases, 677 Rust assertions and 1,942 required real-HTTP assertions. Original Mac invocation retains two credential-home setup failures; unchanged isolated Linux runtime-host suite passes all 44 cases with cleanup. Original cause remains unconfirmed; no single all-green `check:all` invocation is claimed. |
| Installed runtime / metadata | Native macOS ARM64, x64 under Rosetta and Linux x64 under Docker emulation initialize and exit; authenticated packaged metadata confirms 19 models and exact Luna with no prompt. Native Daytona Product and ordinary installed-runtime proof pass. |
| Full repository suite | Current-source offline container full build passes; the full local root invocation retains eight general-server failures. Current-head CI is the release gate; a single all-green local full-suite invocation is not claimed. |
| Normal installation / canaries | Fresh 18-package ordinary npm installation, startup, personal token setup, exact model, save/reopen metadata Test and local task canary pass. Downloaded bytes, accepted receipt, one final response and cleanup are independently verified. Daytona also passes: independently downloaded bytes, accepted receipt, one final response, native command exit and all 13 owned sandboxes absent. The manual metadata Test archive was intentionally retained for diagnostics and then deleted. |
| Image publication | Full final image scan: 225,852 regular files, 18,360,132,191 bytes, zero selected credential matches. Exact OCI index `sha256:b0f81cd040f811b8ae7eeedd326e36a1c697de5116cd91db84694f21526de7d1` was explicitly approved, published, and anonymously verified; Linux x64 manifest is `sha256:2ccfe999e7794ea1577e581840743a466663143c4303a518e06b3f1e0faa58fb`. |
| Review / CI / rollout | The four runtime, regression, setup and qualification PRs are published as #15560–#15563. Current-head CI, final clean review and rollout are tracked above. |

The ten Daytona cells and ordinary installed Daytona canary are complete.
The remaining critical path is current-master compatibility, current-head CI,
Greptile review and shipping. Master advanced to `2f0c485dec7ab036f0abf7d90d09ca5f84df26a7`: its saved-prompt recovery fix changes one bound runtime input, and its Slack migration takes number 0318. The review stack preserves that recovery fix and renumbers Copilot to 0319. Profile v31 binds the changed parser; the completed v30 evidence remains immutable. Its normal installed local canary now passes as recorded above; the full v30 campaign is not reclassified as v31.
Remote workloads use the maintained local controller; no separate source
checkout or credential-file upload is needed.

Account reconciliation retains all historical attempts, infrastructure holds,
other-provider exposure and a **$5 reporting-delay allowance**. GitHub reports
153.34 included credits ($1.53 displayed equivalent), with additional paid usage
disabled. Provider per-run USD remains unknown. The approved window now has
**31.18 remaining**, with no active paid reservation. No budget
reset or billing change was performed; every new attempt requires a reservation.

## Historical v29 current-master replay

Current master is frozen at `5717523b9ea7a2d76efbd6eb73414de9c06c6f96`.
The reviewed merge preserves Dot setup, decision-model routes, credential cleanup,
and other provider qualification. Current runtime source is
`a0e23886e6bd532004252780dfd009b9b449ff0e`, profile **v29**,
`sha256:ce118b64cd7a50a93c3ff538b596327bd8e8d172a1bc0bda5d3334948d5d8eb7`,
Copilot **1.0.88**, exact **gpt-5.6-luna**. Runner definitions are frozen at
`9fb438caa8e4389a53217b7e636b8a15a6d5da26`.
Qualification source is `2003915896ee56eb42a74fddf1ba479d1855549a`.
Its five changes from the runtime revision affect only the warm fixture,
fixture tests, and documentation; retained equivalence proofs keep the runtime
and the other 18 Product cell contracts unchanged.

| Current v29 gate | Retained result |
|---|---|
| Runner protocol | **7/7 pass**, 46 assertions and cleanup, one attempt per case |
| Local Product workflows | **10/10 pass**, saved-token binding, exact native identity and complete cleanup |
| Local warm continuation | Changed-fixture comparison passes all three turns and cleanup; original failure remains retained: the model wrote literal backslash-plus-n and verified its own wrong bytes |
| Warm fixture repair | Prompts explicitly define LF byte 10 and independent byte verification; the original failure and all byte/process/workspace assertions remain; only the two warm cell contracts change |
| Daytona Product workflows | **0/10 current passes**; exact image publication approval pending; maintained cells are prepared to run from a local controller against native Daytona |
| Product support | **2,335 Vitest tests and 128 Node contracts pass**, 2 existing skips; typecheck and exact warm selector discovery pass |
| Runner offline | **3,001 Vitest tests pass**, 11 existing skips; Rust, replay, conformance, protocol, kernel and real-HTTP authority checks pass |
| Build / typecheck / token gates | Pass on the frozen runtime source |
| Installed platform smoke | Actual ARM64 pass; actual x64 installation under Rosetta and actual Linux x64 installation under local Docker emulation pass; native Daytona still pending |
| Full application suite | Original general-server run: **16,807 pass, 8 fail, 69 skip**. Corrected umask/reaper checks pass 9 tests; unchanged native Linux port-ownership and real 40,000-file Git stress checks pass. All three adapter timeout cases pass unchanged on native Linux, including same-version Claude MCP isolation. UI passes **7,810 tests**, CLI passes **517 tests**; a launcher teardown leak is repaired and independently verified. The deterministic bind-readiness fixture and complete Copilot catalog assertion pass. All **155 maintained route suites pass (2,979 assertions)** with descendant cleanup. All 14 remaining workspace projects now have passing evidence (**1,929 cases, 7 existing skips**). A Cursor fresh-lease fixture leaked the installed host CLI; an isolated PATH and execution guard fix the fixture while preserving all 18 assertions. Across maintained coverage, **32,689 cases have passing evidence, with 81 existing skips**. This combines original passes and explicit cause-repaired/native replays; the original failing invocation is unchanged, and a fresh single-invocation root pass is not claimed. Original failures remain retained; no full-root pass is claimed. |
| Ordinary current installation / UI / local canary | Fresh 18-package npm install, first-use personal token connection, exact model selection, save/reopen metadata Test and local task completion pass without qualification overrides; downloaded bytes, accepted receipt, one final response, native exit and scratch cleanup independently verified |
| Ordinary current Daytona canary | Pending |
| Current-head CI / review / rollout | Four unpublished review branches contain **99, 56, 63 and 72 files**. Runtime and regression branches pass their focused checks and Runner typecheck. Saved-token setup/admission passes **1,380 focused tests**, recursive typecheck and token gates; its additive catalog follow-up passes all 16 schema tests. The assembled qualification branch passes recursive and Product typechecks. Live Daytona qualification, current-head CI, final review and rollout remain pending. |

The v29 runtime repair retires a typed ACP native-agent disconnect before turn
finalization while retaining independent process-exit proof for cleanup.
Controller-only disconnection preserves pending input; other providers are unchanged.
The deterministic new regression fails on v28. Historical v28 ten local and seven
protocol passes remain evidence, with closed launch gates. Its full application
suite retained five failures, including embedded Postgres host-resource failures,
fixture timeouts and a Git stress timeout; no failure was discarded or relabeled.

The v29 warm failure is model behavior, not a transport bug: the exact native
command digest matches the recorded command, whose Python string contains bytes
`5c 6e` rather than LF `0a`. The model's own two assertions checked the same wrong
bytes. The changed fixture comparison keeps runtime/model/permission policy
frozen and verifies that the other 18 Product cell contracts and all protocol
definitions are unchanged. Copilot's migration is `0318_copilot_defaults.sql`.

## Historical qualified source

- Master baseline: `ceabc3bc880676c49eee907a8d736f961a1358eb`.
- Integrated source: `8e35f57831fd449a777d49d2686496d543f37cbf`.
- Application / Runner runtime source: `3073c062d47891cc275072de4eaaf049f5837839`.
- Copilot CLI: **1.0.88**; exact model: **gpt-5.6-luna**.
- Copilot profile: **v26**, `sha256:1a2a0c35764105e9a85112d05187fee0862af23eeb82a75569b5198e52eaba4f`.
- Runner eval definitions: `c3c47a3c0d9c207e65713cd05be97cd02d811d89`.
- The 19 later source paths change Product fixtures only. Application / Runner inputs and all 20 Product definition hashes remain unchanged. Source equivalence and each original result hash were verified before admission changed.
- Other provider qualification and the user's dirty dependency lock remain unchanged.

## Historical v26 gates

| Gate | Result |
|---|---|
| Product workflows | **20/20 pass**, saved-token setup and native identity verified; all passing attempts have complete cleanup |
| Runner protocol | **7/7 pass**, 46 assertions, complete cleanup |
| macOS ARM64 installation | Actual installed runtime smoke passes; authenticated discovery includes the exact model without a prompt |
| macOS x64 installation | Actual installed x64 runtime smoke passes under Rosetta; this does not claim a physical Intel-host test |
| Linux x64 installation | Actual installed runtime smoke passes on the native private Daytona controller; authenticated discovery verifies the exact model |
| Qualified runtime root checks | Recursive typecheck, build and token gates pass; 32,105 root tests pass with 107 existing skips |
| Runner checks | 135 Node contracts, 2,964 Vitest tests and 659 Rust tests pass; matching-toolchain doctest compilation passes; 11 Vitest skips and 2 Rust ignores retained |
| Latest Product fixture checks | 2,333 tests pass with 2 existing skips; Product typecheck passes; 152 focused native Linux tests pass |
| Ordinary release admission / packaging | Normal admission and local / Daytona assets promoted; full build, recursive typecheck, token gates and focused admission / packaging regressions pass |
| Fresh npm installation and saved-token UI journey | Fresh 18-package npm consumer passes installation scripts, installed-server import and startup; actual first-run token connection, explicit model selection, save / refresh and metadata test pass; corrected Apps form retested |
| Ordinary local and Daytona canaries | Local passes on ordinary npm source `646408381eca28f795b1e7ede655572154648309`: one final response, accepted completion, exit 0 and owned sidecar / scratch cleanup; Daytona also passes on that source: one final response, accepted completion, exit 0, finalized workspace and automatic task-sandbox cleanup; metadata-probe archive removed by explicit owned test cleanup; no qualification overrides |
| Focused PR stack / current-head CI / review | Pending; fewer than 100 files per PR; exclude the manual qualification lock delta |
| Broader rollout | Pending canary and review |

The final UI suite passes **7,771 tests in 699 files** after correcting one stale
assertion that still expected Copilot to be disabled. First-run inspection found
and repaired a missing Copilot setup choice. The Apps form showed duplicated
access controls; its corrected single form was verified in the installed UI.
The normal release root suite retained five failed files: three embedded Postgres
startup failures, a macOS Unicode descriptor-path failure, and an OAuth loopback
fixture failure. Current-master serial verification passes 485 assertions in four
files after official Postgres native postinstall and a Unicode locale repair;
the custom-image file still hits this host's shared-memory limit. These failures
remain retained; current-master full coverage is required before handoff.

## Retained evidence and failures

Evidence is retained under `/tmp/copilot-production-campaign-v26`. The current
completion record is `current-product-campaign-completion-proof.json`; source
and artifact identities are in `frozen-source.json` and
`qualified-source-equivalence-death-key.json`. All original failed attempts,
assertions, result hashes and cleanup grades remain preserved. No failed grade
was relabeled as passing.

The earlier Daytona attached-command receipt failure is resolved in the pinned
runtime and now passes live. Product fixture repairs separately corrected browser
task-ID binding, installed asset setup, validated process-group peer retention,
context-read permission origins, exact Linux process admission, immutable
boot/start-tick ownership and cleanup against that captured process birth.
Provider-death local attempt 3 passed its behavior assertions but failed cleanup;
its corrected attempt 4 passes both. Regression evidence retains every failure.

Daytona provider-death attempt 1 failed before the behavior began because startup
proc metadata was rejected. Its precise rejected record was not retained and its
cause remains unconfirmed. Subsequent inspection, including roughly 7,000 proc
reads, did not reproduce the rejection. The exact owned disposable sandbox was
deleted and absence verified. One bounded fresh-environment attempt with identical
source and assertions passes all behavior and cleanup checks. No further retry
was made.

Host sleep interrupted two unchanged timing cases; exact power events and failed
attempts were retained. Both cases pass under process-scoped sleep protection
with unchanged assertions and deadlines. Native shared-memory exhaustion affected
the parallel database tests; the exact serial replay passes all 47 files and 166
tests. No foreign process, IPC segment or system setting was changed.

## Setup and release scope

Use first-run GitHub Copilot setup or Connectors → GitHub → Connect Copilot. The AI provider is
`github`, authentication is `api_key`, and the selected saved credential is
injected as `COPILOT_GITHUB_TOKEN`. Repository / MCP connections and grants stay
separate. No ambient GitHub credentials are adopted. Verification uses a bounded
metadata-only probe in the selected execution environment; it sends no model
prompt and reports auth, entitlement, installation and unavailable-model errors
separately. Saving and reopening must preserve ACPX / Copilot / the exact model.

Core local and Daytona workflows are completion, editing, questions, plans,
controller restart, permission denial, attached-command settlement, warm
continuation, Stop with pending permission and provider death. Native steering,
native plan mode, detached commands and additional native event presentation
remain outside this release. Session-scoped notices cannot establish completion,
artifacts or charges. GitHub billing attribution remains; unknown USD cost is
never converted to measured zero-dollar usage.

## Budget and owned resources

The renewed **$100** ceiling retains all prior spending and failed reservations.
The conservative remaining allowance is **$29.55** after independently verifying
the saved token's account and its current-month aggregate included-credit usage
of **153.34 included AI credits ($1.53 displayed USD equivalent)**, with additional paid usage disabled. The prior $1.16 observation remains retained; its $0.37 increase fits the existing reporting-delay allowance and does not release reservations. Reconciliation preserves every
original reservation and infrastructure hold and retains $5 for reporting delay.
Historical ordinary canary reservations and the current ordinary local reservation are settled.
No paid run is active. Native provider USD remains unknown. Reserve ordinary
canaries before sending model prompts; do not reset the ledger or billing settings.
The saved token expires **January 4, 2027**, America/Chicago.

The human's exact approval authorized public image
`ghcr.io/paperclipai/paperclip-daytona-runner:copilot-qualification-70e2d894a067e7891ca7`,
index `sha256:bda4b2793308fe394b8264dafe9d1f226036b5c9fe48d2386435b1950861415c`,
source archive `sha256:78da5a0a06eb813a59edc738537766ab9a321d9877010b5f5d04190cdce2ca82`
and the two selected credentials on the private controller
`copilot-v26-native-private-controller-01`. Publication, anonymous retrieval and
private handoff completed. Credentials are mode 0600. Later credential-free
Product-only increments used the same approved private destination. Delete only
owned resources after their evidence has been collected.

## Remaining critical path

1. Require fresh current-head CI. Maintained offline coverage has passing evidence for all selected cases; retain every original failure, environment diagnosis and explicit repaired/native comparison.
2. Publish the exact credential-free image after approval, then run all ten maintained Daytona Product cells from the local harness, one at a time. Verify native Daytona installation/discovery and the ordinary Daytona canary.
3. Publish the current qualification record, prepare focused PRs with fewer than 100 files each, and require current-head CI and review before broader rollout.

Rollback disables new Copilot admission and retains safe cancellation and recovery
for existing runs. Production readiness requires the ordinary shipped-user path,
not candidate test results alone.

The current credential-free v29 image is built and scanned locally:
`ghcr.io/paperclipai/paperclip-daytona-runner:copilot-qualification-071a851bc57f464c32ec`,
index `sha256:f39a27cc2fe7a83c2c07587fdc367df3307e13259ac50b5c47638559dab92008`.
It has not been published. Automatic approval review rejected publication because
earlier authorization covered different bytes. Exact current image publication
approval is pending. The private controller returned 404 at
`2026-10-08T07:32:25Z`; its disappearance cause is unconfirmed. The proposed
current source archive, runtime delta, credential-file transfer and bootstrap were
withdrawn before execution. No new source checkout or credential file is uploaded
to a separate controller. The maintained local harness will drive disposable native
Daytona task sandboxes using normal saved connections. Local evidence and the
mode-0600 two-key credential file remain retained.

Normal Daytona plugin packaging and isolated installation pass in the fresh npm
application. The existing Environments setting was enabled through its ordinary
UI. The image-pinned Daytona setup form is prepared; no environment has yet been
created or tested. No remote model prompt has been sent for this current build.

The current base still matches public `origin/master`, independently checked on
2026-10-08. The review partition has **99, 56, 63 and 72 files**, respectively. Four
verified fixture-only paths were added: the complete provider catalog assertion,
CLI server ownership, bind readiness and fresh Cursor lease isolation. Every candidate path is assigned once. The user's dependency-lock changes remain
uncommitted and byte-identical. Neither a full-suite pass nor production readiness
is claimed while these gates remain open.

The saved-token review branch now ends at
`be5735cffd6d67cb75ea0567ad16d28d6e489b59`. Its schema follow-up is
`f36e035388811538a3eb91bb5773aee760c7a3b1`; the preceding product commit is
`f61f81b084b4e4bd282609d51c20e54dc5680c4d`. The regression/evidence commit is
`193ef12a7a3c4bd7ecc709dc910e2dd3f3adb498`. These review-only fixture changes and the setup-document correction
do not change the frozen Copilot runtime, profile, model or Product definitions.
The assembled `codex/copilot-qualification-v29` branch passes recursive
typecheck and the Product definition typecheck. It remains unpublished while
current live Daytona qualification, fresh current-head CI and review are open.

The qualification review includes initial commit
`442da9569cb349862d384728ae9c093acfb0bcac` and Cursor fixture follow-up
`abd8fb279ed171838761de1873c2e1b44253db45`. The follow-up changes test setup
only: every test body and assertion stays byte-identical, and Cursor production
code and qualification remain unchanged. Four template-complete PR bodies are
prepared locally, with CI and review boxes left unchecked. Nothing has been
pushed or published. Current credentials were scanned against all changed source
bytes; no matches were found.
