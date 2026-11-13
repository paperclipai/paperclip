# Chat feature scenarios

This is the planning catalog for what happens when a person asks an agent to use
Paperclip. It belongs to [Product E2E](../README.md), alongside the existing chat
and Everyday Workflows suites. These files contain human requests, assumed context
and loosely specified outcomes. Entries alone do not run models, register tests,
or contribute passing results to a report. Two task entries now have explicit
[executable Product E2E cases](../CHAT-FEATURES.md): `tasks.create-backlog` and
`tasks.delegate-announcement`. Their results remain in the existing E2E reports.

The [feature map](../../../maps/feature-map/README.md) answers what the product
lets a person do. The [agent access map](../../../maps/agent-access-map/README.md)
records which APIs and actual agent entry points exist and their boundaries.
This catalog asks whether a person can accomplish that work through a conversation,
including discovering a prerequisite, completing a human step and returning to
work. All three reuse the same capability IDs.

## Start with these requests

- [Hire a Claude Code engineer](agents.yaml): `agents.hire-claude-code`, with
  missing-account, approval-required, denied-permission and ambiguous-wording cases.
- [Create a website task](tasks.yaml): `tasks.website-task`, with missing-project,
  attached-brief, ambiguous-task, privacy and ownership-conflict cases.
- [Archive completed inbox items](inbox-search.yaml): `inbox-search.archive-done`,
  with missing authority, partial failure and undo cases.
- [Read Notion](connection-setup.yaml): `connection-setup.notion-connected` and
  `connection-setup.notion-missing` deliberately use the same sentence. The second
  requires setup in the conversation and continuation after usable access exists.
  Other cases cover decline, wrong account, unassigned agent and expired access.

## Reading a scenario

Each area file uses [catalog.schema.json](catalog.schema.json) and implicitly
inherits [defaults.yaml](defaults.yaml). Scenario context overrides those defaults.
A scenario is independent: mentions of previous turns or existing resources are
fixture requirements, not dependencies on running an earlier catalog entry.

| Field | Meaning |
| --- | --- |
| `schema_version` | Version of this planning format; currently `1`. |
| `feature` | Primary feature-map filename without `.md`. |
| `status` | Always `planned`; execution results belong to the existing E2E system. |
| `scenarios[].id` | Stable, globally unique `<feature>.<scenario>` identifier. |
| `capabilities` | Full feature-map IDs exercised by this request; may span areas. |
| `context` | Existing records, current identity, authority, accounts, gates and significant starting conditions, plus any later human action or fault needed for the branch. |
| `query` | The natural-language message a person would send, including an answer or follow-up where that is the subject of the case. |
| `expected_outcome` | A paragraph describing the visible conversation, resulting durable state, necessary human interaction and meaningful boundaries. |

For example, two fixtures can send “Read my Notion and tell me the latest on the
launch.” In the connected fixture, the answer comes from current pages and links
back to them. In the unconnected fixture, the agent requests setup, the addressed
person completes it, and the original work continues. A third fixture declines
setup and should receive a truthful explanation without any provider read.

Context and expected outcomes are **evaluator material**. Do not paste them into
an agent's system prompt or teach the model which API to choose. A future fixture
should expose the actual product state, ordinary production instructions, the
human query and any genuine attachments or previous conversation. The model must
discover the available operations normally.

## What coverage means here

Every current feature-map capability has at least one associated scenario. This
is inventory coverage, not complete operation coverage, source verification or
live acceptance. Broad capabilities can still need more CRUD, actor, transport,
provider and lifecycle variations. The maps' Policy and Gaps sections remain the
source for access assumptions; recheck them against implementation when promoting
an entry. The YAML does not grant permissions or promise an unimplemented UI.

