# Google Antigravity native Runner integration — 2026-10-28

Owner: Codex integration owner, with separate provider-research, distribution,
and product-configuration workers.
Source baseline: `dce004259394486f6361d0c0dd5a33a5272acc0a`.
Requested finish line: a reviewable native Runner integration. Publication,
merge, deployment, and migration of existing agents are outside this request.

## User outcome and release contract

An operator selects Google Antigravity in native Paperclip Runner, binds an
authorized Google runtime account, selects an exact model, and assigns an ordinary
task. The task produces independently verified files/artifacts, settles through
Paperclip, and can be stopped with physical process cleanup.

- Transport: Google's official Antigravity ACP server through the existing ACPX
  harness driver. The standalone `agy` print protocol is a separate interface.
- First environment: local macOS ARM64. Other registry platforms are an inventory,
  not a live qualification claim. No new hosting environment is promised.
- Runtime pin: ACP server **1.4.3**, including its matching
  `localharness_external` executable. The CLI's separately versioned release is
  not this runtime's version. Use explicit setup and verified immutable assets.
- Authentication: the user authorized an existing Google account connection if
  available. Managed Gemini API-key bindings are eligible only through the
  native `gemini-api-key` method. Google Drive/MCP OAuth is not runtime auth.
  The user subsequently requested a fresh test environment and a named Google
  account. Explicit local personal OAuth is now part of the candidate; it needs
  its own connection flow and must not borrow a workstation login.
- Model policy: caller-selected exact model, passed unchanged and acknowledged
  before a prompt, including on load. Acceptance model remains unset until an
  authorized account can advertise/accept one. No product model allowlist.
- Required: exact instruction admission on create/load; scoped semantic and MCP
  tools; streamed text/tool fidelity; accepted task result/artifact; permission
  denial; distinct native questions and permissions; Stop and bounded shutdown;
  provider-loss expiry; honest usage; ordinary save/reopen/Test and clean install.
- Active steering, native planning decisions, child interactions, inbound media,
  remote platforms, and enterprise login remain discovery items. Do not expose
  unsupported behavior as supported. The required work above remains required.
- Spending: no paid prompts or paid infrastructure in the discovery phase. Do
  credential-free/deterministic work first. A paid acceptance campaign needs an
  explicit model/account and bounded spending record before it starts.
- Admission: keep the profile pending consistently until its required native
  acknowledgments and product acceptance pass. A test override is not delivery.

## Architecture and ownership

Provider translation, native metadata, question semantics, auth-home settings,
and executable verification belong under the Antigravity provider boundary.
The existing Runner owns supervision/PRP/replay; Paperclip retains company,
credential, permission, budget, result, and task-state authority.

- Integration owner: Runner profile/contracts, sidecar/Rust admission, CLI wiring,
  integration tests, and final evidence reconciliation.
- Distribution worker: pinned registry manifest, complete two-binary closure,
  explicit setup/cache provisioning, integrity and cleanup tests.
- Product worker: shared harness registration, explicit managed Google routing,
  server configuration, and gated product presentation.
- Research worker: official documentation and shipped-runtime behavior only.
- Serialize shared profile generation, manifests, schemas and lockfile changes.
  Follow the repository lockfile policy; do not commit generated lock changes.

## Research and capability inventory

Evidence labels describe the actual boundary, not inferred product support.

