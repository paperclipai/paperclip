# DSH native Runner integration

Date: 2026-10-28
Branch: `feat/dsh-runner-support`
Base: `origin/master` at `40c1ab36cdac70c85dc8fe5e912431834fdb691b`

## Release contract

| Decision | Initial scope |
| --- | --- |
| User outcome | Configure DeepSeek Harness (DSH) as a native Paperclip Runner ACP agent, run an ordinary coding task, inspect its normalized activity, stop it, and resume its native session. |
| Native Runner route | Reuse the production ACPX sidecar and Rust `acpx_runtime` backend. Launch the pinned `@deepseek-ai/dsh` CLI with the `acp` profile; do not add a legacy `dsh_local` adapter or a second PRP/provider protocol. |
| Release target | Reviewable implementation on the feature branch. No merge, deployment, migration, or existing-agent conversion is authorized by this task. |
| First environment | Local macOS arm64. Linux, SSH, and Daytona remain unqualified until separately exercised. |
| Runtime | `@deepseek-ai/dsh@0.2.1-rc.5`, ACP v1 over stdio JSON-RPC. The installed CLI and shipped package documentation were inspected on 2026-10-28. |
| Authentication | `DEEPSEEK_API_KEY` from the explicit Paperclip task environment. Ambient developer credentials are not a production admission path. |
| Models | Caller-selected DeepSeek model ID; initial repeatable acceptance model `deepseek-v4-flash`. Translate the Paperclip model ID to DSH's opaque `["deepseek-official","<model>"]` ACP selector and verify the acknowledged selection before prompting. |
| Instructions | Write the composed bounded Paperclip instructions to the isolated `$DSH_HOME/AGENTS.md`; DSH loads that file as its user-global instruction layer. Preserve project-level instructions separately. |
| Isolation | Use a private per-session `DSH_HOME`; map Paperclip read-only policy to `DSH_PERMISSION_MODE=read-only` and ordinary execution to `workspace-write`. Disable DSH session-log contribution and OTel capture in the managed profile. |
| Required behavior | Exact model admission, MCP/tools, assistant/tool events, interactive permission mapping, cancellation, standard `session/resume`, and bounded process cleanup. |
| Deferred behavior | Native plans/modes, native elicitation/questions, assigned-skill materialization, artifact-specific extensions, image input, steering, thread lineage, and production qualification outside the first environment. |
| Accounting | Preserve provider-reported ACP usage where available. No authoritative dollar-cost claim without a provider receipt. |
| Spending | Deterministic and credential-free checks are authorized now. No paid model acceptance run until its exact model, prompt, retry limit, and spend cap are confirmed separately. |
| Installation | Pin the public npm runtime in the Runner dependency closure. Do not depend on the developer's global `dsh` installation at runtime. |
| Proof | Focused TypeScript/Rust admission tests, isolated DSH ACP initialization/model/session probes without a billable prompt, then a real Paperclip task only after paid acceptance is authorized. |
| Ownership | One integration owner serializes shared manifests, generated files, dependency declarations, and provider-pack inputs. |

## Capability inventory

Observed from `@deepseek-ai/dsh-acp@0.2.1-rc.5` documentation and shipped source:

- Supported: `initialize`, `session/new`, `session/list`, `session/resume`, `session/close`, `session/set_config_option` for model and reasoning effort, `session/prompt`, `session/cancel`, standard assistant/thought/tool/usage updates, and `session/request_permission`.
- Supported transports: stdio and Streamable HTTP MCP declarations.
- Not exposed by DSH ACP: `session/load`, modes, native plans, terminal, client filesystem, elicitation, delete/fork, extra directories, and DSH-specific presentation cards.
- DSH loads `$DSH_HOME/AGENTS.md` as user-global instructions and enforces `DSH_PERMISSION_MODE` through its normal sandboxed tools.
- DSH's model selector is an opaque JSON tuple containing provider and model, not the bare model ID used by the Paperclip configuration. Its `set_config_option` rejects IDs absent from the current catalog; the first release must surface that rejection instead of promising arbitrary custom IDs or substituting a fallback.

