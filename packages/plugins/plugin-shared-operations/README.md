# Shared Operations

An optional Paperclip plugin for central instructions, sourced working memory,
bounded decisions and evaluated instruction changes. It adds a company page and
authenticated APIs, using Paperclip's existing tasks and agent identities.

This is an experimental control surface. It does not replace Paperclip's
scheduler, approvals, account authentication or LLM Wiki, and does not launch
models, run evaluations or change agent instructions automatically.

## What is enforced

| Workflow | Enforced condition |
| --- | --- |
| Instructions | The board publishes the initial immutable policy. Later policies pass through an improvement proposal; the board can reactivate a previously approved version. |
| Memory | Records have source references, content digests, explicit status and an expected revision. Concurrent updates fail rather than overwrite silently. |
| Handoffs | A snapshot binds the active policy, selected memory revisions and the current assigned task. Only the receiving agent can acknowledge it. Task reassignment or editing invalidates a pending acknowledgement. |
| Decisions | A named owner, required evidence, a deadline and one to three consultation rounds bound each decision. No change, deferral and escalation are valid outcomes. Reopening needs a changed requirement or different evidence content. |
| Improvement | A proposal freezes its baseline, candidate, evaluation checks and trial budget. Promotion needs a positive measured improvement, all mandatory checks, independent attribution and the same active baseline. |

Agent commands cannot impersonate the board by supplying an actor in JSON. Host
authentication supplies the actor. Company writes use a conditional revision
update. Handoff persistence also locks and checks the actual task row in the same
statement, preventing a task edit between validation and saving the receipt.

An irreversible action, high-risk decision, publication, spend or account change
requires a board decision to proceed. This governs the decision record: it does
not intercept an unrelated tool or turn a recorded decision into a Paperclip
approval. Existing host permissions and approvals still apply to execution.

## Install from a checkout

Use a checkout containing this plugin and the associated plugin-database runtime
support for allowlisted core reads in conditional writes. The manifest requests
read access to `companies` and `issues`; it does not grant writes to core tables.

From the repository root:

```sh
pnpm install
pnpm --filter @paperclipai/plugin-shared-operations typecheck
pnpm --filter @paperclipai/plugin-shared-operations test
pnpm --filter @paperclipai/plugin-shared-operations build
```

In the local instance's Plugins page, install the absolute path to
`packages/plugins/plugin-shared-operations`. Alternatively, an authenticated
board can POST to `/api/plugins/install` with
`{"packageName":"<absolute package path>","isLocalPath":true}`. Local trusted
instances accept loopback board requests; other deployments require their normal
board authentication. Use the returned plugin database ID in API URLs.

Enable the plugin and open **Shared Operations** in a company's sidebar. Publish
the first instruction version through **Instructions**. No agent is started by
installation or policy publication.

Rebuild after source or manifest changes, then reload the plugin or restart the
local server. Back up the instance database before upgrading or removing it.
Disabling this plugin stops its API and UI; it does not undo instructions already
copied to agents or roll back work performed by a harness.

## Central instructions and existing Wiki

`GET /api/plugins/<plugin-id>/api/instructions?companyId=<company-id>` returns
`{policyId,digest,markdown}`. An instance integration can project that markdown
into Paperclip's managed agent instruction bundle. Such a projection should pin
the policy digest, verify the stored bundle, and demonstrate inclusion in an
actual fresh harness run. File existence alone does not prove inclusion.

Skills in a policy are named instruction text. Hooks are declarative workflow
checkpoints, explicitly labelled as such in the generated prompt. They are not
executable harness hooks. This plugin stores neither OAuth tokens nor account
profiles; use each harness's native authentication and isolate profiles outside
the repository.

Use LLM Wiki for source ingestion, search, linked knowledge and ongoing wiki
maintenance. This plugin's memory is a small, explicitly selected working set for
decisions and handoffs. Source text is evidence, not an instruction authority.
Keep stale, contested and omitted context visible. A receipt is acknowledgement
of a particular snapshot, not proof of comprehension or task correctness.

