# Paperclip Runner internals

Developer notes for native Runner harnesses, adapter conversion, remote runtimes, and restart recovery. To add a harness, start with [RUNNER-INTEGRATION-PLAYBOOK.md](RUNNER-INTEGRATION-PLAYBOOK.md).

## Managed Cloud runner images

Paperclip-managed Cloud sandbox images do not require a saved platform or
snapshot qualification. Discovery offers Paperclip Runner, and execution uses
the current platform-selected image even when an older qualification exists.
The real runtime startup and handshake report compatibility failures. Test goes
directly to that runtime check when discovery already offers Paperclip Runner.
Company access, adapter availability, credentials and runtime integrity checks
still apply. Self-hosted sandboxes, custom environments and active captured
custom images keep their existing qualification and snapshot binding.
The active Cloud configuration must still provision the sandbox provider; a
leftover managed marker alone does not enable this policy. Discovery reads
custom-image metadata without resolving provider credentials.
Outdated captures that no longer match the base configuration do not change
the managed runner default, consistent with execution's template selection.

## Local Linux runner qualification

Before serving requests, the server reads `getconf GNU_LIBC_VERSION` once with
an asynchronous subprocess, a one-second timeout, and a 1 KiB output limit.
Runner discovery reuses those immutable platform facts. This check does not
generate a Node diagnostic report or resolve socket hostnames.

If `getconf` is missing, fails, times out, or returns an unrecognized version,
the local libc remains unknown and automatic GNU/Linux runner selection stays
disabled. Qualified Linux targets still require GNU libc 2.39 or newer. Existing
saved execution choices remain unchanged.

## OpenCode native runtime

Paperclip Runner resolves the pinned OpenCode platform package installed with
Paperclip. On Apple Silicon and Intel Macs it runs the matching macOS binary;
on Linux x64 it runs the qualified baseline binary. No global OpenCode command
or dependency postinstall script is required. This also works when installation
scripts are disabled. The published server declares the same pinned dependency
as the source Runner package.

For native OpenCode and Cursor on Daytona, a complete installed Paperclip release
also selects its packaged Linux daemon and provider-pack identity automatically.
Use a qualified Paperclip Daytona image. For an OS-protected pack, startup
checks the selected provider interface and platform from its small manifest in
the existing runner metadata query. It does not rescan the pack or require the
same app source revision. Writable or legacy installations retain full content
verification.
The controller's operating system does not determine the remote daemon target.

Native Claude remote execution also selects the Linux x64 or ARM64 daemon and
pack identity for its actual selected host. For SSH, install that exact release's
pack at `$HOME/.local/share/paperclip-runner/provider-pack` or
`/opt/paperclip-runner/provider-pack`; the runtime discovers and verifies it.
The package's identities and the native producer archives share one source.
No development pack override is needed for this installed-host path. Other
provider qualification boundaries and the current Linux x64 image path remain.
ARM64 cloud-image production is deferred.

