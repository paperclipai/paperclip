# Private tasks and projects

Paperclip work is company-open by default. A task or project can instead be
marked private when its title, discussion, documents, attachments, work
products, or agent run traces should be limited to named participants.

## Who can read private work

A private task is readable by its responsible user, creating user, current
user or agent assignee, active task grantees, and members of its private
project. Restrictions flow down through children and run-created handoffs. Sharing or
assigning a task grants access to that task and its descendants; ancestors and
siblings require a separate grant. An assignment grant stays
active until it is explicitly revoked. Current assignment, ownership, private-project
membership, and inherited access remain independent reasons for access. The
sharing panel shows the source; revoking one grant does not remove other reasons.
Making a parent private protects existing descendants in the same transaction.
Moving a task under a private parent inherits privacy. A child cannot be made
public while it inherits a private boundary; making a parent public leaves its
existing private children private.

Private projects have a separate access-member list. A task-level grant can
expose one task without exposing its containing private project. Direct reads
by non-members return `404`, and list, count, search, attention, status-card,
activity, run-history, and tree-control surfaces apply the same predicate.
Visible blocker and mention edges may show a locked identifier-only stub; they
never include the private task's title or content.

Audit logs remain company-wide because they are the sanctioned oversight path.
They contain entity identifiers rather than private task content. Dashboard and
sidebar aggregate counts also remain company-wide: they may include private
work in totals, but do not expose titles, descriptions, or identifiers. The
issue list/count APIs themselves are viewer-filtered.

## Audited break-glass

Company owners and admins do not silently inherit private-task access. A normal
task detail request still returns `404`. When an owner or admin has a legitimate
emergency need, they must deliberately request the task with
`?breakGlass=true`.

Every successful break-glass read writes both:

- an `issue.break_glass_read` audit row containing the actor, task id, and time;
- a warning system notice on the private task so its owners can see that access occurred.

The flag does not change the canonical read predicate, create a grant, or make
future reads implicit. Non-admin members and agents cannot use it.

## Agent runs and shared-agent residual risk

Issue-bound run detail, events, transcripts, logs, and workspace operations use
the task ACL. Run authority is the intersection of the agent and the run's responsible user.
Reusing an agent does not transfer a different user's private-task permission.
Company run lists retain only timing/status/token/cost metadata for
non-members so budget oversight continues without exposing task identity or run
content.

Workspace operation records retain their original task and run sources even if
those entities are deleted or the operation is relinked. Deletion preserves the
audit record; unresolved sources make its details and log inaccessible. A
company-scoped run does not override a private task linked to the operation.

> **Residual risk — trusted agents (`trust-agent`).** Paperclip enforces privacy
> on reads from the control plane, but an agent that legitimately processes a
> private task may write learned content into shared persistent memory, its home
> directory, an external tool, or a later public response. V1 deliberately
> trusts the agent not to exfiltrate that context. Use isolated execution
> workspaces and appropriately trusted agents for sensitive work; task ACLs are
> not a sandbox or data-loss-prevention system.

## Plugins and notification/digest surfaces

Plugins (including any Slack notifier or digest plugin) are **non-member
principals**: they hold no company membership, task grant, or private-project
access. Rather than an allowlist of individually patched methods, the plugin
host centralizes the synthetic non-member check into shared helpers
(`requirePluginReadableIssue`, `pluginReadableIssueIdsByIds`,
`pluginRedactRelationSummary`) and routes **every** issue-derived read through
them. The complete inventory of issue-derived reads and their disposition:

- **Direct issue content** — `issues.list` (SQL predicate), `issues.get`,
  `issues.listComments`, `issues.listAttachments`, `issues.getAttachmentContent`,
  `issueDocuments.list`, `issueDocuments.get`: a private task is filtered from
  list results, returns `null`/empty on soft reads, and reports "not found"
  (indistinguishable from missing) on document reads.
- **Subtree / orchestration** — `issues.getSubtree` and
  `issues.getOrchestrationSummary`: a private *root* reports "not found"; an
  open root drops private descendants **before** any relation, document, run,
  or assignee is fetched, so no private row or its metadata enters the payload.
- **Relationship metadata** — `issues.getRelations` (and the summaries echoed
  by `issues.setBlockedBy` / `addBlockers` / `removeBlockers`, and the subtree
  relation maps): blocker/blocks edges pointing at a private task are dropped,
  recursing into nested terminal blockers, so its title, status, and assignee
  never surface even on a public task.
