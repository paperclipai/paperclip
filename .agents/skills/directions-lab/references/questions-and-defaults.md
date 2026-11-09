# Questions and defaults - the intake before `scaffold.mjs new`

Read this after SKILL.md and before touching the generator. It covers only the intake: what to pull out
of the brief, how to ground it in the code, the one `AskUserQuestion` call, and how every flag of
`node .agents/skills/directions-lab/scripts/scaffold.mjs new` is derived. What the generated files look
like is in `generator.md` §5, their precedent in `lab-anatomy.md` and `today-fixtures-and-build.md`; the
Storybook entry and its ids are in `design-proposals-storybook.md` and `repo-gates.md` §1; later stage
moves are hand edits per `lifecycle.md`.

## Contents

1. Extract from the brief
2. Ground the subject in the code
3. The one question call
4. When no question can be asked
5. What is never asked
6. Flag derivation table
7. The three eval briefs as flag lines
8. State every derived value before `new`

## 1. Extract from the brief

Read the brief once and fill these four slots. Each slot either comes from the brief or from a step below;
nothing else is invented.

| Slot | Look for | Becomes |
|---|---|---|
| Subject | the feature noun ("the task composer", "the inbox row", "the agent profile card") | `--slug` (kebab-case of the noun, no "directions", no "lab") and `--title` (sentence case) |
| Places | "shows up in", "appears on", "in the right panel", "on the inbox page", a list of locations | `--surfaces`, one entry per place; one place means no surfaces row |
| Count or names | "3 new directions", "2 directions", or named directions ("Solid, Tint") | `--directions` and, only when named, `--names` |
| Flags and components | `enable...`, `use...Enabled`, a component or file name | the Today kit's `flags`, and a head start for the grep in §2 |

A brief that states a count skips Q1; a brief that names the places skips Q2 (§3). Everything the brief
leaves open is either asked (count, places) or derived (everything else, §6). Keep the brief's own words
for the surface labels when it gives them ("Task thread", "Right panel"); the generator only needs them
to be short.

## 2. Ground the subject in the code

Do this before asking anything. Why: Q2's options must be real usage sites, and Phase 2 of the drawing
(`drawing-phases.md`) needs the flag hook and the API routes that the Today kit must answer. Run from the
repo root; drop test files so the hits are product code.

```sh
rg -l -i "<subject word>" ui/src/components ui/src/pages --glob '!*.test.*'
rg -ln "<ComponentName>\b" ui/src/components ui/src/pages --glob '!*.test.*'
rg -n "use[A-Za-z]*Enabled\(" <component files>
rg -n "useQuery\(|queryFn|queryKeys\." <component files>
rg -n -i "<subject word>" maps/feature-map/*.md
```

- **Component files.** The first grep finds the files that define and render the subject. The second,
  run on each defining component, lists the places it is used; those usage sites are the Q2 options.
  Record whether the hits are under `ui/src/components` or only under `ui/src/pages`; `--group` follows
  from that (§6).
- **Flag hook.** Every experimental flag is read through a `use<Feature>Enabled()` hook in `ui/src/hooks/`
  that queries `queryKeys.instance.experimentalSettings` (`ui/src/lib/queryKeys.ts:614`) through
  `instanceSettingsApi.getExperimental()`, for example `ui/src/hooks/useStreamlinedUiEnabled.ts:27-32`.
  The generated `api-routes.ts` answers that one route from `registry.today.flags`, so the hook name and
  the flag key are all you need to write down.
- **API routes.** Follow each `useQuery`/`queryFn` into `ui/src/api/<module>.ts`. Every path string there
  is appended to `BASE = "/api"` (`ui/src/api/client.ts:5`, used at `:54`), which is why the lab's fetch
  stub can answer them by pathname (`today-fixtures-and-build.md` §3). List the paths; Phase 2 registers
  exactly those.
