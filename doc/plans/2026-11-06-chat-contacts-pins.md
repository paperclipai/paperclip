# Chat contacts and pinned navigation

Restore the full agent contact directory in Chat, with avatars, names, roles,
search, unread counts and a shortcut to the existing create-agent dialog.
The chat header spans the directory and conversation. It uses the standard
CHAT section heading and retains the shared properties control.

Agent pins are available in the contact directory and Agents list. A pin opens
the existing direct-chat route. Personal page and agent pins share one ordered
Pinned section. Pointer and keyboard sorting preserve the stored order without
removing pins hidden by a company switch. The drag grip sits after unpin.
Hover and focus controls share the highlighted row surface. The fade masks only
the text behind the control.

Recents uses agent avatars and names for direct chats. It retains the full task
history and fills the available navigation height above the account control.
The heading stays outside its scroll area. Only clipped edges fade. Task-summary
refreshes retain the server's small request limit and publish a complete result,
so a failed request cannot prune unrelated history.

Inbox task rows use bold unread titles without blue dots in both retained
layouts. The All tasks default and saved view behavior already exist on the
current base branch and remain in place.

Group chat stays in a separate follow-up. This change contains no group-chat
schema, routes, discussion worker, approval flow, picker or conversation page.

## Verification

Use the directory, sidebar, breadcrumb, task-row and history tests. Run the UI
typecheck, build and token gates. Verify mouse and keyboard pin sorting,
create-agent dialog access, full-width search and header, and overflow at both
Recents edges. Use both long and short viewports. Preserve existing unread-chat
counts and account/company boundaries.

An early row-wide drag allowed native link navigation after sorting. A dedicated
grip and prevention of native link dragging fixed it. The regression failed
before the fix and passed afterward. Long-history tests also check that a failed
summary chunk retains all snapshots.

## Review corrections

Reserve separate space for unread badges and pin actions, including touch input.
Unread rows do not fade text that the pin no longer covers. Build pin sets and
item maps once per list, keep their inputs stable, and share pin state across
agent rows. Large-list regressions count input reads and pin parsing for five
hundred agents and pins. Reordering retains hidden-company slots. Task history
also uses indexed summary lookups now that it is no longer capped at five rows.
