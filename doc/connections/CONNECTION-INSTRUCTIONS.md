# Connection instructions

Connection instructions are an optional, provider-independent capability. A saved
connection can contribute a short paragraph to an authorized agent’s execution
prompt. Memory providers are the first catalog templates; custom and non-memory
connections use exactly the same settings, authorization, and delivery path.

## Catalog and saved settings

A connector can declare `agentInstructions: { id, version, text }` in its
`AppDefinition`. Author reviewed defaults directly in that app's
`packages/shared/src/app-definitions/<slug>.json`, alongside its configuration
and supporting provider `docsUrl`. This field is the source of truth; there is
no separate template registry. Catalog ingestion validates and preserves it,
including edits or removal, when regenerating the other definition fields. Run
`node scripts/ingest-app-definitions.mjs --definitions-only` to verify. Template
text is limited to 2,000 characters. Remote MCP initialization prose is never
adopted as trusted instructions automatically.

Every `ToolConnection` has nullable `agentInstructions`:

```json
{
  "enabled": true,
  "text": "Use the release handbook before changing a deployment. Cite the checklist.",
  "template": { "id": "handbook.usage", "version": 1 }
}
```

The template provenance is optional. Authorized custom instructions can be saved
without a catalog template. `null` means no instructions. Disabling retains text
and tool access. New catalog connections persist the current default enabled;
the initial migration backfills existing connections for the five participating
providers. A reconnect, OAuth return, or catalog refresh retains saved settings.
Catalog version changes do not replace custom text or opt-outs. **Reset to
default** explicitly adopts the current template and preserves the toggle.

Existing connect, finish, and connection PATCH requests accept the same nullable
setting. Mutations use connection configuration permissions and company checks,
and write activity records. Required provider configuration lives in
`config.methodConfig`, independently of instruction text and enabled state.

## UI convention

The editor appears only when explicit template metadata exists. Setup (including
inline setup and OAuth) uses the current flow, without another wizard step. The
Permissions page places **Agent instructions** after agent access and before
Actions. It shows **Tell agents to use {provider}**, visible text, editing,
**Reset to default** after changes, and an amber notice when off. Failed saves
retain the draft. Agent Instructions includes a read-only **From connections**
section with source links and an explanation of task-dependent availability.
Disabled instructions remain inspectable there with an amber notice.

## Runtime delivery and compatibility

The gateway resolves instructions using the stored run’s company, agent, task,
project, active responsible identity, connection grants, and effective action
policy. At least one tool must be available (including tools requiring approval).
The resolver uses persisted settings and the cached catalog; it does not contact
providers. It does not gate delivery on a provider name, memory category, or the
presence of a catalog template.
Prompt assembly checks access to candidate connections’ cached tools directly,
using the same task restrictions and policy decisions as discovery. It does not
enter the discovery queue, so queue saturation neither drops guidance nor replaces
an otherwise compatible session. Revocation is still checked on every turn.

Eligible blocks are sorted by connection ID. Each block identifies its
connection, selected grant, optional template provenance, and declared public
configuration. Secret/password fields are excluded. Missing required public
configuration withholds standing instructions. The snapshot is `{ text, digest }`,
where `digest` is SHA-256 of the complete UTF-8 text. Declared public configuration and
source changes therefore change the digest as well as text edits.

The server replaces caller-supplied runtime instruction fields before executing.
Native Runner receives the snapshot in `runtimeContext.connectionInstructions`
and composes it alongside agent instructions. Legacy adapters receive it through
shared wake-prompt composition on fresh and resumed turns. Session compatibility
includes the snapshot: changing or removing it replaces an incompatible session,
including when live tool refresh would otherwise retain that session. Active
turns retain the snapshot with which they started. Older native snapshots without
this field remain valid. No AGENTS.md or shared harness home is modified.

Custom integration contracts:

- **HTTP adapter:** the JSON request contains top-level `connectionInstructions`
  (`{ text, digest }` or `null`), also available on invocation `context`.
  This server-owned field overrides `payloadTemplate`. Append its text alongside
  agent instructions before invoking a model; do not reuse a session with a
  different digest.
- **Process adapter:** `PAPERCLIP_CONNECTION_INSTRUCTIONS_FILE` points to a private
  JSON file containing the same snapshot. Read it during the invocation and
  append `.text` to your model prompt. It is empty when no instructions apply.
  Configured or inherited paths cannot override it. The temporary file is removed
  when the process exits, including failure paths.

Instruction guidance grants no new permissions. Approval requirements remain
attached to tool calls, and remembered content does not override the current task.
Provider memory scope follows the provider’s real configuration; Paperclip does
not claim isolation from invented agent IDs or tags.

## Honcho configuration

Honcho requires `config.methodConfig.workspaceId` for new setup. The field is
expanded above instructions, with validation beside it. For tools declaring a
`workspace_id` argument, the existing managed-argument mechanism projects the
configured workspace after caller arguments and removes the field from the
agent-visible schema. Pending approvals compare against the current projected
arguments, so changing the workspace invalidates the old approved invocation.
Existing connections missing a workspace retain their tools and manual workspace
arguments, but receive no standing guidance until configured.

## Verification

`server/src/__tests__/connection-instructions.test.ts` persists a non-memory
fixture, resolves effective access, captures a real process invocation, and checks
shared/native prompt composition. Route tests cover permissions and OAuth draft
preservation. Session tests cover edits/removal and incompatible resumes.
Storybook uses production components backed by stateful mock APIs, including
Notion with and without explicit templates. Model behavior evaluations and new
agent/company memory scope controls are deferred.
