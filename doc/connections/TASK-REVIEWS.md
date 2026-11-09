# Connection reviews in task history

An agent call governed by **Ask human / Ask first** creates a server-owned
`request_confirmation.payload.toolAction` interaction linked to the existing
`tool_action_requests` record. No provider call runs while this review is pending.
The default approval lifetime remains one hour.

The task feed keeps one record for each review. **Review request** opens the
composer takeover. Dismissing the takeover only hides it; the review remains
pending, ordinary comments do not supersede it, and the agent is not resumed.
Multiple reviews retain separate records and the existing takeover navigation.
The card shows the app icon and a short request description. Destructive actions
retain destructive approval styling. Audit metadata and signed arguments remain
on the underlying review record.

**Approve & run** executes the signed, stored arguments once. **Decline** executes
nothing in one click. Both the task and Connections queue use
one decision transaction; a decision removes the pending queue item while its
history remains on the task. The human decision, resolver, remembered permission,
and execution outcome remain separate. Provider failure does not turn an approved
decision into a decline. Successful results stay collapsed behind the status chevron;
expanding it shows formatted JSON (or plain text). The resumed agent processes the
recorded result in a new turn and writes the user-facing answer. Live activity
invalidation refreshes both surfaces, with existing polling/reconnect reconciliation
retained.

## Remembered permission

Choose **Always allow** from the split button beside **Approve & run**. It
atomically saves approval and an action-wide trust rule for the
same agent, connection, and action, restricted to the originating project when one
exists. Future argument values may differ. The menu item exposes the scope through
its tooltip and accessible description; the receipt records the saved permission. If saving the rule
fails, the approval transaction rolls back and no provider call runs.

The rule remains bound to the reviewed catalog definition/schema. Changed
definitions require review again. Revocation, explicit denial, connection access,
and formal approval requirements remain effective. Manage/revoke rules through the
existing Connections trust-rule controls.

The accept/approve endpoints support optional `rememberAction: true`; omission
continues to approve once. Trust-rule promotion supports `argumentMode: "action"`;
its existing omitted/`"exact"` mode continues to bind exact argument values.

## Governed waiting and recovery

The gateway returns `approval_required` with the linked request/interaction IDs
and instructions to finish unrelated work, then yield `in_review` without retrying
or claiming completion. Agent task completion is rejected while a linked action
is pending, approved, or executing. Provider execution is server-owned.

`tool_action_deliveries` is a durable, content-free outbox keyed by action request.
It refers to the authoritative request, invocation, and interaction instead of
copying provider data. Once the originating runs have ended and no other task
interactions remain pending, ready outcomes are batched into one continuation
wake. The wake includes the recorded result/decline and instructions not to repeat
the operation. Native runners materialize validated server-owned interaction
outcomes; legacy runners receive the wake context and agent message. Existing
scheduler eligibility and budget gates still apply. Closed tasks retire receipts;
reassignment does not deliver the old agent's outcome to another agent.

Startup and periodic sweeps recover committed approvals, undelivered outcomes,
expiry, and incomplete feed projections. An execution left in progress for ten
minutes is marked failed with `tool_execution_outcome_unknown`. Its external
outcome is uncertain: inspect the provider before retrying. It is never
automatically replayed. This grace period exceeds the current approved-call timeout.

Migration 0249 adds the outbox and a partial unique wake-idempotency index.
The index is built transactionally; migration can briefly block wake-table writes
while PostgreSQL scans an existing large table. No external payload is added to the
outbox.

## Verification workflows

Run the credential-free, isolated browser suite:

```sh
PAPERCLIP_E2E_PORT=3222 pnpm exec playwright test -c tests/e2e/connection-reviews.config.ts
```

This starts a dedicated embedded database/server and local MCP fixture, configures
Ask first through the UI, and verifies approve, decline, remembered permission with
changed arguments, dismissal/reopening, ordinary comments, cross-tab queue/task
updates, provider failure, and restart while waiting. Assertions include useful
agent results and provider invocation counts. Screenshots, JSON journey identifiers,
and traces are attached to the Playwright HTML report. The deterministic agent is a
scripted process adapter; these results do not prove model-runner behavior.

Run the opt-in, local model-runner matrix with the harness's normal credentials:

```sh
PAPERCLIP_RUNNER_E2E_CONNECTION_REVIEWS=1 pnpm test:e2e:runner -- --suite connection-reviews
```

The 16 cells cover approve, decline, always allow, and restart/resume for native
Codex, native ACPX Claude, legacy Codex CLI, and legacy Claude CLI. Qualified model
settings come from the existing runner catalog. This flag does not expand the
normal hosted/Daytona matrix. The fixture MCP provider is real HTTP but is not
Notion; live Notion evidence must be reported separately.

For a real Notion test, start `paperclipai test-drive` from this checkout using
valid provider credentials, verify its process checkout/port ownership, connect
Notion normally, set an available read-only search/list action to Ask human, and
perform the same approve/decline/always-allow journeys for all four profiles.
Capture request/run IDs, screenshots, traces, and actual page results. Missing
credentials or account/provider access are untested dependencies, never a pass.

## Storybook

```sh
pnpm --filter @paperclipai/ui exec storybook dev -p 6018 -c storybook/.storybook --no-open --ci
```

Open **Chat & Comments / Connection Reviews**. The production task thread/card and
Connections queue cover pending, dismissed/reopened, multiple requests, each
submitting action, recoverable errors, concurrent resolution, approved/executing,
success/failure, decline with/without a reason, expiry/cancellation, remembered
scope/receipt, approval options, narrow layout, and queue/empty states. The global
theme toolbar switches light/dark. Story actions simulate server responses; use the
browser suite for integration proof.

Provider output, execution errors, and review notes travel in the continuation's
`untrustedToolResults` field, separate from its control instructions. Both native
and legacy wake prompts render those fields as fenced JSON with an explicit
untrusted-data boundary. Embedded provider instructions cannot grant permission
or change the task's continuation policy. Wake materialization redacts secrets
and bounds each text field before rendering.

A continuation includes at most eight shortened result records and caps the
serialized wake context at 32 KB. It links to the task interaction API for all
full outcomes and instructs the agent to retrieve omitted or incomplete results
before finishing. A committed receipt cutoff preserves acknowledgement of that
referenced set across restart, without putting an unbounded ID list in the wake.
Task review queries reconcile every 20 seconds if a live event is missed.
