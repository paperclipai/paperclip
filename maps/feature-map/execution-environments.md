---
navigation: {"section":"Projects and execution","sectionOrder":40,"order":40}
---

# Execution environments

Operators configure where agents execute, probe readiness, select an environment for work, and inspect remote provisioning or custom-image state when the installed provider supports it.

Feature ID: `execution-environments`.

Implementation: [environment settings](../../ui/src/pages/CompanyEnvironments.tsx), [environment runtime](../../server/src/services/environment-runtime.ts).

Agent access: [companion](../agent-access-map/execution-environments.md).

## Sub-features

- `configuration`: `execution-environments/configuration` — inspect local environments and configure available SSH/sandbox targets.
- `capabilities`: `execution-environments/capabilities` — select only drivers/providers that advertise the required execution capability.
- `probe`: `execution-environments/probe` — test reachability and runtime prerequisites in the actual target.
- `assignment`: `execution-environments/assignment` — bind the intended agent/project/workspace to its execution target.
- `images`: `execution-environments/images` — inspect supported sandbox custom-image preparation and terminal workflows.

## How to get to it (user POV)

### `environment-settings`

Open Settings → Environments, then create/edit a supported target.
The canonical URL is `/company/settings/instance/environments`. Enable
`enableEnvironments` first; keep `enableManagedSandboxOnly` off to inspect local
targets. The catalog is instance-scoped and mutation requires a local operator
or instance administrator.

### `remote-execution`

Choose the environment in agent/project/workspace configuration, then inspect the resulting task/run and workspace.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use an owned disposable target and a supported provider plugin. Record provider, target identity, account, and spending constraints before a live remote run.

### `environment-settings`

Automated: [environment UI](../../ui/src/pages/CompanyEnvironments.test.tsx), [driver configuration UI](../../ui/src/pages/CompanySettings.test.tsx), and [environment service](../../server/src/__tests__/environment-service.test.ts) cover configuration behavior.

Manual: Save a disposable target, reload it, and run its available probe. Verify both success and missing-credential/reachability errors identify the target. Confirm unavailable providers are not offered as working run targets.

For an immutable sandbox image, pin the OCI image with `@sha256`, or select
a Daytona snapshot whose provider ID can be verified, and explicitly probe the saved environment in the intended company. The existing connection
probe allocates a fresh lease and can measure its OS, architecture and libc.
Qualification is recorded only when the selected image/configuration matches
the live lease and cleanup is confirmed. Inspect `platformQualificationRecorded`
and its diagnostic in the probe result: connection success alone does not mean
the image has native runtime qualification.

