# App access, action permissions, and testing

After connecting an app, an operator decides which agents may use it and whether each action is off, requires approval, or is allowed. Activity and action tests help verify the resulting access.

Implementation: [app detail](../ui/src/pages/apps/AppDetail.tsx), [permissions](../ui/src/pages/apps/app-detail/PermissionsPanel.tsx), [activity](../ui/src/pages/apps/app-detail/ActivityPanel.tsx).

## Sub-features

- `agent-access`: grant the connection to all or selected eligible agents.
- `action-policy`: set off/ask/allowed independently for available actions.
- `catalog-change`: review newly discovered/quarantined actions before enabling them.
- `test-action`: choose an actor and inputs and inspect a real action result.
- `account-maintenance`: inspect accounts, reconnect/revoke, and review connection activity.

## How to get to it (user POV)

### `permissions`

Open an app at `/apps/:connectionId/permissions`; this is the default connected-app view.

### `test-and-maintain`

Use the action test control in Permissions, then the connection’s Activity and available account/advanced controls.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Prepare a connection to a fixture or test provider, two agents, and a harmless action. Record provider and credential ownership.

### `permissions`

Automated: [app detail](../ui/src/pages/apps/AppDetail.test.tsx) covers agent/action controls, quarantined actions, and navigation using mocked requests.

Manual: Grant one agent access, leave another excluded, and exercise off, ask, and allowed states for a harmless action. Reload between changes. Verify actual denied calls stay denied and ask-first creates a decision rather than executing early.

### `test-and-maintain`

Automated: [app detail tests](../ui/src/pages/apps/AppDetail.test.tsx) cover test-dialog/UI contracts. Real provider execution and revocation require the selected provider’s live check.

Manual: Run a read-only action with explicit inputs and inspect returned data and activity. Refresh discovery and review new actions. Revoke or disconnect only the disposable credential, then verify subsequent use fails with an actionable reconnect state.

## Gotchas

- Connected does not imply an agent has access or an action is allowed.
- Credential-only connections may replace tool-action controls with account-specific controls.
- See [connection setup](./connection-setup.md) for auth and [questions and approvals](./questions-and-approvals.md) for pending action review.
