# Agent configuration YAML

Status: v1, October 28, 2026.

The **Advanced** tab at `/:companyPrefix/agents/:agentRef/advanced` edits an
agent's settings as one YAML document. It covers the configuration tabs through
their existing APIs. The database and resource services remain authoritative;
this is not a file on the agent's computer or a harness-specific format.

## Coverage

| Settings surface | YAML location | Save behavior |
| --- | --- | --- |
| Agent identity / profile | `spec.name`, `role`, `title`, `icon`, `appearance`, `reportsTo`, `capabilities`, `metadata` | Existing agent update, including avatar appearance and reporting relationships. |
| Harness / Runtime | `spec.adapterType`, `adapterConfig`, `runtimeConfig`, `defaultEnvironmentId`, `budgetMonthlyCents` | Existing adapter, environment, AI connection, heartbeat, run-policy and budget validation. Adapter-specific extensions are preserved. |
| Instructions | `spec.instructions` | Bundle mode, root, entry file, and editable text files. Managed files and entry revisions enforce concurrency preconditions; omitted text files are deleted. Legacy prompt templates remain in `adapterConfig`. |
| Skills | `spec.skills` | Desired skill keys and version pins, synchronized through the skills API. |
| Secrets & variables | `spec.adapterConfig.env`, `adapterConfig["access.<ALIAS>"]`, `spec.secrets` | Environment values, secret references, API-delivery bindings, creation, rotation, metadata/status updates, and proposal decisions. |
| Tools | `spec.tools` | Direct connection installs, profile bindings and definitions, and agent-scoped policies. Inherited access is visible under `observed`. |
| Channels | `spec.channels`, `spec.channelOperations` | Existing endpoint settings, communication instructions, execution defaults, resource selection, setup/credentials and lifecycle actions, creation, and identity revocation. |
| Permissions / Trust | `spec.permissions` | Agent creation, skill creation, task assignment, trust preset and full authorization policy, including allowed projects in `authorizationPolicy.trustBoundary.projectIds`. |
| API Keys | `spec.apiKeys` | Explicit create and revoke operations; key metadata is under `observed.apiKeys`. New tokens appear once outside the YAML. |
| Revisions | `spec.revisions.restore` | Restore an existing revision, as the only operation in a save; history is under `observed.revisions`. |

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
  title: Software engineer
  icon: null
  appearance:
    schemaVersion: 1
    characterVersion: cap-v1
    paletteId: bubblegum-sky
  reportsTo: null
  capabilities: |
    Implement features, review code, and maintain tests.
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
      wakeOnDemand: true
  defaultEnvironmentId: null
  budgetMonthlyCents: 10000
  metadata: null
  permissions:
    canCreateAgents: false
    canCreateSkills: true
    canAssignTasks: false
    trustPreset: standard
  instructions:
    mode: managed
    rootPath: /managed/agents/codie
    entryFile: AGENTS.md
    files:
      AGENTS.md: |
        # Codie
        Read the task, make focused changes, and verify the result.
      references/workflow.md: |
        Run the relevant tests before handing work back.
  skills:
    - key: paperclip
      versionId: null
  tools:
    connections: []
    profiles: []
    policies: []
  channels: []
  secrets:
    create: []
    rotate: []
    update: []
    proposals: []
  channelOperations:
    create: []
    setup: []
    revokeIdentityLinks: []
  apiKeys:
    create: []
    revoke: []
  revisions:
    restore: null
observed: {}
```

This illustrates the format; model, paths, and secret IDs depend on the
installation. Edit the document loaded for the agent. Do not replace its
`observed` block with the example's empty block.

`apiVersion`, `kind`, `spec`, and every core field from `name` through `metadata`
are required, including explicit `null` for unset nullable fields. Resource
sections (`permissions` onward) are optional: omitting an entire section
preserves it. The editor emits all
sections. Unknown fields at the document, spec, or structured resource level
are errors. Open adapter/runtime/metadata maps retain their existing extension
contracts. Future incompatible changes require a new API version.

Executable contracts:
[core document](../packages/shared/src/agent-configuration.ts) and
[resource sections](../packages/shared/src/agent-configuration-resources.ts).
Resource inputs reuse the owning APIs' validators, including trust-policy,
secret, channel, skill, and tool validators.

## Resource semantics

### Instructions and skills

`instructions.mode` is `managed`, `external`, or `null` for an unconfigured
bundle. `external` requires an absolute `rootPath`. File names and `entryFile`
are relative paths; traversal and absolute file names are rejected. Each file
value is its text content (up to 1 MiB). Adding a mapping creates a file;
changing one edits it; removing one deletes it. The entry file cannot be
removed. Binary/read-only/virtual files are described in
`observed.instructionFiles`. A legacy virtual prompt template is edited using
`adapterConfig.promptTemplate` rather than a second writable copy.

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

`tools.connections` contains `{ connectionId, installed }` for each available
connection. These are direct agent installations; inherited company
installations appear in `observed.connections`. Removing a direct installation
row has the same effect as `installed: false`. Saves preserve other agents'
installations. Company installations cannot be overridden here.
The installation service can add an access profile and binding for an installed
connection. The canonical reload includes those generated profiles.

Each profile contains:

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
Removing a profile row only unbinds it from this agent. Available profile
configurations are listed under `observed.availableProfiles`.

Keep existing profile and policy fields explicit. Removing a field from an
existing definition is rejected because the native PATCH would otherwise
preserve its old value. Use the field's supported empty value to clear it.

Policies use `{ id, configuration }`, with `id: null` creating a policy.
Configuration includes `name`, `description`, `policyType`, `priority`,
`enabled`, `selectors`, `conditions`, and `config`. Policies in this section
must target only this agent; newly created policies are scoped to it. Removing
a row deletes that agent-scoped policy. Shared/inherited policies are read-only
under `observed.inheritedPolicies`.

### Channels

Each `channels` row has immutable `id` and `provider`, plus `settings` and
`resources`. Settings follow the native endpoint update contract:
`executionDefaults`, `communicationInstructions`, `allowUnlinkedPeople`,
`allowDirectMessages`, `requireAtMention`, `allowGroupChats`, `slackApp`, and
`slackSetupMethod`, where applicable. Keep saved settings explicit; omission
cannot silently clear a PATCH field. Resources contain `{ id, enabled,
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
under `observed.channels`.

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
requires a reason. Secrets and pending proposals are listed without values
under `observed.secrets` and `observed.secretProposals`.

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

Operation lists reset to empty after a successful save/reload. Deleting an
`observed` history row does not revoke a key or restore a revision: editing
`observed` is rejected. Lifecycle commands for the agent itself (pause, resume,
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

The suite checks resource saves and clears, one-time key receipts, secret
redaction, stale drafts, a lost creation response, instruction relocation, and
revision restore through real APIs. It enables and restores the Beta skills and
chat connector flags. Its local MCP fixture provides a connection target; it
does not qualify provider login or agent execution.

The lifecycle regressions can use a dedicated external PostgreSQL database when
embedded PostgreSQL is unavailable. Set
`PAPERCLIP_AGENT_LIFECYCLE_TEST_DATABASE_URL` to a database ending in `_test`
before running `server/src/modules/agent-lifecycle/__tests__/lifecycle.test.ts`.
