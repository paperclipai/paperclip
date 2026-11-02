---
name: directions-lab
description: Scaffold a directions lab that shows shipped UI (Today) beside 2-3 design directions, with surface tabs, theme and animation toggles and the V1 MVP hover motion, registered in design-proposals Storybook. Use for a directions page or lab, or to explore design directions next to production.
---

# Directions lab

A directions lab is how design explorations are made in this repo: one page,
one feature, Today plus two or three directions, every surface the feature
appears on, and the same controls every time, so a shared link reads the same
to everyone. The artifact directions lab (`ui/src/artifact-directions`) is the
precedent and stays the frozen reference; this skill generates new labs in the
same shape without redrawing the plumbing by hand.

## What you are making

- **The page.** `ui/<slug>-directions.html` plus `ui/src/<slug>-directions/`,
  a second Vite entry with no backend. All state lives in the URL
  (`?d=&s=&theme=&chrome=&anim=`, plus `proposal=1` for the proposal palette).
  A registry module is the single source for the direction ids, digit keys,
  labels, surfaces, landing view and story id; the toolbar, keyboard, overview
  board and capture script read it at runtime, and `add-direction` keeps the
  story's per-direction export in step, so a direction is one registry entry
  plus one directory.
- **The toolbar.** Row 1 is the directions row: the numbered directions then
  `0.Today` last, as a segmented control, with Theme and Animation
  right-aligned. Row 2 is the surfaces row: Overview plus one tab per surface.
  Row 2 is written only when the lab is scaffolded with more than one surface
  (a surface added later to a one-surface lab needs row 2 by hand,
  `references/lab-anatomy.md` section 8); with one surface the keyboard legend
  joins row 1. Nothing else goes in the header.
- **Today.** Always present, always `0.Today`, always the shipped components
  mounted on the lab's fixtures through small adapters and a fetch stub. It is
  the control every direction is judged against, so it is never a redraw.
- **The directions.** Two or three, numbered, each a self-contained kit
  directory with its own scoped `tokens.css`. Every direction carries the V1
  MVP motion block verbatim and a test that proves it, so hover feels the same
  across labs. Read `references/motion-spec.md` before touching any of it.
- **The directory entry.** One story file under
  `ui/storybook/stories/design-proposals/` with a stable id, catalogued as a
  proposal. The design-proposals Storybook is becoming the canonical directory
  of the design system; a lab exists there from its first commit.

Hard rules, because the repo's gates enforce them and reviewers expect them:
no code comments in anything you commit, no file of 600 lines or more in a lab
(`check` refuses at 600), no
`package.json` script, no lockfile change, no screenshots or generated catalog
files in the repo.

## Before you start

Run from the repo root on a branch of your own (`claude/<slug>-directions`,
from `origin/master`). Check that `ui/node_modules/.bin/vite` exists; if not,
`pnpm install --frozen-lockfile`. Then run the generator's own tests:

```sh
node --test .agents/skills/directions-lab/scripts/scaffold.test.mjs
```

Red here usually means a template or the motion asset has drifted from the
precedent (`ui/src/artifact-directions/directions/d5-v1-mvp/tokens.css`); two
cases also read the real feature map and the catalog script, so a changed
feature-map row or catalog message shows up here too. Fix the generator before
scaffolding anything; a lab built on a stale template fails later in ways that
look like your drawing.

## Read the brief, then ground the subject

Extract four things from what Tonio wrote: the subject (its slug and title),
the places it appears (one surface per place), a stated count or names of the
directions, and any flag or component names. Then look at the code before you
ask anything:

```sh
rg -l "<Subject>" ui/src/components ui/src/pages
rg -n "<subject word>" maps/feature-map/*.md
```

The first grep gives the component files, the flag hook
(`use<Feature>Enabled`), and, by following `useQuery`/`queryFn` into
`ui/src/api/*`, the `/api/` routes Today must answer. The second gives the
capability ids the story cites. This grounding is what makes the surfaces
question specific instead of generic. `references/questions-and-defaults.md`
has the full extraction and derivation tables.

## Ask, in one call

Ask at most two questions, in a single `AskUserQuestion` call, and skip each
one the brief already answers:

1. **How many directions?** Options `2` and `3`. Say in the question that
   three unnamed directions scaffold as `1.Refine` (tokens and spacing, same
   structure), `2.Rework` (new components, same layout) and `3.Rethink` (new
   layout), two as `1.Refine` and `2.Rethink`, and are renamed later. Skip
   when the brief states a count or names the directions.
2. **Which surfaces?** Multi-select from the usage sites the grep found, plus
   "only one place". Two or more selections produce the surfaces row. Skip
   when the brief names the places.

Never ask about theme, animation, Today, ports, the slug or the landing view;
those are fixed by the skill. When no question can be asked (a headless run),
write this before doing anything else, then proceed: "Defaulting to three
directions and one surface (<surface>) because I cannot ask; change later with
`scaffold.mjs add-direction`."

