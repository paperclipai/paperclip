# Governance: Where Rules Live, and Learning From Failures

Paperclip has three instruction layers. Putting a rule in the wrong layer is how the same mistake repeats across companies.

- **Root (bundled) Paperclip skills** — universal factory invariants. Inherited by every company and read-only. Skills are required by default; maintainer-only operational skills can declare `required: false` and remain available without being synced to every agent. Changed only in the Paperclip codebase.
- **Company skills** — repeatable procedures local to one company's domain.
- **`AGENTS.md` / agent prompts** — role identity for one agent.

Core invariant: **do not bury universal factory behavior inside one disposable agent prompt.** Agents can be deleted, cloned, or mis-edited; a rule that must hold everywhere belongs in the root layer or in orchestration code.

## Decision model

Edit `AGENTS.md` (agent prompt) when the change is about:

- role identity, reporting lines, tone/communication style;
- responsibility boundaries for one specific agent;
- something unique to one role in one company.

Create or update a **company skill** when:

- the behavior is repeatable inside one company;
- multiple agents need the same procedure;
- the company has a domain-specific workflow;
- a mistake happened because a repeatable local procedure was missing;
- the company needs local acceptance checks.

Recommend a **root skill change** (escalate to the Paperclip maintainer/instance owner — root skills cannot be edited from inside a company) when:

- the behavior is a universal Paperclip invariant;
- the mistake could happen in any company;
- the rule governs delegation, QA, recovery, audit, or cross-agent orchestration;
- the same class of mistake repeated across companies or plausibly could.

Company skills may **extend** root invariants (add stricter local checks) but must never contradict or weaken them. If a company instruction conflicts with a root skill, the root skill wins; flag the conflict.

## Incident-to-skill loop

Do not only fix the failed task. Fix the mechanism that allowed that failure class.

When an issue fails, drifts, needs rework, or exposes a systemic gap, classify it:

- `handoff_context_loss` — executor lacked context the manager had
- `missing_source_of_truth` — reference material absent or unreachable
- `weak_acceptance_criteria` — nobody could say what "done" meant
- `qa_checked_output_not_contract` — QA passed plausible-but-wrong work
- `broken_skill` / `missing_skill` — skill malformed, unassigned, or absent
- `wrong_agent_assignment` — task went to an agent without the capability
- `agent_prompt_gap` — role prompt missing a boundary or duty
- `workspace_or_runtime_gap` — environment/tooling failure
- `blocked_issue_recovery_gap` — blocked work sat with no escalation
- `external_dependency_gap` — third-party/service dependency unhandled
- `user_approval_or_policy_gap` — needed approval path didn't exist

Then determine the durable fix and record it:

```json
{
  "incident_type": "handoff_context_loss",
  "durable_fix_target": "root_skill | company_skill | agent_prompt | orchestration_code | qa_gate | workspace_guard",
  "recommended_action": "",
  "should_create_followup_issue": true,
  "owner_role": "CEO | CTO | QA | PaperclipMaintainer | CompanyAdmin"
}
```

Post the classification as a comment on the failed issue. Then record an evidence-backed improvement suggestion with `POST /api/companies/{companyId}/improvement-suggestions`. Include the target layer, proposed change, at least one evidence reference, and `sourceIssueId` when applicable. Suggestions created by agents enter `pending_review`; only the board can accept or reject them through `POST /api/companies/{companyId}/improvement-suggestions/{suggestionId}/review`.

Board **Needs work** votes enter the same review queue as `feedback_detected` candidates. They remain distinct from `agent_detected` suggestions and `board_directed` changes, and include a `feedback_vote` evidence reference. A later reason updates the pending candidate in place; changing the vote to **Helpful** closes a still-pending candidate. Accepted or manually rejected decisions are never silently rewritten by a vote change.

```json
{
  "targetLayer": "agent_prompt | company_skill | root_skill | orchestration_code | qa_gate | workspace_guard | company_sop",
  "title": "Short improvement title",
  "summary": "What failed or drifted and why this is systemic",
  "proposedChange": "The durable behavior or guardrail to add",
  "evidence": [
    { "kind": "issue | comment | run | log | document | file | url | other", "ref": "stable reference", "note": "why it matters" }
  ],
  "sourceIssueId": "optional issue UUID"
}
```

Board review payloads use `{ "decision": "accept | reject", "note": "decision rationale" }`. A suggestion can be decided only once; later review attempts fail instead of rewriting the original decision. Company owners and admins may record directives and review company-level targets. Root-level targets (`root_skill`, `orchestration_code`, `qa_gate`, and `workspace_guard`) require instance-admin authority. Operators, viewers, and ordinary members are not governance authorities.

Authorized board-created records are stored separately as `board_directed` changes and are accepted at creation. They do not masquerade as agent-detected suggestions and cannot be sent through the suggestion review queue. This preserves the difference between an operator directive and an agent's recommendation in the audit trail. Board-created directives do not attach a `sourceRunId`; authenticated agent suggestions may attach only the creating agent's own run from the same company.

Create the follow-up improvement issue when `should_create_followup_issue` is true (respect the two-level topology: improvement issues are new parent issues or lanes under an ops/governance parent, never grandchildren). Link that issue in the suggestion evidence. For `durable_fix_target: root_skill` or `orchestration_code`, the follow-up issue and suggestion should request board/instance-owner review since the fix lives outside the company.