These statements are source/document observations, not live model qualification. Each required row still needs evidence through native DSH → ACPX → runnerd → controller → UI before a production-ready claim.

## Acceptance ledger

| Cell | Evidence required | Status |
| --- | --- | --- |
| Static registration | DSH is admitted consistently by TypeScript, server, and Rust; unknown providers still fail closed. | Passed: Runner/server/UI typechecks, generated contracts, map and token checks |
| Managed isolation | Unit tests prove global instructions, credential allowlisting, telemetry opt-out, and read-only/workspace-write mapping. | Passed: focused sandbox/environment tests plus 277 server/UI tests and 8 ambient-credential checks |
| Credential-free ACP | The pinned DSH profile initializes and reports its actual capabilities without a model prompt. | Passed on 2026-10-28: ACP v1, close/list/resume capabilities, exit 0, empty stderr |
| Model/session admission | The exact model selector is acknowledged on new and resumed sessions; mismatches fail before prompt. | Passed for `deepseek-v4-flash` across two real DSH processes, no prompt; catalog rejection covered separately |
| Runner regression | Focused ACPX, server admission, and Rust tests pass. | Passed: 491 core tests, 74 installation tests, 55 Rust unit tests, 17 sidecar integration tests, and DSH ACPX package contracts |
| Real task | Independently checked file result, governed semantic completion, durable Done, and physical cleanup. | Not authorized yet |
| Stop/resume | Stop reaches real pending DSH work; a later session resumes with refreshed MCP configuration. | Not authorized yet |
| Delivery | Clean installed package closure and selected-environment launch. | Local pinned-closure production ACPX probe passed; clean npm tarball and remote-provider-pack proof pending |

## Failure record

- The first probe harness sent `session/set_config_option` and `session/close` before it knew the new session ID. DSH correctly returned invalid-params errors. This was a probe sequencing bug; the follow-up sent requests sequentially. No model prompt was sent.
- The next probe tried `probe-exact-model`. DSH returned `unknown model option`, establishing that this build rejects an unlisted ID. The acceptance probe then used the shipped `deepseek-v4-flash` selection and passed. This is a provider/catalog limitation, not evidence that arbitrary models work.
- Initial dependency setup used incompatible pnpm launch paths and native test signatures. Those environment failures were not counted as integration passes. The eventual focused Runner install and tests used the isolated workspace installation; no full-repo build or dev service was started.
- The first production probe exposed three real integration defects: DSH's unbundled dependency closure was incomplete, its CLI was not invoked because `import.meta.main` is false under the verified bootstrap, and its native addon cache escaped the pinned ancestry. The integration now collects the controlled ACP dependency closure, uses a digest-pinned launcher that calls `runCli()`, and sets `NARB_DISABLE_NATIVE_CACHE=1` so the addon loads from the verified snapshot. ACP initialization then passed with empty stderr.
- The first full ACPX close also exceeded the generic 2-second settlement budget while the DSH session and filtered snapshot retired. DSH now has explicit bounded 10-second runtime-close and 60-second driver-cleanup limits. The final production ACPX probe passed model admission and complete cleanup on Node 24.
- Some Node 22 test outcomes were runtime-specific false regressions in module-hook behavior. Final acceptance used the repository-required Node 24; those Node 22 failures are not counted as source defects or as evidence of compatibility.
- Preserve these original red outcomes alongside the later green results. No paid model acceptance has been attempted and no production qualification is claimed.

## Review hardening — 2026-10-29

