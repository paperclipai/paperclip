# Live console Live Console

## Scope

This is the browser layer of Live console. It adds a **Live console** mode to the
existing standalone devtool in `devtools/browser/`. It builds on the
[protocol and demo server](live-console-protocol-server.md) and follows the
approved [interaction map](design/live-console-interaction-map.md) and
[component decision record](design/live-console-component-decisions.md).

Every file lives under `packages/paperclip-runner/`. The console does not
import or change Paperclip server, UI, database, or control-plane code.

## Start it

```sh
pnpm --filter @paperclipai/paperclip-runner console:live-console
```

Then open `http://127.0.0.1:4180/` and choose **Live console**.

Live console is deliberately loopback-only. A wildcard or LAN `--host` fails
startup because this developer console can start provider-backed turns and
resolve approvals. There is no unauthenticated remote mode.

Two environment variables change the driver behind the console:

| Variable | Default | Effect |
| --- | --- | --- |
| `PAPERCLIP_LIVE_CONSOLE_DRIVER` | `demo` | `codex` starts the real `codex app-server` driver behind the same routes |
| `PAPERCLIP_LIVE_CONSOLE_CHUNK_DELAY_MS` | `45` | Milliseconds between streamed chunks in the demo driver |

## Where state comes from

The console has one data contract: the canonical PRP event stream and the
`SessionSnapshot` the shared reducer produces from it. There is no second event
model, no message store, and no client-side session cache.

- The browser reduces the events it receives with the same
  `applyPrpEvent` the server and the CLI use, so a live session and a replayed
  session project identically. The inspector's **Session** tab reports that
  comparison as `match` or `mismatch`.
- Transcript order is the reducer timeline order. Nothing is re-sorted.
- Lineage, goal state, pending requests, and the durable cursor come from the
  demo server's public state, which is refreshed whenever new events arrive.
- The steering chip is the only local UI intent. It resolves to
  `acknowledged`, `rejected`, or `failed` from canonical facts and never
  merges text into the transcript before an acknowledgement.

## Surfaces

| Surface | Source of truth | Notes |
| --- | --- | --- |
| Transcript | reducer timeline and items | user messages come from `turn.submitted` payload text |
| Composer | composer state machine | one visible primary action: Send, Steer, or Stop |
| Steering chip | `steering_acknowledgement` item or a rejection code | rejected text stays recoverable with **Send as new message** |
| Request card | `runtime_request.*` events | renders only the actions the upstream request offers |
| Goal banner and menu | capability snapshot and goal events | unsupported verbs are disabled with the exact diagnostic |
| Lineage tree | driver thread lineage | child steering is shown as unsupported, never emulated |
| Connection block | transport status and durable cursor | includes a deliberate connection-loss control |
| Inspector | raw canonical events | four tabs: Events, Requests, Capabilities, Session |
| Replay stepper | recorded canonical events | marked with a `REPLAY` eyebrow badge |

## Interruption races

The console distinguishes all three races the spec requires:

| Race | What the console shows |
| --- | --- |
| interrupt before start | the pending turn resolves to `Cancelled before start`; no assistant item is ever created |
| interrupt during generation | the stream stops in place, the partial text stays, and an interrupted divider is added |
| interrupt during a tool call | the tool item keeps its last known status with no fabricated result |

`Escape` in the composer moves focus to **Stop**. It never interrupts
directly, because a destructive action needs an explicit activation.

## Demo chats

The demo server owns the manifest catalogue and serves it at
`GET /api/liveConsole/manifests`. Each manifest names the scenario it proves and
the observations a human should confirm; the console renders that list as a
checklist rather than restating it in the UI.

| Manifest | Proves |
| --- | --- |
| `completion` | streaming, reasoning, tool, answer, structured result |
| `steering` | same-turn steering acknowledgement and stale-turn rejection |
| `interrupt-before-start` | cancellation before the provider accepts the turn |
| `interrupt-during-generation` | preserved partial text |
| `interrupt-during-tool` | preserved tool status with no fabricated result |
| `approvals` | command and file-change approvals, single-response guarantee |
| `user-input` | typed answers and request expiry |
| `subagents` | parent/child lineage and unsupported child steering |
| `goals` | set, view, pause, resume, clear |
| `goals-unsupported` | exact capability diagnostic instead of a hidden control |
| `failure` | failed item and failed turn inside the record |

Manifests run in any order. **Reset demo state** names exactly what it
discards and leaves recorded evidence files untouched.

## Credentials

No provider or Paperclip credential reaches the browser. The Node process owns
the driver, the working directory, and any provider login. Every JSON and event
frame passes the demo server's redaction layer, and the inspector renders
redaction markers verbatim without attempting to reconstruct them.

The live console and standalone server share one transport admission guard:
exact loopback Host/port, loopback sockets, same-origin Origin and Fetch
Metadata, plus JSON-only mutations. Browser reset closes the server session;
active sessions and SSE subscribers are hard-capped. Local untrusted processes
remain a residual risk, and the Codex sandbox/approval policy is the final
execution boundary.

## Components

Adapted from shadcn/ui and Vercel AI Elements **source**, rewritten in the
package's local idiom, with zero new runtime dependencies:

- AI Elements: `conversation`, `message`, `composer`, `reasoning-item`,
  `tool-item`.
- shadcn/ui: `tabs`, `menu`, `dialog`, `tooltip`, `banner`.

`scripts/check-forbidden-imports.mjs` fails the build if anything under
`devtools/browser/` imports `ai`, `@ai-sdk/*`, `zod`, `radix-ui`, `cmdk`,
`streamdown`, `shiki`, `use-stick-to-bottom`, `class-variance-authority`,
`tailwindcss`, or `nanoid`. `scripts/check-browser-tokens.mjs` fails if a
component file carries a raw colour, pixel, or font value.

## Verification

```sh
pnpm --filter @paperclipai/paperclip-runner exec vitest run \
  src/mock-core/live-console-scripted-driver.test.ts \
  src/mock-core/live-console-demo-server.test.ts \
  devtools/browser/src/live/transcript-model.test.ts
pnpm --filter @paperclipai/paperclip-runner test:browser
pnpm --filter @paperclipai/paperclip-runner check:browser-tokens
pnpm --filter @paperclipai/paperclip-runner check:forbidden-imports
```

See the [tutorial](tutorials/live-console.md).
