# Personal Muse on the shared external Runner

Date: 2026-10-10. Implementation architecture; experimental and disabled by default.

This refines [the accepted product plan](2026-10-09-muse-on-shared-external-runner.md) against origin/master `19e9facc5bd459ab790d53373612cfde1a2c9ec3`. It connects the personal Meta Muse, not Muse Code. The old experiment remains stopped. Its four replies establish connectivity only.

## User outcome and caller usage

An operator chooses “Muse — Personal agent,” supplies name/role, and copies a short-lived setup instruction into their current Muse conversation. Muse approves the Paperclip hostname through its own UI, installs a small private client and managed detector, and exchanges the ticket itself. Paperclip shows paired, receiver detected, and independent background reply verified as separate evidence. Existing hiring approval and lifecycle readiness remain required. A normal assigned task uses the native Runner, existing questions/documents/deliverables and finalizer. Idle Muse can identify/read its permitted company work, create tasks and comment with named-agent attribution.

```ts
// Transport owns parsing/authentication, not lifecycle decisions.
const subject = await museIdentity.authenticate(request);
return externalAgents.act(subject, decodeMuseCommand(request.body));

// The existing queue still owns issue -> wake -> run locking and claim policy.
await withExistingQueueClaimLocks(tx, async () => {
  return withExternalAdmissionGuard(tx, companyId, agentId, async () => {
    await assertNoExternalOverlap(tx, companyId, agentId);
    return commitExistingQueueClaim(tx);
  });
});

// The native question bridge retains its actual session signature.
await session.resolveRuntimeRequest({ requestId, turnId, resolution });
// requestId is the native runtime request ID, NOT question_<interactionId>.
```

The installed client exposes safe, durable work/open, operation/receipt, ask/answer and completion commands. It journals stable request IDs before network calls and exact receipts before returning success. Completing work first obtains the native paperclip_finish/paperclip_block receipt, then submits exactly that canonical report to the external finish operation.

## Synthesis decision

Two independent whole-shape sketches compared a transactional domain broker with a pure reducer/effect-shell architecture. Root review preferred the broker 4.15/5 versus 4.075/5; a separate cross-judge preferred it 3.60/5 versus 3.50/5. These measure design preference, not implementation confidence. Both sketches used the same candidate model; only judgment used a different model. No sketch or synthetic fixture qualifies personal Muse.

Choose the deeper transactional broker boundary, with closed Dot/Muse storage adapters and a shared native external-provider engine. Graft separate worker uncertainty and native-effect uncertainty barriers from the alternative. Reject a universal reducer/effect DSL, relocation of ordinary scheduling into the broker, duplicated generic outboxes and a second question bridge. Private effect inventory cannot be certified by a client that does not observe Muse's own tools.

## Boundaries and ownership

- `server/src/modules/external-agents/`: public act/inspect/attach/stop domain boundary and closed provider storage policies. Dot's existing service export is a compatibility facade. Identity, receiver transport and ordinary scheduler remain distinct owners. Routes cannot import private storage helpers.
- `packages/paperclip-runner/`: one TS driver and one Rust external execution engine. Thin provider wrappers/codecs retain deployed Dot identities. No URL, connection token, cookie, signal poll or task callback enters Runner.
- `server/src/services/muse-identity.ts`, `muse-receiver.ts`, `muse-invitations.ts`, `routes/muse.ts`: ticket/access/refresh/cleanup identities, opaque receiver signals, existing hire/lifecycle setup and bounded transport.
- `packages/shared/src/muse-protocol.ts`: finite versioned wire contract and exact public route manifest. `muse-invitations.ts`: shared nonsecret UI DTOs. Provider/tool profiles are closed positive lists.
- Existing native question bridge/response outbox owns question cards and saved answers; existing queue owns task/run admission; native finalizer alone completes work.
- Existing external invitation components/settings own UI. No separate Muse wizard or human MCP identity.
- Cloud owns exact tenant protocol ingress only. It strips spoofable identity headers and never implements agent authorization or uses a local control-plane Runner fallback.

