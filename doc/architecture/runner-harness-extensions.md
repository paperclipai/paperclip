# Native Runner harness packages

Native execution supports an installed npm package through a versioned process
boundary. The package owns its provider implementation and translates it into
normalized events and command acknowledgments. Core Runner owns process groups,
durable PRP delivery, command deduplication and terminal settlement. Paperclip
retains company, issue, tool, secret, approval and budget authority.

`@paperclipai/runner-sdk` is the public contract and process-host package. It has
zero runtime dependencies and imports no provider, server, UI or database code.
The standalone Runner boundary permits this one public contract dependency.
Existing built-in exports and persisted native input versions stay compatible.

The plugin manifest declares `runnerHarnesses` with the
`runner.harnesses.register` capability. Instance administrators install packages
through the existing plugin lifecycle. A company can select only an installed,
ready harness enabled for that company. Source resolution and activation reuse
the existing managed-image guards. Unavailable extensions never fall back to a
built-in provider.

The registry verifies the self-contained package's file inventory and entrypoint.
Its release identity binds package name, version, installed-bundle integrity,
runtime digest and harness protocol version. This integrity value describes
installed bytes; it is not the registry tarball integrity. Dependencies and assets
used at runtime must be shipped inside that self-contained closure. Trusted npm
code is not an operating-system sandbox.

Native input v11 stores the selected release, model, configuration and declared
capabilities. Executable paths are excluded. An execution owner separately supplies
`paperclip.harness-launch.v1` startup authority. Runner verifies the command and
entrypoint before launching; a run descriptor cannot replace them. Credentials
are limited to declared names and are never included in the release identity.

The first process protocol supports per-turn execution and cold session checkpoints.
Snapshots retain exact release, session, model, configuration and workspace binding.
Recovery refuses a changed release, a live previous process group, or incompatible
provider state. Process-local pending human requests expire on provider loss; a
late response cannot grant a new operation. Warm cross-authority adoption requires
its own qualified ownership contract and is not implied by resume capability.

External provider packages live in their own repositories. The default workspace,
lockfile, tests and standard images must not install their provider dependencies.
`node scripts/check-runner-dependency-boundary.mjs` enforces the DeepSeek harness exclusion from
the default workspace dependency closure. Synthetic packages qualify the shared
extension mechanism. Provider-specific paid and product qualification belongs in
the external repository.

Managed Cloud uses the existing distribution plugin catalog in an explicitly
selected image. Default images contain no external harness packages. Runtime
installation remains platform-managed; tenant-controlled npm installation is not
enabled by this extension contract. Environment task providers advertise
`harnessExtensionVersion: 1` before preparing an external harness.

The public SDK must be bootstrapped on npm before releasing its consumers. Its
CI release enrollment and workspace dependency edges are included here; a local
build or packed-consumer pass does not mean that first publish has happened.
The separate provider package is published independently, after the compatible
core release and its own platform and authenticated execution qualification.
