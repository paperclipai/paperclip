# Phase 5 SDK Extraction Decision Record

Date: 2026-08-08
Status: implemented from the approved [Phase 5 component plan](phase-5-component-plan.md)

## Outcome

The accepted Phase 4b transport and reducer contracts were copied into a
versioned `0.1.0` public surface. The reference console and a deliberately
small second consumer import only public package subpaths. Phase 4b and the
Phase 1–3 surfaces remain the comparison baseline.

## Promoted contracts

The implementation promotes the framework-free client, `useRunnerConsole`,
all approved primitives and protocol views, and `RunnerConsoleApp`. Reducer
state and canonical events remain the only rendering authority. File, tool,
plan, terminal, failure, request, goal, lineage, connection, and replay views
do not maintain private protocol state.

The package exports `.`, `./browser`, `./react`, and `./styles.css`. React and
React DOM are peers; the surface adds zero runtime dependencies.

## Extension surface

The implementation has exactly the five approved extension points:

1. item-body renderer;
2. request-detail renderer;
3. Composer leading and trailing slots;
4. scoped `--pcr-*` token overrides;
5. Fetch/EventSource/base-URL transport injection.

The mini consumer demonstrates all five. No new extension registry or
headless contract was added during implementation.

## Kept out

Markdown `Response`, highlighted `CodeBlock`, a persistent Context meter, a
command palette, headless distribution, dark mode, Tailwind/Radix, toasts,
and transcript virtualization remain rejected for the reasons in the approved
plan. Default text and `<pre>` output keeps protocol evidence inspectable;
consumers can opt into rich item bodies through the one renderer contract.

## Implementation findings

- Event IDs must not be deduplicated by the hook. Exact duplicate delivery is
  reducer input, so the shared reducer remains the sole duplicate authority.
- Node types are required only for browser-test and Vite configuration. They
  are not part of the browser runtime or public dependency surface.
- Token enforcement must inspect CSS custom-property definitions as well as
  component usage. The `pcr-` namespace is enforced across SDK sources.
- The reference console renders one React tree selected at the 900px
  breakpoint. Rendering two trees would duplicate landmarks, test IDs, and
  live regions.
- A real provider may explicitly disable goals. The consumer gates buttons on
  that capability and preserves the upstream diagnostic instead of emulating
  a goal.
- Real-provider steering timing is not a stable visual fixture. Fake-driver
  tests own race coverage; a safe real completion owns transport, identity,
  redaction, reconnect, and replay evidence.
- Minimal hosts may lack Playwright shared libraries. The package rootless
  helper runs the same browser commands from a run-owned cache.

## Compatibility rule

`0.1.0` is the first frozen SDK surface. Any later removal or semantic change
to an export, hook field, component prop, `data-slot`, extension point, or
token needs a versioned compatibility decision. Additive protocol fields stay
forward-compatible; the schema and shared reducer remain authoritative.