Use explicit named operations and types rather than generic CRUD/write-set escape hatches. Reuse current domain authority and semantic receipts. Where existing Dot operations already persist commands, those rows are the outbox; add no second journal of the same fact.

## Execution and compatibility contract

Preserve Dot V6, `dot-provider-state.json`, `paperclip.runner.dot-provider-state.v1`, `openai_dot_mcp`, `dot-mcp-v1`, existing command/event identities and OAuth behavior. Dot's nonexpiring refresh and fence-only remote stop policy must not change. Dot's runtime-question capability remains disabled.

Muse has an explicit V7 native execution input, `muse_external` driver, `muse-v1` bridge, and advertised `muse_external_v1` artifact capability. Validate capability before managed launch. Recovery requires the exact target-owned checkpoint/process/session; missing checkpoint after dispatch requires reconciliation. Never start a new target to repeat uncertain work. Usage and cost remain unavailable/null.

Extend external operations with request_user_input and consume_input. request_user_input persists a real pending runtime request and emits `runtime_request.created` with `paperclip.runtime_request.v2`, which the existing bridge projects. The saved answer travels through the existing `request.resolve` command. The existing local bridge, runtime resolution helper and session input carry an optional stable command ID; Muse uses it for its durable PRP lane while other providers retain their behavior. Command identity `question_<interactionId>` remains distinct from the original request ID. Rust checkpoints an exact input reference/digest and emits input_available; broker persists delivery before ACK. The client persists the canonical answer into the same run's continuation before consume_input. Pending/unconsumed input blocks finish. Fetch, transport ACK and prepared response do not prove ingestion. No different-turn injection.

The active first-party profile excludes connector and workspace command grants and includes native task/document/collaboration/completion operations and the question path. Muse may use its own approved tools. Replay rechecks current authority before returning data or dispatching effects.

## Authority and durability

Use a dedicated `AgentConnectionSubject` carrying provider, company, agent, binding/generation and authorizing user. Never cast it into a Dot OAuth grant or human MCP identity. Idle reads/mutations require current agent and authorizer visibility; active projections/tools also require the run responsible user's visibility when different. Lists/search use SQL ACL predicates, not after-the-fact page filtering. Persist authorizer in audit, actor as named agent.

The idle catalog is exactly identify, task list/search/read/history/document-read, task create and task comment. request_turn is ordinary visible intake/scheduling, not an execution grant. Task status/completion/deliverable/configuration/connector/transfer operations require proper native execution and are denied idle. Agent callers cannot write connection configuration through create/update/import/rollback paths.

Preserve one live assignment per connection and an agent-wide barrier across generations, reconnects and provider changes. Stable assignment/request/event IDs and digests are immutable. Concurrent claim has one winner. Native operation rows progress reserved -> dispatched/pending -> settled/rejected/unknown. Unknown never automatically redispatches; only authoritative reconciliation can attach its original result.

Retain distinct offered, authenticated claim, native acceptance, progress, accepted result, finalization and stop facts. A callback cannot complete a task. Self-authored progress cannot create wake loops. Follow-up comments become consumed only through the exact successful native history receipt, not mailbox fetch.

### Transaction and lock constraints

Do not relocate the scheduler. Add a narrow database transaction admission/hold guard to existing claim branches, including no-issue and review claims. The existing process-local agent-start mutex is insufficient across replicas. Preserve queue issue -> wake -> run ordering and existing checkout/review predicates. Avoid acquiring binding then issue, since follow-up can already hold issue then binding. The company/agent guard follows existing issue/wake/run locks in queue claims and serializes the claim against connection generation/stop/hold transitions. Existing-issue idle mutations pre-lock that issue (or parent) before guard/binding; generation/stop and native receipt transitions never subsequently mutate an issue in the same transaction. Mailbox-only operations need not acquire the admission guard. Do not call network services under transaction locks. Prove competing claim, follow-up/edit/cancel interleavings and crash after claim before offer before finalizing the exact lock implementation.

