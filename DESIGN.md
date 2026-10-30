# Paperclip Design Principles

**Status:** v0.3 — anchor document for design-language simplification. Governs structure, not brand. Brand values (color, type, iconography) are intentionally unspecified: they are being redesigned and will land as token values only. Nothing in `ui/` may hardcode them. Spacing/radius scales are likewise TBD pending the token audit (see Principle 3).

Changes from v0.2: token layer location corrected to the repo's real source (`ui/src/index.css`); existing token tiers inventoried; snapshot-coverage scope bounded for Run 1; the issue→task copy rename moved out of the zero-visual-change run.

## What this document is for

Agents and humans modifying `ui/` treat this file as the source of truth for design decisions. Storybook is the verification surface — it documents the system; it does not define it. If a change conflicts with this document, change this document first (with review) or change the code.

## Product stance

Paperclip is an operational control plane: org charts, tasks, heartbeat runs, budgets, approvals, audit logs. The user is an operator scanning state and making decisions. Every screen should answer, in order: *what is happening, does it need me, what do I do about it.* Density in service of scanning beats whitespace in service of aesthetics — but density comes from information, never from chrome.

## The token layer (where visual values live)

The single token source is **`ui/src/index.css`** (Tailwind v4; there is no tailwind config file — tokens are CSS custom properties consumed via `@theme`). Do NOT create a parallel token source such as `ui/src/tokens/` — that would produce two sources of truth. If index.css grows unwieldy, extracted values may live in a `tokens.css` **imported by index.css** so the pipeline still has one root.

Tailwind v4 gotcha: `@theme inline` bakes literal values at build time. Any token that must be runtime-tunable (theme editor, dark mode overrides) must be defined in a NON-inline block.

Existing tiers already in index.css (~80+ tokens) — extraction maps to these on **exact value match** before minting anything new:

1. **Semantic tier** — shadcn core set: `--background`, `--foreground`, `--card`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, `--sidebar-*`, `--chart-1..5` (OKLCH, light/dark overrides).
2. **Brand tier** — agent gradients `--agent-1a/1b..10a/10b` (fixed hex) and status hues `--status-task-*` / `--status-agent-*` (WCAG-tuned; see inline comments).
3. **Domain tier** — match-chip tokens `--chip-match-*`, annotation highlights `--paperclip-doc-annotation-highlight-*`, plus motion/typography tokens.

## Principles

1. **One way to say each thing.** One component per job. One Button, one Card, one Badge, one Table, one EmptyState. Variants are props, not new components. Before creating a component, prove no existing one covers the job.
2. **Tokens are the only source of visual values.** All color, spacing, radius, type size/weight, shadow, and motion values come from the token layer. No hex, no raw px, no ad-hoc Tailwind arbitrary values (`p-[13px]`) in components. If a needed value doesn't exist, add a token — don't inline it. Tailwind palette classes (`bg-red-500`, `text-zinc-400`, etc.) ARE hardcoded values in spirit: they name a literal color, not a semantic role. They are in-scope debt scheduled for a dedicated future run (Run 4, cluster-by-cluster mapping to semantic tokens per doc/design/DECISION-SHEET.md B2) and are not currently gated by check-token-gates. Exception (doc/design/DECISION-SHEET.md B1 user ruling): first-party intentional one-off decoration on demo/UX-lab surfaces stays inline and allowlisted rather than minted as singleton tokens.
3. **Spacing routes through tokens; the scale comes later.** During simplification, extract every spacing and radius value verbatim into tokens — do not normalize, round, or invent a scale. The final scale is a design decision made by a human after reviewing the token audit. Structural rules apply now: vertical rhythm within a container uses one gap value, not per-element margins, and siblings never carry both margin and gap.
4. **Hierarchy through structure, not decoration.** Prefer position, size, and weight over borders, backgrounds, and dividers. Every border, divider, and background fill must justify itself; when in doubt, remove it. A screen should survive the removal of one visual layer.
5. **Status is systematic.** States like running / paused / blocked / awaiting-approval / over-budget map to a single semantic status token set used identically everywhere (badge, row, chart, log). An operator learns the vocabulary once.
6. **Machine values look machine-made.** IDs, costs, token counts, timestamps, and log output use the monospace token and consistent formatting helpers. Never format these ad hoc per screen.
7. **Words are part of the system.** One name per concept across the entire UI — the canonical term is *task* (never *issue* or *ticket* in copy, labels, or empty states). Buttons name the action ("Approve hire," not "Submit"). Errors say what happened and what to do. Empty states say what to do first. **Note:** enforcing the task rename is a visible change and is explicitly OUT of the zero-visual-change extraction run; it happens in its own follow-up run.
8. **Agent-modifiable by design.** The system must be changeable via instructions: single token source, lint rules that enforce it, and this document kept current. A correct change should be expressible as "edit tokens + run checks," not "visit 40 files."

## Form and wizard footers

Keep **Save & exit** (or Cancel/Back) and the primary Continue/Connect/Finish
action in one shared footer row, vertically centered. Put the subdued secondary
action on the left and the primary action on the right. A step owns its whole
footer: do not render Save & exit in a separate parent block below it. Check this
alignment in every step and conditional state, not just the first screen.

Completed Slack setup is a success view: show the full agent avatar, success message,
and one centered Done action. Omit Save & exit after the connection has been
confirmed. The shared footer rule applies to its unfinished setup steps.

The New task form opens immediately. Load its code with the board and fill
agent and project choices in place as their requests finish. Keep text entered
while those requests are pending.

## Mobile navigation and text fields

The fixed bottom navigation uses an opaque surface so scrolling content cannot
show through its labels. On touch devices, editable controls use at least the
16px base typography token to prevent Safari's automatic focus zoom. Larger
title sizes remain larger.

The bottom navigation responds to accumulated scrolling, ignoring small
reversals and Safari's edge bounce. It glides out and eases back in with shared
motion tokens. Keep page padding stable while the navigation moves, and honor
reduced-motion preferences.

Mobile task conversations size their shell to the visible viewport, with one
message scroller and a normal flex footer for the composer. Navigation stays at
the layout viewport bottom, behind the keyboard.

Cold task opens reveal the instruction and recent conversation independently of
recovery, related metadata, and historical run activity. Saved document cards,
the saved plan, and the bounded latest turn arrive before first reveal so they
cannot insert rows into an already readable conversation. Show the latest human
follow-up, recent saved replies, and text or pending requests from the latest run.
Put older messages and diagnostic activity behind **More messages**. Fetch those
only when expanded; never download all history just to calculate a count.
Retain messages and runs observed while the task stays open, preserve expansion
on return within the session. No URL fragment expands history. Document links,
including continuation summaries, open their pane. Older comment links fetch
only the requested comment and preserve the recent conversation.
Background refreshes and history expansion keep the conversation and composer
mounted. A failed history request shows an inline retry without hiding readable
content. Full-history and classic views retain the bounded 15-second initial wait.

Only the viewer's own human comments sit on the right in blue bubbles. Agents
and other humans sit on the left on the page surface, with their own name and
avatar above the message. Human identity comes from the company directory;
missing photos use the shared initials fallback. Match ownership by the stored
author user ID and the authenticated viewer ID, never by display name or the bot
that relayed a message from another channel.

## Contextual feedback

Keep the runner turn's avatar, name, status header and current-activity slot
in place from message submission through queued admission and native startup.
Saving the human comment does not end startup feedback. Keep the identity mounted
until its run appears or a newer execution outcome ends admission.
Runtime discovery must not replace the turn with a generic spinner or a
"run started" receipt. Queued and running headers use the same spacing.

