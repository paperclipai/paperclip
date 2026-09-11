# Runner activity review

Open **Tasks / Runner activity preview / 01 · Desktop live · animated** in Storybook.
Use Pause / Next to step through the fixture, or Replay to watch the transitions.

From this worktree, start the preview with:

```sh
pnpm --filter @paperclipai/ui exec storybook dev --port 6024 --host 127.0.0.1 --no-open -c storybook/.storybook
```

- Each commentary message stays on the page and starts a new activity group.
- Compact groups retain one latest activity row. A new logical item rolls up;
  updates to that same item's status do not replay the transition.
- The count and chevron expand that group into chronological history. An expanded
  group stays expanded when new activity arrives. Collapse returns to its latest row.
- Expanded rows also stay on one line: label and target sit side by side,
  with long targets truncated. Click a row to inspect its full target and detail.
  Icon slots are centered,
  identically sized, and aligned without nested rails or indentation.
- Separate stories cover light, mobile, long paths, full icon alignment, and
  failures. Failures use neutral text, with no red styling or X icon.
- Desktop stories explicitly reset the viewport so visiting Mobile first does
  not leave the desktop animation squeezed into a mobile preview.
- Reduced motion uses immediate replacement instead of the rolling transition.

The fixture renders the production `TaskChatRunnerTurn` and activity group, with
simulated event timing. It does not invoke a runner. Production integration tests
cover commentary boundaries, approvals, final replies, retained expansion,
neutral failures, and reduced motion.