The default starting point is a person talking to their CEO in Agent Chat with
legitimate agent permissions. CEO is not board identity. A valid expected outcome
can therefore be direct action, a grounded answer, a necessary clarification, a
connection or approval request, a precise human handoff, or a truthful boundary.
An unsupported operation must not be “passed” because the agent says it succeeded.
A vague “you can do this in settings” is also insufficient when a supported
specific control or request card exists.

Some capabilities cannot originate inside an already working chat: first server
installation, login, an unfinished first-agent wizard, browser preferences and
developer-only labs. Their entries explicitly describe the relevant boundary or
companion journey. External MCP and channel cases also name their different
surface. Preserve those labels in future selection and reporting; a successful
operator, browser-only or external-client step cannot certify a direct Agent Chat
action. Where only guidance is currently possible, qualifying automated chat
execution requires a separate product change and updated access contract.

## Conditional coverage to preserve

| Condition | Representative scenarios |
| --- | --- |
| Account ready / missing / wrong / expired / not assigned | `connection-setup.notion-*` |
| Allowed / human approval / denied / wrong resolver | `agents.hire-*`, `questions-and-approvals.wrong-reviewer` |
| Unambiguous / missing required detail / ambiguous reference | `tasks.website-task`, `questions-and-approvals.necessary-question`, `tasks.ambiguous-task` |
| Complete list / partial mutation / undo | `tasks.organize-open-work`, `inbox-search.archive-partial-failure`, `inbox-search.restore-archive` |
| Same company / other company / private resource | `access.other-company`, `access.private-resource`, `tasks.private-task` |
| Current decision / stale decision / duplicate answer | `questions-and-approvals.ambiguous-yes`, `questions-and-approvals.review-plan`, `questions-and-approvals.duplicate-answer` |
| Idle / busy / steering / stop / saved continuation | `steering.*`, `recovery.post-stop-message` |
| Known result / uncertain side effect / failed accounting | `recovery.unknown-email-outcome`, `budgets-costs.repair-cost-recording` |
| Feature enabled / disabled / different surface | `cases.cases-disabled`, `agent-chat.chat-disabled`, `developer-labs.gated-lab` |
| Saved record / actually ready / independently usable output | `runs-adapters.validate-hire`, `workspaces.preview-service`, `documents-artifacts.produce-download` |

Different starting conditions should usually be separate scenarios with the same
query, so one favorable fixture cannot satisfy all branches. Outcomes can mention
invariant guards without turning each paragraph into a complete executable test.
When implementing a branch that currently contains several human choices, split
those choices into explicit cells while preserving the planning scenario's ID as
traceability metadata.

## Promoting a scenario later

1. Read the matching product recipe and access companion. Confirm the operation,
   actual admitted agent surface and permission rules; keep current gaps visible.
   Decide whether this is an Agent Chat journey or a named companion boundary.
2. Reuse or extend the existing Product E2E fixture, catalog and report paths.
   [Everyday Workflows](../EVERYDAY-WORKFLOWS.md) already cover hiring/reuse,
   delegation, connection decisions and delivered work. Existing chat-hardening,
   chat-qualification, completion-update and confirmation suites are also
   documented in the [E2E guide](../README.md). Overlap is a reuse opportunity,
   not evidence that this exact query and context have passed.
3. Create isolated synthetic state through supported production setup surfaces.
   Pin the clock, identities, policy, runtime and provider profile; record feature
   gates and owned test connections. Keep actual secret material out of this
   catalog. Follow [fixture](../FIXTURES.md) and [security](../SECURITY.md) rules.
4. Send the query through the real conversation UI. Drive each specified human
   answer, connection callback, navigation, reconnect or fault at its actual
   boundary. Preserve the source chat and linked tasks across those transitions.
5. Turn the outcome into independent assertions: rendered response and correct
   links; saved records and attribution; exact target and audience; actual file
   bytes or provider receipt; absence of unintended mutations; correct return to
   work. Validate the oracle against a plausible wrong outcome. Success prose,
   a tool declaration or an accepted HTTP response alone cannot pass a journey.
