# Grok Bot production readiness

Status: implementation and qualification in progress. Actual client OAuth and a routine wake with an exact chat acknowledgement are observed. The candidate has local authenticated challenge receipts, real Rust assigned-work/file/finalization tests, and durable proactive-intake tests. Deployed two-way work acceptance remains a release gate.

## Candidate and release contract

The production candidate started at `origin/master` commit `833769ab557255b11dd8f650f43ed7333653f5e4` and incorporates master through `e0f30a4c71` in the managed `codex/grokbot-production` worktree. The complete earlier prototype is preserved in snapshot `e0a8150ca248c1b80c58a7e26c10ccda9951907b`; its October 2 test results are historical, not evidence for this candidate. Reuse its provider-specific work where appropriate. Do not import its old gateway baseline, migration numbers, independent session coordinator, or retired UI entry point wholesale.

Use `.agents/skills/create-external-bot-integration/SKILL.md` and its release, Runner, onboarding, conformance, and deployment references. The user selected an existing staging tenant for acceptance; its hostname and verified stack identity are recorded in the private qualification environment manifest. Cloud permits one company per workspace. The user chose a dedicated synthetic qualification project in the selected existing staging company, and authorized a new Bot because Night Shift’s old web link is unavailable. Use the new Paperclip Qualification Bot and one identifiable app/ingress/Runner candidate. Preserve existing tasks, agents and connections.

| Area | Required release behavior | Evidence / current state |
| --- | --- | --- |
| Bot identity | New Paperclip Qualification Bot for acceptance; one Bot to one Paperclip agent; fixed company, agent, client, resource, authorizer, and binding generation | New Bot and temporary fixed agent grant observed; production provider binding implemented and locally tested; not deployed |
| Entry point | Agents → Invite an external agent → Grok Bot; existing shared invitation, copy-prompt component, role/manager controls, Back and Save & exit | Grok preset, persisted setup and secure credential fields implemented; rendered Storybook journey inspected |
| Setup | Copy a complete prompt, approve scoped OAuth, create a webhook-only routine, copy its desktop URL/key into secure Paperclip fields, watch both checks, Done | No terminal or config edits; account-wide plugin access disclosed |
| Outbound / inbound | Supported routine webhook / authenticated agent-purpose remote MCP | Historical outbound observed September 30; current desktop OAuth, authenticated reads, continued access, revocation and reconnect observed; one current routine wake and exact chat acknowledgement observed; candidate’s authenticated receipt pending in the real client |
| Idle work | Bot starts governed work without a placeholder task or echo assignment; can create/assign an authorized task to its responsible human | First production milestone alongside assigned work |
| Cloud placement | Ordinary managed Rust Runner per admitted assignment, reused across messages/tools; no compute for idle connection/readiness traffic | Must prove shipped Linux artifact, configured environment, lease and cleanup on the selected tenant |
| Native capabilities | Bot retains its relevant native browser/apps/skills; Paperclip permissions govern Paperclip calls | Public-source native-tool case required; no new third-party grant solely for testing |
| Paperclip capabilities | First-party context, identity/people, authorized search/coordination, progress, questions, documents, output files and canonical completion/review | Share native operations, receipts and authority; do not maintain a second broad tool executor |
| File powers | Output artifact publishing through bounded task/assignment grants; input attachment access explicit; Paperclip workspace and shell access deferred | Cannot read Grok's filesystem or inherit file/workspace grants from connection pairing |
| Lifecycle | One active assignment; duplicate/lost-response reconciliation; read-aware follow-ups; durable waits; real restart recovery; stale calls fenced | Require run/session/assignment/controller/lease/process evidence |
| Stop | Revoke Paperclip work authority and future dispatch; account for managed Runner cleanup; remote Grok activity remains unknown | “Stop Paperclip work” and “Open Grok”; no claim of global Bot termination |
| Economics | Recorded budgets gate admission; Grok usage/spend unknown; managed Runner cost separate | Never report zero Grok cost or promise control over its billing |
| Distribution | Experimental private connection on authenticated HTTPS instances and Cloud | Localhost relays, internal Grok APIs and public marketplace distribution remain deferred |
| Qualification bounds | One active Bot assignment; short synthetic tasks; no paid soak; bounded attempts and explicit resource ownership | Start with at most six principal task cases and twenty webhook invocations; inspect ambiguity before another send; pause to review any additional spend or scope |

## Architecture decision

