# Antigravity setup and two-turn file journey

This is the conversion contract for the recorded user walkthrough, not a runtime
manifest. The runnable contract and commands live in
[Antigravity agent journey](../../tests/runner-e2e/ANTIGRAVITY-AGENT-JOURNEY.md).
Raw recordings and concrete account, company, agent, task, attachment and native
session bindings remain in private evidence. The aliases and hashes below locate
that evidence without publishing an authenticated screenshot report.

## Outcome and requested delivery

A person can add a Google Antigravity agent from the ordinary Agents roster,
reuse their saved Google subscription, test and finish setup, save an instruction,
and receive a readable file. A follow-up on the same task preserves and updates
that file, returns to Done, and survives reload.

- Suite: `antigravity-agent-journey` (explicit only).
- Profile: `runner-antigravity`; case: `saved-subscription-two-turn`.
- Execution ID:
  `antigravity-agent-journey.runner-antigravity.local.saved-subscription-two-turn`.
- Entry: the selected existing company's dashboard as its board operator.
- Measured creation: a fresh additional agent and one task with two work turns.
- Excluded: fresh Google signup/consent, API keys, gateways, other models,
  permission/question/Stop interactions, controller or provider loss, remote
  execution and a platform matrix. Registration is not global provider release
  qualification or unattended campaign qualification.

## Source and confidence

The source contains two v1 logs. Both originals remain immutable. On conversion,
the original `render_journey.py --validate-only` accepted 38/38 and 9/9 screenshots.
Images A08, A17, A18, A19, A26, A36, A38 and B09 were inspected directly: ordinary
picker discovery, disabled assignment during preparation, actual readiness, clean
composer, saved instruction, accurate activity statuses and persisted outputs.
The HTML gallery itself remains unverified: the collection host rejected local
file preview. Schema validation, image inspection and gallery interaction are
separate claims.

| Alias | Original title and UTC interval | SHA-256 of original `journey.json` | Original verdict |
| --- | --- | --- | --- |
| A | Fresh Antigravity agent from setup to useful work — native .5; 2026-10-29 16:49:19.943–16:57:04.231 | `2064abfafffae4b77bdff364c6746a513dbd6df01e165fbc5450e36bc71520da` | passed; experience ready; 38 steps |
| B | Antigravity .5 second turn on the fresh agent; 2026-10-29 16:58:08.303–17:00:24.774 | `d34c581a1875032634a6dc5eecff11a94a5f98319e9b555ae0898848957d6942` | passed; experience ready; 9 steps |

Both attempts disclose implementation knowledge. A corrected first finish call
followed a genuinely rejected completion citation; it remains a failed activity.
The native `.5` candidate fixed the earlier global error broadcast, so completed
file edit/read activities stayed completed. Raw instruction and session-load wire
receipts were not archived. The saved Instructions-only nonce and independent
downloaded bytes establish the resulting behavior; they do not manufacture those
missing receipts. No fresh Google OAuth took place in A or B.

Independent private observation followed each browser-only phase. The retained
two-turn summary has SHA-256
`2f4a4b06357fb5b0f1db4e7df10a287114f3a8b45f05f0bb4101cd7c0b8879aa`.
Its actual downloads were independently read again during conversion:

| Turn | Bytes / newlines | Download SHA-256 |
| --- | --- | --- |
| First | 61 / 1 | `e229f07be3a7c6835f91f9bd07f7daf4bd19f839c91f2fdd17161867750d4483` |
| Follow-up | 119 / 2 | `b1bca87da838f17535613f48932a40043b9e31a820a43e4c9740d619e3dfac05` |

That observation binds each attachment to its own run, the exact requested and
effective `gemini-3.8-flash-low`, the same full tagged native conversation, accepted
results, committed finalization, applied Done decisions and released leases. It
also records both owned Runner/sidecar process groups absent and the provider
lifetime fence acquired/released. The first Done decision was later explicitly
superseded when the user reopened the task. Its accepted-result/assessment/Done
lineage and captured first settlement remain valid; requiring the *current*
coordinator pointer forever to equal the first Done would reject a correct
follow-up. The initial overly strict audit failure is retained privately beside
the lineage-aware observation; it is not a new product repair or erased attempt.