- Streaming snapshot copy now reads and hashes through the same admitted file handle, writes a new target, and rechecks handle/path metadata. It no longer reopens the source path after validation.
- macOS no longer inherits hundreds of source-directory descriptors. Logical package counts are separate from inherited-FD counts; Linux descriptor behavior is unchanged.
- Optional package admission distinguishes direct resolution failures from nested required failures by dependency depth.
- A proposed cross-launch snapshot cache was removed after review showed directory identity alone could not prove dependency freshness. Every launch now rebuilds its snapshot from current admitted files; no stale-reuse claim remains.
- DSH package traversal and optional-admission policy live in `dsh-installation.ts`. Traversal rejects only the first unique package beyond 2,048, and required dependencies take precedence over optional peers with the same name.
- New-agent setup now maps DSH to the registered `acpx:dsh` brand, shows the `DEEPSEEK_API_KEY` credential field, and queries models through `paperclip_runner` with `acpxAgent=dsh`. Default model configuration is shared across UI and server.
- Snapshot streaming retries short writes until each admitted chunk is complete. Tests cover actual short writes, exact 2,048-package deduplication, and the first unique overflow package.
- Package metadata now has one shared bounded-read implementation with before/after identity checks. DSH dependency resolution uses asynchronous node_modules scanning and realpath/I/O, not synchronous `require.resolve`; real-filesystem and npm-hoisting regressions cover the resolved edges.
- Snapshot package links follow actual resolved dependency edges. Only the launcher and DSH runtime roots carry the shared package set needed by DSH profile inventory, avoiding a roots-by-packages link matrix. A production ACPX probe validated this layout.
- DSH was removed from the global remote-provider-pack digest set so existing Claude/Codex/Grok remote packs remain compatible. Release-pack and remote-manifest tests passed.
- Dependency names are validated before asynchronous path scanning; malicious `../` names fail closed. Shared entry roots preserve first-resolution-wins for duplicate package versions, with a regression covering duplicate names.
- DSH runtime is included in the same 2,048-package deduplicated count without expanding unrelated non-ACP native dependencies. DSH default model fallback is restricted to the ACPX provider, and `entryRoot` is passed explicitly rather than inferred from the numeric limit.
- Full server/runtime/supplemental ancestor merging now has a shared deduplicated limit helper with direct 2,048/2,049 and duplicate-root tests, closing the previous collector-only boundary-test gap.
- Runtime direct dependencies are resolved from the DSH runtime manifest only for targets already admitted by the ACP closure. Their exact peer-context links override shared-entry defaults, with a two-variant fixture verified through actual snapshot links.
- DSH command admission now has a 60-second deadline, external abort propagation, per-file snapshot cancellation, and late-lease cleanup. Controlled tests prove timeout, late close, and partial-snapshot cleanup. Candidate-agent checks are shared across Runner, live usage, and the server shim.
- Streaming snapshot reads now stop on abort, enforce expectedBytes before every chunk write, preserve source-FD identity checks, and have explicit mid-stream abort and file-growth regressions.
- Synchronized `origin/master` through `2badf8a4a`, preserving the upstream Antigravity candidate flow alongside DSH. Shared admission gates now exempt only DSH's existing host-authorized candidate path; Antigravity retains the upstream release gate. Grok's bound profile advanced to v21 with regenerated identity evidence.
- Clean-install review exposed undeclared DSH peer dependencies. Runner now declares the ACP-required Cordis/DSH peers, and server declares its direct DSH peers explicitly; local lockfile changes from installation were reverted as required by repository policy.
- Full DSH installation verification, including dependency discovery and asynchronous resolver traversal, now shares the 60-second admission deadline. Caller cancellation is propagated into dependency resolution, with stalled-resolution timeout and abort regressions. Grok's bound profile advanced to v21 after the runtime-host admission change.
- Review follow-up fixed snapshot filtering to use package-relative paths and allowed the DSH setup-only model catalog through the real route. DSH descriptor assertions now match pending behavior, historical Grok/Pi compatibility includes retained versions, Grok advanced to v18, and Pi advanced to v36 with refreshed source identities.
- CI follow-up also scoped temporary-directory cleanup to the unique mkdtemp result, added the DSH readiness mock export, refreshed the Pi public-install probe to v36, advanced Grok to v22 and Copilot to v96, retained historical Grok/Pi/Copilot version decoding, and made DSH root canonicalization lazy and asynchronous.
- The final affected regression set passed 350 Runner tests, 406 server/UI tests, 77 Rust ACPX tests, and 9 ambient-environment checks. Production ACPX admission passed again on Node 24 with current-source snapshots and complete cleanup.
- `pnpm-lock.yaml` remains intentionally unchanged because this repository assigns lockfile updates to CI. A coordinated lock refresh is still required before frozen/clean-install qualification; this is a delivery gate, not a claim that the current lock already contains DSH.
