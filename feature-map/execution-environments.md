# Local, SSH, and sandbox environments

Operators configure where agents execute, probe readiness, select an environment for work, and inspect remote provisioning or custom-image state when the installed provider supports it.

Implementation: [environment settings](../ui/src/pages/CompanyEnvironments.tsx), [environment runtime](../server/src/services/environment-runtime.ts).

## Sub-features

- `configuration`: inspect local environments and configure available SSH/sandbox targets.
- `capabilities`: select only drivers/providers that advertise the required execution capability.
- `probe`: test reachability and runtime prerequisites in the actual target.
- `assignment`: bind the intended agent/project/workspace to its execution target.
- `images`: inspect supported sandbox custom-image preparation and terminal workflows.

## How to get to it (user POV)

### `environment-settings`

Open Settings → Environments, then create/edit a supported target.

### `remote-execution`

Choose the environment in agent/project/workspace configuration, then inspect the resulting task/run and workspace.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use an owned disposable target and a supported provider plugin. Record provider, target identity, account, and spending constraints before a live remote run.

### `environment-settings`

Automated: [environment UI](../ui/src/pages/CompanyEnvironments.test.tsx), [driver configuration UI](../ui/src/pages/CompanySettings.test.tsx), and [environment service](../server/src/__tests__/environment-service.test.ts) cover configuration behavior.

Manual: Save a disposable target, reload it, and run its available probe. Verify both success and missing-credential/reachability errors identify the target. Confirm unavailable providers are not offered as working run targets.

### `remote-execution`

Automated: [execution target](../server/src/__tests__/environment-execution-target.test.ts) and [custom images](../server/src/__tests__/environment-custom-images-service.test.ts) cover contracts; [SSH live test](../server/src/__tests__/environment-live-ssh.test.ts) requires its own external setup.

Manual: Run a bounded command in the intended target, inspect its output and workspace, and verify execution did not silently fall back to the server host. For custom-image changes, build/probe the disposable image before assigning it. Inspect cleanup and shutdown after the run.

## Gotchas

- A probe is narrower evidence than a complete task with tools, files, and resumption.
- The local option may appear only when editing an existing local environment; availability follows current UI/provider capabilities.
- Workspace service reachability and environment reachability are separate checks.
