# Rich ACP integration and qualification report

Updated: 2026-09-29. Foundation PR #14430 is merged at
`24beb005755465f71a19ec92a85da0958d1b9740`. Basic extended Runner Eval definitions
are merged in `paperclip-evals` PR #29. Provider PRs remain separate review units
and all three providers remain **pending qualification**.

Current candidates are **Cursor v5, Copilot v5 and Pi v8**. None has paid
qualification on the rebuilt combined runtime yet. Cursor v5 binds Agent, Plan
or Ask mode to native acknowledgements, every reconnect, and TypeScript/Rust
recovery identities. Copilot v5 binds the final shared ACPX patch and preserves
native permission/attached-command evidence in both transport paths. Pi v8
retains native assistant message boundaries through the wrapper and both final
answer reducers, and puts retry/compaction notices in bounded activity instead
of assistant text. Previous paid v4/v4/v7 results remain historical evidence.

On integrated source `65b19549e`, 389 focused Runner tests passed (one optional
native installation case skipped), 30 Rust ACPX unit tests passed, 19 selected
server mode/recovery tests passed, and Runner build/server typecheck passed.
The final ACPX patch also passed 22 actual package contracts against the locked
SDK 1.4.0 dependency graph. These are deterministic checks, not paid qualification
or a passing repository-wide gate. The first frozen install exposed a preexisting
legacy ACPX 0.12 patch-hash mismatch; a metadata-only correction passes frozen
lock validation with every dependency version unchanged.

Credential-free tests cover the new policy boundaries, real pinned native
processes, clean runtime builds and Product E2E assertions. On integrated source
`bd4cc29c3`, Cursor v4 has passed local hello, and Copilot v4 has passed all five
basic local journeys: hello, semantic questions, semantic plans, controller
restart and file edit/validation. Pi v7 has passed local hello on `807feaecf` and
Daytona hello on `bd4cc29c3`. Copilot also passed Daytona hello. Pi’s repaired
native-question evidence case passed 15/15; the following continuation case
exposed final-message aggregation of earlier narration.
These passes retain earlier failures and do not qualify native interactions,
all required platforms or the remaining remote journeys.