A plain Daytona sandbox image does not contain this provider pack. Custom images
and source-development launchers must supply a verified Linux provider pack and
daemon through the existing remote artifact overrides; see
[the remote E2E setup](../tests/runner-e2e/README.md#match-the-local-controller-package-to-the-daytona-image).
An explicit override remains authoritative and fails closed if invalid.

## Wake Context Delivery

Built-in adapters deliver wake context through the run prompt, including structured
execution-continuation data. They do not export `PAPERCLIP_WAKE_PAYLOAD_JSON`. A
large JSON environment entry can prevent the agent process from starting with
`E2BIG`, even when the same context fits in the prompt transport. Configured values
for this retired variable are ignored. Scalar runtime variables such as
`PAPERCLIP_TASK_ID` and `PAPERCLIP_WAKE_REASON` remain available.

Custom instructions that read the retired variable must use the wake payload in
the prompt instead. This transport change adds no history limits or truncation;
existing comment windows and resume-delta rendering still apply. Gateway request
bodies and Hermes prompt-template JSON variables remain supported.

This removes the duplicate environment entry, not every possible `E2BIG` cause.
Legacy CLI paths that put prompts in command-line arguments (Gemini, Grok, Kimi,
Pi, and Hermes) still have argument-size limits. ACP turns, SDK requests, and
CLI paths that use stdin avoid that separate limit for the wake prompt.

## Adding a native Runner harness

Google Antigravity's pending integration uses the official ACP server 1.4.3 with
a pinned native admission patch. `paperclipai runtime setup antigravity` installs
its verified assets on macOS ARM64 as the OS user running Paperclip. Setup does
not enable global execution: qualification remains pending and admission is
closed by default. An isolated company can use a finite trusted server-startup
candidate authorization bound to the exact model, local platform, profile and
native closure. The candidate's recorded setup and two-turn task reused the same
owner's managed personal-default Google subscription on macOS ARM64 with
`gemini-3.8-flash-low`; fresh consent and API-key live acceptance remain separate
gates. Workspace OAuth is not runtime authentication. See the
[contract, evidence, and remaining gates](plans/2026-10-28-antigravity-integration.md).

To add a harness/provider to the new native Paperclip Runner, use
[create-runner-adapter](../.agents/skills/create-runner-adapter/SKILL.md), the
[Runner integration playbook](RUNNER-INTEGRATION-PLAYBOOK.md) and its
[working templates](runner-integration-templates.md). They cover requirements,
protocol research, implementation, packaging, and real end-to-end acceptance.
Existing direct adapters remain a compatibility boundary; their authoring and
agent conversion are outside this playbook.

## Paperclip Runner Adapter Conversion

Paperclip Runner offers native Codex, OpenCode, **ACPX Claude**, **ACPX Grok Build**, and **ACPX Pi**. New
Claude Code agents default to ACPX Claude on Apple Silicon, Intel Mac, Linux x64
and Linux ARM64 with supported glibc. New OpenCode and Pi agents default to their native
runtimes on Apple Silicon, Intel Mac, and Linux x64 with supported glibc;
Linux ARM64 remains Legacy until the pinned runtimes support it.
Unsupported or unqualified targets retain Legacy. Claude over Darwin SSH keeps
an automatic Legacy default; explicit native execution
requires matching remote assets. Agent setup and configuration select the runner automatically and do not expose a runner dropdown. Ordinary Claude models default to `claude-opus-5-5`; explicit models
and provider routing remain authoritative. Existing agents keep their saved runner. Converting an existing Claude, Codex, OpenCode, or Pi agent selects its
corresponding provider, preserves compatible models, credentials, workspace,
and instructions, and resets execution sessions while retaining run history.
Grok Build uses its qualified macOS ARM64 and Linux x64 targets. Its conversion
preserves the selected model, account, and explicit reasoning effort through ACP.
Custom commands, extra arguments, legacy permission modes, search flags, and
nonzero turn limits require Legacy; conversion rejects them before saving.
Other adapters require an explicit provider choice. Legacy ACPX Codex agent
settings normalize to native Codex on configuration updates and before fresh
runs; immutable run descriptors remain readable. The **Paperclip Runner**
experimental setting applies to other native providers. Native Codex, OpenCode,
ACPX Claude, ACPX Grok Build, and ACPX Pi do not require it. Company access checks still apply.

Native Codex preserves an explicit `adapterConfig.search: false` when converting
or saving an agent. The disabled hosted-search policy is recorded in the native
execution input and launch requirements, so prepared launches and recovery keep
it. An absent setting retains the provider default; this does not add support
for converting a Legacy agent with `search: true`. Authentication hello probes
always disable hosted web search because they only verify the selected account
and model.

OpenCode requires an explicit `provider/model` before testing or finishing setup.
An inactive setup draft can be saved before choosing a model. Automatic native
selection uses `allow` permissions and leaves the lifecycle unset (see "Runner
lifecycle default" below). Native `ask` and
`deny` policies remain available in agent configuration. Legacy custom commands,
extra arguments, model variants, and inherited permission rules require the
Legacy runner; incompatible settings return remediation instead of being ignored.
Saved OpenCode agents keep their runner and runtime policies.

Plugin environment drivers can declare `requiresAgent: true` when their leases
need an agent-owned resource. The host selects that plugin's lifecycle work only for
agents on that environment. See [Required plugin work](./AGENT-LIFECYCLE.md#required-plugin-work).
Moving a ready agent to an environment that needs a new plugin automatically
pauses execution, waits for stop completion, starts the required resources, and
verifies the saved configuration before allowing work. Existing pause holds
still apply; the user does not need to pause or resume the agent for this move.
Setup saves the draft and environment, runs its
existing lifecycle preparation, and waits in `verifying` with the `setup` hold.
The worker becomes idle there until the user finishes hiring. Connection tests
use that draft's identity and a bounded Core-issued probe; ordinary tasks remain
blocked. Environment changes save immediately, preserve the selected account,
and invalidate the previous test. Tests without an agent report that prerequisite
without allocating a lease. Finishing setup still verifies the saved configuration.
Companies that require hire approval keep drafts paused and defer allocation and
verification until that approval. The wizard saves the account with a pending
verification warning instead of requiring a pre-approval computer.

Pi also requires an explicit `provider/model` before testing or hiring; inactive
setup drafts may precede model selection. Install its pinned runtime on the
execution host with `paperclipai runtime setup pi` before testing the connection.
The native default uses `approve-all` permissions, `per_turn` lifecycle, and
`low` thinking. Exact native thinking levels are `off`, `low`, `high`, and `max`.
Legacy `minimal`, `medium`, and `xhigh` thinking, custom commands/arguments, and
raw stdout mode require Legacy. Switching back to Legacy rejects native `max`
thinking, nondefault permission policy, or warm lifecycle instead of discarding
them. Existing Pi agents retain their saved runner and native policies.

Agent configuration uses the same section layout across adapters: model and
provider belong to **Adapter**, environment variables have their own section,
and command/extra arguments are folded under **Configuration → Advanced**.
Advanced is omitted when the selected adapter has no settings in that section.
Lifecycle, timeout, and interrupt grace settings live under **Advanced Run
Policy**. Permission selectors with a single valid mode are hidden; a saved
unsupported mode still exposes remediation.

Saving an existing agent compares AI connection bindings by value, independent
of PostgreSQL JSONB key order. Identity, thinking-effort and run-policy edits
avoid the connection-adoption runtime probe when the connection and execution
selection stay the same. Connection, harness, model, provider, engine and
environment changes still validate adoption. Explicit runtime tests and
required Copilot metadata checks keep their existing behavior.

Model catalogs and refresh follow the selected provider. ACPX Claude uses the
normal Claude catalog and accepts custom model IDs; the exact ID is sent to
Claude, which can reject unavailable models. Package/version verification is
independent of model selection. Environment tests verify runtime installation;
a successful provider run additionally verifies credentials and model access.

The server must install and bundle `@agentclientprotocol/claude-agent-acp`
at the qualified version, including the patched bridge and pinned SDK. The
vendor dependency check covers this dynamic lookup as well as ordinary imports.
Source builds bind the vendored runner to the workspace's pnpm store while
keeping the server manifest as its provider authority. Published npm bundles
retain the pinned SDK JavaScript and declare its native packages as server
optional dependencies, so npm installs the executable for the consumer's
platform. Runtime admission still checks the exact version and executable digest.
A missing provider package is reported as **Runtime missing**, with automatic
retries stopped. Reinstall or rebuild Paperclip with its provider dependencies,
restart the server, and run the agent's runtime test before retrying the task.
Changing the model or signing in again cannot repair a missing runtime package.

ACPX Claude uses the existing API-key and subscription connection flows,
including built-in login and credential checks. Connection setup and a successful
native task are separate checks. Thinking effort (`low`, `medium`, `high`,
`xhigh`, `max`, where supported by the selected model) travels in native input v9.
The runner requires the provider to acknowledge it before prompting and on resume.
An ignored setting or unavailable model fails admission; no runner fallback occurs.
Chrome integration, custom commands/state paths, warm-process controls,
confinement settings and turn limits require an explicit Legacy choice. Native
forms omit Legacy-only defaults. Native permissions keep their saved policy.

ACPX Claude supports Linux x64 and macOS ARM64/x64 with pinned SDK executables.
On macOS the launcher uses private verified module/executable snapshots instead
of Linux `/proc` descriptors. Dependency isolation, process ownership, and
cancellation remain enforced; the snapshot is removed when the provider exits.

Native Codex is qualified only with `codexPermissionMode: "never"`. The create
and edit surfaces do not offer `on-request` or `untrusted`, and a persisted
unsupported value fails with remediation instead of being silently coerced.

Remote native Codex prepares managed GitHub access and assigned MCP tools
concurrently after the backend claims its session scope and validates its launch
binding. Provider startup waits for both preparations. A failed preparation waits
for the other operation to settle before the existing run cleanup releases its
GitHub access. Discovery remains fresh for each run, and tool calls still use the
current gateway permissions. Local, custom-backend and other provider paths keep
their existing preparation order.
OpenCode defaults to `allow`, with explicit `ask` and `deny` options; ACPX
defaults to `approve-all`, with explicit `approve-paperclip`, `approve-reads`,
and `deny-all` options. Codex conversion keeps a non-empty model and
otherwise stores the shared `gpt-6.1-sol` default (half the `gpt-5.6-sol` token
price on the reviewed OpenAI rate card in `server/src/services/codex-pricing.ts`).
The native execution boundary applies the same default to older runner rows whose
model is missing or blank; a stored model, including `gpt-5.6-sol`, is never
rewritten. A remote Codex CLI older than 0.159.0 falls back to an older compatible
Sol model (`gpt-6-sol`, then `gpt-5.6-sol`).

For an Agent Chat test drive, configure two agents with Paperclip Runner: native Codex and ACPX Claude. Connect
the Claude account through the agent's **AI connection** section (or supply an
explicit supported provider credential); an ambient Claude CLI login alone is
not a credential source for its isolated runner home. The default
`approve-all` setting approves harness operations across assigned tools and
connections, including provider-native tools. Company permissions, approval
gates, and workspace isolation still apply. Explicit restrictive modes remain
restrictive; omitted settings use full auto.

Assigned app tools can use `paperclip_search_assigned_tools` and
`paperclip_call_assigned_tool` instead of direct tool definitions. Search with
`{"query":"github"}` and call an exact returned tool name. Omitted, empty or
whitespace-only `schemaTool` values perform normal discovery, including when
`schemaOffset` is zero. To read a large schema, set `schemaTool` to the exact
`inputSchemaRef` from discovery and follow `nextSchemaOffset`. A positive
`schemaOffset` requires a nonblank reference. Unknown or revoked references
return guidance to search again; discovery still checks current grants and work
modes against the session's pinned catalog.

Test questions, saved plan revisions, approval before task handoff, status
lookups, and `/new` preserving chat history. Hiring additionally requires the
operator-controlled [runner API tools](runner-api-tools.md) rollout; enabling
Agent Chat does not enable that API surface. Failed-turn retries restore the
selected run's user comments so the agent can answer the original request.

An unsaved Agent Chat uses an ephemeral `chat:<agent-id>` view-model ID. Task
browser polling starts after the first send or upload creates a persisted task
UUID. Saved chats retain the task browser's company and credential access checks.
Task browser routes reject malformed task IDs with `404` before querying PostgreSQL.

A native continuation that requires reconciliation shows **Recovery needed**
with **Inspect run**; inspect the original outcome before resolving its recovery
hold. A generic retry cannot resolve this incident. The runner's
`get_task_context` includes up to 100 existing direct child tasks and a truncation
flag so resumed agents can reuse delegated work and inspect completed results.

For native Codex runs, Paperclip passes the resolved execution workspace as
`PAPERCLIP_WORKSPACE_CWD` and uses it as the provider containment boundary. A
workspace below the host `HOME` is valid, including the default projectless
agent workspace. The host `HOME` itself, a directory that contains it, a
filesystem root, a `CODEX_HOME` overlap, or a canonical path outside the
assigned workspace is rejected before provider startup.

Fresh remote Codex Runner runs recover from a supported image CLI that is too old
for the selected model. Preparation selects the closest compatible older model
of the same class, then the stable Runner default. The task shows a warning with
the requested model, effective model, and CLI version. Agent and task settings
stay unchanged. Update the image CLI to restore the requested model on later
runs. Explicit `PAPERCLIP_RUNNER_REMOTE_CODEX_PATH` and
`PAPERCLIP_RUNNER_REMOTE_CODEX_NPM_SPEC` settings take precedence.

### Sandbox ACP input delivery

The legacy sandbox process bridge retries recognized Daytona and Cloudflare
HTTP 502, 503, and 504 failures while writing an input message, with at most
three attempts and a short backoff.
Retries keep the message sequence and use separate temporary upload files.
The remote wrapper discards already-consumed sequences, so a lost provider
response cannot send the same input bytes twice. Messages remain ordered.
This does not restart an agent turn or replay a tool call. Authentication and
shell errors fail immediately; exhausted input delivery closes the bridge and
records a fixed diagnostic without logging the input payload. Persisting that
failure diagnostic does not block bridge teardown.
Run-log finalization closes its write handle and waits for accepted file
appends before computing the size, hash, and durable copy. Writes submitted
after finalization starts are ignored; later progress persistence is not part
of that file-write barrier. If accepted writes remain stalled after three
seconds, finalization returns unknown size/hash metadata and skips the final
durable copy so the run can reach a terminal state. A late write cannot restart
mirroring or produce a claimed verified snapshot.
Readers still attempt bounded reads when size is unknown. Legacy comment
attribution retains its existing 2 MB scan limit and allows three seconds per
log. Storage errors or timeouts preserve any evidence already read and leave
the comments available without additional derived attribution.
The read deadline requests cancellation of local file streams, S3 HEAD and GET
requests, and S3 response streams. The listing stops waiting at the deadline
even if filesystem I/O delays cancellation. Late results cannot add evidence
or start another page. Each listing retains its existing batches of eight reads;
concurrent listings do not skip healthy logs because another listing is busy.

### Preinstalled remote runner runtime

Claude CLI tests and runs prepare a compatible runtime when a managed sandbox's
default `claude` command is older than the selected model requires. Preparation
installs the exact minimum supported package into a versioned workspace runtime
directory, then verifies and launches that executable. It does not replace the
image's global CLI or change the model, account, or execution engine. Compatible
private installations are reused. Custom commands, local and SSH targets retain
their existing operator-managed version checks. Installation failure or an
unverified version still blocks launch. Cloud onboarding omits manual shell
debugging instructions and legacy operator hints while retaining check messages
and details; self-hosted onboarding retains that guidance after deployment
metadata is known.

For fast sandbox startup, bake `paperclip-runnerd` and the latest stable agent
CLIs into the sandbox image. Image builds should keep one current version of each
CLI shared by native and local adapters rather than baking multiple versions.
The private compatibility preparation above is a fallback for existing stale
images; refreshing the image remains the preferred startup path.
Pin the resolved releases at image build time for reproducibility and refresh
the runner's qualification versions and binary digests together with those pins.
The ACP bridges remain separately qualified protocol dependencies.

Native discovery checks `/opt/paperclip-runner/bin`, then `$HOME/.local/bin`,
then PATH. Any preferred-directory entry must launch the same shared CLI that
normal adapters use. Discovery picks the first executable; it does not compare
versions across directories. With these artifacts preinstalled, startup links
and verifies them without uploading a binary or installing packages. Deploy
the updated sandbox image with the matching runner qualification changes.

When the provider allows concurrent sync operations, native startup prepares the
runner and the default image Codex harness together, with at most two operations
in flight. It still verifies the runner contract, selected transport, executable
hash, and final launch paths. Both preparations must settle before startup can
return a failure. Providers without this capability, explicit harness uploads,
and npm installs keep the serial path. See the
[native artifact controls](../server/src/services/native-runtime/native-artifact-preparation.test.ts).

Stamped app images also carry `provider-pack.archives/` and
`provider-pack.archive.json` beside their unpacked provider pack. The cloud build
compresses small files into one overlay and each file of at least 1 MiB into its
own zstd layer. The v2 receipt binds file and archive hashes, sizes, and modes to
the expected provider-pack digest. A sandbox can copy byte-identical large files
from an older image into the new private pack directory. It hashes the copies,
rejects symlink sources, and never shares writable hardlinks with the image.
Only missing or mismatched layers and the overlay are uploaded. The controller
checks those archives before upload; the sandbox checks all received hashes
before extraction. Normal full pack admission still runs afterward.

Historical v1 `provider-pack.tar.zst` receipts remain readable. Missing sidecars,
remote zstd, compatible GNU tar/checksum tools, or the Node 18+ helper retain
directory staging; invalid sidecars fail
closed. Keep transport files outside the pack so they cannot include themselves.
Compatible protected image packs remain preferred and never transfer archives.
The Runner's `src/live/provider-pack-contract.json` declares interface revisions;
bump only the affected interface when its runner/pack contract breaks. Image
packs must also match the bundled pack's computed `contractDigest`
(`scripts/contracts/contract-fingerprints.mjs`, over the `protocol/` and
`generated/` JSON contracts, Rust shapes and the Runner's ACPX patch), so an
unbumped contract or ACPX patch change
still retires older image packs. Declare new runner/pack contracts in a schema
and generate their TypeScript, so the digest covers them. Qualify
and seal packs at image publication. The fast path requires root-owned,
non-writable ancestors and manifest, and rejects writable aliases. The selected
pack's own artifact identities feed launch and the recovery receipt. Reattachment
keeps that exact identity; compatibility is a fresh-launch selection rule.
Older packs without the declaration retain content verification until the image
is updated. Selected ACPX agent profile checks remain in force.
Daytona detects gzip/zstd headers and skips redundant transport compression.

### Daytona duplex close receipts

Lease teardown removes duplex routes from command admission before it closes
their transports. The provider retains up to 4096 route/session bindings and
their close promises, so a later host close joins the same cleanup and returns
the original binding. These records grant no write, stop, or open authority.
Unknown or evicted routes cannot supply a session acknowledgement. A pending
close still waits; an unconfirmed close still retires the worker through the
existing host guard. The acknowledgement identifies the channel. Provider stop
receipts and unresolved external-work checks still determine process termination.
No command is replayed or worker restarted by this mechanism.

### Remote GitHub launcher staging

Managed GitHub launchers stage their nine text files in one bounded control
command. Each file retains its content-hash check, process lock, upload check,
and atomic rename. The command runs outside the persistent agent session and
stops at the first failed file. Earlier files can remain after a later failure;
the launcher environment is returned only after the whole command succeeds.
The batch permits at most 16 files and 1 MiB of shell input. Launcher staging
keeps its 15-second deadline. Run `packages/adapter-utils/src/github-launcher-environment.test.ts`
and `packages/adapter-utils/src/sandbox-callback-bridge.test.ts` for these contracts.

### Native runner restart recovery

An explicit Retry can continue a recovered setup failure that began as a
scheduled retry. Its settlement proof accepts the host-authored promotion event
only when its deadline, reason and attempt match the run and its saved retry
context. The exact failure and durable measurement must still follow. Provider
dispatch evidence, an active controller, unsafe files or changed user authority
keep the Retry held. This adds no automatic replay or recovery loop.

For remote controller disk-loss work, use the existing control-plane snapshot
transaction and `native-controller-recovery.ts`; do not add a second snapshot
writer. The private versioned metadata is limited to 4 KiB. Its importer handles
one verified retained source while the source disk is available. Workspace and
provider-backup migrations remain with their storage owners. See
[the continuity verification guide](testing-native-remote-continuity.md) for
the direct/prepared transport and three-controller continuation fixtures.
An upgrade readiness report contains preliminary native evidence, not permission
to remove a deployment volume. Keep the checkpoint pool bounded and measure all
pools when qualifying database cost; the current size of two is a default.

Cloud repeats the upgrade readiness probe, so the probe does not read or decrypt
a checkpoint header that has not changed. The statement that reads each run also
reads its header's row revision (`xmin`, `ctid`, `updated_at` and stored size)
and returns the encrypted material only for a revision the process has not
inspected. The memo in `native-runner-checkpoint.ts` keeps four identifiers per
header, is bounded in entries and bytes, and forgets a header that the latest
probe did not inspect. It loads the secrets key again for each answer it reuses, as a direct read
does for each header, and refuses the answer when the key is missing or changed. It
never remembers a header that failed to decrypt. Measure a probe with
`pnpm --filter @paperclipai/server exec tsx scripts/benchmark-upgrade-readiness.ts --baseline-ref=<pre-fix-commit>`.
The harness runs both revisions over the same PostgreSQL rows, reports bytes
from the database, decryptions, CPU and sampled allocation per probe, and fails
unless both give the same answer after a header changes, stops decrypting or is
deleted.

Committed native Agent Chat turns recover their unanswered final reply through
the existing response presentation worker. Recovery verifies the accepted result
and final turn, agent, responsible user, native session and conversation generation.
It stores the exact final message before the normal conversation settlement moves
the chat to waiting. Later user input remains active. Recovery does not run the
agent again, replace a selected reply or restore a deleted reply.

For retained Codex event tails, keep source drain/accounting and target admission
separate. `native-staged-attachment-recovery.ts` validates private source/target
header evidence; `native-recovery-usage-delivery.ts` binds the source's accounting
receiver. The transport persists its staged target before source bootstrap, then
uses the existing authenticated attachment protocol after durable drain. Do not
rotate the identity first, acknowledge before receipt persistence, or weaken the
Runner's settled-provider check. A staged target does not yet certify a resumable
session. Its eventual snapshot still uses the existing checkpoint transaction.

Custom source-mode HTTP launchers should create their listener with
`createPaperclipHttpServer` from `server/src/http/server.ts`, passing the selected
API origin as `apiUrl`. This registers the native Runner WebSocket transport
before execution is admitted. Plain Express `app.listen()` or Node
`createServer(app)` alone does not initialize that transport and native runs
fail with `runner_prp_websocket_server_not_configured`. Browser live events still
use their separate authenticated setup.

Project discovery through `list_projects` returns up to 50 compact summaries.
It uses `GET /api/companies/:companyId/projects?view=summary&limit=50&cursor=...`;
the cursor is optional. The database reads bounded summary projections. Agent
and run trust boundaries narrow database candidates before per-project access
checks. Projects with their own authorization policy remain candidates because
that policy can contribute scope; every result still passes the full access check.
Only visible projects determine page boundaries and continuations.
The default project-list API response remains unchanged.
Use its `nextCursor` as the next call's `cursor` until it is null; `limit` accepts
1–50. Descriptions include at most 1,000 characters and an explicit truncation
flag. Full project records remain available through the authorized project API.
Workspace configuration is excluded from discovery responses so large projects
cannot overflow the runner's durable tool-result command limit.

When an accepted result survives a shutdown failure, workspace repair uses a
new assessment for the repaired workspace state. Its status decision and
assessment reference commit together. Recovery completes from the saved result
without another provider turn, clears stale successful-run errors, and retains
the original error in `recoveredExecutionFailure`. Exact-state session cleanup
recognizes both the legacy `adapter_failed` and current `provider_transport_failed`
close-failure labels. Process ownership, pending tool outcomes, and checkpoint
verification still control whether that session can be reused.

Paperclip Runner keeps its heartbeat run, native session, logical runner, and
provider session identities across server restarts. A coordinated hot restart
registers a correlated recovery request before it signals the dev supervisor.
An uncoordinated server restart uses the same durable recovery classifier
without trusting a handoff marker.

Recovery retains each run's saved execution prompt, revision, and context
digest across server upgrades. The shared parser validates the saved prompt's
SHA-256 and aggregate context digest. The revision is non-empty metadata; it
does not need to match the current release or a catalog of past prompts. New
runs use the current prompt. Do not rewrite saved execution inputs to the latest
prompt. Existing execution-schema, ownership, checkpoint, and permission checks
still determine whether recovery can proceed.

Startup binds the HTTP and PRP listener before it classifies native runs. Public
health reports a startup state until every candidate is reattached, dispatched
for same-run resume, finalized from durable evidence, or held for explicit
ownership evidence. Scheduling and generic orphan recovery start only after
that classification finishes.

- A verified live runner re-registers its existing PRP authority and reconnects
  with the same operating-system PID. Paperclip does not spawn a competing
  runner.
- For a running sandbox session, recovery checks the original provider lease,
  remote workspace, durable runner identity, and process marker inside that
  sandbox. The process marker must include the Linux boot ID and start ticks;
  recovery compares them with the live process before adoption and signaling.
  Collection uses the required Node runtime and is optional for fresh launches. Older
  markers or images without that proof remain blocked for recovery. Remote
  PIDs are never interpreted as controller-local PIDs. The runner must
  authenticate to its existing PRP authority; reconnection neither
  launches another provider nor consumes a provider retry. A replacement
  sandbox or mismatched identity blocks adoption without overwriting evidence.
- Shutdown waits up to 30 seconds for an in-progress native startup to reach
  its detach acknowledgement. It reports a startup deadline failure instead
  of claiming that an unfinished bootstrap detached safely. A queued turn
  waits for the previous executor to finish releasing its task resources.
- A verified dead runner starts a replacement from the same durable root and
  resumes the same provider checkpoint. Only the operating-system PID changes.
- A prepared remote workspace interrupted before the executor's first claim
  can continue on the same run without a provider checkpoint. Under the recovery
  locks, Paperclip requires attempt and controller generation zero, no prior
  controller or lease owner, and no session, process, launch, or provider evidence.
  Any existing durable runner root must still prove an untouched bootstrap before
  execution starts. A prior claim or contradictory evidence retains the hold.
  A server-owned preparation protocol marker is required. It is recorded only
  when fresh native identities are created by a server with the ownership fence.
  Older unmarked preparations remain held during rolling upgrades; revisiting an
  existing run never upgrades that marker from caller-supplied profile data.
- If the original preparation resumes after another execution claimed the run,
  it yields without failing the shared run or cleaning up the new owner. An
  expired foreign lease still requires normal recovery before takeover.
  Recovery leaves this server's active preparation with its current execution.
  A detached execution also preserves the current owner's run-scoped gateway tokens.
- A runner that died before its first authenticated connection can restart on
  the same run only when its durable root proves that no provider authority or
  checkpoint exists. Paperclip quarantines the incomplete root first.
- A live but mismatched or unverifiable process fails closed. Paperclip does not
  signal it or spawn a replacement.
- A persisted proposed or terminal result is reconciled before any runner or
  provider work starts, so restart recovery cannot submit a duplicate turn.
- On the next run, a completed local Codex session whose warm controller died
  before suspension is recovered automatically, including a uniquely verified
  checkpoint quarantined by older controllers. Paperclip requires matching
  database/session/provider identities, a settled terminal journal, no pending
  commands or active provider turn, and a confirmed-dead process and process
  group. It seals the old authority for normal epoch rotation and preserves the
  Codex thread and goal state. Empty retry directories do not prevent recovery;
  conflicting histories, changed profiles, and live or unverifiable owners do.

A resumed sandbox lease can contain a workspace whose provider never started. A new attempt may create its exact session directory only when durable control-plane evidence proves zero connections, zero events, and untouched bootstrap commands, and no backup or remote session directory exists. Directory creation is atomic; partial state or uncertain ownership remains blocked.

### Runner lifecycle default

New native Codex, Claude and OpenCode agents store no `lifecycleMode`. For Codex
and OpenCode on a local target, the controller resolves that to `warm` with the default 5-minute idle
window (`resolveHeartbeatNativeLifecyclePolicy`), so a follow-up turn on the same
task reuses the live runner and provider session instead of launching and
loading them again. Claude (ACPX) relaunches its provider process on every
follow-up turn by design, so warm does not shorten its follow-up and it resolves
to `per_turn`, as do remote targets, other harnesses and managed providers
without warm support. An explicit `per_turn` or `warm` choice
("Turn by turn" or "Warm session" in the agent's Runner lifecycle field) always
wins, and a session keeps the policy it was admitted with. The measurements are
in [`plans/2026-11-07-warm-follow-up-ttft.md`](plans/2026-11-07-warm-follow-up-ttft.md).

A warm local runner outlives its turn, so it carries a 7-minute reconnect grace
(`localRunnerProcessReconnectGraceMs`, the same grace remote runners use). If its
controller dies without suspending it, runnerd proves after the grace that no
controller re-authenticated, stops its provider, keeps its durable state for a
cold resume, and exits. A graceful controller shutdown suspends idle warm
sessions first. A per-turn local runner keeps its connection-lease bound.

Only successful turns retain a live warm provider session. A structured failed
or cancelled result must retire that session and collect its managed files before
heartbeat stops the reusable sandbox. A later retry can resume the same sandbox
without inheriting the stopped provider transport.

A rejected warm-session close retains its owner, even when no managed instruction
copy exists. Idle expiry, failed-turn release, and restart must not report that
owner as quiet or launch a replacement over it. The next retirement attempt uses
the same owner and must finish provider closure and stopped-file collection.
The existing explicit-reset exception still requires its typed retirement proof.

`heartbeatService(...).prepareIdleWarmNativeSessionsForSleep({ canRetire })`
delegates to the native owner's retirement path for idle owners. Its caller owns
the admission hold and supplies a synchronous
current-authority check. The check runs before each retirement and after its
awaited effects. A started cleanup settles if the hold expires, but no further
owner retires under that expired hold. Busy turns remain active and do not inherit
a close-on-release request from an abandoned sleep attempt. Counts describe the
attempt; the caller must still validate its hold and final local-work proof.
Diagnostic-only inspection must never invoke this resource preparation.

The privileged `task-drain?idleSleepSafety=1` preflight invokes this operation only
for the exact current, unexpired idle owner with no active admitted work. It tracks
the actual cleanup promise, rejects concurrent work or a changed hold, and then
takes a fresh durable/local safety snapshot. Busy or failed retirement keeps the
instance awake. Plain drain reads and `idleSleepDiagnostics=1` remain passive with
respect to native retirement.

An idle warm owner proves only the exact prior run in the same company, session,
workspace and environment. Mutable configuration compatibility is checked
separately: changed settings retire the owned provider before a replacement can
execute. A copied older owner record, an active or missing owner, and a different
environment cannot use this in-memory proof. Database terminal status alone is
not proof that an unsuspended remote runner can be adopted.

The shared lease-release boundary rechecks the durable run status for recovery
and ordinary teardown. Successful workspace copy-back alone must not keep a
failed turn's sandbox running.

Native workspace export also fences destructive lease cleanup. A failed heartbeat
can still own unexported files, including when checkpoint copyback failed before
its semantic result was accepted. The orphan and pending-cleanup sweeps preserve
the exact lease bound by a prepared workspace-sync reference until export records
it finalized. Direct release and destruction apply the same check. Explicit
stop-only cleanup remains available; neither a retry deadline nor an exhausted
retry budget authorizes deletion of the only workspace copy. This does not change
successful warm-session retention or admit another provider turn.

Run the credential-free real-process restart suite with:

```sh
pnpm --filter @paperclipai/paperclip-runner run build:runner-binaries
pnpm exec vitest run server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts
pnpm --filter @paperclipai/paperclip-runner exec vitest run src/live/runnerd-codex-transport-adoption.test.ts -t 'adopts a live runner'
```

The suite uses isolated PostgreSQL state, isolated `PAPERCLIP_HOME` roots, real
`runnerd` processes, and a deterministic fake Codex app server. It covers hot
and hard restarts with live and dead runners, the result-finalization race,
incomplete bootstrap, repeated crashes with steering, and fail-closed process
identity mismatches.

Native task-session publication is part of the terminal checkpoint transaction,
not resource cleanup. `native-task-session-publication.ts` owns its accepted-result,
owner, task-epoch and reset checks; heartbeat supplies prepared session metadata.
The goal projection also advances its source epoch when a fresh native session
holds the task's current execution lock and assignee. The predecessor must be
terminal, and its saved goal must be absent or complete. This lets the accepted
checkpoint publish the fresh session as the next continuation baseline. A
different session without current task authority, an unfinished or unreadable
goal, a reset conversation, and delayed predecessor events retain their fences.
The goal-less regression in `native-session-resumption.test.ts` holds provider
cleanup open and then exercises a normal follow-up and an explicit session reset.
Its fresh-session case keeps the prior task-session row, opens one new provider
session, and verifies that the following ordinary comment resumes that session.
The opt-in `native-session-epoch.live.test.ts` runs the same path with an existing
Codex login and a built native Runner. It uses warm mode, makes three model calls,
checks exact file contents and provider-thread reuse, and removes its temporary
credential copy and workspace. Run it with
`PAPERCLIP_LIVE_SESSION_EPOCH=true pnpm exec vitest run server/src/services/native-runtime/native-session-epoch.live.test.ts`.
`PAPERCLIP_LIVE_EVIDENCE_PATH` can select a JSON evidence file outside the fixture.
Control-port tests also cover terminal snapshots before accepted results and
result-replay contention with the status writer's coordinator-first lock order.
Remote adoption tests must invoke actual external-state preparation. Inspecting
transport options alone does not exercise the resumed-lease harness checks.
Include a healthy warm handoff before the crash so recovery exercises the
handoff's turn and item attachment IDs as well as first-run identities.
Retirement tests must exercise the preceding `turn.stop` as well as drain and
suspend after result acceptance. Use the actual native-observed, unclaimed
admission phase and the production claim before retiring the predecessor;
a synthetic legacy preparation does not cover that boundary. Verify failed
claims and Stop leave the predecessor and shared attachment staging untouched.
Configuration tests compare fresh and recovered
home-mode fingerprints while preserving rejection of real mode changes.
Include multiple skill versions read back from Postgres JSONB: version-map key
order must not change the generated preference or session fingerprint. Exercise
the real environment-selection and configuration services with a retained shared
workspace, and keep actual model or skill-version changes incompatible.
Run it against an isolated database with `PAPERCLIP_TEST_DATABASE_URL` when the
host cannot start embedded Postgres:

```sh
pnpm exec vitest run server/src/__tests__/native-session-resumption.test.ts -t 'publishes the completed task session before provider cleanup'
```

## Native Runner credential refreshes

Core handles PRP `auth.credentials.updated` notifications for managed Codex and
Grok subscriptions across local, SSH, sandbox, and supported plugin Runner tasks.
After validating the company, agent, run, session, and Runner binding, it exports
the selected account and writes newer credentials directly to the tenant secret.
Grant, secret, version-selector, session-epoch, and provider freshness checks are
shared across execution targets. Explicit reconnects and revoked grants win over
old refreshes. Providers that do not emit this event keep their existing flow;
operator-owned homes do not acquire tenant writeback authority.

The transport's credential handler rebinds with each warm invocation, including
its current target exporter. Idle refreshes and recovered controller handles do
not depend on a completed invocation's temporary home. Detached handles cannot
process new updates. Native/ACPX Codex and Grok use bounded, descriptor-based file
reads; SSH and sandbox readers use the Node runtime already required by remote
isolated-home preparation. Plugin tasks use their account-bound export operation.

A notification is acknowledged only after writeback succeeds or its authority is
intentionally discarded. Export and database failures replay through PRP. An
unchanged managed-subscription turn does no credential export or database write.
Retirement keeps a final export for legacy and recovery paths; a failed final
export retains the provider's credential files for retry. After verified provider
exit, ACPX Codex and Grok preserve a private `auth-refresh.json` handoff before
scrubbing `auth.json`; Core removes it after retirement writeback. Plugin retirement also
records rotation, unchanged credential, changed binding, undispatched task, or a
null export. No secret bytes appear in PRP events or lease metadata. The plugin
provider must support live account-bound exports before enabling the paired Core
handler.
