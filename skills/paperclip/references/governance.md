# Governance: Where Rules Live, and Learning From Failures

Paperclip has three instruction layers. Putting a rule in the wrong layer is how the same mistake repeats across companies.

- **Root (bundled) Paperclip skills** — universal factory invariants. Inherited by every company, read-only, always synced to agents. Changed only in the Paperclip codebase.
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

Post the classification as a comment on the failed issue, and create the follow-up improvement issue when `should_create_followup_issue` is true (respect the two-level topology: improvement issues are new parent issues or lanes under an ops/governance parent, never grandchildren). For `durable_fix_target: root_skill` or `orchestration_code`, the follow-up issue should request board/instance-owner review since the fix lives outside the company.
