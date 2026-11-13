# Live console: Run the Live Codex Protocol Console

## What this is

This tutorial runs the Live console browser console. The
[protocol demo server](live-console-protocol-server.md) tutorial used `curl`. This
one uses the real user interface.

## What this proves

The console shows one live session. You can chat with it, steer it, stop it,
answer its requests, change its goal, watch its child threads, break its
connection, refresh the page, and replay the whole record. Every screen reads
the canonical protocol. Nothing in the browser holds a provider login.

## Before you start

Run every command from the repository root. You do not need a Codex account
for this tutorial. The default driver replays deterministic demo chats.

## Step 1: Run the deterministic checks

```sh
pnpm --filter @paperclipai/paperclip-runner exec vitest run \
  src/mock-core/live-console-scripted-driver.test.ts \
  src/mock-core/live-console-demo-server.test.ts \
  devtools/browser/src/live/transcript-model.test.ts
```

Expected result: all three files pass. They cover the demo driver, the server
routes, and the pure transcript model the console renders.

## Step 2: Start the console

```sh
pnpm --filter @paperclipai/paperclip-runner console:live-console
```

Keep this terminal open. Open `http://127.0.0.1:4180/` in a browser and press
**Live console**.

Expected screen: an empty transcript that says
`Pick a demo chat or start a blank session`, a list of demo chats on the left,
and a disabled **Send** button.

## Step 3: Run one clean turn

1. Press **Completion** in the demo chat list.
2. Press **Run this demo chat**.

Expected facts:

- The connection badge says `connected`.
- Your own message appears first.
- A collapsed **Reasoning** block appears and opens while it streams.
- A **Tool** block shows its input and then its output.
- The answer streams into view with a blinking cursor.
- The turn ends with a `Turn completed` badge.

## Step 4: Steer a running turn

1. Press **Same-turn steering**, then **Run this demo chat**.
2. While the turn runs, the primary button says **Steer**.
3. Type `Keep it to one sentence.` and press Enter.

Expected facts:

- A steering chip appears as `pending` and then becomes `acknowledged`.
- The chip never merges into the answer before the acknowledgement.

Now type text while the turn is running, wait for `Turn completed`, and press
the button. The chip becomes `rejected — turn already ended` and offers
**Send as new message**. Your text is never discarded.

## Step 5: Stop a turn in three ways

Run each demo chat and press **Stop**:

| Demo chat | When to press Stop | Expected result |
| --- | --- | --- |
| Interrupt before start | right away | `Cancelled before start`, and no answer item is created |
| Interrupt during generation | while text streams | the stream stops, the partial text stays, and an interrupted divider appears |
| Interrupt during a tool call | while the tool runs | the tool keeps its last status and shows no result |

The session is never replaced. After a stop you can simply send again.

## Step 6: Answer requests

1. Press **Command and file approvals**, then **Run this demo chat**.

Expected facts:

- A blue banner above the composer says `1 request waiting — Review`.
- The command card offers **Approve**, **Approve for session**, **Reject**,
  and **Cancel**, because the request offers those four actions.
- After you press **Approve**, the whole action row locks until the resolved
  event arrives. A second click cannot answer twice.
- The resolved card collapses to one line that names the action you chose.
- The next card offers only **Approve** and **Reject**, because that request
  offers only two actions.

2. Press **User input and expiry**, then **Run this demo chat**.

Type an answer and press **Submit**. Leave the second request alone. After a
few seconds it becomes `expired before response` and stays in the record.

## Step 7: Change the goal

1. Press **Goal lifecycle**, then **Run this demo chat**.
2. Press **Goal**, then **Set goal…**, type an objective, and confirm.
3. Press **Goal**, then **Pause**.

Expected facts: the banner shows the objective, the state, and the time of the
last change. **Resume** is disabled while the goal is active, and **Pause** is
disabled while it is paused.

Now press **Goals unsupported** and run it. The **Goal** button is disabled,
not hidden, and it names the exact upstream reason:
`Goal operations unsupported: app-server 0.132.0 does not advertise the goals capability`.
Open the **Protocol inspector** and the **Capabilities** tab. The same string
appears there.

## Step 8: Watch child threads

Press **Parent and child threads**, then **Run this demo chat**.

Expected facts:

- The **Threads** panel lists the root session and two child threads.
- One child ends `Completed` and one ends `Failed`. Both stay in the tree.
- Selecting a child shows a breadcrumb and a disabled composer that says
  `Direct steering of child threads is not supported by this app-server.`

## Step 9: Break the connection and recover

1. Run any demo chat and wait for it to finish.
2. Press **Simulate connection loss**.

Expected facts: a banner says the connection was lost, and the composer is
disabled.

3. Press **Retry now**.

Expected facts: the badge returns to `connected` and the transcript is exactly
what it was before the drop. Nothing is lost and nothing is duplicated.

Now reload the page and press **Live console** again. The same session returns
with its full transcript.

## Step 10: Replay the record

Press **Replay**.

Expected facts: a `REPLAY` badge appears, the transcript resets, and a stepper
appears. Press **Step forward** to walk the session forward one event at a
time. Press **Play** to run it. Press **Exit replay** to return to live.

## Step 11: Inspect the protocol

Press **Protocol inspector**.

- **Events**: every canonical event with its sequence, type, and full payload.
  Filter by text or by event type.
- **Requests**: every runtime request with its lifecycle.
- **Capabilities**: what this app-server supports, with a reason for each
  unsupported row.
- **Session**: identities, cursors, gap state, and the live-versus-replay
  reducer comparison. It should read `match`.

Check the **Credentials in browser** row. It must read `no`.

## Step 12: Check the keyboard

- `Tab` reaches every control, including the inspector and the dialogs.
- `Enter` sends. `Shift` and `Enter` add a line.
- `Escape` while a turn runs moves focus to **Stop**. It never stops the turn
  on its own.
- Arrow keys move between inspector tabs and between threads.
- `End` jumps the transcript to the newest item.

## Step 13: Use the real Codex driver

This step needs a working Codex login on the machine.

```sh
PAPERCLIP_LIVE_CONSOLE_DRIVER=codex \
  pnpm --filter @paperclipai/paperclip-runner console:live-console
```

The routes and the screens are the same. The demo chat list still appears, but
the manifest only supplies the first message; the real model produces the rest.
The Codex login stays on the server.

## Step 14: Clean up

Stop the console with `Ctrl+C`. The server-owned working directory is a
temporary directory and is not part of your repository.

## Where to go next

- [Cumulative end-to-end tutorial](end-to-end.md)
- [Live console reference](../live-console.md)
- [Live console interaction map](../design/live-console-interaction-map.md)
