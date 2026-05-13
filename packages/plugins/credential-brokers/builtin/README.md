# @paperclipai/credential-broker-builtin

Default credential broker plugin for Paperclip.

**M1 status:** Placeholder package only. The actual broker — per-task ephemeral CA,
loopback HTTP CONNECT listener, header injection, session store, `pushCredential`
write-through cache — lands in **M2**.

See:
- [Design spec](../../../../docs/superpowers/specs/2026-05-12-credential-broker-design.md)
- [M1 implementation plan](../../../../docs/superpowers/plans/2026-05-12-credential-broker-m1-plan.md)
- [`@paperclipai/plugin-sdk`'s `registerCredentialBroker()`](../../sdk/src/credential-broker.ts)

## Why ship an empty package in M1?

The placeholder reserves the workspace name and import path so the M2 work
can land as additive changes to a known module. It also lets dependent
packages (the server-side broker registry, future operator tooling) take
the workspace dependency now without waiting on M2.
