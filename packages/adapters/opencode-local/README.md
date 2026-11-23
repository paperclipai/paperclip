# OpenCode local adapter

## Runtime configuration

`prepareOpenCodeRuntimeConfig` stages an isolated OpenCode configuration directory
on the host for both local and remote execution targets. It copies the operator
configuration and applies the runtime provider and permission settings. Its
returned `XDG_CONFIG_HOME` points to that host directory.

For remote execution, `execute` and `testEnvironment` pass the staged directory
to `prepareAdapterExecutionTargetRuntime` as the `xdgConfig` asset. They replace
`XDG_CONFIG_HOME` with the asset's remote destination before running OpenCode.
The helper's cleanup function removes the host staging directory.
