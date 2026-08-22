# Phase 5: Run the SDK Console and Mini Consumer

## What this phase is

Phase 5 makes the accepted browser tracer reusable. It has a browser client,
a React hook, reusable components, one reference console, and one small second
consumer.

The two apps use public package imports. They do not import the old demo UI.
Provider credentials stay in the local server.

## What this phase proves

This tutorial proves that a second app can use the SDK without a private
import. It also proves that live events and replay events reduce to the same
state. You can run every hard state with the fake driver. You can then run a
safe turn with your real local Codex login.

Run commands from the repository root.

## 1. Run the small SDK tests

```sh
pnpm --filter @paperclipai/paperclip-runner test:phase5
pnpm --filter @paperclipai/paperclip-runner check:browser-tokens
pnpm --filter @paperclipai/paperclip-runner check:forbidden-imports
```

These tests check reducer parity, components, tokens, and package boundaries.

## 2. Open both apps with the fake driver

```sh
pnpm --filter @paperclipai/paperclip-runner console:phase5
```

Open these pages:

- `http://127.0.0.1:4181/reference-console/`
- `http://127.0.0.1:4181/mini-consumer/`

The fake driver is the default. It does not need a provider login.

## 3. Check the reference console

Use the manifest list. Run these flows:

1. Run **Completion**. Read the streaming and terminal messages.
2. Run **Same-turn steering**. Type a new message while the turn is active.
   The button says **Steer**. Check the acknowledgement.
3. Run each interrupt flow. Confirm that the visible outcome names the race.
4. Run **Command and file approvals**. Resolve one request. Confirm that the
   card locks after the first click and later shows the canonical result.
5. Run **Goal lifecycle**. Set and clear the goal from the Goal menu.
6. Press **Drop connection**. Watch reconnect and gap recovery use the same
   session.
7. Enter replay. Step with Left and Right. Confirm the inspector says the
   replay matches live state.
8. Run **Item and turn failure**. Confirm that the exact server diagnostic is
   part of the transcript.

Resize the browser to 390 by 844. The app must show one pane at a time. It must
not create a second hidden transcript or a horizontal page scrollbar.

## 4. Check the mini consumer

The mini app is intentionally small. Run a turn, steer it, stop it, resolve a
request, set and clear a goal, drop the connection, and enter replay.

Look for these proof points:

- **Mini renderer** shows the custom item-body renderer.
- **Mini detail** shows the custom request-detail renderer.
- Set goal and Clear goal use the two Composer slots.
- The blue accent is a local `--pcr-*` token override.
- Fetch and EventSource are injected by the app.
- **Replay parity: match** appears after durable history is complete.

If the real driver says goals are unavailable, the two goal buttons stay
disabled. This is correct. The SDK must not pretend the provider supports a
feature.

## 5. Run the browser acceptance tests

On a machine with Playwright system libraries:

```sh
pnpm --filter @paperclipai/paperclip-runner test:browser:phase5
```

On a minimal Debian or Ubuntu machine without root access:

```sh
cd packages/paperclip-runner
bash scripts/verify-rootless-linux.sh pnpm run test:browser:phase5
```

This runs keyboard, accessibility, reconnect, gap-recovery, replay, fake
driver, viewport measurement, and screenshot checks.

## 6. Run a real Codex session

Use a machine where the local Codex CLI is already authenticated.

```sh
cd packages/paperclip-runner
bash scripts/verify-rootless-linux.sh pnpm run record:phase5:codex
```

The test runs a safe completion through both public consumers. It checks that
the browser contains no bearer token or `auth.json` path. The mini consumer
then drops and reconnects the transport, enters replay, and confirms parity.

Real provider timing is not used to prove every race. The deterministic fake
driver proves steering, interrupt, requests, and goal branches. The real run
proves the same public transport and identity boundary against Codex.

## 7. Run the package acceptance command

```sh
pnpm --filter @paperclipai/paperclip-runner verify
```

Use `verify:rootless` if the host needs package-local browser libraries.

## Expected result

All commands exit with status 0. The fake and real apps use public imports.
Reconnect keeps run, session, and provider identity. Replay reports `match`.
Provider credentials do not appear in browser state, DOM text, events, or
diagnostics.
