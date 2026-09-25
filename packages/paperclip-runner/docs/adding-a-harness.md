# Adding a Harness

Every Paperclip Runner harness must declare its permission behavior as part of
the provider contract. A driver is not complete until its permission modes,
maximum non-interactive default, durable request translation, recovery
identity, isolation behavior, and conformance coverage are defined.

## Distribution

First-party harness glue belongs in the runner, not in a new npm package for
each provider. Keep built-in launchers and metadata under
`src/providers/<provider>/`; include them in the compiled runner and the public
server's vendored runtime. Grok is the reference implementation. This keeps a
public Paperclip npm install self-contained as more harnesses are added.

Native provider binaries remain execution-environment prerequisites. Provision
them explicitly in sandbox images or on local execution hosts, independently
of npm installation and the controller provider pack. Admission must verify
the qualified version and executable checksum before credentials are delivered.
Missing prerequisites should produce an actionable error, never a silent
download or an unverified fallback to PATH.

Use a distinct built-in launcher identity and native runtime identity in the
qualified profile, recovery binding, provider-pack manifest, and eval config.
Existing upstream npm-backed ACP bridges retain their package pins; this does
not require replacing those bridges or republishing them under Paperclip names.

Verify public release tarballs in a clean consumer outside the checkout with
npm lifecycle scripts enabled. Prove that the launcher ships, npm does not
install the native prerequisite, missing prerequisites fail closed, and
explicit provisioning permits verified execution. See
`scripts/verify-grok-npm-install.mjs` at the repository root.

## Current permission catalog

| Provider | Agent configuration key | Supported values | Default |
|---|---|---|---|
| Codex | `codexPermissionMode` | `never`, `on-request`, `untrusted` | `never` |
| OpenCode | `opencodePermissionMode` | `allow`, `ask`, `deny` | `allow` |
| ACPX (Claude, Grok) | `acpxPermissionMode` | `approve-all`, `approve-paperclip`, `approve-reads`, `deny-all` | `approve-all` |

The browser-safe source of truth for labels, defaults, and configuration
validation is `PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES` in
`@paperclipai/adapter-utils`. Native process boundaries validate the pinned
provider value again; they must not silently accept an unknown mode.

“Full auto” means the harness does not pause for a duplicate approval inside
the environment assigned to the run. It does not grant host-wide filesystem
access, unrestricted network access, Paperclip credentials, or write access in
read-only planning mode. Workspace containment, protected-path and symlink
checks, network policy, credential bindings, and authenticated PRP
authorization remain authoritative and run before any harness auto-approval.

## Driver requirements

When adding or upgrading a harness:

1. Declare the exact native modes supported by the provider. Choose the
   provider's highest non-interactive mode as the default for a fresh
   Paperclip Runner execution.
2. Add its labels, configuration key, options, and default to the shared
   provider-discriminated capability catalog. The agent form must show only
   the selected provider's setting and retain stored choices when the provider
   selection changes.
3. Pin the effective value in native execution input and provider recovery
   state. Include it in provider-session compatibility so changing a mode
   replaces an incompatible warm session rather than mutating an active turn.
4. Translate every lower-mode prompt into the canonical runtime-request
   lifecycle: emit one durable request, recover it after reconnect, accept
   allow-once, allow-for-session, deny, and cancellation where the provider
   supports them, and send exactly one provider-native resolution.
5. Authorize Paperclip semantic and question tools through authenticated PRP.
   These tools may bypass duplicate harness approval, but never their
   control-plane authorization.
6. Emit the provider and effective permission mode in session-start
   diagnostics without including credentials or unredacted provider input.
7. Keep standalone local adapters unchanged unless their own contract is
   deliberately revised. Paperclip Runner defaults apply only to
   `paperclip_runner` executions.

## Compatibility rules

Native execution input v4 pins `approvalPolicy` for Codex and
`permissionMode` for OpenCode and ACPX. Persisted v1-v3 executions remain
replayable. Their missing Codex and OpenCode settings use the historical
effective behavior, and legacy ACPX `permissionPolicy: "interactive"` means
the historical `approve-reads` behavior. Legacy fields are readable only;
new agent configuration must not persist them.

Do not rewrite an active execution when configuration changes. A fresh
execution carries the new policy and replaces an incompatible idle or
checkpointed session through normal session-compatibility handling.

## Conformance checklist

A new driver must cover:

- agent create/edit defaults, selected-provider visibility, provider switching,
  invalid-value rejection, and no Runner sandbox-bypass control;
- native serialization, legacy replay, recovery identity, and replacement
  after a permission change;
- start and resume propagation for every supported mode;
- no runtime request in the maximum mode;
- once, session, and deny resolution in prompting modes, including every
  provider event version the driver accepts;
- immediate rejection in deny mode;
- workspace and protected-path denial before auto-approval;
- authenticated semantic-tool behavior; and
- an end-to-end default-mode write plus validation command that completes
  without an Input needed permission card.

Run TypeScript, Rust, UI, protocol-generation, durable transport, and
documentation validation before declaring the harness qualified.
