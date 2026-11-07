# AgentMail Daytona verification — 2026-09-11

Worktree: `codex/agentmail`; isolated test drive at `http://localhost:3103`.
The original checkout remains untouched. Test mail used only the two previously
authorized inboxes, `pap15838-qa@agentmail.to` and
`attractiveforce961@agentmail.to`.

## Defects corrected

- AgentMail REST connections fell through the generic health-check branch into
  local-stdio MCP validation. Both saved account credentials and inbox credentials
  now validate against AgentMail's `/auth/me` API. Catalog refresh returns no MCP
  tools, and invalid keys still produce a failed health result. The live Apps card
  was inspected in the browser and showed Connected with no stdio error.
- Sandbox callback routing omitted task-email endpoints. It now allows assigned
  inbox discovery, task-thread reads, delivery reads, and explicit sends. Server
  company, inbox, task/run, and action-policy authorization remains in force.
  Setup, credentials, reconnect, and operator delivery resolution stay denied.
- Shell-backed sandbox reads did not preserve ENOENT for a missing optional
  Codex `auth.json`, causing cleanup to fail after a successful email send. Reads
  now confirm absence in a searchable parent and return ENOENT; actual read and
  transport failures still propagate. This lets existing auth copy-back treat
  missing credentials as a no-op.
- Runtime instructions now document inbox discovery directly; the agent otherwise
  spent time guessing that endpoint when initiating a new conversation.

## Live observations

The board used the ordinary task composer in
[AGE-10](http://localhost:3103/AGE/issues/AGE-10) to request a test email.
The agent executed the real Codex CLI in Daytona, used the sandbox callback
bridge to discover its assigned inbox and queue the send, and created
[AGE-11](http://localhost:3103/AGE/issues/AGE-11) as an email child task.

- Provider sandbox: `c2f176ca-dbde-41a6-995d-aefa4689e4c5`.
- Runtime verified by the agent: Linux, x86_64; hostname matched the sandbox.
- Run: `cd7b934a-5555-4361-b0e5-b8106c1510ce`.
- Publication: `d5b7bf41-a583-4f9f-90c0-4d21680e39c2`, **Delivered**.
- Subject: `[Paperclip E2E] Daytona sandbox — Sep 11`.
- Provider key remained in Paperclip's vault. The sandbox used its injected
  Paperclip run credential, and the model key was separately vaulted.

The first fixture launches exposed an unavailable default ACP executable and a
host `service_tier` setting incompatible with the fleet image's Codex CLI. The
QA fixture explicitly selects the CLI engine and an isolated Codex home. Earlier
failed launches remain in AGE-9. The outbound send above completed, but its run
then failed during missing-auth-file cleanup; the cleanup fix is verified
separately below rather than rewriting that history.

## Cleanup verification

A fresh Daytona run in [AGE-12](http://localhost:3103/AGE/issues/AGE-12)
read the existing publication, confirmed Delivered, recorded its Linux hostname,
and completed successfully without sending another email.

- Run: `39e77902-714e-455f-90d8-8709f2d13762`, **Succeeded**.
- Sandbox: `d50c6979-de6e-4a0c-ac18-bd616a39ee1f`.
- Cleanup log: “no sandbox credential to copy back (absent auth.json); host
  credential kept.” The environment lease reached Released.

## Automated checks

- 20 durable email pipeline tests passed, including health checks for account and
  inbox credentials, catalog discovery, and invalid credentials.
- 56 sandbox callback bridge tests passed, including the four email routes and
  denial of email administration routes.
- 28 command-managed runtime tests passed, including the missing-file contract
  and propagation of real read failures.
- 4 capability inventory tests passed. Regenerated both capability indexes for
  the new task-email runtime documentation and updated the expected row count.
- Server typecheck, server build, adapter-utils build, and whitespace checks passed.

## Inbound round trip

After Chrome access recovered, sent a new authorized test email from the other
inbox through AgentMail Console. WebSocket intake created
[AGE-13](http://localhost:3103/AGE/issues/AGE-13), assigned Email QA, and started
the agent in a fresh Daytona sandbox. The agent read the bound thread, explicitly
replied once, checked delivery, and marked the task Done.

- Run: `76be255b-df2e-4479-8c62-f4506f039132`, **Succeeded**.
- Sandbox/verified Linux hostname: `7bb660fa-3cff-4b26-9e10-68c884be21bb`.
- Reply publication: `efdd704c-afd3-4025-ab48-24fab6c97333`, **Delivered**.
- Incoming comment persisted at `19:05:14.750Z`; run started at
  `19:05:14.920Z` (170 ms later). This interval excludes provider delivery and
  does not measure model startup. The run finished at `19:06:09.481Z`.
- Exactly one incoming and one outgoing email comment, plus an internal summary.
- Visually verified the exact acknowledgement in
  [the other AgentMail inbox](https://console.agentmail.to/dashboard/inboxes/attractiveforce961@agentmail.to?thread=805fd7f1-26c2-414a-b139-5fb65f490f50),
  with matching reply message ID and original-message reference.

## Test cleanup

Restored Email QA's original local adapter configuration. Removed the temporary
Daytona environments, all six sandbox instances created by this test, and the
temporary vaulted Daytona/model credentials. Provider inboxes, saved AgentMail
credentials, task history, and run evidence remain available.

## Qualification limits

This run exercises the Codex CLI sandbox adapter. The native runner `task_email`
path is covered deterministically, but was not separately live-qualified in Daytona.
The Daytona inbound round trip used WebSocket intake. Earlier local-agent
WebSocket and signed-webhook qualification is documented in
[the main verification report](AGENTMAIL-VERIFICATION.md).