Adapt the merged external-agent Rust Runner lifecycle used by Dot, retaining provider identity as `grok_bot` and preserving `openai_dot` behavior. Grok-specific code owns Bot URL validation, routine secrets, wake dispatch and provider instructions. Shared code owns agent-purpose OAuth/pairing, admission, durable mailbox/operation receipts, authority, canonical completion, finalization and managed recovery.

On Cloud, reasoning remains at Grok while the admitted Rust Runner uses the configured managed execution environment. Do not run the assignment coordinator on the control-plane host as a fallback. Self-hosted local Runner placement follows the existing explicit local configuration. A sandbox containing Runner does not confine Grok's native computer or apps, and does not grant it workspace tools.

Reuse `/mcp/runner` and its agent-purpose issuer where the current protocol supports the fixed Grok binding. Keep personal `/mcp/paperclip` grants separate. Preserve existing Dot tool/API compatibility while adding a truthful Grok/provider-neutral presentation. Extend the actual negotiated backend and artifact capability contract; a TypeScript-only reference driver is not production Runner evidence.

Persist a routine dispatch intent before network activity. Send references, generation and correlation IDs only; retrieve authoritative content over MCP. Store URL/key through company secret storage. Apply public HTTPS/DNS/redirect policy, bounded timeouts and redaction. Authenticated readiness acknowledgement is distinct from HTTP acceptance. Lost or uncertain delivery requires reconciliation and never an automatic second invocation. Do not assume Grok can implement Dot's signed MCP Events subscription protocol.

Persistent agent authorization permits idle contact. Task effects additionally require the admitted current assignment and run/turn; shared checks enforce private-task visibility, responsible-user access, pause, reassignment, current grant, governance and recorded budgets. Use stable operation IDs and argument digests, current generation checks and durable receipts. Do not manufacture a native identity or use a board/person grant to satisfy Runner checks.

Normal comments need the shared read-aware wake protocol: retain the ordinary deferred wake until the active assignment reads that exact comment. Preserve unread comments at completion; consume read comments once. Test input replies, new-session requests and self-authored messages separately. A webhook or inbox acknowledgement alone is not proof that feedback was read.

Use current lease-renewal and durable waiting paths. Distinguish pairing-code, access-token, persistent grant, assignment and dispatch lifetimes. Do not repeat the prototype's arbitrary one-hour work-session expiry as an undisclosed human-input limitation. Expired or revoked authority denies effects; unknown remote work keeps its recovery hold before another assignment.

## Delivery sequence and finish conditions

| Gate | Work and concrete exit condition | Owner / evidence |
| --- | --- | --- |
| P0 — current candidate | Preserve snapshot, start on current master, inspect actual staging serving revision and current Cloud ingress/Runner support; record one credential-free environment manifest | Codex; branch, revisions, public origin, owned resources |
| P1 — provider boundary | Fresh scoped connection, actual Grok read tool, token refresh/reconnect, harmless routine → authenticated MCP challenge; verify tools are callable in Night Shift | Codex + human at required provider consent; real ingress/OAuth/ack receipts, no work task or managed job |
| P2 — governed vertical slice | Assigned task and idle intake both pass through the real Rust Runner and normal finalizer; one task/run/assignment, first-party document saved/read back, no self-dispatch loop | Codex; real provider and actual Rust/DB evidence kept distinct |
| P3 — onboarding and capabilities | Shared invitation Grok preset, supported generated prompt and secure routine setup; persisted Back/Save & exit, automatic safe pending-code renewal, real lifecycle/readiness states, Done; questions, output files and native tools | Codex; existing UI components, Storybook states, real rendered transitions and artifacts |
| P4 — reliability | Duplicate/reordered delivery, ambiguous effects, completion follow-up race, durable input/dependency waits, real controller restart, stale authority, stop and cleanup pass | Codex; compare original run/session/assignment/binding/controller/Runner fingerprint/lease |
| P5 — review candidate | Focused auth/protocol/Runner/UI tests, full required checks, maps/token/Storybook checks and PR review green on one frozen candidate; compatible packaged Runner artifact | Codex; PR template, exact head/checks and immutable artifact digest |
| P6 — deployed acceptance | Selected staging tenant serves candidate app, ingress and ordinary configured managed Runner image; fresh onboarding and both work directions pass without chat nudges or manual repair; cleanup accounted for | Codex; actual qualification Bot campaign, screenshots/private evidence, run/document/artifact links and provider deletion receipts |

