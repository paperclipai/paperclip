# SDK Browser SDK and Reference Console

## Public package surface

SDK freezes the browser SDK as package version `0.1.2`.

Version `0.1.1` adds direct chat mode. The browser sends the operator message
as plain Codex input. The protocol inspector still shows the event stream,
reducer state, requests, and replay data. The Codex task fixtures remain
available from the session controls.

Version `0.1.2` adds the canonical events for each transcript item to the
optional `debugEvents` projection. `ToolItem` renders these events inside a
nested `Debug details` disclosure. Completed Terminal rows stay folded by
default, while operators can inspect command input, output, provider items,
delta updates, event ids, sequence numbers, and timestamps. Long chat and
command content wraps at mobile widths without horizontal page scrolling.

| Import | Purpose |
| --- | --- |
| `@paperclipai/paperclip-runner` | Protocol, reducer, and existing package contracts |
| `@paperclipai/paperclip-runner/browser` | Framework-free HTTP/SSE client, protocol types, transcript projection |
| `@paperclipai/paperclip-runner/react` | Hook, reference console, and reusable React components |
| `@paperclipai/paperclip-runner/styles.css` | Scoped light-theme token and component styles |

React and React DOM are peer dependencies. The extracted surface adds no
runtime dependency. It is client-only: it uses `window`, `sessionStorage`,
Fetch, and EventSource, so applications must mount it in the browser rather
than render it on the server.

## Framework-free client

```ts
import { createRunnerClient } from "@paperclipai/paperclip-runner/browser";

const client = createRunnerClient({ baseUrl: "/api/liveConsole" });
const manifests = await client.fetchManifests();
```

`RunnerClient` exposes manifest listing; session create/read/close; event
history and SSE streaming; turn start, steering, and interrupt; typed request
resolution; goal operations; and reconnect. `RunnerClientError` preserves the
HTTP status, stable error code, and redacted server message.

The protocol server remains authoritative. The browser client never creates a
second event model, invents capabilities, changes run/session/provider
identities, or removes duplicate events before the shared reducer sees them.

## React hook

```tsx
import { useRunnerConsole } from "@paperclipai/paperclip-runner/react";

function Console() {
  const runner = useRunnerConsole({ baseUrl: "/api/liveConsole" });
  return <p>{runner.connection}: {runner.replayParity ? "match" : "waiting"}</p>;
}
```

`useRunnerConsole` returns manifests and selection, canonical server state,
the exact event list, reducer snapshot, transcript projection, connection and
retry state, composer state, steering acknowledgements, a single polite
announcement channel, errors, busy state, lineage selection, replay controls,
and verbs for every supported mutation. Durable history is re-read before a
reconnected stream opens. Replay uses the same reducer as live state.

## Components

The `./react` export includes:

- primitives: `Button`, `Badge`, `Card`, `Textarea`, `Tabs`, `Menu`, `Dialog`,
  `Tooltip`, and `Banner`;
- protocol views: `Conversation`, `Message`, `ReasoningItem`, `ToolItem`,
  `RequestCard`, `SessionTimeline`, `Inspector`, `ReplayControls`, and
  `ConnectionBanner`;
- composition: `Composer`, `RunnerConsoleApp`, and `useRunnerConsole`.

Components take reducer/protocol shapes. Every component owns a stable
`data-slot` and `pcr-` class. Terminal, file, tool, plan, request, failure,
lineage, goal, connection, and replay states come only from canonical events
or public session state.

The reference server has two driver modes behind the same HTTP/SSE contract.
Deterministic manifests use `LiveConsoleScriptedDriver`. Real chat mode uses
`CodexAppServerDriver`, which starts a real local `codex app-server` process.
The Node server owns provider authentication and the disposable working
directory; browser code receives only canonical runner events.

## Five extension points

These are the complete extension surface for `0.1.2`:

1. `Conversation`, `Message`, `ReasoningItem`, and `ToolItem` accept
   `renderItemBody(item)` for markdown, highlighting, or another item body.
2. `RequestCard` accepts `renderRequestDetail(request)` for its detail region.
3. `Composer` accepts `leadingActions` and `trailingActions`.
4. Consumers may override `--pcr-*` properties under `.pcr-root`.
5. `createRunnerClient` and `useRunnerConsole` accept `baseUrl`, `fetchImpl`,
   and `eventSourceFactory` transport injection.

There is no headless distribution, component registry, render-prop shell,
dark theme, toast layer, or virtualized transcript in this version.

## Transport and credential boundary

```tsx
const runner = useRunnerConsole({
  baseUrl: "/runner",
  fetchImpl: (input, init) => fetch(input, {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init?.headers)), "x-app-session": appSession },
  }),
  eventSourceFactory: (url) => new EventSource(url),
});
```

Transport injection is for browser-to-protocol-server authentication, proxies,
and test doubles. Provider credentials stay on that server. Do not place a
provider bearer token in component props, manifest text, events, diagnostics,
browser storage, or an EventSource query string. The package demo fixes and
validates its workspace server-side and redacts provider paths and credentials.

## Tokens and contrast

`styles.css` declares a light-only `color-scheme` and all visual values under
`.pcr-root`. The shipped foreground/surface pairs are:

| Foreground | Surface | Contrast |
| --- | --- | ---: |
| `--pcr-foreground` | `--pcr-background` | 16.4:1 |
| `--pcr-card-foreground` | `--pcr-card` | 17.6:1 |
| `--pcr-primary-foreground` | `--pcr-primary` | 15.6:1 |
| `--pcr-muted-foreground` | `--pcr-muted` | 5.0:1 |
| `--pcr-success` | `--pcr-success-surface` | 6.5:1 |
| `--pcr-warning` | `--pcr-warning-surface` | 5.4:1 |
| `--pcr-danger` | `--pcr-danger-surface` | 6.2:1 |
| `--pcr-accent` | `--pcr-accent-surface` | 5.5:1 |

When a consumer overrides either side of a pair, that consumer owns a new
contrast check. Keep normal text at 4.5:1 or better. Motion respects
`prefers-reduced-motion`. All mobile controls use the `--pcr-touch-target`
minimum.

Minimum supported widths are 320px for `Conversation`, `Composer`, and
`Inspector`, and 280px for `RequestCard`. `RunnerConsoleApp` renders one
responsive tree: three panes above 900px and one selected pane below it.

## Keyboard and accessibility contract

- The transcript is a labelled `role="log"`; consumers render the hook's
  `announcement` once in an `aria-live="polite"` region.
- Composer Enter sends or steers; Shift+Enter adds a line. Stop remains a
  separate button.
- Tabs use arrow-key roving focus plus Home/End.
- Menu supports Enter/Space/ArrowDown, arrows, Home/End, and Escape with focus
  restoration.
- The native dialog traps focus, closes on Escape, and restores its trigger.
- Reasoning and tool disclosures use native summary keyboard behavior.
- Replay Left/Right steps; Space toggles play from the scrubber.
- Status is always named in text, not communicated by color alone.
- Informational banners do not steal focus. A blocking reconnect failure may.

## Reference applications

`examples/reference-console/` composes `RunnerConsoleApp` only from public
exports. `examples/mini-consumer/` imports only the three public SDK subpaths
and visibly exercises every extension point. Both run against the package fake
driver or the real Codex driver through the same server-only adapter.

See the [hand-run tutorial](tutorials/sdk-console.md) and the
[implementation decision record](design/sdk-component-decisions.md).