## State what you derived, then scaffold

Before running the generator, state every derived value in your reply: slug
and title, each surface as `id:Label:width@nav` with the line the width comes
from, the direction count and names, the group, the capabilities with their
feature-map rows (or `[]` and the exception sentence), the flag hook and the
`/api/` paths Today will need. A wrong slug or capability is cheap to catch
here and expensive after files exist. Then:

```sh
node .agents/skills/directions-lab/scripts/scaffold.mjs new \
  --slug composer --title "Composer" \
  --surfaces thread:Task-thread:960@tasks,panel:Right-panel:434@tasks \
  --directions 3 --dry-run
```

Read the plan (paths, ports, cells, story), drop `--dry-run`, and run it.
`new` renders everything in memory, refuses existing paths, writes the lab,
the html entry, the Vite config, the story file, two `.claude/launch.json`
entries and one `.gitignore` line, then verifies: the Storybook catalog check,
the lab's own Vitest files, and a Vite build. On any failure it deletes what
it wrote and restores the two shared files, so a half-written lab never
breaks `pnpm test` or `tsc -b` for the whole repo (`ui/vitest.config.ts` has no
include filter and `ui/tsconfig.json` includes all of `src`). Quote the
`--json` output in your reply.

`--surfaces` takes `id:Label:width@nav` per place, where `nav` is the sidebar
item the shell highlights (`tasks`, `artifacts` or `other`) and the width is the
product's own constant for that place (see `references/questions-and-defaults.md`).
Flags you will use: `--names a,b,c` for stated names, `--group
Components|Pages|Layouts|Patterns` (Components when the grep hits
`ui/src/components`), `--capabilities area/key,...` (validated against
`maps/feature-map`; omit for `[]` plus an exception sentence), `--company
name:PREFIX` (default `acmehats:ACM`), `--landing auto|all|today|<id>`,
`--ports dev,preview` (the generator picks free ones), `--keep-on-failure` to
inspect a failed scaffold.

## Look at it

Start the dev entry the generator added, `preview_start
{name: "<slug>-directions-dev"}`, and open three URLs: `/` (the landing),
`/?d=today&s=<first surface>` and `/?d=<first direction id>&s=<first surface>`
(`d1-refine` when the directions are unnamed). Confirm
`document.documentElement.dataset.labAnim === "1"`, hover a motion specimen
and watch the front rise and the two pages turn, press `a`, hover again and
see only the fill change. Read the console for `[<slug>-directions] unhandled`
lines: each one is a route Today will need. The overview board and the
capture script never show the movement (iframes take no pointer; stills ask
for reduced motion; `--hover` records one hovered frame, not the transition),
so the transition is verified only this way.

## Commit the scaffold, then draw

Commit the untouched scaffold first as `feat(ui): scaffold the <title>
directions lab`. Reviewers then see the redraw as its own diff, not buried
under plumbing. Draw in this order; `references/drawing-phases.md` has the
done-when for each:

1. **Frames.** Replace each `data-lab-stub="frame-<surface>"` region with the
   product chrome around that place: copy the product's class strings, freeze
   the registry width, reuse presentational primitives, let nothing scroll
   internally. The precedent frames show how (`ThreadFrame`, `PanelFrame`,
   `GalleryFrame`, `AppShell`).
2. **Fixtures and Today.** Retype the per-surface data in `kit.ts` to the
   props each place receives, fill `fixtures.ts`, mount the shipped component
   in `directions/today/<Pascal>Body.tsx` (PascalCase of the surface id, so
   `ThreadBody.tsx` for `thread`) through `adapters.ts`, and register exactly
   the routes it fetches inside `registerFeatureRoutes()` in `api-routes.ts`.
   Today is done when it matches the product on the same data and its test
   passes with the real component.
3. **Directions.** One at a time: replace the motion specimen with the
   drawing, keep the hook names (`data-front` on every treatment branch,
   `data-rotate` and `data-spread` with the inline base angle), put every raw
   value in that direction's `tokens.css` (light base, `.dark` override), and
   leave the motion block alone. Run `scaffold.mjs check --slug <slug>` after
   each phase.

Phase 2 comes before 3 because the slot props change shape in phase 2 and
every kit follows the type.

## Capture

```sh
node ui/src/<slug>-directions/shot.cjs --port <dev> --d all --out <scratch dir>
```

Captures are rest states at 1440×900, DPR 2, both themes; attach the PNGs to
the PR, never to the repo. `--hover` adds a rest/hover pair per direction from
a second browser context that allows motion; the browser pane with the Animation
toggle on is still the only place to judge the motion itself.

## Hand off

```sh
node .agents/skills/directions-lab/scripts/scaffold.mjs check --slug <slug> --strict --run
```

