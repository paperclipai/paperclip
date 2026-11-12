# Capability Clean-Start Tutorial: The Paperclip-Style Issue Thread Over a Mock Control Plane

**Time to first success: about 5 minutes.** Two commands take you from a clean
checkout to 106 passing conformance cases and a Paperclip-style issue thread you
can click through in a browser. The whole tutorial runs from the repository
root. It starts no Paperclip service, contacts no Paperclip control plane, clones
no external eval repository, and holds no provider credential. Everything the
default path needs is checked in under `packages/paperclip-runner/`.

This is the canonical Capability tutorial for the final build. It covers both agent
modes: **scripted (deterministic) fake mode**, which is fully offline, and
**Codex (bounded) live mode**, which is optional and needs a locally
authenticated Codex. The two modes share one mock control plane, one semantic
tool catalog, one authorization engine, and one view contract. See
[execution modes and identity](../capability-execution-modes.md) for the rules that
separate them, and [the future binding boundary](../capability-future-binding-boundary.md)
for why none of this touches real Paperclip — that is future upload integration and needs separate
approval.

For a deeper tour of the read-only scenario explorer and the capability
contract, see the companion
[scenario-explorer tutorial](capability-scenario-explorer.md); this page focuses
on the issue-thread surface and the live loop.

## What you need

- Node.js 20 or newer and pnpm 9 or newer. This tutorial was verified with Node
  22.22.2 and pnpm 9.15.4.
- No Rust toolchain for the fake-mode steps (steps 1–4). The optional live steps
  (step 5) build the `paperclip-runnerd` binary and need a Rust toolchain and a
  locally authenticated Codex.
- No network access after `pnpm install`.

Install the package workspace from the repository root:

```sh
NODE_ENV=development pnpm install --filter @paperclipai/paperclip-runner --frozen-lockfile --offline --ignore-scripts
```

This keeps the checked-in lockfile authoritative while using only packages
already present in the pnpm store, so the offline install does not re-resolve
dependencies to registry-latest versions. Setting `NODE_ENV=development`
ensures the complete test toolchain is installed even when the checkout
inherits `NODE_ENV=production`.

## 1. Prove the 106-case conformance suite (about 1 minute)

```sh
pnpm --filter @paperclipai/paperclip-runner test:capability-evals
```

This drives all 106 eval-derived cases across the 16 groups entirely in-process
against the mock control plane. Expected final line:

```
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

For the per-group counts, assertion classes, the 18-operation fake-agent matrix,
and the 16-case bounded Codex binding sample, generate the parity report:

```sh
pnpm --filter @paperclipai/paperclip-runner report:capability-evals
```

Expected final line:

```
Capability eval conformance passed: 106 cases across 16 groups.
```

The report is written to `.paperclip-local/evidence/capability/eval-parity-report.{json,md}`.
It is generated on demand and is not committed; delete it before running
`docs:validate`, or run validation first.

## 2. Run the issue-thread contract and UI tests (about 1 minute)

```sh
pnpm --filter @paperclipai/paperclip-runner test:scenarios
```

Expected final lines:

```
 Test Files  11 passed (11)
      Tests  137 passed (137)
