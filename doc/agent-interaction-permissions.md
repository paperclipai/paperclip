# Individual agent interaction permissions

Interaction permissions are optional restrictions on actions between agents.
They are independent of low-trust presets and principal permission grants. They
have no UI or bundled preset; a human permission manager configures individual
agents through the CLI or API.

Every setting defaults to unrestricted when absent. Existing agents are not
rewritten, new agents do not persist default values, and no migration or grant
backfill is required. An explicit `true` removes this restriction only: company
boundaries, visibility, trust, responsible-user authority, grants, approvals,
checkout and execution rules still apply.

## Settings

| Operation | Outgoing setting | Incoming setting |
| --- | --- | --- |
| Assign/delegate work to an agent | `canAssignTasksToAgents` | `canReceiveAssignmentsFromAgents` |
| Assign work to a human | `canAssignTasksToHumans` | Existing human authorization |
| Mention another agent | `canMentionAgents` | `canReceiveMentionsFromAgents` |
| Comment on another task | `canCommentOnOtherTasks` | `canReceiveCommentsFromAgents` |
| Edit another task | `canEditOtherTasks` | `canReceiveTaskEditsFromAgents` |
| Configure another agent | `canConfigureOtherAgents` | `canReceiveConfigurationChangesFromAgents` |

An operation must pass both applicable sides. An explicit `false` is not
overridden by a CEO role, manager relationship, assignment grant, parent-report
exception, or the human responsible for the acting agent's run. Authenticated
human actions retain their ordinary authorization without these agent-only
restrictions.

An ordinary task is owned by its current agent assignee; an agent's own
conversation belongs to its canonical conversation agent. Human-assigned and
unassigned tasks are other tasks for outgoing comments and edits. Creating a
task, owning its parent, or formerly being its assignee does not establish current
ownership. Self-interactions retain existing authorization.

Assignments to a new agent check the sender and destination. Reassigning,
unassigning, or claiming an existing task also checks edits against its current
owner. Initial content on a newly assigned task is part of assignment; it does
not require permission to edit that agent's existing tasks. Creating or moving
a child under someone else's task checks the affected parent.

Comments and task messages share the comment controls. Mentions are checked
separately, so a permitted comment can still be denied for mentioning a protected
agent. A denial rejects the entire operation. Structured Paperclip agent links
are mentions; an ordinary name in prose is not. Allowed mentions retain their
existing context-link behavior and do not start execution or forward messages.
New or changed mention-bearing text is checked; unrelated edits do not rescan
untouched history. Delegated reports have no automatic exception.

Task edits include instructions, status, assignment, hierarchy, dependencies,
execution policy, documents, attachments, work products, and feedback results.
Compound operations must pass every applicable control. Posting a comment does
not require edit permission solely because the server updates bookkeeping.

Configuration controls cover peer instructions, settings, runtime configuration,
skill/tool assignments, and restores. Shared company resources retain their
existing permissions; changing a shared skill is not treated as editing every
agent that uses it. Initial hiring remains governed by hiring authorization.

## CLI and API

Use a board-authenticated CLI context whose human has `users:manage_permissions`.
Read access follows agent configuration read authorization. Agents, including
CEOs, cannot change these restrictions.

```sh
paperclipai agent interaction-permissions <agent-id>

paperclipai agent interaction-permissions:update <agent-id> \
  --payload-json '{"canReceiveCommentsFromAgents":false}'

paperclipai agent interaction-permissions:update <agent-id> \
  --payload-json '{"canReceiveCommentsFromAgents":null}'
```

The last command removes that override. Omitted keys are preserved; `null`
restores the default. Human-readable output identifies explicit versus default
values. Both commands support `--json`.

The underlying endpoints are `GET /api/agents/:id/interaction-permissions` and
`PATCH /api/agents/:id/interaction-permissions`. PATCH accepts a nonempty partial map
of the setting names to booleans or `null`. Unknown keys and malformed values
are rejected. Responses contain `agentId`, `companyId`, sparse `overrides`, and
the resolved `effective` map. Effective values describe this restriction layer,
not the outcome of every other authorization rule.

For an agent that should accept only human-directed interactions, explicitly
set all five incoming controls to false:

```sh
paperclipai agent interaction-permissions:update <agent-id> --payload-json '{
  "canReceiveAssignmentsFromAgents": false,
  "canReceiveMentionsFromAgents": false,
  "canReceiveCommentsFromAgents": false,
  "canReceiveTaskEditsFromAgents": false,
  "canReceiveConfigurationChangesFromAgents": false
}'
```

This is a configuration example, not a stored preset. Outgoing controls remain
independent and can be set individually.

## Persistence and changes in flight

Only the dedicated endpoint changes `agents.permissions.interactions`. It merges
under the agent row lock and records the before/after audit in the same
transaction. Saving does not start work, retry a task, reactivate membership, or
alter unrelated grants. Pending hires cannot be changed before approval.

Other permission/configuration saves preserve the subtree, including when an
older client omits it. Attempts to change it through those APIs are rejected.
Restores cannot revive older interaction permissions. Company package exports
omit this instance's restrictions with a warning; configure the imported agent
explicitly after creation rather than copying another agent's authority.

Current restrictions are checked before pending execution and input delivery,
including queued steering. Coalesced input retains per-item origin, so a human
message does not authorize an otherwise prohibited agent message. Refused
delivery retains an inspectable permanent policy outcome instead of retrying
indefinitely. Removing the restriction later does not automatically replay the
refused delivery.

A refused child-completion report does not undo the child's completed work.
The report keeps a terminal refusal receipt. Dependency completion can still
notify the parent with a system event that contains no agent-authored report.

Permission changes do not delete saved comments, rewrite assignments, terminate
running work, or sanitize historical context. Subsequent actions from running
agents use current permissions. Older queue records use existing source
provenance when available; explicitly restricted work with insufficient
provenance cannot be assumed to be human-authorized.

Deploy compatible servers and workers before configuring restrictions. An older
binary cannot enforce these controls. No existing agent is configured during
deployment. These are addressed-action controls, not filesystem/network
isolation or a new read-access boundary: agents can still read otherwise
accessible history, shared files, skills, and external content.

Direct connection installs, profile bindings, and gateways that target an agent are configuration changes. Shared connection/profile changes and connection reads keep their existing authorization checks without treating every consumer as a configuration recipient. Mutation services recheck direct targets under ordered agent locks, independently of the shared-resource authorization check.

Plugin tool invocations retain the host-issued originating agent and run through host calls and queued delivery. A worker cannot replace that identity with a user or system label. Background plugin work without an originating agent retains its existing authority.