The next critical gate is the remainder of P1. Scoped staging prerequisites, a temporary agent grant, the new Bot and its webhook-only qualification routine were explicitly approved. The temporary shared Dot gateway is client interoperability evidence only; it is not a production Grok provider or a passed Runner acceptance test. Keep the endpoint/data alive while the user/Bot tests it, and announce any intentional shutdown with resumption instructions.

## Acceptance campaign

Use the skill's C01–C10 evidence format, one row per candidate/case. Record PASS, FAIL, BLOCKED, UNVERIFIED or NOT_APPLICABLE; list every operator nudge, app reattachment, consent, simulated dependency, manual call and repair.

- **C01 fresh setup:** enter the normal invitation UI; actual read, OAuth renewal/reconnect, routine challenge, fixed identity, Done and refresh persistence. Saved setup, expiry, incorrect routine credentials, outbound-only success and revoked access must remain truthful.
- **C02 assigned useful work:** normal task with a fresh nonce → autonomous acceptance → progress → question/answer → report document and bounded output file → completion/review. Check bytes/hash, revisions, canonical result, disposition and cleanup.
- **C03 idle work:** from no assignment, Night Shift creates governed intake and an authorized task assigned to its responsible human. No placeholder, duplicate task/run or echo wake. Same ID replays before/after completion; changed arguments conflict; admission failure settles visibly.
- **C04 native capability:** use a public synthetic source through Grok's existing browser/native tools and save a useful result. End transport-only test restrictions explicitly. No implication that Paperclip's catalog disables those tools.
- **C05 restart/follow-up:** accept, capture identities, restart the owned controller and prove its identity changed; ordinary comment resumes the same assignment/session/Runner. Test read-before-finish and unread-at-finish races. Simulated recovery is separate evidence.
- **C06 stop/authority:** stop, pause, reassignment, membership loss, grant revocation, refresh replay and stale callbacks deny effects; fence/reconciliation and managed resource cleanup are inspectable. Remote Grok activity remains unknown.
- **Additional protocol cases:** concurrent claims/queues, callback destination policy, mutation response loss, mailbox cursor concurrency, lease renewal, missing completion/checkpoint, artifact corruption/limits and cross-company/private-task access.
- **C07–C10 deployed contracts:** no idle compute, one managed Runner reused per assignment, incompatible artifact rejected before offer, allocation/admission failures settled, real tenant ingress and shipped images validated.

## Validation and release disposition

Reuse `server/src/__tests__/dot-runner.test.ts`, current Runner protocol cases and Product E2E fixtures, adding provider-specific regressions rather than a parallel harness. Read the current eval skills before extending their contracts. Use the actual managed fixture only after inspecting its current cost bounds and `finally` cleanup. Scripted MCP/managed successes do not qualify Grok's tool loading or wake behavior.

Before review-ready handoff run `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`, UI token gates, relevant map checks, Storybook catalog/build and guided browser checks. Do not commit `pnpm-lock.yaml`; current repository policy assigns it to CI. The prototype's old broad-test failures are retained history; they are neither current failures nor a current green aggregate result.

Inspect current private Cloud runbooks and serving versions. Reuse existing tenant `/mcp/runner` routing first; change ingress only for a demonstrated missing route/auth behavior. Keep private Cloud source and qualification secrets out of public plans/PRs. Record the app image, ingress SHA, Runner digest, configured managed environment and resource receipts. A local binary override is not proof of the shipped managed image.

Production ready means one reviewed candidate, required checks green, the named staging deployment and shipped Runner verified, the ordinary C01/C02/C03 journeys witnessed with the approved qualification Bot, required recovery/capability cases passed, and all resources released or intentionally retained with an owner and resume path. Report review-ready, merged, staged and canary-verified independently. Fleet-default enablement and a production-wide rollout require their own explicit authorization.

## Provider sources checked October 13

