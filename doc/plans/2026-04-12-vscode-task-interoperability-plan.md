# VS Code Task Interoperability Plan

Status: planning only, no code changes
Date: 2026-04-12
Related issue: `PAP-1377`

## Summary

Paperclip should not replace its workspace runtime service model with VS Code tasks.
It should add a narrow interoperability layer that can discover and adopt supported entries from `.vscode/tasks.json`.

The core product model should stay:

- Paperclip owns long-running workspace services and their desired state
- Paperclip shows operators exactly which named thing they are starting or stopping
- Paperclip distinguishes long-running services from one-shot jobs

VS Code tasks should be treated as:

- an import/discovery format for workspace commands
- a convenience for repos that already maintain `tasks.json`
- a partial compatibility layer, not a full execution model

## Current State

The current implementation is already service-oriented:

- project workspaces and execution workspaces can store `workspaceRuntime` config plus `desiredState` and per-service `serviceStates`
- the UI renders one control row per configured service and persists start/stop intent
- the backend supervises long-running local processes, reuses eligible services, and restores desired services on startup

Relevant files:

- `packages/shared/src/types/workspace-runtime.ts`
- `server/src/services/workspace-runtime.ts`
- `server/src/services/project-workspace-runtime-config.ts`
- `ui/src/components/WorkspaceRuntimeControls.tsx`
- `ui/src/pages/ProjectWorkspaceDetail.tsx`
- `ui/src/pages/ExecutionWorkspaceDetail.tsx`

This is directionally correct for Paperclip because it gives the control plane an explicit model for service lifecycle, health, reuse, and restart behavior.

## Problem To Solve

The current UX is still too raw:

- operators have to hand-author runtime JSON
- a workspace can have multiple attached services, but the higher-level intent is not obvious
- start/stop controls are visible in multiple places, which makes it easy to lose track of what is being controlled
- there is no interoperability with repos that already define useful local workflows in `.vscode/tasks.json`

The issue is not that services are the wrong abstraction.
The issue is that the configuration surface is too low-level and Paperclip does not yet leverage existing workspace metadata.

## Recommendation

Keep Paperclip runtime services as the source of truth for service supervision.
Add a new workspace command model above the raw JSON layer, with VS Code task discovery as one input.

The product model should become:

1. `Workspace command`
   A named runnable thing attached to a workspace.

2. `Workspace service`
   A workspace command that is expected to stay alive and be supervised.

3. `Workspace job`
   A workspace command that runs once and exits.

4. `Runtime service instance`
   The live process record that already exists today in Paperclip.

In that model, VS Code tasks are a way to populate workspace commands.
Only commands that map cleanly to Paperclip service or job semantics should become runnable in Paperclip.

## Why Not Fully Adopt VS Code Tasks

VS Code tasks are broader than Paperclip runtime services.
They include shell/process tasks, compound tasks, background/watch tasks, presentation settings, extension/task-provider types, variable substitution, and problem-matcher-driven lifecycle.

That creates a bad fit if Paperclip tries to use `tasks.json` as its only runtime model:

- many tasks are one-shot jobs, not long-running services
- some tasks depend on VS Code task providers or editor-only variable resolution
- compound task graphs are useful, but they are not the same thing as a supervised service
- problem matcher readiness is useful metadata, but it is not enough to replace Paperclip's persisted service lifecycle model

The right boundary is interoperability, not replacement.

## Interoperability Contract

Paperclip should support a conservative subset of VS Code tasks and clearly mark unsupported entries.

### Supported in phase 1

- `shell` and `process` tasks with a concrete command Paperclip can resolve
- optional task `options.cwd`
- optional task environment values that can be flattened safely
- task labels and detail text for naming and display
- `dependsOn` for import-time expansion or display-only dependency hints
- background/watch-oriented tasks that can reasonably be treated as long-running services

### Maybe supported in later phases

- grouping and default task metadata for better UX
- selected variable substitution when Paperclip can resolve it safely from workspace context
- mapping task metadata into Paperclip readiness/expose hints
- limited compound-task launch flows

### Not supported initially

- extension-provided task types Paperclip cannot execute directly
- arbitrary VS Code variable substitution semantics
- problem matcher parsing as the main source of service health
- full parity with VS Code task execution behavior

## Long-Running Service Detection

Paperclip needs an explicit classification layer instead of assuming every VS Code task is a service.

Recommended classification:

- `service`
  Explicitly marked by Paperclip metadata, or confidently inferred from background/watch task semantics

- `job`
  One-shot command expected to exit

- `unsupported`
  Present in `tasks.json`, but not safely runnable by Paperclip

The important product decision is that service classification must be visible and editable by the operator.
Inference can help, but it should not be the only source of truth.

## Proposed Product Shape

### 1. Replace raw-first editing with command-first editing

Project and execution workspace pages should stop making raw runtime JSON the primary editing surface.

Default UI should show:

- workspace commands
- command type: service or job
- source: Paperclip or VS Code
- exact command and cwd
- current state for services
- explicit start, stop, restart, and run-now actions

Raw JSON should remain available behind an advanced section.

### 2. Add VS Code task discovery on workspaces

For a workspace with `cwd`, Paperclip should look for `.vscode/tasks.json`.

The workspace UI should show:

- whether a `tasks.json` file was found
- last parse time
- supported commands discovered
- unsupported tasks with reasons
- whether commands are inherited into execution workspaces

### 3. Make the controlled thing explicit

Start and stop UI should always name the exact entry being controlled.

Examples:

- `Start web`
- `Stop api`
- `Run db:migrate`

Avoid generic workspace-level labels when multiple commands exist.

