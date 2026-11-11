# Project environments and repository storage

A repository project belongs to one storage owner. Creation shows **Available in**
when the configured environments require more than one owner. Each choice names
all environments that use that owner. An environment choice saves both the storage owner and the project's
`environmentId`. This is a project-owned execution target, not a company or agent
setting. Compatible environments can share its repository storage.

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
The server validates the choice again and stores its storage owner and environment
on that project. Creation saves the effective default once; changing the instance
or primary agent later does not rewrite existing projects. Compatible environments
share repository storage; the saved environment is the run target. An explicit `executionWorkspacePolicy.storageProviderPluginId`
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

An unavailable configured default produces an error and permits an explicit
available choice. It does not silently select another storage owner. Existing
projects keep their stored owner. This change does not migrate managed storage
or detach projects that contain existing work. A managed project run in an
incompatible environment fails with `project_environment_incompatible` before a
workspace provider operation, with a message naming the storage and environment.

## Project Configuration

`PATCH /api/projects/:id` accepts `environmentId` and the optional
`expectedStorageProviderPluginId` precondition. The Environment selector reads
and writes this project field, independently of checkout/isolation settings.
Changing one project never changes another project, the agent, or instance settings.
Only environments compatible with the project's current storage are offered.
Changing storage ownership is subject to the existing retained-data safeguards.

Ordinary run selection uses the project's saved target before the agent default,
instance default, and local fallback. A null project target explicitly inherits
those defaults. An operator-selected low-trust task sandbox and enforced sandbox
policies retain precedence. Provider API execution keeps its existing placement.

The migration preserves existing valid project-policy environment selections in
the new project field. Older clients may still write the policy field; the service
normalizes it into the project association. Existing projects with no selection
remain unset. Environment deletion counts and clears only matching associations.

Changing or clearing placement requires project workspace-write authority. A
saved selection is checked against company bindings before runtime admission and
again during lease creation. Recovery uses the admitted run's owned environment
lease; a later project edit affects new admissions. The task's organizational
project owns placement even when its files come from another project.
