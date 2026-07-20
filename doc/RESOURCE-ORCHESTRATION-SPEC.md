# Resource Orchestration Overview

**Status:** Draft POC design

## 1. Purpose

BizBox provides a small shared-context layer for workflows and autonomous agents. A Resource is a reusable, versioned source of truth represented as a filesystem tree. BizBox materializes that tree into a run workspace so the consumer can read and edit ordinary files.

The POC has one native Resource Type: `git`. Markdown, code, JSON, and other files are contents of Git-backed Resources, not separate business-specific Resource Types.

```text
Resource Type: git
Resource: versioned source-of-truth file tree
Workspace: filesystem consumed by a workflow or agent
```

This is a POC, not a general orchestration platform. Workflow and autonomous-agent chaining remain outside the Resource layer.

## 2. Core Model

| Concept | Meaning |
| --- | --- |
| Resource Type | How BizBox checks, materializes, and publishes a Resource |
| Resource | Company-scoped reusable source-of-truth context bundle |
| Resource version | Git reference or commit representing an exact file tree |
| Run Resource manifest | Run input that selects existing Resource IDs and declares inputs/outputs |
| Execution workspace | Temporary filesystem used by a workflow or agent |

Resources do not expose business payload schemas. They may contain any files required by their context: Markdown briefs, source code, configuration, research, or assets.

## 3. Resource Type: Git

The POC supports one Resource Type:

```text
git
```

The Type provides three operations:

```text
check(resource, version)
in(resource, version, workspace_path)
out(resource, workspace_path)
```

- `check` resolves and verifies the requested Git reference.
- `in` checks out the selected version and materializes the configured file tree.
- `out` publishes workspace changes as a new version of the same Resource.

The Type defines generic Git behavior. It does not contain a specific repository URL or business schema.

## 4. Resources

A Resource instance identifies one reusable source of truth:

```yaml
resource:
  key: july_campaign_context
  type: git
  repository: github.com/company/context.git
  source_path: campaigns/july
  default_ref: main
  mount_path: campaign_context
  credential_ref: company-github-secret-id
  status: active
```

Other instances can use the same Type:

```text
july_campaign_context
platform_codebase
agent_knowledge
customer_research
```

Each may expose a different directory tree and purpose. A text-based context is simply a Git Resource containing files such as:

```text
brief.md
research.md
audience.md
instructions.md
```

This follows the Unix approach of passing information through simple files and streams that independent tools can inspect and process. [GNU Coreutils](https://www.gnu.org/software/coreutils/manual/html_node/I_002fO-redirection.html)

BizBox stores minimal company-scoped Resource metadata: identity, Type, repository/location, source directory, default reference, access configuration, and discovery labels. Git stores the files and their history.

## 5. Workspace Contract

The individual run supplies the selected Resource manifest:

```yaml
run.resourceManifest:
  version: 1
  resources:
    - resource_id: july_campaign_context_uuid
      mode: input_output
      version: branch:july
      output:
        action: pull_request
        target_ref: main
        title: Update campaign context
```

Resource `mount_path` is authoritative. Run input cannot override it. One run may attach multiple existing Resources.

Runtime flow:

```text
1. Resolve selected run-manifest Resource IDs within the company
2. Run `git.check` for each requested version
3. Create isolated workspace
4. Run `git.in` for every attached Resource
5. Execute workflow or autonomous agent
6. After successful completion, run `git.out` for declared outputs
7. Record input/output Git versions and output/PR metadata in run metadata
```

The workflow receives filesystem paths through runtime environment variables such as:

```text
BIZBOX_RESOURCE_CAMPAIGN_CONTEXT_PATH=/workspace/<run>/resources/campaign_context/
```

Each run uses one temporary root. The Google ADK workflow is copied to `project/`; full Git Resources are cloned directly into `resources/<mount_path>/`. Resource staging, when needed for a configured source subdirectory, remains internal to the same temporary root.

It reads and edits files directly. BizBox owns checkout, credentials, publication, and failure handling. It does not receive Resource payload objects, schema versions, database Snapshot IDs, or Artifact schemas.

## 6. Cross-Workflow Context

One Resource can be consumed and updated by multiple workflows:

```text
Workflow A
  reads research files
  adds campaign findings
  publishes Git commit abc123

Workflow B
  requests july_campaign_context@abc123
  receives the same files in its workspace
  adds social content
  publishes Git commit def456
```

The Resource remains the shared source of truth. Each workflow consumes a selected version and may publish the next version of that same Resource.

## 7. Boundaries

Build:

- company-scoped Resource CRUD APIs for board and agent actors;
- Git Resource Type operations: `check`, `in`, and `out`;
- minimal company-scoped Resource metadata;
- workspace materialization for workflow and autonomous execution;
- logical manifest mounts;
- `latest` and explicit Git references;
- new Git versions for published changes.

Do not build in this POC:

- company-defined Resource schemas;
- domain-specific Types such as `growth_activation`;
- Resource schema revisions or database Snapshots;
- Artifact-owned Resource schemas;
- generic BizBox fetch/publish operations;
- platform-managed workflow chains.
- arbitrary user-supplied Resource scripts or shell commands.

Workflow deliverables remain separate from Resources. They may link to the Resource and Git version used, but they do not define or validate the Resource file structure.

## 8. Acceptance Criteria

- Git is the only native POC Resource Type.
- Multiple Resource instances use the same Git Type.
- Markdown and code work as files inside Git Resources.
- `git.in` materializes a configured repository root or subdirectory.
- Workflows and autonomous agents receive the same filesystem structure.
- `git.out` publishes modifications as a new version of the same Resource.
- Resource creation is explicit through CRUD; workflow runs publish existing Resources only.
- No-change output does not create an empty commit.
- Concurrent publication uses optimistic ref checking and never force-pushes.
- Later workflows can consume the published version.
- Failed checkout or publication cannot report success.
- No workflow requires knowledge of business schemas or Git internals.

For implementation details, see [Resource Orchestration Technical Reference](./RESOURCE-ORCHESTRATION-TECHNICAL-REFERENCE.md).