A queued turn shows `Queued`, or `Waiting for maintenance` while the server holds
admission. Reserve `Working` and `Thinking` for execution. A saved message that
starts this queued turn stays in history, including when it reopens an older
task. This placement is not a consumption receipt. Later follow-ups remain in
the composer queue with their existing edit, order and discard controls.

Stream the provider's final reply as the conversational answer. Completion-tool
reports remain inspectable run data while work continues. Use their summary as
an answer fallback only after the run ends and its final transcript fetch
completes without a provider reply. Preserve the reply through persistence.

Task chat shows execution errors and waits only while they remain relevant.
Exhausted attempts use a padded, rounded notice with a destructive-tinted background,
an error icon, and foreground text. The surrounding layout supplies separation from
the conversation. Automatic retry countdowns keep their quieter inline styling.
Completing or cancelling a task hides its old execution notices. A newer attempt by
the same agent or an explicit successor supersedes earlier run notices; an
unresolved execution hold remains visible. Historical turns keep their responses,
files, questions and inspectable activity without a Worked/Stopped status label.
Run history retains the full diagnostic record. Session reset boundaries remain
in the conversation. Time passing or a new human comment alone does not resolve
an error. Stored notices need run or recovery provenance before they can be hidden;
child-task relays and other unrelated system updates stay visible.

Interrupted runs use compact rows without divider rules, including
older saved markers. When a run error and a no-live-execution-path notice are
adjacent, show only the last error row. Keep its details and retry action. If a
legacy run has a permitted retry, keep that action on the surviving notice,
including its pending state. A
message, input, session boundary or credential-access denial separates errors;
it must not disappear as part of this grouping. Run details retain full history.

Credential-sharing denials stay expanded as an error card in the task conversation.
Name the agent and selected AI connection when known, and say which person lacks
access. Use “you” only for that person’s own run. Link to the agent’s AI connection
settings; retrying before changing the connection cannot repair a sharing denial.
Show the connection name to the affected user so they can identify what blocked
their task, and to viewers in the connection's human sharing audience. Other task
readers see a generic credential label. Never show credential secrets or grant IDs.
The same run-relevance rules hide the card after a newer attempt or terminal task.

Do not show a toast for task or run state already visible on the current screen.
This includes descendant runs represented by the open subtree. Show local action
results in place; keep failures actionable inline. Notifications for other work
remain useful. Repeated delivery of the same run outcome must refresh cached state
without repeating its toast, including after reconnecting. A terminal outcome
delivered more than five minutes after the run finished is historical and should
refresh state silently. Expected cancellation is neutral gray, not an error. The composer's Stop action stops the current response and leaves the composer available for a new message. Pause work is a separate explicit task or subtree action. A paused task replaces the composer with an amber takeover. It says “Task is
paused.” and “Resume this task to send a message.” with a “Resume task” action.
Subtrees use “Subtree is paused.” and “Resume subtree.” The takeover cannot be
dismissed, retains drafts, and hides message inputs until the pause is released.

Confirmations whose source work is still syncing show “Preparing approval…” and
disable acceptance until the server reports readiness. Refresh that state automatically;
rejection and revision remain available. Live tool reviews keep their own approval flow.

Pending questions, confirmations, and other task-thread inputs appear in a separate
card directly above the ordinary composer. The composer stays available for new
messages while the card is open. Questions use their compact history entry as the
reminder; dismissing one clears the composer and stays effective after reload for
that person and task. Other inputs keep a pending indicator that can reopen them;
resolving or skipping the input removes that indicator.

## Proposed color foundation