- [Grok Bot custom connectors, vendor support](https://forum.cursor.com/t/grokbot-custom-connectors/169965/5): a chat request adds a publicly reachable custom MCP server. Actual desktop OAuth and authenticated reads were observed. Continued access beyond the initial token lifetime was observed; token rotation receipts and routine callbacks remain unverified. The separate Grok chat app’s connector documentation does not establish Grok Bot support.
- [Grok Bot routines](https://cursor.com/help/grok-bot/routines): bearer-authenticated JSON POST is documented; HTTP 200 is acceptance, not completion. Missing/ambiguous transport evidence remains uncertain.
- [Grok Bot plugins](https://cursor.com/help/grok-bot/connect-plugins): plugin connections belong to the account and are available across its Bots; installation is not proof of authenticated runtime access.

There is no verified production API in this record for resetting Night Shift's remote memory, stopping all its execution, streaming its full transcript, or reporting its spending. These remain unavailable claims until supported provider evidence says otherwise.

## Current execution record

- The production worktree is on the fetched master baseline above. The old implementation is recoverable from its complete saved snapshot; it has not been represented as upgraded production code.
- Exact Node 24 / pnpm 9 workspace installation succeeded with a frozen lockfile. No lockfile change was made.
- The selected staging stack's Primary host was verified through its signed-in admin detail page. It currently follows fleet releases, so an immutable acceptance candidate will need an explicit per-tenant pin.
- Public agent resource and issuer discovery returned HTTP 503 with “Assistant connections are disabled.” The signed-in tenant UI is usable; network access and provider compatibility have not been blamed for this configuration gate.
- Approved prerequisite overrides were applied to exactly the selected stack. One canary campaign succeeded; desired/applied configuration hashes converged. Agent resource and issuer discovery subsequently returned HTTP 200.
- Cloud’s company-create endpoint rejects tenant-side creation. The user selected a dedicated test project in the existing company. That project was created without repository or third-party app access.
- Night Shift’s original browser URL returned Page not found. At the user’s request, a new Paperclip Qualification Bot was created through the running Grok Bot desktop app. Existing Bots were preserved.
- The actual Bot added a private remote MCP connection through chat and completed OAuth through the current Cursor client. A one-use operator invitation fixed the company and agent in the consent preview; no persistent credentials were copied into chat. Paperclip shows the temporary agent connection as established, and the Bot’s inbox read returned its binding generation and an empty inbox. This was assisted setup, not prompt-only onboarding.
- The temporary protocol agent is labeled Grok Gateway Qualification / Temporary Grok client interoperability test, with the shared Dot provider. Attachment and workspace powers are off. Readiness still requires a verified wake and acknowledgement; no readiness flag or subscription was faked.
- The Bot saved Paperclip MCP Qualification as a webhook-only routine. Its detail row and search result only focused the Routines section during computer use; the documented Bot-generated Webhook URL navigation link opened the fields. Credentials were saved privately, and one guarded routine test returned HTTP 200 and an exact nonce acknowledgement. No real work task, managed job or candidate deployment has been initiated.
- The new candidate’s narrow routine transport uses the existing DNS-pinned public-network guard, closed reference-only payloads, redacted outcomes and single-send behavior. Its transport and existing public-network guard/rebinding regressions pass: 77 tests across three files. Server typecheck also passes. It is now wired into durable dispatch, the shared agent authority/Runner and setup UI. Full repository typecheck, production build, token gates and Storybook build passed before the latest baseline update; final checks and deployed acceptance remain outstanding.


## Updated provider access contract

The current verified client surface is the **Grok Bot desktop app**, signed in with its Cursor account. Do not use the unrelated Grok chat custom-connector UI as a substitute. The observed setup starts with a chat request to add the public MCP URL, followed by an Authorize card and browser OAuth. Record app version and verify the generated prompt against this actual flow before calling setup self-serve. The observed client is Grok Bot 0.70.2, built October 11, on its stable track; its update settings reported up to date.

Do not require a working `grok.com/bot/...` URL for onboarding when the current provider no longer exposes that surface. Bot identification must support its displayed name and a provider-supported link only when available. “Open Grok” needs a supported app handoff or clear desktop instruction; the old dead browser URL is not a recovery action.

The existing Dot readiness contract requires its authenticated MCP Events callback verification. A Grok routine’s HTTP 200 cannot satisfy that contract. The Grok transport must own a distinct routine wake verification, durably acknowledge its challenge through the bound agent grant, and then enter the shared external assignment lifecycle. Preserve Dot’s actual event-subscription checks unchanged.


## Current P1 evidence and remaining gate

| Claim | Observed evidence | Scope / limit |
| --- | --- | --- |
| Fresh custom agent OAuth | Actual Grok Bot Authorize card, current Cursor client consent, fixed company/agent preview, paired connection persisted in Paperclip | Temporary shared gateway; assisted setup; production Grok provider not enabled |
| Callable authenticated tools | Actual inbox response; subsequent capabilities returned the agent name changed only in Paperclip and `ready: false` | Native client response plus persisted binding/configuration; no admitted task |
| Continued authorization | Capabilities call succeeded after the initial 15-minute token lifetime without a new consent step | Supports client renewal; token endpoint/rotation receipt not independently inspected |
| Revocation | Paperclip revoked the temporary connection; real stale inbox attempt returned authentication-required and no data | Current connection boundary only; no task mutation/reassignment test yet |
| Reconnect | Fresh one-use invitation and consent for the same agent; real read returned a replacement binding and empty inbox | Existing plugin reused; old binding revoked; operator-driven test |
| Routine wake | Vendor-confirmed desktop row-click regression; Bot-generated Webhook URL navigation link opened the panel. One guarded invocation returned HTTP 200 and the exact nonce reply | Operator workaround required; chat acknowledgement is not a persisted authenticated nonce receipt in Paperclip. One of twenty permitted webhook calls used |
| Current source checks | Local authenticated MCP challenge, Rust task → document/file → finalization, proactive intake/deduplication, and renewed-session recovery tests pass. Repository typecheck, build, token gates, maps and Storybook build pass | Source candidate is not deployed; complete final suite and candidate-bound real managed acceptance remain required |

Do not promote the temporary shared Dot connection to ready or substitute its event subscription with an unverified Grok webhook. The remaining P1 gate is the candidate’s durable authenticated challenge acknowledgement through the actual Grok client. Assigned work, idle intake, restart and managed cleanup still require real deployed acceptance. Local tests use scripted clients and synthetic storage; they do not count as provider acceptance.

## Current implementation evidence

- Separate `enableGrokBot` gate defaults off. Existing Dot event readiness and person MCP behavior remain distinct.
- Shared Rust external backend identifies `grok_bot_mcp`; session completion does not assert remote termination, transcript streaming or usage accounting. Existing native provider identity guarantees remain required.
- Routine URL/key are one immutable encrypted secret version. Closed reference payloads, DNS-pinned public egress, no redirects, durable single-send intents and authenticated nonce receipts distinguish delivery from reply.
- Recovery holds span old bindings. Inspection cancels uncertain intents and requires re-verification; stop fences session authority before cancellation, without a global Grok stop claim.
- First-party native operations, deferred feedback and proactive admission reuse existing ownership, receipts and finalization. File grants bind current company/agent/assignment/grant and exact bytes; they use existing artifact storage.
- Guided setup and management include resume, fixed consent identity/authorizer, account-wide plugin disclosure, both verification checks, observed contact, queued work and recovery. Pairing codes remain in browser authorization; routine credentials never enter chat instructions.
- The latest upstream fetch advanced beyond the original baseline. Integrate it and regenerate the unshipped migrations before freezing a review candidate. The newer baseline resolves the earlier unrelated Storybook catalog drift; the reconciled catalog passes structural checks, with no new runtime-proof claim.
- Cloud’s current ingress allows the existing agent protocol but needs exact GET/PUT exceptions for bounded file tickets. Extend the current Cloud baseline in isolation and test header stripping and denied adjacent routes. No Cloud primary edits or fleet-default change are authorized or required.

The Grok routine is still a **transport-only qualification** routine. Explicitly replace those test instructions before actual assigned/proactive work; retain Grok’s own authorized native tools. No real client work, Linux managed Runner artifact or deployed candidate has been qualified yet.

## Review and environment changes — 2026-10-13

The app and supporting Cloud ingress candidates are open as draft PRs. The first app review found task-summary privacy, deferred-feedback durability, settled-delivery reconciliation and stale Stop targeting gaps. The corrections use the existing task privacy predicate, keep comment admission independent of routine egress, close notification obligations only on canonical successful finish, and pass the displayed run to Stop. Recovery records distinguish dispatch uncertainty from revoked work; a late reply cannot clear a work-session hold or restore task authority. OpenAPI setup contracts and feature-card ordering are synchronized.

The guided story now uses Night Shift's production task thread, question form and document card with synthetic local callbacks. Incorrect credentials can be replaced from saved setup. This proves UI behavior only.

Cloud master has introduced a separate Test environment for branch experiments. Staging now admits only master-derived app and schema revisions; the previous pre-merge staging harness override is retired. The selected staging tenant remains the authorized destination, but a pre-merge candidate cannot be forced onto it. Candidate testing must either use an explicitly authorized Test workspace/harness or wait for reviewed master changes. Do not change the staging guard or fleet default to bypass this constraint.


## Candidate checks and review corrections

The candidate passes repository typecheck, production build, token gates and the Storybook build. The saved-setup retry and pre-assignment Stop regressions pass. The shared provider descriptor schema accepts Grok and rejects invented native process identity. Copilot's versioned source declaration advances to v18 because that shared schema changes; v17 remains immutable, all pinned source hashes are checked, and Copilot qualification remains pending. Current-head full CI and review remain release gates.

The supporting Cloud ingress candidate passes typecheck, routing smoke and its full suite (3,339 passing, 93 optional skips). Current-head review is 5/5 with no open findings. Neither candidate has been deployed. The actual-client evidence remains one routine HTTP acceptance and matching chat acknowledgement; candidate-side authenticated acknowledgement and the six bounded principal journeys are outstanding.


The next review corrections apply the native deliverable catalog's current work-mode policy to upload-ticket issuance and use. Confirmed rejected deliveries have an explicit operator retry; each retry retains the prior receipt, reserves one idempotent new intent and rechecks binding, grant, routine revision and work-session authority. Unknown or accepted delivery remains single-send. Thread Stop uses the selected run and its agent. Recovery locks all of the agent's current and retired bindings before routine rows. Historical Copilot v17 inputs remain decodable while new launch admission stays pinned to v18.

The focused rendered UI regressions pass (144 tests), as do OpenAPI route coverage (21 tests) and Runner contract/integrity/history checks (82 tests). The current server fixture attempt could not initialize PostgreSQL because the host exhausted its shared-memory slots; no server-test pass is inferred from that attempt. Clean-worker CI must execute the file-policy, rejected-feedback and lock-order regressions before hand-off.


## October 14 setup qualification follow-up

The merged candidate passed source checks and was deployed to the approved staging
workspace. The natural Grok picker and Save & exit recovery were observed there.
The actual Grok desktop client reused its custom MCP plugin and opened the shared
agent authorization flow with its registered Cursor client identity.

Setup stopped before granting access: the masked pairing field lacked a Copy
button, and the pending authorization action still named Dot. Add an explicit
Copy code control through the shared clipboard helper, keep the code masked and
out of setup prompts, and use a provider-neutral approval action. Preserve the
fixed company, agent, authorizing person and permissions preview. Requalify the
rendered copy and authorization path on the deployed follow-up candidate before
running work cases. This is not yet evidence of an authenticated candidate reply
or a completed managed Runner journey.


## October 14 — live file-completion correction

The deployed real Grok client completed agent OAuth, renewed its rotating refresh
token, acknowledged a readiness challenge, accepted an ordinary assignment, and
asked a two-choice question. The human selected setup simplicity. Two continuation
sends received HTTP 400. Explicit inspection, recovery and re-verification let the
same task continue without a Grok chat work nudge.

The Bot saved a 421-word comparison document and a CSV with three rows. Canonical
completion rejected the file because the authenticated upload did not persist the
verified native publication receipt. The real managed run later exited unexpectedly;
its precise cause remains under investigation. All three managed leases have
successful cleanup receipts. These observations are failed acceptance evidence,
not a passed release campaign. Private records retain task, run, assignment,
OAuth lifecycle, dispatch, lease, artifact and completion-feedback references.

The follow-up records a server-owned external publication receipt in the same
transaction as a verified file upload. Completion checks the receipt against the
actual upload, assignment and exact stored metadata. Personal uploads do not gain
agent authority. The real Rust regression now requests a file and must pass the
normal semantic finish and finalization paths with that file's evidence. Deployed
requalification, proactive work, actual controller restart and active-session stop
remain required before the release contract is complete.

The deployed Stop action also rejected the lingering assignment after the managed
run had failed. The follow-up permits a fence for that exact terminal run's active
assignment, while stale Stop calls cannot touch successor work. Known remote
Runner lease/reconnect failures retain a closed diagnostic code; raw stderr and
transport credentials stay out of that error. Qualification access was revoked
while the correction is reviewed. No successful active-session Stop or restart
qualification is inferred from this cleanup.

The upload/document overlap regression uses the real admitted Rust Grok work
session, native document authority, and authenticated HTTP upload. With the
original run-before-task upload order, the upload returned 503. With the shared
task-before-run order, both writes and their durable receipts committed, and
normal file completion passed. This is protocol evidence; it does not replace
the remaining real-client acceptance gates.

A second overlap regression uses an actual admitted Rust Grok session and holds
the upload's storage response while disconnect runs. The former assignment-first
order prevented disconnect from completing. Preliminary upload access now stays
read-only for agent sessions; publication acquires the grant before retaining
assignment authority. Disconnect completes while storage is pending, and the
late upload returns 403 with no attachment or publication receipt. Person write
checks remain in place. The full repository command was interrupted when this
new review finding arrived; its partial output is not a passing test result.
