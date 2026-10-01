# Low-Trust Presets

Paperclip ships core trust preset names so containment decisions are enforced in
Community Edition even when EE policy editing is unavailable.

## Presets

- `standard`: the default V1 company-visible collaboration model. This preserves
  existing behavior for normal agents.
- `low_trust_review`: an opt-in containment preset for automated work that may
  consume hostile or prompt-injected input, such as untrusted pull requests,
  external tickets, dependency diffs, or generated review output.

## Boundary Model

`low_trust_review` is resolved from existing JSON policy fields:

- agent permissions: `permissions.trustPreset` and
  `permissions.authorizationPolicy.trustBoundary`
- project policy:
  `executionWorkspacePolicy.authorizationPolicy.trustBoundary`
- issue/run policy: `executionPolicy.authorizationPolicy.trustBoundary`

The resolver intersects those sources. Narrower wins. A low-trust preset must
resolve to a concrete company-local project, root issue, or issue-id scope. If a
policy source names another company, uses an unsupported preset, or lacks that
scope for risky access, Paperclip fails closed.

## Containment, Not Privacy

This is containment for hostile automated work. It is not a general project,
issue, or human privacy system.

V1 standard work remains company-visible by default: board users and in-company
actors can inspect company work objects unless a separate access-control feature
changes that behavior. Low-trust containment instead limits what the low-trust
agent can read or mutate through the Paperclip API and prevents raw untrusted
output from being automatically promoted into higher-trust agent context.

Low-trust agents cannot read or mutate agent configuration, instruction bundles,
or company skill configuration through direct grants. Configuration changes from
low-trust work must go through higher-trust review and promotion paths instead.

Low trust does not prohibit task creation. Agents may create tasks assigned to
themselves, and subtasks of their own tasks, within their permitted project or
root-task scope. Creation uses the normal task-assignment permission checks,
including explicit assignment restrictions and the responsible user's authority,
even for an unassigned task. Other assignees must be explicitly within the trust
boundary; board-user assignments remain forbidden. New tasks retain the creator's
effective containment policy and quarantined source attribution. An exact issue-id
scope does not implicitly authorize new descendants, and a permitted parent does
not grant access to an unrelated project. An explicit root-task scope includes
its descendants. Self-assigned decomposition is not a delegation cycle.

Permission denials must identify the rejected action and specific restriction.
In particular, agents must explain that low-trust permissions prevent saving
persistent instructions such as their own `AGENTS.md`, surface failed save
receipts, and provide proposed changes for an authorized human to apply. Creating
another task does not authorize the instruction change.

## Human-directed work

An authenticated board user can talk to a low-trust agent in their own Agent
Chat or assign it a task outside its default intake boundary. Existing conversation
identity authorizes owner chat. Ordinary tasks use the human requester already
recorded on the run's wakeup requests, including coalesced requests. Each request
retains its server-owned origin; plugin-attributed users do not count as board
instructions. Legacy board assignment requests remain valid through their existing
assignment source, reason, and human requester, without trusting old plugin human
attribution. A board backlog assignment is retained as a completed assignment
request with no run, so it authorizes the later system launch without starting
work prematurely. No separate permission table or client-supplied human identity is needed. Responsible-user
attribution, external connector sender attribution, and agent claims do not qualify.

At dispatch and API authorization, Paperclip checks the live run and current
assignment in one database snapshot. The exception permits reading, commenting
on, and updating only that run's exact task. It does not extend to another task,
a child, a whole project, configuration, instructions, secrets, or runtime
management. Normal responsible-user checks still apply. The exception is never
stored in the inherited trust boundary.

Automatic retries and continuations follow the existing `retryOfRunId` database
links, checking the same company, agent, and task at every step. Cancelled runs
cannot authorize a retry. The common assignment transaction cancels prior human
requests, including plugin and service reassignments. Assigning the task back
cannot revive those requests, and late run settlement cannot undo cancellation. Sandbox and
isolated workspace requirements still apply, as do malformed-policy and
company-boundary checks.

## Child→Parent Reporting Under Containment

The direct-parent report comment (`doc/execution-semantics.md` §6, "Child→Parent
Reporting") is **off by default** for `low_trust_review`: a contained run reads
untrusted input, so a free-prose comment into the higher-trust parent thread is
a prompt-injection promotion path. Contained reviewers report by completing
their own review issue (`done` — the verdict is the deliverable; the
`issue_blockers_resolved` wake carries it upward) and by the platform's
system-attributed stop-only relay when they enter `blocked` or `cancelled`.
Never instruct a contained delegate to comment on its parent issue.

## Runtime Containment

Managed `low_trust_review` runs fail closed unless Paperclip can enforce the
runtime boundary:

- the selected execution environment must use the `sandbox` driver
- the effective execution workspace mode must be `isolated_workspace`
- the issue being run must be inside the resolved low-trust boundary or be the
  exact human-directed task described above
- secret references must use binding ids explicitly allowed by the boundary
- inline sensitive environment values such as API keys and tokens are rejected
- workspace runtime-service mutations are denied unless the boundary explicitly
  grants the `runtime.manage` tool class

When the task's project has no configured workspace and no layer specifies a
workspace strategy, sandbox execution uses a private directory for that company
and task. The directory persists across turns and reassignment and never imports the shared
project directory or agent home. No Git repository is required for this case.
Configured workspaces and explicit Git strategies keep their existing validation;
a missing or broken checkout does not fall back to an empty directory.

The Docker workflow in `doc/UNTRUSTED-PR-REVIEW.md` remains useful for manual
local review, but Paperclip-managed low-trust execution requires a sandboxed
environment instead of a host-local adapter process.
