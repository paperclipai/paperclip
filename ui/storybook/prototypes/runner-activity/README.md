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

This is a local presentation fixture. It reuses the shipped tool vocabulary,
Markdown renderer, agent identity, buttons, and design tokens. It does not change
the production task feed or invoke a runner. After design review, the selected
behavior can be integrated into the existing task-chat components.

## Review verification

- UI typecheck, token gates, and the Storybook production build pass.
- Browser walkthrough: compact groups stay 32 CSS pixels tall while their
  current item changes; expanded groups keep their history when Next is pressed.
- Measured icon centers match row centers exactly in both compact rows and
  expanded rows. No horizontal row overflow in the
  narrow fixture. Light and dark previews were visually reviewed.
- Keyboard Enter expands a group, and tool details open independently.
- This review does not qualify the production runner integration; that comes
  after selecting the presentation.
