# Runner activity review

Open **Tasks / Runner activity preview / 01 · Desktop live · animated** in Storybook.
Compare **05 · Legacy live · animated**, which uses the actual legacy live renderer.
Use Pause / Next to step through the fixture, or Replay to watch the transitions.

From this worktree, start the preview with:

```sh
pnpm --filter @paperclipai/ui exec storybook dev --port 6024 --host 127.0.0.1 --no-open -c storybook/.storybook
```

- Each commentary message stays on the page and starts a new activity group.
- Active compact groups retain one latest activity row. A new logical item rolls up;
  updates to that same item's status do not replay the transition.
- The count and chevron expand that group into chronological history. An expanded
  group stays expanded when new activity arrives. Collapse returns to its latest row while active, or a short action summary once finished.
- Expanded rows also stay on one line: label and target sit side by side,
  with long targets truncated. Click a row to inspect its full target and detail.
  Icon slots are centered,
  identically sized, and aligned without nested rails or indentation.
- Separate stories cover light, mobile, long paths, full icon alignment, and
  retries. Failures use neutral text inside history, with no red styling, X icon, or failure count.
- Desktop stories explicitly reset the viewport so visiting Mobile first does
  not leave the desktop animation squeezed into a mobile preview.
- Reduced motion uses immediate replacement instead of the rolling transition.

Native stories render `TaskChatRunnerTurn`. Live legacy stories feed raw CLI
transcript events through `transcriptToTaskChatItems` into `TaskChatLiveTail` and
`TaskChatLiveRunPill`. Both use the same production activity group. Legacy stories
cover live playback, expanded history, narrow long labels, light mode, and completed
turns. Only the completed story uses the saved-thread renderer from the start.

Event timing is simulated; the fixture does not invoke a runner. Production integration tests
cover commentary boundaries, approvals, final replies, retained expansion,
neutral failures, and reduced motion.
