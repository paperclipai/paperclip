# Paperclip integration notes

This package now runs as a first-class built-in adapter inside the Paperclip workspace.
The integration work landed in both the adapter package and Paperclip core so the setup is reproducible instead of relying on one-off local tweaks.

## Installed workspace shape

The Hermes adapter lives at:

```text
packages/adapters/hermes-local
```

Paperclip is wired to consume that workspace package from:

- `server/package.json`
- `ui/package.json`
- `server/src/adapters/registry.ts`
- `scripts/release-package-map.mjs`

## Core Paperclip hooks required for Hermes parity

### 1. Dynamic model discovery

The server registry should prefer:

- `listModels()`
- static `models` only as a fallback

Without this, the UI can silently fall back to a default model instead of showing the real Hermes-configured model list.

### 2. Session management

The registry must expose Hermes `sessionManagement` so Paperclip can round-trip session state between wakes.

### 3. Full approval lifecycle wakeups

The requesting agent is now woken when an approval is:

- approved
- revision requested
- rejected

The wake payload should include:

- `approvalId`
- `approvalStatus`
- `approvalType`
- `approvalPayloadName`
- `approvalPayloadAgentId`
- `approvalPayloadReportsTo`
- `approvalPayloadAdapterType`
- `issueIds`
- `decisionNote`
- `wakeReason`

For approved hire flows, that summary is important: it lets the requester reuse
the already-created subordinate instead of blindly submitting another
`/agent-hires` call from the approval wake.

### 4. Issue wake context must include actual task text

Worker wakes are not reliable if the context only contains an `issueId`.
For Hermes, the wake snapshot should also include the issue title and body so the model can act immediately instead of asking the board to restate the assignment.

Recommended context fields:

- `taskId`
- `taskTitle`
- `taskBody`
- `issueTitle`
- `issueDescription`
- `issueIdentifier`
- `source`

### 5. Host should pass resolved runtime config

The adapter expects `ctx.config` to contain resolved values, especially for env bindings and secrets.
It should not be forced to read unresolved secret-ref objects from raw stored config.

### 6. Host should preserve sessionParams exactly

`sessionParams` are intentionally richer than only `sessionId`.
The host should round-trip them unchanged.

### 7. Custom endpoints should use a dedicated Hermes home

Hermes v0.7.0 supports custom OpenAI-compatible endpoints through config/runtime resolution, but its `chat` CLI does not accept `--provider custom` directly.

For LiteLLM or similar endpoints:

- configure a dedicated Hermes home/profile with `model.provider: custom`
- set `model.base_url`, `model.api_key`, and the desired model id there
- point the Paperclip agent at that home via `HERMES_HOME`

### 8. Company-scoped issue creation guidance matters

Hermes will guess issue-creation routes if Paperclip does not give a strong example.

For reliable delegation:

- prompts should show `POST /api/companies/{companyId}/issues`
- prompts should use `description`, not `body`, for issue instructions
- the host should return a helpful error when a model guesses `POST /api/issues`

### 9. Approved hires should reconcile their payload back into the pending agent row

The host pre-creates pending agents before board approval.
When approval is granted, Hermes parity depends on reconciling the approved payload back into that same row, not only flipping status.

This protects fields such as:

- `reportsTo`
- `adapterConfig`
- `runtimeConfig`
- metadata and budget fields

### 10. Hermes supports two skill sources and the host must respect both

The integration now treats these as separate but valid:

- Paperclip-managed runtime/company skills
- existing user-managed Hermes skills under `~/.hermes/skills`

The host should materialize Paperclip-managed skills without overwriting native Hermes skills.

### 11. Non-interactive Hermes runs need the execution-session env gate for cron

Hermes only exposes the `cronjob` tool in:

- interactive CLI sessions
- gateway sessions
- execution sessions marked with `HERMES_EXEC_ASK=1`

Paperclip heartbeat runs are headless, so the host should export `HERMES_EXEC_ASK=1`.
Without that env flag, enabling the `cronjob` toolset is not enough.

### 12. Paperclip API mutations must stay on terminal + curl

Hermes exposes `execute_code`, but in real Paperclip runs that sandbox can resolve
`PAPERCLIP_*` values as missing or `None` even when the terminal environment has
the correct values.

For reliable issue comments, status updates, approval mutations, and `/agent-hires`:

- use terminal + `curl`
- build env-backed payloads in the terminal so the shell expands `PAPERCLIP_*`
- do not rely on `execute_code` for Paperclip API mutations

