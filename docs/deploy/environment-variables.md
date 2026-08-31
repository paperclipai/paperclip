---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that Paperclip uses for server configuration.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `PAPERCLIP_BIND` | `loopback` | Reachability preset: `loopback`, `lan`, `tailnet`, or `custom` |
| `PAPERCLIP_BIND_HOST` | (unset) | Required when `PAPERCLIP_BIND=custom` |
| `HOST` | `127.0.0.1` | Legacy host override; prefer `PAPERCLIP_BIND` for new setups |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string |
| `PAPERCLIP_HOME` | `~/.paperclip` | Base directory for all Paperclip data |
| `PAPERCLIP_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` | Exposure policy when deployment mode is `authenticated` |
| `PAPERCLIP_API_URL` | (auto-derived) | Paperclip API base URL. When set externally (e.g., via Kubernetes ConfigMap, load balancer, or reverse proxy), the server preserves the value instead of deriving it from the listen host and port. Useful for deployments where the public-facing URL differs from the local bind address. |
| `PAPERCLIP_HIDDEN_SETTINGS` | (unset) | Comma-separated settings surfaces to hide from the UI and floor at the API, for operators hosting Paperclip for others (managed cloud, internal shared server). See [Hiding settings surfaces](#hiding-settings-surfaces). |
| `PAPERCLIP_SETTING_DEFAULTS` | (unset) | JSON object replacing the schema default of selected instance settings, for hosting operators. See [Operator setting defaults](#operator-setting-defaults). |

### Hiding settings surfaces

`PAPERCLIP_HIDDEN_SETTINGS` takes keys from the registry in
`packages/shared/src/settings-visibility.ts`:

- Any instance settings page: `instance.profile`, `instance.environments`,
  `instance.access`, `instance.experimental`,
  `instance.plugins`, `instance.adapters` — removed from navigation and
  routing (the General page is the settings root and stays visible). Hiding
  `instance.access`, `instance.plugins`, or `instance.adapters` also floors
  their management endpoints with `403 settings_operator_managed`; hiding
  `instance.experimental` floors every experimental toggle write.
- Any Instance → General section: `instance.general.censorUsernameInLogs`,
  `instance.general.keyboardShortcuts`, `instance.general.backupRetention`,
  `instance.general.feedbackDataSharingPreference` (each also rejects
  value-changing writes via `PATCH /api/instance/settings/general`), plus the
  UI-only `instance.general.deploymentStatus` and `instance.general.signOut`.
- Any experimental toggle: `instance.experimental.<flagKey>` (e.g.
  `instance.experimental.enableSmokeLab`) — the card disappears and
  value-changing writes are rejected.
- Any top-level company settings page: `company.members`, `company.invites`,
  `company.secrets`, `company.export`, `company.import` — removed from the
  settings sidebar, tab bar, and routing (the company General page is the
  settings root and stays visible). These are UI-visibility keys: the
  membership, invite, secret, and export APIs stay live for agents and
  integrations. `company.import` is the exception — hiding it also floors
  every company-import route with `403 settings_operator_managed`. On
  cloud-managed instances import is floored unconditionally with
  `403 cloud_managed`, independent of this variable.
- A single tab of the Secrets page: `company.secrets.vaults` (Provider
  vaults) and `company.secrets.proposals` (Proposals) — the tab disappears
  while the rest of the page stays up. UI-visibility only; the secret
  provider-config and proposal APIs stay live for agents and integrations.

Unknown keys are logged and ignored, so one list can be rolled across a fleet
of mixed app versions, and retired keys (like `instance.heartbeats`, whose
page was removed) can stay in an operator list without breaking older or
newer releases. With the variable unset nothing is hidden and behavior
is identical to earlier releases. Hiding a toggle does not change its value;
pair hiding with the desired default where it matters (for general settings,
see [Operator setting defaults](#operator-setting-defaults)).

### Operator setting defaults

`PAPERCLIP_SETTING_DEFAULTS` takes a JSON object whose fields come from the
registry in `packages/shared/src/setting-defaults.ts` (currently
`feedbackDataSharingPreference`). The operator value substitutes for the
schema default at read time: any field whose effective value is still the
schema default resolves to the operator value, while an explicit non-default
user choice always wins. The overlay is never persisted, so unsetting the
variable restores stock behavior wherever a user has not chosen otherwise.
A client that writes back the full settings object it read does not persist
the operator value either: writing the operator value over a still-unchosen
field is treated as an echo of the overlay and the field stays unchosen.

Example: `PAPERCLIP_SETTING_DEFAULTS='{"feedbackDataSharingPreference":"allowed"}'`
defaults AI feedback sharing to allowed; pairing it with
`instance.general.feedbackDataSharingPreference` in `PAPERCLIP_HIDDEN_SETTINGS`
also hides the control and floors value-changing writes.

Unknown field names are logged and ignored (mixed-version fleet safe).
Malformed JSON or an invalid value for a known field refuses startup — policy
configuration fails closed.

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `~/.paperclip/.../secrets/master.key` | Path to key file |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |

## Agent Runtime (Injected into agent processes)

These are set automatically by the server when invoking agents:

| Variable | Description |
|----------|-------------|
| `PAPERCLIP_AGENT_ID` | Agent's unique ID |
| `PAPERCLIP_COMPANY_ID` | Company ID |
| `PAPERCLIP_API_URL` | Paperclip API base URL (inherits the server-level value; see Server Configuration above) |
| `PAPERCLIP_API_KEY` | Short-lived JWT for API auth |
| `PAPERCLIP_RUN_ID` | Current heartbeat run ID |
| `PAPERCLIP_TASK_ID` | Issue that triggered this wake |
| `PAPERCLIP_WAKE_REASON` | Wake trigger reason |
| `PAPERCLIP_WAKE_COMMENT_ID` | Comment that triggered this wake |
| `PAPERCLIP_APPROVAL_ID` | Resolved approval ID |
| `PAPERCLIP_APPROVAL_STATUS` | Approval decision |
| `PAPERCLIP_LINKED_ISSUE_IDS` | Comma-separated linked issue IDs |

## LLM Provider Keys (for adapters)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Code adapter) |
| `OPENAI_API_KEY` | OpenAI API key (for Codex adapter) |