Earlier evidence remains separate:

| Alias | Original scope/verdict | Log SHA-256 | Conversion treatment |
| --- | --- | --- | --- |
| P1 | Additional-agent picker/draft only; passed, needs improvement | `e1f89d1771a495d5c9220ab4a3eb48b7f4b010dd448ea1bf4e4cd024487d05d3` | Discovery evidence only; no task or full setup claim |
| P2 | Native Test failed; failed, needs improvement | `fa3b4c02aec713a55371b833172410da816ab1304a9f77c6cb3451c8de07f83d` | Retain package-owner mismatch failure; no task ran |
| P3 | Native .4 setup and first task; passed, needs improvement | `8d56f5bc6b77d627f4b01dea038ee4b42d2e8b42b4b1587bf266e3cf7ada2fc1` | Preserve stale paused composer and erroneous activity errors; readiness and per-call status regressions |
| P4 | Native .4 follow-up; passed, ready | `0474ef042f1430c210d5175d44b7c35a3e5e48b7338d4e74aa0ae3378c4988dc` | Historical .4 only; does not qualify changed .5 runtime |

## Actors, setup applicability and dependencies

The fixed Playwright driver replaces exploration. The product agent and Google
subscription are real. An independent observer checks public records, downloaded
bytes and native lifecycle evidence. No semantic judge is needed for exact bytes,
identity or lifecycle. Synthetic oracle/report controls are labeled synthetic and
perform no provider work.

The UI promise is portable where the same product capabilities exist. Current
native admission has a complete maintained Antigravity closure only on macOS
ARM64. Application hosting and runner environment are separate axes; `.local.`
names agent execution, not whether the application is Cloud-hosted.

| Setup | Product applicability | Implemented / selected | Actual evidence |
| --- | --- | --- | --- |
| Attached self-hosted development target, same-host loopback local macOS ARM64, saved personal Google subscription, exact low model | Applicable with trusted candidate admission, account reuse and native lifecycle capabilities | Selected explicit cell | A+B exploratory live pass on native .5; converted fixed-driver acceptance is a separate attempt |
| Compatible self-hosted staging target with the same local runner capabilities | Same user promise; revision, auth and target prerequisites differ | Remote observer/setup adapter gap; current observer requires same-host loopback | Not run; missing fixture is not an unsupported-product claim |
| Paperclip Cloud with an admitted local macOS ARM64 execution target and equivalent account route | Conditional applicability; actual service/target capabilities must be established | Current config restricts hosting to self-hosted; Cloud adapter gap | Not run; no Cloud qualification |
| Linux, macOS x64, Daytona or another remote target | Current native closure/admission unavailable for this case | Excluded from current execution cell | No platform/remote proof |
| Fresh OAuth, API key or gateway | Meaningfully different authentication/setup variant | Excluded from saved-subscription case | No fresh-auth proof |

Required prerequisites are an attached, exclusively assigned test company and
local environment, exact expected serving revision and deployment mode, a
dedicated signed-in browser profile, and a current trusted operator candidate
admission. Admission remains a server-startup responsibility. Agent configuration,
environment variables or test payloads cannot grant it. The harness checks the
effective target, native version, platform, profile and closure pins rather than
silently switching provider/model/host. Missing or expired prerequisites block
before measured work. It never restarts or resets the attached target.
The selected implementation requires the same-host loopback target to verify
native process retirement through kernel birth identities and all three public
checkpoint lifetime fences. It has no managed-local bootstrap adapter; existing
workspace ownership establishes the test drive before non-paying preflight. The
roster must already contain a nonterminated agent to exercise the additional-agent
entry rather than first-company onboarding.