This is now documented in the adapter prompt and shared Paperclip skills because
the failure mode is otherwise misleading: Hermes can appear to understand the
task, then send `POST /api/issues/None/comments` or `PATCH /api/issues/None`.

### 13. Waiting states must not be marked done early

If an assigned issue explicitly says to wait for board approval, revision
feedback, or another reviewer decision after submitting a request:

- post the required progress comment
- stop the run
- leave the issue open until the follow-up wake arrives

Otherwise the issue timeline becomes misleading even if the later approval wake
eventually repairs the flow.

## Validation flow used for this integration

The integration was verified with:

1. Adapter unit tests under `packages/adapters/hermes-local/tests`
2. Paperclip server tests covering registry wiring, session codecs, model listing, approval wakeups, and issue wake snapshots
3. Playwright browser automation covering:
   - company creation
   - Hermes model selection from the discovered model list
   - CEO creation
   - CEO-driven hire request
   - board approval
   - worker-agent creation
   - worker execution against a real Paperclip issue
4. Playwright hierarchy automation covering:
   - imported Paperclip-managed skill sync
   - native Hermes skill usage
   - agent-authored native Hermes skill creation and use
   - installed Hermes skill usage (`executing-plans`)
   - manager hires worker
   - board approval
   - worker issue creation through the company-scoped issues API
   - worker completion and manager completion
   - terminal-only Paperclip mutation discipline after skill execution
5. Playwright approval lifecycle automation covering:
   - approval approved
   - approval revision requested and resubmitted
   - approval rejected

## Issues fixed during validation

### Worker wakes missing task content

Symptom:

- the hired worker woke up with only an issue id
- Hermes asked for clarification instead of completing the task

Fix:

- centralize issue wake snapshot creation in `server/src/services/issue-assignment-wakeup.ts`
- include task title/body fields in all issue-related wake paths
- add prompt fallbacks in the Hermes adapter for `issueTitle` and `issueDescription`

### Approval comment payload drift

Symptom:

- approval-thread comments could fail with `400` when an agent sent `content` or `comments` instead of `body`

Fix:

- normalize approval comment payload aliases at the shared validator layer
- keep `body` as the canonical field while accepting common agent-generated variants

### Hierarchy delegation guessed the wrong issue route

Symptom:

- a hired manager attempted `POST /api/issues`
- Paperclip returned `404`
- the manager stopped instead of creating the worker issue

Fix:

- add explicit company-scoped issue creation guidance to the Hermes prompt and Paperclip API skill
- add a helpful host-side error for `POST /api/issues`
- accept `body` as a create-issue compatibility alias and normalize it to `description`

### External skill checkpoints overrode Paperclip completion

Symptom:

- a Hermes-native skill such as `executing-plans` completed its own checklist
- Hermes posted a narrative summary, but skipped the required exact Paperclip
  issue comment and final status PATCH

Fix:

- make the adapter prompt explicit that loaded skills do not replace the required
  Paperclip workflow
- tell Hermes that "report", "wait", and "Ready for feedback" are only internal
  checkpoints inside a Paperclip child run unless the issue explicitly says to stop
- add E2E coverage for installed Hermes skills inside a hired-agent hierarchy

### `execute_code` produced Paperclip mutations against `/issues/None`

Symptom:

- a run used `execute_code` for a Paperclip comment or status update
- the sandbox resolved `PAPERCLIP_TASK_ID` as `None`
- the host received `POST /api/issues/None/comments` or `PATCH /api/issues/None`

Fix:

- make Paperclip API mutations terminal-only in the adapter prompt and shared skills
- call out the `None` failure mode explicitly so future prompt edits do not regress it

### Approved hires could lose their reporting chain

Symptom:

- approval payload contained a valid `reportsTo`
- approved agents sometimes surfaced with `reportsTo = null`

Fix:

- on approval, reconcile the hire payload back onto the pre-created pending agent record
- keep the approved agent row aligned with the approval source of truth before firing follow-up hierarchy logic

### Approval wakes could re-request an already approved hire

Symptom:

- the requester woke on `approval_approved`
- the task still said "create exactly one subordinate"
- Hermes submitted another `/agent-hires` call instead of reusing the approved agent

Fix:

- include approval type + payload summary fields in the approval wake context
- surface that summary directly in the Hermes prompt
- tell Hermes explicitly that an approved hire with `payload.agentId` already exists and must be reused
