# Durable tool approvals

Outcome: a person can approve the saved action later, after ordinary OAuth refresh
and a server restart. Paperclip executes its reviewed arguments once and returns
the result to the task. Delivery ends at a reviewed PR with passing checks.

The approval binds the action, task, company, selected authorization, tool contract,
destination, and audience. OAuth token lifetime is separate from that decision.
Authenticated refresh may preserve credential identity; manual replacement and
new consent may not. Current access and task state still gate provider dispatch.

| Acceptance | Evidence |
| --- | --- |
| Original failure reproduced | Real local OAuth HTTP exchange and two refreshes; original approval fails with `approved_tool_target_changed` before the fix |
| Approve later | Same HTTP fixture, ended requesting run, rebuilt gateway, approval after 25 hours |
| Execute once | Repeated approval returns the receipt without another provider call |
| Preserve boundaries | Changed consent, scope, identity, tool, destination, arguments, closed task, manual rotation and explicit deadlines refuse execution |
| Connection repair | Keep an accepted decision for a provably unchanged authorization during a pre-dispatch authentication wait; show repair in context and resume on connection changes |
| Upgrade compatibility | Old signatures retain strict version checks; no inferred continuity for already-rotated historical credentials |

Owners: OAuth credential storage owns authenticated refresh continuity. The vault
owns credential identity epochs. Tool approval target validation owns the saved
contract. Existing approval execution, recovery and delivery own claims, results
and continuation. Shared interaction cards own user-facing repair and deadlines.

Progress: reproduced the original 409 for both OAuth client modes before the
repair. The local OAuth HTTP journey now passes for personal and shared grants,
public and confidential clients, delayed review, ended runs, reconstructed gateway,
duplicate approval, changed scopes/consent/tool/destination, manual token replacement,
and event-driven authorization repair. The journey injects the production OAuth
refresher and proves that an invalid refresh preserves the decision before action
dispatch. It also covers equivalent scope-reporting changes, withdrawn formal
approvals during sign-in waits, and explicit deadlines on saved decisions.
Gateway service regressions,
connected-tool acceptance and vault suites passed after making their intentional
expiry fixtures explicit. UI tests, server/UI typechecks, token gates and catalog
checks passed. The production task-thread repair state was inspected in local
Storybook. Providers are simulated by the local HTTP fixture; no staging rollout
or real Notebook publication is claimed. Verification planning returned exit 2
and requires broad CI coverage. PR and review checks are next.
