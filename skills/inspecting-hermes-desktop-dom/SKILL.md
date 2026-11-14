---
name: inspecting-hermes-desktop-dom
description: >
  Read the live Hermes desktop DOM/CSS
  over Chrome DevTools Protocol.
---

# Inspecting Hermes Desktop DOM Skill

Read the live rendered DOM of a running Hermes desktop window — computed styles,
geometry, winning CSS rules, and renderer console output — instead of inferring
them from `.tsx` source. Dev-server runs open a Chrome DevTools Protocol port on
`127.0.0.1:9222` automatically. This answers factual questions only; aesthetics
still need the user's eyes or a screenshot.

## When to Use

- Verifying a UI change actually took effect in the running app
- "Why is this element still X?" — find the winning rule before editing anything
- Locating a stable selector for a component you're about to change
- Checking a design token's computed value on a real node
- Reading renderer console errors the user mentions but can't copy out

**Don't use for:** perf profiling or heap work (`node-inspect-debugger`,
`debugging-and-error-recovery`), or anything where the real question is "does
this look right".

## Prerequisites

- A dev-server run is active (`hgui` / `npm run dev` in `apps/desktop`), which
  opens the CDP port on `127.0.0.1:9222` by default.
- `HERMES_DESKTOP_CDP_PORT` overrides the port (`=9333`) or disables it
  (`=off`).
- Packaged builds close the CDP port always; no environment value overrides it.

## How to Run

Check the port before doing anything else:

```bash
curl -s --max-time 3 http://127.0.0.1:${HERMES_DESKTOP_CDP_PORT:-9222}/json/version
```

Empty response means no port — do not guess another port silently. Never relaunch
the user's app to get a port; that destroys their session and state.

For a one-off DOM query, use `apps/desktop/scripts/eval.mjs`:

```bash
cd apps/desktop
node scripts/eval.mjs "document.querySelectorAll('[data-slot]').length"
```

For multi-step work, use the shared CDP client from `scripts/perf/lib/cdp.mjs`:

```js
import { CDP, SELECTORS } from './scripts/perf/lib/cdp.mjs'

const cdp = await CDP.connect({ port: 9222, match: '5174' })
const out = await cdp.eval(`JSON.stringify({
  radius: getComputedStyle(document.documentElement).getPropertyValue('--radius-scalar').trim(),
  composer: !!document.querySelector('[data-slot="composer-rich-input"]')
})`)
cdp.close()
```

`SELECTORS` holds the stable `data-slot` hooks (composer, thread viewport,
assistant message, turn pair, profile rail). Prefer them over inventing a
`querySelector` — they are updated as a unit when components move.

## Quick Reference

To read which CSS rule won on a real node:

```js
const el = document.querySelector('[data-slot="aui_assistant-message-root"] a')
JSON.stringify({
  ownClasses: el.className,
  weight: getComputedStyle(el).fontWeight,
  parents: (() => {
    const out = []
    let n = el
    while ((n = n.parentElement) && out.length < 6) out.push(n.className)
    return out
  })()
})
```

If the node carries no class of its own, the value is inherited — sweeping call
sites will not fix it. Override on the shared class, not at each usage.

## Procedure

When there is no port, or you must not disturb the user's window, launch your
own isolated instance:

```bash
cd apps/desktop
HERMES_HOME=$HOME/.hermes/cache/scratch/cdp-probe-home \
HERMES_DESKTOP_DEV_SERVER=http://127.0.0.1:5174 \
HERMES_DESKTOP_CDP_PORT=9333 \
  npx electron . --user-data-dir=$HOME/.hermes/cache/scratch/cdp-probe-userdata
```

The separate `--user-data-dir` dodges Electron's single-instance lock, so it
cannot collide with a running `hgui`; the separate `HERMES_HOME` keeps it away
from real sessions. Pick a port other than 9222 for the same reason. Run it in
the background and kill it when done.

`npm run perf:serve` does the same with a temp `HERMES_HOME` baked in, if you
also want the perf harness.

## Pitfalls

- Never kill the user's dev server or app to "free" anything. A mid-serve kill
  nukes Chromium's socket pool, and the resulting `ERR_NETWORK_CHANGED` gets
  blamed on whatever you just changed.
- A throwaway `HERMES_HOME` has no backend. The app logs `ECONNREFUSED` for
  `hermes:api` and may exit on its own. The renderer still mounts and the DOM is
  readable — read promptly, and don't mistake a self-exited probe for a broken
  port. Chromium logs `DevTools listening on ws://127.0.0.1:<port>/…` when it
  binds; that line is the proof the port opened.
- Poll, don't probe once. A just-launched app needs a second or two before the
  port answers.
- Never dump the whole DOM. The desktop renders hundreds of nodes and `outerHTML`
  will bury your context. Project down to a small JSON object inside the
  evaluated expression.
- Pass `match` to `CDP.connect`. Without it you may attach to the pet overlay,
  quick-entry window, or a devtools target instead of the main window.
- `cdp.eval` returns the value; raw `Runtime.evaluate` double-nests it
  (`.result.result.value`). Use the wrapper.
- `import.meta.env.DEV` is `true` under `vite dev` in this repo. The note in
  `apps/desktop/scripts/profile-typing-lag.md` claiming otherwise is stale.

## Verification

- `curl` to `/json/version` returns a non-empty JSON body with the CDP version.
- `DevTools listening on ws://127.0.0.1:<port>/…` appears in Chromium's logs when
  the port opens.
- `cdp.eval` returns a small JSON object, not the whole DOM outerHTML.
