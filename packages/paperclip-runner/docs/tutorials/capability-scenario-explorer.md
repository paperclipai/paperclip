# Capability Clean-Start Tutorial: Capability Contract, Mock Control Plane, and Scenario Explorer

**Time to first success: about 5 minutes.** Two commands take you from a clean
checkout to 106 passing conformance cases and a browser you can click through.
The whole tutorial runs from the repository root. It starts no Paperclip
service, contacts no Paperclip control plane, clones no external eval
repository, and holds no provider credential. Everything it needs is checked in
under `packages/paperclip-runner/`.

Capability does not integrate the runner into Paperclip. It builds a package-local
model of what a native Paperclip run *would* do — a deterministic mock control
plane, a transport-neutral semantic tool catalog, an authorization engine, a
106-case conformance suite derived from the Paperclip Evals corpus, and a
read-only browser explorer over all of it. Real integration is future upload integration and
requires separate approval. See
[the future binding boundary reference](../capability-future-binding-boundary.md).

## What you need

- Node.js 20 or newer and pnpm 9 or newer. This tutorial was verified with Node
  22.22.2 and pnpm 9.15.4.
- No Rust toolchain. Every command in this tutorial is TypeScript/Node only. (A
  full `verify` still builds Rust, but nothing here does.)
- No network access after `pnpm install`.

Install the package workspace from the repository root:

```sh
pnpm install --filter @paperclipai/paperclip-runner --lockfile=false --offline --ignore-scripts --dev
```

## 1. Prove the 106-case conformance suite (about 1 minute)

```sh
pnpm --filter @paperclipai/paperclip-runner test:capability-evals
```

This runs the eval-derived conformance suite entirely in-process against the
mock control plane. Expected final line:

```
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

The single test file drives all 106 cases across the 16 eval groups. To see the
per-group counts, assertion classes, the fake-agent operation matrix, and the
bounded Codex binding sample, generate the parity report:

```sh
pnpm --filter @paperclipai/paperclip-runner report:capability-evals
```

Expected final line:

```
Capability eval conformance passed: 106 cases across 16 groups.
```

The report is written to
`.paperclip-local/evidence/capability/eval-parity-report.{json,md}`. It is a
generated-on-demand artifact, not a committed file; a clean checkout does not
contain it. Delete it before you run `pnpm --filter @paperclipai/paperclip-runner docs:validate`
(the report carries no OKF frontmatter and would otherwise fail the knowledge
bundle check — see [Known gaps](#known-gaps-and-boundaries)).

The 16 groups and case counts are fixed by the capability contract:

| Group | Cases | Group | Cases | Group | Cases | Group | Cases |
| --- | ---: | --- | ---: | --- | ---: | --- | ---: |
| hb | 5 | co | 6 | st | 8 | cm | 6 |
| se | 4 | su | 4 | bl | 5 | dp | 3 |
| ix | 9 | ap | 6 | ar | 4 | er | 9 |
| rf | 22 | mh | 4 | rs | 3 | wk | 8 |

## 2. Open the scenario explorer (about 2 minutes)

```sh
pnpm --filter @paperclipai/paperclip-runner demo:scenarios
```

Open `http://127.0.0.1:4183/scenario-explorer/`. The explorer is read-only. It
runs each scenario in the browser against the same mock control plane and
renders the run artifact; it never re-judges parity and never leaves its own
origin. Walk this path:

1. **Home.** Confirm 16 group facets whose counts sum to 106.
2. **Pick a scenario.** Filter to `ap` and open `ap-mcp-gate-01`. The
   authorization view shows a deny row and a "1 deny" tab chip; the typed
   denial card carries no task data.
3. **Read a heartbeat.** Open `hb-context-01`. The control-plane checkout entry
   is labelled "no agent tool exists for this" — it is control-plane-owned, not
   a semantic tool.
4. **Inspect a manager scenario.** Open `rf-api-mgr-heartbeat-01`. Optional
   tools are listed with the grant that unlocked them, alongside the
   control-plane "no tool" list and a traceability panel.