## API contract

All routes live under `/api/plugins/<plugin-id>/api` and require board or agent
authentication. An agent's company access is enforced by Paperclip.

| Method | Route | Result |
| --- | --- | --- |
| GET | `/overview?companyId=<id>` | Current `{revision,state}` |
| GET | `/instructions?companyId=<id>` | Active policy markdown and digest |
| GET | `/tasks/<task-id>/context-head?companyId=<id>` | Actual `{id,taskRevision,receiverId}` |
| POST | `/commands` | Updated `{revision,state}` |

Every command body contains `companyId`, `expectedRevision` from the latest
overview, and `command`. For example:

```json
{
  "companyId": "00000000-0000-0000-0000-000000000001",
  "expectedRevision": 0,
  "command": {
    "type": "policy.publish",
    "id": "initial",
    "reason": "Establish the initial operating rules",
    "bundle": {
      "instructions": ["Record the expected benefit and stop condition before work."],
      "constraints": ["A justified no-change decision is a successful outcome."],
      "skills": [],
      "hooks": []
    }
  }
}
```

The exported `Command` union in `src/domain.ts` is the complete command contract;
unknown fields and invalid values are rejected at runtime. On `409`, reload and
review the changed state before constructing another command. Do not blindly
retry a decision, evaluation or acknowledgement with a newer revision.

Use the opaque `taskRevision` returned by `context-head`, never a timestamp
constructed by the client. Task tokens refer to the current live database;
create fresh snapshots after database restoration. Snapshot receipts must come
from the assigned agent's authenticated request, not from a board request with
the agent's name in its body.

## Evaluations and limits

The board records evaluation attestations with an evaluator ID, a unique run
reference and digests of inspectable evidence. The proposer cannot be the
attributed evaluator. The plugin checks the recorded values and trial limits;
it does not execute the evaluator, authenticate a manually entered evaluator ID,
fetch evidence references or establish that a claimed result is true. Independent
checks of the underlying artefacts remain necessary.

Checks and non-regression checks must each contain at least one named gate. At
least one metric must require a positive improvement. Failed, skipped, missing
or repeated results cannot satisfy promotion. Recreating the same candidate
against the same baseline cannot reset its trial budget by rearranging the
evaluation specification. The latest evaluation governs promotion.

Version 0.1 keeps each company's working state and audit events in a single atomic
JSON document, capped at 900,000 UTF-8 bytes. Reaching the limit returns `422`; no
history is silently discarded. This deliberately small first version is not a
large-scale memory archive. A production-scale deployment needs an export and
history migration strategy before this limit is reached. Policy bundles and
context snapshots are each capped at 32 KiB.

Committed commands also write to the host company activity log with their type,
subject, committed revision and authenticated actor. Policy and memory contents
are not copied into the host log. The SDK activity call is separate from the
state transaction. If it fails, the API returns `503 activity_log_failed` and
names the saved revision. Refresh the state; do not resubmit that command. The
complete domain event remains in the company document for audit reconciliation.
This first version does not automatically retry unconfirmed host log writes.

The plugin does not implement subscription quota discovery, automatic account
rotation, model routing, training-data collection, model training, or a GrokBot
group transport. Those are separate integrations, not implied by this plugin's
policy and evidence records.

## Verification

The package tests cover invalid commands, permissions, late debate, material
evidence, stale handoffs, concurrent writes, measured promotion and rollback.
The host's `plugin-database.test.ts` covers the SQL guard and real PostgreSQL
conditional task writes. To exercise a local installation, use a temporary
company and paused synthetic agent: verify cross-company denial, a stale task
receipt rejection, one winning concurrent update, bounded consultation, and a
deterministic candidate promotion followed by rollback. Revoke temporary keys
and archive the fixture company afterwards.

For a PR-ready repository check, follow `AGENTS.md`: recursive typecheck, the
repository test suite, and the full build. Report failures separately from this
plugin's focused checks; a passing synthetic fixture is not production evidence.
