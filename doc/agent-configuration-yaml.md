# Agent configuration YAML

Status: v1, compact editor updated October 29, 2026.

The **Advanced** tab at `/:companyPrefix/agents/:agentRef/advanced` edits an
agent's settings as one YAML document. It covers the configuration tabs through
their existing APIs. The database and resource services remain authoritative;
this is not a file on the agent's computer or a harness-specific format.

## Coverage

| Settings surface | YAML location | Save behavior |
| --- | --- | --- |
| Agent identity / profile | `spec.name`, `role`, `title`, `icon`, `appearance`, `reportsTo`, `capabilities`, `metadata` | Existing agent update, including avatar appearance and reporting relationships. |
| Harness / Runtime | `spec.adapterType`, `adapterConfig`, `runtimeConfig`, `defaultEnvironmentId`, `budgetMonthlyCents` | Existing adapter, environment, AI connection, heartbeat, run-policy and budget validation. Adapter-specific extensions are preserved. |
| Instructions | `spec.instructions` | Bundle mode, root, entry file, and editable text files. Managed files and entry revisions enforce concurrency preconditions; omitted files are preserved; `null` deletes a named file. Legacy prompt templates stay in Instructions unless explicitly supplied. |
| Skills | `spec.skills` | Desired skill keys and version pins, synchronized through the skills API. |
| Secrets & variables | `spec.adapterConfig.env`, `adapterConfig["access.<ALIAS>"]`, `spec.secrets` | Environment values, secret references, API-delivery bindings, creation, rotation, metadata/status updates, and proposal decisions. |
| Tools | `spec.tools` | Direct connection installs, profile bindings and definitions, and agent-scoped policies. Inherited access remains in the Tools tab. |
| Channels | `spec.channels`, `spec.channelOperations` | Existing endpoint settings, communication instructions, execution defaults, resource selection, setup/credentials and lifecycle actions, creation, and identity revocation. |
| Permissions / Trust | `spec.permissions` | Agent creation, skill creation, task assignment, trust preset and full authorization policy, including allowed projects in `authorizationPolicy.trustBoundary.projectIds`. |
| API Keys | `spec.apiKeys` | Explicit create and revoke operations; key metadata remains in the API Keys tab. New tokens appear once outside the YAML. |
| Revisions | `spec.revisions.restore` | Restore an existing revision, as the only operation in a save; history remains in the Revisions tab. |

Read-only information stays read-only: organization-wide inherited access,
immutable history, binary instruction assets, live status/spend, and provider
connection state. Interactive provider login/OAuth and approval flows still use
their normal UI. The YAML can select existing accounts/connections and configure
channel credentials; it cannot synthesize provider consent or export stored
credential values. AgentMail provisioning remains owned by its connection flow.

## Document contract

```yaml
apiVersion: paperclip/v1
kind: Agent
spec:
  name: Codie
  role: engineer
  adapterType: codex_local
  adapterConfig:
    model: gpt-5
    cwd: /workspace/project
    env:
      SERVICE_TOKEN:
        type: secret_ref
        secretId: 11111111-1111-4111-8111-111111111111
        version: latest
  runtimeConfig:
    heartbeat:
      enabled: true
      intervalSec: 3600
  budgetMonthlyCents: 10000
  instructions:
    mode: managed
    entryFile: AGENTS.md
  skills:
    - paperclip
  tools:
    profiles:
      - profileKey: engineering
```

This illustrates the compact format; model, paths, and references depend on the
installation. The default editor contains agent-specific settings and references.
It does not embed company catalogs, inherited profile definitions, history,
credential metadata, or instruction file contents. Empty commands, unset nullable
fields, zero budget, empty maps/lists, and standard permission defaults are omitted.
Unpinned skills use their key strings. Non-default values remain explicit.

