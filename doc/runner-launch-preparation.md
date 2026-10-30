# Runner launch preparation

Core selects the provider, model, instructions, tools, and task permissions.
The execution environment supplies executable paths and filesystem locations.

The built-in TypeScript implementation constructs the provider descriptor in
`createRunnerProviderLaunch`. The transport sends this descriptor with
`run.prepare`. Provider backends keep their existing validation and session rules.

By default, the SDK prepares local files. It stages remote files through the
existing execution driver.

## Environment-owned preparation

An execution driver can supply `prepareLaunch`.
The callback receives `RunnerProviderLaunchRequirements`.
It returns `PreparedRunnerProviderLaunch`.

Requirements contain the selected provider, model, policy, run identity, and
runtime context. They do not contain task text, process callbacks, provider
credentials, or controller executable choices. Resource paths identify source
locations. They do not grant filesystem access on the execution host.

The environment resolves its resources and prepares the provider descriptor.
It can use `bindRunnerLaunchResources` to replace registered context locations.
It can use `createRunnerProviderLaunch` for the existing descriptor projection.
The transport does not perform its built-in file preparation in this mode.
The process owner supplies the Runner artifact and process lifecycle.

The result contains a configuration ID, a requirements digest, and a provider
descriptor. The transport checks Core's selected profile and policy before
registration and launch. Core still supplies authorized tools and completion
criteria through PRP. A failed preparation does not enable a fallback launch.

### Working directory

In this mode the environment chooses the provider working directory. Core does
not supply one. The backend uses `workingDirectoryAuthority:
"runner_prepared_launch"`, and its controller environment stays empty.

- Core authorizes the agent, task, projects, and workspace binding.
- The environment resolves that assignment into mounts and the descriptor's
  `cwd`. For a projectless task it selects its own default directory.
- The transport accepts only a normalized absolute `cwd` that is not a
  filesystem root. Runnerd validates the directory on its own filesystem.
- The transport reports that `cwd` to the driver. The driver records it in
  session context, snapshots, and recovery, and ignores the caller's directory.
- Recovery and run attachment must keep the same `cwd`. A runner snapshot or
  recovered thread that reports another directory fails recovery. Core does not
  substitute a controller-local or temporary directory.

`remote_runner` remains the mode in which Core assigns the remote directory
through `PAPERCLIP_WORKSPACE_CWD`.

The transport saves the exact requirements and prepared configuration in its
private `launch-preparation.json` file. The file holds at most two records.
A new attachment keeps the active run's record. Runner commands contain the
provider descriptor once. They do not contain these recovery records.

Recovery within the same run must return the same configuration. This rule also
applies during an interrupted warm attachment. A new run uses its current
requirements. For a new run, `runtimeContext: null` removes the assigned context.
Only an omitted context can reuse the previous context.
Provider session compatibility checks remain in their existing
backends. Close waits for preparation within its deadline. A timeout retains an
unsettled checkpoint and prevents reuse.

## Plugin task protocol

The [environment task API](plugins/PLUGIN_ENVIRONMENT_TASKS.md#launch-preparation)
defines the plugin preparation exchange. The [native plugin integration](plugins/PLUGIN_RUNNER_EXECUTION.md)
connects the callback to task execution. A Launcher implementation remains the
execution owner's responsibility.
