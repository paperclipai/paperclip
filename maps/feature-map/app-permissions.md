---
navigation: {"section":"Apps, channels, and extensions","sectionOrder":50,"order":20}
---

# App access and action permissions

After connecting an app, an operator or authorized agent decides which agents may use it and whether each action is off, requires approval, or is allowed. Activity and action tests help verify the resulting access.

Feature ID: `app-permissions`.

Implementation: [app detail](../../ui/src/pages/apps/AppDetail.tsx), [permissions](../../ui/src/pages/apps/app-detail/PermissionsPanel.tsx), [activity](../../ui/src/pages/apps/app-detail/ActivityPanel.tsx).

Agent access: [companion](../agent-access-map/app-permissions.md).

## Sub-features

- `agent-access`: `app-permissions/agent-access` — grant the connection to all or selected eligible agents.
- `action-policy`: `app-permissions/action-policy` — set off/ask/allowed independently for available actions.
- `catalog-change`: `app-permissions/catalog-change` — review newly discovered/quarantined actions before enabling them.
- `test-action`: `app-permissions/test-action` — choose an actor and inputs and inspect a real action result.
- `account-maintenance`: `app-permissions/account-maintenance` — inspect accounts, reconnect/revoke, and review connection activity.

Changing the connection's agent list preserves profile assignments for agents
that remain installed. Saving the list must not restore a removed app-profile
assignment. New installations retain the current app-profile defaults.
Non-empty saves also remove legacy connection-wide include rules, including
unchanged lists and removals with no new targets.

## How to get to it (user POV)

### `permissions`

Open an app at `/apps/:connectionId/permissions`; this is the default connected-app view.

### `test-and-maintain`

Use the action test control in Permissions, then the connection’s Activity and available account/advanced controls.

### `delegated-permissions`

Ask an agent to change access or action policy for a named connection through
the existing APIs. The responsible person's current authority, the agent's
management grants, resource scope and all affected targets bound the request.
An explicitly requested, authorized policy change may target that same agent.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Prepare a connection to a fixture or test provider, two agents, and a harmless action. Record provider and credential ownership.

### `permissions`

Automated: [app detail](../../ui/src/pages/apps/AppDetail.test.tsx) covers agent/action controls, quarantined actions, and navigation using mocked requests.

[Installation permission regressions](../../server/src/__tests__/tool-connection-installs.test.ts)
exercise the real install API with a local operator and PostgreSQL. They check
that adding, removing, or retaining agents preserves removed app-profile grants
and denies write tools for agents with read-only profiles. They also check
company installations, new-agent defaults, legacy connection-wide include
cleanup, and access-extension audit records.
These fixtures do not qualify an agent-authenticated request or a live provider.

[Browser Use connection tests](../../server/src/__tests__/browser-use-connection.test.ts)
verify that an installed, permitted personal or organization connection is ready
for an agent and can satisfy an existing connection intent. Removed installs,
disabled connections, revoked grants and attention-health errors remain blocked.
These PostgreSQL fixtures do not prove live provider access or a rendered card.

[Runtime assignment tests](../../server/src/__tests__/agent-runtime-assignments.test.ts)
use PostgreSQL to verify committed assignment notifications, bounded snapshots,
rollback, and concurrent AI adoption. The owning lifecycle plugin can read
standing assignments through `ctx.agents.getRuntime`; this does not grant tool
execution access or replace task-specific authorization.

[Tool-definition runtime tests](../../server/src/__tests__/agent-runtime-tool-definitions.test.ts)
cover catalog invalidation, scoped policy/profile-entry recipients, ignored
bookkeeping, profile-entry edits concurrent with setup finalization, and profile
replacement concurrent with application deletion using PostgreSQL. They do not
qualify live provider access.

[Connector access runtime tests](../../server/src/__tests__/agent-runtime-connector-access.test.ts)
cover grants, delegation, membership cleanup, referenced vault changes, and
agent-scoped secret bindings. OAuth and Railway tests exercise the corresponding
credential lock order. Slack search and membership cleanup tests cover lock
contention and complete transaction retries. Provider calls use fixtures; no live credentials are
qualified by this coverage.

