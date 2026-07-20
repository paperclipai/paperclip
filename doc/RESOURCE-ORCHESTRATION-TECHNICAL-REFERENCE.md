# Resource Orchestration Technical Reference

Supporting detail for [Resource Orchestration Overview](./RESOURCE-ORCHESTRATION-SPEC.md). This document defines the POC filesystem and Git contract.

## Terminology

| Term | Definition |
| --- | --- |
| Resource Type | Materialization and publication behavior |
| Resource | Company-scoped reusable source-of-truth configuration and file tree |
| Resource version | Exact Git reference or commit |
| Workspace | Isolated filesystem for one run |
| Mount | Workspace path where a Resource is materialized |

`git` is the only native Resource Type in the POC. “Text Resource” means a Resource containing readable text files; it is not a separate Type.

## Resource Type Interface

Every Resource Type must eventually expose the same conceptual operations:

```text
check(resource, requested_version) -> resolved_version
in(resource, resolved_version, destination) -> materialized_files
out(resource, source_directory) -> published_version
```

The POC implements this interface only for Git.

### `check`

`check` verifies that the Resource source is available and resolves either:

- `latest`, using the Resource’s configured default branch/ref; or
- an explicit branch, tag, or commit.

Failure prevents workflow execution.

### `in`

`in`:

1. obtains the resolved Git version;
2. checks out the configured repository state;
3. selects the Resource’s configured root or subdirectory;
4. copies/materializes that file tree into the run workspace.

The workflow receives a path, not a Resource object.

### `out`

`out`:

1. receives the output workspace directory;
2. applies its changes to the Resource source;
3. creates a new Git commit/version;
4. returns the published version reference.

Publication failure is a failed workflow result. Versions already published by earlier outputs remain recorded for audit and reconciliation; the failing output is not recorded as successful.

## Resource Metadata

BizBox retains only metadata required to locate and operate a Resource:

```yaml
resource:
  id: resource_uuid
  key: july_campaign_context
  company_id: company_uuid
  type: git
  repository: github.com/company/context.git
  source_path: campaigns/july
  default_ref: main
  mount_path: campaign_context
  credential_ref: company-secret-uuid
  labels:
    purpose: campaign-context
  status: active
```

The Resource record is company-scoped. Git remains the source of truth for file contents and history.

No Resource payload JSON, business schema, schema revision, or database Snapshot is required.

## Manifest Contract

```yaml
resourceManifest:
  version: 1
  resources:
    - resource_id: resource_uuid
      mode: input_output
      version: branch:july
      output:
        action: push
        target_ref: main
```

Manifest responsibilities:

- reference one or more existing company Resource IDs;
- request `latest` or an explicit Git version;
- declare input/output mode and an output action (`none`, `push`, or `pull_request`);
- configure target refs and PR metadata when applicable.

The Resource owns `mount_path`; manifest configuration cannot override it.

Manifest does not define Resource fields, Resource schemas, Snapshot IDs, or Artifact schemas.

## Runtime Execution

```text
run.resourceManifest
  -> validate Resource references
  -> resolve requested Git versions
  -> run git.check
  -> create isolated workspace
  -> run git.in for each input
  -> execute workflow or autonomous agent with `BIZBOX_RESOURCE_*_PATH` values
  -> after successful completion, run git.out for declared outputs
  -> record input/output Resource versions
```

Workflow and autonomous execution use the same workspace preparation. The execution mode determines the consumer, not the Resource contract.

## Cross-Workflow Version Flow

```text
Resource: campaign_context

Workflow A consumes main@abc123
Workflow A publishes def456
Workflow B consumes campaign_context@def456
Workflow B publishes ghi789
```

The Resource identity remains stable. Git references identify the exact file tree used by each run.

## Workspace Rules

- Each run receives an isolated workspace.
- Each logical input has a deterministic mount path.
- Workflows may read and edit files under their declared mounts.
- BizBox invokes `out` only for declared output mounts.
- BizBox invokes `out` after workflow completion; workflow code does not call Git.
- No-change outputs do not create empty commits.
- Publication fails on consumed-ref divergence and never force-pushes.
- A workflow must not need Git credentials or Git command knowledge.
- Files outside declared mounts are not published by the Resource layer.

The run temporary root contains the copied workflow under `project/` and Resource mounts under `resources/`. A full Git Resource is cloned directly into `resources/<mount_path>/`; no separate exposed `.resources/<key>/repo` directory is created. Source-subdirectory Resources may use internal staging within the same run root.

## Git Resource Examples

### Campaign context

```text
Resource: july_campaign_context
Type: git
Source: context.git/campaigns/july
Files: brief.md, research.md, audience.md
```

### Codebase

```text
Resource: platform_codebase
Type: git
Source: platform.git/
Files: complete repository tree
```

Both use the same `git.check`, `git.in`, and `git.out` operations.

## Error Handling

The POC must fail clearly for:

- missing Resource metadata;
- unavailable repository;
- invalid or missing Git reference;
- failed checkout/materialization;
- invalid workspace mount;
- failed publication.

No silent fallback to another Resource or version is allowed.

## Existing Workflow Deliverables

Existing workflow deliverables remain separate run outputs. They may contain links to:

- Resource ID;
- input Git version;
- output Git version;
- workspace files.

They do not own Resource content and do not define its file structure.

## POC Non-Goals

- company-custom Resource Types;
- Resource payload schemas;
- Resource schema revision tables;
- Resource Snapshot tables;
- generic external fetch/publish APIs;
- automatic workflow chaining;
- Artifact schema validation;
- arbitrary user-supplied executable Type implementations.

## Verification Matrix

| Scenario | Expected result |
| --- | --- |
| `latest` Git reference | Resolves configured default ref |
| Explicit commit | Materializes exact commit |
| Configured subdirectory | Only that tree is mounted |
| Markdown files | Work as ordinary Resource files |
| Full repository | Full tree is mounted |
| Workflow modifies files | `out` publishes a new Git version |
| Second workflow consumes output | Receives the published version |
| Checkout failure | Run fails before execution |
| Publication failure | No successful output version recorded |