| Dependency alias | Consumer / phase | Requirement and delivery | Ownership / cleanup |
| --- | --- | --- | --- |
| `browser-operator` | Browser driver; prerequisite | Existing company member with board agent creation/configuration, instructions, task and connection-use rights; dedicated signed-in QA profile | Supplied user/profile retained; exclusive profile lock |
| `google-subscription-owner` | Browser user and connection; prerequisite | Same user as browser identity; existing personal Google subscription and personal default grant, exact private connection binding | Shared saved credential/grant retained; no default change or revocation |
| `product-model-account` | Newly created product agent; measured binding | Existing connection selected through ordinary Google setup; normal managed credential delivery; exact low model | New agent owned by attempt; managed credential refresh remains product-owned |
| `native-candidate-authority` | Attached server/native admission; prerequisite | Approved version/profile/closure/platform/company/model and finite expiry through trusted startup | Operator owns renewal; never copied into prompt or agent configuration |
| `independent-observer` | Harness; observation | Same session's bounded authorized read APIs and owned-file download; local native evidence only where its declared target permits | Read-only; private evidence retained |

Expected MCP connections: **none** for browser driver, product agent, observer or
authoring conversion. Native product tools are not an MCP dependency. No mailbox,
new passkey, billing-management credential, external App or new OAuth registration
is required. Concrete identity/session/cookie/account/connection and target refs
stay in an owner-only private setup file and existing credential store, not in
tracked examples or public metadata. Readiness verifies the consuming identity,
same-user personal grant, selected native capability and accounting policy before
use. Existing auth may refresh normally; fresh consent is outside this case.

## Source-step disposition

`A` and `B` refer to the immutable logs above. Checkpoint names below describe the
contract rather than source step numbers. Waits become bounded assertions; source
timings are evidence, not sleeps. No measured agent/task creation moves into API
fixture setup. Every one of the 47 numbered steps appears once below.