Manual: Grant one agent access, leave another excluded, and exercise off, ask, and allowed states for a harmless action. Reload between changes. Verify actual denied calls stay denied and ask-first creates a decision rather than executing early.

For Braintrust, distinguish reviewed action risk from effective policy: S4
methods retain the shared Allowed defaults. Explicit Off and Ask-first choices
must survive refresh and reconnect. Exercise the read, write, and destructive
classifications with a fixture, including billable tests classified as writes
and dataset row edits/automation activation classified as destructive. After
initial discovery, newly added or changed tools remain quarantined until
reviewed. Use synthetic data for provider calls; see
[Braintrust](../../doc/connections/BRAINTRUST.md#actions-and-governance). Live US
OAuth proof covers bounded reads, a synthetic dataset insert/readback through
actual process-agent gateway calls, and denial after local removal. Off,
Ask-first, and changed-tool denial use fixture evidence; the other three methods
still need live account qualification.

### `test-and-maintain`

Automated: [app detail tests](../../ui/src/pages/apps/AppDetail.test.tsx) cover test-dialog/UI contracts. Real provider execution and revocation require the selected provider’s live check.

Manual: Run a read-only action with explicit inputs and inspect returned data and activity. Refresh discovery and review new actions. Revoke or disconnect only the disposable credential, then verify subsequent use fails with an actionable reconnect state.

For Daytona, opening an older saved catalog discovers the current native
contract. Removed diagnostic actions disappear from Permissions and agent
discovery; new or changed actions require review. Existing Off/Allowed choices
remain in place. [Daytona regressions](../../server/src/__tests__/daytona-connection.test.ts)
cover shared/personal catalog upgrades, failed refresh, permission preservation,
run-bound file transfers, and revocation with fixture provider responses.

Unikraft actions follow the same review rules: deletion, stop/suspend/detach and
sandbox command execution are destructive, and catalog updates quarantine new or
changed actions. [Unikraft regressions](../../server/src/__tests__/unikraft-connection.test.ts)
cover classification, Off policies, revocation and stale contracts with fixture
provider responses.

### `delegated-permissions`

Automated: [production-authenticated integration](../../server/src/__tests__/connection-management.integration.test.ts)
covers actual key/JWT policy edits, retained targets, caller/target test policies,
human approval, scope and revocation using PostgreSQL and provider fixtures.

Manual: Request a bounded access or policy change through an actual agent, reload
Permissions, and verify the saved audience, action choice and agent audit actor.
Include an explicitly requested self-targeted policy edit. Repeat with missing
management grants, an excluded target/resource, and Ask or Plan mode; writes
must be denied. A denied tool call must not cause an unsolicited policy relaxation.
An Ask-first action still requires the authorized human's decision; the agent
cannot approve its own governed action or edit its own principal permissions.
Verify caller and target policies both apply when testing as another agent.

## Gotchas

- Connected does not imply an agent has access or an action is allowed.
- Credential-only connections may replace tool-action controls with account-specific controls.
- See [connection setup](./connection-setup.md) for auth and [questions and approvals](./questions-and-approvals.md) for pending action review.

### Storybook verification

#### `catalog-change`

Capability ID: `app-permissions/catalog-change`.

Scope: ui
Storybook: Mount PermissionsPanel/AppDetail with quarantined actions, selection/review, refresh pending, empty and failed discovery states. Existing auto-allowed NewToolsAllowed examples are not quarantine review.
Production: Exercise catalog refresh and new-tool review with permitted/denied actors; unreviewed actions stay quarantined, prior Off/Ask choices survive refresh, and approved review persists.
Sources: Source: [PermissionsPanel.tsx](../../ui/src/pages/apps/app-detail/PermissionsPanel.tsx), [AppDetail.tsx](../../ui/src/pages/apps/AppDetail.tsx), [tool-access.ts](../../server/src/routes/tool-access.ts). Tests: [AppDetail.test.tsx](../../ui/src/pages/apps/AppDetail.test.tsx), [tool-access-service.test.ts](../../server/src/__tests__/tool-access-service.test.ts), [tool-access-policy-service.test.ts](../../server/src/__tests__/tool-access-policy-service.test.ts)
### `delegated-configuration`

See the canonical [delegated configuration guidance and acceptance evidence](connection-setup.md#delegated-configuration).