`apiVersion`, `kind`, and `spec` are required. All settings inside `spec` are
optional when editing an existing agent. Omission preserves the saved value,
including omitted instruction files, tool subsections, channel settings, and
permissions. To clear a value, supply its supported empty value explicitly:
`title: null`, `skills: []`, `tools: { profiles: [] }`, or `adapterConfig: {}`.
An explicit list replaces that list. An explicit adapter/runtime/metadata map
replaces that map. The one adapter exception is hidden legacy `promptTemplate`:
omission preserves it, and an explicit empty string clears it.

All settings remain expressible. Add an optional section when needed. Use the
owning settings tabs to inspect instruction contents, available profiles,
inherited access, API key metadata, secret proposals, and revision history.
A supplied legacy `observed` block is read-only; remove it before editing an old
export. Unknown fields remain errors. Open adapter/runtime/metadata maps retain
their existing extension contracts. Future incompatible changes require a new
API version.

Executable contracts:
[core document](../packages/shared/src/agent-configuration.ts) and
[resource sections](../packages/shared/src/agent-configuration-resources.ts).
Resource inputs reuse the owning APIs' validators, including trust-policy,
secret, channel, skill, and tool validators.

## Resource semantics

### Instructions and skills

`instructions.mode` is `managed`, `external`, or `null` for an unconfigured
bundle. `external` requires an absolute `rootPath`. File names and `entryFile`
are relative paths; traversal and absolute file names are rejected. File
contents are omitted from the default YAML. The Instructions tab owns
normal content editing. To edit a file inline, add `files: { workflow.md: "text" }`
under `instructions`; only named files are changed. Each text value supports up
to 1 MiB. Use `files: { workflow.md: null }` to delete that file. Omitted files
and an empty `files: {}` are preserved. The entry file cannot be removed.
Binary/read-only/virtual files remain visible in Instructions. A legacy virtual
prompt template can still be edited explicitly with `adapterConfig.promptTemplate`.
It is hidden by default and preserved when another adapter setting changes.
Managed root paths are assigned by Paperclip and omitted from the default YAML.

Changing the mode, root, or entry file is a separate save from editing file
contents. That save loads the destination files without writing the old YAML's
contents over them. The native bundle service may seed an empty destination or
a missing entry file from the previous bundle. Review the freshly loaded files
before editing them. A managed root is assigned by Paperclip; choose `external`
mode to select another directory.

Skills accept a key string or `{ key, versionId }`; `versionId: null` follows
the current version. An empty list unassigns skills through the normal sync
API. These keys are organization-library references, not embedded skill source.

The `instructionsBundleMode`, `instructionsRootPath`, `instructionsEntryFile`,
`instructionsFilePath`, and `paperclipSkillSync` adapter keys are represented by
the dedicated sections. Direct edits to those adapter keys are rejected so two
sections cannot disagree about the same setting.

### Tools

`tools.connections` contains only selected direct agent installations.
Each row has `connectionId`; omitted `installed` means `true`. Use
`installed: false` or remove a row from an explicitly supplied list to uninstall.
Inherited company installations remain in Tools. Removing a direct installation
row has the same effect as `installed: false`. Saves preserve other agents'
installations. Company installations cannot be overridden here.
The installation service can add an access profile and binding for an installed
connection. The compact reload references those generated profiles by key.

Existing profiles normally use a reference: `{ profileKey: engineering }`.
`profileId` is also accepted. If both are provided, they must identify the same
company profile. Optional `priority` and `metadata` affect only this binding;
omission preserves an existing binding or uses 100/null for a new one.
A reference never updates the shared definition. Omit `tools.profiles` to
preserve bindings; use `profiles: []` to unbind all direct profiles.

To create a profile or explicitly edit its definition, supply:

```yaml
profileId: null # null creates a profile; an existing ID binds/edits it
updateSharedDefinition: false
priority: 100
metadata: null
configuration:
  profileKey: engineering
  name: Engineering
  description: null
  status: active
  defaultAction: deny
  metadata: null
  entries:
    - selectorType: tool_name
      effect: include
      toolName: get_repository
```

