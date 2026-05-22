---
title: Instructions Bundle
summary: How Paperclip resolves, stores, and serves agent instruction files
---

Every agent has an **instructions bundle** — the set of files (primarily `AGENTS.md`) that form the agent's system prompt. This page documents how the bundle mechanism works, the two bundle modes, and how it relates to skills.

## Bundle Anatomy: Common Conventions

While Paperclip only strictly requires an **entry file** (usually `AGENTS.md`), complex agents often split their instructions into multiple files for better organization. 

Common file naming conventions include:

-   **`AGENTS.md`** (The Persona): The primary system prompt. Defines the agent's identity, role, high-level objectives, and handoff rules.
-   **`SOUL.md`** (The Personality): Dedicated to the agent's "vibe," tone of voice, values, and behavioral constraints. Separating this allows you to swap "personas" while keeping the same "soul."
-   **`KNOWLEDGE.md`** (The Context): Static reference material, FAQ, or project-specific constraints that the agent must always remember.
-   **`HEARTBEAT.md`** (The Task): Specific instructions for the agent's scheduled maintenance or "rollcall" tasks.

### How they are combined
Supported adapters (like the OpenRouter adapter) will often read the primary `AGENTS.md` and then look for sibling `.md` files. These fragments are concatenated or injected as distinct system message blocks to form the complete agent "brain."

## Managed vs. External: Which mode to use?

Paperclip supports two modes for managing agent instructions. The choice depends on whether you want your agent personas to be "managed state" (like a database) or "code" (like your git repo).

| Feature | `managed` Mode (Default) | `external` Mode (Agent-as-Code) |
| :--- | :--- | :--- |
| **Primary Storage** | Internal Docker volume | Local Git repository |
| **Editing Workflow** | Paperclip UI "Instructions" tab | Local IDE (Cursor/VSCode) + Git |
| **Version Control** | Manual exports only | Full Git history, Branching, PRs |
| **Setup Complexity** | Zero (out-of-the-box) | Requires bind-mount & migration |
| **Best For** | Prototyping, casual use | Production crews, team collaboration |

### `managed` mode

The server owns the bundle directory. Files are stored at a deterministic path inside the Paperclip instance data root:
`{PAPERCLIP_INSTANCE_ROOT}/companies/{companyId}/agents/{agentId}/instructions/`

The Paperclip UI's instructions editor reads and writes files directly to this internal path. This is the simplest way to get started.

### `external` mode

The bundle directory is an absolute path on the host filesystem (outside the managed root), set via `adapterConfig.instructionsRootPath`. This is the recommended mode for professional "Agent Crews" where the instructions (the "brain") should be versioned alongside the code.

**Key advantages of external mode:**
- **Peer Review**: Changes to agent personas can be reviewed via Git Pull Requests.
*   **Pro Tooling**: Use your local IDE with markdown support and Copilot to write instructions.
*   **Sync**: Anyone who clones the repo gets the exact same agent configuration.

