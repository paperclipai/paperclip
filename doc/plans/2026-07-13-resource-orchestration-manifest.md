# Resource Orchestration: Filesystem Context and Git Versioning

Status: implemented POC

## Decision Summary

The Resource is the reusable source of truth passed between workflows and autonomous agents. It is represented as a versioned filesystem tree.

Implementation note: Resource instances live in the company-scoped Resource catalog. Resource selection is invocation-scoped; the Run workflow input selects concrete attachments and refs for each run. Workflow settings store no Resource configuration. Resource instances own repository, source path, default ref, mount path, credential reference, labels, and archive state.

The POC has one native Resource Type: `git`.

“Text” is not a Resource Type. It is the Unix-style content/interface convention: workflows exchange readable files through ordinary filesystem paths. A campaign brief, research context, agent instructions, and a codebase are all files inside Git-backed Resource instances.

```text
Resource Type: git
Resource: versioned source-of-truth file tree
Workspace: filesystem consumed by workflow or agent
```

## Workflow Resource Manifest Shape

```yaml
resourceManifest:
  version: 1
  resources:
    - resource_id: resource_uuid
      mode: input_output
      version: branch:july
      output:
        action: pull_request
        target_ref: main
        title: Update campaign
```

The run manifest references existing global Resource IDs. It does not define Resource instances or business payload schemas. Resource instances own their mount paths; run input cannot override them.

## Runtime Flow

```text
run.resourceManifest
  -> resolve Resource IDs and Git version
  -> run git.check
  -> create isolated workspace
  -> run git.in
  -> execute workflow or autonomous agent with filesystem paths
  -> after successful completion, run git.out for declared outputs
  -> record new Git version
```

The workflow receives a filesystem path:

```text
/workspace/<run>/resources/campaign_context/
```

The run temporary root contains the copied workflow under `project/` and Resource mounts under `resources/`. Full Git Resources are cloned directly into their mount directories; source-subdirectory staging remains internal to the same run root.

It reads and edits files directly. BizBox does not require the workflow to understand Git internals.

## Resource Example

```yaml
resource:
  id: july_campaign_context
  type: git
  repository: github.com/company/context.git
  ref: main
  source_path: campaigns/july
```

The directory may contain:

```text
brief.md
research.md
audience.md
instructions.md
```

Another Resource can use the same Type for a complete codebase:

```yaml
resource:
  id: platform_codebase
  type: git
  repository: github.com/company/platform.git
  ref: main
  source_path: /
```

## Git Type Operations

```text
check(resource, version)
in(resource, version, workspace_path)
out(resource, workspace_path)
```

- `check` verifies the source and resolves `latest` or an explicit Git reference.
- `in` materializes the configured root or subdirectory into the workspace.
- `out` publishes workspace changes as a new version of the same Resource.

## Cross-Workflow Example

```text
Workflow A consumes campaign_context@abc123
Workflow A adds campaign findings
Workflow A publishes campaign_context@def456

Workflow B consumes campaign_context@def456
Workflow B adds social content
Workflow B publishes campaign_context@ghi789
```

The Resource identity remains stable while Git versions identify the exact file tree used by each workflow.

## Implementation Sequence

1. Rewrite the overview and technical reference around Resources as filesystem context bundles.
2. Define the generic `check`/`in`/`out` Resource Type interface.
3. Implement the Git Type.
4. Keep minimal company-scoped Resource metadata in BizBox.
5. Add shared workspace materialization for workflow and autonomous execution.
6. Replace payload-based manifest inputs with logical workspace mounts.
7. Support `latest` and explicit Git references.
8. Publish modified output mounts as new Git versions.
9. Record input and output Resource/version references in run metadata.
10. Remove schema, revision, Snapshot, and Artifact-contract requirements from the Resource design.

## Scope Boundaries

Build:

- one Git Resource Type;
- multiple Git-backed Resource instances;
- directory and file materialization;
- workflow and autonomous workspace consumption;
- publishing new versions of existing Resources.

Defer:

- additional Resource Types;
- company-defined schemas;
- Resource Snapshot tables;
- generic external fetch/publish operations;
- automatic workflow chaining;
- Artifact schema validation;
- arbitrary user-supplied executable Resource Types.

## Acceptance Criteria

- Git is the only native POC Resource Type.
- Markdown, code, JSON, and other files work as Resource contents.
- One Resource can be consumed by multiple workflows.
- `git.in` materializes a configured root or subdirectory.
- Workflows and autonomous agents receive the same filesystem structure.
- `git.out` creates a new version of the same Resource.
- Later workflows can consume the published version.
- Failed checkout or publication cannot report success.
- No workflow requires business payload schemas or Git-specific implementation knowledge.

This repository Markdown is the engineering source of truth. ClickUp synchronization is intentionally outside this plan.