| Source | Observed action/result | Phase / checkpoint | Disposition | Assertion / evidence |
| --- | --- | --- | --- | --- |
| A01 | Open test-drive root, initially loading | measured / dashboard | retain | Selected company dashboard is the entry |
| A02 | Dashboard loads, Agents visible | measured / dashboard | observation | Bound loading wait; ordinary sidebar route |
| A03 | Click Agents | measured / agent-roster | retain | Navigate through visible sidebar |
| A04 | Roster has New Agent | measured / agent-roster | observation | Correct roster creation control visible |
| A05 | Click New Agent; name required | measured / name-agent | retain | Visible dialog and disabled adapter action |
| A06 | Enter distinct name | measured / name-agent | retain | Attempt-owned name enables continuation |
| A07 | Choose adapter | measured / normal-picker | retain + recovery regression | Ordinary grid, Advanced collapsed; durable request identity before forwarding; response bound to future ID/creator |
| A08 | Scroll to Google card | measured / normal-picker | observation | Google Antigravity card outside Advanced |
| A09 | Select Google card | measured / select-antigravity | retain | Configuration action becomes enabled |
| A10 | Configure agent | measured / google-connection | retain | Google-specific connection choices |
| A11 | Find personal saved default | measured / saved-subscription | observation | Exact personal default binding and reuse control |
| A12 | Use saved subscription | measured / saved-subscription | retain | Ordinary connection reuse, pending state |
| A13 | Configure opens with low model and Local | measured / model-environment | observation | Exact selected low model/environment |
| A14 | Run real setup Test | measured / native-test | retain | Prompt-free native runtime check |
| A15 | Connection successful | measured / native-test | observation | Successful check and enabled Finish |
| A16 | Finish setup | measured / finish-setup | retain | Activate the same owned draft |
| A17 | Finishing; assignment disabled | measured / readiness | observation | Never call pending activation ready |
| A18 | Actual ready; assignment enabled | measured / readiness | observation | Same persisted agent becomes invokable |
| A19 | Open first composer; no paused warning | measured / first-composer | retain | Correct agent/model and no stale pause |
| A20 | Escape empty composer | measured / configure-before-work | retain detour | No task created before instructions |
| A21 | Open agent from sidebar | measured / agent-overview | adapt | Follow ordinary Agents roster and search the exact owned name; the recent sidebar list is bounded |
| A22 | Idle/configured; no runs | measured / agent-overview | observation | Same owned Google agent and exact model |
| A23 | Open Instructions | measured / instructions | retain | Entry AGENTS.md and edit controls |
| A24 | Edit existing entry text | measured / instructions | retain | Preserve default instruction text |
| A25 | Add instruction-only marker | measured / instructions | retain | New nonce supplied only in instructions |
| A26 | Save changes; saved state | measured / instructions-saved | retain | Persisted instruction, no unsaved state |
| A27 | Assign Task from agent | measured / task-composer | retain | Same ready agent/model, no pause |
| A28 | Ask for configured marker, omit its value | measured / first-task-prompt | retain | Prompt cannot supply expected first-line bytes |
| A29 | Create task | measured / create-task | retain | Capture exact owned task immediately |
| A30 | Open Recent Tasks entry | measured / open-owned-task | retain | Follow visible newly created task link |
| A31 | In Progress / native work | verification / first-working | observation | Same task/agent; bounded start |
| A32 | Actual 61-byte result card arrives | verification / first-delivery | observation | New attachment correlated to owned first run |
| A33 | Open actual file; first finish rejected | verification / first-file | retain + recovery regression | Read/download actual bytes; preserve genuine rejection |
| A34 | Expand history after finish rejection | verification / activity-status | adapt | Open ordinary More messages when saved history is compacted, then expand activity; match actual native `tool_call`/`tool_result` (`kind: tool`) and canonical `provider_activity` rows while retaining A36 per-call attribution |
| A35 | Done after corrected finish | verification / first-settlement | observation | Own accepted result, committed finalization, applied Done |
| A36 | Completed edit/read, only actual finish failed | verification / activity-status | observation + recovery regression | Completed tools stay completed; do not force live rejection |
| A37 | Reload first result | verification / first-persistence | retain | Durable navigation boundary |
| A38 | Done and actual file survive reload | verification / first-persistence | observation | Exact visible task status plus independent saved bytes |
| B01 | Begin from same completed task | measured / follow-up-entry | retain | First settlement/output preserved before next trigger |
| B02 | Enter preserve-first-line/append-new-line request | measured / follow-up-prompt | retain | New nonce only; original marker not repeated |
| B03 | Send; task reopens/queues | measured / follow-up-send | retain | Same task and agent; exact new run bound |
| B04 | In Progress; existing file read | verification / follow-up-working | observation | Same native conversation; prior file read evidence |
| B05 | Second Done and new attachment | verification / follow-up-settlement | observation | Own accepted/committed Done lineage |
| B06 | Open actual 119-byte file | verification / follow-up-file | retain | Distinct second attachment, both exact lines and bytes |
| B07 | Reload final result | verification / final-persistence | retain | Durable second navigation boundary |
| B08 | Done and updated file persist | verification / final-persistence | observation | Same task, updated actual file, no stale first artifact |
| B09 | Scroll to latest result/viewer | verification / final-result | observation | Final checkpoint image and actual download, no prose-only pass |

## Acceptance, ownership and execution bounds

The observer is armed before each UI mutation and journals immutable owned
agent/task/run/artifact IDs as they become available. It rejects a wrong company,
agent, task/run, stale first artifact, empty file, missing proof, model mismatch,
conversation mismatch, uncommitted completion, pending lease or uncertain
retirement. Exact synthetic pass/fail/missing-evidence controls calibrate the same
oracle and normal report importer. Visible status checks target the exact task's
property; hidden menu items, SVG titles and narrative “Done” cannot pass them.