5. **Confirm the credential boundary.** Codex mode is a disabled option with a
   stated reason. `localStorage` holds no run artifact or grant, and the page
   makes no request beyond its own assets.

The explorer imports the frozen `0.1.2` SDK through the package-local
`@paperclip-runner-local/capability` alias — deliberately not the published package
name. See [the browser explorer reference](../capability-scenario-explorer.md).

## 3. Read what each surface guarantees

The explorer renders four surfaces produced by the runtime. Each has a
package-local reference page:

- [Capability disposition](../capability-disposition.md) — how every
  skill/reference behavior and eval case is classified as control-plane-owned,
  always-agent-tool, or optional-agent-tool, and how the generated contract is
  produced and checked.
- [Mock ControlPlanePort](../capability-mock-control-plane-port.md) — the
  deterministic in-memory adapter, its entity domains, and its boundary.
- [Semantic tool catalog](../capability-semantic-tools.md) — the
  transport-neutral tools an agent may call.
- [Authorization and exposure](../capability-authorization-and-exposure.md) —
  grants, typed denials, and secret redaction.
- [Eval conformance](../capability-eval-conformance.md) — how the 106 cases are
  derived from the checked-in traceability derivative with no external repo.

## 4. Run the full focused verification set

Every command below is offline, deterministic, and package-local. The
[verification commands reference](../capability-verification-commands.md) lists
each one with its purpose and expected result.

```sh
# Capability contract: completeness, uniqueness, one-to-one MCP folds, no drift.
pnpm --filter @paperclipai/paperclip-runner check:capability-inventory
pnpm --filter @paperclipai/paperclip-runner test:capability-inventory

# Mock control plane adapter and shared ControlPlanePort conformance.
pnpm --filter @paperclipai/paperclip-runner exec vitest run \
  src/conformance/control-plane-port.test.ts \
  src/mock-core/capability-mock-control-plane-adapter.test.ts

# Semantic tool catalog and authorization/redaction engine.
pnpm --filter @paperclipai/paperclip-runner exec vitest run \
  src/tools/capability-semantic-tools.test.ts

# 106-case conformance and the parity/fake-agent/bounded-Codex report.
pnpm --filter @paperclipai/paperclip-runner test:capability-evals
pnpm --filter @paperclipai/paperclip-runner report:capability-evals

# Scenario runtime, explorer components, and route determinism (49 tests).
pnpm --filter @paperclipai/paperclip-runner test:scenarios

# Browser information architecture, accessibility, determinism, and boundary.
pnpm --filter @paperclipai/paperclip-runner test:browser:scenarios

# Deterministic 24-image screenshot acceptance set.
# Recorded evidence generation is deferred from this release.

# Documentation links.
pnpm --filter @paperclipai/paperclip-runner docs:validate
```

## Known gaps and boundaries

- **Reports are local.** `report:capability-evals` writes ignored output under
  `.paperclip-local/evidence/`; `docs:validate` does not scan it.
- **Codex mode is disabled.** The explorer offers a bounded real-Codex binding
  sample only through `report:capability-evals`; the browser holds no credential
  and the in-page Codex mode is inert with a stated reason.
- **No Paperclip integration.** Nothing here touches a real control plane,
  database, or provider. future upload integration (ACPX) binds the real adapter behind the same
  seam and requires separate CTO approval.

## Where this sits

- Plan: Capability plan, issue `TASK-16897` (see its `#document-plan` document).
- Child issues: 7A capability inventory (TASK-16898), 7B UX map (TASK-16899),
  7C mock adapter (TASK-16900), 7D semantic tools and authorization (TASK-16901,
  security gate TASK-16902, remediation TASK-16909), 7E conformance suite
  (TASK-16903), 7F browser explorer (TASK-16904, UX gate TASK-16905), 7G docs and
  evidence (TASK-16906), 7H clean-room QA (TASK-16907), Capability checkpoint
  (TASK-16908).