The measured record is server-owned, company-bound and tied to the effective
configuration and active custom-image identity. Mutable tags, provider defaults
and snapshots without verified provider identities do not qualify. Daytona
qualification creates by provider ID and binds native execution to that same ID;
a deleted ID fails instead of resolving a replacement name. Changing the target,
account, image or active captured template invalidates
the record; normal metadata edits cannot forge or overwrite it, and API reads
omit the private metadata. Reading this evidence for discovery or creation does
not allocate a sandbox. The draft `probe-config` checks are not a saved-image
qualification operation. See the [runtime contract](../../packages/paperclip-runner/README.md)
and [adapter validation recipe](./runs-adapters.md#adapter-setup) for native
binary/provider readiness after platform qualification.

Verification recipe: probe a pinned owned image, record its company/config/image
identity and cleanup result, then change the image or target and verify its old
qualification is not reused. A mutable-image connection can succeed while
qualification remains absent. Assert ordinary agent and non-admin board probe
requests are denied, and environment create/PATCH payloads cannot supply
qualification metadata.
This recipe and its [probe controls](../../server/src/__tests__/environment-probe.test.ts)
are not claims that a live provider or agent-access journey ran for this map update.

The local row has no UI Test button. Its API/CLI probe reports host/cwd
availability only; it does not validate an adapter binary, workspace, or task
execution. Remote-driver probes and a real bounded run need their own evidence.

### `remote-execution`

Automated: [execution target](../../server/src/__tests__/environment-execution-target.test.ts) and [custom images](../../server/src/__tests__/environment-custom-images-service.test.ts) cover contracts; [SSH live test](../../server/src/__tests__/environment-live-ssh.test.ts) requires its own external setup.

The [environment runtime regression](../../server/src/__tests__/environment-runtime.test.ts)
also covers sandbox reuse after a start longer than one minute. Acquisition
uses the configured or provider-declared startup budget for resume and shares
one deadline across retries. Failure preserves the recorded sandbox. This
controlled timing check does not establish live provider acceptance.

Manual: Run a bounded command in the intended target, inspect its output and workspace, and verify execution did not silently fall back to the server host. For custom-image changes, build/probe the disposable image before assigning it. Inspect cleanup and shutdown after the run.

## Gotchas

- A probe is narrower evidence than a complete task with tools, files, and resumption.
- Platform qualification does not authenticate a model account or qualify every
  harness; the selected native runtime still needs its own setup and useful-task proof.
- The local option may appear only when editing an existing local environment; availability follows current UI/provider capabilities.
- Workspace service reachability and environment reachability are separate checks.

### Storybook verification

#### `configuration`

Capability ID: `execution-environments/configuration`.

Scope: ui
Storybook: Local/SSH/sandbox editors; unavailable providers, missing credentials, save pending/error and restricted operator.
Production: Persist target configuration and enforce instance-admin/local-operator mutation boundary; target catalog is instance-scoped.
Sources: Source: [CompanyEnvironments.tsx](../../ui/src/pages/CompanyEnvironments.tsx), [environments.ts](../../server/src/routes/environments.ts). Tests: [CompanyEnvironments.test.tsx](../../ui/src/pages/CompanyEnvironments.test.tsx), [environment-service.test.ts](../../server/src/__tests__/environment-service.test.ts)

#### `capabilities`

Capability ID: `execution-environments/capabilities`.

Scope: ui
Storybook: Supported versus unavailable driver/provider controls and interactive-setup/template-capture limitations.
Production: Verify advertised driver/plugin capabilities match operations; unavailable provider cannot become working target; capability discovery must not allocate sandbox.
Sources: Source: [CompanyEnvironments.tsx](../../ui/src/pages/CompanyEnvironments.tsx), [environments.ts](../../ui/src/api/environments.ts). Tests: [environment-capability-contract.test.ts](../../server/src/__tests__/environment-capability-contract.test.ts), [environment-execution-target-capabilities.test.ts](../../server/src/__tests__/environment-execution-target-capabilities.test.ts), [plugin-environment-driver-sandbox-capabilities.test.ts](../../server/src/__tests__/plugin-environment-driver-sandbox-capabilities.test.ts)

#### `probe`

Capability ID: `execution-environments/probe`.

Scope: ui
Storybook: Remote Test pending, success, reachability/auth failure and platform qualification absent/invalidated notice.
Production: Probe actual owned target; verify selected saved immutable config/image/company qualification plus lease cleanup; local API probe proves host/cwd only and has no UI Test button.
Sources: Source: [CompanyEnvironments.tsx](../../ui/src/pages/CompanyEnvironments.tsx), [environment-probe.ts](../../server/src/services/environment-probe.ts). Tests: [CompanyEnvironments.test.tsx](../../ui/src/pages/CompanyEnvironments.test.tsx), [environment-probe.test.ts](../../server/src/__tests__/environment-probe.test.ts), [environment-live-ssh.test.ts](../../server/src/__tests__/environment-live-ssh.test.ts)

#### `images`

Capability ID: `execution-environments/images`.

Scope: ui
Storybook: Custom-image setup/capture/progress, terminal connect/disconnect/failure, unsupported capability and active-image drift.
Production: Execute owned provider setup/capture/probe/terminal transport with correct saved image identity, authority, cleanup and shutdown; terminal screenshot cannot prove operation.
Sources: Source: [CompanyEnvironments.tsx](../../ui/src/pages/CompanyEnvironments.tsx), [environment-custom-images.ts](../../server/src/services/environment-custom-images.ts). Tests: [CompanyEnvironments.test.tsx](../../ui/src/pages/CompanyEnvironments.test.tsx), [environment-custom-images-service.test.ts](../../server/src/__tests__/environment-custom-images-service.test.ts)
