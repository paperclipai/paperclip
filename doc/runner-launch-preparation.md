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
defines the plugin preparation exchange. This callback does not implement a
plugin task process owner or a Launcher endpoint. Those integrations are
separate changes.