- **Capability ids.** `scripts/feature-map.mjs:6-10` takes the area from the file stem of each
  `maps/feature-map/<area>.md`; lines `24-31` read every row of the form `` - `key`: ... `` under
  `## Sub-features` and build the id `<area>/<key>`; line `34` enforces `/^[a-z0-9-]+\/[a-z0-9-]+$/`.
  `--capabilities` is validated against that same `featureIndex(root)`, so an id you type must exist as a
  row, not merely read well. Open the area file's `## Sub-features` block and pick the row whose
  description names what the subject does; when no row does, the answer is `[]` (§6).

## 3. The one question call

One `AskUserQuestion` call, at most two questions, placed after §2 and before any file is written. Each
question is dropped when §1 already answered it; when both are answered, no call is made. Headers stay
within 12 characters and each question carries 2-4 options, which is the tool's limit.

**Q1** (skipped when the brief states a count or names the directions)

- `header`: `Directions`
- `question`: "How many directions should the lab explore next to Today? Each direction is a level of
  exploration. Unnamed directions scaffold as 1.Refine (tokens and spacing, same structure), 2.Rework
  (new components, same layout), 3.Rethink (new layout) and are renamed later by hand
  (`lab-anatomy.md` §5 lists the touch points)."
- options: `2` with description "Today + 1.Refine + 2.Rethink"; `3` with description
  "Today + 1.Refine + 2.Rework + 3.Rethink".

**Q2** (skipped when the brief names the places)

- `header`: `Surfaces`
- `question`: "Which product surfaces does <subject> appear on? One tab per place."
- `multiSelect: true`
- options: up to three usage sites from §2, each labelled by the product place and described by the file
  that renders it there (for example "Task list row" / `ui/src/components/IssuesList.tsx`), plus a last
  option "Only one place" described as "<subject> on its primary surface only; no surfaces row". With more
  than three sites, choose the three most distinct product places and name the rest in the closest
  option's description; a surface left out is added by hand later (`lab-anatomy.md` §8).

Two or more selections produce the surfaces row; one selection or "Only one place" produces a
single-surface lab with the legend joined into row 1 (`lab-anatomy.md` §8, last paragraph).

## 4. When no question can be asked

`AskUserQuestion` is not in every harness. When the call is unavailable or the run is non-interactive,
write this sentence in the reply before running anything, then proceed with the §6 defaults:

> Defaulting to three directions and one surface (<surface>) because I cannot ask; change later with
> `scaffold.mjs add-direction`.

`<surface>` is the place the brief names, else the subject's primary surface from §2: the first usage site
under `ui/src/pages` in grep order, else the first under `ui/src/components`. Say which one and why in the
same reply. `add-direction` is the only lifecycle subcommand this version has; removing a direction or
adding a surface is a hand edit (`lab-anatomy.md` §5 and §8), which is why the sentence names only the
move the CLI can make.

## 5. What is never asked

Theme (both palettes ship behind the `t` toggle), animation (always on behind `a`), Today (always present,
always the shipped components on fixtures), ports, slug, landing, title, group, company and capabilities.
Why: each is fixed by the lab contract or derivable from the brief and the grep, and the question call is
the one chance to ask; spending it on a derivable value costs an answer that only Tonio can give.

## 6. Flag derivation table

Run-mode flags (`--dry-run`, `--json`, `--skip-verify`, `--no-build`, `--keep-on-failure`, `--root`) are not
derived; always run `--dry-run` first.