| Capability | Native evidence | Runner/product qualification | Remaining work |
| --- | --- | --- | --- |
| Distribution | Registry-observed 1.4.3, macOS ARM64 archive checksum verified | Unqualified | Complete closure verification and clean setup |
| Initialization | Credential-free observed: ACP v1, `antigravity-acp` 1.4.3 | Unqualified | Actual installed ACPX path |
| Auth | Observed methods: personal OAuth, business OAuth, Gemini API key, Agent Platform | Unqualified | Bound account, settings isolation and revoke |
| Missing auth | Observed `session/new` rejects with authentication-required error | Unqualified | Product diagnostic and routing |
| Instructions | Advertises `_meta.antigravity.systemPrompt.append` | Unverified | Exact create/load content acknowledgment and live behavior |
| Models | Account-dependent; official issue reports client-dependent catalogs | Unverified | Exact model selection/ack on create/load; no identity spoofing |
| Native questions | Upstream ACPX identifies `interaction_` permission callbacks as questions | Unverified | Preserve option identity and human round trip |
| MCP | Advertises HTTP/SSE support | Unverified | Scoped tool discovery/invocation and result acceptance |
| Media | Advertises image/audio/embedded context | Unverified | End-to-end conversion; no UI promise yet |
| Continuity | Advertises load/list/resume | Unverified | Process/session distinctions, fencing and failure recovery |
| Shutdown | Credential-free observed stdin EOF exits 0 after init/auth rejection | Unverified during work | Stop, native-child loss and bounded descendant cleanup |
| Usage/cost | Historical issue reports missing ACP usage | Unverified | Inspect current receipts; absent is unknown, not zero |

Public references:

- [Official ACP distribution registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json)
- [Google's Zed setup/authentication documentation](https://antigravity.google/docs/ide/extensions/zed/)
- [Upstream ACPX integration](https://github.com/openclaw/acpx/blob/main/agents/Antigravity.md)
- [Client model catalog issue](https://github.com/google-antigravity/antigravity-cli/issues/1318)
- [Instruction metadata and workspace confinement issue](https://github.com/google-antigravity/antigravity-cli/issues/1273)
- [Historical terminal/cancellation issue](https://github.com/google-antigravity/antigravity-cli/issues/1041)

## Acceptance ledger

| Gate | Required observation | Current verdict |
| --- | --- | --- |
| Native admission | Installed dependency verifies exact model and instructions before first prompt and after load | Real create passed; loaded session and model behavior still pending |
| Scoped tools | Real semantic/MCP round trip; wrong-company/revoked/stale authority denied | Unattempted |
| Ordinary task | Browser/server/DB/Runner/provider; verified file/artifact, accepted result, durable task state, cleanup | Account/model selected; product execution remains gated pending acceptance |
| Human decisions | Native question/permission identity, correct response, duplicate/stale denial, loss expiry | Unattempted |
| Stop/lifecycle | Startup/work/pending-input Stop, spontaneous child loss, bounded shutdown and no late revival | Unattempted |
| Setup | Connect/select/save/reopen/Test/reconnect/revoke in selected environment | Real personal connect/save/reload/account catalog passed; agent Test/reconnect/revoke pending |
| Distribution | Clean installed package, explicit setup, verified closure and tamper/missing rejection | Final `.4` cold public setup bundle passed on macOS ARM64; other platforms unqualified |
| Compatibility/checks | Focused existing native and legacy regressions; required repo checks | Focused checks passed; full typecheck/build passed; full suite incomplete due host PostgreSQL resources; final impact checks running |

Credential-free discovery is not a passed Product E2E cell. Original failures and
later attempts retain their own candidate identity. No shipping candidate is
frozen or published yet. Discovery sent no prompts; the later bounded native
slice below sent one prompt through the selected subscription.

## Implementation and acceptance progress

The candidate remains pending. One authenticated native prompt passed exact
instruction behavior and scoped file-tool checks; Product E2E remains pending.
The implementation now includes the registered native harness, a two-executable
verified closure and explicit setup, exact-byte/model native admission receipts,
question translation, scoped credential projection, and fail-closed release
checks at catalog, API, TypeScript driver, sidecar, and Rust launch boundaries.

The operator subsequently requested a fresh test environment and named a Google
account. This adds explicit personal Google runtime sign-in to the first release
contract. The existing local connection-attempt lifecycle owns sign-in, vault
promotion, access, reconnect and expiry. Its setup-only native ACP client sends
only `initialize` and `authenticate`; readiness requires the native result,
physical process retirement, and a verified Google email. A token file appearing
before native onboarding finishes is insufficient. Managed task execution must
silently refresh or fail; it cannot open another browser sign-in. Remote OAuth
execution remains rejected pending separate qualification.

### Evidence observed so far

- The official archive and complete vendor closure were verified. The owned
  Mach-O/Python patch is signed locally and pinned independently from the vendor
  closure. Subsequent patch candidates retain separate hashes and observations.
- Installed ACPX tests with a controlled native peer exercise nonce/session/model/
  instruction receipts, setters, question identity, invalid acknowledgments and
  stale connections. They do not prove real model behavior.
- Actual hermetic native Python tests execute Google's protobuf builder, server
  configuration builder, native SDK strategy, and a real helper subprocess and
  local WebSocket. They reject a cached external executable, exclude browser/
  subagent/workflow/ambient command-hook configuration, and fence unattended OAuth
  against browser fallback. Native conversation acknowledgment remains controlled.
- A public-layout CJS setup bundle installed the first patch candidate from the
  real vendor archive into an isolated cache, verified its signed closure and
  removed it. The final candidate requires a fresh installed-layout result.
- Focused OAuth/credential checks passed 20 tests using real local subprocesses,
  private files and lifetime-fence sockets with controlled provider responses.
  Shared and UI connection regressions passed 37 tests. Local Google lifecycle
  checks passed 8 tests, including early-token rejection and retirement-before-
  removal. These tests do not establish Google entitlement or live inference.
- Full `pnpm -r typecheck` and `pnpm build` passed with the OAuth integration.
  The subsequent metadata discovery changes passed Runner/server TypeScript;
  final impact checks remain required after freeze.
- Fresh ordinary browser onboarding created one disposable company. Personal
  Google sign-in completed for the user-selected account, its verified email
  was saved on the encrypted runtime grant, all login processes retired, and
  the connection remained connected after a browser reload. This proves setup
  authentication, not model entitlement or task execution.
- Eight real PostgreSQL connection integration tests passed without DB/service
  mocks, covering encrypted user credentials, selected homes, company/member/
  install authority, revoked defaults, and refresh/reconnect compare-and-swap.
- The final metadata candidate is `1.4.3-paperclip.4`, closure
  `05ed2a3e39c95fc813abeb664a78a295d1dcbfd4098f28cbc17d30d710a1ea92`.
  Its setup-only `_paperclip/models` path invokes the official account catalog
  without creating a conversation, native helper, or prompt. Four actual-source
  native regressions and 25 auth/catalog process regressions passed. Discovery
  retains the credential home and executable lease if process retirement cannot
  yet be proved; deletion follows physical retirement.
- The account catalog supplies suggestions. Explicit compatible model IDs remain
  eligible even when absent from discovery, for both OAuth and API-key bindings.
  The native exact-model receipt decides admission.

### Preserved failures and limits

| Observation | Resolution or remaining limit |
| --- | --- |
| Imported patch CLI top-level await broke CJS setup bundling | Removed the imported CLI entry branch; public-layout bundle subsequently installed the real archive successfully |
| New Rust pending-profile regression initially failed formatting | Formatted the assertion and regenerated affected unpublished identities; full typecheck subsequently passed |
| Native embedded PostgreSQL could not create host semaphore/shared-memory resources | Preserved failed launch. Started a disposable PostgreSQL 18 container with an owned volume and loopback-only port; fresh source onboarding, health, bootstrap and browser rendering passed |
| One credential test could not acquire its deterministic TCP quorum | Failed closed before staging. A later fresh-directory run passed all 20 focused cases. Host observation found 1,781 reservations in the relevant ephemeral range; the exact original colliding reservations were not captured, so causality is not claimed |
| Review found SDK cached-helper override, hidden browser/hook setup and interactive refresh fallback | Corrected the actual native boundaries and added actual-source regressions; original candidate observations are not transferred to replacement hashes |
| Missing source vendor-shim exports caused the first new server OAuth tests to fail | Added the explicit exports; focused rerun is required/recorded separately |
| Full test run repeatedly failed native PostgreSQL initialization on the shared host | Full suite did not complete. All 16 affected native-session DB cases subsequently passed using the supported external test-DB seam and a separate disposable PostgreSQL container; later full-suite groups remain unrun |
| One existing route test exceeded its 15-second deadline during concurrent checks | Other 94 tests passed; the unchanged route test subsequently passed alone with its original timeout |
| First authenticated native session returned exact receipts but installed ACPX rejected its grouped model selector | Native create and model setter both acknowledged `gemini-3.8-flash-low` and the exact 112 instruction bytes. ACPX preferred the separate family selector `gemini-3.8-flash`, producing an effective-model mismatch. Zero prompts were sent; native process, command lease, managed-home writeback and deletion all completed. Preserve this failed attempt while fixing the provider projection |

The local environment is a fresh checkout instance with an isolated Docker
PostgreSQL database, not the seeded `test-drive` CLI (that command requires an
API key and rejects external PostgreSQL). The failed embedded attempt and fresh
Docker-backed attempt have separate evidence directories. No existing company,
workstation CLI login, Google tool grant, or shared database was borrowed.

Ordinary product task output/result, scoped semantic/MCP tools, human decisions,
loaded sessions, Stop, and native-child loss remain unqualified. The selected
account/model, direct native file-tool slice and final installed setup passed;
typecheck/build passed and the complete test suite remains environment-blocked.

### Selected account and first native slice

The fresh instance's saved personal Google subscription returned its account
catalog through the ordinary authorized metadata API: `gemini-3.8-flash-high`,
`gemini-3.8-flash-medium`, and `gemini-3.8-flash-low`. The first slice selects
**`gemini-3.8-flash-low`** unchanged. This is an acceptance choice, not a product
allowlist. The user authorized the named account and fresh local test drive.

First prove native create/model/instruction admission without a prompt. Then
permit at most two short first-slice prompts, each with a 120-second process
deadline, using the existing subscription and disposable local workspace.
Stop at the first admission, tool, output, or cleanup divergence and diagnose
before another attempt. No subscription change, paid infrastructure, or automatic
paid fallback is authorized by this bounded slice. Per-request provider billing
may remain unavailable; request count and duration do not establish dollar cost.
The broader Product E2E campaign needs its own recorded cells and bound.

The first authenticated native attempt (2026-10-28 14:44 UTC) failed before a
prompt at the ACPX model-selector projection, after two correct native receipts.
The full wrapper error SHA-256 was
`8b6480a8eac6d058877054700dbd69654955e6061f961d23c8eddbbefc349818`;
the message was independently reproduced from the installed wrapper's source.
Native closure `.4` remains unchanged. The provider projection fix reproduced
that exact error against installed ACPX, then passed 28 admission/dependency
regressions. The unchanged native runtime subsequently passed authenticated
session admission at 14:49 UTC: the exact low model and 112 instruction bytes
were acknowledged, no model setter or prompt was needed, and native process/
lease plus managed credential writeback and home cleanup completed. The passing
guard JS digest was
`31b9dd005c7452b61e61f3a29c77f74d7f16b20511d1e0f9eff10dfb649dca4b`.
Current slice tally: two native attempts, zero prompt requests, one preserved
failure, one admission pass, physical cleanup passed for both.

At 15:00 UTC, one bounded native prompt passed on the same `.4` closure and
exact model. The unpredictable proof string appeared only in the admitted
650-byte system append. The real model completed native client write/read
tools; an independent filesystem read matched all 40 expected bytes including
one LF. Native tools, stream, terminal result, physical process retirement,
command lease release and managed credential cleanup passed. The provider
reported context usage but no input/output token or monetary receipt, so cost
remains unknown. This is native dependency evidence, not Product E2E.

The [sanitized native evidence](2026-10-28-antigravity-native-evidence.json)
retains all three attempts, source/runtime identities, the original failure,
one actual prompt and its independent byte oracle. Total native attempts: three;
prompt requests: one. Production admission remains pending because Product E2E
and the remaining release-qualification cells are not complete.

### Proposed Product E2E candidate campaign — not implemented

The existing operator qualification authorization lists only Cursor, Copilot
and Pi; it does not admit Antigravity through the canonical driver, installation,
sidecar and Rust pending gates. Do not mark the profile qualified or inject a
private backend to obtain a pass. A candidate path must bind the exact model and
runtime identity across those boundaries, while default admission stays closed.

The proposed campaign is local-only, uses this disposable company's saved
personal Google grant, selects `gemini-3.8-flash-low`, and permits at most twelve
provider admissions in thirty minutes, with no automatic story retries. It
stops at the first divergence. Provider billing is unavailable; these are
admission/time bounds rather than a fabricated dollar-cost guarantee.

Required cells remain ordinary task/file/artifact/result delivery; native
question and permission responses; active and pending-input Stop; spontaneous
native-child loss with durable expiry; and loaded-session instruction/model
continuity. Each needs an independent state/file/cleanup oracle. Reuse the
existing Product E2E catalog and report pipeline with an explicit attached-local
saved-connection fixture. The fresh-connection suite intentionally rejects
usable pre-existing connections, so it cannot be relabeled as this journey.

Candidate authority should extend the existing trusted startup launch profile:
server operator authorization → Runner launch descriptor → Rust session policy
→ sidecar initialize/open → provider host/install checks. It must bind company,
exact model, profile digest and native closure. Do not place this authority in
agent configuration, provider environment, runtime context, or a saved provider
snapshot. Existing `acpxCandidateProfile` stops at TypeScript transport gates;
it is insufficient on its own. This design is proposed, not implemented or
activated, and does not change any current qualification verdict.

### October 29 additional-agent user walkthrough

The user requested a Codex bootstrap with the authorized local OpenAI key, then
Google Antigravity in the ordinary additional-agent picker. The Codex agent and
saved personal OpenAI connection were created through the UI. A subsequent
strict user-control recording found that the pending Antigravity draft lost its
provider when reopened. That 17-step failed recording is preserved.

The UI now retains a non-secret pending provider choice on the held draft,
labels it Google Antigravity in the roster and overview, and resumes Google
setup through Finish setup. It keeps the physical draft paused and leaves native
qualification and execution configuration unchanged. Change adapter can reuse
the same draft. All 193 affected UI tests, UI typecheck, token gates and map
validation passed.

A fresh 14-step browser-only recording created Antigravity Assistant from New
agent, found Google Antigravity in the main grid with Advanced collapsed, opened
Google setup, returned to Agents, and reopened the correct provider through
Finish setup. Its report and structured log are in the Codex artifact directory
`add-antigravity-agent-verified-2026-10-29-1793285314053`, with 14 actual viewport
screenshots. The earlier failure is in
`add-antigravity-agent-user-journey-2026-10-29-1793284634382`.

This proves additional-agent discovery, draft identity, labeling and resumption.
The pending banner still prevents runnable completion. This walkthrough did not
complete Google OAuth, an Antigravity task, a follow-up turn or Stop acceptance.
The Codex overview also exposed taskless scheduled-heartbeat failures, which
remain outside this additional-agent change. The local test drive was moved to
a stable temporary source mirror while retaining the same isolated database and
saved connection. No provider credentials were copied between instances.

### October 29 finish line: setup and real work

The user clarified that picker/draft success is insufficient. Continue the
recorded user-test → diagnosis/fix → focused checks → fresh user-test loop until
Google Antigravity connects, finishes setup, and completes a real task. Retain
each failed attempt. Include a follow-up turn and independent output evidence;
the original request expects useful results over multiple turns.

| Required outcome | Current evidence | Remaining gap | Next action / owner |
| --- | --- | --- | --- |
| Ordinary Google setup and activation | Fresh `.5` agent passed ordinary picker, saved account reuse, native Test, actual readiness and clean task handoff | No gap in the declared local setup path | Preserve the 38-screen walkthrough and exact candidate identity |
| Real native task and follow-up | `.5` first task and follow-up delivered exact 61/119-byte files, retained the native conversation and persisted Done | No gap in the declared local two-turn task path | Preserve independent bytes, decision lineage and native retirement evidence |
| Local release qualification | Exact native model/instruction receipt and physical native cleanup | Product authority, interactions, cancellation and installed path cells | Prove the local contract with exact candidate identity before changing release flags |

The initial acceptance target remains the local darwin-arm64 test drive and the
selected Google subscription connection. Candidate authorization is bound to
that company, exact model, provider profile, native closure and expiry, with
fresh actual run/session binding. It is supplied only by the server operator;
agent config and provider environment cannot create it. Global qualification
remains pending while gathering real evidence. Diagnose the first divergence
before another paid attempt; provider billing remains unknown rather than zero.

The next recorded user attempt (`antigravity-connect-and-run-2026-10-29-1793286152790`)
completed the selected Google account sign-in, saved the personal subscription,
and discovered the real account model catalog. Selecting Gemini 3.8 Flash Low
still left Test and Finish disabled, so the full user goal failed. Its 15
screenshots and original report are retained. No task prompt was sent.

During implementation the active Codex checkout was externally removed. Snapshot
`7eb51ffb10f4a2fd0937f54060a9d10fd4f8c630` preserved the source; it was recovered
into a stable temporary Git checkout with independent objects and an additional
tracked-source archive. The separate serving mirror, instance database, saved
Google connection and original evidence were unchanged. The remaining native
continuation and taskless timer corrections are being tested there before the
next recorded setup/task attempt.

The second full setup attempt
(`antigravity-setup-task-iteration-2-1793289638292`) reused the saved Google
subscription, reached Configure with Gemini 3.8 Flash Low, and exposed enabled
Test and Finish controls. The real prompt-free runtime Test failed and disabled
Finish. Its expanded details offered only a generic account/model verification
failure. This remains failed acceptance: no Antigravity task ran. The ten-step
recording and all ten screenshots are retained. Diagnose the original native
error and improve safe recovery details before a fresh browser-only attempt;
do not count an enabled picker or passing unit suite as the user outcome.

Independent verification after that failure found no serving-source or runtime
drift: the frozen Runner, selected ACPX sidecar and profile/closure manifests
match the final build ledger, and the original PostgreSQL container remains
healthy with its saved volume. The scoped candidate path is implemented across
server, Runner, Rust and sidecar; the earlier proposed-design section records
the state before implementation, not a present claim that authority is absent.

The next diagnosis reproduced the original `session.open` rejection with zero
model prompts and confirmed physical retirement. Its first failing stage is
installation. The controller selected the JavaScript workspace dependency root
for Antigravity while supplying the native Runner package manifest; the native
asset guard correctly rejected that owner/manifest mismatch. A credential-free
check reproduces the old failure and verifies the real pinned native closure
after selecting the actual Runner package owner. The correction also covers the
vendored source-server layout while preserving existing Copilot behavior.

The rebuilt candidate's third browser-only attempt completed the real native
Test and Finish setup, then ran ANT-2 in its isolated task workspace. Antigravity
created and read back the requested file, registered its attachment, corrected
an initial completion-citation rejection, and reached Done. Done and the actual
file persisted after Reload. Independent download verification then preserved
the first result: 55 exact UTF-8 bytes, SHA-256
`5964636e0fd46950f9296593d33bd864e47e35f79997287cc4498735f839e733`.
The 26-step recording includes 26 screenshots. This is the first complete
setup/task success, not a release-qualification verdict. The follow-up native
conversation and completion/cleanup joins remain to be checked. Usability gaps
observed in this run are a stale paused warning in the post-setup task composer
and misleading failed labels on earlier activity rows after a finish error.

The same task then completed a second ordinary UI turn. Send reopened ANT-2;
Antigravity read the existing file, preserved its first line, appended the new
requested line, registered a second attachment and returned to Done. The updated
file remained readable after Reload. The nine-step follow-up recording has nine
screenshots. Independent download verification preserved all 113 expected bytes
with SHA-256
`cc8160e66e60e98aa1013668760691ee46379606aeaf1e89ab5ff2b3c604d15a`.
The first accepted native result was joined through committed finalization and
an applied status decision to Done; the follow-up native identity and physical
retirement audit are being completed separately from the strict browser runs.

Both independent oracles now pass. The follow-up retained every tagged native
conversation identity field and exact requested/effective low model. It used a
fresh run-bound startup/state root and different physical Runner/sidecar PIDs.
Both native results have accepted rows, committed finalizations and applied
assessments/status decisions to Done. All four recorded Runner/sidecar PIDs and
both process groups are absent, both provider states are closed without an
unconfirmed-exit marker, and the exact retained native-home kernel quorum was
acquired and released. This proves native lifetime retirement beyond Runner
exit alone. Setup readiness and activity-label feedback remain under correction
before the final fresh-agent walkthrough; global qualification is unchanged.

The activity-label diagnosis found two coupled upstream SDK behaviors: local
client file callbacks emitted ACTIVE without a terminal result, and any later
ERROR step failed every open activity. Native patch `.5` closes file callbacks
from their actual `ToolResult` after matching call/step identity and successful
result delivery. It removes the broad error broadcast, retaining the existing
per-call terminal mapping and turn cleanup. No successful outcome is fabricated;
genuine concurrent and scoped errors remain errors. The real hermetic SDK
regression first failed on the missing terminal, then passed actual create/read/
edit bytes, genuine file failures, concurrent calls and scoped/unscoped errors.
All five native regressions and independent semantic review pass. Admission
Python remains byte-identical. The `.4` binaries, cache and real-task evidence
remain historical; `.5` has a new immutable native closure and needs fresh
candidate authority and live acceptance.

The post-Finish UI now waits for the actual lifecycle-ready detail before
showing readiness or enabling task assignment, then refreshes the roster entry
used by the composer. Genuine manual/import pauses and approval/Dot flows stay
intact. All 120 setup tests, UI typecheck and token checks pass. The final user
walkthrough will create a fresh agent and exercise this corrected handoff.

The final `.5` fresh-agent walkthrough passed all 38 recorded steps with 38
screenshots. Google Antigravity was selected from the ordinary additional-agent
grid with Advanced collapsed. The saved Google subscription passed native Test.
The UI visibly waited in Finishing agent setup before enabling assignment at
actual readiness; the composer had no paused warning. A unique marker was then
saved through the ordinary AGENTS.md instruction editor, preserving the default
sentence. ANT-3 requested that configured marker without including its value.
The delivered file contained that marker, was readable and downloadable, and
Done persisted after Reload. Independent download preserved all 61 expected
bytes with SHA-256
`e229f07be3a7c6835f91f9bd07f7daf4bd19f839c91f2fdd17161867750d4483`.
Native event evidence confirms completed edit/read activities stayed completed
when the first finish citation failed; only the actual failed finish was marked
failed, and its corrected retry completed.

A separate nine-step `.5` follow-up also passed with nine screenshots. The same
task reopened through Send, read and updated its existing file, preserved the
instruction marker and appended the requested line. It returned to Done and the
actual updated attachment survived Reload. Independent download preserved all
119 expected bytes with SHA-256
`b1bca87da838f17535613f48932a40043b9e31a820a43e4c9740d619e3dfac05`.
The second run retained the full native conversation identity and exact low
model under the `.5` profile. Both physical Runner/sidecar process groups and
their four recorded PIDs are absent, provider states are closed with confirmed
exit, and the exact native-home kernel quorum was acquired and released. Both
accepted results have committed finalization and applied Done decision lineage.
The first coordinator's current pointer subsequently changed to a superseding
assessment during the user's follow-up reopening, preserving in-progress work;
its original applied Done decision and captured first-run result remain intact.
The oracle retains the initial strict-current-pointer failure and this explicit
lineage explanation instead of rewriting the original grade. Raw native
instruction wire receipts remain unarchived;
the instruction-only marker provenance and actual bytes establish the observed
behavior without claiming an independent wire archive.

### Final repository verification and local handoff

Repository-wide `pnpm -r typecheck` and `pnpm build` pass against the frozen
`.5` source. `pnpm test:run` remains incomplete: its first general-server group
reached the declared 20-minute command bound and reported a 15-second timeout in
the Gmail/Cloud environment-identity case. The exact case passed in isolation
with its unchanged 15-second test budget. The cause of the broad-run timeout is
not established; later full-suite groups were not reached. Original logs and
grades are retained, and owned verification processes were retired. This is not
a claim of a green complete test suite or a production-qualified release.

The externally removed chat workspace was restored from the independent source
checkout on `codex/google-antigravity`. All 106 changed/new source paths, the
native binary, selected sidecar and Git object connectivity were verified after
restoration. The test drive continues to serve from its separate frozen mirror
with the original isolated database and saved account, and reports ready/healthy.
The final `.5` oracle and both browser journeys establish the requested local
setup, task and follow-up outcome; broader release qualification remains pending.
