# SDK Extraction Decision Record

Date: 2026-08-08
Status: implemented

## Outcome

The accepted Live console transport and reducer contracts were copied into a
versioned `0.1.2` public surface. The reference console and a deliberately
small second consumer import only public package subpaths. Live console and the
Replay–3 surfaces remain the comparison baseline.

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
- The compact layout keeps the transcript and composer as the primary view.
  A single accessible Menu opens session controls or the protocol inspector in
  a modal panel; secondary controls never replace or duplicate the chat tree.
- A real provider may explicitly disable goals. The consumer gates buttons on
  that capability and preserves the upstream diagnostic instead of emulating
  a goal.
- Real-provider steering timing is not a stable visual fixture. Fake-driver
  tests own race coverage; a safe real completion owns transport, identity,
  redaction, reconnect, and replay evidence.
- Minimal hosts may lack Playwright shared libraries. The package rootless
  helper runs the same browser commands from a run-owned cache.
- Assistant text uses the canonical reducer text but reveals queued additions
  progressively at the character level. Reduced-motion clients receive the
  complete current text immediately; protocol events and replay stay unchanged.
- A completed assistant item that contains a semantic result JSON object shows
  its summary and disposition as the primary agent response. Completion checks,
  remaining work, and the exact protocol JSON stay behind a `Completion details`
  disclosure, while the protocol inspector continues to expose the full event
  record.
- Transcript follow mode anchors the latest settled assistant response instead
  of terminal or diagnostic events appended after it. The complete ordered
  transcript remains available below the response, and manual scrolling still
  disengages follow mode.

## Compatibility rule

`0.1.2` is the current frozen SDK surface. Any later removal or semantic change
to an export, hook field, component prop, `data-slot`, extension point, or
token needs a versioned compatibility decision. Additive protocol fields stay
forward-compatible; the schema and shared reducer remain authoritative.

## Direct chat presentation

The reference console opens in a normal Codex chat mode. This mode sends plain
user text and permits follow-up turns in the same provider thread. It does not
add the Codex task envelope, semantic completion tools, or output schema.

The workspace sandbox and server-only provider authentication stay active.
The deterministic Codex fixtures remain selectable for protocol tests. The
chat layout removes decorative panel outlines and keeps the protocol inspector
available on demand. The header includes a package version and an iteration
emoji so a reviewer can identify the deployed build.

## Terminal diagnostics and responsive wrapping

`TranscriptItemEntry.debugEvents` is an additive, optional projection of the
canonical item events already retained by the client. `ToolItem` shows this
data in a nested folded disclosure rather than inventing a second diagnostic
model. Long commands, payloads, and assistant text wrap within the center
column; mobile layouts keep every transcript descendant intrinsically
shrinkable so the page does not gain a horizontal scrollbar.