| Flag | Derivation | Default |
|---|---|---|
| `--slug` | kebab-case of the subject noun; the generator adds `-directions` to the directory, html, config, story and launch entries, refuses a slug that already ends in `-directions`, and refuses when any path it would write exists, so run `scaffold.mjs list` first | required |
| `--title` | sentence case of the subject ("Inbox row"); the page title becomes `<Title> directions` | the slug in sentence case (`Agent profile card`) |
| `--surfaces` | `id:Label:width@nav,...`, one per place, 1-6 entries. `id` is a short lowercase word (never `board`), `Label` the brief's own name for the place, rendered as typed (the precedent hyphenates, `Task-thread`; quote the flag for spaces), `width` from the product constant (table below), `nav` one of `tasks`, `artifacts`, `other` (below) | required |
| `--directions` | the stated count or the Q1 answer; `2` or `3`; 4-9 only with `--force-count`, which WARNs | required |
| `--names` | only when the brief names the directions, comma-separated, in order | `Refine,Rework,Rethink`; `Refine,Rethink` for 2; required with `--force-count` |
| `--group` | `Components` when any §2 hit is under `ui/src/components`, `Pages` when every hit is under `ui/src/pages`; `Layouts` and `Patterns` only when the brief says so. The vocabulary is the existing Storybook section order at `scripts/storybook-feature-index.mjs:11` | `Components` |
| `--capabilities` | the validated `<area>/<key>` ids from §2 whose description names what the subject does; when none fits, `[]`, and the story carries the exception sentence `repo-gates.md` §1.4 describes | `[]` |
| `--company` | `name:PREFIX`, fixed so the fixtures and the stub's `/companies` fallback match the precedent (`today-fixtures-and-build.md` §3) | `acmehats:ACM` |
| `--landing` | `auto` picks `d=all&s=board` when cells = (directions + 1) × surfaces ≤ 8, else `d=all&s=<first surface>`; `all`, `today` or a direction id override it | `auto` |
| `--ports` | chosen by the generator: the first `dev,dev+10` pair from `5200/5210` upward in steps of 20 that avoids every port in `.claude/launch.json` (today `3121`, `6016`, `4173`, `5180`, `5190`), `RESERVED_PORTS` in `scripts/lib/ports.mjs:5` and any `ui/node_modules/.vite-*-<port>` cache directory; pass `dev,preview` only to override, and a taken pair is refused | generator |

Widths are product constants, never measured from a screenshot. Re-check the line numbers when you cite
them; three frame comments in the precedent had drifted (`lab-anatomy.md` §8).

| Place | Width | Source |
|---|---|---|
| Task-chat column (thread, composer dock) | `960` | `ui/src/index.css:575` `--tc-shell-max-w: 60rem`, used by `ui/src/components/task-chat/TaskChatComposerDock.tsx:19` and `ui/src/components/TaskChatThread.tsx:3072` |
| Right pane (task detail properties panel) | `434` | `ui/src/components/PropertiesPanel.tsx:88` `TASK_DETAIL_DEFAULT_PANE_WIDTH = 434` |
| Company page body | `1152` | `max-w-6xl` (72rem) at `ui/src/pages/Artifacts.tsx:248`; the same class caps `ui/src/pages/PluginManager.tsx:192` and `ui/src/pages/Secrets.tsx:1808` |
| A place with no `max-w-*` on its wrapper (the inbox list fills the main column; `ui/src/pages/Inbox.tsx` sets none) | `960` | the default; say in the reply that the width is the default, not a product constant |

`nav` takes `tasks`, `artifacts` or `other` (`scripts/lib/context.mjs:5`); the generated `AppShell` highlights only
Tasks (`ui/src/components/Sidebar.production.tsx:182`, route `/issues`) or Artifacts (`:196`). A place under
Inbox (`:156`) or Agents (`ui/src/components/Sidebar.tsx:273`) takes `other` and gets its highlight by hand in
Phase 1 (`drawing-phases.md` §1).

## 7. The three eval briefs as flag lines

Each case under `.agents/skills/directions-lab/evals/<name>/prompt.md` exercises one intake path. Read the
prompt, then compare with the line below.

