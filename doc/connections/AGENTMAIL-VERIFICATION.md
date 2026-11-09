# AgentMail verification — 2026-09-11

## Environment

Worktree: `codex/agentmail`. The original checkout and its merge conflicts were
preserved. Live checks used the isolated AgentMail Test Drive company at
`http://localhost:3103`, with the experimental connections feature enabled.

Only these user-authorized inboxes exchanged test mail:

- Paperclip: `pap15838-qa@agentmail.to`, assigned to Email QA.
- Other end: `attractiveforce961@agentmail.to`, inspected in AgentMail Console.

## Live browser results

| Journey | Observed result |
| --- | --- |
| Connect from the Apps catalog | Saved personal human access, selected agent access, and a vaulted key through the real UI. |
| Give an agent an address | Used Permissions → three-step wizard → existing scoped inbox. The selected agent, review warnings, and connection persisted. |
| Trust controls | Saved Low-trust review with a root-task boundary, verified the missing-sandbox prerequisite, then explicitly restored Standard for this local QA agent. |
| Live receiving | Inbound correspondence created AGE-6. The agent explicitly replied once; the reply appeared in AgentMail Console and Paperclip recorded Delivered. |
| Signed webhook | Registered an inbox-scoped webhook. Actual signed POSTs returned 204. AGE-7 received its email, the agent replied once, and both consoles showed the exchange. |
| Reply to a completed conversation | New mail reused the same task and reopened it. |
| Restart catch-up | Sent another reply while the server health endpoint was unreachable. Startup imported it into AGE-7, woke the agent, and sent one acknowledgement in the same thread. |
| Agent-initiated new conversation | A board request in AGE-7 caused the agent to create AGE-8 with `parentId` pointing to AGE-7. One email was sent and marked Delivered; it appeared as a separate thread in AgentMail Console. |
| Internal publication boundary | Internal summaries and the outbound-only child task's “No reply sent” response produced no additional emails. |
| Cleanup | Restored WebSocket mode, removed Paperclip's test webhook, stopped the webhook-only proxy/tunnel, and removed the temporary public URL from the isolated configuration. Inbox history and vaulted test credentials remain inspectable. |

Useful live pages:

- [Saved connection permissions](http://localhost:3103/AGE/apps/78dd5c23-f60f-42ca-b30a-6f0c701b38d3/permissions)
- [Inbox settings](http://localhost:3103/AGE/apps/chat/7cdf17d6-465e-4eef-8858-2b545be64b3a/settings)
- [Inbound conversation and restart recovery: AGE-7](http://localhost:3103/AGE/issues/AGE-7)
- [Agent-created email child: AGE-8](http://localhost:3103/AGE/issues/AGE-8)
- [Other inbox in AgentMail Console](https://console.agentmail.to/dashboard/inboxes/attractiveforce961@agentmail.to)

## Timing

These are individual observations from `email.received` audit records, not a
load test or latency guarantee. Admission-to-wakeup includes durable processing
and heartbeat admission; it excludes provider delivery and subsequent model
startup/generation.

| Check | Admission to wakeup |
| --- | ---: |
| Live inbound, AGE-6 | 409 ms |
| Signed webhook, AGE-7 | 421 ms |
| Startup catch-up, AGE-7 | 585 ms |

The clean webhook run was created at `18:10:53.471Z`, started at
`18:10:53.512Z`, sent its reply at approximately `18:11:40Z`, and finished at
`18:12:05.225Z`. Model work is separate from the sub-second admission measurement.

## Fixes found by testing

- Personal credential access displayed as organization access in the generic
  connection panel. AgentMail now displays the actual saved grants and installs.
- Low-trust permissions used the wrong mutation route; Standard omitted rather
  than cleared the previous boundary. Both are fixed and covered by regressions.
- Email task recovery incorrectly entered restricted chat replay. Normal email
  work now uses normal task recovery while retaining execution controls.
- A send/read-only key could not register a webhook. Setup now explains the
  required inbox-scoped webhook permissions. A failed switch leaves the live
  connection active. The user authorized a replacement scoped key for the live
  webhook test.
- Graceful shutdown retained the socket lease until its crash timeout. Shutdown
  now releases only this worker's socket tokens; the ownership test verifies
  immediate takeover by a second worker. The final live restart became ready at
  `18:30:10Z` and completed a mail check at `18:30:14Z`, with no connection error.
- A path-like attachment filename could produce a stored object key that the
  storage reader rejected. Imported filenames now remove path traversal segments.
  The regression covers bounded, deduplicated intake, reading stored bytes,
  task-scoped attachment references, and rejecting bytes changed after queueing.
- The initial QA agent attempted to install the released CLI for an unreleased
  feature. The test agent now uses the local HTTP API. Runtime documentation also
  describes the direct HTTP fallback.
- The first QA instruction to leave work open omitted a valid task disposition,
  triggering existing recovery controls after a successful send. Corrected QA
  instructions explicitly set the requested disposition. Clean subsequent runs
  completed successfully; those earlier diagnostic tasks remain inspectable.

## Automated verification

- API/provider and durable-pipeline tests: 32 passed, including signature checks,
  deduplication, callback-before-response, uncertain-send handling, inbox/company
  isolation, credentials, low-trust placement, and socket ownership/shutdown.
- OpenAPI contract checks passed (8 tests); the final combined run passed all 40.
- Deterministic Playwright setup and task-conversation coverage includes actual
  trust-permission persistence, rich email cards, and Bcc details. Following the
  board UX revision, email controls were removed and instructions use the normal
  task composer. Its provider responses are mocked; it is separate from the live
  browser results above.
- Trust UI tests passed (10 tests).
- Catalog regression and damaged-runner-history recovery regression passed.
- Repository typecheck and build passed; changed-package checks were repeated
  after subsequent fixes. Token gates and whitespace checks passed.
- Full repository Vitest run did **not** pass. The general server group finished
  with 10,584 passing tests, five failing tests, and one database-startup suite
  failure. Its five individual failures subsequently passed in focused reruns
  (email recovery/trust, gallery count, plugin wait, and damaged runner history).
  This broad run began before the final fixes; it is not a final green result.
- Additional broad workspace and serialized-route groups encountered database
  startup, hook, and adapter timeouts. The UI group had 5,923 passing tests and
  five failures; rerunning its two affected files passed all 73 tests. Shared
  contracts passed 727 tests and the skills catalog passed 20. Remaining broad
  groups have not been rerun to completion, so this is not a PR-ready all-green
  qualification.

## Limits

The account was at its inbox limit, so live setup attached an existing inbox.
Programmatic inbox creation and custom domains were not live-qualified.
Attachment transfer, invalid signatures, cross-company denial, cancellation,
duplicate callbacks, and expired idempotency windows are checked deterministically
rather than against the live provider. Low-trust execution was not run in a real sandbox; setup correctly
rejected the isolated test drive's missing sandbox runtime.

One restart-test acknowledgement arrived in the other inbox while Paperclip's
status remained Sent because its delivery receipt was missed during socket
recovery. Sent records provider acceptance; Paperclip does not fabricate a
Delivered receipt or resend the message. The later independent outbound email
received and recorded its Delivered receipt normally.