The profile configuration uses the native profile/entry schema. Profiles can
be shared: editing a profile's definition affects every binding to that profile.
When other targets share it, changes to the definition require explicitly
setting `updateSharedDefinition: true`. The flag resets after reload; changing
only the flag does not write anything. Binding an unchanged shared definition
does not require the flag. Use `profileId: null` for a separate profile.
Removing a profile row from an explicitly supplied list only unbinds it from
this agent. Available profile definitions remain in Tools.

Keep existing profile and policy fields explicit. Removing a field from an
existing definition is rejected because the native PATCH would otherwise
preserve its old value. Use the field's supported empty value to clear it.

Policies use `{ id, configuration }`, with `id: null` creating a policy.
Configuration includes `name`, `description`, `policyType`, `priority`,
`enabled`, `selectors`, `conditions`, and `config`. Policies in this section
must target only this agent; newly created policies are scoped to it. Removing
a row deletes that agent-scoped policy. Shared/inherited policies remain read-only in Tools.

### Channels

Each `channels` row has immutable `id`; `provider` can be omitted or must match
the saved provider. Omitted `settings` and `resources` preserve their saved values. Settings follow the native endpoint update contract:
`executionDefaults`, `communicationInstructions`, `allowUnlinkedPeople`,
`allowDirectMessages`, `requireAtMention`, `allowGroupChats`, `slackApp`, and
`slackSetupMethod`, where applicable. Omitted settings fields are preserved; an explicit empty value clears a field
where its native API supports it. Resources contain `{ id, enabled,
executionDefaults }`; removing a resource row disables it. Removing a channel
row removes the endpoint using its existing setup API.

`channelOperations.create` accepts the native creation fields (`provider`,
optional `applicationId`, `name`, `slackApp`, `slackSetupMethod`); the current
agent ID is supplied by the editor. Save creation first to obtain its endpoint
ID before adding setup commands. `setup` accepts `{ id, input }`, where input
has an `action` (`configure`, `verify`, `pause`, `resume`, `reconnect`, `remove`)
and optional `credentials` or Photon configuration. `revokeIdentityLinks`
accepts `{ endpointId, principalId }`. Provider authorization is still enforced
by the channel service. IDs, resources, linked people, and state are available
in the Channels tab.

An endpoint cannot be removed and also edited, configured, or have its identities
revoked in the same save. Duplicate setup commands and identity revocations are
rejected before any writes.

### Secrets, API keys, and revisions

Use `secret_ref` and `user_secret_ref` bindings for existing credentials.
`secrets.create` accepts `{ secret, bind: { env: [], api: [] } }`; `secret` follows
the create-secret contract (name/key, provider, value or external reference,
provider configuration and metadata). After creation, `bind` can attach its ID
to environment names or API aliases. An empty bind creates without attaching.
`rotate` and `update` accept `{ id, input }` using their native contracts.
`proposals` accepts `{ id, decision: approve|reject, reason? }`; rejection
requires a reason. Secrets and pending proposals remain in Secrets & variables.

New secrets must use distinct binding targets. A target cannot also be edited
in `adapterConfig` in the same save. Binding targets are checked again before
creation and before the revision-guarded binding update. If creation succeeds
but binding fails, the receipt identifies the created secret; reload before
deciding how to bind it.

`apiKeys.create` accepts `{ name, scope }`; scope uses the existing agent key
schema, with `{ kind: standard }` as the default. `apiKeys.revoke` contains key
IDs. Tokens returned by creation appear outside the YAML and are not stored in
the configuration query cache. Copy them before leaving the page. Previously
issued tokens cannot be retrieved.
Duplicate creation names within one save are rejected.

`revisions.restore` accepts an existing revision ID or `null`. Restore must be
the only change in that save. It uses the same rollback operation as the
Revisions tab and restores only the fields covered by that revision; it is not
a rollback of all external resources.

Empty operation lists are omitted after a successful save/reload. Commands are
not replayed from history. Read-only history and catalogs are excluded from YAML. Lifecycle commands for the agent itself (pause, resume,
terminate) are actions outside configuration.

## YAML, secrets, and save guarantees

