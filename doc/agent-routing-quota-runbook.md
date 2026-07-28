# Agent routing runbook: GLM-5.2 quota limits

This runbook is the operational companion to the authoritative routing policy
in [`AGENTS.md`](../AGENTS.md). It applies to confirmed provider quota events on
agents backed by GLM-5.2, including both session limits and weekly limits.

## Preconditions and trigger

Start this runbook only when the provider response, run record, or operator
evidence confirms a quota condition for the affected GLM-5.2-backed agent:

- a provider session-limit condition; or
- a provider weekly-limit condition.

Do not treat a generic transient capacity error, timeout, rate-limit-looking
message without provider confirmation, or unrelated adapter failure as a quota
trigger. Triage those through the normal failure/retry path.

## Procedure

1. Record the affected agent and the evidence identifying the provider quota
   condition. Keep the evidence free of credentials, tokens, and customer data.
2. Enumerate that agent's open issues in `todo`, `in_progress`, `in_review`, and
   `blocked`. Do not include terminal `done` or `cancelled` issues.
3. For each open issue, find a replacement that is:
   - Codex-backed;
   - in the same discipline; and
   - in the same capability tier.

   When multiple eligible same-tier peers exist, apply the existing within-tier
   active-workload rule. Remove candidates that are paused, budget-limited, or
   otherwise unavailable. If no eligible same-tier candidate remains, queue the
   work or create/escalate a capacity issue. Do not route down-tier.

4. Apply status handling per issue:

   | Current status | Action before/with reassignment |
   | --- | --- |
   | `todo` | Preserve `todo`. |
   | `in_review` | Preserve `in_review` and its review path. |
   | `blocked` | Preserve `blocked` and its blocker/owner context. |
   | `in_progress` | Reset to `todo` only when the work was abandoned; then reassign. |
   | `done` / `cancelled` | Do not reopen or reassign. |

   Do not reset active, non-abandoned `in_progress` work without documenting
   why it is abandoned. Preserve the issue's done criteria and relevant
   dependencies when moving it.

5. For review work, use a same-role Codex review peer where one exists. If none
   exists, send only allowlisted coordination or final-sign-off work to the
   CTO. Create a capacity/escalation issue for all other review work.
6. Add an audit comment to each changed issue. The comment must name:
   - original assignee and replacement assignee;
   - discipline and capability tier;
   - confirmed reason, explicitly identifying `session limit` or `weekly limit`;
   - whether the status was preserved or reset from abandoned `in_progress` to
     `todo`; and
   - the replacement's done criteria.

## Verification

Confirm that:

- every eligible open issue was enumerated and handled or linked to a capacity/
  escalation issue;
- no `done` or `cancelled` issue changed;
- no issue was routed to an unavailable candidate or down-tier candidate;
- preserved statuses and blocker/review context remain intact;
- abandoned `in_progress` issues are now `todo`; and
- each reassignment has the required audit comment.

If a same-tier Codex candidate becomes available later, resume queued work using
the same selection and audit rules. Do not infer quota recovery from a generic
successful run; confirm the provider state before returning work to a GLM-backed
agent.

## Review and GitHub restrictions

This routing procedure does not change review governance. Internal review
findings stay in Paperclip. Agents must not request GitHub reviewers, post
Paperclip-internal review content on GitHub, or merge pull requests. A reroute
does not itself make a branch review-ready; normal conflict, isolation,
validation, and CI gates still apply.