6. Declare the ordinary E2E execution selection, environment, turn/time/cost
   limits, cleanup and evidence contract. Retain failures, retries, source and
   definition revisions, actual model/profile, usage and missing evidence in the
   existing report. A changed setup or model is a separate measurement, and a
   missing observer is not a pass. No live or paid runs are authorized by these
   planning files themselves.

The first useful runnable slice is the user's three core jobs plus the paired
Notion branches above. Extend from that slice across this catalog without building
a second runner, scheduler, scoring system or evidence store.

## Maintaining the catalog

Keep area filenames aligned with the feature map and IDs stable when wording
changes. Add a capability reference only when the query and outcome exercise it;
linking every scenario to every related subsystem would inflate coverage. Write
specific context and an observable paragraph rather than mechanically repeating a
feature description. Use cross-feature references for real combined journeys.

Before handing off edits, parse every YAML file, validate area files against the
schema, check unique IDs and nonempty prose, and reconcile capability references
with the Sub-features keys in `maps/feature-map/*.md`. Check both missing and
unknown IDs. The schema alone cannot validate references or uniqueness across
files. `defaults.yaml` is shared context and is not an area-schema document.

`chat-scenario-catalog.test.ts` performs these structural checks in
`pnpm test:e2e:runner:unit`, including the 35 areas, 244 scenario IDs and 191 mapped
capabilities. Update the inventory counts intentionally when the catalog grows.

After editing map links, also run `node scripts/check-maps.mjs`. That existing
check validates the maps, not this YAML catalog and not live chat behavior. Keep
structural validation and any future execution evidence separate. Do not label a
scenario passed, register a paid cell or alter default suite selection merely
because its planning text has been reviewed.

## Browse by feature

The feature recipe and same-named access companion define each area's behavior
and authority. Each YAML file can also reference capabilities from other areas.