Mailbox readers and writers serialize on the same binding row before allocating/returning a cursor, preventing a later commit from hiding an earlier sequence. Reuse existing Dot journal and mailbox rows; new Muse rows and additive sidecars carry new facts without copying existing assignments.

## Credentials, client and receiver

Single-use pairing tickets expire in ten minutes. Access credentials expire in fifteen minutes. Rotating refresh families expire after thirty days of authenticated inactivity; anonymous detector polling does not extend them. Hash credentials at rest; bind to tenant/company/agent/generation. Concurrent refresh is serialized by the private client's OS lock; consumed-token replay revokes the family. Ambiguous lost rotation requires reconnect, never a guessed successful token. Reconnect does not remove uncertainty holds.

The private Python standard-library client uses 0700/0600 private storage, exclusive lock, atomic writes/fsync, bounded HTTPS without redirects, safe output and persistent stable request journals. A Bash detector uses Muse's demonstrated managed-hook interface. Setup pins versioned asset digests and installs discoverable instructions in Muse's supported persistent environment. The copied instruction contains only a transient ticket and public asset metadata; no durable worker credentials or task content. Detector scripts and wake messages contain only a narrow opaque signal capability/reference, never worker credentials or task content.

Live discovery on 2026-10-10: personal Muse's managed hooks cannot use secrets, including narrow signal tokens. `hooks.add` accepts only `script_path`, without arguments; five-second checks are supported. The authenticated detector design above is therefore unsupported by the current managed-hook runtime and has no live qualification. A public opaque wake-only revision remains proposed and unapplied. Automatic approval review requires explicit human authorization for that public boundary. No successful real setup or fresh-conversation execution is asserted.

Request five-second checks. Empty or failed checks never wake the model. Errors back off; HTML/redirects/202/503 are not successful protocol responses. Health uses coalesced per-replica contact buckets with explicitly reported persistence lag; polling is not worker readiness. Qualification retains bounded cadence evidence and fails incomplete evidence rather than concealing lost tails.

Disconnect immediately revokes normal credentials and leases, persists control and any claimed-work hold, and activates a bounded old-generation cleanup-only capability. That lane cannot read task content, claim, refresh or run tools and remains available when the feature is off. Detector removal acknowledgement is distinct from worker stopping and sandbox cleanup.

## Stop evidence

Stopping fences authority immediately and records exact assignment/run/generation/nonce/operation boundary. A claimed assignment remains an overlap barrier across terminal state, restart, reconnect and provider switch.

Worker reported quiescence, operator attestation and authoritative native effect outcomes are separate facts. An unobserved private-tool inventory, empty manifest, token revocation, process exit or model declaration cannot establish all independent Muse effects stopped. Default to cannot_confirm unless a tested provider mechanism covers the named assignment. An operator may attest the worker facet for that exact boundary; unknown native effects remain an independent block and never become replayable. UI states exactly what is observed; it does not claim all personal Muse conversations stopped.

## Fixed public transport and UI API

Protocol version 1 has the following exact Cloud-public method/path set. Paths are immutable; adjacent, encoded/trailing variants and other methods are rejected. Core registers these through the same manifest, Cloud consumes a checked-in generated copy with parity verification.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /api/muse/v1/assets/1/manifest.json | Public immutable digests/version |
| GET | /api/muse/v1/assets/1/client.py | Private worker client source |
| GET | /api/muse/v1/assets/1/detector.sh | Managed detector source |
| GET | /api/muse/v1/assets/1/instructions.md | Discoverable client instructions |
| POST | /api/muse/v1/pair | Single-use ticket exchange |
| POST | /api/muse/v1/refresh | Refresh rotation |
| GET | /api/muse/v1/signal | Opaque signal; narrow bearer credential |
| POST | /api/muse/v1/commands | Strict closed worker command union |
| POST | /api/muse/v1/queries | Strict closed worker read union |
| POST | /api/muse/v1/cleanup | Old-generation cleanup-only union |
| POST | /api/muse/v1/detector-cleanup | Narrow detector-removal receipt |

