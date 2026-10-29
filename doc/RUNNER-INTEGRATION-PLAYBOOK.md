# Adding a harness to Paperclip Runner

Last reviewed: 2026-10-19. Source baseline: `c6a0cf4bce42449f617fb1cfbe25b8500d8a9fb9`.

This playbook adds a new harness/provider to **native Paperclip Runner**, the new
Runner execution system. It takes that integration from requirements and protocol
research to installation, real product acceptance, and a bounded release. It
distills the Pi, Cursor, and GitHub Copilot integrations, including failed attempts and
later corrections. It is a procedure for future work, not a certification of
today's binaries or a requirement to repeat every historical test.

All reusable principles and acceptance criteria are written here and in the
templates. No private Codex session, Paperclip task, historical evidence archive,
or separate private repository is a prerequisite. Links point to code and docs
in this checkout or public provider documentation. The matching skill is
[create-runner-adapter](../.agents/skills/create-runner-adapter/SKILL.md).

Legacy direct-adapter authoring, agent conversion, and migration are outside
this playbook. Existing legacy behavior remains a regression boundary.

Start with one useful vertical slice: an operator configures the harness, assigns
a task, sees real work, receives an independently checked result, and can stop
the work. Extend that slice to the capabilities and environments promised for
the release. Keep a finite acceptance contract and a capability inventory side
by side: the inventory describes everything discovered; the contract says what
must work before this release can ship.

Use the [copyable working templates](runner-integration-templates.md) for the
contract, capability inventory, acceptance ledger, and failure record.

## Contents

