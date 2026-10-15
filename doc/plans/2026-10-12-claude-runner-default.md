# Claude default: refreshed plan — 2026-10-15

Installed-target implementation and API-key qualification are complete on the existing three-PR stack. The subsequent hosted test below found a Cloud default-selection gap. Hosted acceptance is failed and must not be inferred from the installed-target evidence. Earlier attempts remain preserved below.

## Hosted user acceptance — 2026-10-15

A dedicated test organization served exact candidate `49f99e130aff317cb270c367523755910f20d080` after a successful single-organization deployment. The supported Core-only branch preview excluded private Cloud UI plugins; it does not qualify the full private distribution. [Cloud image build](https://github.com/paperclipai/paperclip/actions/runs/38778601920) completed remotely. No local Docker or Rust build ran.

The strict user-only journey started at the supplied management entry, entered the fresh organization, created Claude Staging Writer, connected the authorized API key through the normal masked field, and completed onboarding without any runner/model override. The saved runtime form displayed `Default (claude-opus-5-5)` but **`Legacy runner (default)`** in Advanced. Acceptance failed at that point. No task or follow-up was submitted, so native execution, downloaded artifacts and session continuity remain unverified on this hosted deployment. The failure is preserved in 33 chronological screenshots and the structured journal; later engineering diagnosis is separate.

The managed test fleet uses a named sandbox snapshot. Candidate `needsClaudeSetupQualification` only probes explicit immutable OCI image digests, and `readSandboxPlatformQualification` rejects named snapshots. The same target gate therefore keeps this Cloud path Legacy. A correct follow-up must establish an immutable provider snapshot identity, bind measured OS/architecture/libc facts to the selected environment and company, and invalidate stale/replaced bindings. It must then repeat fresh ordinary onboarding and the useful-task/revision acceptance. Forcing the agent to native, changing the fleet default image, or treating a CLI version probe as native task proof would not resolve this failure.

The QA agent was paused with no runs or sessions. An unused $2 allowance was reserved within the existing $50 ceiling by lowering an inactive local fixture cap; its unknown-charge hold and blocking policy remain intact. Report: `/private/tmp/claude-test-user-20261015/report.html`; structured log: `/private/tmp/claude-test-user-20261015/journey.json`; deployment and diagnosis receipt: `/private/tmp/claude-test-deployment-20261015/deployment.json`. The offline renderer validated all 33 screenshots. Host file preview was queued; report-gallery rendering was not visually verified. Individual product screenshots were inspected during the journey.

Experience findings: the Connectors announcement covered part of the first-task screen until dismissed; budget navigation required several detours and did not expose a clear policy-creation action. These do not cancel the successful API-key connection, and connection success does not establish native execution.

## Delivery checkpoint — 2026-10-15

New Claude agents use Paperclip Runner and ordinary Opus 5.5 defaults on the four qualified installed targets. Saved Legacy/native choices, explicit models, provider routing, and the latest Codex defaults remain intact. Runtime source is `0670b85392a0be51745f1ba7ca84f998bf122c07`, integrated with master through `7420af26fc9a80d6252ababd879e2fc991eebd07`. Required source CI passed, with exact-source Greptile 5/5 and zero unresolved threads. The final record changes evidence only; the linked PRs show current-head checks.

| Target | Completed evidence |
| --- | --- |
| Apple Silicon | Ordinary UI defaults, API task/revision, controller restart, independent files and session continuity on packaged `bd74bf5059`; final `0670b85392` clean consumer passes and its daemon/runner payload remains unchanged. The later execution fix affects remote directory staging. |
| Linux ARM64 | Native build, clean installed consumer, standard provider-pack discovery on an unprivileged SSH host, final-source API task/revision, exact files, effort/permission acknowledgment, session continuity and released leases. |
| Linux x64 | Clean installed consumer, exact-artifact immutable cloud image, final-source API task/revision across fresh Daytona sandboxes, exact files, effort/permission acknowledgment, session continuity and successful cleanup. |
| Intel Mac | Native cloud build and clean installed consumer pass. Attended provider execution was not required. |

Delivery order: [protocol prerequisite #15994](https://github.com/paperclipai/paperclip/pull/15994), [Apple Silicon behavior #15993](https://github.com/paperclipai/paperclip/pull/15993), then [remaining platforms #15997](https://github.com/paperclipai/paperclip/pull/15997). None is merged or deployed to production.

Reviewable previews: [Mac task and revision](http://127.0.0.1:3105/CLA/issues/CLA-3), [ARM task and revision](http://127.0.0.1:3105/CLAAA/issues/CLAAA-1), and [x64 task and revision](http://127.0.0.1:3105/CLAAA/issues/CLAAA-2). Acceptance reports and screenshots are attached to those tasks and independently checked after upload. The earlier 3115 preview is retained separately.

Known rate-card estimates total **$4.810616600**, excluding unknown charges. Aggregate qualification caps remain **$50**, with all prior holds and the separate $1 setup reserve retained. There are no active qualification runs. No automatic paid retry ran. All Docker and Rust builds ran in cloud infrastructure. Live subscription execution remains unverified under the user's API-key direction; built-in connection/authentication flows are preserved. ARM64 cloud-image production remains deferred.

## Finish line and baseline

New Claude agents created through ordinary product entry points select Paperclip Runner automatically, use `claude-opus-5-5` unless an explicit model/provider override exists, and complete a useful task plus revision. Saved Legacy/native choices remain stable. Deliver tested, reviewable PRs; merge and production rollout remain separate.

Planning baseline fetched from origin/master: `7fc2dc8b3236e1149ae32756b6153a503623404b`. Implementation later integrated master through `7420af26fc9a80d6252ababd879e2fc991eebd07`; see the current evidence below.
Clean baseline checkout: `/private/tmp/claude-default-master-plan`, branch `codex/claude-default-master-plan`. Existing three PR branches and installed preview are preserved. This planning checkout is current master plus this record; it does not yet contain the Claude implementation.

## What current master already supplies

- Codex default on macOS ARM64/x64 and Linux ARM64/x64 via #15683 (`adb69e8f09`). Keep its current platform/libc checks, including the glibc 2.39 minimum and sandbox target qualification.
- Existing native Claude ACPX profile: Claude ACP 0.73.0, SDK 0.3.286. Native Claude is not a new adapter implementation.
- Pinned Claude Linux ARM64 executable admission, including actual digest `0292fa22ac2fd43e16be9d0e511ddd8347280d6e0ebaca744ef5b27e05d8d0f8`, landed in #16372 (`854ab294cc`). Reuse this implementation.
- Network-safe libc detection and asynchronous startup probing (#16333/#16335), plus newer task recovery, repository admission, workspace retention, and snapshot isolation. These must survive integration.
- Claude still has no automatic runner mapping: `paperclipRunnerProfileForHarness` and `agentRunnerAvailability` select Codex only. Legacy Claude defaults to Opus 5; generic ACPX defaults to Sonnet 5. Native Claude remains subject to the experimental gate.
- Native setup's SSH architecture whitelist still excludes Linux ARM64. Executable admission alone does not prove onboarding/remote selection works.

## Existing work and evidence at the planning checkpoint

| Work | Current state | Reuse / remaining gap |
| --- | --- | --- |
| Protocol prerequisite #15994 | Open, head dd82936c1d | Reconcile with master; retain only shared changes required for Claude and historical readers. |
| Claude behavior #15993 | Open, head 4ee0d1d444 | Existing selection, UI, auth, effort and resume work; previous CI and review passed, but integration needs fresh verification. |
| Platform qualification #15997 | Open, published bddff3c5e9; local 84426fef60 | ARM/package work and unpublished image artifact consumer. Preserve the work, remove duplicate landed ARM admission changes. |
| Packaged Mac API task/revision | Passed on frozen source 2646b94533, including controller restart and independent files | Historical proof. Repeat relevant acceptance on the master-integrated candidate. |
| Packaged ARM SSH API task/revision | Passed on the same frozen source | Historical proof. Revalidate final remote runtime and selection after integration. |
| Linux x64 API acceptance | Failed before model startup due to image/npm pack mismatch | Build an image from the exact package producer artifacts, then run a fresh task/revision. |
| Subscription | Existing flow retained; complete follow-up acceptance unverified | User redirected this work to API keys. Preserve flow and auth-routing controls; do not claim live subscription acceptance or request another CAPTCHA. |

The two successful historical journeys remain at http://127.0.0.1:3115/CLAAAAAA/issues/CLAAAAAA-2 and /CLAAAAAA/issues/CLAAAAAA-3. They are not evidence for current master or a new candidate. Do not upgrade their data in place for the new verification run.

## 1. Reconcile the existing implementation onto current master

Use the existing PR stack; integrate master forward into its prerequisite, then cascade to behavior and platforms. The fresh checkout above provides the reference baseline. Preserve published history and the image fix. Do not wholesale replace current runtime files with old versions.

An index-free merge rehearsal against the complete local stack found 25 overlapping changed files and six textual conflicts:

- packages/paperclip-runner/README.md
- packages/paperclip-runner/src/drivers/acpx/installation-integrity.ts
- server/src/__tests__/agent-skills-routes.test.ts
- server/src/__tests__/issue-update-comment-wakeup-routes.test.ts
- ui/src/components/AgentConfigForm.render.test.tsx
- ui/src/components/AgentConfigForm.tsx

Resolve executable admission using master's landed ARM64 support; preserve newer UI and consolidated test structures while adding Claude cases. Independently review clean merges in native-session-executor, runner transport, heartbeat selection, agents routes, onboarding, and imports: textually clean does not establish correct recovery behavior.

Review prerequisite scope before carrying it forward: the old branch advances Pi profile 22 to 25 as part of shared config admission. Keep changes demonstrably required for Claude transport and historical compatibility; isolate unrelated provider changes instead of making their qualification a new Claude gate. Do not drop required historical readers merely to reduce the diff.

Exit: focused selection/UI/protocol/resume checks pass with current Codex behavior preserved; each remaining diff has a clear reason tied to Claude delivery.

## 2. Prove the local default first

First implementation delivery enables Apple Silicon only. Other Claude targets retain their current default until their package/execution gates pass.

- Extend existing centralized resolution to `claude_local` -> `paperclip_runner`, `provider: acpx`, `acpxAgent: claude`. Graduate this profile only from the experimental gate.
- Preserve request-level `runner: auto | paperclip | legacy`, discovery fields, and resolved stored configuration. No migration or bulk rewrite of saved agents.
- Reuse Claude connections, secret storage, selected account, subscription actions, and built-in setup probes. Use the API key from ~/.secrets through the existing connection flow without exposing it.
- Reuse the shared Advanced runner selector with Claude branding. Omit legacy-only defaults from native forms; incompatible custom execution settings require explicit Legacy with a useful error.
- Apply ordinary Opus 5.5 defaults consistently while preserving explicit models, ANTHROPIC_MODEL, and provider routing.
- Preserve effort admission before prompt/resume, permission semantics, instructions, skills, timeouts, workspace settings, cancellation and session continuity.

Run the smallest faithful isolated local Product E2E case on the integrated candidate. Reuse a compatible verified daemon only if its protocol identity is compatible; any necessary Rust build runs in cloud and only the Mac target is needed initially. Do not begin a four-target packaging campaign to answer a local behavior question.

Acceptance: ordinary New Agent/onboarding -> Claude Code -> existing API-key connection -> submit with no runner/model override. Inspect saved native/Opus 5.5 config directly, with enableNativeRunner=false. Produce a useful file, independently download it, restart the isolated controller, request a revision, download both versions and compare bytes, then reload task/agent and confirm the same session and persisted settings. The E2E fixture must not patch the runner after onboarding.

Exit: two successful paid turns, independently verified artifacts, persisted settings, effort acknowledgment, exact controller/runtime identities, and a usable new preview. Failures are diagnosed locally before platform work proceeds.

## 3. Close compatibility and creation-path gaps

Use focused controls for:

| Contract | Required evidence |
| --- | --- |
| All creation boundaries | UI, API/CLI, onboarding, hires/approval snapshots, built-ins, plugins and imports call the resolver. |
| Saved configuration | Ordinary edits, restart, activation, export/import preserve saved Legacy/native and explicit model/provider values. Explicit changes invalidate sessions through existing revisions. |
| Target/adapters | Disabled adapters, external overrides, unsupported OS/libc, qualified sandbox target, remote ARM setup, and unchanged Codex defaults. |
| Auth and isolation | Selected account, company boundaries, secret forwarding, API billing attribution; existing subscription actions still route to Claude. |
| Settings and failures | Effort before prompt/resume; permissions, instructions/skills, timeout, cancellation/cleanup; clear model/auth/package/incompatible-setting errors with no runner fallback. |
| Protocol compatibility | Historical input readers and existing provider controls; no silent effort loss on resume. |
| UI | Shared components, light/dark, narrow viewport and keyboard operation. |

Update configuration docs, bundled agent-creation skill, feature maps and E2E documentation. Re-run only affected passing cases during iteration; final required checks remain mandatory.

## 4. Qualify the remaining platforms

After the local integrated candidate passes, freeze its runtime/package source and build in cloud. Reuse the prior four-target release mechanisms and the image artifact consumer where applicable.

The observed x64 failure was real: its independently rebuilt image had a different lock/provider-pack manifest than npm. Preserve the rejection guard. The cloud image must consume the same exact-source, digest-verified daemon and provider pack as the public package, then verify both identities inside the resulting image. Do not rerun the old 2646 campaign merely because its command is available; qualify the newly integrated candidate.

Before dispatch, verify current GitHub workflow publishing access. The previous OAuth token lacked workflow scope and SSH signing failed. If unchanged, this blocks publishing the prepared workflow only; local behavior/reconciliation can proceed. Inspect a successful push before dispatching the updated workflow.

| Target | Required before enabling its automatic default |
| --- | --- |
| Apple Silicon | Local API pair above, then final packaged runtime verification. |
| Linux x64 | Clean install, matching immutable image and package authority, ordinary selection, API task/revision, independent downloads and continuity. |
| Linux ARM64 | Native cloud build, clean install, standard installed-host/SSH package selection, API task/revision and continuity. No ARM cloud-image production. |
| Intel Mac | Cloud build and clean install/package admission. Attended provider execution is not required. |

Preserve existing Linux x64 pack behavior and other providers' qualification boundaries. Additional defaults are enabled only after the corresponding evidence passes. Live subscription task/follow-up qualification remains explicitly unverified under the user's API-key steering.

## 5. Delivery and operating limits

Keep the approved prerequisite + two delivery boundaries: protocol compatibility, Claude behavior/Apple Silicon, remaining platforms. Reuse existing PRs where their scope still fits. Refresh exact-head CI and review after reconciliation; historical green checks are not current approval.

Required before PR-ready handoff: pnpm -r typecheck, pnpm test:run, pnpm build, pnpm check:token-gates, applicable cloud package checks, current review 5/5 and resolved findings. Keep expensive builds and all Docker work in cloud. No paid retries run automatically.

Retain the separate $50 Claude ceiling. The last recorded known rate-card estimate was $3.054638600, excluding unknown charges, with a $1 setup reservation. Reconcile actual current policies/usage before any paid work; unknown charges and failed holds stay reserved. Use fresh bounded fixtures within existing available allocation, never clear old holds to make acceptance proceed.

Update this record with the integrated source, package/image digests, preview, artifact comparisons, reports, costs and PR checks. Finish with usable previews and reviewable PRs. No merge or production deployment is included.


## Integrated implementation progress — 2026-10-15

Current source checkpoint: master through `7420af26fc9a80d6252ababd879e2fc991eebd07` is integrated through the stack. Protocol is `bffac456ddb2ea6c340a8f598af10c6b98135625`, Apple Silicon behavior is `f0ed0bdefaeb363e5ab2d4018d9cd13656df7137`, and frozen platform runtime source is `0670b85392a0be51745f1ba7ca84f998bf122c07`. Each has passing required source CI, exact-head Greptile 5/5, and zero unresolved review threads. The protocol and behavior PRs are ready; platform acceptance remains gated below. GitHub workflow access is restored and the image consumer is published.

Master's retained-reader authorization batching and CI profile export are preserved. Their 267 authorization/selection controls and 15 CI profile tests pass. The Darwin SSH automatic-Legacy safeguard is included in the behavior boundary, so Apple Silicon SSH creation is safe before the platform PR; its 142 selection tests pass. Existing Codex behavior and master's landed ARM SDK admission remain intact.

Review corrections are committed and covered by failing-before/passing-after controls. Discovery changes invalidate stale onboarding probes. Finish setup now saves the exact configuration admitted during qualification rather than rebuilding Legacy defaults from an older render. V7 native input retains prepared transport, constraints, and completion-only second turns. The latter regression reproduces `session cannot start another turn` before the fix. All 160 focused protocol/session tests, all 71 New Agent tests, 148 onboarding tests, UI typecheck, and runner TypeScript build pass. Earlier focused verification also passed 343 selection/configuration checks, 849 skills/comment/native-session checks, 320 latest-master lifecycle/selection/snapshot checks, 148 platform-selection controls, 114 release controls, 16 image-consumer controls and token gates. Master's subsequently landed snapshot-worker test fix replaces the earlier local timeout change. All three heads have fresh 5/5 reviews with zero unresolved findings and passing required CI. One earlier platform shard hit an ephemeral HTTP/2 EADDRINUSE test-port collision in unchanged code; a single provider-free rerun passed, preserving the original failure log at `/private/tmp/claude-v7-platform-workspaces-b-failure-20261015.log`. The final packaged Mac pair subsequently passed; current remote execution gates are recorded below.

Preview: http://127.0.0.1:3105/CLA/issues/CLA-2, data `/private/tmp/claude-master-local-20261015`. Historical preview 3115 is separate. Ordinary New Agent -> Claude Code -> saved Anthropic API key -> Model Default -> high effort -> Finish setup originally saved agent `5339638d-b41d-4a6f-a041-4e5d1698a8de` as `paperclip_runner`/`acpx`/`claude`/`claude-opus-5-5`. No runner/model was patched after creation. Only timeout (180 seconds) and concurrency (one) were bounded. Experimental native runner remains false. The isolated PATH uses the already-qualified Claude 2.1.286 executable, preserving the user's system CLI.

The first integrated local pair passed on `77936b2973`: runs `58291208-459e-4de4-8b3e-5eff25d4e98c` and `37e6164e-98e3-42fe-8847-2ee061629055`, independent 160/217-byte artifacts, high effort, unchanged task/provider/backend session across controller restart, estimate $0.336505200. Its report remains `/private/tmp/claude-master-local-proof-20261015/acceptance.json` and attached to CLA-1. This is preserved historical evidence for that runtime.

After rebuilding the corrected TypeScript runtime, the new pair passed on `f1dfde5a09`: runs `6bfd4019-4d7e-4be7-948e-b56f56d8ee3e` and `c761ac19-3e5f-4301-bf13-22a1f9ec0d32`. Independently downloaded `claude-v7-checklist-v1.md` is 134 bytes, SHA256 `3161571692c5d08dd80e91ce83f7ff42fb69f70d8f349084114707e27b8b8b82`; v2 is 180 bytes, SHA256 `3fe1b7f05f1f320246691d007576d0d25a40a1e91fd649c2496a8e56d1ddd299`. V1 is preserved. Task/provider/backend identity survived another controller restart; both turns admitted high effort, billed as metered API, and settled without pending/unpriced usage. Estimate $0.351676000. Report `/private/tmp/claude-v7-local-proof-20261015/acceptance.json`, also attached to CLA-2 as `56c7acb8-7079-4b46-a73f-b0b49e21c0e3`; screenshot attachment `615e3de4-38dd-4c0f-be94-0bb05f7b6757`. Task and agent settings survive reload. A fresh read-only browser check also passes light/dark desktop, 390-pixel mobile, and keyboard open/Escape/focus restoration for the shared Runner control. No horizontal overflow or mutations occurred. Screenshots and receipt: `/private/tmp/claude-v7-local-ui-20261015`.

The local daemon retains verified source `2646b94533bac1eae0d30b11d3774b104eeaf981` and its original manifest. Rust/protocol trees are unchanged; Darwin ARM64 daemon SHA256 is `094e5e809843efc3d16c796ee4271ff11fcb550afb927b3fa0e745d964bcba2d`. Current-source JS was rebuilt locally. No local Docker or Rust builds ran. Local source acceptance is passed; final installed-package proof remains separate.

The first new cloud campaign [38734513491](https://github.com/paperclipai/paperclip/actions/runs/38734513491), source `64e721e5f5`, was cancelled after review identified the v7 session defect. Its ARM64 Linux, ARM64 Mac and x64 Linux daemon jobs succeeded; Intel and package assembly were cancelled. Those artifacts are preserved and are not final qualification. Following the corrected local pair, [campaign 38738177651](https://github.com/paperclipai/paperclip/actions/runs/38738177651) builds frozen source `bd74bf5059` in cloud workers. The exact-artifact image consumer and final installed Mac/Linux execution follow that successful producer. Live subscription acceptance remains unverified under the user's API-key direction.

Budget remains $50 total with historical holds intact. The fresh fixture cap is now $2.30: $0.80 from the original safe reallocation, then $1.50 from unused allowance in held fixture `16cc3ada` while retaining its $1 pending reservation and $1 setup reserve. Donor remains hard-stopped and its agents paused. Receipts: `/private/tmp/claude-master-local-allocation-20261015.json` and `/private/tmp/claude-master-platform-allocation-20261015.json`. Fresh fixture observed usage is $0.688181200, pending/unpriced zero, leaving $1.611818800. Historical known rate-card estimate plus these runs is $3.742819800, excluding unknown charges. Per-run reservation remains $0.50; automatic paid retries and timer heartbeats remain disabled.


## Packaged acceptance and remote staging repair — 2026-10-15

Cloud producer [38738177651](https://github.com/paperclipai/paperclip/actions/runs/38738177651) passed all four native daemon builds and clean package consumers on source `bd74bf50596d099e138bc6824cf0230f1026bfe1`. Public package artifact 11976635617 has ZIP SHA256 `079a0e5277ce978ccbe8464e4413ddb7f9a537a76fd71da931e3ee355bbe4198`; all 18 package archives were independently verified and installed into `/private/tmp/claude-installed-bd74bf50-preview/consumer`. The [cloud image consumer](https://github.com/paperclipai/paperclip/actions/runs/38744991246) also passed. Image `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:41cde6894c649ff76a06ddb925f1be1945d5efc901b13a7e43d371427a205235` contains the exact producer's Linux x64 daemon and provider pack. No Docker or Rust build ran locally.

The installed Mac task/revision passed in ordinary New Agent UI with saved API key, Default model, high effort, and no runner override. Agent `766dddf5-1178-4cdf-81ee-ec542cfe0673` saved native ACPX Claude/Opus 5.5 with the experimental gate disabled. Preview http://127.0.0.1:3105/CLA/issues/CLA-3. Runs `ae8386b6-6a41-493c-a35c-a34bcd5feb7c` and `f79a151e-2267-4acd-ad81-6a34be25e1ff` succeeded across a controller restart with the same task/provider/backend session and high-effort acknowledgment. Independently downloaded v1 (114 bytes) SHA256 `f1da81caf11f90e80c3fe008adf3c1d6e180d38188f929dc8244edd64e4ff41a`; v2 (157 bytes) SHA256 `cae638f5f239806842b9ef1fa9694097e142035f803a89ff743696e558f5b3b2`. V1 remained unchanged. Settled API estimate $0.347345000. Report `/private/tmp/claude-v7-installed-mac-proof-20261015/acceptance.json` retains the state at acceptance; later company holds do not invalidate those settled runs.

The two subsequent ARM attempts failed before provider startup and remain pending accounting: `c2d8f460-381c-4764-ae04-4974b30739eb` (test-drive stripped inherited callback configuration) and `a6979058-b3d0-49ed-8c6d-159f507e3443` (read-only directory staging). Each retains a $0.50 hold. Callback configuration is now persisted through the instance's normal environment file. ARM uses a dedicated unprivileged account and private SSH listener, with the verified standard provider-pack installation; the system CLI and existing root listener are untouched. Root execution was rejected by Claude's ordinary permission check, reproduced without credentials or prompts.

Credential-free reproduction proved that BSD tar emits non-contiguous directory entries. GNU tar restored read-only directory permissions before later children arrived. The staging fix delays GNU directory restoration, omits macOS metadata, and verifies existing immutable context bytes and modes before reuse on follow-up. It keeps native provider sync behavior and durable checkpoint handling. Corrupt or symlinked targets do not become accepted cache hits. The regression failed before the fix; all 15 focused controls now pass with both GNU and BSD tar, including repeat staging and corrupt/symlink rejection. The actual patched function also passes twice on the unprivileged ARM host with zero provider calls; receipt `/private/tmp/claude-v7-arm-staging-fixed-20261015.json`. Remote live acceptance remains incomplete; no paid retry runs automatically.

Earlier allocation receipt `/private/tmp/claude-v7-remote-allocation-20261015.json` preserves the $50 aggregate ceiling and all historical holds. Known rate-card estimates total $4.090164800, excluding pending/unpriced charges and setup reservations. The current remote fixture has a $1.22 cap with its new $0.50 pending hold. Live subscription acceptance remains explicitly unverified under the user's API-key direction.


The staging repair is frozen at `0670b85392a0be51745f1ba7ca84f998bf122c07`. Its source CI passed; Greptile reviewed this exact commit at 5/5 with zero unresolved threads. [Package campaign 38751544488](https://github.com/paperclipai/paperclip/actions/runs/38751544488) passed the Linux and Apple Silicon producers, then was cancelled after the Intel worker stalled in checkout for 17 minutes. Its artifacts and checkout log remain preserved. A single infrastructure retry, [38756070238](https://github.com/paperclipai/paperclip/actions/runs/38756070238), uses the same frozen source and one consistent producer attempt. Its Intel checkout completed normally; all three other producers passed. All four producers subsequently passed; package assembly is queued for a hosted Linux worker, followed by clean consumers. No provider retry occurred. The new ARM pack differs from the previous payload only in `runnerSourceRevision`; its new manifest digest is `sha256:9b4dfddca028ac8befcc84b9cbe724553531d991386f80329b4bdcab3890874d`. Daemon bytes remain SHA256 `4720c6a23784d3b4535329ecf852d38af8c14ae920447a662a00c4657711387a`, and the pinned Claude executable remains SHA256 `0292fa22ac2fd43e16be9d0e511ddd8347280d6e0ebaca744ef5b27e05d8d0f8`. The verified new pack is installed in the dedicated QA user's standard location; receipt `/private/tmp/claude-staging-arm-activation-20261015.json`. The previous user pack and the system/root installations remain preserved.

The prerequisite [#15994](https://github.com/paperclipai/paperclip/pull/15994) and Apple Silicon default [#15993](https://github.com/paperclipai/paperclip/pull/15993) are ready for review, with final packaged Mac evidence in their bodies. Neither is merged. The platform PR [#15997](https://github.com/paperclipai/paperclip/pull/15997) remains draft until its final remote task/revision acceptance passes. The installed Mac acceptance report and screenshot are attached to the completed preview task as `beec99dd-a9b3-40bb-84f5-6cae7c867562` and `fa8f2a00-d18b-444b-802e-11ad25166055`; both were downloaded again and verified after upload.

The fresh remote fixture `99824208-435b-4c44-8f63-829fc79faad9` (CLAAA) has a $1.40 shared cap. It receives $0.72 of unused allowance from held fixture `4389d6ab` (retaining its $0.50 hold) and $0.68 from original QA `f1dd89ef` (retaining its known spend plus two conservative $8 unknown-charge reserves). Aggregate caps remain $50; every prior hold and the separate $1 setup reserve remain. Receipt `/private/tmp/claude-staging-fixture-allocation-20261015.json` verifies paused donors before and after the reduction. No hold was released and no task retry was submitted. Ordinary UI creation on the unchanged `bd74bf50` UI saved native Claude/Opus 5.5/high effort for ARM agent `7233d811-41f0-4059-9084-5eeea09da7dd` and x64 agent `3ba4cef6-bca9-4341-b9f2-88696e892dba`. Both existing CLI API-key checks succeeded in the selected environments; this is connection evidence, not native execution acceptance. Both agents are bounded to 180 seconds and one concurrent run. UI journal `/private/tmp/claude-staging-ui-20261015`; no runner/model switch occurred after onboarding.

The isolated database is backed up before package replacement at `/private/tmp/claude-master-local-20261015/instances/default/data/backups/claude-before-staging-0670b853-20261015-094815.sql.gz`, SHA256 `8620dc98360032f48767c0d273d98c4926f355bb7bde6ff802a82451f2fe80cc`. The first backup attempt used the configured default port and timed out; the successful backup binds the actual instance data directory and allocated port 54334. No existing instance or backup was replaced.


### Final installed ARM acceptance — 2026-10-15

The replacement campaign's public package assembly passed. Artifact `11985673906` is 109691616 bytes, ZIP SHA256 `de6810dca086f2320a52bc4dc3d06e6e07374a0e9246add568f017b56b1bef89`. All 18 archive digests were verified before installing into `/private/tmp/claude-installed-0670b853-preview/consumer`. The controller preview now reports frozen source `0670b85392a0be51745f1ba7ca84f998bf122c07`, with the native experiment disabled. All four installed daemon hashes match the release manifest and are unchanged from the prior packaged Mac proof. The installed ARM provider-pack authority exactly matches the dedicated host's standard installation. All four native builds and all clean consumers have now passed in [campaign 38756070238](https://github.com/paperclipai/paperclip/actions/runs/38756070238). The matching x64 image is building in cloud via [38764436597](https://github.com/paperclipai/paperclip/actions/runs/38764436597); no local Docker build runs.

The ARM task and revision both succeeded on the final installed source: `47cf1e62-2023-4198-ba04-65564b56ecf8` and `3f07e836-acc0-4141-9daa-bd74013317ac`. Preview http://127.0.0.1:3105/CLAAA/issues/CLAAA-1. Independent downloads match the 114/157-byte oracles and SHA256 values recorded for the packaged Mac pair; the original remains unchanged. Task/provider/backend session identity is the same across turns, and high effort is requested and acknowledged on both. API accounting settled at $0.216398000 and $0.163966600 ($0.380364600 combined), with no pending or unpriced usage in this fresh company. Report `/private/tmp/claude-staging-installed-arm-proof-20261015/acceptance.json`; runtime identities `/private/tmp/claude-0670b853-installed-runtime-identity.json`. The earlier read-only staging failure is preserved and is not counted as passing evidence. The report and reloaded completed-task screenshot were attached and independently downloaded again (`13602319-1f90-4176-94c6-4789df9c630a`, `10c4c7fe-d745-4034-b356-b15565304a8e`). Reloading the agent also retained Claude/Opus 5.5/High settings; UI journal step 51. No runner or provider processes remained in the dedicated ARM account after both turns.


The [cloud image consumer](https://github.com/paperclipai/paperclip/actions/runs/38764436597) passed. Immutable image `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:d241ab13d48297a0fe85b04acf70980a427a5fbcd4a95ca2284c7022cd29d03c` contains the exact installed Linux x64 pack `sha256:6adcfdf1a90d922fb65d647e13936eafff7d9cc5f0142ebdfbc11d9470b00c55` and daemon SHA256 `cd46aa8e809f4f3a4f705bfdc93b17b1466c010235f37b0b2f71572f927b5f8f`. Evidence artifact `11989266220` ZIP SHA256 `f6878e2c8e97d0f9d0dc8bfc8af9ea4b255d1f5b92ea6323cd5a983c6e003f34` was independently verified, as were source and inner-image identities. The dedicated x64 environment now uses this image with its saved credential reference preserved. No local Docker or Rust build ran.


### Final installed x64 acceptance and accounting — 2026-10-15

The final x64 pair succeeded: `65f04a06-c2a4-4c3c-af4a-2f6026563623` and `9c22a214-c9f3-436c-a509-0ddf763c66e6`, using native Claude/Opus 5.5/high effort with the experimental gate off and no runner/model override. Preview http://127.0.0.1:3105/CLAAA/issues/CLAAA-2. Independent downloads match 114/157 bytes and the exact SHA256 values above; the original is unchanged. Task/provider/backend identity persists across two distinct Daytona sandboxes. Both runtime records confirm provider ingress, the selected environment, approve-all permissions, and high-effort acknowledgment. Both leases bind the verified immutable image and report successful cleanup. API accounting settled at $0.212391400 and $0.127695800 ($0.340087200 combined).

Report `/private/tmp/claude-staging-installed-x64-proof-20261015/acceptance.json` includes actual environment leases, immutable image identity, and cleanup evidence. The report and reloaded completed-task screenshot are attached as `7276f35e-aad9-4be0-8e51-330cd9ad0904` and `20b33105-1229-47ec-b50f-ce88745b3fcf`; both passed independent download comparison. Reloading agent settings retains Claude/Opus 5.5/High; UI journal step 61. The ARM transport addendum `/private/tmp/claude-staging-installed-arm-proof-20261015/execution-targets.json` verifies both actual SSH leases, selected account, standard pack reuse, and permissions from retained runtime records; both leases are released and no provider/runner processes remain in that account.

Final read-only accounting receipt `/private/tmp/claude-staging-accounting-current-20261015.json` records $4.810616600 known rate-card estimates, $50 aggregate caps, zero active runs, retained unknown charges and setup reserve, and no released holds. The fresh remote company has $0.720451800 observed usage, no pending/unpriced usage, and a $1.40 cap. One older retired fixture retains its prior policy evidence because its current instance is unavailable; its entire $9 allowance remains reserved. The original failed records, unknown-charge holds, previous package attempts and source identities remain intact. No additional paid turns are required for this handoff.

---

# Historical plan and evidence (retained)

# Claude runner defaults

Updated 2026-10-12.

## Outcome and constraints

Start from `058af8f1b69c5fa3d9bc974b9eab73c141b52823`; branch `codex/claude-runner-default`, checkout `/Users/dotta/.codex/worktrees/670b/paperclip`. New Claude agents eventually default to native ACPX Claude on Apple Silicon, Intel Mac, Linux x64 and Linux ARM64. Codex selection remains owned by the dependency branch. On 2026-10-12 the user explicitly approved preserving its latest Linux ARM64 default from `dcdf09a0f33536fa2b6daaf6e731d921d5711282` during reconciliation. Ordinary Claude defaults become Opus 5.5; explicit models and existing runner selections remain intact.

Local Apple Silicon API-key task and follow-up are the first gate. Keep existing connection/login tools. Complete core settings and local subscription next, then package/qualify other targets. Two behavior/platform delivery boundaries plus the user-approved protocol prerequisite PR; no merge or deployment. Linux ARM64 covers installed hosts and SSH, not ARM cloud images. Separate $50 Claude ceiling including setup probes, unknown-charge holds and task turns. No automatic paid retry loops. Docker and expensive Rust builds run in cloud infrastructure; never build Docker images on this Mac.

## Current state

- Review boundaries: the user approved a separate shared-protocol prerequisite to keep each PR below the repository's 100-file limit. The behavior PR is [#15993](https://github.com/paperclipai/paperclip/pull/15993); the platform branch is `codex/claude-runner-platforms` and remains gated. Protocol prerequisite [#15994](https://github.com/paperclipai/paperclip/pull/15994), initial candidate `2e8d5e906e`, has 44 source files and preserves latest Codex startup changes from `a200495cc7`. Behavior candidate `12f30702d7` includes that prerequisite.
- Review corrections preserve legacy ACP permission aliases, retained native import settings and fixed Claude OAuth claims through native creation. Unknown inherited-property model names stay unpriced. Legacy onboarding cases now explicitly select Legacy; ordinary native Claude onboarding skips unqualified controller targets before provisioning. Focused import52, selection/pricing117, OAuth54, CLI fixture104, shared Pi92, Copilot28 and Pi evidence72 controls passed; final CI/review remains required.
- Shared source attestations are versioned rather than rewriting historical identities: Pi v23 and pending Copilot v18 bind the changed Claude effort sources. Prior declarations remain. Executable closures and platform qualification are unchanged; prior mismatched profiles require session reopening. These new generated bindings require a current-source daemon/package build.
- Local ordinary API-key onboarding, useful task, revision, cold resume with high effort, independent artifact downloads and persistence passed. The active preview is `http://127.0.0.1:3105/CLAA/issues/CLAA-1`.
- The user redirected the remaining live checks to API keys. Subscription login remains supported, but no further attended subscription qualification is required; subscription follow-up is not claimed.
- Shared runner controls passed light/dark, 390-pixel mobile and keyboard opening/closing checks. The walkthrough found native Command/Extra args controls; they are now hidden for native execution. The saved Claude preservation test covers this path. Agent form 111 tests, UI TypeScript and token gates passed.
- Four-target cloud producers and required source checks are running on 9788c05; clean-install consumers are still pending. The existing authorized SSH development host is Linux ARM64 with GNU libc 2.39; qualification will use an isolated directory and preserve its other services.
- Reviewed source chat “Make Paperclip Runner the default”; source worktree remains separate and active.
- Isolated feature branch starts at the exact requested SHA.
- Workspace dependencies installed with pinned pnpm 9.15.4 and lifecycle scripts disabled.
- Local key source exists; no credentials retained here.
- Verified baseline Apple Silicon daemon is available at `/private/tmp/pr2-d522-mac-remote-daemon/darwin-arm64/paperclip-runnerd`; use its receipt and digest for phase 1.
- Local default selection, narrow experimental-gate graduation, Opus defaults, and shared runner UI are being implemented. Claude effort transport and acknowledgment are being implemented; the live milestone used default effort on the unchanged baseline daemon.

## Remaining gates

1. Local API-key onboarding/task/follow-up passed; retain evidence while runtime components change.
2. Core settings propagation and preservation paths. The user redirected the remaining subscription acceptance to API-key qualification; subscription follow-up remains unverified.
3. Four-target package and remote proof; enable additional defaults only after qualification.
4. Required checks, final-source review, PRs, inspectable evidence and working preview.

## Budget

Ceiling: $50. Two successful API-key task turns and one successful built-in setup probe. Retain $8 for the initial unpriced receipt/setup uncertainty, plus an $8 additional billed-spend allowance with hard stops and no automatic paid retries; total conservative hold/allowance $16. The follow-up estimate consumes $0.269886 of that additional allowance. These are qualification estimates/reservations, not provider invoices.

## Local API checkpoint

Source base plus uncommitted feature changes; preview `http://127.0.0.1:3105`, isolated home `/private/tmp/claude-runner-default-qa`. Initial CLI seed and ordinary UI creation both saved native Claude / Opus 5.5. Native experiment was disabled before UI setup and task. Existing setup tools succeeded using the verified SDK CLI 2.1.286 in this instance-only PATH; global CLI 2.1.245 was insufficient for Opus 5.5 and was not modified. PostgreSQL install required local postinstall links/signature repair after lifecycle-disabled installation.

UI agent `a0e75080-86de-427a-8ac3-3743c6d076ae`; task `CLA-1`, `6ddff45d-9974-4bd6-976a-f586393ed8f5`. First native run `42773dcb-cbb2-4deb-a495-ca5b3f451780` succeeded with `acpx_runtime` and observed model `claude-opus-5-5`. Independent attachment download: 125 bytes, sha256 `839680679537dfcc8700661347623f0fc1eef7a35e4593dd851a1389bbdc14fc`, three requested checklist items.

The run exposed missing Opus 5.5 pricing. Its immutable receipt remains unpriced, with reported input 15611, cache-write 15599, cached-input 135871 and output 2194 tokens. Preserve an $8 hold. A narrow rate-card addition uses official standard rates 4 / 0.2 / 8 (one-hour cache-write upper bound) / 20 USD per million; first-run independent upper-rate estimate is $0.1958942, not an invoice. Both QA policies blocked unpriced usage and paused after completion. Before the follow-up, retain the $8 hold as explicit policy reservation, allow the known historical unpriced receipt only in these disposable QA policies, keep the $8 additional billed-spend hard stop and no automatic paid retries. Total conservative hold/allowance $16 of the $50 ceiling. No historical receipt is rewritten.

Checks: 66 selection/model tests, 111 agent form tests, 78 other affected UI tests, UI/server noemit and token gates passed. Native eligibility regression passes; Opus pricing check passes after the provenance formatting correction. The mocked route suite subsequently passed 47 tests with localhost access enabled; the initial timeouts came from sandbox listener restrictions.


Follow-up run `60e7f9a2-aff3-40b3-8493-2ede6c59da72` succeeded after a controller restart. The task session was reused and the observed model remained Opus 5.5. Estimated Anthropic API usage: `$0.269886000`. Second attachment is 178 bytes, sha256 `ae6fad75dfa46c4c444ad203dff8029359721e19249c04ec1faba9eb6c3d3341`, preserving the first three items and adding the requested revision. Independently re-downloaded the original after the follow-up and confirmed it remained unchanged. Both runs reached Done; saved agent configuration and native experiment=false persisted across restart.

Product evidence: [task and both downloadable artifacts](http://127.0.0.1:3105/CLA/issues/CLA-1), [first artifact](http://127.0.0.1:3105/api/attachments/3b1b6033-78b4-4a0b-99ae-de363d7f5071/content?download=1), [revision](http://127.0.0.1:3105/api/attachments/857add4a-ef8c-4146-b9c5-be9affc32565/content?download=1). Sanitized receipt: `/private/tmp/claude-local-api-acceptance.json`.

Runtime: daemon source `d522822a5daeb72d124360b576b82a8bb52b43f4`, executable sha256 `d0656673f7b6dfa6f2554fac18f3e0b42e2eb10f444b06f6063255335d71aa14`; SDK CLI 2.1.286 sha256 `75e3016e9d2570767b08e43a7467d4817a4f149232c169ca295f2c95fef21433`. The planned effort transport changes require a new remotely built daemon and affected acceptance reruns; they are not covered by this baseline-runtime evidence.


## Behavior candidate and cloud checks

Implementation commit `6fd56c445d` adds the Apple Silicon default, native-input v7 effort admission, compatible settings/preservation, existing authentication routing, and Opus API pricing. Historical v1-v6 readers and Codex/Pi admission remain covered. Focused runner tests passed (197 tests before the additional three admission/recovery tests; the new focused admission/recovery suite also passed 111 tests). Focused server selection/provider projection, UI/import, routing and token gates passed; two stale experimental-gate fixtures were corrected and the New Agent suite then passed 60 tests. Updated server/runner/UI TypeScript checks passed. Required broad checks and the updated daemon run in cloud CI.

Reconcile the latest Codex dependency (`dcdf09a0f3`, direct descendant of the requested baseline), preserve its newly supplied four-target producer/consumer work, and keep Claude automatic selection restricted to Apple Silicon. No Docker build ran locally. The baseline local API proof remains tied to its original runtime; new effort acceptance requires the cloud-built candidate.


Frozen runtime candidate: `5f0b898e9ecef77afefe309a230e04d7fef66cde`. [Cloud daemon and clean-install qualification](https://github.com/paperclipai/paperclip/actions/runs/38273229107) uses the reconciled source's four-target release matrix. [Cloud required-source verification](https://github.com/paperclipai/paperclip/actions/runs/38273238920) resolves the branch to an immutable target under the trusted master workflow. Both are in progress; no passing claim yet. Image publication is disabled. All Docker/Rust compilation is remote.

Subscription setup is prepared through the ordinary Claude Code wizard. The existing host CLI account is Paperclip Team (`claude.ai`, Team subscription), but the provider browser requires fresh reauthentication after selecting that organization. The user has been asked to complete that sign-in; no credential was extracted from the host or pasted into chat. The API-key preview/artifacts remain available while the subscription draft is pending.

## Cold-resume diagnosis and corrective candidate

The remotely built candidate daemon passed all four producer builds, but package assembly failed on a TypeScript error in Claude task-effort projection: runtime selection profiles expose a backend, not provider/agent properties. The projection now reads the persisted adapter configuration. No daemon Rust change is needed for this correction.

Actual high-effort first tasks succeeded for API-key and subscription agents. Their cold follow-ups rejected session admission before a task prompt. A bounded existing-runtime diagnostic submitted zero prompts/tools and captured only static admission errors and effort options. It identified `session/resume`, newly used by the pinned ACP library, as missing from the configuration acknowledgment guard. The guard now correlates resume acknowledgments just as it does load acknowledgments. Bound effort also persists in the private Claude settings used by cold connections. The corrected diagnostic admitted high effort with `providerTurns: 0`. Focused Claude/Pi/sandbox tests passed 68 tests; focused Product E2E fixture checks passed 91 tests. Server TypeScript passed after the projection correction.

Failed qualification records remain intact, including their pending-accounting/recovery fences. No historical receipt was overwritten or invented. Automatic approval review rejected a budget-resume action as potentially restarting paid work; the user then explicitly approved bounded resume plus one manual retry. The product refused resume while accounting remained pending, and no provider retry occurred. New disposable fixtures preserve those failures while proving the corrected execution path. This recovery/accounting condition remains a recorded acceptance limitation until resolved.

Current aggregate company policy caps: original QA $17 (including an $8 unknown-charge reservation), old candidate $9 (retaining its failed-start reservation and known spend), API-effort acceptance $16, fresh subscription acceptance $8; total $50. Agent policies share their company allocations. Timer heartbeats are disabled, no automatic paid retry campaign is enabled, and only the explicit small acceptance turns are authorized. Reservations and estimates are not invoices. Known API estimates before the final pair: original follow-up $0.269886 and candidate first task $0.1906868; the original first receipt remains unpriced.

The first subscription artifact was independently downloaded and matched the exact 153-byte oracle, sha256 `ef76358a83a31dcb5759ee4384b92fa7a0ce1801b093352e5e6a548e0fbb7512`. Its run used `acpx_runtime`, observed Opus 5.5, and recorded `subscription_included`. The new API wizard saved native Claude, Opus 5.5, and high effort without a runner override; its 137-byte first artifact matched sha256 `fe24122962056946d5d01f693342c86fd83e22dbb21d6d0bc20d35f220f7952c`. Updated-runtime follow-up acceptance is still in progress.

Cloud source verification retained failures rather than claiming a pass: the projection TypeScript error; a 15-minute full-suite timeout; stale Pi catalog identities inherited from the dependency branch; installed-startup fixtures exposed to pnpm's NODE_PATH; and absent historical Git objects in the shallow checkout. The corrected fixture expectations preserve current Pi qualification boundaries and explicitly test rejection of ambient Node injection. The cloud source-check step now fetches only the two exact historical fixture trees and gives the full test command a bounded 60-minute slot inside an 80-minute check step. Required checks and clean-install consumers must be rerun on the corrected source before PR-ready handoff. Docker and Rust builds remain cloud-only.

## API-key acceptance after the resume correction

The user redirected remaining live execution checks to the API key in `~/.secrets`; the fresh subscription sign-in was closed and its unused company archived. Do not require more attended subscription sign-in for this delivery. Preserve existing connection tools and the prior successful subscription first-task evidence; subscription follow-up qualification is not claimed.

Ordinary API-key wizard agent `688ff15d-eb48-4cb5-9f31-2d394ab3fbbb` saved `paperclip_runner` / `acpx` / `claude`, model `claude-opus-5-5`, effort `high`, and the existing responsible-user API-key connection. Preview: [successful API task and revision](http://127.0.0.1:3105/CLAA/issues/CLAA-1). Runs `271e0877-c60c-4ac7-aa1a-7b075481872b` and `eb95ed4d-c219-463e-b04a-1bc4ac83c012` both succeeded with `acpx_runtime`, acknowledged high effort, and metered Anthropic API attribution. Estimated costs: $0.194798400 and $0.342168800. The task, provider, and backend session identities all matched across the controller restart; private provider IDs are omitted from the report. Both runs finished accounting. Saved settings and `enableNativeRunner=false` persisted after reload.

Independent downloads matched both byte oracles, and the original remained unchanged after the revision: v1 137 bytes, sha256 `fe24122962056946d5d01f693342c86fd83e22dbb21d6d0bc20d35f220f7952c`; v2 194 bytes, sha256 `0232a93ccc4da44fd156907b22a64b14487a981fdf12ab9cf73b4ef20d755816`. [First download](http://127.0.0.1:3105/api/attachments/fe58953d-7d1d-4b33-9548-c7611a2e82c6/content?download=1), [revision download](http://127.0.0.1:3105/api/attachments/3a0b5877-5afc-4088-b958-daa3c0b61f61/content?download=1). Sanitized report: `/private/tmp/claude-final-api-acceptance.json`.

Executable identities: daemon source `5f0b898e9ecef77afefe309a230e04d7fef66cde`, sha256 `228c7814c4786614c8358b205da01cf43df822ca5e6f6b74d5a1e8304d03a6de`; sidecar sha256 `daabddfc1373e6b6d2a754cb60bc4c33d7a8b6d6d5c3564ce511ebfaeb8a463d`; Claude SDK 0.3.286 executable sha256 `75e3016e9d2570767b08e43a7467d4817a4f149232c169ca295f2c95fef21433`. Behavior source is `9788c05d0a9825d825c0461eab3191da6a6dcad7`. Reconciled source `966b3d5bc294442f71c1def9406ed2027f41d191` merges Codex dependency `123a18837478d8cd0e2aff23f7e7aa86c9107de3`, retaining its GNU libc 2.39 gate and Linux ARM64 selection. Claude admission/sandbox/input and daemon Rust sources did not change during that reconciliation; the rebuilt sidecar digest is identical. Updated runner TypeScript build, server TypeScript, 95 selection controls and 15 installed-startup controls passed after reconciliation.

[Corrected cloud source checks](https://github.com/paperclipai/paperclip/actions/runs/38279356267) and [corrected four-target packaging](https://github.com/paperclipai/paperclip/actions/runs/38279359427) run on frozen behavior source 9788c05. Carry forward only unchanged evidence; final source and package consumers still require passing checks. Active company caps after archiving the unused subscription-only fixture total $42: original $17, failed candidate $9, API acceptance $16. Agent limits share these allocations, and unknown-charge holds remain in place. Known API estimates now total $0.9975406; this excludes the original unpriced receipt and is not a provider invoice.


## Approved prerequisite split and current CI

The behavior PR now targets the protocol branch and has 64 changed files. Protocol #15994 targets the latest Codex dependency and adds the shared v7 effort/resume contract with historical readers. Cloud Docker-context verification found that `.dockerignore` omitted the new Pi v23 and Copilot v18 identity inputs; explicit exceptions retain them without broadening the fixture context. The old 9788c05 package campaign passed all four daemon producers and Apple Silicon clean install, but the Linux ARM64 consumer failed durable-suspend settlement. Retain that failure; current-source package qualification and ARM diagnosis remain required. No local Docker or Rust compilation occurred.


## Platform candidate implementation

The isolated platform checkout is `/private/tmp/claude-runner-platform-pr` on
`codex/claude-runner-platforms`. It preserves behavior candidate `8d07b40907`.
The pinned Linux ARM64 Claude SDK 0.3.286 archive passed registry SHA512
integrity, ELF aarch64 inspection and an actual no-prompt version launch on
the authorized cloud ARM host. Its executable SHA256 is
`0292fa22ac2fd43e16be9d0e511ddd8347280d6e0ebaca744ef5b27e05d8d0f8`.
Native admission retains descriptor/no-follow, package and architecture checks.

Release producers now retain target-owned Linux x64 and ARM64 provider-pack
identities and relocatable archives separately from daemon receipts. Assembly
binds both target identities to its daemon source and vendors the manifests.
ARM inventories cannot claim additional Pi, Cursor or Copilot qualification.
Mac controllers probe the selected Claude remote target and select its packaged
identity without a development override. Installed SSH hosts use the standard
pack locations. Additional automatic defaults remain gated pending evidence.

Focused platform checks: pack integrity11, release workflow67, native remote
manifest/selection12, executable/profile/path86 passed (six platform skips).
The first new ARM selection test failed from shared durable fixture identity;
a unique workspace/session per case fixed the fixture. No product guard was
removed. Platform TypeScript build passed. Cloud package and actual Linux task
pairs remain required. Current behavior package campaign:
https://github.com/paperclipai/paperclip/actions/runs/38284813521 .

## Review and qualification update after the prerequisite split

Review stack: [protocol #15994](https://github.com/paperclipai/paperclip/pull/15994),
[behavior #15993](https://github.com/paperclipai/paperclip/pull/15993),
[platform #15997](https://github.com/paperclipai/paperclip/pull/15997).
Before the latest dependency reconciliation, protocol `33c9216614` and behavior
`23d834fc0a` each received 5/5 with their findings resolved. Platform pack parity
was corrected in `4dc13aa32c`; its review still requires refresh. All remain
unmerged drafts pending checks and final qualification.

Further fixes keep explicit Auto effort cleared through native imports and use
the resolved Claude harness for task model/effort overrides and compatibility
validation, including saved profiles without `acpxAgent`. Builder/provider88,
import52 and server noemit passed. Native v7 answered-question constraints now
point to the compact envelope; native contracts/runtime-context58 passed. The
clean-install Pi probe now binds both v23 and its exact digest. Install-sandbox
controls21 passed.

Native Linux producer packs previously contained a daemon under `dist/bin`
that was absent from image packs. Both builders now exclude controller binaries
and remote-pack identities before hashing their provider tree. Parity/integrity13
and image content9 controls passed. Actual rebuilt pack/image identity and paid
remote execution remain gates. No provider boundary was widened by this fix.

Candidate campaigns `38284813521` (8d07b409) and `38285667342` (d0da37c2)
completed all four daemon producers and both Mac clean-install consumers.
Linux assembly retained package bytes but failed the stale Pi install-probe
assertion, now fixed. ARM host startup exposed the precise Codex prerequisite
error: stock Bubblewrap's network namespace was denied by the host AppArmor
policy. The latest dependency `665c155472` supplies verified stock distro
prerequisites and retains the host restriction values before and after setup.
The stack is reconciled with that branch, including its master fixes and cached
build preparation. Reconciled Pi evidence/installed controls87 passed.

The cloud ARM pack from d0da37c2 passed GitHub ZIP digest validation,
bounded archive extraction, recorded artifact hashes, relocated Node/Claude
version launches and the shipped no-follow Claude admission probe. ZIP digest:
`9589de44e923b336e6a4b09bacbfd8ae66de1473577197731bc85e8eefd174a0`;
pack identity: `sha256:6e283f3069e38a2f00cd1b752f10d8147f633dc5be4b60e85ae15a1b762bcfd1`;
daemon: `sha256:0adbf14efb2b5b2826044aa0f55f50a0a779d0f5751d7a7a2526f494ffb9e1bc`.
The pack is installed at the authorized SSH host's standard runtime location;
an ownership receipt records this disposable qualification installation. No
existing pack was replaced. These software checks submitted zero prompts and
used no API key. Pack-parity changes require a new identity before final proof.

The hash-verified 8d07b409 public packages were installed without lifecycle
scripts into `/private/tmp/claude-installed-8d07-preview/consumer` for an actual
installed preview. This is preparation, not a passing installed task claim.
The existing successful preview/data and all unknown-charge holds remain.
No additional paid turns occurred during this review/packaging work; aggregate
active company caps remain $42 of the $50 Claude ceiling. Remaining live checks
use API keys per the user's steering. No Docker or Rust build ran locally.

## Installed API-key acceptance and latest review corrections

The installed 8d07b409 public package preview is now usable at
[CLAA-2](http://127.0.0.1:3105/CLAA/issues/CLAA-2). Runs
`11155946-5239-4127-9c67-ff23acf961c2` and
`5f0e4191-9dd6-44ef-bc0a-0b66a910ec2c` succeeded using the saved API-key
connection, Opus 5.5, admitted high effort, and normal installed daemon
resolution with no runner override or ambient Claude credential. Accounting
completed: estimates $0.197602000 and $0.136576400. Known estimates now total
$1.331719; unknown-charge reservations and aggregate $42 caps remain intact.

The controller restarted between turns. Task, provider and backend session
identities matched privately; IDs are redacted from the sanitized report
`/private/tmp/claude-installed-api-acceptance.json`. Agent settings and the
completed task persisted after reload with the native experiment disabled.
Independent downloads matched v1 (168 bytes, SHA256
`858f0438f048937dcd2e357a77f77e058582968215d33d5857637cd37fcfdb94`) and
v2 (222 bytes, SHA256
`4efd87a1f3a9d946d4278906bb779c4e3c0c83ec92faafdc29b9d6da28cada6d`);
v1 remained unchanged. [v1 download](http://127.0.0.1:3105/api/attachments/4fa30ccf-f6bd-47a5-83f3-564c1b16a138/content?download=1),
[v2 download](http://127.0.0.1:3105/api/attachments/af0f2c2e-a0f1-4138-980e-f93f5b48d2cf/content?download=1).
Installed daemon SHA256:
`36bbf4d878bfaa23e2fcec443e117cf04f46006ff8815c64855491b7bd3e440f`;
sidecar SHA256:
`ca6cad1f9b2fb2822d940d281a383360076c2ac03ea2ac875e64662f4719ae13`.
This source predates subsequent review fixes; final package qualification and
subscription follow-up are not claimed.

Latest behavior corrections preserve plain environment model bindings, reject
unresolved default/model-routing bindings, retain native translation when an
import explicitly switches to Legacy, and clear every effort alias on an
incompatible model change. Selection/import/form controls: 271 passed; server
noemit and token gates passed. Current historical instruction admission: 6
passed. Platform `33077bed73` pins producer Node to the image's 24.21.0 version;
its narrow policy exception and workflow controls passed (71 tests).

[Four-target campaign](https://github.com/paperclipai/paperclip/actions/runs/38293566808)
and [cloud image build](https://github.com/paperclipai/paperclip/actions/runs/38293576503)
retain source `557c3064a30779e86e1ae312eab3d1d42c3a8b8d`. Actual pack/image
identity agreement remains required. Additional Claude defaults remain gated
pending clean-install and execution evidence. No local Docker or Rust build.

### Independent cloud pack comparison and explicit-asset compatibility

The cloud image build `38293576503` passed. Its immutable image is
`ghcr.io/paperclipai/paperclip-daytona-runner@sha256:d9dbda3a9435e3e555f431bdeb0ba22e1241ae9103184e6c1646a200e26423e1`.
The image manifest, copied from a stopped disposable container on the cloud
host, exactly matches the independently downloaded Linux x64 producer manifest:
pack digest `sha256:97f44524d1b35ed6295c922f6b52ac376960213be0a0e09a3635c281db26aecf`;
Node digest `sha256:7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`;
provider-tree digest `sha256:83aafb7d6c951c1fa31c0d8bbbfd32c39b4d265b01607cd566c55c8d9b4a6143`.
Both bind source 557c3064a3. This is actual byte-identity proof, not task execution.

The independently downloaded ARM producer archive has storage SHA256
`7c219420b02149cdc3f44c6c5073bed40631d26c03d06f0b109a9ff36962c9c7`;
its pack digest is `sha256:51fe734d79211b474ee13f53080ac60f07cdc9315ebd33b703ecf4a7dc0f8ce1`.
Bounded extraction checked 7,244 members, all recorded artifact hashes and
absence of controller binaries. The shipped Claude admission probe passed on
the native cloud ARM host with zero provider turns and no credentials.
The prior installed pack remains available separately.

Latest platform review found the automatic Linux restriction also affected
explicit Mac SSH assets. The restriction now applies only when selecting a
bundled pack; explicit assets retain their existing manifest integrity checks.
Eight targeted controls passed, including both Mac architectures and unchanged
automatic Linux selection. Final broad source checks run in the cloud on
reconciled `06c4f5e5a0`: [campaign 38296110502](https://github.com/paperclipai/paperclip/actions/runs/38296110502).
The behavior head `2874232d25` received 5/5 after its three settings fixes.

Installed Mac proof is available as a Paperclip
[acceptance report](http://127.0.0.1:3105/api/attachments/61653e0a-3ae0-459c-b1d1-20b5d1db73d6/content?download=1)
and [screenshot](http://127.0.0.1:3105/api/attachments/bce37c56-3984-45b9-a995-b6a23cc9a85d/content?download=1),
with artifact work products on CLAA-2. The actual native SDK is the server's
nested 0.3.286 package, executable SHA256
`75e3016e9d2570767b08e43a7467d4817a4f149232c169ca295f2c95fef21433`;
the top-level Legacy SDK is a separate dependency and was not this runtime.
## Four-target packages and SSH launch repair — 2026-10-12

The frozen `557c3064a30779e86e1ae312eab3d1d42c3a8b8d` four-target
campaign above completed successfully, including all daemon producers, Linux
x64 public installation, both Mac consumers, and the native Linux ARM64
consumer. Consumer reports record clean npm installation and zero provider
calls. The raw packaging manifest's `publicInstallationVerified: false`
precedes those consumer checks; it is not rewritten as execution evidence.

The cloud image campaign succeeded with immutable image
`ghcr.io/paperclipai/paperclip-daytona-runner@sha256:d9dbda3a9435e3e555f431bdeb0ba22e1241ae9103184e6c1646a200e26423e1`.
Independent native/image Linux x64 manifest comparison matched pack
`sha256:97f44524d1b35ed6295c922f6b52ac376960213be0a0e09a3635c281db26aecf`,
Node `sha256:7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`,
and distribution `sha256:83aafb7d6c951c1fa31c0d8bbbfd32c39b4d265b01607cd566c55c8d9b4a6143`.
The installed ARM pack is
`sha256:51fe734d79211b474ee13f53080ac60f07cdc9315ebd33b703ecf4a7dc0f8ce1`.
The new existing-consumer Claude SDK admission hook passed 22 controls and a
real installed Mac no-prompt probe. The earlier frozen campaign predates this
hook; its Intel report does not certify that new hook ran.

The isolated preview now uses the real 557 public package with two recorded
controller overlays: the narrow existing Claude ARM setup allowlist and the
shared SSH argument repair. Normal installed daemon/package resolution stays
in use. The source is not misrepresented as an unmodified installed package.
The user-directed remaining acceptance uses the API key in `~/.secrets`;
subscription follow-up remains unverified.

ARM attempts `5ec7bc81-8023-4b5c-84c0-1886224ac4fa` and
`ebb8a76b-60d8-4881-a6ad-e60b6604ca9c` failed before provider startup.
The first lacked a remote WSS ingress URL. Qualification now uses the existing
explicit direct-WSS transport through a private TLS relay and authenticated SSH
reverse forwarding; both endpoints bind loopback, certificate validation stays
on, and protocol authentication is unchanged. The second exposed the first
causal launch error, `sh: 7: 1: parameter not set`: the shared SSH wrapper had
flattened `sh -c`, dropping positional arguments. Failed records and unknown
accounting holds remain intact; neither failure is reported as a successful
provider turn or zero-cost accounting completion.

Protocol `b833c609cf2da1aacb6ab29d062e23bb1865624c` preserves argv, applies
environment assignments after `exec`, and validates environment names.
Six regression controls fail before and pass after; 51 shared/Codex controls
and adapter-utils typecheck pass. The authorized cloud host passed both
execFile and stdin/spawn paths with exact literal quoted arguments and zero
provider calls. Private proof: `/private/tmp/claude-ssh-no-provider-proof.json`;
installed overlay: `/private/tmp/claude-installed-557-ssh-overlay.json`.
Module SHA256 changed from
`0b89740ef859923d3bb9cdddc09a836eab8ff9296b986eaee68700f766ea5bae` to
`a7f3ec5effa48d05a8388d77d130449dba52f3693afd8bed04c16378a7c764ae`.

The stack incorporates latest Codex composed source
`d3916151f65ca08904bda309474a35e4c48c54fe`. The authorized source-chat owner
will lift the identical shared SSH fix into prerequisite
[PR #16028](https://github.com/paperclipai/paperclip/pull/16028) before Codex;
our retained commit will coalesce on later reconciliation. That owner coordinates
normal squash merge order. No dependent PR or production deployment is performed
by this qualification session.

The failed fresh ARM fixture now retains its complete $1 unknown reservation
under a reduced $1 cap and remains held. A new repaired ARM fixture has a $3
cap; original $17, candidate $9, and local acceptance $16 caps remain.
Aggregate allocated cap is $46, reserving $4 for Linux x64, within the separate
$50 ceiling. Timer heartbeats and automatic paid retries remain disabled.
Known estimates remain $1.331719, excluding unknown charges.

[Required cloud source checks](https://github.com/paperclipai/paperclip/actions/runs/38302321706)
passed authorization and await a build worker. Current-source full checks,
latest reviews, useful remote task/follow-up pairs, additional platform defaults,
and final package qualification remain gates. No local Docker or Rust build.

## SSH cold-controller acceptance — 2026-10-12

The first repaired SSH task `9a6c3417-b961-47fb-bd25-06847d82e2e6`
succeeded with a checked file, admitted high effort, and completed API accounting
($0.195194600 estimate). Its follow-up failed before provider startup with
`prior_owner_terminal_state_indeterminate`; accounting completed without a
pending charge. The successful remote turn had already persisted a suspended
verified backup, but two controller migration callers allowed that backup only
for sandbox transport. The existing quarantine and task records remain intact.

Shared repair `e833e1d6c1cac6017f4effb59fbe0d22f0a9fcf2` allows selected
SSH remote targets to use the same integrity/full-scope/suspended-owner checks.
Two positive SSH regression cases fail before the repair; all 14 sandbox/SSH
backup scenarios pass after, including corrupt, conflicting and active state
rejection. Additional active-owner/full-scope controls bring focused coverage to
16 passing tests. Server typecheck passes. The source owner lifted both shared
repairs into prerequisite `00ac509b0a85336e4948a325dbde1cbf09378572`, composed
Codex `8de43be4cd7e71e7833ea268d9e6e59e77cde381`; our stack coalesces them.

A fresh bounded [ARM task and revision](http://127.0.0.1:3105/CLAAAAAA/issues/CLAAAAAA-1)
now passed. Runs `3c297604-23b4-4a42-a0af-185af05aad01` and
`09bae36d-32a5-4634-a0b8-0349cf405dc9` succeeded with Opus 5.5,
requested/admitted high effort, metered Anthropic API billing and completed
accounting: estimates $0.219495400 and $0.186328600. The controller boot changed;
task, provider and backend session identities matched privately. Both exact
oracles passed independent downloads after the revision; v1 stayed unchanged.

- [v1](http://127.0.0.1:3105/api/attachments/e94f7320-1197-4a4a-b27e-4447a9ecc58c/content?download=1):
  166 bytes, SHA256 `6263758fb2009dd6b70df03b1c3aa314a865ba1b2b81d5bda5cc6c079a17b7ab`.
- [v2](http://127.0.0.1:3105/api/attachments/a536415a-91c3-4e7f-8b45-46b09d5520bb/content?download=1):
  220 bytes, SHA256 `b7229581fb2b566485a023ed6b016e556e6bc66f3ab4d1bcf7b81c6abf61f9f4`.
- [Sanitized report](http://127.0.0.1:3105/api/attachments/5db4c71b-cb01-4a91-972d-49bcec527d7f/content?download=1)
  and [screenshot](http://127.0.0.1:3105/api/attachments/998dac47-837f-46a9-b821-a77499809031/content?download=1)
  are attached artifact work products. Uploading them left the run count at two.

This proof uses public package source 557 with the recorded setup/argv/cold-resume
controller overlays and the verified standard installed ARM pack. It is not an
unmodified-final-package claim. The cold-resume compiled module changed from
`205e27e8a0dda494585600d87b98545d5601822e5bd77c79505101419719a1b7` to
`1c75aa00142f5657a416debba44717548ad5106a763821ed1f8cb0309167ab71`.

The prior successful-but-failed-resume fixture is paused with a conservative $1
allocation; the fresh ARM pair uses $2. Original $17/$9/$16 allocations and the
failed prelaunch ARM fixture's $1 unknown reservation remain. The Linux x64
fixture has $4, making aggregate allocated caps $50. No automatic paid retries
or timer heartbeats are enabled; remaining acceptance uses API keys per the user.

## Linux x64 task and cold-controller revision — 2026-10-12

The [Linux x64 acceptance task](http://127.0.0.1:3105/CLAAAAAAA/issues/CLAAAAAAA-1)
and follow-up succeeded on the immutable 557 cloud image through the existing
Daytona integration. Runs `ba8ff6f0-d88d-4369-b03e-a88cf2a3dafa` and
`f9675055-6f9f-4ec2-aa7c-31b3a784dffc` used Opus 5.5, acknowledged high
effort and the fixture's selected API-key connection. Accounting completed:
estimates $0.178204600 and $0.135639200. The controller restarted between
turns; private task/provider/backend session IDs matched. Both versions passed
independent exact byte/hash checks after the revision and persisted after reload.

- [v1](http://127.0.0.1:3105/api/attachments/b7ebc13d-a09f-414f-84fc-a36d0dac9975/content?download=1):
  176 bytes, SHA256 `97d7ddbea0d3d1a1aad23673692ff3719fc83d8b8e7c66da4fc1f70af79d9672`.
- [v2](http://127.0.0.1:3105/api/attachments/e238108d-3a61-42c7-a305-b2199b97a291/content?download=1):
  230 bytes, SHA256 `426e41d0c76b037322aec212c60ece80d91b05ca9064aaab17a7e7950dc9416f`.
- [Sanitized report](http://127.0.0.1:3105/api/attachments/9f619e2f-6bca-4059-9a35-7e1651863395/content?download=1)
  and [screenshot](http://127.0.0.1:3105/api/attachments/3eb53a63-f8fc-483e-8b53-18439b87185b/content?download=1)
  are attached work products.

The pinned official Daytona package `2026.1005.0` (manifest version `0.1.8`,
SDK `0.203.0`) is registered from the private qualification installation.
The first existing installer request used its shared package directory and
failed to resolve a version-suffixed package name; no global plugin record was
adopted for this fixture. Shared package files were left intact. Subsequent
installation disabled lifecycle scripts and uses the private directory.
Company-scoped Daytona and Anthropic secrets remain separate, with Anthropic
connection installation restricted to the qualification agent.

This proof uses the exact 557 installed controller plus its recorded overlays
and image/pack identities; it does not qualify an unmodified final release.
Known Claude API estimates now total $2.2465808, excluding earlier unknown
charges. Aggregate allocated company caps remain $50; holds/reservations and
failed records are preserved. No automatic paid retries or local Docker/Rust
builds occurred.

The source owner is correcting additional shared review findings and will
provide the next source freeze. Final packaging waits for that freeze. The
platform PR can now apply the additional target default changes using the
passing package/clean-install and API execution evidence, while final packaged
runtime, current-source required checks and exact-head reviews remain handoff
gates. Subscription follow-up remains unverified under the user's API-key
steering; Intel Mac requires clean installation, not attended provider turns.


## Current dependency and review reconciliation — 2026-10-12

Reconciled source-owner prerequisite `d16eccf109b524778ceb896f79ccb3881bc61a9b`
and Codex `eee0534154eaf5d0d3f2bbc97c1e24d86f34a5a5`. The latest Codex
Linux ARM64 default remains intact. Sandbox automatic selection uses the
server-owned probe bound to effective configuration and an immutable image;
unknown or mutable sandbox identity stays Legacy. Disabled Codex does not block
Claude's SSH platform probe.

The behavior composition preserves the shared ACP-alias rejection and imports
saved native configuration by applying actual form changes. Explicit empty
model/effort and account-binding removal remain removals. Mounted Codex and
Claude import cases cover ordinary edits, model/effort clears, connection-binding
removal, Legacy selection and harness changes. Switching a Legacy Claude import
to Paperclip preserves deny-all/approve-reads through the native builder.
Current import/builder controls: 123 passed; mounted existing-agent form controls:
121 passed, including hydration and explicit Auto clearing for both harnesses
and all three effort aliases. Server/UI noemit, token gates and capability-map
checks passed. Profile source controls: 31 passed. The Pi install probe now
reports the exact profile version it actually validates.

Platform review repairs retain explicit supported runner choices while keeping
Darwin SSH automatic Claude selection on Legacy until automatic Mac remote packs
exist. Local Mac defaults and GNU/Linux defaults remain qualified. Discovery
tries every standard preinstalled pack candidate through the full verifier; a
stale `/opt` pack cannot hide a matching user installation. Failed verification
still uses the existing upload/error path. These controls are separate from live
provider execution evidence.

[Cloud required-source campaign](https://github.com/paperclipai/paperclip/actions/runs/38302321706)
completed on immutable source `b754869376e7bee831e87d879d5d89575044cb04`:
recursive typecheck, build, token gates, Runner E2E typecheck, 124 Runner E2E
unit files (2619 tests), and public installation verification passed. The full
`pnpm test:run` command exceeded its 60-minute bound (exit 124); this is incomplete,
not a passing full suite. Its artifact `11775656103` preserves source, logs and
statuses. Final exact-head checks must use the existing complete sharded test
coverage or finish the full command on cloud infrastructure.

A read-only accounting audit records allocated caps of exactly $50 and known
ledger estimates of $2.246580800, excluding unknown charges. The original QA
policy retains its earlier approved `allow` setting and $8 unknown reservation
under a hard stop; other live qualification policies block unpriced work. The
historical candidate's $9 allocation and failed records remain reserved. Its
port has a listener but current API health did not respond, so its current policy
state is unconfirmed rather than asserted stopped or reverified. No accounting
hold was cleared by this audit. Timer heartbeats and automatic paid retries remain
disabled. No local Docker or Rust builds occurred.


## Complete CI fixture corrections — 2026-10-12

The first current-head matrix exposed stale fixture assumptions after graduation:
experimental harness-switch rejection still targeted Claude, Linux SSH creation
still expected Legacy, and Legacy instruction/skill cases relied on an implicit
runner. The gating case now uses Pi; all 56 validation-route controls pass.
Qualified SSH creation asserts native Claude/Opus 5.5; all 92 permission-route
controls pass. Legacy instruction/skill fixtures explicitly choose Legacy.
The native Claude creation/hire matrix now checks preserved skill-version pins
and CEO defaults, while omitting the legacy operational skill supplied by PRP.
All 111 skills-route controls pass. Builder/config controls retain the shared
package and mounted-form evidence rather than a duplicate UI pure-function test
that expected blank effort to restore saved values. The historical missing-form
fixture now deletes the property instead of assigning an invalid typed undefined;
Codex package noemit passes. These corrections make no provider calls and change
no runtime artifact identities.


## Final shared source freeze and corrective matrix — 2026-10-12

Composed published prerequisite `5a9ce11c49db31440863d633426ebe30bcc850ca`
and Codex `a583630e1c128c6d577b236b7ea9b73cf1be0bdd` without changing
Codex Linux ARM64 selection. The inherited network-admission guard rejects an
effective ACP no-network setting or a deferred policy reference with explicit
Legacy guidance; existing trusted native policy remains separate. The source
owner retains normal merge ownership and will send the actual master merge
identity before final reconciliation.

Fresh reviews reached 5/5 with no open findings for protocol `66f20c4682`,
behavior `628754f6dc` and platform `0a8677d15c`. The subsequent corrective
composition includes reviewed shared changes and the test-fixture corrections;
its exact-head review/CI remains required. Packaging/assembly controls now pass
91/91 after the inert target JSON copy fix. Composed platform selection, pack,
import and mounted-form controls pass 341/341; server noemit, maps and token gates
pass. Native declarations match the release manifest without regeneration.

Database-backed lifecycle, connection-pool and controlled catalog cases pass
121/121 on the behavior branch. Qualified platform onboarding/built-in/catalog
fixtures now assert native Claude directly, including preserved Haiku and role
skills. Their local database initialization hit hook timeouts; the existing fresh
cluster fallback skipped those suites. Neither result is an execution pass, and
full cloud execution must validate them. Custom ACP Stop/recovery browser fixtures
explicitly select Legacy for their custom commands/state paths; latest cloud
browser execution remains required. No provider turns or local native/Docker
builds were added by these corrections.


## Lifetime ownership and resolved Legacy limit — 2026-10-12

The fresh protocol review identified a real ownership violation: sandbox
preparation rewrote active Claude settings before a contender acquired the
provider lifetime lease. A fake-provider/real-lease regression reproduced losing
the active owner's saved high effort and marker when the second opener was
rejected. Repair `4cdb5ec4b38d792b432993a9a4b722090813a8ef` defers the
Claude settings write until after lifetime ownership is acquired and before
provider launch. Cancellation retains the lease until that filesystem write
settles. A later legitimate owner can initialize normally. Host, sandbox and
profile controls pass 104/104; runner noemit and unchanged declaration generation
pass. No provider process was launched by these controls.

Fresh behavior review also found the Legacy form's default 1000-turn cap was
omitted for Auto even when the selected target resolved to Legacy. The form now
passes a transient resolution to the builder; unknown/Legacy Auto and explicit
Legacy retain the cap, while resolved native omits only that Legacy default.
Explicit custom limits still reach compatibility validation. The hint is absent
from execution config and API overrides. Onboarding uses its existing discovery;
import excludes hint-only updates from meaningful edits. The same builder carries
explicit native permission choices from the ordinary create form. Mounted forms,
builder, imports and onboarding pass 298/298; adapter-utils TS build, Claude/UI
noemit, maps and token gates pass. No local Rust or Docker build or new paid turn.

The prior corrective platform source `a97a681f1caf90627505097cdcd368356811ffc1`
passed all required cloud checks and fresh 5/5 review. Behavior and protocol
required CI aggregates passed before these two findings. New repair heads require
fresh exact-head CI/review. Prerequisite #16028 is not merged: normal auto-merge
is queued for actual code-owner approval. Dependent branches have not been
retargeted as if master contains that prerequisite. Final packaged runtime and
source reconciliation remain gated; the source owner retains merge ownership.

## Guided setup and source-attestation correction — 2026-10-12

Fresh review reproduced another ordinary creation gap: `NewAgentSetup` supplied
Auto without its discovered runner, causing native Claude to receive Legacy's
1000-turn default and fail compatibility validation. Repair `e2e5c60496` passes
the existing environment-scoped discovery into the transient builder hint. All
63 mounted setup controls pass, including native, Legacy and unknown Auto with
the native experimental flag disabled. UI noemit, maps and token gates pass.
The hint is absent from saved execution configuration and request runner overrides.

Exact-head cloud runner controls also caught the ownership repair's changed Pi
shared-source closure. Declaration generation alone had not checked that closure.
Protocol repair `0ff31b2b76` publishes Pi profile 24 with command digest
`sha256:d25d674cda9a0853bdbf0521025099f1424c573d2f533630cb67d90e1bfcda3b`.
Immutable profile 23 is retained. Only the profile version and sandbox-source
attestation change; executable closures, models, effort and platform qualification
remain intact. Copilot stays at pending profile 18. TypeScript/Rust declarations,
current installed-Pi probe and historical rejection controls are synchronized.
Profile/factory controls pass 122 with one historical skip; runner noemit passes.

Host/sandbox controls pass 78/78 on restored, uninstrumented source. Earlier local
expanded runs had one varying kernel-lease acquisition failure each; their logs
are retained, not relabeled as passes. This Mac's listener inventory contained
718 TCP rows. A temporary diagnostic group passed 78/78 and was fully reverted;
occupied-port contention is suspected but not independently proven. Sandboxed
loopback execution additionally failed and is excluded from valid lease proof.
Fresh cloud execution remains required to distinguish infrastructure contention
from a regression. Production ownership checks were not weakened and unrelated
listeners were not stopped. No local native/Docker build or paid provider turn.

Current platform Darwin SSH guard keeps Auto on Legacy for both architectures;
explicit matching assets and saved native choices remain supported. Both focused
x64/arm64 controls pass. The general review comment cites historical `bfa3a966`,
which predates this guard. Final package qualification will use one frozen
candidate source through the existing provider-free cloud workflow, with tooling
and product identities recorded separately. No publication, deployment or paid
retry is part of that campaign. The actual foundation code-owner approval and
master reconciliation remain external prerequisites for normal merge sequencing.

The first corrected candidate's cloud Docker-context check independently found
profile 24 excluded by the existing explicit attestation allowlist. The new
fixture now has its own exception alongside immutable prior identities; other
fixtures remain excluded. Cloud job 115053600515 retained the exact ENOENT
failure. No local Docker invocation was used. The next composed heads must pass
this check before candidate package qualification.

## Completed-discovery onboarding guard — 2026-10-12

Fresh behavior review reproduced a separate onboarding race: saved-subscription
verification could start while runner discovery was pending, building an
unresolved Auto configuration with Legacy's 1000-turn cap. Both delayed native
and Legacy cases fail before treatment. Onboarding now enables discovery after
its environment/settings/policy queries succeed and gates manual, keyboard,
saved-account and completed-login advancement on the matching completed result.
The builder receives that resolved value. Target or runner changes invalidate
an in-flight attempt; metadata-only environment refreshes preserve it. Discovery
failure or a missing harness result stops setup and offers an explicit availability
retry, without testing or hiring. No connection/authentication mechanism changed.

All 173 mounted onboarding/guided-setup/builder controls pass, including keyboard
submission while discovery is pending, both native and Legacy results, failed
availability/retry and obsolete-target verification rejection. UI noemit, token
and map checks pass. Earlier subscription/account/login controls remain intact;
the prior environment-refresh fixture now changes metadata rather than changing
its target ID, and a separate two-target control proves actual invalidation.

Protocol source `3aaf1f8b1e1e525378f0f2330fd5453a3ac1c252` has 53 successful
current-head cloud checks, including Rust, static checks, both runner unit shards
and Docker-context integrity, with fresh 5/5 review. Earlier local varying lease
failures remain recorded. Behavior/platform need fresh gates after this UI guard;
no final candidate package campaign has been dispatched and no paid turn added.
The retained installed preview has been inspected in light/dark mode with the
original theme restored and agent Save disabled. The browser's requested mobile
override did not affect its actual 1150-pixel viewport, so that attempt is not
mobile proof and its override was reset. Final responsive qualification remains.

## Warm metadata, dependency recovery and owned startup — 2026-10-12

Three warm-cache regressions reproduced configuration construction while required
metadata was unresolved. Onboarding now waits for current environment, settings
and policy reads as well as matching runner discovery, including refetch over
cached successful data. Each prerequisite failure is visible and Retry setup
refetches the required reads without testing or hiring early. This also closes
fresh review 4253377849. The neutral-role step fixture's empty discovery response
reproduced the exact cloud failure; it now supplies valid Legacy discovery while
retaining role/name assertions. All 193 wizard/step/guided-setup/builder controls,
UI noemit, maps and token gates pass. Exploratory guided-connection changes were
removed; its existing connection flow remains intact.

Cloud platform job 115058187599 exposed ENOTEMPTY during late-bootstrap cleanup.
A deterministic held-writer test proves transport close returned before owned
credential preparation settled. A separate production-probe test proves the
helper called cleanup-confirmed during that unconfirmed preparation. These are
actual ownership defects, not a waived filesystem retry. Protocol repair
`463ebb62661d81ef1fbd79ae0a7b43ece68830f8` tracks startup, joins it within the
existing close budget and blocks later activation/launch. A drain timeout retains
state; late registration retires only its owned route. Primary setup timeout and
unconfirmed cleanup both remain in the failure. Six no-provider controls pass,
including writer drain, bounded retention, late release/error and the actual
probe callback fence. Runner noemit, declaration generation and maps pass; no
provider process, local Rust or Docker build was used. Historical Pi/Copilot
identities are unchanged by this transport-only correction.

The repair is in this chat's protocol worktree, not the frozen upstream #16028.
Its placement must be reconciled with the source owner's normal merge sequence
before either default rollout merges. Automatic approval review rejected cross-
chat status messages because it did not accept the earlier approval retrieved
from the source chat as current-chat authorization; the direct coordination
question remains pending. Public PR/evidence updates continue within this task.
Fresh exact-head cloud runner/native execution is required, including the failing
late-bootstrap case. No package campaign or new paid task has been dispatched.

## Current cloud ownership proof and durable test envelope — 2026-10-12

Behavior `be0e68872fd5e043bc6242e0634471b2c1794336` passed all 54 current
checks plus two conditional skips, required verify/E2E and fresh 5/5 review.
Protocol `463ebb62661d81ef1fbd79ae0a7b43ece68830f8` and platform
`66925e79c9d9e8f7e51fd9ee5a518a778d34acf8` passed the previously failing
real late-bootstrap case and the new ownership controls. Their remaining runner
lane failure was a different fake-transport durable-resume case: it reached the
outer 5000 ms test timeout (1599 passed, one failed, three skipped). There was no
ENOTEMPTY or primary semantic assertion failure in those runs. The exact cloud
latency stage was not recorded and is not labeled an infrastructure flake.

That fixture deliberately includes a 500 ms killed turn, a resumed turn with its
own 5000 ms bound, and durable filesystem writes. A controlled 3800 ms resumed-
turn delay (within the existing turn bound) reproduces the outer 5000 ms timeout;
the identical treatment completes its semantic/usage/deduplication assertions
with a 15000 ms outer budget. The temporary delay was removed. Only the outer
fixture deadline and its rationale are committed; internal deadlines and all
assertions remain unchanged. The full fake-transport suite passes 72 with one
existing skip; runner noemit and maps pass. Fresh exact-head runner CI remains
required after this test-only correction. No package campaign, paid provider
call, local native build, Docker build or upstream prerequisite edit.

## Guided creation with refreshed settings — 2026-10-12

Review 4253594222 on behavior head `4440df2e44e346080308e40ec3287c94c7f776a2`
identified stale cached environment selection during a background instance-settings
read. The mounted reproduction actually calls setup against cached SSH/Legacy
before the pending current settings select local/native, rather than merely
observing a loading label. Guided Claude/Codex setup now requires current completed
environment, settings, execution policy, experimental policy and matching Auto
runner discovery reads before testing or hiring. Existing connection controls stay
mounted inside a disabled fieldset while refreshing, preserving an API-key draft.
Both the cached SSH-to-local case and same-environment discovery refresh pass;
all 65 guided setup controls, UI noemit, token gates and structural maps pass.
Logs: `/private/tmp/claude-guided-current-settings-before.log`,
`/private/tmp/claude-guided-current-settings-draft-controls.log`, and
`/private/tmp/claude-guided-current-settings-final-{types,tokens,maps}.log`.
This repair is prepared locally while the source owner integrates the common
transport correction; published behavior head remains the literal 4440 revision.
No paid turns, local native builds or Docker builds were performed.

Platform head `173a73ec95386d7b9eac50d87699a16ec27da3b3` failed a credential
fixture during its two-port reservation (EADDRINUSE before the production staging
call). The existing bounded three-port fixture reservation helper is extended to
hold two candidates, retrying fixture preparation only and never a production
staging call. A foreign-collision control verifies that foreign ownership survives,
the auth sentinel stays unchanged, and preparation stops within eight attempts.
All 42 credential controls and runner noemit pass locally after supplying the
worktree's declared tsx test loader. Logs:
`/private/tmp/claude-quorum-fixture-complete-controls.log` and
`/private/tmp/claude-quorum-fixture-final-types.log`. This test-only correction
is prepared in the protocol worktree and has not been published during the parent
integration hold. The independent serialized issue-route timeout remains under
phase diagnosis; a subsequent full mocked suite passes 36 controls but does not
waive the cloud failure or prove its latency cause. Final source composition,
required CI and the provider-free cloud packaging campaign remain pending.

## Serialized route fixture initialization — 2026-10-12

The failing inherited-pause cloud case timed out at its 15000 ms outer test bound.
Temporary local phase instrumentation measured cold route imports at 9741 ms
(and 11920 ms in a separate diagnostic attempt), followed by a POST 409 response
in 11 ms and PATCH 409 in 4 ms. The subsequent full mocked suite passed 36 cases;
these measurements do not establish the exact unrecorded cloud latency. Route
module loading now runs in beforeEach after the same per-case module reset,
unmocking and mock initialization. It uses the existing 30000 ms setup-hook bound;
the 15000 ms request/test bound, application construction, policy assertions and
mutation/wakeup checks are unchanged. All 36 treatment controls pass. Temporary
phase instrumentation was removed. Evidence:
`/private/tmp/claude-pause-route-phases.txt`,
`/private/tmp/claude-pause-route-targeted-phases.log`, and
`/private/tmp/claude-pause-route-hook-controls.log`. Exact-head cloud verification
is still required; no timeout is waived and no provider or native build was run.

## Mobile retained-preview inspection — 2026-10-12

The in-app browser's viewport override did not apply, including to a fresh tab,
so it supplies no mobile acceptance evidence. The existing Product E2E
`openConnectionBrowser` helper then opened a private temporary Chromium profile
against the retained preview. At an actual 390×844 viewport, light and dark
runner menus fit within the document's 390 px scroll width. Enter opens the
Runner listbox with native/Legacy choices; Escape preserves the saved native
choice. Screenshots fast-forward CSS color transitions. Mutation requests were
blocked by the test browser (none attempted); no provider prompts or setup probes
were sent. This is a bounded UI inspection, not a catalog workflow grade.

Evidence remains tied to compiled source
`557c3064a30779e86e1ae312eab3d1d42c3a8b8d` with the recorded controller
overlays, and must be repeated against final installed packages. The older
preview's Linux Legacy default label is not evidence for the later platform Auto
change. Report, light screenshot and dark screenshot are attached to the completed
isolated x64 task as work products, with independently downloaded SHA-256 matches.
The task stays done and the agent stays idle. The Product E2E helper's local source
is `42e5d9bae436254bba6747e7d26be0cce13b3d0c`.
Report attachment: `e6206748-a785-4c02-9bbf-f4db8a3b22f9`, work product
`e7f6a023-e754-424b-bdc5-eb4087a79172`; light attachment
`7c324aa1-d1c0-45cd-b314-c3106cac302d`, work product
`e81b6b06-e64d-4ed5-aca7-c936a5235c81`; dark attachment
`2815f32b-86d5-48ed-a0f4-7e35554e54ca`, work product
`6fb9753e-19e0-496f-bf0a-f2de4d331895`.
Local receipts: `/private/tmp/claude-responsive-preview-evidence.json`,
`/private/tmp/claude-responsive-evidence-upload.json`, and
`/private/tmp/claude-responsive-evidence-independent-check.json`.

## Canonical composition and current contribution rules — 2026-10-12

The source owner committed the stronger shared startup repair as
`ce23716503a2c9158b5a7ab74ab61571ff4ee7a3`. Local additive merges preserve
that parent and this chat's Claude effort/resume changes. Eight controls that do
not need native executables and runner noemit pass in the combined protocol.
The ninth selected readiness-cycle case timed out while waiting for readiness;
read-only resolution confirms both the default runner artifact and fake provider
fixture are absent, with no private runner override. That native case remains a
hosted CI gate, not a pass. No local native build was performed. Logs:
`/private/tmp/claude-canonical-startup-composition-controls.log`,
`/private/tmp/claude-canonical-startup-no-process-controls.log`, and
`/private/tmp/claude-canonical-startup-composition-types.log`.

The source owner then reconciled current master in `9f59ff36cf`, adding the
Storybook catalog and contribution rules against new code comments and code files
crossing 1000 lines. The guided-creation fixture is extracted to
`ui/src/pages/NewAgent.test-support.tsx`; all 65 cases remain and pass, with UI
noemit and token gates passing. Fixture component rendering stays inside its
mock-owning module, including the saved-confirmation reload case. The active test
file no longer crosses the threshold. Our added explanatory comments are removed;
the source owner handles the common transport's comment cleanup. Semantic code
and internal deadlines stay unchanged.

Removing this chat's added sandbox comments changes its raw source attestation to
`144d62b3415cfedf272b5b052e14af1e41fe50a644af84247fc9c20c7ef7edde`.
Immutable Pi profiles 23 and 24 remain retained. New Pi profile 25 binds only that
source revision plus its profile version, digest
`sha256:dd67387487dadb08da76534c057dc0aa059f7698d1779cbd5fc452813828167a`.
SDK/executable closures, platforms, model/effort contract and other providers'
qualification boundaries do not change. Copilot remains pending profile 18.
Generated TS/Rust descriptors, Rust current/prior fixtures, Docker context and
current documentation are synchronized. All 119 profile/factory/admission/effort
controls pass with one existing historical skip, including corrupt-byte rejection
before spawn/bridge; runner noemit and generation checks pass. The first restricted
attempt stopped at loopback lease admission and is retained, not counted as byte
validation. Native/Rust execution and final package qualification remain cloud gates.

The maintain-storybook source review found concrete fixture incompatibilities:
the general-settings endpoint and scoped runner-discovery defaults were absent.
The shared preview now returns that settings contract and explicitly simulated
Legacy discovery for Claude/Codex, exposes the loaded native adapter, and includes
Opus 5.5 while retaining explicit older-model examples. These fixture defaults are
not rollout qualification. Catalog fingerprints/classification and affected story
rendering must be reconciled after the final parent is frozen; source-only review
is not an executed Storybook or provider pass. Published draft heads remain fixed
while the source owner finishes the canonical contribution/catalog cleanup.

## Published canonical parent and later master blocker — 2026-10-12

The canonical prerequisite is published as
`64c074fb8da1b31f8d6042c4fef48dc4164e759b`; all 54 exact-head checks pass
with four conditional skips, fresh 5/5 and all review threads resolved. Its hosted
native transport suite passes 246/246, closing the fake-native-fixture limitation
for that literal source. Its four provider-free producers also pass, while clean
consumers remain in progress. Those checks are not relabeled as this chat's Claude
input/profile composition. Root retains sequential normal merge/staging ownership;
code-owner approval is still required and production is not promoted.

Local composition preserves the source repair with no duplicate lifecycle delta:
the transport diff against 64 contains only Claude effort additions. The old Codex
base branch `1a0ca66242121e39d88455aa2b52a07acc4a07d9` still lacks the current-
master parent, so publishing the current protocol would expose 468 upstream files.
The root-owned dependency must be reconciled before the review slices can again
be verified under the 100-file limit. Cross-chat dispatch still needs direct
human authorization in this chat; a concrete dependency-coordination question is
pending. No frozen root branch was mutated.

Master then advanced to task-workspace source
`f329b24ee12496e710ad17377ec7716e0eee22ef`, making the canonical prerequisite
conflicted. The source owner is reconciling its three conflicts and requested that
leaf CI/package campaigns wait for the next published parent. All local Claude
changes and earlier package/task evidence are preserved, and no new paid turn,
local Rust/Docker build or leaf package campaign is dispatched during that hold.

The current Storybook catalog is reconciled with 224 story files and all 2,223
pre-move IDs preserved. Fifty-three source-affected entries retain their prior
review classifications. Six bounded fixture plays and reset pass; exact cases,
source scope, simulated boundaries and omitted coverage are recorded in
`maps/storybook-map/REVIEW.md`. This does not qualify the final installed runtime.

## Task-workspace composition and qualification hold — 2026-10-12

The source owner published canonical prerequisite
`16a53254c495f3e49a28cc911f5dcd60c41779fc` against task-workspace master
`f329b24ee12496e710ad17377ec7716e0eee22ef`. This chat composed it through
additive merges, retaining the Claude settings and immutable profile changes:

| Review slice | Local code identity | Files against local dependency |
| --- | --- | --- |
| Protocol prerequisite, PR #15994 | `12113e431e37379901f2a39103816c8f2afec14a` | 678 against the older Codex branch; publication held |
| Claude behavior, PR #15993 | `cf1fa2e98285cf80d25b0681ab45761389b22a9d` | 88 |
| Platform qualification, PR #15997 | `4ba521823f8a92ba3fffcb5d6f578144466d848f` | 42 |

The existing published PR heads remain unchanged. The root-owned Codex branch
still needs the same current-master dependency before the protocol can meet its
review file limit. Canonical 16a's fresh CI has two failing runner cases, which its
owner is investigating; earlier 64c074fb success is not carried forward as a
16a pass. The source owner's provider-free cloud qualification is separate from
the final Claude package campaign.

Current composition checks pass: 189 guided-creation/form controls, 18
task-workspace admission/runtime-context controls, 25 platform consumer controls,
and nine Storybook catalog controls. UI, server, runner and runner-surfaces noemit,
map checks, token gates and profile generation checks pass. The platform tests
retain both Claude corrupt-package admission and the root's bounded Intel install
diagnostics. No provider task, Docker build or Rust build ran for these checks.
Logs are `/private/tmp/claude-16a-creation-form-controls.log`,
`/private/tmp/claude-16a-workspace-context-controls.log`,
`/private/tmp/claude-16a-consumer-diagnostic-controls.log` and
`/private/tmp/claude-16a-catalog-controls.log`.

Server noemit initially found a stale plugin SDK declaration where `projectId`
was still non-nullable. The source type was already correct. Refreshing ignored
shared/SDK outputs with the installed TypeScript compiler restored server noemit;
no product code or lockfile changed. The default pnpm wrapper's restricted-network
fetch failure is retained in `/private/tmp/claude-16a-sdk-refresh.log`; signature
checks were not bypassed. The successful compiler receipts are
`/private/tmp/claude-16a-shared-refresh.log`,
`/private/tmp/claude-16a-sdk-direct-refresh.log` and
`/private/tmp/claude-16a-server-types-refreshed.log`.

The usable preview remains `http://127.0.0.1:3105` on recorded installed source
557c3064 with the previously declared controller overlays. Its successful API-key
task/revision pairs and downloaded artifacts remain valid for those literal
identities. They do not certify the current composition. Final gates remain a
frozen Codex dependency, fresh checks/review on all three published slices,
four-target cloud packages and clean consumers, and current installed-runtime
acceptance within the existing $50 ceiling. Unknown-charge holds remain intact.
Merging and production deployment remain separate actions.

The retained preview stopped listening during the integration hold. Restarting
the same installed launcher restored health without changing its source/runtime
or isolated data. Read-only checks confirmed native Claude / Opus 5.5, the completed
x64 acceptance task, `enableNativeRunner=false`, and zero live runs in all six
checked QA companies. No task prompt was submitted. Receipt:
`/private/tmp/claude-retained-preview-restart-receipt.json`; launcher log:
`/private/tmp/claude-retained-preview-restart.log`. These checks confirm persistence
and preview availability, not qualification of the current source composition.

The source owner identified the same durable-resume outer-deadline failure in
canonical 16a and requested reuse of correction
`c60bf4b6b9ee7a6052ae9c95bd10fef90f3418f7`. Its single semantic test change is
the 15000 ms outer budget; the old explanatory comments have since been removed
under the contribution rules. The controlled before/after receipts and full
72-pass/one-skip suite remain the evidence stated above. The separate callback
fixture failure is being diagnosed by the source owner and is not covered by
that correction.

## Canonical dae808fe composition — 2026-10-12

Canonical prerequisite `dae808fe02694d13d322c535944910813b21f6d6` is published
against master `e168512f7bdbb6af6ea01954c6d7ed80b91e903e`. Additive composition
uses protocol `f34a1c81a93e755ed867ab71c2d016ed612baa07`, behavior
`81ce173e57` and platform `bfba2c6a5453a88c624077cec57000cfb3152d90` before
this evidence update. The durable-resume and callback tests have no remaining
diff against the canonical parent. Common production transport differences stay
limited to Claude effort. Two Storybook combined fingerprints were reconciled
after inspecting the activity/recovery map changes; classification, declared
sources and story IDs are retained.

Current runner, surface, server and UI noemit pass. Maps, tokens, nine catalog
controls, four profile/protocol/capability generation checks and 25 clean-install
consumer controls pass. The fake-transport live-session suite passes 72 with one
existing skip. Receipts use `/private/tmp/claude-dae-*.log`; native transport
execution and required full checks remain cloud gates. The older Codex dependency
still makes the protocol review contain 703 files, so the three PR code heads
remain unchanged until that dependency is reconciled. Local behavior/platform
review slices remain 88/42 files.

The source owner's provider-free campaign
[38338806076](https://github.com/paperclipai/paperclip/actions/runs/38338806076)
passed four native producers and all clean consumers, including Intel Mac, on
literal source 16a53254. That result is not relabeled as the Claude v7/Pi25
composition. A separate immutable qualification ref will carry this composition
through the existing release-smoke producer/consumer workflow in the cloud, with
zero provider prompts and no package publication or deployment. This preserves
the existing PR boundaries while current package evidence is collected. Any
later source changes require an explicit evidence applicability check.

## Frozen cloud campaign and remaining onboarding gap — 2026-10-12

Frozen qualification source is `ad5875fa4b78804e77911703f7ab2aacb9b32067`
on `codex/claude-runner-qualification-ad5875`. Its
[four-target package campaign](https://github.com/paperclipai/paperclip/actions/runs/38342761144)
has passed all native producers; package assembly and clean consumers remain
pending at this checkpoint. Independent no-follow reads verified all downloaded
daemon hashes, source bindings and executable architectures without executing
them locally. Receipt: `/private/tmp/claude-ad5875-daemon-identities.json`.

| Target | Verified daemon SHA-256 |
| --- | --- |
| Apple Silicon | `bd55bd6f1868415fb6d0e3d402f469c310a35f34b96ca830216212e95fc77dd3` |
| Intel Mac | `37fe6575758600312ce13870d5471d464e6421ad9103db81f03b3451d0eabed6` |
| Linux ARM64 | `2b8f13c311cc33de809ba97718fd6f79e9f184658a2fe316dfc6c1f3251fdddc` |
| Linux x64 | `e55a45705095558110592fa38a7bf6e5ae52da5199c6051298e6db3c27ca3a78` |

The [Linux x64 image build](https://github.com/paperclipai/paperclip/actions/runs/38342885632)
passed on the same source. Its recorded immutable image is
`ghcr.io/paperclipai/paperclip-daytona-runner@sha256:d42fc84fda9af4cf37c52ba850b6d928c475e8ec72d3c9df0332120f247ea62d`.
Source/digest receipts are in `/private/tmp/claude-ad5875-image-evidence`; build
dispatch and fixed workflow identities are retained in
`/private/tmp/claude-ad5875-qualification-dispatch.json`. Neither campaign uses
provider prompts. No local Docker or Rust build ran.

Shared parent correction `021df20762d96bc58d90a1dfa0fdb884393b1d5d` is
composed through all three review branches. The platform tree differs from
the frozen source only in the shared transport test and source-owner dated
record; runtime/UI/package/workflow inputs are unchanged. Runner noemit passes
for that composition. The ongoing package result retains literal source ad5875fa.

The source owner separately found that fresh managed onboarding does not probe
its saved environment before Auto resolution; an immutable but unprobed new
company therefore stays on Legacy. Existing managed E2E fixtures preprobe that
environment and do not establish the ordinary first-use path. Claude's local
Mac proof and prior qualified selected-environment proofs retain their stated
scope. The source owner is repairing the shared/Codex setup flow and cloud seed
defaults. Claude must be checked against that repair before claiming fresh
managed onboarding or final additional-platform defaults. This gap is not
closed by the current package/image builds.

## Installed-runtime checkpoint and lookup repair — 2026-10-13

Campaign 38342761144 completed with all four native producers and the Apple
Silicon, Intel Mac and Linux ARM64 clean consumers passing. Its Linux x64 public
installation failed at a stale verifier assertion, `25 !== 24`, before the Pi
admission probe. The 18 assembled archives were retained; independent no-follow
hash checks pass for all 18. The raw manifest's `publicInstallationVerified`
remains false. Protocol commit `35b811e09c` updates only the strict current Pi
version assertion to 25; the pinned command digest and other guards are unchanged.
This needs a corrected cloud clean-install run, not a relabeled prior pass.

The same archives were installed in a fresh private Apple Silicon consumer.
Normal daemon resolution verifies source ad5875fa and daemon hash bd55bd6f;
sidecar SHA-256 is
`0ef83c19d993e8a4b3cf43c5418aa7b8f7b4ec82afa325d8c53781d145e9e2a0`.
After all six QA companies were confirmed idle, the old preview was stopped
gracefully and its 120 MB data copied to
`/private/tmp/claude-qa-before-ad5875-snapshot`. PostgreSQL's standard
`hydrate-symlinks.js` hook restored links omitted by the lifecycle-disabled
installation; no compilation or signature bypass was used. The preview at
port 3105 now runs the supplied ad5875fa packages without controller overlays.
Health, persisted native Claude/Opus 5.5, `enableNativeRunner=false`, disabled
heartbeat scheduling and zero live runs are verified. Receipts:
`/private/tmp/claude-ad5875-local-installed-identity.json` and
`/private/tmp/claude-ad5875-preview-health-receipt.json`.

The actual creation UI selected Claude Code and displayed Paperclip Runner as
the default with the existing saved API-key account. Setup then failed before
authentication with `acpx_runtime_unavailable`: the default installed verifier
did not carry its owning server's package authority. The SDK and qualified
platform dependency are present. The earlier clean-consumer probe injected
that authority explicitly, so it did not prove ordinary discovery.

Protocol repair `52486d6b8d` derives authority only from the canonical installed
server verifier layout. It checks bounded regular owner metadata, package name,
directory/file containment and no symlinks; existing package declarations,
qualified version/digest/architecture checks, external overrides and source-mode
resolution remain intact. Six filesystem controls, 15 selected installation
controls, runner noemit and profile generation pass. In a separate APFS-cloned
server treatment, the original installed probe fails with the recorded error;
the repaired normal probe verifies the real pinned SDK and closes its snapshot
lease without credentials, authority environment variables or model prompts.
The live preview was not modified by this comparison. Receipt:
`/private/tmp/claude-installed-authority-real-noprompt.json`.

Platform commit `50659ac0e9` removes injected authority from the consumer probe
and rejects authority overrides before invoking it. All 26 consumer controls
pass. The runtime and strengthened consumer are composed locally, but require
new packaged-runtime verification and API task/revision acceptance before a
final claim. No new paid setup or task turn succeeded or was retried during
this checkpoint; the UI failure returned before the supplementary CLI probe.
Known estimates and all unknown-charge holds remain unchanged.

Canonical parent `271d434c170e74bdedde65d0b13059a55419c943` is composed
without separate leaf diffs for the durable-resume, authorization and credential
quorum test repairs. The source owner reports a private explicit-Connect setup
repair and an unresolved named Cloud snapshot binding. Those changes are not
integrated or qualified here yet. The source-owned Codex dependency still needs
to advance before these PR code updates meet the review file limit. GitHub CLI
authentication expired during the source campaign; attended reauthentication is
owned there. No alternative credentials or conflicting auth changes are used.

The incomplete checkpoint is attached to the existing isolated acceptance task
as work product `38b9e957-df5c-416f-b370-d51405a755ed`, attachment
`194e1903-5bd3-45b3-af94-af6821a6bf13`. Its independent download matches
6,911 bytes and SHA-256
`398c24270b7bd1f2e00883ddf9a5132ad642cb38c7647d830c04ad2541845a81`.
[Download checkpoint](http://127.0.0.1:3105/api/attachments/194e1903-5bd3-45b3-af94-af6821a6bf13/content?download=1).
Upload receipt: `/private/tmp/claude-checkpoint-20261013-upload.json`.


## Claude managed Connect qualification — 2026-10-13

The root private patch 665a4bda8dd09ef82911e8b384004c29cbe72da9d534781c548a1bc223f159ef
is Codex-only. Claude now has a separate narrow counterpart in the shipped
onboarding wizard and agent setup. New Claude Code with Auto and an explicit
immutable sandbox image uses fresh company/environment discovery; an unqualified
eligible environment is probed once through the existing permission-gated API
at Connect. Discovery is refreshed afterward, and the measured runner controls
both the environment test and saved configuration. Native forms omit the Legacy
turn-limit default; a measured Legacy result retains it. No runner override is
submitted for Auto.

Existing API-key storage and managed connection bindings remain in use. A new
API key is saved once before qualification; subsequent test/hire payloads carry
the managed binding rather than the raw key. Local execution, saved agents,
explicit runner choices, other harnesses, disabled/overridden adapters, mutable
images and named snapshots do not acquire this additional qualification path.
Named Cloud snapshot identity remains a separate unresolved acceptance boundary.

The helper validates the existing probe's recorded qualification and lease ID.
Permission, connection, cleanup or missing-identity failures stop setup without
an automatic retry. Generation and selection checks discard held results after
company/environment/configuration changes. The wizard caches measured discovery
after its operation so its own new default does not invalidate the setup; agent
creation recognizes that same measured transition while retaining stale guards.

Four mounted positive cases fail against the prior components and pass after
the change. Final focused verification passes all 197 tests: 109 wizard,
69 creation and 19 helper controls. The new cases include native and Legacy
measurements, API-key storage, denied probe access and held-result races.
UI noemit, token gates, map contracts, all nine catalog controls and the catalog
checker pass (224 files, 2,223 stable story IDs). The six affected catalog entries
were source-reviewed; no new rendering, play or live managed acceptance is
claimed. Logs: /private/tmp/claude-managed-cache-full-controls.log,
/private/tmp/claude-managed-cache-types.log,
/private/tmp/claude-managed-cache-catalog-controls.log and
/private/tmp/claude-managed-cache-token.log. The before comparison is retained
in /private/tmp/claude-managed-setup-before-controls.log.

No provider prompts, paid setup retries or local Docker/Rust builds were used.
The live preview remains the unmodified ad5875fa installed package; the runtime
lookup repair and this UI change still need a new cloud-qualified package and
real API task/revision acceptance. Full repository checks and PR review must run
on the reconciled delivery heads before a PR-ready claim.


The managed setup checkpoint is attached to the same isolated acceptance task
as work product `894e1e67-ba80-40e0-80b3-e5e0723788dc`, attachment
`df4dde66-0c0a-4553-a3a2-170ded6663e9`. Independent download verifies
8,085 bytes and SHA-256
`01783ff0aca0f4514df75aead60c511553cb8c407339dd047282a1e9248a4c85`.
[Download managed setup checkpoint](http://127.0.0.1:3105/api/attachments/df4dde66-0c0a-4553-a3a2-170ded6663e9/content?download=1).
It records behavior commit `6ea47e5480ca17e8e634c203964e99d5614db1dc`
and the platform composition at attachment time; it does not claim a final
packaged runtime or completed live managed acceptance. Receipt:
`/private/tmp/claude-managed-checkpoint-20261013-upload.json`.


## JavaScript-only local treatment and startup collision — 2026-10-13

Built only the UI JavaScript from behavior 9b068c0120 and copied the two verified
lookup repair files into a separate APFS-cloned ad5875fa consumer. The original
consumer is retained. The supplied daemon and sidecar are unchanged; the normal
Claude SDK probe passes without credentials or explicit package authority. No
Docker or Rust build ran locally. Treatment identity is recorded in
/private/tmp/claude-installed-9b068c-js-treatment-identity.json. After all six QA
companies were confirmed idle, the owned preview was stopped gracefully, its
complete data backed up to /private/tmp/claude-qa-before-js-treatment-snapshot,
and the private treatment started at 3105 with scheduling and ambient Claude
credentials disabled. This is explicitly a treatment, not a final package.

The real creation UI displays Paperclip Runner (default) for Claude Code. Both
native readiness and the existing supplementary credential check pass with the
saved personal Anthropic API key. Three bounded setup walkthroughs were used:
the first browser harness waited on the wrong Configure label; the corrected
walkthrough reached Configure; the final walkthrough saved the agent but watched
/agents rather than the product's /agent-hires response. No duplicate agent was
created. Reload independently verifies agent dd26921e-fe79-4ef7-a83c-5755bebd8936
as paperclip_runner/acpx/claude/claude-opus-5-5 with the existing managed API-key
binding. The runner control was inspected without changing its default.

The first manual file task CLAAAAAAA-2 (6689bb7c-785e-4884-842f-13f6f5fddefa)
failed in session.open, run 04da7f23-3cff-4efb-87f5-7a757500bfc3, with
provider_lifetime_owned. No artifact or successful task execution is claimed.
The exact provider record identifies Claude SDK 0.3.286. Its deterministic
three-port lifetime fence is 56223/54772/53321. Read-only ownership inspection
finds unrelated node processes already listening on the first two ports: PID
13796 belongs to a separate runtime-service test directory; PID 42452's cwd is
not yet confirmed. The two-of-three guard refused admission. No guard was
weakened and neither foreign process was stopped. The failed run is preserved
and no retry was submitted. The post-failure budget read is pending, so no
accounting completeness or zero-charge claim is made. Existing company cap $4
and new agent cap $2 remain inside the aggregate $50 company ceiling; retain
$1 run reservation and a conservative $1 reserve for unknown setup charges.

Local checkpoint: /private/tmp/claude-local-startup-checkpoint-20261013.json.
Further paid work waits on the recorded accounting state and a safe startup
path; final cloud package and PR qualification also remain outstanding.


## Actual prerequisite merge reconciliation — 2026-10-13

The source owner confirmed prerequisite #16028 merged as actual master commit
`d67e3507b23041212fa26302ce6de078c5ebcc05`. That object is present locally.
Protocol composition `abcd8261d2` merges this actual commit; behavior composition
`3f442729a4f1253771e5693724142efb58f9c006` carries it forward. Five conflict
files retained only the reviewed newer Codex checkpoint history, Linux libc
compatibility prose, source/access-map scopes and native-platform test import;
master additions outside those hunks remain intact. Obsolete instructions to
start the already existing Codex slice were not restored. No source-owned branch
or new npm/staging qualification environment was changed.

Focused reconciliation checks pass: 213 root controls (197 Claude setup and 16
development native-binary controls), six package-local installed-authority
controls, UI noemit, generated ACPX profiles, map contracts, token gates and nine
catalog controls. The initial root invocation does not include runner package
tests; the six authority controls were separately run from that package's cwd.
The inherited Storybook delta has nine changed declared inputs across 61
entries; source review retains classifications and all 2,223 IDs. Rendering,
play, final broad checks and live task/follow-up proof remain pending. Logs are
/private/tmp/claude-d67-reconcile-focused.log,
/private/tmp/claude-d67-authority-controls.log,
/private/tmp/claude-d67-reconcile-ui-types.log and
/private/tmp/claude-d67-catalog-after.log.

The source owner's separate private Codex rehearsal is frozen at
`a758b226d898ef457f524427c19a9919ec3b5276`; its receipt independently matches
SHA-256 `568f927baed3e0864a31a6a4dbb44ab0ec0f7ccab2b93f7848c24387eb1e1c3a`.
It remains private and unqualified for live execution; it was not merged here.
The source-owned published Codex branch still needs final reconciliation before
our protocol publication can satisfy its review-size boundary. These source
checks do not relabel the live treatment preview as new compiled master.

The human authorized the source owner a separate $25 npm-canary/fresh-staging
qualification lane, with $15 stack/sandbox, $5 setup/four Codex turns and $5
cleanup reservations. It does not fund Claude and does not redistribute the old
$250 ledger or our $50 ceiling. No such environment or budget was allocated here.
Claude's budget-check/manual-retry question remains pending. The read-only budget
check failed to execute after approval-review timeout and then model-capacity
failure. No approval bypass, foreign listener cleanup, hold clearing, paid retry,
local Docker/Rust build or production promotion was performed.


The reconciliation report is attached to the existing completed QA task as
work product `ebb8457c-6a9c-40ee-bfaf-690538702feb`, attachment
`a42cc0c7-f253-4242-98ca-2d671e5cd5a9`. Independent download verifies
4,612 bytes and SHA-256
`84322cef2fd1b3eb7074b7f946dce9b0466302fed8b0160ea7ef2fc527e9515b`.
[Download merged-master checkpoint](http://127.0.0.1:3105/api/attachments/a42cc0c7-f253-4242-98ca-2d671e5cd5a9/content?download=1).
Receipt: /private/tmp/claude-d67-reconciliation-checkpoint-upload.json.

At attachment time the earlier preview process had expired and 3105 was free.
Restored the same recorded JavaScript treatment without rebuilding or changing
its runtime. Health at 2026-10-13T11:44:32.104Z confirms all six QA companies
have zero live runs, the experimental flag is false and the original completed
x64 task persists. Its agent is paused; no resume or budget read was performed.
The served controller is ad5875fa with the recorded 52486d6b lookup repair and
9b068c UI, not a newly compiled d67 package. Health receipt:
/private/tmp/claude-d67-source-treatment-preview-health.json.
Full workspace typecheck/tests/build and final packaged acceptance remain
unrun on the reconciled head; they belong to the still pending cloud/full-check
handoff after dependency and local acceptance gates are satisfied.


## Published prerequisite evidence remains separate — 2026-10-13

The source owner reports public canary `2026.1013.0-canary.6` on
`60bc0d5fee9a6e48db08fc016521fee3d9f57d67`, following merged prerequisite
d67e3507. The 60bc object is available locally and its own commit changes only
the release workflow and its verification tests (#16149). This checkpoint does
not merge that later master into the Claude branches or run a new workflow.
The source owner reports four native producers, publication and real onboarding
smoke passing, plus clean Apple Silicon installation and two native Codex task
runs through the supported API. Its fresh staging pair remains separately bound
to literal d67/cloud38392212140-1 and reuses its provider session.

Those are prerequisite/Codex measurements, not qualification of our untested
Claude package. The source owner's published saved-account Connect UI still
uses a Legacy CLI probe that fails on its clean local PATH; its private Codex
#15683 fix remains separate. Its released gpt-5.6-luna costs are unpriced, and
an additional positive-budget control correctly fails closed. Restoring its
budget to default zero changed the configuration revision/session; local same
provider-session reuse is therefore not claimed. Four authorized Codex turns
were used, its QA agents are paused, and physical sandbox teardown/invoices
remain unconfirmed. None of its $25 allowance funds this Claude lane.

Our public heads remain c60bf4b/4440df2/173a73e, with newer reconciled fixes
committed locally. Claude budget-check/retry approval is still pending; no new
paid check, retry, hold release, foreign process cleanup or borrowed environment
was performed. Current-source broad checks, final packages, local useful-task
and revision proof and fresh PR review remain gates. The old source merge timer
was canceled by its human; this chat has no authority to recreate it or promote
production defaults.


## Actual Codex merge composition — 2026-10-14

Codex #15683 merged as `adb69e8f09852c772d9901ae270e5b2d66e39c77`.
Fetched that exact object using the existing repository authentication. The
original /Users/dotta/.codex/worktrees/670b/paperclip checkout no longer exists,
but its committed behavior branch is intact at f4b24bf695. App-managed recovery
reported Not a git repository, so the same branch was recovered into the isolated
/private/tmp/claude-runner-default-recovery worktree. No source-owner branch,
preview or allowance was changed.

Protocol composition `9ac6e674fa` retains the actual merged Codex implementation,
including shared bounded suspension reads and ingress shutdown. Its shared server
executor is byte-identical to adb69; transport differences are Claude effort
fields/admission only. The v7 input reader retains v1–v6, including Dot and Grok
Bot bindings. The merged Grok Bot gates remain intact in Claude behavior.
Copilot profile 18 already belongs to merged Grok schema evidence, so the combined
Claude source extension uses pending profile 19, preserving that immutable v18
and the earlier private Claude v18 under a separate fixture name. Pi25 retains
its previous digest; no provider qualification boundary is promoted.

Protocol checks pass 326 controls with one existing distribution-root fixture skip,
plus runner noemit, schema/profile/manifest generation and map contracts. These
are JavaScript/fake-provider checks, not new native package or live proof.
Cached dependencies were restored into isolated copies after the old absolute
workspace links became dangling. A frozen install stopped on the inherited
manifest/lock mismatch; a separate pnpm version query refused an unverifiable
registry fetch. No signature guard or patch policy was bypassed. The existing
installed dependency lock identity is retained in
/private/tmp/claude-adb69-dependency-recovery/receipt.json. Newly merged Speko and
OpenTelemetry packages were installed at their manifest-pinned versions into a
private prefix with npm lifecycle scripts disabled. Canonical shared/plugin SDK,
eval-kernel and runner JavaScript outputs were prepared without Docker or Rust.
Fresh full dependency/source checks still belong to current-head hosted CI.

The defaults composition retains Codex onboarding draft recovery and its
explicit-Connect probe handling. A combined test exposed an inherited reset that
started another setup probe when measured discovery changed; restoring merged
navigation ownership fixes all 39 targeted managed Code/Claude controls. A
separate stale Claude target control now requires an explicit Connect action
before a second test: obsolete results cannot hire, and environment updates do
not automatically spend another setup turn. Native/Legacy configuration and
saved-account assertions remain intact.

The actual merged Storybook uses source annotations and generated indexes, so
its deleted old maps/storybook-map files are not revived. The canonical Codex
story location and stable identity are retained. The current catalog generator
passes 283 files/2,727 stories; map contracts pass 35 areas/176 capabilities.
UI/server typechecks and token gates pass. Final focused settings/creation checks
cover 577 controls across their recorded runs, and all 31 native input-builder
controls pass. Logs use /private/tmp/claude-adb69-* prefixes. No new rendering,
paid model turn, budget read/resume, hold release or local native build ran.
The local preview remains its separately recorded older treatment; this source
composition is not a claim of current installed/runtime or task/revision proof.


### Hosted clean-install correction — 2026-10-14

The first reconciled hosted Build jobs (38605177149 and 38605182039)
failed in the credential-free Pi public-install probe: the generated profile25
digest was dd673874…, while the probe retained d25d674c…. Protocol correction
519e8369a1 aligns that exact assertion with the immutable profile; all24 existing
public-install sandbox controls and profile generation checks pass locally.
The daemon, profile, admission checks and paid-provider behavior are unchanged.
The full clean consumer will rerun in hosted CI; no local Docker build ran.

The earlier port3105 preview has been replaced by another test-drive
(source a6d81b67cb, separate github-review data directory). The report uploader
stopped on its404 target check before creating an attachment or work product.
That foreign instance is left untouched. Claude preview recovery must select
a separate port and the existing Claude data directory; the historical3105
link is no longer a usable Claude preview.


### Fresh review and cancellation correction — 2026-10-14

Fresh reviews passed behavior 7069077274 and platforms 6b0cb979d4 at 5/5.
Protocol 519e8369a1 received two valid findings: stale profile 23 catalog
expectations and an owned Claude settings write that blocked startup abort.
Correction dd82936c1d updates the Pi 25 expectations/fingerprint and uses the
existing abort-aware admission helper, transferring the unfinished write and
lifetime lease to retained cleanup. Both successful and failing late writes
return cancellation promptly while rejecting a competing provider. All 55
runtime-host tests, 72 Pi evidence controls, runner noemit and profile/manifest
checks pass. These are fake-provider controls, not paid execution evidence.

Hosted jobs 38606914671 and 38606913944 received simultaneous runner shutdown
signals at 17:35:06 UTC. One failed-job prerequisite rerun was requested before
the new review findings. Credential-free package campaign 38607132186 was
canceled once the runtime fix invalidated its source 6b0cb979d4. Completed
producer outputs remain historical; no new package qualification is claimed.
A replacement package campaign waits for fresh review of the corrected runtime.

The existing Product E2E browser helper exercised UI source 7069077274 against
the retained older backend at 3115 through New Agent, Claude Code and Advanced.
The runner shows Paperclip Runner (default); keyboard Legacy/native selection
passes. Stable light/dark screenshots at 1440 and 390 px show no horizontal page
overflow. The inherited Custom Gateway subtitle clips on 390 px; Claude API-key
controls remain visible. Every API mutation was blocked by the browser guard;
one local connection-attempt request was intercepted, no agent was created and
no setup probe or provider turn was submitted. This establishes UI rendering
and controls only, not saved-default persistence or final runtime execution.
UI receipt: /private/tmp/claude-current-ui-review-20261014.json.
Retained Claude preview: http://127.0.0.1:3115 (historical runtime treatment).
The prior reconciliation report was uploaded to its original completed QA task
and independently byte-checked: attachment aabe2e7e-a8a0-4408-bc7e-a013e0f7485b,
5916 bytes, SHA256 3bd9bcfa64db6a3a7968952122b1a5c2ae27e24f0e4ff336fd47ae374bae8ff1.
Paid acceptance and budget/hold changes remain stopped pending human approval.


### Frozen runtime and comment-only review cleanup — 2026-10-14

Protocol dd82936c1d has current 5/5 review and green CI 38609018629.
Platform 2646b94533 has current 5/5 review and green CI 38609191818.
Behavior 05a98b6cbf received one style finding for added code comments.
Removing its seven specified comment lines across three files produces identical
comment-free esbuild output for each file; the SHA256 comparison is retained in
/private/tmp/claude-comment-cleanup-equivalence-20261014.json. No executable
behavior changes, so package campaign 38610086180 and qualification-image
campaign 38610152781 retain their literal 2646b94533 runtime source identity.
They do not become proof of a later source revision by relabeling.

The full Product E2E support checks pass 2733 Vitest and 128 node:test controls.
The behavior static lane observed a transient atomic .tmp record in an unchanged
build-stamp concurrency fixture; its exact local control passes. The original
failed attempt and one requested failed-job rerun remain recorded.
A read-only QA budget audit now succeeds on 3115: six confirmed policies have
zero live runs; four remain paused with pending accounting, and an older policy
is unavailable. Historical reservations remain conservative. No hold, limit or
paid run was changed. The two previously colliding foreign port listeners remain
present and untouched; retrying that exact old session is not execution proof.

### Installed API-key acceptance — 2026-10-14

The full frozen package campaign [38610086180](https://github.com/paperclipai/paperclip/actions/runs/38610086180)
passed all four native producers and clean consumers, including default installed
Claude authority on Apple Silicon, Intel Mac and Linux ARM64. Linux x64 passed
its existing clean public-install controls; that lane does not separately run
the Claude authority probe. Runtime source remains
`2646b94533bac1eae0d30b11d3774b104eeaf981`. Behavior `06258a283c` and platforms
`bddff3c5e9` have green CI and 5/5 reviews, with executable comment equivalence
recorded above. Subsequent evidence or packaging-tooling edits do not relabel
these runtime bytes.

The retained preview now runs that installed package at http://127.0.0.1:3115,
with no JavaScript overlays, daemon overrides, development provider pack or
ambient provider credentials. Native Runner experiment and timer heartbeats
are disabled. The compiled server identity is 2646b94533; the health page's Git
context reports checkout 06258a283c. Both identities are recorded. The old data
has a private cold backup. Normal embedded-Postgres symlink hydration and a
QA-local dangling Claude CLI link were repaired; the system CLI was unchanged.

Ordinary browser onboarding selected Claude Code and its saved personal API-key
connection, left runner/model defaults intact, and saved native Claude/Opus 5.5.
One useful task and its revision succeeded after a controlled controller restart.
Independent downloads matched 160 and 214 byte oracles, and the original remained
available after reload. Task, provider and backend sessions were identical across
turns; High effort was requested and acknowledged in both. API usage settled at
$0.183214600 and $0.287600400 estimated rate-card cost, not invoice charges.
Report: `/private/tmp/claude-2646-mac-api-acceptance.json`.
Preview: http://127.0.0.1:3115/CLAAAAAA/issues/CLAAAAAA-2.

Linux ARM64 also passed a fresh API-key task/revision on the installed SSH host,
using ordinary API creation with neither runner nor model overrides. The current
pack was discovered at its standard host location, not an explicit development
path; its source/digest and staged ARM daemon matched the frozen release.
Independent files matched 156 and 203 bytes, all three sessions persisted, and
High effort was acknowledged before both turns. Settled estimates are
$0.209004800 and $0.128238000. The old SSH port had reached an interactive
Tailscale login; the isolated fixture uses the authorized key on port 22222.
Report: `/private/tmp/claude-2646-arm-api-acceptance.json`.
Preview: http://127.0.0.1:3115/CLAAAAAA/issues/CLAAAAAA-3.

These four turns used the existing healthy $2 company cap, serialized with timer
heartbeats disabled. After both Mac turns settled below 30 cents each, its
per-turn reservation changed from $1 to $0.50 while the $2 hard cap and unknown-
usage blocking remained intact. Historical failed records/holds and the separate
setup reservation remain preserved. No automatic paid retries were enabled.
The next x64 attempt was rejected before provider startup because its independently
rebuilt image pack differed from the npm release authority; its failed record
and pending accounting hold are retained. Cloud image alignment is the next gate.
Subscription follow-up remains unverified; remaining live acceptance uses API
keys per human steering. No local Docker or Rust build ran. Merge and production
deployment remain separate.

### Release image artifact consumer — 2026-10-14

The first current-image x64 run failed before Claude startup. The independently
built image used a separately resolved lock and omitted the producer pack's Pi
assets, so it could not equal the pack manifest shipped in npm. The runtime
rejected it; its pending accounting hold stays preserved.

The manual cloud image workflow now optionally consumes one successful exact-
source Release Smoke artifact set. It validates repository/workflow/source,
artifact archive digests, canonical paths, package authority, daemon architecture
and daemon bytes before constructing the image. The release pack must equal the
manifest inside the public server tarball. This mode copies the producer's pack
and daemon over an immutable Paperclip base image without rebuilding either or
resolving dependencies. The resulting image is read back to compare pack and
daemon identities. Existing source-build mode remains available. Fifteen focused
negative/positive controls and 71 existing release workflow controls pass; full
current-head checks and fresh review run in hosted CI. The repaired image and
x64 task/revision are still pending. No local Docker or Rust build ran.

### Review checkpoint and GitHub access gate — 2026-10-14

The Mac/ARM reports and completed-task screenshots are attached to their original
completed preview tasks, registered as artifacts, and independently downloaded
again with identical bytes. Mac report attachment:
`fb6e5d1b-09a6-4c0b-980a-cde24e4c25bb`; ARM report:
`15804e48-3338-4e8c-8f5f-0dbe36204e8a`.
Upload receipt: `/private/tmp/claude-2646-acceptance-upload-receipt.json`.
ARM's actual SDK executable SHA256 is
`0292fa22ac2fd43e16be9d0e511ddd8347280d6e0ebaca744ef5b27e05d8d0f8`;
its daemon is `4720c6a23784d3b4535329ecf852d38af8c14ae920447a662a00c4657711387a`
and its automatically discovered pack is
`sha256:fe4b772a2568fc9d9febac5ef37f4cb402a2f2b2448f85983afb2c54a7c367fa`.

The four current successful turns add $0.808057800 of settled rate-card estimates.
Read-only reconciliation gives $3.054638600 known estimated ledger usage, excluding
unknown charges; the separate $1 setup reservation remains. Aggregate company
caps remain $50. All old holds and the new pre-start x64 pending hold remain
intact. The current company's agents are paused by its budget hold, timers are
disabled, and there are zero live runs. The owned x64 leases report cleanup
success. The unused 3116 Vite process was stopped; installed preview 3115 remains
available for reviewing/downloading the finished tasks.
Accounting: `/private/tmp/claude-qualification-accounting-20261014.json`.

The cloud image consumer fix is committed locally (38cd5c95e5, d8e4c98cd5 and
502f404794), with 15 focused controls, 71 release controls and YAML syntax checked.
It preserves the non-root Daytona user and binds image labels to the consumed
runtime source. GitHub rejected its push because the OAuth credential lacks
workflow scope. Both existing SSH signing attempts failed through the configured
1Password agent. The attempted dispatch rejected the unknown inputs on the old
published workflow; no corrected image build or model retry started.

Human intervention requested: approve GitHub SSH access or refresh the GitHub CLI
with workflow scope. Once available, push the platform branch, dispatch the exact
artifact consumer against producer 38610086180/runtime 2646b94533 and immutable
base b774f547…, verify the resulting image, then run the x64 API pair. Keep the
failed current company held. An existing $1 company allowance has zero pending or
unpriced usage and $0.804805400 remaining; its old agent stays paused. A fresh
x64 fixture there can retain the original aggregate $50 cap without releasing any
hold. Do not create a new allocation or silently retry the held task.

Protocol #15994 remains at dd82936c1d. Behavior #15993 now publishes the evidence-
only 4ee0d1d444; its current-head hosted CI/review is running. Platform #15997's
published head remains bddff3c5e9, with prior green CI and 5/5 review; the prepared
image consumer is not published or reviewed yet. PR bodies distinguish these
states. All remain draft. No merge or production deployment occurred.

Behavior head 4ee0d1d444 subsequently completed all 54 checks successfully, with
fresh Greptile 5/5 and zero unresolved review threads. Exact hosted source CI:
[38622133620](https://github.com/paperclipai/paperclip/actions/runs/38622133620);
Docker context/native compilation control:
[38622133915](https://github.com/paperclipai/paperclip/actions/runs/38622133915).
The behavior PR checklist now reflects those completed gates. This does not
qualify or publish the still-local platform image consumer.


### Hosted named-snapshot repair — 2026-10-15

The failed UI journey is retained unchanged. The correction extends explicit
Claude Connect qualification to Daytona snapshots: the plugin resolves a stable
provider ID and creates by that ID, the server measures the actual sandbox and
records v2 company/config/account/template-bound proof after owned cleanup, and
native acquisition pins that same ID. Existing image v1 readers remain intact;
ordinary Legacy acquisition and Codex setup eligibility are unchanged. Discovery
performs no new provider calls. Lookup timeout cannot continue into allocation.

A no-prompt live check with the pinned Daytona SDK 0.203.0 created an owned sandbox
from the managed snapshot ID, measured Linux x86_64 / glibc 2.41, and deleted it.
Receipt: `/private/tmp/claude-test-deployment-20261015/snapshot-id-live-probe.json`.
This is provider identity/architecture evidence, not native Claude task proof.
The new candidate still needs cloud checks, deployment, and a fresh ordinary UI
journey through creation, useful task, revision and downloaded artifacts.


### Warm snapshot review correction — 2026-10-15

Review reproduced a valid warm-run gap: run-only `reuseLease: true` changed the
configuration fingerprint before snapshot proof was checked. The orchestrator
now carries the original configured environment into acquisition. The driver
resolves templates and checks proof against that configuration, then applies the
run-only retention setting. It rejects other run/configuration differences.
The regression failed before the fix; 19 focused database/runtime/orchestration
checks pass afterward, including omitted and false saved retention values.

Candidate 7ff0038175 passed its source CI but received Greptile 4/5 for this gap.
Its task-owned preview build 38792291081 was cancelled before deployment. The
previous served 49f99e130a and failed UI report remain unchanged. A replacement
cloud build and fresh hosted acceptance are pending for the corrected source.
The disposable acceptance project has a UI-configured $2 lifetime cap, a $1
per-run reservation, and unpriced usage blocking; all survive reload. This uses
the previously reserved allowance within the $50 ceiling.


### Hosted API-key acceptance passed — 2026-10-15

The corrected candidate `15e37379e94535fd9692a4f0c4d3fadd2595b188` is deployed
to the dedicated test organization. The deployment receipt confirms
`sha-15e37379e94535fd9692a4f0c4d3fadd2595b188-cloud`, status succeeded, and
verification verified. Cloud build:
[38793774125](https://github.com/paperclipai/paperclip/actions/runs/38793774125).
Deployment campaign: `fleet-campaign-1791979001533`. This is a Core-only preview;
private Cloud UI plugins are excluded. All image builds ran in cloud infrastructure.

A fresh strict browser journey started at `https://test.paperclip.app`, selected
the test organization, created Claude Hosted Writer through New Agent, reused
the saved personal Claude API connection, and submitted default model/runner
settings. The saved Runtime form showed Paperclip Runner (default), Claude
Opus 5.5, effort Auto, and Paperclip Computer. No runner or model override was
submitted. The native experimental flag remained at its disabled app default.
Prior interface familiarity and the preconfigured $2 project are disclosed.

The useful task and same-task follow-up both succeeded:

| Turn | Run | Result | Duration | Displayed API estimate |
| --- | --- | --- | --- | --- |
| Create checklist | `000105db-4244-48f2-8b7e-a2bd207b2311` | succeeded | 3m 07s | $0.2083 |
| Add rollback section | `c68e858f-09f2-4aea-9c21-fbc57a1585a2` | succeeded | 3m 11s | $0.1468 |

Independent checks read browser-downloaded files after the strict journey ended.
The 655-byte v1 has three headings and six checkboxes; the 906-byte v2 preserves
those sections and adds Rollback with two checks. Downloading v1 again after the
revision produced identical bytes. SHA-256 values:

- v1: `0a279d7048f3e1d949aaaac6fdb467ec8d18489e7e7a6818497083e327bd1365`
- v2: `0b78e9f0226613892f47892a29f2e2aba7f28c7cd78707b6800e194603b8e485`

Both rendered run logs identify provider session
`b1b07c68-7557-4a8d-b109-6619e10300ec` and normalized session
`163815a9-25e5-438b-bfc0-a84c6fadd479`. The follow-up records session resume
and durable-session attachment to its new run authority. Workspace finalization
succeeded on both runs. Saved settings, both responses, both attachments, and
Done status persisted across revisit/reload. The QA agent was then paused.
The displayed task estimates total $0.3551; this is additional to the previous
$4.810616600 known estimates. Unknown charges and the setup reservation remain
reserved, and aggregate qualification allowances remain within $50.

The 78-step report includes an actual screenshot for every step. Evidence lives
in `/private/tmp/claude-test-user-20261015-r2/`, including `journey.json`,
`artifact-verification.json`, `session-verification.json`, and the portable HTML.
The report and structured log were uploaded to the completed acceptance task:
report attachment `43b8698f-d264-4d0f-86c3-9d0b8adabd35`; log attachment
`b5313baa-4a1c-408e-886b-400ac876083c`. The original failed journey remains intact.

Functional acceptance passes. Experience needs improvement: Connect shows
“Connection needs attention” despite successful credential/hello checks, and
cold provider-pack uploads took 122.1s and 125.8s while the task mainly said
“Thinking.” The first download-text click had no visible feedback; file-card
preview and its Download control worked. This is desktop dark-theme evidence,
not mobile/accessibility qualification. The report renderer validated all images;
host preview was queued, so HTML gallery interaction was not visually verified.
Subscription execution and private Cloud plugins remain unqualified.

Exact deployed-source required CI passed, including typecheck, tests, build,
Docker context/native compilation, and the aggregate verification gates.
Greptile is 5/5 with zero unresolved threads. The optional supply-chain scan
remains neutral/inconclusive. The evidence-only follow-up does not change runtime
bytes or invalidate these serving-source results. PRs remain
[#15994](https://github.com/paperclipai/paperclip/pull/15994),
[#15993](https://github.com/paperclipai/paperclip/pull/15993), and
[#15997](https://github.com/paperclipai/paperclip/pull/15997).
No merge or production rollout occurred.

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