```

This covers the mock `ControlPlanePort`, the semantic tools with their
authorization and redaction rules, and the `CapabilityIssueThreadSnapshot`
view-model contract — including that every one of the twelve deterministic
screenshot states builds a schema-valid snapshot with no credential anywhere in
the projected view.

## 3. Open the issue thread in fake mode (about 2 minutes)

```sh
pnpm --filter @paperclipai/paperclip-runner console:issue-thread
```

Open <http://127.0.0.1:4184/#/issue/hb-baseline?shot=thread-baseline>.

You are looking at a Paperclip issue thread, not a dashboard. The header carries
three identity chips that stay visible in every mode — `Fake agent`,
`In-process runner`, and `Mock Paperclip` — plus the mock issue identifier
(reserved `MCK-` prefix), status, priority, and the Scenario / Replay / Reset /
Stop controls. The main column is one readable work thread; the Evidence panel is
collapsed on the right.

Swap the `shot` value to seed any of the twelve contract states — each one is a
different item type or interaction state from the
[issue-thread UX contract](../design/capability-issue-thread-ux-contract.md):

| `shot=` | What it shows |
| --- | --- |
| `thread-baseline` | User message, model prose, a durable `Recorded to mock thread` comment, and a collapsed tool strip. |
| `turn-streaming` | A streaming turn with the composer in its `streaming` state (input editable, Stop primary). |
| `interaction-question-pending` | An inline `ask_user_questions` card that refuses an incomplete submit. |
| `interaction-confirmation-pending` | A revision-bound confirmation that requires a reject reason. |
| `interaction-resolved-mixed` | Accepted, rejected, expired, and stale interactions as durable history. |
| `denial-optional-tool` | A verbatim typed denial with its Evidence badge and no protected data. |
| `document-revision` | A document revision card bound to the mock document. |
| `deliverable-registered` | A registered deliverable reporting one size in one unit. |
| `disposition-terminal` | A terminal disposition that disables the composer. |
| `debug-panel-open` | The eight-section Evidence panel opened on the authorization records. |
| `reconnect-banner` | The reconnect banner and its `Reconnected` confirmation. |
| `replay-mode` | The replay progress strip with `Step back`, `Next turn`, and `Play all`. |

Open the Evidence panel (or the `Evidence` segment on a phone). Its eight
sections stay in a fixed order: Tools exposed, Calls & results, Authorization,
Control plane, Runner & events, State diff, Traceability, Parity. The Tools
section separates `Agent tool — always`, `Agent tool — granted` (with its
grant), and a `Control plane (not exposed to the agent)` list — what the model
*cannot* call is first-class evidence. Every strip, denial, and card deep-links
into its record, and each record links back to its thread anchor.

Resize the browser below 768px: the page collapses to a `Thread` / `Evidence`
segmented control, keeps Stop outside the `⋯` menu while a turn is active, and
never scrolls horizontally.

## 4. Record the deterministic screenshot matrix (about 1 minute)

```sh
# Recorded evidence generation is deferred from this release.
pnpm --filter @paperclipai/paperclip-runner check:capability:ui
```

The first writes 24 images — the twelve slugs at 1440×900 and 390×844 — to
`.paperclip-local/evidence/capability/ui/`. Every mobile capture asserts no horizontal
scroll before the shot. The second re-records and confirms all 24 reproduce
byte-for-byte, which is the property that makes the fake-mode matrix a stable
acceptance artifact. Both modes render fixture time only, so a fresh checkout
reproduces the committed images exactly.

## 5. Optional: drive a real Codex turn (live mode)

Live mode needs a Rust toolchain and a locally authenticated Codex. It starts a
real `paperclip-runnerd` process and a real Codex app-server session; the
package server owns the process, the tool loop, and the provider credential, and
the browser receives none of them. **Skip this section if you do not have Codex
installed** — nothing above depends on it.

Headless smoke over the package server:

```sh
pnpm --filter @paperclipai/paperclip-runner smoke:capability:ui
```

This creates a session, runs live turns, and asserts the identity reads
`Real Codex` / `Real runnerd` / `Mock Paperclip`, that a real tool call was
recorded with its authorization record, that the control-plane-owned list is
withheld from the agent, and that no credential appears in the view.

Capture the live browser frames (a real browser driving a real Codex turn):

```sh
# Recorded evidence generation is deferred from this release.
```

The frames land in `.paperclip-local/evidence/capability/ui-live/`. They are intentionally
**not** byte-stable — a real provider turn varies — so they are excluded from the
determinism gate and are the mode that satisfies the final live acceptance
criteria. A scripted (`mode=fake`) frame cannot.

Prove the process and network boundary directly:

```sh
pnpm --filter @paperclipai/paperclip-runner trace:live-runner -- --json
```

This checks a real semantic-tool mutation, a typed result, a same-thread second
turn, process ownership and cleanup (`runnerExited`, `authorityCleared`), and —
critically — `noRealPaperclipRequest` and `noPaperclipAuthorityInChild`.

## Reset, stop, replay, and cleanup

These controls work the same in either mode because they act on the mock core
and the runner session, not on the agent:

- **Reset** asks first, then restores the original clean mock seed under new
  run/session authority and rotates or clears the old authority. It does not
  touch another browser session.
- **Stop** cancels only the active turn and reaps the runnerd process group; the
  session and transcript survive with a `Stopped by user` marker.
- **Replay** reproduces a recorded canonical timeline. It is always scripted and
  always labelled fake-derived.
- **Refresh / reconnect** restores the same session, pending interaction,
  transcript, and mock state; reconnect starts a fresh runnerd and Codex and
  resumes the persisted thread without restarting the conversation.

## What this does not do

- No ACPX implementation and no real control-plane integration. Real Paperclip
  binding is future upload integration and requires separate approval.
- No provider, runner, or control-plane credential in the browser, ever.
- Nothing you type is persisted beyond the mock session. A reload drops an
  unsent draft — the accepted trade against storing conversation content.

References: [issue-thread UI](../capability-issue-thread-ui.md),
[live runnerd and Codex loop](../capability-live-runnerd-codex.md),
[execution modes and identity](../capability-execution-modes.md).