The first line derives from a fresh attempt nonce saved only in Instructions;
the second line derives from an independent follow-up nonce. Expected bytes are
computed by the observer. Fixed historical 61/119-byte sizes are source evidence,
not fixture constants for different nonce lengths. Each download must be bound
to its own task/run and actually match the independently computed content/hash.
After each turn, accepted native result, committed finalization and applied Done
decision lineage must agree. Same conversation does not require same physical
daemon: the source retired the first owners and resumed with fresh owners.
The native Runner instance ID is session-scoped in the recorded `.5` runs.
Freshness therefore compares each independently observed primary Runner PID and
OS birth identity, with its exact run and `per_turn` argv verified; changing only
a sidecar or journal digest cannot satisfy that gate.

Exactly two task work turns/runs are admitted in one selected case and one
attempt, with finite whole-attempt/per-turn deadlines, no automatic retries and
the startup authority's TTL. `budgetCents` (at most 1,000) is an observed known-cost
stop threshold, not a hard currency cap. It cannot cap missing prices, unknown
subscription charges or already in-flight usage. The fixture creates no agent
budget policy or QA override: the operator's existing policy and the new agent's
inherited policy remain unchanged. Current budget incidents, held charges and
unpriced-usage rules retain their authority; the fixture does not clear flags,
resume repeatedly or weaken policy. Native Test is a zero-turn
account/model/retirement probe; an unexpected inference edge or extra task run
fails the bound and remains in accounting. Measured token usage and missing
prices survive packaging as unknown cost rather than free work. No recurrence
is requested.

Supplied company, environment, browser user, saved Google connection and default
grant are retained. The ordinary draft POST is forwarded unchanged only after
its safe identity subset is durably journaled: future setup ID, company/name,
origin, intended harness and preflight creator. Serialized private temp-file
fsync, atomic rename and directory fsync keep later interruptions from truncating
that identity. A lost response can be recovered only by exact-ID and creator
readback with unique company/name binding; pending 404 stays unconfirmed. No
historical source request is inferred or reconstructed from a later agent row.
The new measured agent, task and any owned active work are journaled incrementally.
Teardown cancels/stops only owned work, waits for
settlement and physical retirement, then removes or pauses/retains the owned
agent as declared. Retained task history is inspectable; it does not authorize
future dispatch. A forced interruption retains a private ownership receipt for
the existing recovery command. Cleanup failure stays separate from the primary
failure; late cleanup writes a new receipt without rewriting the failed attempt.
An authoritative cancellation before native selection has a separate no-launch
receipt: settled preparation, explicit absence of native ownership, settled
accounting, and the exact environment lease's concrete release time. A lease
marked expired is accepted only for this no-launch variant when its release
precedes preparation settlement. Native success still requires released lease,
captured process births, absence of all owned processes and all three fences.

## Integration and handoff record

The registered catalog/profile/case, measured Playwright flow, independent
oracle and result integration belong in `tests/runner-e2e`, alongside existing
provider-connection target/browser helpers. This is a separate suite because the
existing connection suite requires **fresh** credentials; changing that invariant
would mislabel saved subscription reuse. No second runner, report schema,
dashboard or scheduler is introduced. Private setup/native evidence uses the
existing retained-attempt boundary. Authenticated setup images are never marked
public-fixture screenshots.

Mapped capabilities require actual assertions: `agents/hire`,
`agents/instructions`, `runs-adapters/validation`, `runs-adapters/session`,
`tasks/create`, `tasks/completion`, `documents-artifacts/attachments` and
`documents-artifacts/work-products`. Visiting other surfaces adds no coverage.
The runbook records exact discovery, credential-free calibration, readiness,
run, normal report and owned-resource recovery commands. Fixed-driver live
attempts, serving/driver/report revisions, actual setup, failed attempts, tokens,
unknown prices and cleanup are separate from the historical A+B proof.

Delivery state: source recovered, original logs validated, decisive images and
actual retained file bytes inspected; conversion implemented in the accompanying
case. Credential-free results and any fresh live attempt are recorded in the PR
and normal attempt artifacts. Historical A+B qualifies only its declared
attended local candidate scope. Other hosting/auth/platform cells remain unrun.