**Note**: In Docker deployments, external mode requires a bind-mount (see [Docker Considerations](#docker-considerations) below).

## `adapterConfig` Fields

The server stores bundle state in the agent's `adapterConfig`. All fields are managed automatically — do not set them by hand unless migrating between modes.

| Field | Description |
|---|---|
| `instructionsBundleMode` | `"managed"` or `"external"` |
| `instructionsRootPath` | Absolute path to the bundle directory |
| `instructionsEntryFile` | Relative path of the entry file within the root (default `AGENTS.md`) |
| `instructionsFilePath` | Absolute path to the entry file (`rootPath + entryFile`); read by adapters |

## Adapter Requirements

An adapter must declare `supportsInstructionsBundle = true` in its module exports for the server to activate managed bundle features. The adapter also sets `instructionsPathKey` (default `"instructionsFilePath"`) to tell the server which `adapterConfig` key holds the entry file path.

```typescript
// packages/adapters/my-adapter/src/index.ts
export const supportsInstructionsBundle = true;
export const instructionsPathKey = "instructionsFilePath";
```

At run time, the adapter reads the entry file from `config[instructionsPathKey]` and includes its content in the system prompt. It may also load sibling files (e.g. `HEARTBEAT.md`) as additional fragments.

See `creating-an-adapter.md` for the full list of adapter module flags.

## Bundle Resolution Logic

The service (`agentInstructionsService` in `server/src/services/agent-instructions.ts`) resolves the bundle state on every API call using this order:

1. Read `instructionsBundleMode`, `instructionsRootPath`, and `instructionsEntryFile` from `adapterConfig`.
2. If those are absent but `instructionsFilePath` is set (legacy field), derive the root and entry file from it. Classify the mode as `managed` if the path falls inside the managed root, `external` otherwise.
3. **Recovery pass:** if the managed root directory exists on disk and contains files, use it — even if `adapterConfig` is stale or empty. This prevents agents from losing access to their instructions after an import or a config reset.

## Relationship to Skills

Skills are **not** stored in the instructions bundle. They are:

1. Assigned to agents via `POST /api/agents/{agentId}/skills/sync`.
2. Injected by the server into `config.paperclipRuntimeSkills` at run time (an array of `PaperclipSkillEntry` objects with `{ key, runtimeName, source }`).
3. Read by the adapter using `readPaperclipRuntimeSkillEntries(config, moduleDir)` from `adapter-utils`.
4. Prepended to the instruction fragments in the system prompt, before the AGENTS.md persona content.

The AGENTS.md file in the managed bundle is the agent's **persona** (role, capabilities, handoff rules). Skills are **behaviour extensions** loaded on top of it. Neither should be modified to accommodate the other.

## Editing Instructions

Instructions can be edited:

- **Via the Paperclip UI** — navigate to the agent's Instructions tab. The editor reads and writes files through the instructions API.
- **Via the API directly** — `PUT /api/agents/{id}/instructions/files/{relative-path}` with a JSON body `{ "content": "..." }`.
- **On disk (managed mode)** — edit files directly at the managed path inside the container, then restart the agent. The server will pick up changes on the next run.

## Docker Considerations

In a Docker deployment:

- The managed bundle path lives inside the container's instance data volume.
- Files written via the UI are durable as long as the volume is mounted.
- There is no host-side copy of the managed bundle; do not look for it on the macOS filesystem.
- To inspect or edit files from outside the container: `docker exec <container> cat <path>`.

## External mode with the crew repo

In crew deployments, agent instructions and company skills are tracked in a git
repository (`crew`) alongside code. The crew repo is bind-mounted into the
Paperclip server container at `/paperclip/companies`, giving the server access to
both assets under a single mount.

### Docker Configuration

In `docker/docker-compose.yml`, add to the `server` service:

```yaml
volumes:
  # Crew repo company assets (agent instructions and skills).
  # Read-write: the Paperclip UI can write back to the crew repo directly.
  # Changes appear as git working-tree modifications and must be committed.
  # Additional companies require additional mounts.
  - ${PAPERCLIP_OVERLAY_PATH}:/paperclip/companies:rw
```

`PAPERCLIP_OVERLAY_PATH` must be set in the deployment environment (e.g. `.env`)
and should point to the `paperclip/companies` subdirectory of the crew repo
(e.g. `~/Projects/linkcast/crew/paperclip/companies`).

### Mount is read-write

The mount is `:rw` so the Paperclip UI instructions editor and skills editor can
save changes back to the crew repo directly. This is intentional — it means:

- Editing an agent's instructions in the UI writes directly to
  `crew/paperclip/companies/{slug}/agents/{urlKey}/AGENTS.md`.
- Editing a skill in the UI writes directly to
  `crew/paperclip/companies/{slug}/skills/{skill-name}/SKILL.md`.
- These changes show up immediately in `git status` / `git diff` in the crew
  repo and must be committed deliberately.

Git remains the canonical source of truth. The UI is a convenience editor, not
a bypass of version control.

### Directory structure inside the mount

```
/paperclip/companies/{companySlug}/
  agents/
    {agentUrlKey}/
      AGENTS.md          # entry file for external mode
      HEARTBEAT.md       # optional supplementary fragment
  skills/
    {skill-name}/
      SKILL.md
      scripts/
        *.sh
```

The `agents/` subtree is used when an agent's bundle is switched to `external`
mode (a deliberate per-agent migration — see below). The `skills/` subtree is
auto-discovered by the server (see `docs/specs/crew-repo-integration.md`).

### Migrating an agent to external mode

Switching an agent from `managed` to `external` mode is a deliberate, per-agent
decision. It is not automatic. Steps:

1. Write the current managed bundle content to the crew repo:
   ```bash
   docker exec <container> cat \
     /paperclip/instances/default/companies/{companyId}/agents/{agentId}/instructions/AGENTS.md \
     > crew/paperclip/companies/{slug}/agents/{urlKey}/AGENTS.md
   ```
   Repeat for any supplementary files. Commit the result.

2. Switch the agent via the API:
   ```bash
   curl -X PATCH -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "adapterConfig": {
         "instructionsBundleMode": "external",
         "instructionsRootPath": "/paperclip/companies/{slug}/agents/{urlKey}",
         "instructionsEntryFile": "AGENTS.md",
         "instructionsFilePath": "/paperclip/companies/{slug}/agents/{urlKey}/AGENTS.md"
       }
     }' \
     "$PAPERCLIP_API_URL/api/agents/{agentId}"
   ```

3. Verify in the UI: the Instructions tab should show the crew repo file and
   allow editing.

The `scripts/externalise_agents.sh` script (see `docs/specs/externalise-agent-instructions.md`)
automates this for all agents in a company at once.