- **Interactions** — `issues.listInteractions`: a private task yields no
  interaction payloads.

A synthetic `{ type: "none" }` actor resolves to the same public-only scope as
any other non-member. This is why a digest broadcast to a shared channel —
whose audience is non-members by definition — cannot carry private issue
content. Writes that operate on a task must also satisfy its read predicate; plugin
capabilities do not substitute for task access. Returned relationship summaries
remain redacted.

There is intentionally **no plugin oversight exception**: unlike the
company-wide audit log, no plugin read path bypasses the predicate. A plugin
that must surface private work would need an explicit, separately designed
oversight capability; none exists today.

> **Residual metadata disclosure.** A plugin still learns aggregate,
> content-free signals about private work that mirror the accepted
> dashboard/count disclosure: `issues.getOrchestrationSummary` returns
> company-wide `openBudgetIncidents`. Its `costs`/token roll-up is limited to
> the readable subtree, and unreadable relationship edges are omitted entirely.
> No private title, body, comment, attachment, identifier, relationship target,
> or locked-edge signal is exposed.

## Rollout modes

`PAPERCLIP_ISSUE_PRIVACY_MODE=enforce` is the default. `shadow` records
structured would-deny decisions without enforcing them and exists only for
rollout diagnosis. `off` disables the task predicate. Operators should not use
`shadow` or `off` when private-task confidentiality is required.

The production gate includes positive and negative checks: an authorized reader
can read a shared child and its descendants, an unrelated reader cannot, and a
warm HTTP or live subscription loses that grant after revocation. Privacy grants
are read from the database without a cross-request positive cache.

## Migration and current runtime integration

Migration `0291_private_task_access.sql` adds the task/project ACL tables and
backfills privacy parent edges with indexed keyset batches. Run binding is derived
from native task identity, explicit issue identity, or legacy context. Missing
source tasks remain issue-scoped tombstones. Context changes cannot turn those
runs into company-wide history. The migration is idempotent for preview installs;
existing explicit grants are preserved. Operators upgrading an unreleased preview
should inspect root grants created under its former whole-tree sharing semantics.

Migration `0292_private_task_draft_assets.sql` accompanies enforcement and binds
historical inline images to their first owned task. Unbound drafts remain
uploader-only under the new asset-content guard.

Private output uses the same predicate on native tool searches and task context,
linked approvals, training exports, execution workspace APIs, stored run-response
assets, and WebSocket delivery. Workspace access requires permission for every
linked task. Chat publications recheck recipient identity and task access at the
provider boundary: private output is withheld from shared channels and from DMs
whose known recipients no longer qualify. This does not revoke Gmail or other
connection credentials; connection permissions continue to apply independently.

## CI leak-test inventory

The privacy regression gate is part of the normal server Vitest suite. Its
surface coverage is intentionally distributed beside the routes and services
it protects:

| Surface | Non-member regression coverage |
| --- | --- |
| Downward sharing, responsible-user intersection, mutation denial, provenance, live revocation | `privacy-production-review.test.ts` |
| Task detail, list, count, grants, documents, work products | `issue-access-grants-routes.test.ts`, `company-search-service.test.ts` |
| Search and machine extract | `company-search-service.test.ts`, `company-search-extract-service.test.ts` |
| Attention feed | `attention-service.test.ts` |
| Status-card hydrate and dry-run | `status-cards.test.ts` |
| Activity stream | `activity-service.test.ts`, `activity-routes.test.ts` |
| Run list, live run, detail, transcript, events, logs, operation history | `heartbeat-run-privacy-routes.test.ts` |
| Tree holds and tree control | `issue-tree-control-routes.test.ts` |
| Blocker and mention identifier-only stubs | `issue-access-grants-routes.test.ts` |
| Attachment content | `issue-attachment-routes.test.ts` |
| Private-project list and direct read | `projects-list-archived-routes.test.ts` |
| Plugin issue reads (list, get, comments, attachments, orchestration, subtree, relations, interactions, documents) | `plugin-orchestration-apis.test.ts` |

Adding a new task-derived read surface requires a non-member fixture in this
gate before the surface can ship.

Project privacy management belongs to its recorded creator (the responsible user
for agent-created projects), the personal-project owner, and administrators.
Project read membership alone never allows publishing the project or changing
its audience. Legacy projects recover ownership from their creation audit event;
when that evidence is missing, an administrator manages their privacy.