`--strict` refuses any remaining `data-lab-stub` marker; `--run` runs the
lab's tests, the catalog check, the token gates, a Vite build of the lab and
`cd ui && pnpm typecheck`, stopping at the first failure, and prints a
`## Verification` block whose `Not run:` lines name what stays manual
(`pnpm build-storybook`, the repo-wide typecheck); `--json` returns the same
results as data, with those items under `notRun`. Open the PR with every
section of `.github/PULL_REQUEST_TEMPLATE.md` filled, the linked-issue path B
with three filled feature-request labels, the story id, the launch entries
and the Vercel alias if you deployed. Offer the DESIGN.md directory row as
text in the PR body; never apply it from a lab PR.

If the skill itself is in your diff, force-add it: `/.agents/` is git-ignored
and the repo's tracked skills were added with `git add -f`.

## Storybook and the design directory

`new` writes `ui/storybook/stories/design-proposals/<slug>-directions.stories.tsx`
with meta id `design-<slug>-directions`, title `Design proposals/<Group>/<Title>
directions/Compare`, a literal `parameters.paperclip` block (`status:
"proposed"`, `home: "design-proposals"`, `implementation: "prototype"`,
`boundary: "fixtures"`, capabilities, exception, notes) and stories Compare,
Today, one per direction, and `TodayProductionPalette` (the decorator themes
the whole iframe with the proposal palette; this one opts out so Today can be
seen as shipped). The page itself renders the production palette by default;
`?proposal=1` wraps it in the proposal theme for a side-by-side with the entry.
The catalog script validates all of it at Storybook start, in
`cd ui && pnpm typecheck` and in CI.

The lifecycle a direction moves through, and what to edit by hand at each
step, is in `references/lifecycle.md`: proposed (what `new` writes), adopted
(product code behind an experimental setting, with a feature-home story),
current (flag removed), historical (retired with a `replacement`, moved out of
the proposals folder keeping its id). Today the catalog forces every entry in
the proposals folder to stay `proposed`; the governance change that would let
the directory carry `current` entries is written up as paste-ready diffs in
`references/canonical-directory.md`. Offer it once, as its own PR, only when
Tonio says yes.

## Later asks

- Add a direction: `scaffold.mjs add-direction --slug <slug> --name <Name>`
  (next digit, registry entry, kit directory with the motion block and a
  specimen, the story's `D<N>` export, then `check`, rolling back on failure).
  The toolbar legend follows the registry at runtime. The generator refuses a
  fourth without `--force-count`, which also records `allowMore` in the
  registry; the story description's "1–N" sentence is the one thing to
  update by hand. Once phase 2 has retyped the slot props in `kit.ts`,
  `add-direction` refuses and prints the by-hand steps instead, because a
  generated kit would not fit the new props.
- List labs: `scaffold.mjs list`.
- Rename a direction, add a surface, or move a direction through the
  lifecycle: by hand, following `references/lab-anatomy.md` section 5 and 8
  and `references/lifecycle.md`.
- Publish: build with `<SLUG>_DIRECTIONS_OUT_DIR=<dir>/paperclip-<slug>-directions`,
  remove `sw.js` from the output, `vercel deploy <that dir> --prod --yes` from
  its parent; the basename names the project and the alias is the public URL.
  `references/today-fixtures-and-build.md` section 11 has the details.

## Do not

- Run two full `ui` Vitest suites at once; run the lab's files alone.
- Land on `d=all&s=board` from a dev server with more than eight cells; use
  the static launch entry (`<slug>-directions`) for the full board.
- Copy the artifact lab's `html:not(.dark)` token idiom; new labs put light
  values in the base block and dark ones under `.dark [data-direction=…]`.
- Edit the motion block in a lab. A different rise or fan is Tonio's decision.
- Add comments, `package.json` scripts, lockfile changes, PAP ids or localhost
  URLs to anything that goes in the PR.

## Maintaining the skill

The generator's templates were derived from the precedent at the commit
recorded in `assets/PRECEDENT`. `scripts/scaffold.test.mjs` pins the generated
structure and asserts the motion asset still equals the precedent's block
after substitution; when the precedent changes, re-derive the template and
bump the pin. `references/generator.md` explains the template conventions
and the context object.

## References

| File | Read it when |
| --- | --- |
| `references/questions-and-defaults.md` | Before asking; derivation tables, eval prompts as flag lines |
| `references/lab-anatomy.md` | Drawing frames or changing the toolbar, state or board |
| `references/today-fixtures-and-build.md` | Mounting Today, the fetch stub, build, capture, deploy |
| `references/motion-spec.md` | Any hover motion; the per-direction checklist |
| `references/drawing-phases.md` | After the scaffold, phase by phase |
| `references/design-proposals-storybook.md` | The story file, the catalog gate, the theme |
| `references/lifecycle.md` | Adopting, shipping or retiring a direction |
| `references/canonical-directory.md` | Only when Tonio approves the governance PR |
| `references/repo-gates.md` | Before the PR |
| `references/generator.md` | Changing the generator |
