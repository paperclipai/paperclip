# Sandbox provider capability contract

A sandbox provider plugin declares an environment driver with
`kind: "sandbox_provider"`. Each driver can declare a set of optional sandbox
capabilities. This document is the contract for a third-party provider author.
It states what to declare, which worker methods each capability needs, what an
omitted key means, and when the host narrows or denies a capability.

Read [Sandbox file-sync lifecycle hooks](./SANDBOX_FILE_SYNC_HOOKS.md) for the
native file-transfer hooks. Read the driver declaration shape in
[the plugin specification](./PLUGIN_SPEC.md).

## How the host resolves an effective capability

The host never trusts a declaration alone. For every run it resolves each
capability as the intersection of three inputs:

```
effective = verified ∩ declared ∩ narrowing
```

- **verified** — the methods the live worker advertised in
  `InitializeResult.supportedMethods`. The host maps each capability to the
  worker methods it needs (see the table below). A capability is verified only
  when the worker advertises every required method. An empty or missing method
  list verifies nothing, so every capability resolves `false`.
- **declared** — the values in the driver declaration. A declared key is
  optional (see the next section).
- **narrowing** — a per-run restriction from the lease policy or the resolved
  provider config. A narrowing can only remove a capability, never add one.

A capability is effective only when all three allow it. A declaration therefore
never grants a capability that the worker did not verify.

## The declaration is optional and partial

Declare capabilities through the nested `sandboxCapabilities` object on the
driver declaration:

```ts
environmentDrivers: [
  {
    driverKey: "my-provider",
    kind: "sandbox_provider",
    displayName: "My Provider",
    configSchema: { type: "object", properties: {} },
    sandboxCapabilities: {
      reusableLeases: true,
      nativeSyncIn: true,
      nativeSyncOut: true,
      persistentProcessSessions: false,
      independentControlCommands: false,
    },
  },
]
```

Every key is optional. For a valid, identified provider each key has one of three
states:

- **Omitted** — the host defers to verified worker discovery. The capability is
  effective when the worker advertises the required methods and no narrowing
  removes it. Omission is the correct default for a provider that follows the
  standard method contract. `reusableLeases` is the one exception: an omitted
  `reusableLeases` key never grants reusable leases (see the next section).
- **`false`** — the host narrows the capability to off. The capability is never
  effective, even when the worker advertises the required methods.
- **`true`** — the host still requires the verified prerequisites. A `true`
  value never grants a capability without them. It documents intent and lets the
  host present the capability, but the worker must still advertise the required
  methods.

## Reusable leases need an explicit opt-in

Reusable leases are the exception to the omission rule above. The host grants
reusable-lease acquisition only when the declaration sets `reusableLeases` to
`true`. The provider opts in through one of two fields:

- the nested `sandboxCapabilities.reusableLeases: true`, or
- the legacy `supportsReusableLeases: true`.

An omitted key leaves `reusableLeases` unset. An unset key does not make the
provider eligible for reusable-lease acquisition, and it does not advertise
provider-level reusable support. The host then always creates an ephemeral lease.

The opt-in never removes the other prerequisites. The worker must still verify
all three lifecycle methods, `environmentResumeLease`, `environmentReleaseLease`,
and `environmentDestroyLease`, and per-run narrowing still applies.

The two opt-in fields have a fixed precedence. The host keeps the legacy
`supportsReusableLeases` field for backward compatibility, and it folds the field
into `sandboxCapabilities.reusableLeases`.

- When only `supportsReusableLeases` is present, the host reads it as
  `reusableLeases`.
- When both `supportsReusableLeases` and `sandboxCapabilities.reusableLeases` are
  present, the nested value wins.

A manifest with legacy `true` and nested `false` therefore resolves to `false`.
Prefer the nested `sandboxCapabilities.reusableLeases` in a new manifest.

## The capabilities and their worker-method prerequisites

| Capability | Required worker methods | Meaning |
| --- | --- | --- |
| `reusableLeases` | `environmentResumeLease`, `environmentReleaseLease`, **and** `environmentDestroyLease` | The host retains a provider lease and resumes it across runs. |
| `nativeSyncIn` | `environmentSyncIn` | The host transfers files into the sandbox through the native inbound hook. |
| `nativeSyncOut` | `environmentSyncOut` | The host transfers files out of the sandbox through the native outbound hook. |
| `persistentProcessSessions` | `environmentExecute` | The provider keeps a persistent process session open across commands. |
| `independentControlCommands` | `environmentExecute` | The provider runs a one-shot control command beside a long-lived command. |

Reusable leases need all three lifecycle methods. The host resumes a lease with
`environmentResumeLease`, ends it with `environmentReleaseLease`, and tears down a
stale lease with `environmentDestroyLease`. The reuse path destroys a stale lease
when a resume fails, so a provider that cannot destroy a lease would strand it. A
worker that omits any of the three methods never gets reusable leases, even with a
positive declaration. The host then always creates an ephemeral lease.

The host advertises and consumes the two native sync methods as a pair. Define
both or neither. See [Sandbox file-sync lifecycle hooks](./SANDBOX_FILE_SYNC_HOOKS.md).

## Target and config narrowing

A narrowing removes a capability that the provider verified and declared but that
this run cannot use.

- **Ephemeral lease policy.** A lease that the host does not retain never reuses.
  The host narrows `reusableLeases` to off for an ephemeral lease and keeps it on
  only for a reuse-by-environment lease.
- **Kubernetes Job backend.** A Job-backed lease, or a lease the host marked as
  unable to run native file sync, disables native sync. The host narrows
  `nativeSyncIn` and `nativeSyncOut` to off and keeps the base64-over-exec
  fallback.
- **`useSessions` provider config.** A session-based provider follows its
  `useSessions` config value for `persistentProcessSessions`. Sessions default to
  off. A config that omits the key adds no narrowing.

## Failure behavior

The host fails closed on two failure states. It never grants a capability from an
unknown state.

- **Config-resolution failure.** When the host cannot resolve the provider
  config, it cannot read `useSessions`. It narrows `persistentProcessSessions` to
  off instead of allowing it through an empty config.
- **Exact-plugin identity failure.** A retained lease pins the exact plugin that
  acquired it. When that plugin is absent, or when it no longer declares this
  provider key with the `sandbox_provider` kind, the host cannot establish the
  declaration. It resolves every effective capability to `false`, no matter what
  methods a stale worker still advertises. An omitted `sandboxCapabilities`
  object on a valid, identified plugin is a different state; the host defers to
  verified discovery for that case.

## Concurrency capabilities are not part of the contract

Earlier drafts listed two concurrency keys, `concurrentSyncAndExec` and
`concurrentSyncOperations`. The runtime never exposed a scheduling choice that
read either key, so a declaration had no effect. The host removed both keys. The
strict capability validator now rejects them as unknown keys. The host can
reintroduce a concurrency capability when a runtime path enforces it.
