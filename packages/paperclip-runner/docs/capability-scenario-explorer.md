# Capability Browser Scenario Explorer

The scenario explorer is a read-only browser surface over all 106 conformance
cases. It runs each scenario in the page against the
[mock control plane](capability-mock-control-plane-port.md) through the
[semantic tool runtime](capability-semantic-tools.md) and renders the resulting
run artifact. It never re-judges parity, never leaves its own origin, and holds
no credential.

Sources: `src/scenarios/` (scenario index, runner, parity, state diff) and
`examples/scenario-explorer/`. Interaction contract:
[Capability scenario explorer UX](design/capability-scenario-explorer-ux.md).

## The run artifact

Running a scenario produces one immutable artifact carrying:

- **Tool exposure** — which semantic tools were available, and for optional
  tools, the grant that unlocked each one.
- **Control-plane actions** — control-plane-owned steps (for example checkout),
  each labelled "no agent tool exists for this."
- **Authorization records** — allow and typed-deny decisions; a denial carries
  the missing claim and no protected task data.
- **State diff** — an immutable diff over the ten entity domains, with unchanged
  domains collapsed.
- **Parity verdict** — the runtime's own verdict, plus Capability's per-case
  result carried through in a separately labelled block. The explorer displays
  these; it does not recompute them.

## Read-only and frozen SDK

The explorer imports the frozen **0.1.2** public SDK through the package-local
alias `@paperclip-runner-local/capability`, which is deliberately not the published
package name. It adds no SDK export and changes no published surface. Fake mode
runs entirely in the page against checked-in fixtures and renders fixture time
only, so two loads of the same route produce identical settled DOM.

## What the explorer shows

- **Home** — 16 group facets whose counts sum to 106, corpus stats, and example
  deep links.
- **Picker** — a listbox with live filter chips, disabled zero-count values, and
  a clear-filters control.
- **Transcript** — both channels (agent-visible and control-plane).
- **Inspector** — four tabs: context (exposure and grants), authorization
  (allow/deny), state diff, and traceability.

## Boundary

- No network request leaves the explorer's own origin.
- `localStorage` holds no run artifact, grant, or fixture payload.
- Codex mode is a disabled option with a stated reason; wiring it to the SDK
  relay is deferred, and the browser holds no provider credential either way.
- Secrets are redacted before display; redaction chips name the rule and never
  the value. See [authorization and exposure](capability-authorization-and-exposure.md).

## Accessibility

The 7F browser suite asserts: listbox arrow-key navigation with
`aria-activedescendant`, WAI-ARIA tab arrow-key activation with exactly one
tablist, every interactive control named, a polite live region announcing the
settled verdict, three landmarks, a single `h1`, and — at 390px — one segment at
a time with zero horizontal overflow.

## Running it

```sh
# Open the explorer on 127.0.0.1:4183.
pnpm --filter @paperclipai/paperclip-runner demo:scenarios

# Scenario runtime, explorer components, and route determinism (49 tests).
pnpm --filter @paperclipai/paperclip-runner test:scenarios

# Browser IA, determinism, evidence routes, boundary, a11y, responsive (25).
pnpm --filter @paperclipai/paperclip-runner test:browser:scenarios

# Deterministic 24-image acceptance set (12 routes x 2 viewports).
# Recorded evidence generation is deferred from this release.
```

## Related

- [Eval conformance](capability-eval-conformance.md)
- [Verification commands](capability-verification-commands.md)
