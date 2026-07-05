# Execution Contracts

Every delegated child issue MUST carry an execution contract. The contract is the single source of truth the executor works from and QA reviews against. Delegation without a contract is invalid.

Core invariant: **missing required context is a blocker, not permission to invent.** If a required field is absent or a source-of-truth link is unreachable, the executor blocks and names what is missing. It does not fill gaps with assumptions.

## Where the contract lives

Embed the contract in the child issue **description** under a `## Execution Contract` heading, as a fenced `json` block. For very large contracts, put the full contract in an issue document with key `contract` and keep a summary block in the description that links to it (`#document-contract`).

## Contract schema

```json
{
  "objective": "Concrete outcome required",
  "why": "Business/user reason this matters",
  "task_type": "implementation | research | design | qa | ops | marketing | docs | finance | reference_fidelity | incident_response | other",
  "source_of_truth": {
    "links": [],
    "files": [],
    "issue_documents": [],
    "previous_outputs": [],
    "external_systems": [],
    "required_context": []
  },
  "constraints": {
    "must_preserve": [],
    "must_change": [],
    "must_not_change": [],
    "assumptions_allowed": [],
    "assumptions_forbidden": []
  },
  "dependencies": {
    "blocked_by_issue_ids": [],
    "external_blockers": [],
    "required_access": []
  },
  "acceptance_checks": [],
  "evidence_required": [],
  "block_if_missing": [],
  "handoff_notes": {
    "manager_reasoning": "",
    "known_risks": [],
    "open_questions": [],
    "non_goals": []
  }
}
```

Required fields for every contract: `objective`, `why`, `task_type`, `source_of_truth` (at least one non-empty entry), `acceptance_checks` (at least one), `handoff_notes.manager_reasoning`. Empty arrays are fine for the rest, but must be deliberate, not omitted by laziness.

## Manager duties (before delegating)

- Externalize your reasoning. Anything you know that the executor needs — user intent, prior decisions, rejected approaches, non-goals — goes into the contract. The executor must not have to reconstruct intent from the parent thread or your hidden context.
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

1. The issue has an execution contract (description section or `contract` document).
2. Every `source_of_truth` entry is reachable — open the links, stat the files, fetch the documents.
3. Every `block_if_missing` item is present.
4. `dependencies.required_access` is available to you.
5. The `objective` and `acceptance_checks` are concrete enough that you could hand your output to QA and they could verify it without talking to you.

If any check fails:

- Move the issue to `blocked` (or comment requesting recovery from the delegating manager).
- State exactly which fields/links/items are missing.
- Do NOT proceed on assumptions. A plausible result built on guessed context is a contract violation even if it looks good.

If the issue has no contract at all and the delegator is an agent, comment asking the delegator to supply one and set the issue `blocked`. If the delegator is a human user, reconstruct the contract yourself from their request, post it as a comment for visibility, and proceed — humans are not required to write contracts, agents are.

## QA duties (contract review)

QA verifies the work **against the contract**, not against general quality intuition:

- Required `source_of_truth` was actually used.
- `must_preserve` items preserved; `must_change` items changed; `must_not_change` items untouched.
- Every `acceptance_check` passes, with evidence.
- Every `evidence_required` item exists (link it in the QA comment).
- `block_if_missing` items were not silently skipped.
- The output solves the contract's `objective` — not a related, plausible-looking problem.

QA MUST fail work that is high quality but solves the wrong problem. "Looks great" is not a pass. When failing, cite the specific contract field violated.

## Evidence

Record evidence appropriate to the task type: files changed, tests run, screenshots, API checks, logs, old-vs-new comparison, deployment URL, artifact links, remaining risks. Attach it to the issue (comments, documents, work products, attachments) before requesting review.