1. [Establish the native Runner boundary](#1-establish-the-native-runner-boundary)
2. [Define the release before implementing it](#2-define-the-release-before-implementing-it)
3. [Understand the existing execution path](#3-understand-the-existing-execution-path)
4. [Investigate the real harness](#4-investigate-the-real-harness)
5. [Build the smallest complete slice](#5-build-the-smallest-complete-slice)
6. [Implement admission and configuration](#6-implement-admission-and-configuration)
7. [Deliver instructions, tools, and credentials](#7-deliver-instructions-tools-and-credentials)
8. [Preserve events and rich capabilities](#8-preserve-events-and-rich-capabilities)
9. [Make human interactions durable](#9-make-human-interactions-durable)
10. [Own continuity, cancellation, and settlement](#10-own-continuity-cancellation-and-settlement)
11. [Ship an installable runtime](#11-ship-an-installable-runtime)
12. [Test with an evidence ladder](#12-test-with-an-evidence-ladder)
13. [Run the product acceptance matrix](#13-run-the-product-acceptance-matrix)
14. [Diagnose failures before another paid attempt](#14-diagnose-failures-before-another-paid-attempt)
15. [Keep qualification finite and reproducible](#15-keep-qualification-finite-and-reproducible)
16. [Review, release, and operate](#16-review-release-and-operate)
17. [Lessons and remaining limits](#17-lessons-and-remaining-limits)

## 1. Establish the native Runner boundary

The object being added is a **harness/provider integration within native Runner**.
“Adapter” in this document means its translation and launch layer. The Runner
daemon, provider protocol, and execution environment have separate responsibilities.
Trace those responsibilities before copying an existing provider.

| Integration responsibility | Owning boundary | Starting point |
| --- | --- | --- |
| Provider lifecycle and native session behavior | Harness driver and provider-owned translation | [Runner package](../packages/paperclip-runner/README.md) and the source map in section 3 |
| ACP-based transport, when suitable | Existing ACPX driver plus provider-owned launch and extensions | [ACPX implementation](../packages/paperclip-runner/src/drivers/acpx/) |
| Admission and product configuration | Shared contracts, server admission, and native Runner UI | Section 6 and the source map in section 3 |
| Running this provider on an existing hosting target | Runtime distribution, execution-environment lifecycle, and networking | [RunnerExecutionDriver architecture](../packages/paperclip-runner/README.md#execution-environment-lifecycle) and section 11 |

Choose the richest stable interface that can meet the release contract. A native
session API can be better than ACP when it exposes controls ACP cannot carry.
ACP can be better than parsing an interactive CLI's text. Existing ACPX support
is a strong reuse opportunity, not a reason to ignore a material native feature.
Document the choice and the capabilities it loses. If a CLI is the only viable
interface, implement its launch, observation, and cancellation contract behind
the native Runner driver boundary. A direct-adapter implementation does not
satisfy this integration's contract. Adding a hosting platform or external bot
system is a separate scope decision, not an implicit part of adding a provider.

Adding native Runner support does not authorize migrating existing direct
adapters. Preserve persisted runtime choices, history, and the legacy invocation
path. Test that a legacy run still starts no runner process or PRP connection.
Read the current selection code before describing defaults: historical ADRs
describe rollout phases and can lag current product configuration.

Before editing, follow `AGENTS.md`, the scoped rules, and any nested instructions.
Read the goal/product/spec/development/database documents, then the runner README,
[architecture](architecture/paperclip-runner.md),
[compatibility](architecture/paperclip-runner-compatibility.md). The test procedure
and acceptance criteria are in sections 12–15 below. Use
[runtime-dependency-boundaries](../rules/runtime-dependency-boundaries.mdc) when
adding filesystem, process, database, or network work to shared paths.

## 2. Define the release before implementing it

Create a dated plan under `doc/plans/` when a repository plan is needed. If the
task lives in Paperclip and requests a plan, use its issue plan document. Keep
one current acceptance ledger; append historical results without allowing them
to masquerade as the current decision.

Record these decisions explicitly:

| Decision | Required answer |
| --- | --- |
| User outcome | What ordinary work should this harness complete? What result does the user receive? |
| Native Runner route | Which harness driver and native protocol/wrapper own this provider? Which existing execution environments will run it? |
| Release target | Reviewable PR, merged experimental support, staging canary, or deployed production? Which actions are already authorized? |
| Environments | Local, SSH, Daytona, or another target; identify the first acceptance environment. |
| Platforms | Actual supported OS/architecture combinations, and whether proof means build, startup, emulation, or native live execution. |
| Authentication | Explicit API key, subscription token, or managed connection; setup and entitlement requirements. |
| Models and modes | Caller-selected configuration; a separately recorded model/mode for repeatable acceptance. |
| Required richness | Questions, approvals, plans, steering, queueing, artifacts, children, memory, recovery, or other promised behavior. |
| Known exclusions | Unsupported or deferred capabilities, their visible product treatment, and why the release remains useful. |
| Accounting | Required measurements, known unknowns, and what budget enforcement can actually guarantee. |
| Spending | Total campaign budget, provider/account caps, infrastructure/review costs, retry authority, and stop conditions. |
| Installation | Normal public package/setup path and remote image path; no development-only override as the final setup. |
| Proof | Exact test cells and independent observations establishing every required outcome. |
| Ownership | Integration owner; owners of shared contracts, provider code, packaging, tests, and release. |

Infer routine choices from the request and existing product contracts. Ask only
about a consequential unresolved choice. Do not make the user repeatedly approve
already-authorized testing or routine corrections. Conversely, changing an
explicitly frozen model, exceeding a cap, overriding a repository gate, or
deploying beyond the agreed target requires the relevant authority.

Use three categories for capabilities: **required for this release**, **supported
but outside this campaign**, and **deferred/unsupported**. Missing required work
cannot be relabeled to finish. A user-approved scope change is legitimate: record
its date, new contract, and exclusions without rewriting old failures.

Derive the matrix from the new release's promises. A large protocol catalog and
an all-platform inventory can obscure an unfinished ordinary task journey.
Require each acceptance cell to name the user promise it proves; keep discovery
gaps visible without silently making every optional gap a release blocker.

## 3. Understand the existing execution path

Trace one already-working provider from configuration to final task state before
writing new code. Record the file and owner at each boundary.

```text
Operator / API
    -> saved agent configuration + company/workspace authority
    -> server admission and persisted native run selection
    -> execution environment prepares verified assets and scoped credentials
    -> runnerd + authenticated PRP transport
    -> harness driver / ACPX sidecar / provider adapter
    -> real provider session and tools
    -> normalized events, runtime requests, semantic receipts
    -> durable controller projection, result acceptance and finalization
    -> task state, interactions, artifact access and user-visible response
```

For ACPX, inspect both the TypeScript path and the production Rust/sidecar path.
A field that works in a direct TypeScript probe may be rejected or dropped by
the Rust decoder or actual packaged sidecar.

| Responsibility | Current source anchors |
| --- | --- |
| Public harness interfaces, capabilities, requests | [harness-driver.ts](../packages/paperclip-runner/src/contracts/harness-driver.ts), [native execution contracts](../packages/paperclip-runner/src/contracts/native-execution.ts) |
| Canonical provider event inventory | [provider-events.ts](../packages/paperclip-runner/src/provider-events.ts), [protocol schemas](../packages/paperclip-runner/protocol/) |
| ACPX capability and driver declarations | [driver-profile.ts](../packages/paperclip-runner/src/drivers/acpx/driver-profile.ts), [capability-profiles.ts](../packages/paperclip-runner/src/drivers/acpx/capability-profiles.ts) |
| Provider-specific requests and activity | [profile-extensions.ts](../packages/paperclip-runner/src/drivers/acpx/profile-extensions.ts), [profile-activity.ts](../packages/paperclip-runner/src/drivers/acpx/profile-activity.ts) |
| Actual ACPX manager and provider interaction | [codex-runtime-adapter.ts](../packages/paperclip-runner/src/drivers/acpx/codex-runtime-adapter.ts), [codex-acpx-driver.ts](../packages/paperclip-runner/src/drivers/acpx/codex-acpx-driver.ts) |
| Model/mode and session identity | [model-verification.ts](../packages/paperclip-runner/src/drivers/acpx/model-verification.ts), [provider-mode.ts](../packages/paperclip-runner/src/drivers/acpx/provider-mode.ts), [recovery-identity.ts](../packages/paperclip-runner/src/drivers/acpx/recovery-identity.ts) |
| TypeScript/Rust sidecar boundary | [sidecar schema](../packages/paperclip-runner/protocol/provider-schemas/acpx-sidecar.schema.json), [sidecar-protocol.ts](../packages/paperclip-runner/src/drivers/acpx/sidecar-protocol.ts), [sidecar CLI](../packages/paperclip-runner/src/cli/), [Rust core](../packages/paperclip-runner/runner/crates/runner-core/src/) |
| Release identity | [acpx-profiles.json](../packages/paperclip-runner/acpx-profiles.json), [profile generator](../packages/paperclip-runner/scripts/generate-acpx-profiles.mjs), [qualified-profiles.ts](../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.ts) |
| Server admission, permissions, finalization, recovery | [native-runtime services](../server/src/services/native-runtime/), including `acpx-qualification.ts`, `native-interaction-bridge.ts`, `native-run-finalizer.ts`, and `native-plan-wait-receipts.ts` |
| Product selection and setup | [shared agent runner](../packages/shared/src/agent-runner.ts), [Runner UI adapter](../ui/src/adapters/paperclip-runner/), [runtime CLI](../cli/src/commands/runtime.ts) |
| Packaging and image contents | [runner scripts](../packages/paperclip-runner/scripts/), [remote pack admission](../server/src/services/native-runtime/remote-provider-pack.ts), [Daytona image identity](../tests/runner-e2e/daytona-image-content.ts) |
| Product acceptance | [runner-e2e](../tests/runner-e2e/README.md), [fixtures](../tests/runner-e2e/FIXTURES.md), [security](../tests/runner-e2e/SECURITY.md) |

These are discovery anchors, not an exhaustive edit checklist. Search from the
actual field or capability to find its callers, serializers, snapshots, tests,
UI, and packaging. Some historical filenames still say `codex` while carrying
shared ACPX behavior. Do not infer ownership solely from a filename.

Keep business authority in Paperclip: company access, task ownership, approval
policy, budget stops, semantic action acceptance, and final task state. Keep
provider protocol translation, native mode names, CLI flags, credentials, and
version-specific quirks in provider code. The runner owns process supervision,
bounded transport, replay, and normalized events. The UI presents durable facts.

Do not add native method names or vendor-specific mode enums throughout shared
Rust/controller logic. Translate a native plan callback into a generic,
identity-bound runtime request; let generic finalization consume its proof. A
generic field name alone is insufficient if shared code still switches on one
provider's semantics.

## 4. Investigate the real harness

### 4.1 Establish a versioned research dossier

Gather official documentation, source or shipped implementation, protocol
schemas, release notes, actual `--help`/version output, and wire observations.
Record exact versions and the date. Label each statement as documented,
source-observed, credential-free observed, authenticated observed, or unverified.

For ACP, start from the [protocol overview](https://agentclientprotocol.com/protocol/v1/overview),
then the provider implementation. Cursor's official entry point is
[`agent acp` over stdio JSON-RPC](https://cursor.com/docs/cli/acp).
The [Pi ACP wrapper repository](https://github.com/svkozak/pi-acp) is a distinct
layer from Pi itself. These references identify where to investigate; current
web documentation does not qualify a pinned historical executable.

A schema accepting a method is not proof the harness implements it. A documented
method is not proof the account/model/mode exposes it. Successful initialization
is not proof instructions or credentials reach a billable turn.

### 4.2 Inventory each capability across the whole chain

For every row, record **native harness → transport/wrapper → runner normalization
→ controller persistence → UI/action surface → evidence**. Use Codex app-server's
richness as a comparison checklist, not as permission to invent native features.

Cover:

- Initialization, version negotiation, authentication, entitlement, and model discovery.
- Exact model selection and acknowledgment; native mode and reasoning settings.
- Instructions, assigned skills, MCP/tool discovery, and refreshed configuration.
- Assistant text, reasoning visibility policy, message boundaries, and terminal output.
- Tool start/input deltas/results/errors, commands, validation receipts, and background work.
- Native questions, semantic questions, permission requests, and plan decisions.
- Streaming plans/todos, revisions, cancellation, and accepted-plan behavior.
- Steering during an active turn, queued follow-ups, interruption, and replacement.
- New/load/resume/history/fork, compaction, replay, and state restoration.
- Child/subagent identity, parent relationships, child activity and supported interactions.
- File edits, diffs, images, attachments, artifacts, and inbound media.
- Usage, cached tokens, retries, subagent usage, cost provenance, and subscription limits.
- Idle behavior, autonomous retry/cache warming, shutdown, EOF, and process cleanup.
- Config/command discovery and useful native events that Paperclip does not yet display.

For every partial or dropped field, name the field, loss boundary, impact,
reason, and next action. “ACP does not support it” is too broad if the wrapper
dropped an available native event. Equally, defensive parsing code is not a
supported user feature until an actual native request has been observed and
resolved through the product.

### 4.3 Probe the consequential assumptions first

Use short, controlled probes with explicit cleanup. Before buying a campaign,
prove initialization, exact model acknowledgment, instruction delivery, semantic
tool discovery, one real tool result, permission denial, cancellation, and clean
settlement. Exercise the installed dependency whenever the assumption belongs
to that dependency.

Historical examples explain why:

- Cursor's pinned ACP path ignored the assumed system-prompt field. Transport
  success did not prove governance instructions reached the model.
- Native Cursor question documentation did not establish that the selected
  account/model/mode would emit the callback. Semantic questions remained a
  separate, supported path.
- Pi 1.0 changed RPC delta shapes. A wrapper written for the earlier runtime
  initialized successfully but failed on actual streamed output.
- Cursor did not reliably retire on stdin EOF. Cleanup needed an explicit,
  ownership-checked termination path.

These examples are failure patterns, not a claim about the current vendor
release. The reproducible checks are: inspect the actual create/load inputs;
observe and answer a real native callback; stream a real tool/text response
through the installed wrapper; and close stdin while watching the owned process
tree. Record the exact version and outcome for the new integration.

## 5. Build the smallest complete slice

Implement in this order unless a demonstrated dependency requires another:

1. Record the runtime version, transport choice, initial capability matrix,
   release target, first environment, and acceptance model.
2. Start the real provider through a minimal owned harness. Establish exact
   model/instruction admission and a clean stop with no product UI yet.
3. Complete one semantic tool round trip through the real wrapper/sidecar.
4. Run an actual task through Paperclip: context → file change → validation →
   artifact → accepted completion → durable Done → cleanup.
5. Add the blocking human interactions and lifecycle controls promised for
   the first environment. Exercise their failures, not only successful replies.
6. Prove normal installed-package use, then the selected remote environment.
7. Freeze a candidate and complete the remaining release-specific matrix.

Plan packaging early enough that the slice cannot depend on a developer's
checkout. Do not spend days building every platform before the first actual
task works. Do not defer permission enforcement until after the provider has
been allowed to perform uncontrolled work.

If parallel workers are authorized, give each a bounded file/responsibility
boundary and one shared integration owner. Provider research and isolated
translation can proceed independently. Serialize changes to shared schemas,
profiles, lockfiles, generated files, pack manifests, and image inputs. Share a
known prerequisite commit and integrate a concrete snapshot. Do not build an
unbounded chain of fix branches whose combined passing state exists only in
someone's worktree.

## 6. Implement admission and configuration

### 6.1 Separate executable identity from model choice

Pin the implementation you intend to ship: runtime package/version, wrapper,
patches, native distribution closure, and protocol contract. Keep those facts
independent from the model used in acceptance tests.

For ACPX, `acpx-profiles.json` owns release declarations. Generate the language
representations instead of maintaining handwritten TypeScript/Rust tuples:

```sh
pnpm --filter @paperclipai/paperclip-runner generate:acpx-profiles
pnpm --filter @paperclipai/paperclip-runner check:acpx-profiles
```

The existing native Runner serialized field `qualificationModel` contains the selected
model in resolved snapshots. Its name is not authority to create a model
allowlist. Preserve persisted compatibility deliberately when changing schemas.

An explicit caller-selected compatible model must travel unchanged through UI,
server, Rust, sidecar, ACPX, and provider. Discovery catalogs are suggestions.
An incomplete catalog must not block an otherwise valid model before the
provider can accept it. Provider rejection or a mismatched effective model must
fail visibly; never substitute a convenient qualification model.

Test at least these cases through the real bundled ACPX manager:

| Input/state | Expected behavior |
| --- | --- |
| Model listed in discovery | Exact selected ID acknowledged before prompt. |
| Valid explicit model absent from discovery | Forward unchanged; provider acknowledgment decides acceptance. |
| Unknown model rejected by provider | Actionable failure, no fallback, no prompt under another model. |
| Provider acknowledges a different model | Reject admission. |
| Loaded session reports a different model | Reapply and verify the selection before use, or reject if unsupported. |
| Automatic reconnect/load | Repeat admission; a prior connection's acknowledgment grants no authority. |

Generic tests should use an explicit neutral model ID. Paid fixtures record real
models. Runtime integrity tests verify actual pins. Keeping these distinct makes
an accidental product model restriction much easier to detect.

### 6.2 Carry settings through every boundary

For each new setting, trace creation, validation, serialization, launch, provider
acknowledgment, persistence, recovery, environment diagnostics, and UI readback.
Test the actual packaged sidecar decoder. Pi's thinking-level work exposed both
a rejected field and a verification call in the wrong branch after integration.

Modes and reasoning are provider-owned semantics. Shared transport can carry a
bounded opaque mode. The adapter validates supported values and verifies the
native effective value. Changing identity-relevant settings must not silently
reuse an incompatible warm session. A read-only native mode is not an OS sandbox.

Keep pending providers gated consistently across catalog, API validation,
factories, UI, test drive, Rust, and packaging. A configuration UI that offers a
provider rejected by normal startup is an unfinished integration. A test-only
admission override must never become the production installation recipe.

Pass the actual registered profile through every execution-input parser, not only
the runtime registry. Derive version types from one declaration so a new profile
cannot be admitted by one layer and rejected by another. Generators must preserve
historical identity fixtures; creating today's profile must not rewrite yesterday's
digest. Also check generated catalogs against their authoring source.

### 6.3 Qualify the ordinary setup path as its own integration

A working driver is insufficient if the form silently saves another provider,
the connection link opens a repository-login flow, or a task picker loads another
provider's models. Exercise **connect → select environment/provider/model → save
→ reopen → Test → run → reconnect/revoke** through the ordinary product surfaces.
Include both agent configuration and task-level model selection where supported.

| Setup boundary | Required proof |
| --- | --- |
| Connection purpose | Runtime authentication is distinct from repository/MCP access, even when both use the same vendor catalog entry. Correct method survives navigation and reconnect. |
| Ownership and grants | New personal connections do not acquire company-wide grants accidentally. Shared access follows existing explicit policy; reconnect preserves grants and revocation removes access. |
| Database admission | Inspect CHECK constraints and defaults as well as TypeScript enums. A text column may still reject the new provider. Test a fresh database and upgrade/reapplication through the maintained migration workflow. |
| Metadata probe | Uses the bound account and selected execution environment, sends no model prompt, distinguishes auth/entitlement/model/install failures, and retires its process or sandbox. |
| Environment routing | Remote discovery and Test use the production plugin/worker/lease services. Global managed-sandbox settings cannot silently replace an explicit target, and a controller-local probe cannot qualify a remote installation. |
| API parity | Direct API creation with missing or invalid bindings follows the same authority policy as the UI. Any allowed default-account resolution uses the responsible user's authorized connection, never ambient credentials. |
| Model cache | Cache identity and invalidation include relevant account, grant/reconnect state, environment, and provider. Reconnect fetches fresh choices; it must not silently change a saved explicit model. |
| Permissions | Model discovery enforces connection access without unnecessarily requiring unrelated agent-configuration privileges from an otherwise authorized task user. |

These checks establish correct routing and authority. They do not turn a discovery
list into a model allowlist: explicit compatible models still follow section 6.1.

## 7. Deliver instructions, tools, and credentials

### 7.1 Prove instruction delivery at the native boundary

Trace composed governance instructions, custom entry instructions, agent-home
references, and skills into the native request/session context. Confirm precedence,
byte limits, empty-content semantics, and both create/load behavior.

Prefer an authenticated or otherwise verifiable native acknowledgment. If an
owned patch adds one, bind the exact content digest and length to the originating
request, session, and connection. Reject missing/mismatched acknowledgments
before prompt bytes are sent. A passive log observer cannot authorize execution.
Then run a live behavior test; an exact byte receipt proves delivery, not that
the model followed the instructions.

Avoid fixing instruction delivery by repeatedly prepending instructions to user
messages. Respect native instruction layering and keep the user's task distinct.
Place skills/extensions in owned locations, outside the project checkout. Verify
that unassigned ambient extensions, hooks, MCP servers, and user configuration
cannot replace the managed context.

### 7.2 Bridge tools with the correct authority

Trace assigned MCP tools and Paperclip semantic actions from current company/run
authority through discovery and invocation. The provider receives only the
scoped tool bridge and explicitly granted credentials. Do not give the native
runner a broad control-plane credential to simplify integration.

Distinguish native tools, Paperclip semantic tools, and assigned external tools.
Verify discovery, schema, invocation, result, and accepted control-plane mutation
separately. Inspect the schema actually sent to the model: a validator may accept
a schema that presents required fields poorly to a real model. Preserve runtime
validation when improving the presented schema.

Test revoked/wrong-company access, stale run identity, malformed arguments,
duplicate delivery, and denied mutations. Display events must not mint approvals,
register artifacts, or claim successful semantic completion. A successful MCP
transport response is not automatically an accepted product action.

An empty object can be complete valid input to a zero-argument tool. Distinguish
missing input, an initial streaming placeholder, and terminal `{}` using the
actual native lifecycle; a generic nonempty-object guard can erase valid context
reads. Preserve the originating request and normalized input through result
delivery. Commit a successful semantic receipt only after the receiver accepts
the normalized response. Test rejection, oversized/truncated output, changed
arguments, stale responses, and duplicate delivery independently.

Teach tool use from the catalog actually exposed to the model. A dedicated context
tool is not an HTTP route to discover through a generic API-search tool. In tests,
publish a prerequisite file or instruction before asking the model to read it;
waiting for an action that itself depends on that file creates a fixture deadlock.

### 7.3 Make credential selection explicit

Use company secret bindings or the product's selected managed connection.
Isolate provider HOME/XDG/config/cache directories as appropriate; do not borrow
ambient developer login as production proof. Enumerate credential forwarding by
provider and explicit run environment. Redact secrets from logs, prompts,
snapshots, session files, evidence, and public reports.

For custom provider configuration, validate references and reject executable
credential commands unless the product explicitly supports that authority.
Recovery must bind relevant credential/configuration identity without persisting
secret values. Configuration changes apply according to an explicit refresh or
restart contract; test that subsequent turns do not retain stale bindings.

Enumerate all native credential aliases and clear unselected ones before launch.
For example, a vendor's generic CLI token variables can override a dedicated
runtime binding. Test with a conflicting ambient credential and prove the selected
connection remains authoritative. Test redaction after flattening/nesting too:
an innocuous leaf such as `credentials.endpoint` must retain its sensitive-parent
classification through normalization, display projection, and diagnostic output.

Keep authentication failures separate from missing runtime assets, unavailable
models, account entitlement, and policy denial. A provider error rendered as
ordinary assistant text must not become a successful task. Prefer typed errors
from the provider boundary over prose matching.

## 8. Preserve events and rich capabilities

Define normalization against the closed canonical event inventory. Preserve
stable session, turn, message, tool, request, and child identities; validate
native payloads as untrusted data. Bound payload size, queues, diagnostics, and
replay. Unknown metadata is not permission to execute code or mutate state.

### Message and tool fidelity

Test fragmented and interleaved text/tool deltas, final-only messages, empty
chunks, retries, compaction, native errors, aborted turns, and replay after load.
Retain distinctions between progress, reasoning, tool output, and final reply.
Correlate streamed blocks with final native receipts without fabricating deltas
the provider never emitted. Preserve original tool arguments and terminal error
state where the canonical contract supports them.

Decode stdout as a byte stream with a stateful UTF-8 decoder before JSON-line
parsing. Decoding each chunk independently can corrupt a multibyte character
split between reads. Cover the real probe, launcher, and transport readers with
split-character and fragmented-line cases, including incomplete terminal bytes.

Identity tests must include numeric request ID zero, unusual characters, long
IDs, and events arriving before or after the associated callback. Apply one
documented normalization at each boundary. Do not compare native IDs directly
with a later opaque/hash representation. Names, titles, and textual similarity
cannot substitute for event identity.

### Plans, children, and artifacts

Keep a progress checklist separate from a plan requiring approval. Preserve todo
merge/replace semantics and revision identity. Attribute child activity to the
declared child and parent; do not flatten a child answer into the main response.
If raw child details cannot be shown, make the partial projection explicit in
the capability report.

Provider-reported artifact paths are references. Validate containment, regular
file type, symlink behavior, and permitted roots at ingestion time. Registration,
upload, permissions, download, and copy-back are separate steps. A generated-image
notification does not prove a usable image was delivered. Compare downloaded
bytes with an independent expected result.

Inbound media is a separate capability from artifact output. A provider's
advertised image support does not prove Paperclip's text-only turn path forwards
attachments. Do not expose an affordance until the complete conversion path exists.

### Usage and costs

Identify whether values are per message, per turn, cumulative, retried, or
inclusive of children/cache. Deduplicate by native receipt identity and verified
semantics, not by whether two numbers happen to match. Keep token observations,
estimated prices, provider billing receipts, and account-level spending bounds
distinct. Unknown values remain unknown; absent usage is not zero cost.

When the provider cannot supply usable accounting, explicitly decide whether that
blocks this release. If it is deferred, the product must not claim an enforceable
per-run dollar budget from partial counters. An authorized account cap can bound
a qualification campaign without proving per-task cost. Decide accounting for
this integration explicitly; another provider's exclusions do not carry over.

## 9. Make human interactions durable

Implement a complete round trip, not just a card renderer:

```text
native request
  -> validate active connection/session/turn + native request identity
  -> persist canonical pending interaction
  -> render the complete request in the browser
  -> validate human choice and exact displayed revision
  -> persist the decision
  -> deliver the exact native response to the still-authorized request
  -> observe delivery acknowledgment
  -> settle the interaction and continue or cancel work
```

Persist before presentation. A browser response, a queued write, a pipe flush,
native receipt, and resumed model behavior are different observations. Use the
actual transport's delivery contract and test it. Do not mark an answer consumed
merely because a callback resolved locally.

| Interaction | Required details and negative cases |
| --- | --- |
| Native question | Native question/option identity, required fields, selection cardinality, supported text/editor forms, explicit skip/cancel. Reject missing, duplicate, forged, or cross-question selections. |
| Semantic Paperclip question | Durable tool-backed product interaction; prove its continuation independently of native question support. |
| Permission | Only offered and policy-supported decisions; correlate with the exact tool operation. Denial must precede side effects. An “always” choice requires a proven scope. |
| Native plan | Complete plan, correct revision, reject with feedback, revised display, accept/cancel, exact response delivery, and defined post-accept state. Reject oversize plans instead of approving a truncated document. |
| Stale/duplicate answer | Reject wrong task/company/run/revision, late answer after Stop, repeated submission, and provider-loss answer. No second mutation or replacement run. |

Define the distinction between a successful planning run and a completed task.
For Cursor's accepted native plan, the run can succeed while the task remains
open waiting for an explicit next message. Acceptance alone must not switch mode
or silently start implementation. The controller requires correlated native
request, accepted revision, delivered response, and terminal/lifecycle evidence;
“the model said the plan was accepted” is insufficient.

Test browser reconnect and controller restart while input is pending. When the
provider is still alive, preserve the same request and deliver once. When the
provider has died, expire the request unless exact restoration is supported and
proven. Do not replay an old permission into a new session. Retaining an answered
card in history is not proof it was delivered to the native runtime.

Permission targets need canonical path handling: an OS alias such as `/tmp` and
`/private/tmp` can name the same allowed file. Resolve through the existing
containment policy and display the actual target; do not fix a false rejection
with string-prefix authorization. Keep escape, dangling-link, and replaced-root
negative cases. On provider loss, preserve the authoritative expiry event all
the way through the controller to the durable card before terminal handling.
Test questions and permissions separately: a validator that assumes every request
has a permission-shaped `method` field can reject legitimate question expiry.

## 10. Own continuity, cancellation, and settlement

### 10.1 State the continuity claim precisely

Track conversation continuity, provider process continuity, workspace continuity,
and agent-file persistence separately. A supported provider may reload a
conversation in a new process; another may require the original process to
preserve a pending native callback. A warm test must grade the promised property.

Session identity must fence relevant company/agent/task/workspace, selected model,
mode, instructions/skills/tools, executable profile, and environment. Define which
run-scoped references may refresh and which changes force a new session. Do not
copy an old agent-home path into a new run or reject every refreshed path by
accident. Test the actual snapshot handoff and readback after restart.

Recovery reads persisted facts and verifies ownership. A timeout waiting for a
connection does not prove the process is dead. A PID alone does not establish
ownership because it can be reused. Use the platform's established birth identity,
lease, and process-group checks. Keep an interrupted-but-owned process distinct
from an abandoned process or a new provider launch.

### 10.2 Keep the controls distinct

| Control | Meaning | Evidence |
| --- | --- | --- |
| Steering | Change input to the active turn without replacing it | Accepted control receipt and observable consumption in that same native turn. |
| Queued follow-up | Work intentionally delivered after the current turn settles | Queue acknowledgment, order, and exactly one later consumption. |
| Interruption/Stop | Cancel active work and retire or safely retain resources according to contract | Actual native cancellation, terminal state, pending-input invalidation, and physical cleanup. |
| New prompt after settlement | A new turn on a retained/reloaded session | New turn identity with the intended conversation continuity. |

Do not emulate steering by sending a concurrent prompt to a provider that cancels
the old prompt. Pi's native acknowledgments and settlement semantics differ from
Cursor's. Advertise unsupported controls honestly.

### 10.3 Prove terminal behavior and cleanup

Separate provider prompt completion, native background-work settlement, accepted
Paperclip result, task-state finalization, and resource retirement. Pi historically
required `agent_settled`; a partial tool JSON fragment or final-looking assistant
message cannot substitute for the native terminal boundary.

Test Stop during startup, ordinary work, a pending question/permission, and
finalization where the new integration changes those paths. Keep cancellation
available when a dependency stalls. If synchronous work blocks the event loop,
a timeout promise around it does not make it cancellable.

Verify actual processes/children, leases, temporary roots, bridges, remote
sandboxes, and database/test resources. Cleanup success in a ledger is not proof
cleanup callbacks ran. A missing process after a verified exit differs from an
unreadable live process; fail incomplete ownership evidence instead of assuming
absence. Bound the lifecycle observer and test its own races.

Test process death without first calling the cleanup function. Kill the verified
native child while its wrapper/guardian remains alive: a launcher can otherwise
keep stdout or an exit promise open indefinitely. Separately test guardian loss
without native-child loss. Use bounded termination and escalation for an owned
child that ignores Stop, including during metadata-only probes; cleanup itself
must not hang forever. Expire pending input before publishing terminal failure,
and preserve the original failure if a later metadata read also errors.

For attached commands, deliberately create the overlap being tested: hold an
owned finite child until the matching finish request is observed, then release
it through a bounded test mechanism. Require independent command exit before
accepted task completion, receiver acknowledgment, one final response, and
cleanup. A command that happened to exit before finish began does not exercise
the settlement barrier. Detached work remains unsupported unless explicitly
implemented; session-level notices cannot mint task completion or charges.

## 11. Ship an installable runtime

### 11.1 Verify the complete execution closure

A launcher hash is not enough if it loads mutable JavaScript chunks, native
addons, worker files, Node, a wrapper, or extensions. Record and verify the
complete distribution and its dependencies. Reject changed content, unexpected
links/special files, unsafe paths, ambiguous patch anchors, and stale manifests.

Owned source patches should verify the vendor input first, apply only to the
known version, and verify a separately pinned output. Keep vendor and patched
identities distinct. Disable unauthorized self-update, ambient hooks/extensions,
and background model activity where the managed runtime contract requires it.
Do not loosen production checks to get a qualification image to launch.

Use one authoritative release declaration and generated language bindings. Include
patch scripts and all runtime inputs in image content identity. Test that changing
a relevant input invalidates the derived artifact identity. Rehashing a manifest
must not make a stale provider pack compatible with a newer controller.

### 11.2 Prove ordinary installation

Exercise the actual public-package lifecycle in a clean consumer as the OS user
who will run Paperclip. Use the published-layout package/tarball path; a local
source loader, private store, borrowed `dist`, or candidate environment override
does not establish normal installation.

Pi and Cursor currently have explicit setup commands:

```sh
paperclipai runtime setup pi
paperclipai runtime setup cursor
```

These are examples, not a generic command that already supports a new provider.
Implement and document the equivalent normal setup if the new runtime needs it.
Verify installation permissions, platform selection, runtime-cache resolution,
packaged-asset precedence, startup diagnostics, upgrades, and missing/tampered
assets. Never silently fall back from an invalid packaged runtime to an ambient
user installation.

Start that proof with a clean frozen-lockfile install. Workspace-installed native
dependencies can conceal missing lock entries. Inspect the final tarball after
all build steps: a later TypeScript compile can overwrite maintained vendored
entry points with source-tree imports. Compare the packaged daemon and provider
manifest with the artifacts used by the tests. Explicit test paths can select
the right daemon while the shipping archive still contains an older one.

Remote packaging has both a worker and a controller side. Verify that the normal
controller package can locate the correct platform companion and provider-pack
manifest using production resolution, without extracting it manually from a
qualification image. Docker copy/include lists must include new declarations,
patches, and the **active** identity fixture. Bind the manifest to the directory
the loader actually consumes; a valid manifest in another directory is not proof.

For remote execution, build on an appropriate host, record an immutable OCI
digest, and verify contents through the production pack reader. Start a fresh
consumer using normal secret bindings and normal provider admission. Test the
actual networking route: loopback, outbound WSS, or authorized sandbox ingress
have different contracts. Consult [Daytona networking](architecture/paperclip-runner-daytona-networking.md).

### 11.3 Keep platform work proportional

Build and prove the development platform first, then the agreed deployment target.
Use cloud/native build infrastructure for Linux or other targets when local
emulation is slow, unavailable, or disallowed. A Rosetta startup result is useful
but must be labeled emulated startup, not native Intel live qualification.
Do not introduce physical-machine certification or additional architectures
without connecting them to an actual release promise.

Measure build, image, startup, and single-cell latency. When a feedback cycle
takes hours, identify the expensive stage and establish a shorter local or
provider-free reproduction. Keep artifacts cached by verified input identity;
do not rebuild eighteen packages after an evidence-only edit.

## 12. Test with an evidence ladder

Use the lowest-cost test that can disprove the hypothesis, then climb to the
actual promised user experience. Each level has a limited claim.

### 12.1 Match the test to the claim

| Level | System exercised | What a pass establishes | What it does not establish |
| --- | --- | --- | --- |
| Static/source inventory | Docs, implementation, declarations | A plausible mapping and explicit gaps | Actual runtime behavior |
| Deterministic contracts | Parsers, reducers, identity/policy/recovery state | Exact normalization and negative boundaries | Real dependency behavior removed by mocks |
| Real dependency with controlled peer | Installed SDK/wrapper/sidecar and synthetic native peer | Wire shape, model pass-through, delivery/ordering, decoding | Model instruction following or provider service behavior |
| Packaged credential-free smoke | Clean install, real binary, initialization/stop | Packaging, platform launch, integrity, cleanup | Authenticated tools, model access, task completion |
| Runner protocol exercise | Real runner/provider, seeded mock control plane | Bounded semantic/protocol behavior | Production DB/UI, real third-party mutation, or remote deployment |
| Product E2E | Real browser/server/DB/runner/provider, selected environment | The selected user workflow and independent outcome | Unselected environments, models, or later binaries |
| Installed canary | Normal installation and ordinary repeated work | Usability of the proposed delivery path | Universal reliability or indefinite operation |

### 12.2 Author reproducible tests in this repository

The following path uses source and fixtures shipped in this checkout. No previous
campaign, private eval definitions, or personal account history is needed. Provider
credentials and infrastructure are needed only for the explicitly selected live
steps. Author new cases alongside the maintained test families instead of building
a one-off qualification system.

**Provider and transport contracts:** use
[`packages/paperclip-runner/test/`](../packages/paperclip-runner/test/) and the
co-located driver tests. For example, the
[installed ACPX model-selection test](../packages/paperclip-runner/test/acpx-model-selection-package-contract.test.mjs)
loads the actual installed manager and replaces only the provider process with
a controlled peer. Its advertised model list omits the requested model; the
peer records the exact selection and can accept, reject, or acknowledge a
different model. This catches restrictions inside the dependency that mocking
the manager would hide. Add new provider cases through the same boundary.

Cover at least the fragile contracts the new implementation introduces:

- Exact model pass-through, rejection, mismatch, missing acknowledgment, and
  replay after load. No prompt may cross an inadmissible selection.
- Exact instruction content on create and load, including empty input, missing
  proof, mismatched digest/length, and an acknowledgment for the wrong request.
- Native IDs including zero, repeated IDs in a new session, and out-of-order
  callback/tool announcements. Verify the full wrapper/sidecar/decoder path.
- Durable answer delivery, one authorized effect on duplicate submission,
  invalid/stale answers, cancellation during delivery, and provider loss.
- Process shutdown with pending work, child cleanup, late callbacks, and asset
  integrity failures. Assert the intended native boundary was reached.

Use the existing [mock control plane](../packages/paperclip-runner/src/mock-core/)
and [conformance suite](../packages/paperclip-runner/src/conformance/) when a
semantic/protocol check needs Runner plus a controlled server peer. Label synthetic
provider responses as synthetic. A deterministic pass cannot qualify model
behavior. Any additional live protocol campaign is a separate evidence family;
it cannot replace the full product workflow or imply access to archived results.

**Product E2E cases:** the maintained entry points are
[`catalog.ts`](../tests/runner-e2e/catalog.ts),
[`fixture-registry.ts`](../tests/runner-e2e/fixture-registry.ts), and the nearest
case/flow, matcher, result validator, and report test. Follow this sequence:

1. Register a **native-generation** profile for the new provider, using its
   production declaration and a separately explicit acceptance model. Store
   credential binding references, never credential values, in fixture data.
2. Select existing environments and relevant journeys. Add a case only when a
   promised behavior lacks an independent oracle; keep one durable purpose per
   suite. Record expected turns, deadline, spending bound, and cleanup obligations.
3. Make setup create an isolated company, workspace, agent, and secrets through
   supported APIs. Execute the graded action through ordinary browser/API
   surfaces. Avoid direct database writes and test-only provider shortcuts.
4. Define an expected result independently of the model. For a file task, generate
   a nonce, specify exact bytes, require native edit/read or validation receipts,
   retrieve the actual delivered file, and compare bytes. A fresh follow-up task
   must read persisted state without receiving its expected content in the prompt.
5. For human decisions, wait for an actual native/semantic request, act through
   the browser, reload, and verify one correlated continuation or denial. For
   Stop, observe real pending work first and watch for prohibited effects until
   physical cleanup. Test timeout/provider death/stale answer as applicable.
6. Calibrate each new grader with a valid result and a plausible wrong result:
   missing/extra newline, wrong agent/run/path, truncated receipt, duplicate
   completion, missing artifact, or surviving process. Missing evidence must fail
   or remain inconclusive; it must never satisfy a positive assertion.
7. Register the case, selectors, fingerprints, evidence writer, and report output
   together. Make changes to prompts, fixtures, graders, or runtime identity visible
   in the definition digest. Confirm catalog discovery before a paid run.
8. Retain sanitized reproducible inputs, exact versions, independent expected and
   actual observations, original grade, cleanup, and cost coverage. Include enough
   in the review for another contributor to assess the claim without a private
   dashboard. Keep secrets and raw sensitive traces outside the shareable record.

The [fixture guide](../tests/runner-e2e/FIXTURES.md) and
[test security contract](../tests/runner-e2e/SECURITY.md) describe current runner
mechanics and evidence handling. The acceptance criteria in section 13 are
complete even when a contributor has no access to earlier campaigns.

### 12.3 Run selected checks, then the agreed live cells

Start with targeted checks. Existing command entry points include:

```sh
pnpm --filter @paperclipai/paperclip-runner check:acpx-profiles
pnpm --filter @paperclipai/paperclip-runner typecheck
pnpm --filter @paperclipai/paperclip-runner check:runner
pnpm test:e2e:runner:typecheck
pnpm test:e2e:runner:unit
pnpm test:e2e:runner -- --list
```

Run only the relevant layers while iterating. `check:runner` includes Rust and
protocol/replay checks; it is not a paid acceptance campaign. Inspect package
scripts at the selected revision before relying on a command name.

List precise cells before spending:

```sh
pnpm test:e2e:runner -- --list --profile runner-acpx-pi
pnpm test:e2e:runner -- --list --profile runner-acpx-cursor
```

Replace those example profiles with the registered new profile. Choose an exact
ID returned by the catalog and use `--id` for a billable run. The runtime version,
credentials, budget, environment, and image prerequisites must already be satisfied.
`--all` excludes explicit-only suites; its green result cannot imply their coverage.

Use the repository's existing catalog, result validator, classifier, and report
pipeline. Keep protocol-only outcomes separate from Product E2E outcomes in the
ledger. If a separate campaign is explicitly part of the release contract, its
inputs and required evidence must be available to the people executing and
reviewing that contract; an inaccessible historical campaign is not a prerequisite
or substitute for new proof.

For an implementation PR-ready handoff, complete the repository-required checks:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

Run token gates for UI changes and applicable runner/package checks. If maps or
stories change, update their owning annotations/entries and run their generators.
Report omitted, interrupted, failed, and isolated-repeat checks accurately.
Do not convert an incomplete full run into a full pass because focused tests pass.

## 13. Run the product acceptance matrix

Select the applicable rows for every promised environment. Mark genuinely
unsupported native features as such before the campaign. The core daily-work,
authority, completion, and cleanup invariants remain mandatory.

| Journey | Action | Independent acceptance evidence |
| --- | --- | --- |
| Normal setup | Install/configure from the ordinary product entry point | Saved provider/model/environment/secret references; real runtime discovered; no candidate override. |
| Task completion | Assign a concrete task and let the harness finish it | Actual provider identity, accepted semantic completion, correct durable task/run state, visible final reply after reload. |
| File/edit/validate/deliver | Create and edit a file, run a specified validation, publish it | Native tool receipts, independent expected bytes, exit/validation evidence, registered download, user can open/use the result. |
| Instructions and skills | Require a behavior from assigned instructions/skill | Native input binding plus observed requested behavior; no hidden test-only instruction that makes the case pass. |
| Questions | Ask, answer in browser, continue | Correct fields/options, exact persisted answer, native delivery, exactly one continuation. Test semantic and native forms separately. |
| Plans | Reject, revise, accept/cancel | Complete displayed revision, correlated delivery, correct post-plan state; no implicit implementation if contract waits for a message. |
| Permission denial | Attempt a controlled marker write under restrictive policy | Real request surfaced; denial delivered; marker remains absent through terminal cleanup; no automatic replay. |
| Pending input + controller restart | Restart after a real request exists, then answer | Same authorized native run/request where supported; one delivery, no duplicate card/result or replacement task. |
| Provider death | Kill the exact owned provider while input waits | Original request expires; stale response rejected; no silently replayed mutation or unsupported restoration claim. |
| Stop | Stop while real work or native permission is pending | Cancel reaches actual native request/process; terminal state and physical cleanup; late responses cannot revive work. |
| Warm follow-ups | Complete three turns on the intended workspace/session | Ordered outputs, no duplicates, selected model/mode retained, explicit conversation/process continuity evidence. |
| Steering and queueing | Steer active work or queue another request where supported | Native acceptance and actual consumption/order; same-turn versus later-turn identity verified. |
| Agent files/memory | Write, restart, read in a fresh task, attempt cross-root access | Exact persisted bytes and scope; fresh task does not receive the expected content in its prompt; cross-root access denied. |
| Failure presentation | Missing assets/key, wrong model, entitlement or provider failure | Specific actionable error, no false success/fallback, no leaked secret or retry storm. |
| Accounting/budget, when promised | Observe measured usage and trigger relevant limit | Verified receipt semantics, deduplication, honest unknowns, actual stop behavior at the supported enforcement boundary. |
| Legacy compatibility | Run the existing direct adapter | Existing behavior remains; no native process, transport, or native-state side effects. |

A database assertion alone is not a browser journey. A screenshot alone is not
an artifact or permission proof. A model's “I tested it” message is not a
validation receipt. A task marked Done with an empty or inaccessible artifact
is not a successful delivery.

Use independent expected values, nonce files, durable receipts, and ordinary
browser controls. Explicit test setup may seed a fixture through supported APIs;
the action being graded must traverse the promised user path. Reload the product
and download the artifact. For interactive output, actually exercise it—for
example, click a generated counter and verify its behavior.

Keep UI assertions consistent with the product. Fix brittle selectors or incorrect
path assumptions without weakening the intended behavioral oracle. The real test
must reach the boundary it claims to test before its result can qualify that
boundary. A Stop test that never saw a pending permission is inconclusive for
pending-permission cancellation even if the final run is cancelled.

### Make the observer prove the intended sequence

Capture native event origin when it arrives, before asynchronous persistence or
receipt processing can reorder its visible projection. A delayed context-read
notice cannot prove context-before-action merely from its later publication time.
Correlate each receipt by kind and invocation; a valid context receipt plus a
finish receipt must not fail a grader that accidentally assumes one total receipt.

Bind browser assertions to the stable task ID returned by the creation action,
not a model-editable title. Poll for a complete identity-correlated permission
and tool pair; the first partial notice is not enough. Keep observation latency
below the pending-input window—serial slow API reads can consume the window
before the test sends Stop. Preserve deadlines and assertions while fixing the
observer; do not relabel a missed window as exercised cancellation.

Branch the oracle by the observed lifecycle. An active-permission Stop requires
native cancel delivery. A denied turn that already settled cannot dispatch to a
live provider; require its prior settlement, no-effect evidence, and valid server
acknowledgment instead. Do not broadly accept `blocked` or any terminal state.
Local controller PID checks cannot substitute for remote lease, boot/start, and
process-group identity. Merge observed group members without losing a surviving
parent when a short-lived child exits; changing API timestamps are not process births.

## 14. Diagnose failures before another paid attempt

### 14.1 Freeze the failed attempt

Preserve the original grade, source/build/image/model identities, timeline,
native receipts, browser/server state, expected/actual artifacts, cost coverage,
and cleanup result. Record whether the target boundary was reached. A new grader
or offline replay is additional evidence; it does not erase the original attempt.

Use the evaluation guide's classes: product defect, model/provider behavior,
grading/evidence defect, or infrastructure. Record observed failure separately
from inferred cause and confidence. A timeout is a symptom, not a classification.

### 14.2 Find the first divergence

Compare the same identity across the chain:

```text
user request / fixture expectation
 -> native model input and available tool schema
 -> native model tool arguments
 -> wrapper and sidecar output
 -> canonical event / semantic request
 -> accepted control-plane effect
 -> persisted bytes / interaction / task state
 -> browser presentation and grader
 -> process and resource cleanup
```

Examples:

| Symptom | First discriminating check | Appropriate next action |
| --- | --- | --- |
| Valid model rejected | Did the provider receive the requested ID? | Exercise the real dependency's catalog/selection path; remove a wrapper restriction if that is the failing boundary. |
| Required newline missing | Did native write arguments contain the newline? Do stored bytes match? | If the model omitted it, preserve the behavior failure. If transport/storage removed it, fix that boundary with exact-byte regression. |
| Question card answered, run stuck | Was the response durably accepted and delivered to the same live request? | Inspect connection/request identity and delivery receipt; test controller restart with the real dependency. |
| Plan accepted, task fails | Did the accepted tool lifecycle arrive after the callback? Was identity preserved? | Repair correlation/settlement, preserving unrelated-tool rejection and correct waiting state. |
| Agent says complete, task open | Was an accepted semantic completion result produced for this turn? | Inspect authority, contract revision, tool delivery, and terminal event; do not mark Done from prose. |
| Tool JSON complete, no result | Did the provider stream actually finish? | Reproduce unfinished streaming with the real wrapper; do not execute partial input or weaken terminal guards. |
| “No space left” on DB startup | Disk exhaustion or OS IPC/semaphore exhaustion? | Inspect the actual resource; clean only owned/stale resources with proper authority. |
| Cleanup observer failed | Process alive, unreadable, identity drift, or raced with verified exit? | Repair and calibrate the observer; no blanket success on read errors. |
| Works from source, fails installed | Missing package, wrong pin, dynamic import, permissions, or borrowed files? | Reproduce in clean public-layout consumer and fix packaging. |

### 14.3 Prove a correction cheaply

Write the smallest meaningful regression at the owning boundary. Use a real SDK,
installed wrapper, or process when mocking it would remove the defect. Calibrate
an evidence/grader repair on both a valid outcome and a plausible wrong outcome.
Keep denial, stale-input, and no-effect controls intact.

Then rerun the affected paid cell under existing authority, with a new attempt ID
and the correction recorded. Do not loop on unchanged paid failures. Broaden the
rerun only when changed shared behavior or remaining uncertainty warrants it.

If the model cannot reliably perform a required behavior, state that result.
Changing the acceptance model can be a useful decision; it is not a runtime fix
or evidence that the first model passed. Obtain a decision if the model was
explicitly frozen. Similarly, do not drop exact-byte checks simply because a
model repeatedly misses them.

## 15. Keep qualification finite and reproducible

### 15.1 Freeze a candidate, not the entire development process

After the thin slice, normal installation, architecture review, and deterministic
checks pass, record one candidate: application commit, runner/profile/wrapper
identity, lock/dependency state, package hashes, image digest, model/mode, test
definition revision, and grader revision. Keep shipping source separate from
harness/fixture source when they differ.

Do not combine passing cells from unrelated profiles into “all green.” Do not
discard useful historical evidence whenever a report changes either. Use a
change-impact record:

| Change | Evidence impact |
| --- | --- |
| Prose/report-only edit | Preserve measurements; validate report/links. No provider call or runtime rebuild solely for presentation. |
| Fixture/grader correction | Preserve failed attempt and grade; calibrate the new oracle and rerun affected live behavior. |
| Provider adapter/wrapper/native patch | New relevant runtime identity; rebuild affected artifacts and rerun impacted native/product paths. |
| Shared protocol/recovery/instruction path | Identify every affected provider and persisted state; run parity and targeted cross-provider regressions plus impacted live gates. |
| Packaging/image-input change | Rebuild affected artifacts and repeat clean install/startup; assess behavioral impact explicitly. |
| Model/mode change | New behavioral qualification identity; old model results remain historical. |
| Mainline reconciliation | Inspect semantic differences, preserve newer invariants, and document what was retested; never assume a conflict-free merge is behavior-neutral. |

Some changes justify a full campaign; others justify a narrow proof plus retained
earlier evidence. The release decision must name that distinction. A source-level
argument that a dependency patch does not change interaction behavior is not a
fresh paid test of the rebuilt package.

### 15.2 Keep an operational ledger

For every live process/job record its actual handle, owner, candidate, selected
cell, start time, expected next observation, deadline, budget reservation, and
cleanup obligation. Reobserve that handle after compaction or connection loss.
Do not restart a job merely because the observation tool timed out. Retire
superseded builds explicitly so they cannot later be mistaken for the candidate.

Keep accepted passes, preserved failed attempts, unattempted gates, blocked gates,
and deferred capabilities separate. Budget accounting includes retries,
infrastructure, and paid review where applicable. Separate measured spend from
reservations and unknowns; a reservation is not a charge.

Persist the resumable campaign record outside temporary directories before a
long pause: candidate manifests, retained grades, sanitized evidence, budget
window/reservations, job handles, outstanding gates, and cleanup obligations.
Store credentials in the supported secret store and record only references.
After interruption, recover this record and inspect existing jobs before running
anything paid. Missing history does not reset a budget, and organization-wide
usage totals do not establish this campaign's spend. Treat unverifiable old
results as reported history, not newly recovered proof.

Report counts by state: for example, **1 passed, 0 failed, 19 unattempted of 20**,
rather than an ambiguous “1/20 passes.” Keep setup-blocked, boundary-not-reached,
failed assertions, and cleanup failures visible. Distinguish the qualified
runtime, local source, published PR head, mergeable candidate, and shipped build.

Reuse authorization already granted. If an actual approval system rejects an
action, record the precise action and stated reason, prepare the bounded remedy,
and continue independent work. Do not infer that all testing needs fresh consent.
Do not broaden a specific “no CI workflow edits” restriction into “no fixture
repairs”; resolve ambiguity against the actual instruction and scope.

When an actual policy gate binds authorization to exact bytes, finish the artifact
and record its destination and digest before asking. Distinguish source upload,
build execution, image publication, and secret transfer; permission for one is not
evidence of permission for all. Retire superseded requests so a late response
cannot publish an obsolete candidate. Reuse approvals wherever they still apply;
do not invent a digest-specific approval requirement where no policy imposes one.

### 15.3 Detect drift while there is still time to correct it

At a failed paid case, changed candidate, or long build cycle, answer:

1. Which required user outcome is still unproven?
2. What evidence changed since the previous checkpoint?
3. What is the cheapest next observation that can change the decision?
4. Is the current work on that path, or did an optional capability/platform
   become a gate without a deliberate decision?
5. Are we testing the same shipping bytes we intend to deliver?

If progress has become repeated status reports, reworded goals, or rebuilds
without resolving a user outcome, stop expanding the checklist and repair the
execution plan. An autonomous continuation should execute the active objective,
not keep handing the user another prompt to start it. Report the next concrete
action and the real blocker when one exists.

Settle known mainline conflicts and the review dependency graph before the
expensive final campaign. If PRs are split, each layer must include its own
required fixtures/installers and build from a clean checkout against its declared
base. Port by behavior and current ownership: a refactor may move instruction
refresh into a new module that an old provider-list patch never touches. Check
fresh migrations, historical snapshots, and other providers' release identities.
Keep provider-only composition out of shared identity inputs when it needlessly
invalidates another provider's qualification.

Once frozen, reconcile again for a concrete merge requirement or demonstrated
release-relevant change, and assess the exact impact before rebuilding. Unrelated
upstream activity alone is not a reason to restart the entire campaign. Identify
required human review early, but continue the remaining qualification without
asking the user to coordinate a final handoff that is not yet ready.

## 16. Review, release, and operate

Perform architecture review before the expensive acceptance campaign. Specifically
search for vendor names in shared contracts, duplicated pins/model policies,
test-only setup in production paths, hidden catalog restrictions, and broad
exceptions to recovery or permissions. Review the actual installed dependency
where a critical assumption crosses it.

Before handoff, establish all of the following:

- The agreed user journeys pass with inspectable evidence and explicit limits.
- Normal setup works from clean packages; the selected remote image is immutable.
- User-visible configuration, diagnostics, secrets, tools, docs, and capability
  claims agree with admission and actual behavior.
- Legacy paths remain intact; persisted historical records remain readable.
- Required tests/build/typecheck, token gates, relevant maps/stories, and PR checks
  are accounted for. The PR uses every required template section.
- Failed attempts retain their grades and diagnoses. Review score, CI green,
  functional acceptance, and release authorization are reported separately.
- Supported models remain caller-selected; qualification examples are labeled.
- Accounting limitations and unavailable richness are visible and actionable.
- Rollout and rollback address fresh admission, already-running sessions, stored
  interactions, task history, artifact access, and recovery.
- A short operator recipe makes the result immediately usable.

Use the existing release workflow for publishing packages/images and deployment.
Merge, publish, deploy, and canary are separate actions even when automation
connects them. If merging deploys automatically, include deployment readiness in
the merge decision. Do not treat an old branch's green CI as the final merged
candidate's proof. Resolve conflicts without replacing newer shared files wholesale.

A good operator recipe says where execution occurs, how authentication is selected,
how to start a task, where files/results appear, how to Stop, how to restart, and
what remains unsupported. “Cursor on the Mac calling Cursor's service” differs
from “a Cursor Cloud Agent VM.” “A test instance is ready” differs from “this
instance completed a real authenticated task.” Make those facts explicit.

Run a bounded canary of consecutive tasks and one interruption/recovery journey
when that is part of the release target. Capture startup and first-use latency,
completion reliability, provider errors, stale interactions, duplicate output,
and cleanup. Use existing observability and run logs; classify any new data by
path under the repository's Telemetry/Observability/run-log rules. Do not send
private prompts, credentials, or reasoning into a new reporting channel.

For Paperclip issue work, upload deliverable files and register work products
before final status, following the [artifact guide](AGENT-ARTIFACTS.md). Keep raw
private evidence in its proper store; public summaries use sanitized evidence
and immutable references. A local `/tmp` directory is not a release handoff.

## 17. Lessons and remaining limits

The Pi, Cursor, and Copilot work exposed the following failure patterns. Each lesson below
includes its own corrective rule and a test condition; no historical chat, task,
readiness report, or retained private artifact is needed to apply it. These are
regression questions for a new integration, not claims that a defect persists
in the current vendor release.

| Failure pattern | Reusable rule | Reproducible acceptance condition |
| --- | --- | --- |
| Rich implementation and green CI left the ordinary workflow unproven | Separate implementation, qualification, and release | An operator installs, assigns, receives a verified result, and can Stop in each promised environment; record CI and product outcomes separately. |
| Vendor mode and plan semantics spread into shared lifecycle code | Translate vendor behavior at the provider boundary | Review shared contracts for vendor switches; drive equivalent generic plan/decision cases through two providers without adding native method names to controller logic. |
| Moving model restrictions into a manifest retained an unintended product allowlist | Pin runtime bytes separately from caller-selected models | A compatible model absent from discovery still reaches native selection and is accepted only on exact acknowledgment; rejection never silently falls back. |
| Mocked model tests missed the installed dependency's rejection | Mock only the boundary below the dependency being tested | Run the real manager against a peer that omits the requested model from discovery; inspect actual outgoing selection and prompt ordering. |
| A transported system-prompt field was ignored | Verify native create/load delivery before prompt admission, then behavior | Match content digest/length and request/session identity; missing or wrong proof blocks the prompt; a real task follows the assigned instruction. |
| Native callbacks preceded their associated tool announcements | Preserve identity across every decoder and event order | Exercise both orderings, native ID zero, stale revisions, duplicate answers, cancellation, and late delivery; one authorized response reaches the original native request. |
| An upstream runtime upgrade changed delta shapes while initialization still passed | Qualify wrapper compatibility through actual streamed work | Use the pinned runtime and wrapper to stream text, tool arguments, result, and terminal event; verify no truncation, duplication, or stale final text. |
| Wrong file bytes and an incorrect remote-path grader were separate failures | Trace native arguments, bytes, persistence, and grader independently | Independently compare expected bytes at each boundary; calibrate local/remote path checks with correct and wrong agent/run/path identities while preserving original grades. |
| Platform packaging expanded before a usable first slice existed | Tie each platform requirement to the release contract | Finish one authenticated task on the first environment, then clean install and agreed remote target; label build, emulated startup, and native-live proof separately. |
| Same conversation was mistaken for same-process recovery | Prove the continuity actually promised | Record session and owned process identity separately; restart the controller or kill the provider and verify supported restoration, or explicit expiry without replay. |
| Logical cancellation hid surviving work and late effects | Prove Stop at the owned process and side-effect boundaries | Stop actual pending work, watch the prohibited marker through cleanup, reject stale responses, and verify owned children retire. |
| A development checkout concealed packaging gaps | Prove the complete installed execution closure | Install a clean consumer from distributable artifacts with no source loader or ambient-runtime fallback; reject altered dependency/patch/image inputs. |
| Later runtime changes were described using earlier paid passes | Bind every result to exact candidate identity | Change an input, compute its impact, and rerun affected cells; original records retain the old digest and grade. |
| Driver tests passed while setup chose the wrong provider, account, or environment | Qualify normal setup independently of runtime execution | Save/reopen/Test/run/reconnect through the product and direct API; verify exact binding, grants, model, remote target, fresh model choices, and revocation. |
| Text-backed provider fields still had database CHECK constraints | Inspect persisted admission, not just language types | Fresh install and upgrade admit the new provider while preserving existing defaults and historical migration snapshots. |
| Cleanup hid a launcher that stayed alive after native-child death | Exercise spontaneous child loss and stubborn-child termination | Kill the owned child before cleanup, preserve durable question/permission expiry, refuse late input, and bound metadata-probe shutdown. |
| Empty-input tools and split UTF-8 were lost during normalization | Preserve protocol meaning across byte and event boundaries | Valid terminal `{}` remains distinct from missing/partial input; multibyte text survives arbitrary chunk splits; receipts require receiver acceptance. |
| A test never established command/finish overlap or missed the permission window | Make the graded concurrency observable and controlled | Hold/release a finite child around the actual finish request; correlate complete input evidence before timely Stop; keep wrong-order and no-effect controls. |
| Fresh installs and PR layers depended on invisible workspace build state | Qualify clean dependency and artifact resolution | Frozen install, standalone PR-layer checks, final tarball startup, and ordinary remote companion discovery work without borrowed `dist` or explicit qualification paths. |
| Temporary evidence disappeared while unpublished local fixes diverged from the PR | Keep resumable evidence and delivery state durable | Resume from manifests, retained grades, budget and job records; report local, published, mergeable, and shipped status separately without restarting the spending window. |

This playbook does not establish live qualification for any current binary.
Broader model/platform coverage, richer media/diff/child projections, accounting
guarantees, and future provider releases each need explicit evidence. An absent
native capability must remain visibly unsupported or have a separately described
product mechanism; it cannot inherit another provider's support label.