### 4. Separate services from jobs in the UI

Do not mix one-shot jobs and long-running services into one undifferentiated list.

Recommended sections:

- `Services`
- `Jobs`
- `Unsupported imported tasks`

That resolves the ambiguity called out in the issue.

## Data Model Direction

Do not replace `workspaceRuntime` immediately.
Instead add a higher-level representation that can compile down to the existing runtime-service machinery.

Suggested workspace metadata shape:

```ts
type WorkspaceCommandSource =
  | { type: "paperclip" }
  | { type: "vscode_task"; taskLabel: string; taskPath: ".vscode/tasks.json" };

type WorkspaceCommandKind = "service" | "job";

type WorkspaceCommandDefinition = {
  id: string;
  name: string;
  kind: WorkspaceCommandKind;
  source: WorkspaceCommandSource;
  command: string | null;
  cwd: string | null;
  env?: Record<string, string> | null;
  autoStart?: boolean;
  serviceConfig?: {
    lifecycle?: "shared" | "ephemeral";
    reuseScope?: "project_workspace" | "execution_workspace" | "run";
    readiness?: Record<string, unknown> | null;
    expose?: Record<string, unknown> | null;
  } | null;
  importWarnings?: string[];
  disabledReason?: string | null;
};
```

`workspaceRuntime` can then become a derived or advanced representation for service-type commands until the rest of the system is migrated.

## VS Code Mapping Rules

Paperclip should map imported tasks with explicit, documented rules.

Recommended rules:

1. A task becomes a `job` by default.
2. A task becomes a `service` only when:
   - Paperclip metadata marks it as a service, or
   - the task clearly represents a background/watch process and the operator confirms the classification.
3. Unsupported tasks stay visible but disabled.
4. Task labels become default command names.
5. `dependsOn` is preserved as metadata, not silently flattened into hidden behavior.

Paperclip-specific metadata can live in a namespaced field on the imported task definition, for example:

```json
{
  "label": "web",
  "type": "shell",
  "command": "pnpm dev",
  "isBackground": true,
  "paperclip": {
    "kind": "service",
    "readiness": {
      "type": "http",
      "urlTemplate": "http://127.0.0.1:${port}"
    },
    "expose": {
      "type": "url",
      "urlTemplate": "http://127.0.0.1:${port}"
    }
  }
}
```

That gives us interoperability without depending on VS Code-only semantics for service readiness and exposure.

## Execution Policy

Project workspaces should be the main place where imported commands are discovered and curated.
Execution workspaces should inherit that curated command set by default, with optional issue-level overrides.

Recommended precedence:

1. execution workspace override
2. project workspace command set
3. imported VS Code tasks from the linked workspace
4. advanced raw runtime fallback

This matches the existing direction in `doc/plans/2026-03-10-workspace-strategy-and-git-worktrees.md`.

## Implementation Plan

### Phase 1: Discovery and read-only visibility

Goal:
show imported VS Code tasks in the workspace UI without changing runtime behavior.

Work:

- parse `.vscode/tasks.json` for project workspaces with local `cwd`
- derive a list of candidate commands plus unsupported items
- show source, label, command, cwd, and classification
- show parse warnings and unsupported reasons

Success condition:
an operator can see what Paperclip would import and why.

### Phase 2: Command model and explicit classification

Goal:
introduce a first-class workspace command layer above raw runtime JSON.

Work:

- add a persisted command definition model in workspace metadata or a dedicated table
- allow operator edits to imported command classification
- separate `service` and `job` in UI
- keep existing runtime-service storage for live supervised processes

Success condition:
the workspace UI is command-first, and raw runtime JSON is advanced-only.

### Phase 3: Service execution backed by existing runtime supervisor

Goal:
run supported imported service commands through the current Paperclip supervisor.

Work:

- compile service commands into the existing runtime service start/stop path
- persist desired state per named command
- keep startup restoration behavior for service commands
- make the active command name explicit everywhere control actions appear

Success condition:
imported service commands behave like native Paperclip services once adopted.

### Phase 4: Job execution and optional dependency handling

Goal:
support one-shot imported commands without pretending they are services.

Work:

- add `Run` actions for jobs
- record output in workspace operations
- optionally support simple `dependsOn` execution for jobs with clear logging

Success condition:
one-shot tasks are runnable, but they are not mixed into the service lifecycle model.

### Phase 5: Adapter and execution workspace integration

Goal:
let agents and issue-scoped workspaces consume the curated command model consistently.

Work:

- expose inherited workspace commands to execution workspaces
- allow issue-level selection of a default service command when relevant
- make service selection explicit in issue and workspace views

Success condition:
agents, operators, and workspaces all refer to the same named commands.

## Non-Goals

- full VS Code task-runner parity
- support for every VS Code task type
- removal of Paperclip's own runtime supervision model
- editor-dependent execution semantics inside the control plane

## Risks

- overfitting Paperclip to VS Code and making the model worse for non-VS-Code repos
- misclassifying watch tasks as durable services
- hiding too much detail and making debugging harder
- allowing imported task graphs to become implicit magic

These risks are manageable if the import layer stays explicit, conservative, and operator-editable.

## Decision

Paperclip should adopt VS Code tasks as an optional workspace command source, not as the canonical runtime model.

The main UX change should be:

- move from raw runtime JSON to named workspace commands
- separate services from jobs
- make the exact controlled command explicit
- let `.vscode/tasks.json` pre-populate those commands when available

## External References

- VS Code tasks documentation: https://code.visualstudio.com/docs/debugtest/tasks
- Existing Paperclip workspace plan: `doc/plans/2026-03-10-workspace-strategy-and-git-worktrees.md`