The parser accepts one YAML 1.2 mapping containing JSON-compatible values.
Duplicate keys, multiple documents, aliases, anchors, explicit tags, merge
keys, non-string mapping keys, non-finite numbers, and prototype-related keys
are rejected. Documents are limited to 8 MiB and 50 levels of nesting. Syntax
errors include a location; schema errors identify a field path. There is no
interpolation, shell evaluation, include directive, or parser file access.
Comments and formatting are not persisted; saving/reloading regenerates YAML.
Changing only comments or mapping order does not write resources.
The editor shows **No configuration changes** and keeps Save disabled when the
operation plan is empty, including when an optional section is omitted.

The initial core read checks configuration access before related resources are
loaded. Failed reads are shown as errors, never substituted with empty resource
lists. The editor validates document structure, known references, explicit
clears, and conflicting operations before enabling Save. Expand the change
summary to review the ordered operations, including removals and shared profile
edits. Domain-specific authorization, validation, and normalization still run
at each API write; not every server rejection can be predicted in the browser.

Saving refreshes the snapshot before the first mutation. A changed core revision or an
edited resource section that has changed elsewhere rejects the save. Concurrent
changes to untouched resource sections are preserved. These are preflight
checks, not a transaction spanning all resources.

Core changes use `PATCH /api/agents/:id` with
`expectedConfigurationRevision`, checked again under the row lock. Removing an
adapter key uses `replaceAdapterConfig: true`. The opaque revision uses a
domain-separated HMAC with the instance's private signing key. Credential edits
invalidate an open draft without exposing a public credential digest. Rotating
the signing key requires reloading open editors. Server processes for one
instance must share that key. File-based rotation takes effect on the next
revision calculation without a server restart. Managed instruction files and
entry revisions enforce hash/revision preconditions. External supporting file
writes/deletions do not enforce these preconditions. Other resources retain
their own API guarantees; changes between preflight and an unversioned resource
write are not atomically protected. Every mutation uses its existing company/actor authorization,
approval, validation, audit and revision behavior.

A multi-resource save runs sequentially and is **not atomic**. On an interrupted
save, the editor retains the draft, reports completed steps and the failing
step, preserves any credential receipts, and disables Save until **Reload
saved**. Reload reveals current state and clears pending operations so retrying
cannot blindly duplicate a successful creation. A network failure may mean the
last operation committed even when its response did not arrive. No writes are
automatically retried. Double-clicking Save starts one operation, the editor
and Reload are disabled during saving, and agent navigation is held until it
settles. Dirty drafts use the agent page's unsaved-navigation guard. Closing the
browser cannot cancel or roll back requests already sent.

A successful save reloads canonical state, clears command lists, and displays
any normalization warnings returned by the server. CEO agents and agents that
can create agents must explicitly retain task assignment authority.

Stored inline credentials use `***REDACTED***`. An unchanged marker at its
original location preserves its saved value. Removing the key removes that
setting; replacing the full value supplies a new value under normal validation.
For revision-guarded core saves, the server restores unchanged masked subtrees
before validation; moved/partially edited redactions are rejected. Secret
references are never resolved into values. New secret/channel credential inputs
are one-time commands and disappear after canonical reload. This document is
an editable settings view, not a portable credential backup.

No background polling, database migration, or new authorization bypass is
introduced by the editor.

## Verification

Run the browser acceptance suite against its disposable checkout instance:

```sh
pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/agent-configuration.spec.ts
```

The suite checks compact output with large company catalogs and instruction
files, sparse saves, profile-key bindings, resource saves and explicit clears, one-time key receipts, secret
redaction, stale drafts, a lost creation response, instruction relocation, and
revision restore through real APIs. It enables and restores the Beta skills and
chat connector flags. Its local MCP fixture provides a connection target; it
does not qualify provider login or agent execution.

The lifecycle regressions can use a dedicated external PostgreSQL database when
embedded PostgreSQL is unavailable. Set
`PAPERCLIP_AGENT_LIFECYCLE_TEST_DATABASE_URL` to a database ending in `_test`
before running `server/src/modules/agent-lifecycle/__tests__/lifecycle.test.ts`.
