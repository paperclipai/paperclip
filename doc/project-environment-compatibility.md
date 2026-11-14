# Project environments and repository storage

A repository project belongs to one storage owner. Creation shows **Available in**
when the configured environments require more than one owner. Each choice names
all environments that use that owner. The choice selects storage only. It is not
an allowlist, and it does not override an agent's run environment. A project has
no run environment of its own.

## Compatibility rule

Use the existing workspace execution contract, not environment names, driver
names alone, images, operating systems, endpoints, or complete config equality:

- Local, SSH, and sandbox environments use core repository staging. They can use
  the same repository project even across driver types and sandbox providers.
- Plugin-managed storage belongs to an installed plugin ID. It can be consumed
  only by that plugin's registered `environment_driver` with `supportsTasks: true`.
  Its manifest must declare `environment.drivers.register`, `workspaces.manage`,
  a workspace provider, and the project resource lifecycle.
- Two task environments from that installed plugin share its project storage
  contract, even when their other settings differ. Storage operations are scoped
  by company, project, and plugin; they do not take an environment configuration.
  Separate installed storage plugins remain incompatible even when both use the
  `plugin` driver. Core cannot transfer their managed bindings between them.
- Unknown plugin drivers and the probe-only fake sandbox do not establish a
  compatible project storage contract. They are excluded from creation choices.

These are project repository compatibility rules. They do not assert that
arbitrary local paths exist remotely, that a retained task workspace can switch
hosts, or that an adapter, credential, image, or running worker is ready. Existing
run-time validation still checks those conditions. Cross-plugin storage sharing
would require a new execution/storage contract; matching config fields cannot
establish it.

## Defaults and validation

For an agent API request, use that agent's default environment. For a person,
use their primary agent's default environment when present. Fall back to the
instance default, then local execution. There is no separate user or company
`defaultEnvironmentId` setting today. Managed-only and forced Kubernetes policies
retain their execution restrictions and default redirection.

`GET /api/companies/:companyId/project-environments` returns environment IDs and
names grouped by storage owner, plus the caller's effective default. It excludes
archived environments, disabled/uninstalled storage plugins, and managed
environments bound only to another company. It does not contact workers or return
provider configs, credentials, endpoints, or host paths. A cold worker does not
change a durable storage choice.

`POST /api/companies/:companyId/projects` accepts an optional `environmentId`.
The server validates the choice again and stores only its storage owner. The
project is then available to the compatible environments in that group; no single
run environment is saved. An explicit `executionWorkspacePolicy.storageProviderPluginId`
continues to work. The UI sends both the environment and its observed storage
owner in `expectedStorageProviderPluginId`, so a changed environment cannot
silently select different storage. This guard does not create a workspace-mode
policy; instance task-isolation defaults remain inherited. An explicit policy
and environment must agree when both are supplied. Without either,
storage follows the caller's effective environment. A plugin's
`defaultForProjects` claim alone no longer attaches a project to that plugin.

The hidden repository-free “My private tasks” project is independent of
environment/storage availability, so creating a private note never requires
repairing an environment.

When the configured default is unavailable and only one storage owner is
available, that owner becomes the default, because there is nothing to choose.
When two or more owners are available, an unavailable default produces an error
and permits an explicit available choice. It does not silently select another
storage owner. The UI shows the **Available in** selector only when there are two
or more storage owners. Existing
projects keep their stored owner. This change does not migrate managed storage
or detach projects that contain existing work. A managed project run in an
incompatible environment fails with `project_environment_incompatible` before a
workspace provider operation, with a message naming the storage and environment.

## Project Configuration

Storage is fixed when the project is created. `PATCH /api/projects/:id` rejects a
change of `executionWorkspacePolicy.storageProviderPluginId` with `409`
`project_storage_locked`, in both directions: core to plugin and plugin to core.
A policy update that omits the storage owner keeps the stored owner.

Project Configuration has no storage or environment control. When a storage plugin
is installed, or the project uses one, it shows an advisory **Available in** list:
the environments that can use the project's storage. If the project's storage
plugin is no longer installed, it shows **Storage plugin unavailable**. Without a
storage plugin, the advisory is hidden.

Runs use the agent default, then the instance default, then local execution. An
operator-selected low-trust task sandbox and enforced sandbox policies retain
precedence. A project does not change run placement. Older clients may still send
`executionWorkspacePolicy.environmentId`; the service drops it.