Review **Design proposals → Foundations → Colors** in Storybook
(`design-foundations-colors`): Token reference, Surfaces & elevation, and
Text & interaction. The palette comes from the [Paper Dark mode frame](https://app.paper.design/file/01KZ5QQTS4TG2VADP7ZVGJNQY4/p-L-0/3LXU-2)
and the designer's usage rules. Dark mode retains these proposed values. Light mode inherits the existing
production semantic palette from `:root`, including foreground, background,
border, input, accent, status and ring colors. Proposal-only `--muted-alt`
aliases production `--secondary`; the proposed light sidebar uses `--primary-sidebar-background`, the same
border/background blend rendered by the production primary sidebar. Light
navigation uses production foreground at 80% opacity and sidebar-accent for
selected/hovered items, rather than the dark proposal’s muted mapping.
Storybook proposals follow the theme toolbar instead of locking dark mode. It remains
proposed until visual approval.

Paper's `dark-color-*` names map to theme-independent CSS tokens in
`ui/src/index.css`; do not introduce a second token file or copy colors into
components/stories. The token-reference story reads values from the active CSS.

| Paper name | Code token | Intended use |
| --- | --- | --- |
| `dark-color-foreground` | `--foreground` | Headings, header labels, emphasized text, unread task titles |
| `dark-color-background` | `--background` | Center/right panes, lowest card surface, menus and popovers |
| `dark-color-background-alt` | `--background-alt` | Text inputs and search fields |
| `dark-color-muted` | `--muted` | Left sidebar and highest card surface |
| `dark-color-muted-highlight` | `--muted-highlight` | Hover backgrounds; preserve documented selection/sort behavior |
| `dark-color-muted-alt` | `--muted-alt` | Middle card surface |
| `dark-color-muted-foreground` | `--muted-foreground` | Default text, secondary labels, metadata, read task titles |
| `dark-color-border` | `--border` | Shared dividers, input outlines and card borders |

Focus indicators use `--ring: var(--foreground)`, matching `dark-color-foreground`.
A 1px bright edge and a 3px outer halo at 20% opacity give focus two levels of
emphasis, using `--focus-ring-stroke-width`, `--focus-ring-halo-width`, and
`--focus-ring-halo`. Inputs, buttons and the proposed custom focus indicators
share this treatment. This additional reference also supplies sidebar focus. Resize controls
retain their neutral gray via `--pane-resize-highlight`, independent of focus
elsewhere. The focus colors are listed alongside the Paper palette in the token
story as derivatives of foreground. The override is scoped to the proposed dark theme.

The border is translucent: its rendered shade depends on the surface beneath it.
Keep that alpha value rather than replacing it with a different opaque gray for
each background. Card surface levels share this border and do not automatically
add shadows. Use the existing `Card` with `elevation="low"`, `"middle"`, or `"high"`;
omitting elevation keeps its default surface. These new surface mappings apply
in both proposal themes, using their respective tokens.

Most text is muted foreground. Foreground is an intentional exception for
headings, header labels and emphasis. Task-title read/unread weight and hover
rules below remain in force. Task-status colors keep their existing semantic
meaning and are outside this neutral-palette reference.

The Storybook proposal decorator adds `.design-proposal-theme`. Dark semantic
overrides are scoped to its presence on the document so portaled menus inherit
the same colors. Leaving a proposal removes that scope. Existing production
stories and the app's default theme retain their existing appearance; the
light palette is reused without redefining its production colors. Activity shimmer
and interactive metadata emphasis follow `--foreground`; human bubble text stays white on blue. The sidebar, page shell,
task list, shared inputs, card levels and refreshed flyouts consume these same
semantic tokens.

## Proposed typography foundation

Review **Design proposals → Foundations → Typography → Type specification**
(`design-foundations-typography--type-specification`). The proposal and the
opt-in design sandbox use Inter Variable for interface text and bundled Paper
Mono for all monospace text, including IDs, code and run diagnostics.

**Conversation styles** (`design-foundations-typography--conversation-styles`)
shows the same composition as the sandbox task detail page by mounting
`DesignSandboxTaskThread` directly. Its canonical 72-state fixture catalog,
grouped selector, replay, history, activity disclosures, transcript/native paths
and local composer actions are shared, rather than independently assembled
examples. It defaults to All states. Optional computed typography measurements
inspect rendered text, including expanded disclosures; refresh after changing
states or opening content. Storybook does not load saved backend conversations.
The fixtures use production renderers with synthetic data; this does not certify
a deployed production version. Refine shared tokens/renderers after review so
subsequent typography changes propagate back to the sandbox.

**Conversation type spec** (`design-foundations-typography--conversation-type-specification`)
uses the Type specification layout to dissect the shared conversation preview.
Its size inventory, family/weight specimens, searchable usage rows and shared-
metric consolidation candidates derive from browser measurements of the same
72-state composition. Source classes and example-state links connect each row
to its owning surface. Measurements are snapshots: refresh after opening
content or selecting another state. Closed disclosures, placeholders and absent
Markdown structures are excluded. Isolated text specimens copy measured styles;
the shared composition remains available in context. Consolidation requires a
subsequent change to shared tokens/renderers, which then propagates to the sandbox.

The sandbox demonstration tasks now open a **Play conversation** preview rather
than stacking all state fixtures. A local, token-timed controller progressively
feeds one cumulative synthetic transcript through the real conversation
renderers: an initial question, reasoning, commentary, file read, command and
streaming final, then a follow-up with queuing, planning, clarification and
permission receipts, a failed test and retry, file preview, usage and a second
final. Demo answers and permissions advance automatically; no approval affects
a real run. Settled turns retain inspectable Activity history. Pause freezes the preview clock; resume continues
and replay resets it. At completion the response keeps the same mounted bubble:
preceding live activity fades over 180ms, then releases its height over 480ms so
the final reply glides into place. The Activity footer appears after the fold;
reduced motion settles immediately. This handoff is shared by the Storybook and
sandbox playback. Preview prose arrives in complete words with a subtle
320ms fade from near-transparent on newly mounted word spans; existing words remain stable. Reduced
motion disables the word fade. No provider or command runs. Saved conversations on other
tasks remain available. The Typography **Conversation playback** story uses the
same controller; Conversation styles and Conversation type spec retain the
72-state catalog for detailed inspection.

Conversation typography is now consolidated inside explicit shared thread and
composer regions under the proposal theme: body text is 14px/20px and metadata
is 12px/16px. Human messages retain blue bubbles with white text. Final agent
responses use foreground; commentary, reasoning, activity labels and metadata
use muted foreground without extra opacity tiers. Interactive metadata
returns to white text with a subtle neutral background on hover or keyboard
focus; noninteractive metadata stays muted. Agent names use 14px/20px semibold
in foreground.
Only the current activity owns white shimmer: Working while awaiting activity,
then the active reasoning or tool line. Working returns to muted foreground
while another activity owns shimmer; streaming final text does not shimmer.
The sweep loops continuously without an end pause. Tool labels and Paper Mono
targets share one gradient across their containing line, rather than animating
each text segment independently; reduced motion restores solid readable text.
Completed tools return to muted metadata. Runner preparation and transcript
loading placeholders are omitted from the normal live tail; actionable queues,
recovery and failure messages remain. Explicit final-channel text is foreground while
streaming; unclassified/progress deltas stay muted. Reduced motion disables
tool shimmer and word fades. Markdown headings stay 14px
normal and retain their semantic elements and spacing; final-response headings
use foreground. Explicit strong emphasis remains semibold. Authored code follows
14px body text; diagnostic output follows 12px metadata in Paper Mono. Links
inherit color and remain underlined. Semantic status accents, action-button
variants and keyboard-focus treatments remain meaningful exceptions. Standalone
Markdown outside conversation regions retains its existing scale. Removing the
proposal theme restores ordinary conversation styling.

Only normal (400) and semibold (600) are part of this proposal. Medium recipes
resolve to normal; bold recipes resolve to semibold. The size ramp is nano
(10px), xs (12px), compact (13px), sm (14px), base (16px), lg (18px), xl (20px),
2xl (24px) and 3xl (30px). Former micro usages use xs, including message times,
account email and technical metrics. Navigation group labels and streamlined
property section labels share the same sans/nano/normal/uppercase recipe,
150% leading, 0.1em tracking and muted foreground at 60%.

These decisions live in `ui/src/index.css`, under the shared proposal marker.
Compatibility aliases carry existing shared components onto the proposed
families, weights and sizes, including portals. New proposal code uses normal,
semibold and xs directly. The ordinary app theme retains its original
typography. The Buttons playground uses the sandbox proposal theme. Do not
remove those defaults while this design is being tested.

## Task-row refresh: proposed specimen

The task-row refresh is an explicitly authorized design change following the
extraction run. Its review surface is **Design proposals → Components → Task list** in Storybook
(`tasks-row-design`), using the production `IssueRow` with
`presentation="task" appearance="refreshed"` and the shared `TaskRowGroup`.
The existing row presentation remains the default while this specimen is reviewed.

Stage this design-system refresh's new token, component, layout, and screen stories
under **Design proposals**, in `ui/storybook/stories/design-proposals/`. Organize
sidebar titles by Foundations (tokens), Components (reusable UI), Layouts
(reusable page structures), Pages (complete screens), Patterns (shared behavior),
and Guidelines (usage and contribution rules). Add groups as stories exist;
do not create empty placeholder stories. Use
`home: "design-proposals"`, `status: "proposed"`, and an explicit staging reason.
These stories are review references and do not count as current production coverage.
All Design proposals opt into `AvatarInitialProvider`: text fallback avatars use
one uppercase character, the first initial. This includes the sidebar account
control, account/profile headers, identity avatars and failed agent-image
fallbacks. Uploaded images and organization artwork keep their existing rendering.
They continue to import shared components and the existing token layer; this is
organizational separation, not a second implementation or token source. Use them
for tasks explicitly implementing the refresh. After design review and adoption
in the app, move each suite to its feature or Foundations home and update its
classification while retaining its explicit story ID and exports.

- Comfortable density is 44px; compact density is 32px. Comfortable is the default.
  Compact is a preview for a future user preference, not a new app setting yet.
- All text in proposed task rows and table headers uses the `sm` size token
  (`--text-sm`, 14px) with a 16px line height. This includes metadata, IDs and tag
  chips; keep the same type size at both row densities.
- Titles use Inter: read titles are regular (400), muted foreground; unread titles
  are semibold (600), foreground. Hover changes the row background and title to
  foreground while preserving its read/unread weight. Proposed task-row hover
  backgrounds use `--muted`; other hover highlights retain their existing tokens.
  Keyboard focus reveals the
  same title emphasis and retains a visible focus indicator.
- Refreshed task rows indicate unread state through title typography alone. Do not
  show the old blue unread dot or reserve space for it, including in inbox rows.
- Task identifiers use bundled Paper Mono. All visual values live in the
  `--task-row-*` token family in `ui/src/index.css`, mapped to the shared semantic
  color tokens (`--foreground`, `--muted-foreground`, `--border`).
- Keep an 8px gap between the status icon and title in both row specimens and
  the complete column layout. Status icons show their text label in the shared
  tooltip on hover or keyboard focus; clicking still opens the task. Use the
  shared status label, including waiting/blocked context, rather than duplicating
  status copy. Title text continues to use its marquee without a tooltip.
- Titles stay on one line with ellipsis. Every truncated column uses the same
  `CellMarquee`: hover reveals only the cell in that column, scrolling left once
  at a constant speed until the last character is visible, then holding there.
  Moving to another column or leaving the row resets immediately. Fitting cells
  stay still. Keyboard focus also reveals truncated cells; Escape stops the
  reveal. Recheck overflow when width, text, or fonts change. Reduced motion
  jumps to the end without animation. There is no title tooltip; full text
  remains accessible, and the full title stays in the row link's accessible name.
  Truncated edges use a subtle 12px alpha fade into the actual row background,
  including hover, selection and other highlights. Fitting cells have no fade.
  The marquee also fades its clipped leading edge; once it reaches the end, the
  trailing fade clears so the final character remains fully visible. Keep the
  mask inside the focusable cell so keyboard focus outlines stay intact.
- Each nesting level adds 24px inside the title area. Trailing metadata columns
  stay aligned. Thin vertical guides communicate ancestry, with room for disclosure
  controls. Disclosure controls retain independent keyboard and pointer behavior.
- A root task and its visible descendants form one `TaskRowGroup`, bounded by a
  separator above the parent and below its final visible descendant. Child rows
  have no horizontal dividers. Adjacent groups share a single separator. The outer
  nesting guide stops above the bottom separator with the same gap as between
  its top and the parent's status icon.

Review read/unread, actual hover/focus, long titles, both densities, and an expanded
two-level hierarchy before composing the full task-list screen. Story fixtures
show local UI behavior; they do not prove live persistence or task authorization.

### Task-list columns

The complete column order is **Task, Task ID, Created by, Assignee,
Project, Parent Task, Tags, Worktree, Last updated**. The reusable
`TaskListColumnHeader` and `IssueRow`'s `columnValues` share the `--task-list-*`
width tokens and configurable column order. Review the complete composition in
**Design proposals → Components → Task list → All columns**.

- Created by is the recorded creator (human or agent); Assignee is the current
  assignee. Both show names without avatars. Do not infer either from tree depth
  or task status.
- Task combines the status icon and title under one header and one Columns-menu
  choice. Sorting Task uses the title. Status sorting is unavailable for now.
- Parent Task refers to the structural parent; it can show its ID and title.
- Last updated comes from `updatedAt`. Worktree shows the linked Git worktree's
  branch name. Unassigned tasks say “Unassigned”; other missing values use “—”.
- Default visibility is Task, Task ID, and Last updated. The All columns specimen
  starts with all nine visible for review. Widths are provisional: preserve
  a readable title area and scroll horizontally on narrower screens rather than
  dropping requested fields. Nesting consumes title space; metadata stays aligned.
- Fade clipped left/right edges into the background only while more content is
  hidden on that side. Remove both fades when the table fits. Keep scrolling and
  row controls usable through the fade.
- Tag chips use muted-foreground text on a muted-highlight background
  (`--muted-foreground` and `--muted-highlight`). In dark mode, muted-highlight
  matches Paper's `--dark-color-muted-highlight` (`#333333`).
- The column header stays 44px high in both row densities. Every visible header
  is a keyboard-accessible sort button: a new column starts ascending and repeated
  clicks toggle ascending/descending. The active label and direction arrow use
  foreground on a persistent muted-highlight background; inactive labels use
  muted foreground. Expose `aria-sort`.
  All header backgrounds have 8px of padding on each side. Vertical padding stays 4px.
  Preserve label alignment and column positions across hover states.
  The Task header spans status and title and aligns its label with root-row
  titles. Headers stay left-aligned, with sort arrows to the right. Sorting must
  not move other columns or widen the gap between row status icons and task
  titles. Every column uses the same 12px arrow.
- Drag a header left or right to reorder the entire column, including Task's
  status/title pair and its nested rows. A click still sorts; dragging never
  changes the sort. Alt+Left/Right reorders a focused header. Headers and all
  rows share one grid; widths, nesting and metadata alignment survive reordering.
  Last updated is last in the default table order and flyout order.
- Sorting keeps each parent before its descendants and sorts siblings at every
  level. Task IDs and names use natural, case-insensitive ordering; timestamps use
  their raw value. Tags sort by their
  alphabetized names; missing values stay last in both directions. Equal values
  retain their order. The initial collection uses Task ID ascending as its
  default order, with no active header, direction arrow or persistent highlight.
  A header becomes active only after the user sorts by it; the first click sorts
  ascending.
- A horizontal ellipsis stays pinned to the right edge of the header, outside
  horizontal scrolling. Its “Columns” flyout lists all nine columns in their current order
  with checkmarks on the right. Toggling columns updates both header and rows
  immediately and keeps the flyout open. Keep at least one column visible; nesting
  controls remain available even when Task is hidden. Reset defaults shows only
  Task, Task ID, and Last updated and restores the default column order.
  Reset also clears the active sort, direction arrow and persistent header highlight.
  Other columns remain available in the menu; hiding and re-enabling a column
  preserves its position until reset.
  Hiding the sorted column clears the explicit sort and restores the default
  collection order without highlighting another header.
- The refresh's compact flyout uses the shared DropdownMenu primitives. The
  Paper reference defines a 200px surface with an 8px radius, 12px content
  padding, 32px items separated by 4px, regular-weight muted labels and 14px
  checks on the right. Flyout text uses `sm` (14px) with a 20px line height;
  the heading and Reset defaults use semibold foreground. Hover/focus promotes
  labels and checks to foreground on muted-highlight. The dark surface matches
  Paper's `--dark-color-background` (#1a1a1a), shared by the task list, nesting
  groups, header controls, edge fades and the entire proposal canvas (including
  its document/root background and surrounding content). The flyout has an
  explicit 1px semantic border; the reset outline also uses the semantic tokens.
  Table text retains its 16px line height.
  The existing inbox picker remains tied to its older column contract and descriptions.
  Sort, order and visibility changes in the specimen are local state; saving preferences
  across navigation/reloads belongs to app adoption.

### App-shell layout proposal

Review **Design proposals → Layouts → App shell** (`design-app-shell`):
Two Panes, Three Panes, and Independent Scrolling. These use the existing
`DesignPageShell` and `DesignSidebar`, also composed by Pages → Tasks.
Pages supply the `sidebar`, `title`, and main `children`; optional `rightSidebar`
and `rightSidebarTitle` add a contextual right pane. Do not recreate this shell
inside a page or story. The shell owns pane geometry, fixed headers, and separate
main/right scrolling; each page owns its content and actions.

For tabbed contextual panes, supply `rightSidebarHeader` and
`rightSidebarControls`; `rightSidebarMaximized` expands the right pane across
the workspace while retaining the left navigation. `headerActions` can supply
a reopen control. The Three Panes and Independent Scrolling stories reuse the
task-detail page's production `SidePanelTabs`, `SidePanelLauncher`,
`SidePanelWindowControls`, and `useSidePanelTabs`. Their Properties, Tasks, Plan,
and Artifacts tabs can be selected, added, closed, and reordered; closing the
last tab reveals the launcher. Tab contents remain neutral fixtures. Closing
the pane preserves its tabs for reopening. Both content viewports use
`useScrollbarWhileScrolling` and `scrollbar-while-scrolling`: scrollbars appear
while moving and hide after the shared `--motion-scrollbar-idle-delay`.

The left sidebar retains its shared resizing behavior. The right pane defaults
to 320px, capped at 30% of the shell width on narrower desktops. Its divider
uses the left sidebar's neutral resize highlight on hover, keyboard focus, and dragging.
Dragging left widens the pane; arrow keys resize in 16px steps, and Home/End
select the bounds. Double-click clears its saved width and restores the default.
Both sidebars animate their double-click reset with the shared 200ms
`--motion-pane-width-reset` and `--motion-ease-pane-width-reset` tokens, matching
the task-detail right pane. Dragging and keyboard resizing remain immediate;
left navigation open, close, and peek behavior stays immediate. Reduced motion
sets the reset duration to zero. The app-shell stories expose this through both
dividers, using the same SidebarShell as the sandbox's left navigation.
Resizing keeps at least 260px for the right pane and, when space permits, 320px
for the main pane. Width preferences use `rightSidebarStorageKey`, defaulting
to `${sidebarStorageKey}.right`, independently of the left width. Maximizing
hides the resize handle and restoring retains the chosen width. All dimensions
use `--design-page-aside-*` and `--design-page-main-min-width` tokens.
Main and right panes use `--background`, the left
sidebar uses `--muted`, and dividers use `--border`. Layout stories use separate
sidebar-width storage keys and neutral placeholder content so review focuses on
the structure. These are proposed dark desktop layouts; mobile navigation and
right-panel overlay behavior require separate design work.

### Task-list page proposal

Review the complete composition in **Design proposals → Pages → Tasks**
(`tasks-list-page-design--default`), alongside All Columns and No Results.
This page remains proposed until the design owner approves the surrounding
layout. The Default story shows Task, Task ID and Last updated; the row specimen
and full page consume the same `TaskList` collection.

- `DesignPageShell` composes the existing 240px `SidebarShell`, a 60px page
  header, and scrolling main content with 24px insets. The sidebar uses muted;
  the entire main pane uses Paper's background token. Desktop is the current
  review scope; mobile composition remains to be designed.
  Enable the shared shell's production resize handle, including its hover,
  dragging and keyboard states. Sidebar width persists under the proposal's own
  storage key, separate from the production sidebar preference. Double-clicking
  the resize handle restores and saves the default 240px width.
- Toolbar outlines use the opaque `--design-page-control-border` token so
  search, view, layout, expansion and filter controls have the same visible
  border despite their different fills. General surface borders continue to
  use the translucent `--border` token. Disabled controls retain their normal
  dimming, and keyboard focus retains its separate ring.
- The left sidebar clips its muted fill to the padding box so its translucent
  right divider blends over the app background, matching the main header and
  pane boundaries. The divider still uses `--border`; the resize handle keeps
  its distinct hover/focus highlight.
- `DesignSidebar` is the shared proposed navigation component used by this page
  and **Design proposals → Components → Sidebar**. Refine its Default, Narrow,
  Long Labels, Many Recent Tasks, Empty Recent Tasks, Organization Menu and
  Account Menu stories, then review the Tasks page in context. Both compositions
  use the same component and CSS tokens. The caller supplies recent tasks and
  the New Task action; recents are filtered to the selected company.
  The Recent Tasks heading stays fixed while its list scrolls independently.
  The list uses the existing `scrollbar-while-scrolling` utility and shared idle
  timer token; hovering alone does not reveal its scrollbar.
  Standalone examples use separate width preferences and share the page's owner-access
  fixture boundary, existing dialogs, marquee and Popover appearance. Navigation
  remains fixture based; mobile composition and backend behavior are not proved.
- Sidebar navigation labels use `sm` (14px). Icons match Paper and the existing
  sidebar mappings: CircleCheck, MessageCircle, FolderOpen, Repeat, Package,
  Users, Boxes, Unplug and History. The organization and account controls mount
  `SidebarCompanyMenu` and `SidebarAccountMenu` directly, preserving their
  production keyboard behavior and actions, with the shared refreshed flyout
  appearance. Switching fixture
  organizations changes the selection and never shows another company's tasks.
  The sidebar follows Paper node `32TP-0`: 12px navigation insets, 8px item
  margins and padding, 14px/150% labels, 2px row gaps and 16px section gaps.
  Work and Org captions use the sans family rather than monospace. Recent Tasks
  is a separate final section with five regular-weight, unindented links; it is
  not nested beneath Tasks. The account footer has no divider above it.
  Sidebar surface and right border alias `--muted` and `--border`, matching
  Paper's dark-color-muted and dark-color-border. The task search field uses
  `--background-alt` (Paper dark-color-background-alt: oklch(14.5% 0 0)).
  The organization switcher has no caret in this proposal. Its hit area is
  separate from an adjacent global-search button, which opens the production
  `CommandPalette`; the toolbar input remains a task-list filter.
  `TruncatedTextMarqueeProvider` opts sidebar and menu labels into the same
  `CellMarquee` animation and alpha fade as table cells. Links and buttons own
  focus; labels add no tab stops. Organization-menu state changes reset the
  trigger title; restored focus after dismissal does not restart it outside the
  hit area. Fresh pointer interaction or tabbing away and back can reveal it.
  Pointer exit resets immediately, Escape stops
  reveal, fitting labels stay still, and reduced motion follows the shared rules.
- `TaskListToolbar` composes shared buttons, input, tooltip, dropdown and filter
  primitives. Controls are 44px high. A 32px gap separates the toolbar and table.
  Page dimensions, spacing, type and surfaces live in the token layer under
  `--design-page-*` and `--design-sidebar-*`.
  The filter popover uses Paper's five peer groups in order: Status, Project,
  Creator, Assignee, Label. All but Status have an always-visible search field.
  Desktop groups are 200px wide with 16px gaps and 12px body insets; groups wrap
  on smaller viewports. Checkbox rows use the existing filter state and toggle
  helpers, with Clear resetting the active filters. This opt-in `refreshed`
  presentation omits the old quick-filter and visibility sections and inherits
  the shared Popover surface, highlight and `--shadow-flyout` token.
- Refreshed dropdowns and popovers share `FlyoutAppearanceProvider` and the
  existing Radix primitives. `Flyout` / `FlyoutContent` compose a popover;
  `FlyoutHeader` supports a simple title or profile details, and `FlyoutOptions`
  groups the actions below it. Dropdowns reuse these sections and the appearance
  provider while retaining menu keyboard behavior. Surfaces
  use background, borders use border, hover/focus uses muted-highlight and
  foreground. Unhighlighted labels and their checkmarks use
  `--flyout-item-foreground`, bound to muted-foreground. Selection uses a checkmark,
  including single-choice Views.
  The shared `--shadow-flyout` token controls the subtle drop shadow. All flyout
  visual values live under `--flyout-*`; menu-specific widths stay contextual.
  The account flyout fits its contents and retains production Invite access
  checks. The preview supplies owner access and loaded operator-policy fixtures.
  This appearance remains opt-in while the proposal is reviewed.
  Review the component separately in **Design proposals → Components → Popover**, with Columns,
  Views and Account Menu examples. Account Menu mounts the canonical
  `SidebarAccountMenu` with the same owner-access fixture boundary as the Sidebar
  story; no separate action list or simulated account handlers are maintained.
  The former Profile story keeps its stable URL and is named Account Menu.
  Its Shadow control previews a local override;
  changing the saved `--shadow-flyout` token in `ui/src/index.css` updates every
  refreshed flyout. Storybook controls do not persist token edits.
- Views appear in this order: Inbox, Unread, Needs attention, All tasks. Inbox includes
  tasks created by or assigned to the current user. Unread uses the task unread
  state; Needs attention includes both blocked and in-review statuses. New users start
  on All tasks. The last view persists in browser storage per user, across the
  proposal stories and organizations, under an isolated design-proposal key.
  Invalid or unavailable storage falls back to All tasks; changing views still
  works if storage is denied. Cross-device preference sync requires app integration.
  Search, views and filters operate on fixtures. Matching
  subtasks keep their ancestor chain for context; the result count distinguishes
  matches from contextual parents. Expand/collapse applies to every nested level.
  The grouping icon and menu are omitted from the proposed toolbar.
- List/board switching preserves the list's local column state. The board and
  New Task composer reuse existing components and are not new approved designs.
  The proposed board uses one horizontal scroll viewport. It shares the task
  table's edge detection and fade tokens, showing each fade only while content
  is clipped on that side; resize and scrolling update the indicators.
  Sidebar links exercise the memory router; destination pages, creation API
  behavior, production preferences and production routes are outside this preview.

### Reuse collection behavior as well as appearance

`useTaskListCollection` in `ui/src/hooks/` is the shared presentation controller
for the proposed task page and reproduction trial. Supply accessible `items`,
the selected `companyId`, current `userId`, an isolated `viewStorageKey`, and
optionally `initialQuery`. Feed its query/view/layout/filter handlers to
`TaskListToolbar`, its `creators` directly to the Creator filter, and its
`visibleItems`, `companyItems` and expansion state to `TaskList`. Boards consume
`matchingItems`: contextual parents belong in the hierarchical list only.
The caller owns data loading and mutations; this hook does not authorize data
access, define server permissions, or integrate production persistence.

Creator IDs are namespaced (`user:<id>` / `agent:<id>`), including when human
and agent IDs coincide. Search includes task IDs, titles, creator, assignee,
project and tags. Changing query, view or filters expands matching families so
results cannot remain hidden behind collapsed ancestors. Clear resets search,
filters and view, while keeping the chosen layout. View storage remains isolated
by the caller's scope/user key. Company changes scope tasks and creator options
and start with expanded families.

The reproduction story now uses this controller too. It is a repaired regression
reference, not an untouched fresh-agent result. Preserve the first submission's
source, frozen PNGs and capture metadata separately when evaluating improvements;
do not replace its evidence with repaired output or silently accept new images.
The opt-in `task-list-reproduction-trial.config.ts` suite requires
`TRIAL_REFERENCE_PNG` pointing to the original frozen reference (and a matching
Chromium executable via `TRIAL_CHROMIUM_EXECUTABLE`). Missing visual evidence is
an error rather than an omitted comparison. Its browser cases exercise creator
filters, collapsed search/view/filter transitions, metadata search and board
matching on both the reference and trial. These checks establish fixture behavior
and reproduction of that frozen desktop state, not production acceptance.

The next milestone is the agent reference contract and another fresh-agent test
using the shared components, tokens and collection controller. A corrected trial
does not establish that a new agent will discover and reuse this system without
coaching. Visual approval and production integration remain separate milestones.

### Activity lists

**Design proposals → Components → Activity list** demonstrates the shared
`ActivityList` and the refreshed appearance of `ActivityRow`, including mixed
task, agent, project, approval, run and unlinked system events. Its Playground
exposes comfortable/compact density and standard/narrow/smallest container width.
It reuses task-row height, spacing, typography, ID/time widths and responsive
metadata rules, plus the same `CellMarquee` and `useCellMarqueeHover` behavior.
Activity is its own composition; events are not converted into synthetic tasks.

The caller supplies events in display order, entity/actor directories and any
entry animation. Only task events show a task ID and task hover card; other
events retain their entity or run destination. Unlinked events remain readable.
The main row stays 44px (comfortable) or 32px (compact), with 14px/16px text.
Added/removed issue references remain in a detail block below that row rather
than being dropped or clipped to fit. Narrow containers hide task ID first,
then timestamp in the smallest layout, matching task summaries.

Dashboard's Recent Activity opts in only while the design sandbox is on. The
sandbox also provides the same single-initial avatar policy as Design proposals
in Storybook, including account menus and other shared fallback avatars.
Turning proposals off restores the original rows and avatar policy.

### Task hover cards

**Design proposals → Components → Task hover card** documents the contextual
preview shared by task links and recent activity. The code names are
`IssueLinkQuicklook` (trigger/behavior) and `IssueQuicklookCard` (content).
Use the existing `Link` from `@/lib/router` for task links; set
`disableIssueQuicklook` when a surface should omit the preview. This choice
belongs to the caller, not a user preference. `IssueRow` and `TaskSummaryList`
remain opted out and reveal truncated text locally instead.

The refreshed card follows the Paper task-card reference: 280px width, 16px
padding, status/ID/timestamp metadata, a 14px semibold title clamped to two
lines, and a 12px description clamped to three lines. Project metadata is
omitted in this proposed appearance. The card uses background, border,
foreground and muted-foreground semantics plus the existing `--shadow-flyout`;
its geometry and typography live in the `--task-preview-*` token family.
It retains production hover intent, single-open behavior, focus, dismissal,
prefetch and access boundaries. The default appearance remains unchanged.
Story fixtures demonstrate the component and opt-out contract, not live access
checks; verify the sandbox's recent-activity links for integration review.

### Narrow task summaries

`TaskSummaryList` is the flat summary composition of the same refreshed
`IssueRow`, reviewed under **Design proposals → Components → Task list → Narrow**.
The **Playground** (stable story ID `tasks-row-design--specimen`) exposes row
density and container width both above the preview and in Storybook Controls.
It retains nesting and read/unread samples while varying these independently;
the fixed density and width stories remain review references.
The caller supplies ordered issues and an accessible list
label; `showIdentifier` and `showUpdated` can omit optional metadata. The list
uses regular muted read-style titles regardless of the source unread flag and
never marks a task read. It retains the 44px comfortable height, sm/16px type,
status tooltips, normal task navigation, hover, keyboard focus and cell-local
fade/marquee. It omits disclosure spacing, avatars, assignee, table headers,
column settings and collection state. Container queries hide Task ID below
28rem and Last updated below 20rem while keeping status/title readable without
horizontal scrolling. Existing row, spacing, type and divider tokens are reused.

Dashboard's Recent Tasks opts into this composition only while the design
sandbox is on. Data, ordering, limit and empty-state behavior stay with Dashboard;
the ordinary presentation remains available with the toggle off.
Agent overview's Recent Tasks uses the same summary in the sandbox, retaining
its participant-scoped query, updated ordering, six-task limit, more-task count
and See All link. The toggle restores its original rows as well.

### Sandbox button playground

**Design proposals / Components / Buttons / Playground** is a styling
workbench for the local design sandbox. All specimens use the shared proposal
theme. The live specimen, variant/state matrix and size matrix use the shared
Button API; contextual examples mount the sandbox's task toolbar, task list,
sidebar, pane controls, agent actions, conversation feedback, favorites, file
controls, status picker, attachment actions and relation expansion.

Label, variant, size, icon, interaction state and semantic surface controls
stay synchronized with Storybook args. Specimens measure actual dimensions,
padding, typography, radius, icon size and resolved colors. Hover, keyboard
focus and pressed previews derive from compiled component CSS under a
Storybook-only attribute; the app's Button gains no forced-state API. Disabled
and loading remain real props. Context actions use local fixtures.

The workbench has one full-width sandbox inventory. It does not show a
production iframe, comparison-layout controls, legacy-only components,
feature-gated priority controls or repository-wide source usage counts.
Playground is the single story in this grouping. These examples do not run
agents, persist uploads or establish backend behavior.

### Local integration sandbox

The development app can opt into **Design proposals only** with
`VITE_PAPERCLIP_DESIGN_SANDBOX=true`. The bottom-right **Design proposals: On/Off**
control persists a local comparison preference. Production builds and development
instances without this environment switch cannot activate it through browser
storage. This experiment does not enable other Storybook explorations.

When on, the app uses the same `.design-proposal-theme` marker and
`FlyoutAppearanceProvider` as the proposal stories. Document-wide token and portal
propagation is intentional: inspect ordinary pages for missing foundation mappings
and component variants. The desktop primary sidebar mounts `DesignSidebar` with
real recent-task data; existing layouts retain their route handling, contextual
sidebars, panels and dialogs. Mobile retains its existing drawer. No new global
component defaults are introduced. Toggle off removes the marker and restores
the existing sidebar, Tasks surface and menu appearance.

The resizable contextual pane uses `--design-page-aside-width` for its default
and double-click reset while the proposal is on (currently 320px). Sandbox
widths use separate `paperclip.design-proposal.properties-pane-width.*` storage
keys, so toggling off retains the ordinary 434px task-detail default and its
saved widths. This adapts the existing task-detail pane; it does not replace its
production content or maximize behavior with the layout-story fixtures.

`DesignSandboxTasks` adapts real company-scoped APIs to `TaskListToolbar`,
`TaskList`, `KanbanBoard` and `useTaskListCollection`. It imports no Storybook
fixtures. Creator names, projects, labels and viewer unread state come from APIs;
the ordinary organization list does not supply unread context, so a separate
server-filtered unread query supplies that set. Load-more explicitly limits
client search/filter/sort coverage to loaded tasks. Preferences use sandbox keys.
Task links, creation dialogs and board updates retain the existing app services.
This is an integration experiment, not permission, scale or release acceptance.

Dashboard metrics use `MetricCard appearance="card"` while the proposal is on.
This mounts the shared low-elevation `Card` with semantic background, border,
radius and padding, keeping the existing metric links and responsive grid.
The plain metric presentation remains the default outside the experiment.

The streamlined task-detail header follows the Paper title-block proposal while
the sandbox is on: a regular 24px title, followed by a metadata row grouping the
status picker with its monospaced task ID, project and people. The title remains
editable and the existing task-actions menu stays at the upper right. Typography
and spacing use the shared tokens; toggling off restores the ordinary header.

The local task detail also offers a **Thread preview** selector. DES-1 opens a
complete synthetic conversation matching the staging transcript layout; other
tasks start with their saved thread. Synthetic runner events pass through
`nativeRunEventsToTranscript` and `transcriptToTaskChatItems`. The preview uses
the shipped message bubbles, attached **Activity** history, working/elapsed/tool
status, chronological activity groups and composer takeovers. It does not import
the older chat-lab scenario inventory. The presentation flag follows the instance.

The selector also exposes native-runner turns, streaming commentary/final replies,
reasoning, tools, startup, queued messages, pause, failure, cancellation, timeout,
permissions/questions, result dispositions, provider activity, workspace changes
and usage. Native-runner and transcript layouts are named separately: runner
version alone does not determine which presentation a run uses. Individual
snapshots replay streaming text; **All states** is a labeled comparison gallery.
Stop, approval, question, feedback, resume and composer actions change local
presentation state only. **Show saved thread** restores the real task thread.
`threadPreview` preserves selection in the URL, including aliases for older links.
The fixture module is lazy-loaded only in the enabled development sandbox.
These styling snapshots do not run agents or prove provider/backend behavior.

Use the worktree-local isolated config and database. For a desktop visual review
without building the agent runner, the documented direct API/UI dev path is:

```sh
PAPERCLIP_CONFIG="$PWD/.paperclip/config.json" \
PAPERCLIP_HOME="$PWD/.paperclip-local" \
PAPERCLIP_INSTANCE_ID=design-system-sandbox \
PAPERCLIP_UI_DEV_MIDDLEWARE=true \
VITE_PAPERCLIP_DESIGN_SANDBOX=true \
HEARTBEAT_SCHEDULER_ENABLED=false \
PAPERCLIP_TELEMETRY_DISABLED=1 \
pnpm dev:server
```

The dark foundation is the review target; select dark mode in the account menu.
Local sample records are persisted through product APIs in the sandbox database,
not supplied by fetch mocks or copied from a live instance. Sample agents remain
paused. Agent execution is outside this visual sandbox.

## Enforcement (what "compliant" means for the extraction run)

- **Zero visual change is proven, not promised:** Storybook visual snapshots are baselined before any refactor, and all snapshots match baseline after it. A change that alters rendered output must be intentional and human-approved.
- **Baseline scope for Run 1:** the shared primitives in `ui/src/components/ui/` (each gets a story if missing — there are only ~24) plus the ~46 existing stories under `ui/storybook/stories/`. Do NOT attempt a story for every feature component (~277) in this run; full coverage is a later effort.
- Mechanical rewrites (value extraction, renames) are done via committed codemod scripts in `scripts/`, not hand-edits — reviewable once, repeatable forever.
- Token layer is the single source (`ui/src/index.css`, per above) consumed via CSS variables / Tailwind theme — never values copied into components.
- Lint/grep gates pass: zero hardcoded hex values, zero arbitrary spacing values, zero raw font-size declarations in `ui/src/components/**` and `ui/src/pages/**` outside the token layer and a documented allowlist (third-party overrides, intentional opt-outs commented inline).
- `pnpm build`, `pnpm typecheck`, and `pnpm build-storybook` pass.
- AGENTS.md links here and states the token-only rule.

Aspirational (NOT gating this run): no duplicate components; every component has exactly one story covering its variants; all UI copy says "task".

## Out of scope (do not do during simplification)

No visual redesign, no new colors or typefaces, no layout restructuring, no new dependencies beyond snapshot tooling, no component consolidation/merges (audit + recommend only), no copy renames, no changes to server code or app logic. Simplification means fewer parts, same product.

## Prior art (read before auditing)

See `doc/design/PRIOR-ART.md` — a previous audit pass (PAP-280/283/284, on the `PAP-282-playground` branch, NOT on master) found that of ~220 hardcoded drift sites, only 6 were exact-value-mappable to existing tokens; expect the verbatim extraction to mint many new tokens that the human scale-collapse step later merges. It also drafted usage rules (radius tiers, CTA tiers, named type styles) that are good candidates for the post-audit scale decision.

How-to guide for day-to-day UI changes: see `doc/design/CHANGING-THE-UI.md`.

## Motion tokens (Task Chat Redesign)

Mobile task panels fill the viewport within the safe area. Their top toolbar shows the current tab title, an open-tab count and selector, an add action, and an X to return to the feed. The selector lists tabs vertically with wrapping titles, an explicit current-tab check, and visible close controls. Each touch control uses the 44px size token. Desktop tabs keep their horizontal layout. Document links within the current task open through the router and retain the feed's reading position and query cache.

The redesigned task thread (flag `enableTaskChatRedesign`) is the first surface to
tokenize motion. Principles — reasoning only; values live in `ui/src/index.css`:

- **One home, and it is `:root`, not `@theme inline`.** `@theme inline` bakes literals
  at build time, so a value placed there cannot be moved at runtime. The dev tweak panel
  tunes motion by writing CSS custom properties live, so every motion token must resolve
  at runtime — hence `:root`.
- **Two tiers.** Primitives (`--motion-duration-*`, `--motion-ease-*`) express the app's
  baseline motion feel; state/component-scoped tokens (`--motion-<state>-*`) reference the
  primitives so the whole thread retunes from a few knobs. Scoped tokens exist so the
  tweak panel can group controls by the state they affect.
- **Reuse the house curves.** New easing defaults point at the two curves already used
  across the app rather than inventing a third feel.
- **No hardcoded timing in components.** Durations, easings, delays, and staggers used by
  the redesigned thread must reference these tokens; a check script rejects raw `ms` /
  `cubic-bezier` values outside `ui/src/index.css`. This discipline is what makes the
  tweak panel structurally possible.
- **Values are placeholders.** The committed numbers are sensible starting points, tuned
  live by a human and pasted back from the tweak panel's export — never treated as final
  during the baseline build.
- **Reduced motion is honored at the token layer.** A `prefers-reduced-motion: reduce`
  block collapses the duration/stagger tokens to zero, cascading to every scoped token,
  in addition to each animation's own component-level guard.

Agent Chat and regular task chats keep pending questions and requests as compact, reopenable entries at their original position in history. Dismissing any composer request—including completion reviews, confirmations, choices, suggested tasks, item verdicts, and runtime input—removes its form and pending reminder. Saved interactions record human dismissal on the server; raw runtime requests retain a browser-local preference. Dismissal is not an answer, approval, or rejection. Sending a newer user message also clears an ordinary question from the composer without resolving it. Questions never contribute to composer pending counts or navigation. Opening the history entry restores the original form and its draft; submitting later uses the same durable question response path. Actual permission reviews retain their permission checks.

Desktop properties panels keep a zero-width, noninteractive host while their content is unknown. Late content expands the panel and moves the thread in the same width transition. Removing content on navigation clears the pane immediately, including maximized geometry. The motion uses `--motion-pane-reveal` and `--motion-ease-pane-reveal`; reduced motion disables it. A saved hidden preference stays hidden, and pointer resizing stays immediate.

## Canonical proposal toolbars

`Design proposals / Components / Toolbars` is the canonical toolbar review and
reuse home. Playground shows all demonstrated families; Tasks and Decisions
isolate their controls, and Narrow exercises wrapping. Reuse `TaskListToolbar` with
`useTaskListCollection` for proposed Tasks controls, `CollectionToolbar` for
collection context/search/controls/actions/feedback slots, and `DecisionsToolbar`
for decision filtering, grouping and sorting. These are distinct jobs; do not
copy their markup into new page-specific toolbars. Shared buttons, semantic
foundations, focus treatment and refreshed flyouts remain their dependencies.

The Decisions specimen mounts the production component used by
WhatNeedsMe and DecisionQueuePage. Preview creation callbacks only report
intent; menu and control state is local. Canonical proposal status establishes
the reference for continued styling and reuse, rather than certifying deployed
production behavior or migrating every existing page.

Skills and Artifacts are additional canonical toolbar references. Their shared
`SkillsToolbar` and `ArtifactsToolbar` presentations are consumed by both the
shipped pages and proposal stories; query, URL, permission and mutation state
stay in the pages. The Skills story simulates scanning and creation locally.

`Design proposals / Components / Tabs` defines two canonical filled sizes:
Compact uses `--text-xs` (12px) and a 24px item height; Standard uses
`--text-sm` (14px) and a 32px item height. Both use normal 400 weight,
muted inactive text, foreground selected text, rounded filled selection and
shared focus treatment. Standard follows the Paper tab bar: 10px horizontal
padding, 8px gaps and 4px list padding. Compact retains the artifact filter's
6px gaps. Sizes, colors, spacing and motion live in the token layer.

`TabBar` composes within Radix `Tabs` with matching content panels.
`TabFilters` uses an exclusive Radix ToggleGroup with radio semantics for
collection filters; it never clears the current choice. Both support roving
keyboard focus and disabled choices. `PageTabBar` adopts Standard and retains
its mobile select; connector source filters and the Artifacts toolbar use
Standard. Artifact type filters also support Compact for dense standalone uses. Segmented controllers and closable document tabs are separate
patterns. Tabs contains only Playground, Standard and Compact. Playground
compares the two sizes with local fixture state; narrow width remains a control.

Accepted toolbar foundation for Design Proposals and the opt-in sandbox:

- Use the shared `ToolbarSearch` and 44px control height, with one token-driven
  border, radius and horizontal padding across Tasks, Decisions, Skills and
  Artifacts. Adjacent toolbar controls and action groups use an 8px gap
  (`--collection-toolbar-gap`); separate rows retain the 16px layout gap. Embedded search clear buttons and the inner halves of a segmented
  layout switch retain their smaller geometry within a full-height control.
- Order controls as search, filter/sort/group/view, optional secondary actions,
  then the primary action. Tasks is the exception: its view dropdown precedes
  search because it also serves as a heading.
- Decisions includes a controlled search field on the desk and queue pages.
  Search intersects active filters before grouping; it matches all entered words
  across titles, task identifiers, summaries, agent, project and workspace names.
  It searches the current decision list, not collapsed terminal-history curtains.

Further consolidation proposals, pending visual review:

- Move infrequent secondary creation actions into the primary creation menu
  when that keeps the toolbar readable.
- Reuse CollectionToolbar slots while keeping domain-specific controls and
  controllers separate. Preserve search and the primary action in narrow
  layouts, with predictable wrapping or overflow for secondary controls.
- Use canonical Standard or Compact filled tabs for the compared label strips.
  Keep panel-switching tab semantics separate from exclusive collection
  filters. Closable document tabs retain their additional behavior.

### Segmented controller comparison

`Design proposals / Components / Segmented controllers` owns the segmented
comparison Playground, with Disabled and Narrow stories. It includes audit
scope, proposal and production task layouts, agent layouts, instruction and file
preview modes, secret ownership/value source, goal panels and model lanes.
FilePreviewModeToggle mounts directly; inline page controls use explicitly
labelled primitive compositions with local state. Page navigation and
collection filters remain in Tabs. This comparison does not migrate app styles
or certify backend behavior or keyboard accessibility.

Agents and Connectors compose the same `ToolbarSearch`. Connectors also use canonical Standard filled tabs. `AgentsToolbar` is shared by the roster page and
toolbar references; `ConnectorsToolbar` is shared by Browse and toolbar references. Keep search
first, source selection next where present, and view/actions last. The agent roster uses a harness filter icon without a status selector.
Connector source choices use radio semantics and preserve Browse's existing
automatic search expansion; they do not switch separate content panels.
Legacy agent status and built-in URLs redirect to the full roster at `/agents/all`.
Agent search matches name, role and title words, and retains ancestor context
for matching org-chart nodes.

Projects uses `ProjectsToolbar` for shared search, the existing name/updated/
created/target-date sort choices and direction toggling, and Add Project. Project
search matches all words across name and description before sorting and grouping.
Connector source tabs sit on a second row below search. Tasks keeps its view
dropdown before search; task view state and persistence are unchanged.

In the streamlined Skills area, `SkillsNavigationTabs` replaces the contextual
sidebar with Installed, Discover and My Skills links styled as canonical Standard
tabs beneath the toolbar. Studio and Sources keep these links beneath their own
header controls. Sources is a separate destination available through the Skills
New menu's Manage sources action; it is not a tab. The main company navigation
stays visible. Legacy Skills navigation retains its existing sidebar.

The streamlined My Skills landing (`/skills/studio`) mounts the same CompanySkills
collection, SkillsToolbar and DiscoveryGrid/SkillCard as Installed and Discover.
It keeps the existing installed-skill collection, defaults to Recently updated,
and opens cards directly in Studio. Search, source filtering, scanning, import,
folder creation and skill creation use the existing collection controllers.
Studio editor routes and the legacy recency landing keep their own layouts.

## Offline recovery

The service worker recovery page uses a centered character, a dark surface, and
a visible Reload page action. Keep the character inline and embed the marked
`offline-recovery` section from `ui/src/index.css` at build time so the page needs
no network requests or cached assets. Preserve the supplied character palette
through the offline tokens.
