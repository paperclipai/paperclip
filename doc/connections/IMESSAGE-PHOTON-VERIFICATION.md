# iMessage Photon verification

Date: 2026-09-11. Branch: `codex/imessage-photon`.
Base inspected: `1c4bcff2b`; updated through master `ab15aff39`.
Initial implementation checked: `7ada38eb7ef5dff5441f23c02131798b11d57712`.
**Status: experimental; Pro shared-DM live journeys verified below. Dedicated groups and the remaining release matrix are not yet qualified.**

[PR #13299](https://github.com/paperclipai/paperclip/pull/13299) carries the current
CI and review results. The Photon migration is `0275_easy_dragon_man.sql`, regenerated after master added its own 0274 agent-chat migration. Greptile reviewed the implementation commit at 5/5 with no
actionable comments. This record distinguishes local evidence from live proof.

## Environment and versions

- Fresh worktree: `imessage-photon`; separate worktree configuration, instance,
  database/storage home, and application port 3109.
- Browser tests use a disposable local-trusted instance on port 3319 with a new
  database and storage home. They mock the provider/control-plane responses.
- Database integration tests use disposable embedded PostgreSQL with real channel,
  identity, task, attachment, publication, and interaction services.
- Advanced SDK 2.1.0; grpc-js 1.14.4; nice-grpc 2.1.17; nice-grpc-common 2.0.4;
  heif2jpeg 0.1.6. Local converter execution: macOS arm64.
- The synthetic HEIC fixture is generated from a solid-color 16×16 image. It has
  no personal photo content and does not qualify real iPhone HEIC/Live Photos.
- Production credentials, line tokens, phone numbers, and participant identifiers
  are absent from this record. Test numbers/IDs in fixtures are synthetic.

The primary-instance seed attempt encountered existing source schema drift
(`tool_connections_transport_check` missing), so the isolated worktree uses a clean
instance. The primary database was not modified. Several test starts also reached
macOS's 32-segment System V shared-memory limit. Only unattached IPC from this task's
exited browser-test databases was eligible for cleanup; running instances were not
stopped or altered.

## Deterministic acceptance evidence

`server/src/__tests__/photon/photon.test.ts` exercises Basic Cloud authentication,
token redaction, dedicated/shared/missing allocation, immutable line identity,
Unicode multipart publication, receipt recovery, unknown sends and explicit retry,
upload receipt reuse, quota classification, per-part authorization, contiguous
checkpoint recovery, ignored event frames, cutoff history, lease loss, real local
gRPC framing/authentication, scoped state, duplicate-title poll IDs, poll creation
before a local crash, answer parsing, source ownership, image bounds, and actual
synthetic HEIC conversion.

`server/src/__tests__/photon/channel.integration.test.ts` composes the real channel
service with the Photon adapter and synthetic provider responses. It proves the
fresh linked-message/task/agent-publication setup requirement, restored DM reply,
echo filtering, identity reservation, explicit group enablement, authorized poll
resolution, per-person answer drafts, rejection reasons, exactly one canonical
continuation record, delayed HEIC retry after restart, attachment provenance,
quoted context, task generations, stale controls, retained pending input through
pause, group removal, and a native continuation proof for a second group person.
The checkpoint takeover test verifies the database lease and checkpoint update
share one transaction.

The native continuation test caught a JSON key-order mismatch after JSONB storage.
Both the recorded answer digest and reconstructed proof now use the existing
canonical hash. This is a native authorization composition test, not evidence of
a live model turn through Photon.

The Photon/OpenAPI follow-up also verifies safe setup credential, quota, network,
and invalid-response errors, the complete board-only inspection contract, group
participant response fields, and the unchanged credential binding after rejected
replacement. All 39 Photon/OpenAPI tests and the server build passed after the
review fix separating provider outages from invalid setup input.

The Photon browser cases in `tests/e2e/chat-adapters-ui.spec.ts` cover catalog
discovery, multiple-line selection, password input, keyboard selection, vaulted
credential payload shape, setup completion, group enablement, light/dark themes,
mobile navigation/layout, and pause/resume. The surrounding suite covers existing
Slack, Discord, GitHub, Teams, and Telegram surfaces.

| Check | Result |
| --- | --- |
| Photon targeted tests | 31 passed, including checkpoint takeover, Live Photo companion retention, and native continuation authorization. |
| Token gates | Passed. All four gates clean. |
| Workspace typecheck | Full `pnpm -r typecheck` passed before and after rebase. |
| Full chat-adapters browser suite | 38 passed, including Photon light/dark/mobile coverage and existing providers. |
| OpenAPI contract | 8 passed, including mounted-route completeness, board-only inspection, and token-free response schemas. |
| Post-rebase channel/native checks | 96 passed across Photon, OpenAPI, explicit native continuation, and chat-control admission retry. |
| Native session resume | 37 passed after building the required local fake-provider binary. |
| UI Vitest project | 6,008 passed across 582 files after rebase. |
| Shared catalog project | 727 passed, including exact catalog and branding coverage. |
| Repository Vitest suite | The initial `pnpm test:run` overlapped edits/rebase and was stopped; it is not a final-commit pass. Fresh targeted and CI checks supersede it. The serialized route run found the missing Photon OpenAPI contract, which is fixed and passes its 8-case suite. Full gate status is recorded in the linked PR. |
| Build | Full `pnpm build` passed before and after rebase. |
| Generated forward migration | Generated through `pnpm db:generate`; `@paperclipai/db check:migrations` passed. Disposable database migrations exercised by integration tests. |
| Native HEIF platform packages | macOS arm64 executed; other published platforms not executed. |

### Local test prerequisites

The standard `pnpm test:run` launcher isolates `PAPERCLIP_CONFIG`, `PAPERCLIP_HOME`,
and temporary files. Direct heartbeat/continuation tests must use equivalent
isolation; otherwise the worktree preview configuration suppresses execution.
The actual runner-driver fixture also requires:

```sh
cargo build --manifest-path packages/paperclip-runner/runner/Cargo.toml --bin fake-codex-app-server
```

A run without that binary failed at provider startup; the complete 37-case native
session-resume suite passed after building it. Catalog assertions were updated
for the 42nd visible app, and the focused catalog/Browse/board-gallery tests pass.
Some broad package runs encountered host embedded-Postgres startup limits during
concurrent local development. These startup failures are not provider proof;
inspect the linked PR for the current complete gate results.

## Pro shared-DM live qualification (2026-09-12)

The operator approved Pro-compatible shared DMs with groups disabled. The live
test uses the isolated instance on port 3109, a Photon Pro project, its enrolled
test participant, and the participant's actual iPhone. The test source was fully
seeded through the worktree CLI; the primary instance remains untouched.

Observed with SDK 2.1.0 on implementation base `e556f7dbefd3ee738bde7830d69d5e30c4e96872`
plus the shared-DM changes in this PR:

- Project inspection and vaulted setup succeeded against Photon Cloud's actual
  shared allocation. Shared credentials select the fixed shared gateway and a
  project-scoped identity, without inventing an owned phone number.
- At 13:16 UTC, the participant sent a fresh iMessage from their iPhone. Photon
  delivered it through authenticated recovery. The project-filtered event feed
  jumped from an empty cursor to a non-adjacent sequence; the dedicated-only
  adjacency check initially stopped in Attention.
- After the shared recovery fix and an isolated server restart, reconnect replayed
  the original message at 13:26 UTC. Paperclip discovered the exact sender but
  created no conversation/task while the identity was unlinked. The normal private
  confirmation flow then linked that identity to the isolated Board account.
- At 13:27–13:28 UTC, the fresh linked request created a task, ran the native
  Codex runner, and delivered the requested response back to Apple Messages.
- A native poll created at 13:29 UTC survived restart. Setup initially rejected
  interaction answers until the endpoint was active, deadlocking a clarifying
  question before final-reply qualification. Photon now permits those responses
  during its verified test step with the same identity, generation, and permission
  checks. After restart, a fresh vote at 13:33 UTC produced exactly one canonical
  answer and one native continuation. Its final reply arrived in Messages. A late
  unvote did not undo the answer. Setup then completed normally.
- At 13:35–13:37 UTC, two free-text answers were collected sequentially. Early
  submission stayed pending; explicit submission of both drafts resumed the
  native agent with both exact values. The test also corrected the missing-answer
  hint to identify the unanswered question rather than always question 1.
- At 13:38 UTC, the initial PNG/document import failed visibly because the shared
  gateway returns project attachment aliases in metadata and native UUIDs in
  stream headers. Shared downloads now retain authenticated source-message/chat
  checks and the exact alias-addressed RPC, validate the header metadata, and
  retain project aliases for provenance and restart. At 13:43–13:44 UTC, a fresh
  two-file message sent during the outage was recovered, imported, inspected by
  the agent, and returned as actual PNG and text-file attachments in Messages.
  The agent correctly identified the image and the document's verification word.
- At 13:46–13:49 UTC, a canonical `request_confirmation` rejected a bare Reject
  reply with an actionable reason request. A correlated rejection with a reason
  resolved the canonical interaction and resumed the native agent, which returned
  the exact reason and confirmed that no further action ran.
- At 13:49–13:50 UTC, a synthetic HEIC was sent through Apple Messages. Paperclip
  retained the 676-byte original and created a 633-byte JPEG derivative. The agent
  correctly described the solid blue 16×16 image and returned the original HEIC
  through Photon; the file appeared in Messages. This tests the real transport and
  converter together, but does not substitute for an actual iPhone camera photo.
- At 13:51–13:53 UTC, Pause suppressed a delivered test message without creating
  a task. Resume did not replay it as work; a fresh request created the next task
  and received a reply. Reconnect reused the vaulted credentials and preserved
  project/allocation identity, then completed its fresh-message/reply test.
- At 13:53–13:54 UTC, revoking the linked identity caused the next live message to
  be filtered with no task or agent run. The normal private confirmation flow
  restored the link. Completed tasks remained idle between fresh requests, and
  `/status` correctly reported no active task. `/new` requested a fresh message,
  and `/close` closed the next active conversation. Its late correlated answer
  left the old interaction unresolved and did not start another task.
- At 13:56 UTC, Remove connection archived the test endpoint and its connection,
  cleared saved secret bindings, and stopped intake. A message sent while removed
  created no task. The same Photon project remained eligible in new setup.
  A replacement endpoint was linked normally and completed a fresh native
  task/reply test at 13:58 UTC. The test channel was left active.
- At 18:13–18:14 UTC, an operator-supplied iPhone camera HEIC passed the same
  authorized Apple Messages conversation on code commit `fc4e4f0a3` (documentation
  head `a2a9319f3`). Messages transformed the 1,432,391-byte source into a
  1,132,602-byte HEIC before ingestion. Paperclip retained those received bytes
  and generated a 783,443-byte, 3024×4032 JPEG preview. The native agent correctly
  described the photo, then staged the HEIC with the same SHA-256 as the received
  original. Text and file publications each succeeded on their first attempt with
  provider receipts, and the returned photo appeared in Apple Messages. The native
  run succeeded and the task completed. The personal photo is not included in the
  repository or this report. This closes the real camera HEIC round-trip gap;
  Live Photo reassembly remains outside scope.
- An identical published test send was repeated with its original key, exact
  payload digest, and reply target. Photon suppressed it but returned gRPC 6 with
  SDK `internalError` and an empty context, saying the operation was already
  processed. No new bubble appeared. Contrary to the documented original-result
  behavior, the shared gateway supplied no receipt. A regression test preserves
  delivery-unknown state in this case; no text matching or new key is used.
- The shared receiver now commits only after the complete ordered replay barrier.
  Regression cases cover sparse events, interrupted/out-of-order replay, and cursor
  resets without advancing the saved checkpoint. Dedicated recovery remains strict.
- All 39 chat-adapters browser tests passed, including shared setup after reload
  and existing provider coverage. The 20 Photon unit cases passed. An integration
  rerun initially hit the host's embedded-Postgres startup limit; this is a test
  environment failure, not a provider result.

The expanded unit suite has 22 passing cases, including shared attachment alias
ownership, header validation, and missing duplicate receipts. After merging master
and regenerating migration 0275, all 16 integration cases passed at code commit
`fc4e4f0a32d35e41e56f6698404fca64cee3f32b`. Full workspace typecheck, build, token
gates, and migration checks passed on that commit. The isolated instance then
restarted successfully, reported startup ready on that commit, and retained the
active shared-DM endpoint and linked identity. A broad `pnpm test:run` was started and stopped
when the host's shared-memory limit prevented the live isolated PostgreSQL from
restarting. Only this task's exited test database resources were removed. This
interrupted run is not a full-suite pass; current CI must qualify the final commit.

All 30 applicable CI checks passed on `a2a9319f3`, with two skipped checks. One
unchanged Cursor sandbox command-selection case initially exceeded its 10-second
timeout. The exact case passed locally in 735 ms, and the failed CI server shard
passed on its single rerun. Greptile rated that head 5/5 with no unresolved review
threads. The 22 Photon unit cases also passed in Linux CI, including native HEIC
conversion. Subsequent changes to this record add qualification evidence only;
the linked PR shows their current check status.

Photon's CLI manages projects and users; its terminal provider simulates chat UI.
Neither substitutes for actual Cloud iMessage delivery. The local Mac initially
classified the assigned number as RCS, while the participant's iPhone sent the
observed iMessage. No RCS/SMS fallback was enabled.

## Live qualification still required

Dedicated-line credentials were unavailable during the initial implementation.
The Pro shared-DM journeys above passed; the remaining matrix must be completed
before release readiness. Live inbound receipt alone is not full qualification.
Record the tested commit, package versions, redacted project/line/chat IDs,
participants, timestamps, and observable results when running it.

| Live case | Status |
| --- | --- |
| Linked DM creates task and receives actual agent response | Passed with Pro shared DMs and the native Codex runner. |
| Enabled group with two linked people preserves attribution | Disabled for the approved Pro scope; dedicated-line live qualification remains unrun. |
| Unlinked sender cannot start work | Passed for the live shared-DM probe; sender discovered, zero conversations/tasks created. |
| Inbound/outbound photos and real iPhone HEIC | Passed for PNG, text file, synthetic HEIC, and an operator-supplied iPhone camera HEIC. The real photo produced a full-resolution JPEG preview and a byte-identical return of the received HEIC. |
| Native poll and text answer resume correct interaction | Passed, including sequential drafts, incomplete submission, explicit submission, and one poll continuation. |
| Approval rejection reason reaches canonical interaction | Passed, including missing-reason correction and native continuation. |
| Restart preserves DM/group replies and pending questions | Shared DM recovery and pending native poll passed; dedicated groups remain unrun. |
| Pause/resume/reconnect/removal enforce authority | Passed for Pro DMs. Removal archived the endpoint and connection, cleared secret bindings, and stopped intake. |
| Completed turn stays idle until fresh input | Passed. September 12 correction: two successive real follow-ups reopened PHOTON-17, with no new task. |
| Provider ambiguous-send/idempotency behavior | Real repeated key suppressed duplicates but returned no original receipt. Unknown-send recovery remains an operator action; no induced network-timeout test. |
| HEIF conversion on Linux glibc/Windows and deployment packaging | macOS arm64 and Linux CI conversion passed. Windows execution remains unrun. Linux musl has no packaged converter. |

Keep this channel behind the existing experimental gate. Mocked tests, synthetic
gRPC, and a visible catalog card do not establish these live results.

### September 12: persistent conversation and live task bubbles

The operator reported three messages creating PHOTON-15, PHOTON-16, and
PHOTON-17. Task completion had incorrectly been treated as the end of an
iMessage conversation, and channel admission did not emit the comment event
used by an open task page. The fix preserves the latest task until an explicit
`/new` or `/close`, publishes comment activity after its transaction commits,
and labels inbound human bubbles in both task-chat renderers.

Tested the fix in the isolated `codex/imessage-photon` worktree on September 12,
2026 at 13:56–13:57 America/Chicago, against the operator's existing Pro DM
endpoint (`99bebf95…3884`) and PHOTON-17 (`bd6d8379…ba15`). Left the task page
open and sent two authorized messages through Apple Messages to the same Photon
conversation, waiting for completion between sends. Both appeared without a
page reload and both reopened PHOTON-17. Its bubbles showed “Sent from
iMessage”; the agent returned “PHOTON-17 live follow-up received” and
“PHOTON-17 still one conversation” through Photon. The earlier task records
were preserved as history. No live `/new` was sent to replace the operator's
current conversation; explicit reset, close, stale controls, duplicate delivery,
restart, and dedicated-group continuity are covered by integration fixtures.

The live server was then restarted on `4d7222110`. A third message asked the
agent to repeat its previous reply. It appeared live on PHOTON-17 with its
iMessage label, and the agent returned the exact previous reply through Photon.
All 304 focused tests passed on that commit, and the existing Teams completion
boundary passed its separate regression test.

Interactive Storybook coverage lives under **Connections / iMessage Photon**.
It uses the production catalog card, three-step channel wizard, access and
management pages, and task message bubbles with explicitly simulated provider
actions. Thirteen stories cover catalog discovery, agent selection, credentials,
shared setup, multiple dedicated lines, missing allocation, loading, connecting,
outage recovery, reconnect, identity access, and persistent task follow-ups.
All 26 light/dark Playwright cases passed, including the 390px mobile layout.
The credential and mobile screenshots were inspected. Run with:

```sh
pnpm build-storybook
pnpm exec playwright test --config tests/storybook-visual/imessage-photon.config.ts
```
