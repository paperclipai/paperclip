# Native Runner harness packages

A plugin can contribute a native harness while keeping its implementation and
dependencies in its own npm package. Paperclip retains execution authority,
Runner transport and supervision; the package owns its native protocol, model
admission, tools, events and session state. Installing a harness is an
instance-admin operation because plugin code is trusted executable code.

This contribution is separate from an environment driver. A harness implements
agent execution. An environment driver places Runner and the selected harness
on a computer, acquires and releases its resources, and proves termination.

## Package declaration

Add `runner.harnesses.register` and `runnerHarnesses` to the ordinary plugin
manifest. The plugin still has its existing worker entrypoint and installation
lifecycle. A declaration has this shape:

```ts
{
  capabilities: ["runner.harnesses.register"],
  runnerHarnesses: [{
    harnessKey: "coding",
    displayName: "Example coding harness",
    configSchema: {
      type: "object",
      properties: { mode: { type: "string", enum: ["coding", "review"] } },
      required: ["mode"],
      additionalProperties: false,
    },
    platforms: ["linux-x64", "darwin-arm64"],
    capabilities: { interruption: true, resume: true, structuredResult: true },
    runtime: {
      entrypoint: "dist/harness.js",
      sha256: "sha256:<SHA-256 of the entrypoint bytes>",
    },
    credentials: [{ key: "PROVIDER_API_KEY", displayName: "API key", required: true }],
  }],
}
```

The stable selection ID is `<plugin manifest id>/<harnessKey>`. Harness keys
must be unique within a plugin. Declaration parsing is owned by the lightweight
`@paperclipai/runner-sdk/contracts` package, which has no provider dependencies.
The [standalone SDK](../../packages/runner-sdk/README.md) defines its versioned
process protocol and public host helper.

The runtime entrypoint and all runtime assets must form a self-contained,
prebuilt package. Bundle dependencies or ship them below that package root.
Imports resolved from a controller's ambient dependencies are not a runtime
distribution contract. Admission inventories the installed package's regular
files, content hashes and permission bits, bounded to 10,000 files, 256 MiB and
32 directory levels. Nested symlinks and special files are rejected. A local
development install therefore needs a prepared runtime bundle rather than a
source tree containing pnpm dependency symlinks.

The release `integrity` is an SRI encoding of this installed inventory, not the
registry tarball's SRI. `runtimeDigest` binds the same inventory. Runtime state,
credentials and working files belong outside the immutable package directory.

## Agent setup and execution

Company-scoped discovery is `GET /api/companies/:companyId/runner-harnesses`.
It requires board access to that company and lists only ready packages enabled
there. Discovery returns settings and credential metadata, without importing
the harness or launching a provider. Runtime integrity is checked at admission.

Selecting an installed harness saves an agent with:

```json
{
  "adapterType": "paperclip_runner",
  "adapterConfig": {
    "provider": "extension",
    "harnessId": "example.plugin/coding",
    "model": "operator-selected-model",
    "extensionConfig": { "mode": "coding" },
    "env": {
      "PROVIDER_API_KEY": { "type": "secret_ref", "secretId": "<company secret id>" }
    }
  }
}
```

The form renders the package's JSON Schema and preserves its settings when
reopened. Model IDs are explicit in this version. Credential binding uses the
existing environment-variable and saved-secret interface; plugin-specific AI
connection catalog entries are not part of this contract. Process-control keys
such as `PATH`, `HOME`, `NODE_OPTIONS`, and `PAPERCLIP_*` cannot be declared as
credentials. Core transfers only the selected package's declared keys.

Protocol v1 uses a fresh process for each turn (`lifecycleMode: "per_turn"`).
Warm process retention is not supported by this version.

The Test action initializes the selected environment's installed runtime with
the selected model and a read-only probe request. It supplies no task tools and
does not start a model turn. A successful receipt must identify the exact
package release and effective model. Provider errors are reported without
returning credential-bearing diagnostics. A local probe does not qualify
another execution environment.

Probe completion includes physical process-group retirement. Temporary remote
packages and environment leases remain owned until that proof arrives. A failed
proof keeps a bounded cleanup owner; the next matching setup action retries it.
There is no idle cleanup poll. V1 local probes require POSIX process groups and
fail before launch on Windows.

## Environment-owned launch preparation

An environment task provider opts in through
`description.harnessExtensionVersion: 1`. Existing drivers without that version
remain valid for their existing harnesses; they cannot execute an external
harness through a fallback.

Extension launch requirements carry `provider: "extension"`, the admitted
`settings.extensionRelease`, and package-owned configuration and capabilities.
The environment returns `launch.extensionLaunchProfile` from preparation. This
profile contains the same release identity, digest-verified executable and
optional entrypoint paths, fixed arguments, and permitted credential names on
the execution host. These paths are environment-owned data, never agent settings.

Core checks that the prepared profile and provider descriptor match the admitted
release, preserves the profile during recovery, and sends it through
`submit.launch.extensionLaunchProfile`. Authentication travels separately as
`{ type: "harness-env", harnessId, environment }`, with safe bounded keys and
values. A credential envelope for another harness is rejected before dispatch.

Use the [distribution plugin contract](DISTRIBUTION-PLUGINS.md) for managed
Cloud installation: operators select a prebuilt optional image and its verified
runtime package. Standard images, default provider packs, core manifests and
core tests do not acquire an external harness as a dependency. Startup and task
execution never implicitly install an npm package.

## Compatibility and verification

Runs record their admitted package identity. Changed runtime bytes cannot be
substituted for a saved session. Company enablement and current installed package
identity are rechecked at execution. Package-specific human-input callback
recovery and native model verification must be implemented and qualified by the
harness author; declaring a capability does not prove it works.

Use a synthetic package for core protocol, registration and distribution tests.
Keep real provider dependencies and live provider qualification in the external
package's repository. Test the native task path, questions and approvals,
restart/reconnect, exact-model rejection, Stop races, physical child cleanup and
independently verified work output before advertising those capabilities.