Bodies and responses have explicit bounds; secrets are never URL parameters or logs. Cloud strips identity headers, selects the correct tenant, and passes through tenant authentication failures. Board endpoints remain ordinary operator-authorized API endpoints:

- POST `/companies/:companyId/muse-invitations` with name, role; returns resumable approved/pending hire.
- GET/POST `/companies/:companyId/agents/:agentId/muse-binding` for health and compare-and-replace pairing.
- POST sibling `/verify`, `/revoke`, `/attest-stop` with exact binding/execution/version identity as applicable.

Control owner publishes shared DTOs first and coordinates actual closed command/query schemas with Runtime before implementing both sides. Do not implement a parallel untyped protocol. A revised internal signature is permissible when current code requires it; changes to invariant or public route set require architecture update and parity tests.

## UI and release gates

Reuse ExternalAgentInviteDialog/Content and one-row step footer. Add name/role nonsecret draft scoped to company/operator; never persist ticket/prompt/token in browser storage or query cache. Server resume is operator/company scoped and stale-window ticket replacement uses binding/config revision CAS. Readiness requires all three evidence milestones plus lifecycle/approval. Explain hostname-wide standing permission; never infer permission failure from silence. Use “No recent response” and Open Muse when appropriate.

Settings show last persisted receiver contact, authenticated worker activity, last verified reply, version, live/uncertain work and cleanup. Actions test, repair, pause, disconnect and narrowly scoped stop attestation. Show unavailable usage and best-effort/unconfirmed remote stop. Use real-component Storybook journeys and token-only styles.

Conservatively inhibit Cloud sleep while a receiver can poll or unresolved assignment/input/operation/stop/cleanup remains, even with the feature disabled. Measure polling cost before release (17,280 checks/day at five seconds). No Cloud local execution fallback.

Validation order: existing Dot compatibility; synthetic Muse pair/background challenge/task/document/native finalization; authority/races/restart/unknown/stop/clarification/proactive tests; real components and Cloud ingress; required typecheck/test/build/token checks. Then actual personal Muse task, Paperclip clarification, follow-up and fresh-conversation proactive behavior. Finally a new bounded 24-hour qualification, at least twenty unattended samples, at least two hours sustained idle, requested five seconds and at least 90% steady gaps <=7 seconds. Report queue-to-claim and full response separately with missing evidence visible. Durable deadline cleanup must survive watcher/server restart. No silent sixty-second fallback. Keep default-off until all gates pass; elapsed time and successful simulations are not live qualification.

## Implementation partitions

Runtime owns Runner TS/Rust/contracts/generation, native runtime integration, heartbeat claim guard call sites, provider/tool/runtime/artifact registration. Control owns DB/migration, shared Muse DTO/protocol/feature settings, broker/identity/receiver/client/setup/routes/invitations/lifecycle and admission guard implementation. UI owns ui/**. Root owns Cloud ingress, integrated review/qualification tooling and cross-boundary fixes. Writers use isolated worktrees and exchange early contract commits; one DB migration owner and one Runner generated-contract owner.

If independent implementation repeatedly requires alternate lifecycles, hidden policy copies or type escape hatches, stop that construction, re-ground the failing boundary and subtract the duplication before continuing.


Implementation qualification evidence uses the original persisted 24-hour window. Idle coverage is bounded by persisted receiver contacts and excludes native runs, live assignments and pending input. A receiver gap longer than the 30-second contact persistence interval breaks idle coverage; the separate cadence check still requires at least 90% of gaps at or below seven seconds. Incomplete buckets, lost ingress tails or reader overflow leave evidence incomplete.
