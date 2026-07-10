# Execution Contracts

Every delegated child issue MUST carry an execution contract. The contract is the single source of truth the executor works from and QA reviews against. Delegation without a contract is invalid.

Core invariant: **missing required context is a blocker, not permission to invent.** If a required field is absent or a source-of-truth link is unreachable, the executor blocks and names what is missing. It does not fill gaps with assumptions.

## Where the contract lives

Put the contract in the child issue's hidden `executionContract` JSON field when creating or updating the issue. The issue `description` remains the durable human-readable brief: it should explain the objective, relevant human context, source links or filenames, and a short acceptance summary in prose. Do not leave delegated child descriptions empty, and do not use the description as only a JSON contract dump.

Agents receive this hidden field through `PAPERCLIP_WAKE_PAYLOAD_JSON.executionContract`, `GET /api/issues/{issueId}/heartbeat-context.issue.executionContract`, and `GET /api/issues/{issueId}.executionContract`. Do not require humans to read or maintain the contract inside the description, and do not ignore a human description when a hidden contract exists.

Legacy compatibility: older issues may still have a `## Execution Contract` fenced `json` block in the description or an issue document with key `contract`. Use those as fallback sources and, when possible, copy the parsed contract into the hidden `executionContract` field. Do not erase or rewrite the issue description merely because the contract was extracted. New delegations must use the hidden `executionContract` field and keep the visible description readable.

Server enforcement: agent-created child issues are rejected when the resolved hidden contract is missing or invalid. Human-created issues are exempt; agents reconstruct a contract from a human's natural-language request when they pick up the work.

## Contract schema

```json
{
  "schemaVersion": 2,
  "contractType": "delegated_task",
  "taskType": "implementation | research | design | qa | ops | marketing | docs | finance | reference_fidelity | incident_response | other",
  "core": {
    "objective": "Concrete outcome required",
    "why": "Business/user reason this matters",
    "sourceOfTruth": {
      "links": [],
      "files": [],
      "issueDocuments": [],
      "previousOutputs": [],
      "externalSystems": [],
      "requiredContext": []
    },
    "constraints": {
      "mustPreserve": [],
      "mustChange": [],
      "mustNotChange": [],
      "assumptionsAllowed": [],
      "assumptionsForbidden": []
    },
    "dependencies": {
      "blockedByIssueIds": [],
      "externalBlockers": [],
      "requiredAccess": []
    },
    "acceptanceChecks": [],
    "evidenceRequired": [],
    "blockIfMissing": [],
    "handoffNotes": {
      "managerReasoning": "",
      "knownRisks": [],
      "openQuestions": [],
      "nonGoals": []
    }
  },
  "extensions": {
    "qa": {
      "reviewMode": "contract_fidelity",
      "failConditions": []
    },
    "skillSpecificNamespace": {
      "customField": "custom value"
    }
  }
}
```

Required fields for every contract: `schemaVersion`, `contractType`, `taskType`, `core.objective`, `core.why`, `core.sourceOfTruth` (at least one non-empty entry), `core.acceptanceChecks` (at least one), `core.handoffNotes.managerReasoning`. Empty arrays are fine for the rest, but must be deliberate, not omitted by laziness.

The `extensions` object is intentionally open-ended. QA, deployment, reference-fidelity, finance, or company-specific skills may add namespaced extension objects. A skill may validate its own extension, but it must not delete or reinterpret the core contract.

## Manager duties (before delegating)

- Externalize your reasoning. Anything you know that the executor needs — user intent, prior decisions, rejected approaches, non-goals — goes into the contract. The executor must not have to reconstruct intent from the parent thread or your hidden context.
- Write a readable child issue description too. The contract prevents drift, but the description is what humans and quick issue lists rely on.
- Every acceptance check must be verifiable by QA without asking you.
- List `must_not_change` items explicitly. "Obvious" preservation requirements are the most common silent failure.
- If you cannot fill the required fields, the work is not ready to delegate. Ask the requester, or create a discovery task instead.

## Task-type notes

- `implementation`: `source_of_truth.files` and `acceptance_checks` are mandatory. `evidence_required` should include tests run and, for UI work, screenshots.
- `reference_fidelity` (rebuild/match-a-reference work): the reference itself is mandatory in `source_of_truth.links` or `files`; `constraints.must_preserve`/`must_not_change` are mandatory and reviewed first by QA.
- `research`: `acceptance_checks` state what questions must be answered and with what sourcing standard.
- `qa`: the contract under review is itself the source of truth; see QA duties below.
- `incident_response`: `block_if_missing` must include access/credentials needed; escalation path goes in `handoff_notes`.

## Executor preflight (before starting work)

Run this checklist immediately after checkout, before doing any domain work:

1. The issue has an execution contract (`PAPERCLIP_WAKE_PAYLOAD_JSON.executionContract`, `GET /api/issues/{issueId}/heartbeat-context.issue.executionContract`, `GET /api/issues/{issueId}.executionContract`, or a legacy description/document fallback).
2. Any non-empty issue description has been read as the human/operator brief.
3. Every `core.sourceOfTruth` entry is reachable — open the links, stat the files, fetch the documents.
4. Every `core.blockIfMissing` item is present.
5. `core.dependencies.requiredAccess` is available to you.
6. The `core.objective` and `core.acceptanceChecks` are concrete enough that you could hand your output to QA and they could verify it without talking to you.

If any check fails:

- Move the issue to `blocked` (or comment requesting recovery from the delegating manager).
- State exactly which fields/links/items are missing.
- Do NOT proceed on assumptions. A plausible result built on guessed context is a contract violation even if it looks good.

If the issue has no contract at all and the delegator is an agent, comment asking the delegator to supply one and set the issue `blocked`. If the delegator is a human user, reconstruct the contract yourself from their request without deleting or replacing the user's description, post it as a comment for visibility, and proceed — humans are not required to write contracts, agents are.

## QA duties (contract review)

QA verifies the work **against the contract**, not against general quality intuition:

- Required `core.sourceOfTruth` was actually used.
- `core.constraints.mustPreserve` items preserved; `core.constraints.mustChange` items changed; `core.constraints.mustNotChange` items untouched.
- Every `core.acceptanceChecks` item passes, with evidence.
- Every `core.evidenceRequired` item exists (link it in the QA comment).
- `core.blockIfMissing` items were not silently skipped.
- The output solves the contract's `core.objective` — not a related, plausible-looking problem.

QA MUST fail work that is high quality but solves the wrong problem. "Looks great" is not a pass. When failing, cite the specific contract field violated.

## Evidence

Record evidence appropriate to the task type: files changed, tests run, screenshots, API checks, logs, old-vs-new comparison, deployment URL, artifact links, remaining risks. Attach it to the issue (comments, documents, work products, attachments) before requesting review.

When evidence uses attachments, reference each attachment by filename/link and exact location: screenshot region, page number, table row, timestamp, or visible UI area. Preserve those attachment links in downstream execution-contract comments so reviewers can open the same evidence from the comment that mentions it.