The [harness priorities report](https://pages.paperclip.ing/2026-09-25-harness-priorities/)
recommends Cursor and Copilot, followed by Pi, using the existing qualified ACPX
path. Codex app-server is the richness benchmark. The legacy Cursor and Pi
adapters are outside this change.

## Current production checkpoint (2026-09-29)

The basic eval definitions and current profile pin follow-up are merged in
`paperclip-evals` PRs [#29](https://github.com/paperclipai/paperclip-evals/pull/29)
and [#30](https://github.com/paperclipai/paperclip-evals/pull/30). The latter passed
134 unit tests, CI and Greptile 5/5 at `4a15550d16ced37c6edbafa91a11783a64e4e649`;
its merge commit is `0ad9c5a4275fbfbed3b32f261d3e603d9761a07c`. The Cursor/Copilot v4 and Pi v7 pin
update, including prelaunch profile admission, merged in
[PR #31](https://github.com/paperclipai/paperclip-evals/pull/31) at
`0b4b3932e95fe1685df5d523edff18c824fd3d54`. It passed 135 deterministic tests,
all three explicit lanes, current-head CI and Apex 5/5. These definitions
are not paid qualification results. Versioned config IDs separate current
candidate scorecards from historical runtime policies.

| Historical paid profile | Latest observed result | Remaining work |
| --- | --- | --- |
| Cursor v4, source `2e0b0fec0`; paid runtime `bd4cc29c3` | All three closures verify; native instructions and bounded todos are implemented. Exact-head Apex reports 5/5. Current-profile local hello passed six matchers with one authenticated run, complete process cleanup and unchanged semaphore count | The question-resume case failed reopening its provider session; the following three cases were not launched. Rebuilt `627451ecf` passed question, plan and controller restart. Its file test validated the correct bytes but failed its exact response marker (5/7 matchers). Native callbacks, restrictive permissions, other platforms and Daytona remain unqualified. The approved account on-demand cap is $25 |
| Copilot v4, source `2042ca14c`; paid runtime `bd4cc29c3` | Native instruction delivery and lifetime ownership have deterministic proof. Exact-head Apex reports 5/5. All five basic local journeys passed; file edit/validation passed seven matchers in one run with complete cleanup | Daytona hello also passed six matchers with complete cleanup. Native permissions, attached background-command settlement, remaining remote workflows and other platforms remain open. The original session startup timeout is retained without a proven root cause |
| Pi v7, sources `807feaecf` and `bd4cc29c3` | Local hello on `807feaecf` and Daytona hello on `bd4cc29c3` passed six matchers each with zero retries and complete owned cleanup. Remote model plus sandbox analytics stabilized at $0.0053185282. Apex reports 5/5 on the reviewed provider head | The `bd4cc29c3` campaign passed hello, then failed packaging native-question evidence despite 15 passing behavioral checks. The harness-only repair subsequently passed all 15 native checks. The next continuation case failed final-message aggregation; five later cells did not launch. Remote/platform evidence remains incomplete |
| All three, Linux/Daytona | The immutable `bd4cc29c3` image and actual server artifact admission pass. Pi hello attempt 02 passed; failed attempt 01 remains retained | The host database resource blocker is repaired. Copilot’s retry passed six matchers and its exact sandbox remained absent for the full 360-second observation. Remaining remote cases are unqualified |

Cursor and Copilot ignore generic ACP `_meta.systemPrompt`; setting `AGENT_HOME`
in the process environment does not make it part of model instructions. The v4
profiles bind provider-specific delivery. Pi already uses its dedicated launch
configuration and owned `before_agent_start` extension. Offline source/SDK
checks use dependency doubles or synthetic model responses. They do not prove
final packaged, authenticated delivery. Cold restoration refreshes trusted context and instructions before reopening.
The shared continuation fix also allows a settled, authenticated new run to
refresh registered instruction/skill roots and its MCP binding. It preserves
profile, model, session, aggregate/context digests and all unknown policy fields;
same-run mutations and active-turn attachment remain rejected.

The repository-wide test attempt recorded 14,057 passed tests, eight failed
tests and two failed setup hooks in the first general-server group. All affected
cases and setup groups passed isolated retries. One retry selected no tests
because Vitest shortened a parameterized name; the corrected selector ran and
passed the case. A confirmed short-prefix collision in the chat test fixture is
repaired with bounded, constraint-specific allocation and three actual-database
regressions. The broad failed attempt remains retained; it is not converted into
a passing full run. On combined source `97217c531`, token gates, repository-wide
typecheck and build pass; its broad test run completed with 14,052 passing tests,
six failed tests and nine failed files (including collection failures). That
archive lacked Git metadata. A filtered private install also resolved Vitest
against unsupported Vite 6; four unchanged suites (116 tests) pass with its
intended Vite 8 dependency. Other broad-run failures remain retained rather
than being credited as passing.
On `807feaecf`, typecheck/build and CI reproduced a test-fixture typing error;
shared prerequisite commit `bb56af7fb` fixes it. These sources predate the latest
review and continuation fixes.
On integrated `bd4cc29c3`, full build, recursive typecheck and token gates pass.
The completed full test attempt records 11,598 passing tests, six failed tests,
2,640 skipped tests and 43 failed files. Four cases fail before assertions during
database bootstrap; other files fail setup or cleanup. Two separate cases time
out at 15 seconds and 300 seconds. After host recovery both passed unchanged
in isolation (documentation read and streamed Git snapshot); the original
full run remains failed and the exact timeout causes remain unproven. This is not a green
repository test run. All Runner verification stages pass across retained,
targeted retries, including 2,533 base TypeScript tests, Rust, 22 SDK tests,
537 scenario tests, 25 main browser tests, six SDK browser tests, 43 scenario
browser tests, 112 issue-thread browser tests, import/package gates and an actual
clean-consumer pack/install. The aggregate `verify` command was not rerun from
the beginning after those repairs. The
[validation checkpoint](runner-rich-acp-validation-2026-09-29.json) retains source
revisions, log hashes, failed attempts and the exact scope of each pass.
The shared PR includes test setup/settlement repairs, corrected baseline browser
expectations, the standalone devtool loader repair and verification-script fixes.
The private embedded Postgres package required its declared postinstall to
restore shipped dylib symlinks before live startup; a credential-free server
health check and subsequent paid question passed with the repair hashed in
their evidence. A green full-suite run and final-head CI remain required.

The Copilot attempt increased the visible included-credit counter from 5 to 6;
additional usage remained disabled at a $0 budget. Per-run USD is unknown.
The first two Pi attempts failed before inference and have zero exclusive-key
billing delta in delayed observations. Pi hello attempt 03 passed on the combined
`97217c531` runtime: 15,340 input, 332 output and 15,360 cached tokens, with a
delayed exclusive-key delta of $0.00065884. The native USD receipt remains
unpriced. All 48 observed owned process identities were retired. Its retained
invocation policy allowed one automatic retry even though the supervisor declared
zero; exactly one Product attempt ran. This configuration gap is retained in
evidence, and subsequent supervisors explicitly pass `--max-automatic-retries 0`.
The current-profile Copilot v4 attempt on `807feaecf` increased included usage
from 6 to 7 credits, with additional usage still disabled; it failed after answer
submission because run attachment rejected the refreshed registered file root.
All 59 owned processes retired. Pi v7 hello on the same source passed with the
$0.000646464 delayed delta above and explicit zero retries. Its informational
pricing-estimate notice appears with a generic warning icon; that presentation
needs refinement and is not a provider error. Failed attempts, missing cost
coverage and cleanup remain recorded. The $100
shared budget and provider allocations remain in force; one successful hello
does not establish production qualification.

The corrected Copilot question on `bd4cc29c3` passed all six matchers with two
runs on the same provider session, no invariant failures and all 59 observed
owned processes retired. Its included-credit counter moved from 7 to 8; the
subsequent four-case campaign moved from 8 to 11. That campaign passed hello,
plan approval and question continuation after controller restart, then stopped
at file-edit startup timeout. No automatic retries occurred. All campaign
processes retired and post-run runtime/dependency checks passed. Additional
GitHub usage remained disabled at $0/$0; these account counters do not supply a
native per-run dollar receipt. The plan and question journeys use authenticated
Paperclip semantic tools; they do not establish a native Copilot ask-user
responder.

Pi Daytona attempt 01 used the previous `807feaecf` image and never reached
provider inference. Exclusive OpenRouter usage stayed unchanged. The owned
sandbox’s closed usage interval cost $0.000407164 in delayed sandbox-specific
analytics, and the resource was observed absent throughout the cleanup window.
The failed attempt and launcher teardown diagnostic are retained. The next
image is built from `bd4cc29c3`, with digest
`sha256:bff4c3f291087a0eeae37e4c20dd51857b92833eaf73ba3aca4157f37de1e109`.
Its installed Linux provider-pack digest is
`sha256:08ad9f6a6fb9c14c87e3bc5b20d01876986178c768433d709a45540e8d40a4be`.
An image build and manifest check are not paid remote qualification.

The [sanitized qualification checkpoint](runner-rich-acp-qualification-2026-09-29.json)
retains current attempts and their original source/profile identities. Pi's
corrected `bd4cc29c3` Daytona hello passed six matchers with one run; the sandbox
was absent throughout the full cleanup window and all owned processes retired.
Three delayed reads stabilized at $0.000630644 OpenRouter usage plus $0.0046878842
sandbox analytics ($0.0053185282 combined, provisional provider accounting).

Host semaphore exhaustion was confirmed by a credential-free PostgreSQL
bootstrap reproduction (`semget` returned `ENOSPC`). With the user's approval,
a fixed-snapshot cleanup removed 4,892 stale sets (83,164 semaphores) and skipped
11 whose recorded creator PID was present. Startup and graceful shutdown now
pass. Private qualification supervisors were also repaired to let the owned
server shut down PostgreSQL before terminating launcher wrappers. Paid Cursor
hello and Copilot file runs each returned to the 255-set baseline without a
forced PostgreSQL kill; no provider runtime bytes changed.

Cursor hello attempt 01 stopped in the private supervisor before provider
launch. A process-inspection race was reproduced and repaired; attempt 02 passed
six matchers with one run. Its matching account usage row is labeled Free (24K
tokens), while native token and dollar receipts remain unavailable. Copilot's
new file diagnostic passed seven matchers, exact file bytes and validation in
one run; its included-credit counter moved from 11 to 12 with additional usage
disabled. An initial workspace-only citation was rejected, then the model
registered its deliverable and completed in the same run. This is not a retry.

Earlier Copilot local and first Daytona failures remain preserved. The remote
invocation never reached fixture creation or a cloud-write path; its machine
cleanup flag remains `unresolved_scope_not_captured`, separately from that
source-order assessment. Host exhaustion does not explain the earlier provider
session timeout. The Pi local/native campaign stopped at its second cell: hello passed, and all
15 native-question behavioral checks passed, but a required API snapshot was
missing. The failed Product result remains retained; the six later cells did
not launch. A minimal harness-only snapshot repair and seven focused regressions
are committed. The two calls cost $0.004005496 by delayed exclusive-key delta.
Cursor’s subsequent question-resume test also stopped its batch on a provider
reopen failure; all 56 owned processes exited and semaphore counts returned to
baseline. Its matching account row is Free (24.7K tokens). A credential-free reproduction shows that a fresh ACPX manager can return a
saved Cursor record without loading the native provider. The committed repair
forces an exact-model control to load that session and acknowledge current
instructions within the existing admission deadline, then renews the consumed
launch lease. Missing or incorrect acknowledgements still block prompting.
The original private sidecar stack is unavailable; this is corroborating
reproduction evidence. The fix passed 93 focused tests and package typecheck;
the rebuilt `627451ecf` runtime subsequently passed question continuation,
semantic plan approval and question continuation after controller restart. Its
file test created and validated exact bytes and reached Done, but the model added
`VALIDATION` to the explicitly requested final marker, failing two of seven
matchers. The batch retains that failure: four cells, seven runs, 23/25 matchers.
All owned processes retired. Seven matching account rows were explicitly Free
and on-demand usage remained zero; native per-run dollars are still unavailable.
Later cases from the original failed batch were not launched.

Copilot Daytona hello attempt 02 passed six matchers with one run. All 45 owned
processes retired and the exact owned sandbox remained absent throughout the
360-second cleanup observation. Three delayed sandbox analytics reads stabilized
at $0.0039682144; this remains provisional infrastructure accounting, separate
from unavailable native per-run dollars and the account’s unchanged included-credit
counter. Additional Copilot usage remains disabled.

Pi’s native-question retry on unchanged `bd4cc29c3` runtime and separate
`43c99f044` eval source passed 15/15 with complete required evidence. The next
question continuation reached Done with two succeeded runs, but failed one of
six matchers because the final item included earlier pre-tool narration. Retained
post-tool text deltas alone match the expected final marker. Both cells fully
settled, all 96 owned process identities retired across the two cells, and delayed
exclusive-key charges totaled $0.005707808. Five later cells did not launch;
the final-message defect remains under investigation.

GitHub billing coverage was also audited: public standard-runner and self-hosted
GitHub minute charges do not add a per-minute charge, but external fleet costs
and private evals CI incremental charges remain unmetered. The $100 live-test
ceiling is not evidence of complete infrastructure cost attribution.

## Registered persistent agent files

Candidate ACP processes receive `AGENT_HOME` only from the authenticated
runtime context's server-registered `agent_files` working copy. Ambient
environment values cannot grant a directory. Admission rejects symlink roots,
filesystem roots and overlap with provider runtime state; directory identity is
rechecked at launch and before each turn. Each provider reopen receives the
current run's registered copy. The native executor requires provider shutdown
before collecting and synchronizing the copy. Pi additionally receives a
runner-owned native-tool root binding; its task read-only policy still applies.
These checks do not by themselves qualify provider-specific native file tools.

## Branches and evidence ownership

| Branch | Deliverable |
| --- | --- |
| [`codex/runner-rich-acp` / #14430](https://github.com/paperclipai/paperclip/pull/14430) | Shared ACPX extension boundary, durable permissions, canonical display events, provider pack infrastructure, configuration and UI |
| [`codex/runner-cursor-acp` / #14435](https://github.com/paperclipai/paperclip/pull/14435) | Cursor native distribution, questions/plans, child activity, policy admission, wire fixtures |
| [`codex/runner-copilot-acp` / #14434](https://github.com/paperclipai/paperclip/pull/14434) | Copilot native distribution, event inventory/projections, permission and settlement probes |
| [`codex/runner-acp-inputs` / #14591](https://github.com/paperclipai/paperclip/pull/14591) | Shared editable drafts, native question compatibility, bounded image builds and authenticated continuation fixes |
| [`codex/runner-pi-acp` / #14436](https://github.com/paperclipai/paperclip/pull/14436) | Patched wrapper, owned extension, MCP/tools, permissions/input, portable dependency closure |
| [`codex/rich-acp-extended-harness-evals` / evals #29](https://github.com/paperclipai/paperclip-evals/pull/29) | Explicit 21-cell Runner Eval campaign, semantic assertions, provenance and fail-closed budget accounting |

The provider branches were implemented in parallel from the foundation. Final
shared registration and packaging conflicts are resolved in dependency order:
foundation → Cursor → Copilot → shared input/continuation prerequisite → Pi.
They remain separate managed worktrees and PR review units; the later PR bases include their prerequisite providers. Foundation
acceptance completed with Apex 5/5 and passing CI; that result does not cover
subsequent provider changes. Provider PRs remain unmerged
pending qualification. Source reports on the provider branches are
`doc/architecture/runner-cursor-capabilities.md`,
`doc/architecture/runner-copilot-capabilities.md`, and
`doc/architecture/runner-pi-capabilities.md`. Those reports retain versioned
source references, per-field dispositions, fixture paths, and narrower claims.
The Copilot inventory enumerates all 150 pinned native event types. Read the
[Cursor inventory](https://github.com/paperclipai/paperclip/blob/codex/runner-cursor-acp/doc/architecture/runner-cursor-capabilities.md),
[Copilot inventory](https://github.com/paperclipai/paperclip/blob/codex/runner-copilot-acp/doc/architecture/runner-copilot-capabilities.md),
and [Pi inventory](https://github.com/paperclipai/paperclip/blob/codex/runner-pi-acp/doc/architecture/runner-pi-capabilities.md)
for the complete per-provider source audit.

[Retained browser evidence](../../ui/storybook/fixtures/evidence/rich-acp-browser-proof.darwin-arm64.json)
records the production renderer's full native plan, accept/reject/cancel,
single/multiple selection, typed input and activity-details checks. Its Cursor
transport is a canonical fixture, not a paid provider session. The browser
renders a 99,724-character plan and verifies its final paragraph before approval.
The JSON records screenshot hashes; screenshots remain outside the source tree.

## Capability matrix

“Candidate” means implemented or observed in deterministic tests. It does not
mean the required paid local and Daytona product cases have passed. “Not exposed”
means the pinned interface was inspected; “unverified” is a separate finding.
Codex's row is the existing app-server integration, not the Codex ACP bridge.

The provider reports above are the method/event and field inventories. Paid
observations in the matrix refer to retained historical versions unless an
explicit profile is named; the current checkpoint above controls qualification. In the
table below, a method that is absent from a pinned implementation is distinct
from an exposed method with no Paperclip control. Shared surfaces and their
deterministic evidence are mapped separately after the comparison.

| Capability | Codex app-server benchmark | Cursor ACP candidate | Copilot ACP candidate | Pi ACP candidate |
| --- | --- | --- | --- | --- |
| Exact model | Selected and reported model | Explicit ID required; exact echo, paid semantic protocol and five local semantic product cases passed | Explicit ID required; exact `gpt-5.6-luna` echo, paid semantic protocol and local completion/file/plan/restart passed | Exact `openrouter/deepseek/deepseek-v4-flash-0731`; model echo and v2/v3 paid Product completion/file/question cases passed; v5 native controls passed |
| Text and tools | Typed thread/turn/item events | Standard ACP updates; child activity kept separate | Standard ACP plus opt-in native session events | Wrapper text/tool updates and owned tool gates |
| Active steering | Dedicated `turn/steer` | Concurrent prompt replaces/cancels, so it is not steering | Concurrent prompt replaces/cancels, so it is not steering | Owned `pi/steer` requires handshake, exact active turn and acknowledgment; real active-turn probe passed |
| Queued follow-up | Product continuation controls | Controller can schedule a later prompt; native queue not established | Native pending-message activity exists; no qualified ACP queue responder | Owned `pi/follow_up`, separately named and ordered; real queued marker followed the steered current response |
| Cancellation | Typed interrupt and process lifecycle | ACP cancel; paid command cleanup pending | ACP cancel; attached async native settlement passes offline. Explicit detached work is rejected before side effects; it is not supported background settlement | Native abort; wrapper waits for `agent_settled` and treats provider errors as failure |
| Session continuity | Read/load/history/fork and durable identity | Session load/list observed; paid semantic warm continuation passed; native history replay unverified and fork absent in tested methods | Session load plus native history events; semantic pending-question controller recovery passed | Private Pi JSONL mapping/load; native RPC `fork`, `clone`, `get_fork_messages` are not mapped through this ACP wrapper; unresolved UI promises cannot survive provider death |
| Questions | Typed input requests and response correlation | `cursor/ask_question`, option identity and multiple selection preserved | Native ask-user capability exists, but pinned ACP does not wire its responder; do not display a false answerable form | `select`, `confirm`, `input`, `editor` through typed form elicitation |
| Permissions | Durable typed approvals | Standard ACP permission options; denied shell write had no observed side effects; separately labeled exact-correlation assessment | Standard ACP; real native reject_once prevented marker creation; session decision scope inspected | Native pre-tool gate; allow once, exact-operation session grant, deny; paths rechecked after wait |
| Plans | Typed plan and collaboration mode | `cursor/create_plan` includes full plan and revision-bound accept/reject/cancel; todo activity separate | Native plan events displayed; native plan-decision callback not exposed in ACP | No native structured plan event; authenticated Paperclip planning tools available |
| Authenticated tools | Runner bridge and governed operations | ACP HTTP MCP binding; paid context/history reads passed | ACP HTTP MCP binding; paid context read passed | Owned extension registers exact bound MCP tools; four authenticated semantic reads succeeded in a paid partial run; no ambient servers |
| Delegation | Typed agent roles and lifecycle | Opt-in subagent lifecycle, nested ownership and bounded child activity; never parent transcript flattening | Native session details retain agent/model fields with unknown originating turn; typed turn-owned delegation is not inferred | No built-in ACP delegation protocol; arbitrary extensions are excluded |
| Files/diffs | Typed file changes and artifact references | Standard tool changes plus validated image references | Correlated ACP tool events remain available; native session file/workspace details are session notices, not attributed task file changes | Wrapper-retained read/write/edit diffs; common typed/UI projection remains partial; semantic artifact tools |
| Images/artifacts | Typed references and registered work products | Existing contained files only, provenance, `registered:false` | Native session artifact details are bounded notices with no inferred turn ownership or automatic registration | Image/resource tool blocks preserved by wrapper; dedicated artifact channel absent |
| Image/attachment input | Typed input conversion | ACP advertises images, but the runner turn converter currently forwards text only | ACP advertises images/embedded context, but the runner turn converter currently forwards text only | Native Pi/ACP image input exists, but the runner turn converter currently forwards text only |
| Usage | Per-request receipt and model context | Pinned ACP omitted receipts on denied and successful turns; account UI confirms included usage separately | ACP/native tokens retained; account UI confirms included credits separately, without a per-run USD receipt | Assistant-message and compaction token receipts; dollar cost is a catalog pricing estimate, never authoritative billing |
| Config/model changes | Typed configurable controls | Agent/Plan/Ask setup is bound to native configuration acknowledgements and recovery; unsolicited mode drift fails admission. Rich parameterized model picker remains unused | Model/reasoning/mode options exist; runtime policy remains authoritative | Exact pinned candidate model; arbitrary slash commands/config/extensions disabled |
| Reconnect/restart | Durable controller replay and qualified provider restoration | Semantic pending question survived a real controller restart; exact native callback restoration remains unverified | Semantic pending question survived controller restart with the same interaction and provider session; native callback restoration remains unverified | Wrapper explicitly advertises live-process-only pending-input recovery |

| Shared capability | User-visible surface | Inspectable implementation / deterministic evidence |
| --- | --- | --- |
| Text, tools and child activity | Task transcript; bounded activity details preserve provider/session/tool attribution | `src/drivers/acpx/codex-runtime-adapter.test.ts`, `runner/crates/runner-core/tests/acpx_rich_events.rs`, `ui/src/components/task-chat/TaskChatProtocolActivityRow.test.tsx` |
| Native questions and permissions | Existing question/confirmation cards; only offered decisions can be submitted | `src/protocol/permission-request.test.ts`, `src/drivers/acpx/acp-permission-adapter.test.ts`, `server/src/services/native-runtime/native-question-bridge.test.ts`, `ui/src/components/task-chat/TaskChatProtocolCard.test.tsx` |
| Native plan decisions | Full plan description followed by a revision-bound decision; no implicit plan acceptance | Cursor provider fixtures; `ui/storybook/fixtures/evidence/rich-acp-browser-proof.darwin-arm64.json` records the real renderer with a canonical fixture |
| Active steering and queued follow-up | Existing active-turn control where a bound method is negotiated; no native Pi queue selector yet | `src/drivers/acpx/turn-controls.test.ts`; provider reports state which wire method is absent or not surfaced |
| Files, diffs and images | Workspace file/artifact cards plus contained provider reference notices; raw provider diffs are still partial | `src/drivers/acpx/profile-extensions.test.ts`; provider field audits; Product `file-edit-validate` uses an independent exact-byte oracle |
| Usage and model identity | Exact configured model, per-provider token/accounting fields, explicit incomplete cost coverage | `src/drivers/acpx/usage-accounting.test.ts`, `src/cli/eval-session-contract.test.ts`, `server/src/services/native-runtime/native-session-executor.test.ts` |
| Durable input, reconnect and provider death | Pending interaction cards survive controller recovery; unsafe replacement expires unresolved requests; delivered settlement survives a crash before journaling | `src/control-plane/durable-prp-control-plane.test.ts`, `runner/crates/runner-core/tests/acpx_provider_resolutions.rs`, `runner/crates/runner-core/tests/native_provider_backend.rs`, `src/live/runnerd-codex-transport.test.ts` |
| Session list/fork, generic configuration and commands | No added operator surface; exact owned session recovery and configured model remain available | Provider inventories identify native-only, ACP-exposed, confirmed-absent and unverified methods with follow-ups |

Paths starting with `src/` or `runner/` in this evidence table are relative to
`packages/paperclip-runner/`; other paths are repository-relative. Deterministic
fixtures establish contract behavior, not successful paid provider execution.

## Shared event and interaction contract

The active connection, wire session, normalized turn and original request identity
bind every extension callback. The allowlist is per provider. An omitted wire
session can only acquire the verified active connection's session; an explicit
mismatch is rejected. Retired streams and inactive turns cannot emit new activity.

Requests enter durable runtime state before the UI presents them. The response
must match an outstanding request and an offered action or valid typed answer.
The direct driver and sidecar await a receipt for the exact JSON-RPC pipe write before the runtime settles its durable record.
The successful resolution enters the retained event outbox in the same atomic
state save that removes the pending request. A restart before journal delivery
retains that resolution for normal event replay and acknowledgment. A restart
before this state save instead expires the unresolved request; neither path sends
the provider response again.
If persistence fails, the current executor stops accepting commands and exposing
or acknowledging retained events. Cleanup still terminates its owned provider,
but leaves the uncertain snapshot untouched. A fresh executor reads the complete
atomic snapshot that survived; it cannot publish an in-memory resolution that
conflicts with a later recovery expiry.
Standard ACP does not acknowledge application of a permission reply; a lost
transport acknowledgment is not proof of exactly-once external effects. A
replacement provider process cannot inherit an old approval promise. A bounded durable ledger expires pending requests after provider loss or unsafe restart, including requests whose creation events were already acknowledged. No tool
mutation or approval is automatically replayed into a replacement.

Full plan documents have a bounded 100,000-character description and a 196 KiB
question-set envelope. Oversized plans fail rather than approve an unseen suffix.
Display redaction remains visible. Decision descriptions render image references as
inert text and Mermaid diagrams as source, so reviewing a plan does not fetch
provider-selected media. Automatic issue-reference linking is disabled for these
descriptions, so a long provider plan cannot start an issue-detail query for every
identifier. The rich event channel has exact canonical
schemas and a bounded envelope. It cannot create terminal outcomes, dispatch a
semantic tool, register an artifact, synchronize a durable plan, or supply source
authority. Notices retain useful bounded fields and provenance in expandable UI
details. Provider references remain unregistered until a control-plane operation
registers them.

Permission labels are derived from offered option kinds. An unknown or duplicate
option is rejected. A provider's “always” decision is not relabeled “this session”
unless the pinned implementation proves that scope. Restrictive execution policy
is separate from automatic approval and company governance. Fresh permission
configuration defaults to full auto; it never overrides read-only task policy.

## Distribution and isolation

Cursor pins `2026.09.26-dd393fe`; Copilot pins `1.0.88`; Pi pins wrapper `0.0.33`,
runtime `0.84.2`, portable Node and its full npm lock. Native distribution hashes
cover macOS ARM64, macOS x64 and Linux x64. Source-owned closure pins remain
separate from profile declaration digests. Native admission reads held files,
verifies every admitted byte, creates a private immutable snapshot and retains
the existing process guardian. A manifest cannot supply its own trusted pin.

Candidate credentials are only read from explicitly bound run environments:
Cursor `CURSOR_API_KEY`/`CURSOR_AUTH_TOKEN`, Copilot `COPILOT_GITHUB_TOKEN`, Pi
`OPENROUTER_API_KEY`. Ambient GitHub login variables, provider configuration,
extensions and MCP discovery do not establish authority. Homes/config/cache are
private. Updates are disabled. Pi launches only its owned extension and assigned
skills, with a startup sentinel before a prompt can run.

Build candidate packs explicitly with `--candidate-providers=<name>` on that
provider's branch. Local and remote pack verification includes the complete
candidate asset tree. The corresponding Daytona build argument is documented in
`docker/daytona-runner/README.md`. Candidate packaging never promotes a profile.

ACP is not an OS sandbox. Cursor v3 patches the verified native ACP
distribution to disable project and ambient MCP discovery and local/remote
hooks. Offline poison-configuration tests exercise the actual transformed
vendor functions; paid and remote qualification remain required. Pi's tool policy supplements the execution boundary; arbitrary
shell commands and filesystem races require the host boundary. These are
qualification gates, not claims that a JavaScript path check confines a shell.

## Explicit gaps and follow-ups

| Priority | Exposed but unused, partial, or unverified | Reason and next proof |
| --- | --- | --- |
| P0 | Remaining paid product cases on local and Daytona | Fresh Cursor5/Copilot5/Pi8 builds require authenticated local and Daytona evidence. Historical Cursor4 passed hello/question/plan/restart but its latest file marker failed despite correct bytes. Copilot4 passed all five basic local journeys and Daytona hello. Pi7 passed native questions but continuation exposed the final-message bug repaired in8. The semaphore blocker is resolved and Cursor's approved on-demand cap is $25. Native interaction, denial, settlement, platform and complete cost/cleanup gates remain open; no old profile pass qualifies new bytes. |
| P0 | Pi fresh-profile Product verification | Historical v4 plan startup failed with unavailable Postgres semaphores. Historical v6 attempts exposed profile admission and verified-runtime startup faults, repaired without raising deadlines. Preserve every failed attempt and run unchanged canonical cases against the final build; do not remove unrelated IPC objects. |
| P0 | Copilot native ask-user and plan-decision callbacks | Pinned ACP does not install native responders. Prove no blocking request is exposed, or add a qualified responder/wrapper; never swallow the request. |
| P0 | Broader Copilot denial and background settlement qualification | Pinned 1.0.88 and isolated 1.0.89 settle attached async commands, but deliberately detached work can finish after end_turn. The earlier paid detached success depended on that model waiting and is not general settlement evidence. Profiles v3/v4 reject explicit detached admission before effects; governed long-lived background work remains unsupported. Denial and process-death recovery pass offline; paid local/Daytona proof remains required. |
| P0 | Cursor native question availability | A real default-mode prompt with no semantic MCP tools reported that native AskQuestion was unavailable. No native request arrived. The pinned client implements the RPC and mode controls, but inspected local guards do not explain the negotiated tool availability. Inspect the actual catalog/flags before another live probe; do not infer permanent harness absence or native success from semantic question tests. |
| P0 | Typed Cursor entitlement failure | The v4 native patch preserves typed entitlement/authentication errors. Offline transformed-vendor tests and clean native authentication failure probes pass. The historical first-account failure remains retained; authenticated Product proof on the revised runtime is still required. |
| P0 | Cursor project and remote hooks; native shell boundaries | The verified v4 patch disables native ambient MCP/hooks at their actual initialization points on all three platforms. Retain real paid/remote isolation and command cleanup qualification before promotion. |
| P1 | Native Pi queue selection in the product UI | The runner API exposes negotiated `follow_up` separately from active steering. The current composer has no native queue selector; add one without confusing it with controller-scheduled later turns. |
| P1 | Pi `queue_update` contents and delivery state | RPC acknowledgment proves acceptance, not model consumption. Add bounded queued/delivered events and durable message correlation with explicit retention rules for user content; preserve this distinction on reconnect. The selected live marker-order probe proves its own consumed messages only. |
| P1 | Pi structured retry and compaction progress | Current text projection drops some `attempt`, `maxAttempts`, `delayMs`, `errorMessage`, `success`, `finalError`, `reason` and `willRetry` fields. Add bounded redacted provider notices with source-event provenance and outcome regressions; keep terminal failure authority separate. |
| P1 | Native Cursor/Copilot active steering and queues | ACP prompt replacement is not steering; native SDK capabilities may be richer. Require a dedicated bound method plus acknowledgment before advertising. |
| P1 | Child tool media/diff/raw payloads | Bounded delegation summaries preserve lifecycle and identity. Large nested payloads need a child-owned canonical item model; current omission is a visible notice and provider report entry. |
| P1 | Standard ACP parent tool `content` diffs/images, secondary locations and raw input bodies | The existing common normalizer projects bounded output text, input-presence, and the first safe relative location. Raw argument bodies can contain secrets; richer content needs bounded typed blocks and a separately validated workspace binding for each file. Provider-specific image/file notices do not close this standard-tool gap. |
| P1 | User attachments and image prompting | `AcpxRuntimeTurnInput` and the common runtime adapter currently forward text only, despite underlying image-input support. Implement validated attachment-to-ACP content conversion and model-specific capability admission, then qualify real local/Daytona image prompts. This is an implementation gap as well as a live-verification gap. |
| P1 | Copilot native session event attribution | `_session_event` omits an originating turn. Preserve bounded event fields as session-scoped notices with `turnAttribution: unknown`; typed delegation, artifacts and compaction need an explicit native correlation contract before turn-owned projection. Standard correlated ACP events remain separate. |
| P1 | Copilot session-store files and export/artifact URIs | Provider paths are not task-workspace paths. Add a separately authorized export flow with validated bytes and provenance; do not resolve arbitrary URLs or auto-register. |
| P1 | Pi native fork/history/export interfaces | Pinned Pi 0.84.2 native RPC exposes `fork(entryId)`, `clone`, `get_fork_messages` and `export_html`. The wrapper does not map them to runner controls. Add durable branch lineage for fork/clone and an authorized, contained artifact flow for HTML export before exposing them; do not label these native capabilities absent. |
| P1 | Complete usage/billing provenance | Missing cache fields remain unknown. Pi price estimates are displayed separately. Budget qualification requires actual spend coverage, not an estimate presented as a bill. |
| P1 | Fork/history and richer configuration controls | Cursor session mode now has explicit admission-bound setup. Arbitrary session discovery/forking, mid-turn configuration changes and the parameterized model picker still need company-scoped controls and durable lineage. |
| P1 | Exact pending-request restoration after process death | Session transcript restoration does not restore callbacks. Expire unresolved requests unless a provider proves exact restoration. |
| P1 | Paid qualification of persistent agent-directory access | Candidate launch paths now bind only the registered `agent_files` working copy, and Pi's native-tool policy admits that root while preserving read-only restrictions. Cold restoration refreshes both the trusted context and composed instructions. Environment delivery alone does not prove model awareness: Cursor and Copilot ignore generic ACP `_meta.systemPrompt`. Provider-specific instruction delivery must pass fresh/load model-boundary checks, followed by paid local/Daytona persistence and cleanup-before-collection cases. Ambient roots remain excluded. |
| P2 | Remaining Copilot native diagnostic/config/account events | The provider inventory records every event and field, its projection or reason for omission. Preserve bounded useful context; avoid credentials, raw environment or unbounded blobs. |
| P2 | Pi empty or whitespace-only submitted input/editor text | Canonical required text rejects blank responses; optional blank responses are omitted. Defaults can be empty and nonblank text preserves boundary whitespace. Add explicit empty-text semantics across TypeScript, Rust and UI before claiming complete native empty-answer parity. |
| P2 | Pi native extension surfaces and unsupported slash commands | Arbitrary extensions/templates/themes may execute ambient code. Only reviewed runner-owned capabilities are admitted; structured native plan/goals are not fabricated. Native fork/clone/export are separate unmapped capabilities above. |
| P2 | Pi status/widget/title/editor and session/configuration notifications | `setStatus`, `setWidget`, `setTitle` and `set_editor_text` have no UI projection and are unused by the owned extension. Native session-name and thinking-level events also lack a dedicated projection. Add reviewed bounded notice schemas and governed configuration controls before exposing these fields; `notify` and interactive input already have separate bridges. |
| P2 | Pi invocation and history provenance metadata | The v4 wrapper retains `nativeToolCallId`, `modelIteration`, `historyMessageIndex` and `identityScope` in private ACP-wire metadata. Closed common tool and permission projections omit them from the UI. Normalized IDs still correlate live tool, MCP and permission events. Add bounded, redacted display-only provenance fields and parity tests before surfacing the native metadata. |
| P2 | Conditional native-plan follow-up fields | Cursor's optional rejection-reason field also appears for accept/cancel. The current question renderer has no conditional fields; add conditional presentation without changing the revision-bound decision receipt. |
| P2 | Cursor command exit code projection | The paid file case preserved native `exitCode: 0` inside output text, while the canonical command field remained null. Normalize a typed, correlated exit code without parsing arbitrary prose; current independent file assertions do not prove this field. |

## Qualification ledger

Combined ceiling: **$100**, including retries and infrastructure. Cursor allocation:
$25; Copilot: $25; Pi: $25; coordinated diagnosis reserve: $25.
Initial reservations are $2 per provider. Measured cumulative OpenRouter key-usage
delta through Pi's native denial, both file attempts, question, three plan attempts and native controls: **$0.028858372**, including failures.
The first model-backed Pi attempt cost **$0.005748807**. Cursor's first account was
not entitled; its dashboard was unchanged at the displayed precision, with no
per-request receipt. Copilot's first session-start failure left its dashboard at
0/1,500 included AI credits and $0 incremental charges. After its protocol and
Product question cases, GitHub displayed 3/1,500 included credits with additional
usage disabled and a $0 budget. It still displayed 3 immediately after the native
denial and detached-command probes, then 5 after the two-turn plan batch. These
are delayed aggregate snapshots; exact allocation among calls is unverified.
After its denial probe, the selected Cursor account displayed 482.5K included
tokens across twelve qualification requests and zero on-demand tokens. The restart
rows showed 23.8K and 41.7K included tokens; denial used 24.4K. Displayed credit precision
and delayed accounting do not establish
a per-run zero receipt. These measurements are
partial, not a final all-provider total. No Daytona leases have been started.
Registry downloads, fake-model fixtures and metadata-only authenticated discovery
are separate from model inference.

The first Pi canonical `get-task-context` attempt used source `788105248a3ba594b30b5bcec3fa266d8a51d8d4`
and provider-pack digest `sha256:4de47c31a8131424495366741bd491ff5fa10723ab9a3918c07a3e42982dbe3c`.
It observed successful `get_task_context`, `get_task_history`, `list_documents`
and `read_document` calls, then hit its 120-second turn deadline without a
terminal receipt. This is a retained failed attempt, not semantic qualification.
Earlier launch/interpreter failures are retained separately. The initial Cursor
failure exposed a native wrapper gap: a typed entitlement error becomes an
ordinary message and normal completion. The runner does not infer authorization
from that message or fabricate a zero-cost usage receipt.

The selected paid Cursor account passed canonical `get-task-context` at source
`01959b8a602683f13706807983f02c3cba9d36a0`, pack
`sha256:f0b622e9151c1c0886e6220c48ea71993b65887baa88b1600b27462074748ddb`,
using exact `gpt-5.6-luna[context=272k,reasoning=medium,fast=false]`.
Its context/history reads and all four semantic checks passed in 29.291 seconds.
The account usage row attributes 56K tokens to this run, included in its existing
Pro+ subscription; incremental cash is zero. ACP supplied no token or USD receipt.
A conservative list-price bound of $0.07 is an estimate, not an invoice.

Copilot's first real completed attempt used source `92fcaf0c`, the same immutable
runnerd SHA-256 `986060810ba7377c6ddd64a5d89e322d0a434e1a9c80400e6d4acf5934bfc421`,
and exact `gpt-5.6-luna`. One context read and all four canonical semantic checks
passed. The original post-run package/provenance failure is retained; offline
scoring recovered the same artifact with zero additional provider calls. Its
24,258 input, 11,781 cached-input and 441 output tokens yield a $0.00326022 catalog
estimate. GitHub still displayed 0/1,500 included credits and additional billing
disabled with a $0 budget after the run. UI delay/rounding leaves the exact credit
delta unverified; this is not a provider USD receipt. Neither protocol case proves
Product E2E, restrictive permissions, restart recovery, or Daytona qualification.

Separate paid Product E2E evidence now records:

| Provider / local case | Exact source revision | Observed result |
| --- | --- | --- |
| Cursor / completion | `edf538e61e712dddb6b4d59045c3dcfd445686c7` | 6/6 assertions; committed finalization, one completion marker, cleanup passed |
| Cursor / file edit and validation | `fe132224c2b30a8d9ce7b46cea38b8760af233fc` | 7/7 assertions; independent final file bytes, visible downloadable workspace artifact, cleanup passed |
| Copilot / completion | `bcc9c638a25b91b84065f12633f083bd4f7a689f` | 6/6 assertions and cleanup passed; original accounting projection failed independently |
| Cursor / question continuation | `a7e01a0cec397dd5048f5d5b5825658dc6e91450` | UI answer Cobalt, continuation and 6/6 terminal assertions passed; two expected provider runs, no retry |
| Cursor / semantic plan approval | `a7e01a0cec397dd5048f5d5b5825658dc6e91450` | Displayed plan revision matched the confirmation target; accept/continue and 6/6 terminal assertions passed |
| Copilot / file edit and validation | `ee9536001fbe733b2386dd3379730a4e0be59488` | 7/7 assertions and cleanup passed; independent bytes validated; GitHub biller and unpriced receipt verified |
| Copilot / question continuation | `ee9536001fbe733b2386dd3379730a4e0be59488` | Question/answer and warm session reuse worked; 4/6 terminal assertions passed because the provider returned a literal placeholder instead of the required marker; failed attempt retained |
| Cursor / controller restart | `d35b83074a018537f5475568d7410e3b1d676789` | 6/6 assertions in 57.865 seconds; pending semantic question survived server restart, Cobalt answer continued to Done, cleanup passed; earlier failed attempts retained |
| Pi / completion | `dd78df1ef8b279c30c710c9b7a7f9fda22e321d6` | 6/6 assertions and cleanup passed in 32.668 seconds; one authenticated `paperclip_finish`, `turn.completed` and `run.terminal`; exclusive-key delta $0.000654767 |
| Copilot / semantic plan approval | `c06fc5fccc88f5816450434493451b9d2d339125` | 6/6 assertions in 45.625 seconds; accepted decision bound to displayed revision 1, exact marker and Done; both paused/completed receipts are GitHub/unpriced; cleanup passed |
| Copilot / controller restart | `19ca0f558` (final runtime remains `8aa867b64d5fc2fd62cff110bd000addf5dc54de`) | 6/6 assertions in 50.875 seconds; same pending interaction survived restart and same persisted provider session continued; exact marker once, Done and cleanup passed |
| Pi / file edit and validation | Runtime `dd78df1ef8b279c30c710c9b7a7f9fda22e321d6` | Failed at the 120-second active deadline after five rejected `paperclip_finish` calls; cleanup passed. The extension discarded validation details. Final bytes and completion arguments cannot be reconstructed from the retained projection. |
| Pi / file edit and validation, v3 | Pack source `7710736ca3924c655c5b0efd172cfd3c0173766a`; execution fix `06cf356a8bc94f709fcd15606fe05e17933fe3b2` | 7/7 assertions in 49.427 seconds, exact file bytes and cleanup passed. One rejected completion exposed the missing registered deliverable; Pi corrected it, registered the artifact and finished. Exclusive-key delta $0.003324737. |
| Pi / semantic question, v3 | Pack source `7710736ca3924c655c5b0efd172cfd3c0173766a` | 6/6 assertions in 158.388 seconds across two bounded turns; exact question/option IDs, Cobalt answer, warm continuation, final marker and cleanup passed. First waiting run has no usage receipt; exclusive-key delta covers both runs ($0.001413697). |
| Pi / semantic plan, v3 first attempt | Pack source `7710736ca3924c655c5b0efd172cfd3c0173766a` | Failed the native write-boundary UI assertion in 119.553 seconds. The saved two-step plan, matching revision and confirmation controls were visible, but all retained DOM snapshots showed the fallback Plan card. Rust lost the MCP display name/namespace used for placement. Cleanup passed; exclusive-key delta $0.003090504. Matcher remains unchanged. |
| Pi / semantic plan, v3 second attempt | Combined pack source `7ab463697037c9456a4ad2b83ea0e9c28b353f8a`; daemon source `e35b11db21b8da8527fa0b6c6f5fe186bdced111` | Displayed Plan placement and revision-bound acceptance passed. The resumed turn exceeded the unchanged 120-second active deadline; total case duration 260.246 seconds, cleanup passed. Pi reused native `call_0` for different tool executions, so the bridge correctly rejected conflicting identities. No terminal usage receipt; exclusive-key delta $0.002440082. |
| Pi / semantic plan, v4 first attempt | Frozen combined runtime `f556110d588a9de9fefe676a9a62bf09e98afb85`; fresh pack `sha256:4df7e9fa164929c7ae7d8e8711f0bf7d587d9fa6a246d0a8340f318f57168855` | Infrastructure failure during embedded PostgreSQL initialization in 6.679 seconds; no provider process or prompt. Disposable reproduction confirms host SysV semaphore exhaustion (16 free, 17 required). Cleanup passed, exclusive-key delta $0, and all original graders/deadlines remain unchanged. |

Pi's immediately preceding `hello05` consumed $0.000351509 and failed evidence
packaging after a confirmed 888-second host Maintenance Sleep. It reached
authenticated prompt acceptance but retained no semantic-tool or terminal event.
An incomplete Playwright archive could not be inspected (`unzip` exit 9), so the
existing scanner failed closed with its `secret_leak` classification; no credential
match was observed. That canonical failure remains unchanged. The deliberate
`hello06` repeat used the same runtime source, a task-owned idle-sleep hold, and
both wall-clock and monotonic outer deadlines. Canonical Pi cost remains unpriced;
the exclusive-key billing delta is separate evidence, not a fabricated receipt.

Separate real native probes used final immutable packs without a Product database:

| Provider / probe | Runtime source | Observed result |
| --- | --- | --- |
| Cursor / native AskQuestion | `25fb1b5b317e52a8ad50208d7681a1ee34bd939c` | Failed: zero native input events, normal terminal and cleanup; the provider reported that the tool was unavailable. This does not qualify the native question bridge. |
| Copilot / denied write | `8aa867b64d5fc2fd62cff110bd000addf5dc54de` | Passed: actual native permission request ID 0, original `reject_once`, forbidden marker absent in all 79 observations through process cleanup. |
| Copilot / detached command | `8aa867b64d5fc2fd62cff110bd000addf5dc54de` | Passed: actual `mode:async` and `detach:true`, original `allow_once`; command completion at 10.083 seconds and marker at 10.098 preceded `end_turn` at 10.675; five-second late-effect check and process cleanup passed. |
| Pi / denied write | `dd78df1ef8b279c30c710c9b7a7f9fda22e321d6` | Passed in 20.438 seconds: actual native permission ID 0 persisted before original reject_once reply, pipe delivery acknowledged, correlated tool failed, prompt settled end_turn, forbidden file absent and cleanup passed. |
| Cursor / denied shell write | `25fb1b5b317e52a8ad50208d7681a1ee34bd939c` | Original grader failed because permission omitted rawInput. Separate offline assessment passed from the preceding exact-command tool_call bound to the same toolCallId, original reject-once reply and 98 independent absent-file observations through terminal and cleanup; no repeat prompt. |
| Pi / active steering and queued follow-up, v3 | Pack source `7710736ca3924c655c5b0efd172cfd3c0173766a` | Passed in 21.342 seconds. Both active-session operations acknowledged while a persisted native write permission waited; original reject_once denied the tool, visible STEERED_CURRENT preceded QUEUED_NEXT, forbidden file stayed absent, end_turn settled, stale steer was rejected and cleanup passed. |
| Pi / active steering and queued follow-up, v4 | Frozen combined runtime `f556110d588a9de9fefe676a9a62bf09e98afb85`; verified pack `sha256:4df7e9fa164929c7ae7d8e8711f0bf7d587d9fa6a246d0a8340f318f57168855` | Passed in 20.255 seconds: normalized invocation identity matched the denied tool update; both controls acknowledged before the original denial; exact STEERED_CURRENT then QUEUED_NEXT, stale steering rejected, end_turn and cleanup passed, forbidden file absent. Settled exclusive-key delta $0.000546502; separate Pi estimate $0.000803936. |
| Pi / active steering and queued follow-up, v5 | Runtime `aec26ad83f1d082f0d0a5eaffbd615a9e2e26155`; pack `sha256:cf7d0998bbc2bed7b893c726c2b6455ba8a683d9cff7d92afedbff2d5900d500` | Passed in 19.199 seconds: one real normalized write invocation, original reject_once persisted before reply, both controls acknowledged before denial, exact STEERED_CURRENT then QUEUED_NEXT, stale steering rejected, end_turn, forbidden file absent and cleanup passed. Settled exclusive-key delta $0.000151739; its separate Pi estimate is $0.000611156. |

These narrow native probes do not replace durable Product interaction, restart,
or Daytona coverage. Their private wire evidence remains separate from sanitized
public summaries. A private durable retention manifest also records hashes for the
logs, screenshots, wire evidence and failed attempts; no credentials are published. The semantic Cursor question and plan cases above exercise
Paperclip tools, not the native `cursor/ask_question` or `cursor/create_plan` RPCs.
The failed Pi file case exposed two wrapper losses. Profile version 3 at
`06cf356a8bc94f709fcd15606fe05e17933fe3b2` preserves bounded, redacted MCP validation
errors and bounded Bash arguments/output; oversized values have an explicit
omission marker. Version 1 and 2 warm snapshots are rejected. Installed-wrapper
regressions pass. A fresh v3 pack then passed the paid file case: the model received
the actual missing-deliverable receipt error, registered its deliverable and
completed. The original v2 failure remains retained.
Canonical command exit codes and typed generic diff/media projection remain partial.

The Pi denial/file batch cost $0.010995043 by exclusive-key delta. Delayed billing
prevents exact per-call attribution, so the aggregate remains separate from Pi's
catalog estimates and its missing terminal receipt on the file case.

The Cursor file case proves the workspace artifact surface, not complete native
file/diff projection. The Copilot result incorrectly projected missing native cost
as USD zero and attributed its biller to OpenAI. The original result is retained;
the shared fix identifies GitHub, Cursor and OpenRouter correctly and keeps absent
candidate USD receipts unpriced. The separate Copilot file case verifies that fix.
The question case exposed a second ledger edge: zero normalized token counters
were treated as a reported cost despite no cost field. Ledger classification now
requires an explicit finite nonnegative cost; an explicit zero remains reported.
Protocol evals now fail their cost gate when spend is unknown, preserving completed
behavior and semantic evidence in a separate accounting-failure result. The
maintained campaign stops subsequent cells on unknown accounting and never turns
an unavailable receipt into a zero-dollar measurement.

Initial Product attempts exposed local PostgreSQL postinstall hydration and a
server candidate-admission gap before any model prompt. Both failed attempts are
retained. The package's own hydration repairs local installation; exact host
qualification now applies consistently at agent creation, runtime selection,
native input and process construction. Agent configuration cannot grant itself
qualification authority. The obsolete unconditional Pi executor rejection is
replaced by the same closed host authorization. Candidate active turns are bounded
to 120 seconds and automatic infrastructure retries remain disabled.

Pi's next local startup attempt timed out before any prompt, with zero exclusive
key usage delta. A credential-free reproduction isolated a 37.423-second immutable
copy of its 13,827-file, 234,019,683-byte distribution, after 5.168 seconds of
verification, against the 30-second session-open deadline. Bounded parallel copying
reduced that same copy to 5.851 seconds without changing a timeout. Ten tests cover
the eight-file / 32 MiB batch bounds, unchanged per-file integrity checks, stable
digest order, mutation rejection, and draining pending copies before cleanup.
The later `hello06` paid Product case above proves successful inference and
settlement after this startup fix. Its final screenshot shows one readable answer,
a visible Done status and a usable composer, with no duplicate response or error.

The maintained Product E2E `extended-harnesses` suite covers local and Daytona
completion, question/answer, semantic plan approval, pending-input restart and
file edit/validation. It has no automatic retries and does not enable candidates
outside exact operator-authorized provider/model pairs. The private Runner Eval
campaign is complementary: seven semantic protocol cases per provider. Neither
suite's membership is a qualification claim.

Before each paid batch, record source SHA, executable and closure/profile digests,
exact model, OS/architecture or Daytona image, selected cases, prior spend,
maximum batch spend and authoritative billing coverage. Stop before the shared
ceiling. Missing spend coverage blocks a run rather than treating unknown cost as
zero. Retain screenshots and wire evidence without credentials. Never convert a
provider to supported solely because a test suite or packaging check passed.

Verification commands and final results are recorded with the prerequisite and
provider PRs. The full handoff requires runner checks, token gates, recursive
typecheck, `pnpm test:run`, and `pnpm build`. Until that evidence is recorded, this
report is an implementation report rather than a PR-ready certification.

At foundation `5aeebb20c`, recursive typecheck, build, token gates, full Rust runner
checks, conformance/replay parity and API-authority checks passed. Approval
verification includes 18 real database integration tests, 15 projector cases,
87 transcript/UI cases, 82 route/websocket cases and eight provider receipt cases.
The local full root test attempt initially failed because embedded Postgres's
install-time library links were missing. Its official package postinstall restored
them; all 38 affected suites (743 tests) then passed. The workspace streaming stress test initially exceeded macOS path limits
(`ENAMETOOLONG`); the later portable fixture correction is recorded below. The full runner TypeScript repeat passed 2,164 tests in 156 files, with ten
skipped tests. The full UI and CLI suites passed 6,772 and 502 tests. Remaining
source workspace checks passed 2,882 tests; two macOS path-alias fixture failures
were corrected with an explicit injection assertion (all 89 sandbox tests pass),
and a database timeout passed in an isolated repeat. Failed attempts and the
latest CI state remain recorded in the PR. The decision-media review fix passes
87 focused tests, UI typecheck, token gates and the UI build.

At execution source `f063fbf2b`, recursive typecheck, full build, token gates,
13 accounting tests, 10 immutable-distribution tests and seven image-contract tests
pass. Both full UI/CLI shard partitions pass (6,848 UI and 502 CLI tests).
The remaining local test partitions run sequentially after paid Product cells to
avoid the machine's observed PostgreSQL semaphore exhaustion. Earlier failures,
including the unchanged macOS path-length stress case, remain retained. Foundation
CI at this source passed typecheck, build, Rust, both runner test lanes, all twelve
general server shards and all eight browser shards. Six other jobs received a
coordinated runner-shutdown signal; their cancellation is not a passing result.
Greptile reviewed this source at 5/5. Later documentation/build-pin updates still
require their own final check status.

Initial macOS ARM64 candidate packs were independently built and launched through
the generic installation registry: Cursor source `1055c13f8`, Copilot `5d8829add`,
Pi `f58cfa1cb`. Review fixes that change execution bytes require fresh packs and
launch proofs; the latest source SHA, manifest/profile/closure digests and
sanitized wire evidence are retained in each provider PR. Earlier proofs retain
their original source identity. These probes send no model prompt.

Final native Linux packaging probes also run with no network, no credentials and
no model prompt. Cursor source `25fb1b5b317e52a8ad50208d7681a1ee34bd939c` initialized
from image `sha256:5fa7951d1d6dd99305555fe00a5baf2bf5b834d16f021053737301975b93986f`;
its native EOF does not settle within five seconds, so explicit process-group
cleanup is required and verified. Copilot source
`8aa867b64d5fc2fd62cff110bd000addf5dc54de` initialized as version 1.0.88 from image
`sha256:5457769683fd310223d3b0d4f1ed9a6cf341bdb16514746b3aaeabca2e888fee` and exited
zero on EOF. Its metadata-only fixture received zero requests. The provider PRs
retain complete pack/executable digests and sanitized initialization responses.
Pi v3 source `06cf356a8bc94f709fcd15606fe05e17933fe3b2` also initializes and
exits zero from image `sha256:c5fa7976bba92a186a2f70dc8b8ddc58ab86606b80a819c89bf550d2d057c832`,
with profile digest `sha256:72cb225288376f733b9ed3afa5e13565eb4152f0de509bc1181382fa44bee472`.
The earlier Pi v2 proof remains historical.
These are packaging proofs, not paid Daytona or model-availability evidence.

At `e8dee462e2fd09cf858be0a02368805346ec4f3b`, versioned profile contract tests
pass 36 cases and full runner TypeScript checking passes. Nine additional source
workspace suites pass 2,757 tests with 19 skips. An isolated repeat of the unchanged
HTTP redaction suite passes all 59 tests after its earlier concurrent-run timeout.
The feedback-route mock fix retains both company-boundary assertions and passes
two independent fresh-environment repeats (4/4 each). Current source and any
remaining partition failures are recorded in the final prerequisite PR evidence.

The portable real-Git stress fixture passes on macOS in 234.43 seconds, retaining
40,000 files, four independently checked 34,988,890-byte filename lanes, real
staging/deletion and cleanup. Its timeout is 300 seconds on macOS and remains
180 seconds elsewhere. Both earlier failures are retained. All seven remaining
serialized root partitions pass; database-project and previously skipped-file
remediation later passed all ten partitions, including 1,042 chat integration tests.

The combined provider stack passes 616 ACP/profile/backend tests with eight
skips, 34 packaging and actual-wrapper tests, and a TypeScript build. The
Copilot registry regression now verifies dispatch to separate native factories;
the pack test no longer assumes another implemented provider is absent.
The complete database project passes 161 tests in 44 files after serialization;
all ten remediation partitions completed without failure, including the full
1,042-test chat integration lane.

The first Pi plan attempt exposed a shared Rust display-mapping gap: prefixed MCP
tool names were retained as builtin names, preventing the saved Plan from anchoring
to its write event. All four retained browser snapshots showed the fallback Plan
card inside a settled turn, so the existing Product matcher remains unchanged.
Foundation `5aa02662b34fc70f5fe9ffd5ac8f7ae81b5fe3bd` parses both ACP MCP name forms,
preserves bounded/redacted namespace and name, and leaves semantic authorization,
operation and read-only classification unchanged. The original Rust regression
fails before the fix; 55 Rust, 28 TypeScript provider and 158 UI tests pass afterward.
The UI regression distinguishes the proper write-boundary card from the original
fallback. A rebuilt daemon is required for the retained paid retry.

The rebuilt daemon passed the Plan placement and revision-acceptance boundary in
the second paid attempt. Its continuation exposed a separate Pi identity defect:
the owned extension reused native `call_0` as the MCP request ID for different
executions. A rejected finish was followed by a corrected finish and context read,
both correctly rejected by shared duplicate-call protection. Further paid cases
stopped. Pi v4 at `f556110d588a9de9fefe676a9a62bf09e98afb85` binds live identities
to a private launch namespace and a lifetime model-iteration ordinal. Exact
request retries retain their identity; conflicting or duplicate native invocations
within one iteration fail closed. History uses a separate display-only identity.
Bridge idempotence and durable call tombstones stay intact. Raw native IDs remain
private-wire provenance, with the UI omission recorded above.

The corrective-call regression failed before the fix and passes against the real
authenticated loopback tool bridge afterward. The pinned native SDK test covers
six iterations across two warm prompts and four executions that reuse `call_0`;
its native turn index resets, while the owned ordinal remains monotonic. This
check uses an in-memory model stream and no inference. Independent review and
profile-digest verification pass. At that v4 checkpoint, the profile digest was:
`sha256:2324d9b47650c12b16f8e2c44dc33637d52f1b22ba8e914623eac4049e7e1991`.
Earlier v1-v3 snapshots could not establish that runtime identity. The extended
Runner Eval configuration then pinned v4 and rejected those historical identities;
all 132 eval tests and seven-cell Pi campaign validation passed without provider
calls at that checkpoint. The later v5 identity is recorded below.

Recursive typecheck and the full build both pass at shared repair source
`5aa02662b34fc70f5fe9ffd5ac8f7ae81b5fe3bd` and again at version-admission source
`1545c7692`. The latter adds closed profile-version-4 admission, with 22 contract
tests and full runner TypeScript checks passing. Exact profile digest matching
remains mandatory. Recursive typecheck and the full repository build also pass
on the frozen combined provider source `f556110d588a9de9fefe676a9a62bf09e98afb85`,
including Pi v4. The combined macOS ARM64 provider pack
at `7ab463697037c9456a4ad2b83ea0e9c28b353f8a` independently verifies all three
complete candidate trees (446 Cursor files, one Copilot executable and 13,827 Pi
files), manifest digest
`sha256:0800f10114e3d8e2e981ea27f0ab47f1da9349dbcc22bf55a76ebbc4af00601d`.
All three initialize through the verified registry without credentials or model
prompts. The combined Linux image at source
`e35b11db21b8da8527fa0b6c6f5fe186bdced111` also passes all three initialization
probes under network-none and a read-only root. Image digest:
`sha256:17c228d3b9744d6bf375ead57918c755d0cc44fc3db44d238cc898317cea25ce`;
pack digest: `sha256:4e0ddb39a34e7f55d7520a8a2d9074009589f3f95f4c10bb837e54ec58d70ba1`.
These combined proofs contain Pi v3 and retain that historical identity when the
invocation-identity repair produces a new profile. They are not paid Daytona proof.
All candidates remain pending; verification and packaging do not grant support.

The fresh v4 macOS ARM64 pack at the frozen combined source has digest
`sha256:4df7e9fa164929c7ae7d8e8711f0bf7d587d9fa6a246d0a8340f318f57168855`.
All 13,827 Pi runtime files independently match the pinned closure. Native
initialization under denied networking exits cleanly; the complete Runner path
returns the expected typed missing-key rejection without inference. The rebuilt
daemon has SHA-256 `373848d2d7287b2c47b2cee422cb7bd25073a594a620a9ad574f2d3d51cd1670`.
The next canonical paid plan attempt stopped in PostgreSQL initialization before
provider startup. Its unchanged billing and exact disposable initdb failure are
retained. The diagnostic created no server, removed its temporary directory, and
left IPC totals unchanged. Unrelated database processes and IPC objects were not
modified. Canonical Product E2E does not currently admit an external database
substitute; introducing one requires its own ownership, isolation and cleanup
proof rather than bypassing the existing guard.

The v4 native probe above does not need a database and passed independently of
the host PostgreSQL blocker. A read-only IPC attribution audit found no semaphore
set with sufficient task provenance for safe cleanup; no unrelated set was
removed. The paid Product and Daytona qualification gaps remain open.

Dependency review subsequently identified Pi's pinned `undici@8.9.0` in
[GHSA-3wwx-pv8p-q78v](https://github.com/advisories/GHSA-3wwx-pv8p-q78v),
indexed in GitHub's advisory database on September 28. Pi's owned Node 24.19.0
also embeds affected Undici 7.29.0. The repair requires both the exact npm override
and the provider-local patched Node distribution; it cannot be represented by a
waived check or a claim that updating npm replaces Node's builtin implementation.
Shared contract source `e6163e16a` admits closed profile version 5, with 23 contract
cases and full runner TypeScript checking passing; unknown versions remain
rejected and exact command digests remain mandatory.

The combined v4 Linux image at frozen source `f556110d588a9de9fefe676a9a62bf09e98afb85`
was built and all three providers passed credential-free initialization under
network-none with a read-only root. Image digest:
`sha256:4c4e2fb7eb8ef3681b14c3e21dd28eace5ef920d6d08d572fb9c9c7e9a5f290a`;
pack digest: `sha256:8f263ed5c309b47cdc74a37d8217bb49e57129fca393498f54f6dd461657a9b9`.
The daemon SHA-256 is `5914ed1ad0235aaee9af8731af2cbf28d7b16b0fda231a13963f1d86c3220daa`.
Cursor still needs explicit cleanup after EOF; Copilot and Pi exit zero. No model
prompt or credential was supplied. This remains a historical packaging proof
when the dependency repair changes Pi's profile and executable closure.

Recursive `pnpm -r typecheck` and `pnpm build` also pass at shared version-5
admission source `e6163e16a`; no database or model request is used by those checks.

Pi v5 repair source `aec26ad83f1d082f0d0a5eaffbd615a9e2e26155` pins private
Node 24.21.0 (bundled Undici 7.29.1) and nested npm Undici 8.10.2. Because npm
retains the vulnerable shrinkwrapped package despite overrides, materialization
verifies the exact published old tuple, replaces only that package from a bounded,
integrity-checked fixed archive, and then verifies the complete trusted closure.
The upstream Pi package and shrinkwrap bytes remain unchanged; the exception is
explicit and closed. Profile digest:
`sha256:020d96ccbd3c45c3f62680814776394ed5a56d9572a1a4dccda56a74d16c7803`.
Old versions 1–4 are rejected. Forty-three focused TypeScript tests, 19 package
checks, eight materializer checks and 13 Rust tests pass. Independent review verified all 13,827 installed
files, both patched dependency copies, eight materializer and twelve profile/
recovery cases. Recursive typecheck and the full build pass at the same source.

Shared Docker pin source `3a5637732` uses the official Linux x64
`node:24.21.0-bookworm@sha256:5a750d3be5e5c80275f8c9a5367c3aed99c2875656590c8d0701c7ee687f5f0a`
for the outer provider pack. A network-disabled launch independently reports
Node 24.21.0 and Undici 7.29.1, matching the
[official Node release](https://nodejs.org/en/blog/release/v24.21.0). All seven
image-contract tests pass. The first local test invocation failed because the
root has no `tsx` executable; the retained retry used the maintained Vitest
configuration. No provider call was made by either command. Pack authority
includes the outer Node bytes and is bound into the persisted launch profile;
changes invalidate incompatible warm recovery independently of Pi's profile bump.

The fresh v5 macOS ARM64 combined pack has manifest digest
`sha256:cf7d0998bbc2bed7b893c726c2b6455ba8a683d9cff7d92afedbff2d5900d500`
and source `aec26ad83f1d082f0d0a5eaffbd615a9e2e26155`. Independent initialization
through the verified registry passes for Cursor, Copilot and Pi with no provider
credentials or prompts. The outer interpreter reports Node 24.21.0 and Undici
7.29.1. Cursor still requires explicit process-group cleanup after EOF; Copilot
and Pi exit zero. All owned processes and private supervisor directories are
cleaned. Cursor/Copilot profile and closure identities match their prior pack.
The proof index has SHA-256
`a07394e3215eb0a153c4a9443762a5d84ddfe0e70b92e1d47ae8d574239e104c`.

The private Runner Eval campaign now pins v5 at eval source
`18f06b9391838d637c1588f372c7f1397ec6f9a7`. All 133 Python tests and the seven-cell
Pi validation pass without provider calls. Explicit tests reject each historical
v1–v4 version, digest and paired identity. Cases, model, scoring, budgets and
deadlines remain unchanged.

Current Linux image identities and exact-head CI/review status are recorded in
the [Pi PR verification](https://github.com/paperclipai/paperclip/pull/14436) and
[foundation PR verification](https://github.com/paperclipai/paperclip/pull/14430).
Their immutable source and dependency identities remain distinct from the
historical packaging proofs above. Image initialization does not certify paid
Daytona execution. Those were historical blockers at that checkpoint. The current production
checkpoint above records the present blockers; Daytona API authentication and
analytics access have since been verified.