**multi-surface-three-directions** - the brief states 3 and names two places, so no question is asked.
Subject "task composer" → `composer`. The grep finds `ui/src/components/task-chat/TaskChatComposer.tsx`,
rendered at the bottom of the thread by `ui/src/components/TaskChatThread.tsx:3305` inside the dock
(`TaskChatComposerDock.tsx:19`, width 960); the thread is `IssueChatThread` or `TaskChatThread`, chosen at
`ui/src/pages/IssueDetail.tsx:1473-1474` and mounted at `:2519`. The product has no chat tab in the right
panel: the 434px pane (`PropertiesPanel.tsx:88`) carries `Properties | Plan | Artifacts` (`:72`), so the
panel surface comes from the brief alone and its frame follows the precedent's `PanelFrame`.
The flag hook is `useStreamlinedUiEnabled` (`TaskChatThread.tsx:495`). `maps/feature-map/tasks.md:21`
`tasks/discussion` ("persist comments, references, and files on the task") is the row that names what a
composer does. Group `Components`. Cells 4 × 2 = 8, so the landing is the board.

```sh
node .agents/skills/directions-lab/scripts/scaffold.mjs new --slug composer --title Composer \
  --surfaces thread:Task-thread:960@tasks,panel:Right-panel:434@tasks --directions 3 \
  --capabilities tasks/discussion --dry-run
```

**single-surface-two-directions** - the brief states 2 and one place ("on the inbox page"), so no question
is asked. Subject "inbox row" → `inbox-row`, title `Inbox row`. The row is `IssueRow` from
`ui/src/components/IssueRow.tsx`, imported at `ui/src/pages/Inbox.tsx:87` and rendered at `:2851`; the
inbox list has no width cap, so 960 is the stated default; the shell highlights neither Tasks nor Artifacts
there, so nav is `other`. Group `Components` (the row lives under `ui/src/components`).
`maps/feature-map/inbox-search.md:17` `inbox-search/views` names the views the row lists; add
`inbox-search/triage` (`:18`) only when the brief includes the archive affordance. Cells 3 × 1 = 3.

```sh
node .agents/skills/directions-lab/scripts/scaffold.mjs new --slug inbox-row --title "Inbox row" \
  --surfaces inbox:Inbox:960@other --directions 2 --capabilities inbox-search/views --dry-run
```

**asks-how-many-directions** - "make me a directions lab for the agent profile card" states neither a count
nor a place, so Q1 and Q2 are asked in one call. No file is named `*ProfileCard*`; the grep lands on
`ui/src/components/AgentIdentity.tsx:3`, `AgentCapsule.tsx:88` and `AgentAvatar.tsx`, used from
`ui/src/components/IssuesList.tsx`, `KanbanBoard.tsx`, `task-chat/TaskChatBubble.tsx`,
`issue-properties/IssueProperties.tsx`, `ActiveAgentsPanel.tsx` and more, so Q2 offers three of those
places plus "Only one place" and names the rest in the descriptions. No row under
`maps/feature-map/agents.md:15-27` describes an identity card, so capabilities are `[]` with the exception
sentence. Without the question tool, the §4 sentence is written and the lab is 3 directions × 1 surface:

```sh
node .agents/skills/directions-lab/scripts/scaffold.mjs new --slug agent-profile-card \
  --title "Agent profile card" --surfaces list:Task-list:960@tasks --directions 3 --dry-run
```

With answers, `--directions` takes the Q1 value and `--surfaces` gains one entry per selected place.

## 8. State every derived value before `new`

Before the real `new`, the reply lists, in this order: slug and title; each surface as `id:Label:width@nav`
with the width's source line; the direction count and names; the group; the capability ids with the row
each came from, or `[]` and the exception; the landing and cell count; the flag hook and API paths the
Today kit will need; the `--dry-run` output. Then run `new` and quote its `--json` output.

Why this is not optional: this version of the generator has `new`, `check`, `add-direction` and `list`
only. There is no rename, no add-surface and no stage, so a wrong slug, width, surface list or capability
after `new` means removing the lab directory, its html, its vite config, the two launch entries, the
`.gitignore` line and the story by hand before trying again. The story meta id `design-<slug>-directions`
is permanent once catalogued (`design-proposals-storybook.md` §4). An unknown capability is refused before
any file is written (`scripts/lib/capabilities.mjs`); the catalog check, the lab's Vitest files and the Vite
build run after the write and roll everything back on failure. A derived value stated in prose costs Tonio
one line to correct; the same value baked into files costs a rollback.