| Scenarios | Product recipe | Agent access |
| --- | --- | --- |
| [access](access.yaml) | [Feature](../../../maps/feature-map/access.md) | [Access](../../../maps/agent-access-map/access.md) |
| [activity](activity.yaml) | [Feature](../../../maps/feature-map/activity.md) | [Access](../../../maps/agent-access-map/activity.md) |
| [agent-chat](agent-chat.yaml) | [Feature](../../../maps/feature-map/agent-chat.md) | [Access](../../../maps/agent-access-map/agent-chat.md) |
| [agents](agents.yaml) | [Feature](../../../maps/feature-map/agents.md) | [Access](../../../maps/agent-access-map/agents.md) |
| [app-permissions](app-permissions.yaml) | [Feature](../../../maps/feature-map/app-permissions.md) | [Access](../../../maps/agent-access-map/app-permissions.md) |
| [assistant-connections](assistant-connections.yaml) | [Feature](../../../maps/feature-map/assistant-connections.md) | [Access](../../../maps/agent-access-map/assistant-connections.md) |
| [budgets-costs](budgets-costs.yaml) | [Feature](../../../maps/feature-map/budgets-costs.md) | [Access](../../../maps/agent-access-map/budgets-costs.md) |
| [cases](cases.yaml) | [Feature](../../../maps/feature-map/cases.md) | [Access](../../../maps/agent-access-map/cases.md) |
| [chat-channels](chat-channels.yaml) | [Feature](../../../maps/feature-map/chat-channels.md) | [Access](../../../maps/agent-access-map/chat-channels.md) |
| [cli-operations](cli-operations.yaml) | [Feature](../../../maps/feature-map/cli-operations.md) | [Access](../../../maps/agent-access-map/cli-operations.md) |
| [companies](companies.yaml) | [Feature](../../../maps/feature-map/companies.md) | [Access](../../../maps/agent-access-map/companies.md) |
| [connection-setup](connection-setup.yaml) | [Feature](../../../maps/feature-map/connection-setup.md) | [Access](../../../maps/agent-access-map/connection-setup.md) |
| [developer-labs](developer-labs.yaml) | [Feature](../../../maps/feature-map/developer-labs.md) | [Access](../../../maps/agent-access-map/developer-labs.md) |
| [documents-artifacts](documents-artifacts.yaml) | [Feature](../../../maps/feature-map/documents-artifacts.md) | [Access](../../../maps/agent-access-map/documents-artifacts.md) |
| [execution-environments](execution-environments.yaml) | [Feature](../../../maps/feature-map/execution-environments.md) | [Access](../../../maps/agent-access-map/execution-environments.md) |
| [gateways-profiles](gateways-profiles.yaml) | [Feature](../../../maps/feature-map/gateways-profiles.md) | [Access](../../../maps/agent-access-map/gateways-profiles.md) |
| [goals](goals.yaml) | [Feature](../../../maps/feature-map/goals.md) | [Access](../../../maps/agent-access-map/goals.md) |
| [inbox-search](inbox-search.yaml) | [Feature](../../../maps/feature-map/inbox-search.md) | [Access](../../../maps/agent-access-map/inbox-search.md) |
| [instance-operations](instance-operations.yaml) | [Feature](../../../maps/feature-map/instance-operations.md) | [Access](../../../maps/agent-access-map/instance-operations.md) |
| [navigation-preferences](navigation-preferences.yaml) | [Feature](../../../maps/feature-map/navigation-preferences.md) | [Access](../../../maps/agent-access-map/navigation-preferences.md) |
| [onboarding](onboarding.yaml) | [Feature](../../../maps/feature-map/onboarding.md) | [Access](../../../maps/agent-access-map/onboarding.md) |
| [plugins](plugins.yaml) | [Feature](../../../maps/feature-map/plugins.md) | [Access](../../../maps/agent-access-map/plugins.md) |
| [projects](projects.yaml) | [Feature](../../../maps/feature-map/projects.md) | [Access](../../../maps/agent-access-map/projects.md) |
| [questions-and-approvals](questions-and-approvals.yaml) | [Feature](../../../maps/feature-map/questions-and-approvals.md) | [Access](../../../maps/agent-access-map/questions-and-approvals.md) |
| [recovery](recovery.yaml) | [Feature](../../../maps/feature-map/recovery.md) | [Access](../../../maps/agent-access-map/recovery.md) |
| [routines](routines.yaml) | [Feature](../../../maps/feature-map/routines.md) | [Access](../../../maps/agent-access-map/routines.md) |
| [runs-adapters](runs-adapters.yaml) | [Feature](../../../maps/feature-map/runs-adapters.md) | [Access](../../../maps/agent-access-map/runs-adapters.md) |
| [secrets](secrets.yaml) | [Feature](../../../maps/feature-map/secrets.md) | [Access](../../../maps/agent-access-map/secrets.md) |
| [skills](skills.yaml) | [Feature](../../../maps/feature-map/skills.md) | [Access](../../../maps/agent-access-map/skills.md) |
| [status-cards](status-cards.yaml) | [Feature](../../../maps/feature-map/status-cards.md) | [Access](../../../maps/agent-access-map/status-cards.md) |
| [steering](steering.yaml) | [Feature](../../../maps/feature-map/steering.md) | [Access](../../../maps/agent-access-map/steering.md) |
| [task-coordination](task-coordination.yaml) | [Feature](../../../maps/feature-map/task-coordination.md) | [Access](../../../maps/agent-access-map/task-coordination.md) |
| [tasks](tasks.yaml) | [Feature](../../../maps/feature-map/tasks.md) | [Access](../../../maps/agent-access-map/tasks.md) |
| [teams](teams.yaml) | [Feature](../../../maps/feature-map/teams.md) | [Access](../../../maps/agent-access-map/teams.md) |
| [workspaces](workspaces.yaml) | [Feature](../../../maps/feature-map/workspaces.md) | [Access](../../../maps/agent-access-map/workspaces.md) |
