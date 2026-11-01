# Design-proposals Storybook - registering a lab and graduating a direction

For the agent scaffolding a new directions lab under `ui/storybook/stories/design-proposals/`. Line numbers confirmed at `5e26b733b`; re-check after the cited files change. Working directory: repo root.

## Contents

1. The catalog gate
2. The proposal theme
3. Precedent: the two artifact lab stories
4. The story file `new` writes
5. Lifecycle: proposed, adopted, current, historical
6. Source-of-truth note

## 1. The catalog gate

`scripts/storybook-catalog.mjs` stands between a story file and the sidebar. It parses every
`ui/storybook/stories/**/*.stories.(ts|tsx|mdx)` with Storybook's CSF parser and never executes the
module (lines 61-67). It reads only the default-export meta's `parameters` (line 46).

Rules for a story homed in `design-proposals`:

- Explicit static meta `id` (109: "explicit meta ID is required"). Folder convention `design-<slug>`
  (18 of 20 files). Story ids are `<meta id>--<kebab-case export name>`; `name` does not change them.
- `title` starts `Design proposals/` (17, 106-108), then `<Group>/<Suite>`. Group vocabulary
  (`maps/storybook-map/README.md:62-65`, `DESIGN.md:299-301`): Foundations, Components, Layouts,
  Pages, Patterns, Guidelines, in that order. The pinned sort order in
  `scripts/storybook-feature-index.mjs:11` adds "AI Generated Test Pages" between Pages and Patterns
  and is asserted by `scripts/storybook-feature-index.test.mjs:19`. An unlisted group (today
  "Artifact directions") validates and sorts after Guidelines in file-discovery order; to pin a lab
  group, extend line 11 and the test, never the generated `preview.tsx`. No empty groups (`README.md:65`).
- File path starts `ui/storybook/stories/design-proposals/` (107). Subfolders pass: `files()`
  recurses (19-24) and the check is `startsWith`.
- Exactly one literal `parameters.paperclip` on the meta (45-59): `parameters` is an object literal
  (47) with one `paperclip` key (49), non-computed (51), and no `...spread` or `[computed]` key after
  it (52-53), so put it last. Values are string, boolean, number, array or object literals; `as` and
  `satisfies` wrappers are unwrapped (26-43). Template literals, identifiers, calls and `null` throw
  "metadata must be literal; expressions are not executed". To omit a key, leave it out.
- Closed field set (16): `capabilities`, `status`, `implementation`, `boundary`, `notes`, `home`,
  `exception`, `replacement`. Any other key throws "unknown paperclip field <key>" (57).
- Enums (13-15): status `current | proposed | historical | mixed | unreviewed`; implementation
  `production | prototype | mixed | guide | unreviewed`; boundary `fixtures | fixture-server | static |
  unreviewed`. Omitted status, implementation and boundary default to `unreviewed`, notes to `""` (77).
- `capabilities` is required even as `[]` (94); every id must exist in the feature index (102), no
  duplicates (104), and `[]` needs an `exception` (103). Ids are `<feature>/<key>` from the
  `## Sub-features` bullets of `maps/feature-map/<feature>.md` (`scripts/feature-map.mjs:28,34`;
  example `maps/feature-map/documents-artifacts.md:17-21`). No `design-proposals/*` capability or
  recipe exists (145). Adding a capability means editing the recipe and its agent-access companion,
  then `node scripts/check-maps.mjs`; `generateStorybook` aborts on map errors first (184-185).
- `home` may only be `foundations` or `design-proposals` (95). `home: "design-proposals"` forces
  `status: "proposed"` (99) and a nonempty `exception` (96, 100);
  `scripts/storybook-catalog.test.mjs:101-115` asserts current, mixed, unreviewed and historical fail.
- Uniqueness (112-114): meta ids unique among meta ids; story ids unique among story ids plus the
  generated `feature-map-<featureId>--overview`. Avoid a `feature-map-` prefix by convention.
  `replacement`, when present, names an existing story file (110).

Two failure modes: `annotation()` and `literal()` throw and abort the whole scan (26-59), so
Storybook does not start and `tsc` never runs; `validateCatalog` collects errors and throws them
joined (83-116, 189-190). A `.mdx` file passes the filename filter (64) but the parser throws a raw
Babel error: emit TSX only, prose goes in `parameters.docs.description.component`. Only the meta
block counts: a story-level `parameters.paperclip` is ignored, and a file whose only block is
story-level fails "declare parameters.paperclip as literal metadata" (47) when the meta has no
`parameters`, else "expected one parameters.paperclip annotation" (49). Storybook merges story
parameters at runtime, so a story-level block still reaches the theme decorator (section 2).

How it runs:

- Storybook start and build: `ui/storybook/.storybook/main.ts:10` calls `generateStorybook()`.
- `cd ui && pnpm typecheck` is `node ../scripts/storybook-catalog.mjs && tsc -b`
  (`ui/package.json:23`): write mode, then `tsc` over `src` and `storybook` (`ui/tsconfig.json:19`).
- CI: `.github/workflows/pr-trusted.yml:332-333` runs `pnpm run typecheck:build-gaps`
  (`package.json:25`); `scripts/run-typecheck-build-gaps.mjs:143-149,181-182` typechecks every
  workspace whose `build` script lacks `tsc`, and `ui` builds with `vite build` (`ui/package.json:18`).
  `release-verify.yml:118` and `docker-runner-check.yml:271` run `pnpm -r typecheck`.
- `pnpm test` runs `ui/storybook/map-tooling.test.ts:5-11`, which shells out to `node --test
  scripts/check-maps.test.mjs scripts/storybook-catalog.test.mjs scripts/storybook-feature-index.test.mjs`.
  Those are fixture-based: they prove the checker, not your story, which only the paths above and `--check` validate.

`--check`: `node scripts/storybook-catalog.mjs --check` validates without writing (202-206). It still
runs `checkMaps` and resolves `storybook/internal/csf-tools` through `ui/package.json` (62-63), so
`pnpm install` comes first. Current output, exit 0: `Storybook map: 316 files, 2973 stories. Structure
only; no runtime proof.` Every failure above is an uncaught throw: exit 1, stack on stderr, no summary
line. Any flag other than `--write` or `--check`, or two flags, throws a usage error (204).

Every generated output is git-ignored and never committed: `ui/storybook/generated/`,
`ui/storybook/.storybook/preview.tsx`, `maps/generated/`, `ui/storybook-static/` (`.gitignore:11-14`;
`README.md:86-90`). Add decorators and fixtures to `preview-base.tsx` only. Do not record review state
in the annotation: `fingerprint` fails as an unknown field (`storybook-catalog.test.mjs:49-50`), as
`reviewedAt` would (16, 57); evidence goes in the PR (`README.md:107-113`).

## 2. The proposal theme

One decorator, `ui/storybook/.storybook/preview-base.tsx:843-857`. Line 853, verbatim:

```tsx
{context.parameters.paperclip?.home === "design-proposals" && context.parameters.designProposalTheme !== false ? <AvatarInitialProvider><div className="design-proposal-theme"><Story /></div></AvatarInitialProvider> : <Story />}
```

Opt out per meta or per story with `parameters: { designProposalTheme: false }`. The parameter exists
only in that line (no doc names it); its one user is the `TodayProductionPalette` export the generator
writes (section 4). Opting out also drops
`AvatarInitialProvider`, the single-initial fallback-avatar rule for proposals (`DESIGN.md:305-308`).

All proposal CSS lives in `ui/src/index.css` in additive blocks keyed on the marker:
`html:has(.design-proposal-theme)` 3916-3933 and 3938-4091 (conversation typography),
`html.dark:has(.design-proposal-theme)` 4097-4111, `html:not(.dark):has(...)` 4114-4120, element rules
4121-4144 (body and `#storybook-root` fill 4123, inputs 4124-4125, focus 4129-4140, cards 4141-4144),
group labels 4508-4509, canonical toolbar 4625-4698 and 4767. The scope is `html:has(...)`, so the
marker anywhere re-themes the whole iframe including Radix portals (comment 4093-4096); a column-wise
production-vs-proposal split inside one themed story is impossible. Either opt out and scope a
direction's tokens to `[data-direction="<id>"]` (section 3), or theme every column. Adopting a theme
value means lifting it out of the scoped block into `:root` or `.dark` and deleting it there;
"removing the story marker restores the existing production theme" (4095-4096).

What the theme changes: `--font-mono` and `--default-mono-font-family` become `--font-paper-mono`
(Paper Mono; `@font-face` 126-132, token 214); `--font-weight-medium` collapses to normal and
`--font-weight-bold` to semibold; `--text-micro` aliases `--text-xs` (3917-3922). In dark mode the
Paper palette applies: `--background: #1a1a1a`, `--muted-alt: #202020`, card and popover equal
background, `--accent` from `--muted-highlight`, `--input` from `--border`, `--ring` from
`--foreground` (4098-4110). Light inherits production colors and only aliases `--muted-alt` and four
`--design-sidebar-*` names (4115-4119). No radius changes.

Light and dark come from the toolbar global `theme` (default `dark`, 858-872), applied as `.dark` on
`<html>`. Pin per story with `globals: { theme: "light" }`
(`ui/storybook/stories/design-proposals/bulk-agent-settings.stories.tsx:33`). Proposals follow the
toolbar and never lock a mode (`DESIGN.md:150-151`). The backgrounds addon is disabled (878-880).

Global for every file: `a11y: { test: "error" }` (875-877) with `@storybook/addon-a11y` (`main.ts:25`),
so an axe violation in any direction fails the a11y run; override per story, never in `preview-base`.
`docs: { autodocs: true }` (`main.ts:30-32`) plus `docs.toc` (888-890): every file gets a Docs page from
`parameters.docs.description.component`. Opt-out precedents: `tags: ["!autodocs"]`
(`scripts/storybook-feature-index.mjs:49`) and `docs: { story: { inline: false } }` (`buttons.stories.tsx:23`).

Viewport presets (892-908): `mobile` 390x844, `tablet` 834x1112, `desktop` 1440x960, plus
`MINIMAL_VIEWPORTS` (`mobile1` 320x568, `mobile2` 414x896). Select with
`globals: { viewport: { value: "mobile", isRotated: false } }`; add `parameters.waitForViewport: true`
to defer mounting until the iframe has that width (847-850). Declare a custom width per story in
`parameters.viewport.options` (`ui/storybook/stories/documents-artifacts/rich-work-product-cards.stories.tsx:249-253`).
`parameters.initialEntries` seeds the MemoryRouter (default `/PAP/storybook`).

## 3. Precedent: the two artifact lab stories

Both live in `ui/storybook/stories/design-proposals/`, import the lab from `ui/src/artifact-directions/`
through the `@` alias (`main.ts` maps `@` to `ui/src`), and share one classification: `status: "proposed"`,
`home: "design-proposals"`, `implementation: "prototype"`, `boundary: "fixtures"`, capabilities
`documents-artifacts/library`, `documents-artifacts/work-products`, `documents-artifacts/attachments`.

`artifact-directions-compare.stories.tsx`: id `design-artifact-directions-compare`, title
`Design proposals/Artifact directions/Compare` (38-40). `exception` (56): "Design exploration staged
in the artifact directions lab: the shipped baseline and five proposed directions compared on static
mocks of the task thread, the side panel and the Artifacts page." `notes` (57) end "nothing here
establishes production behaviour or access checks." Mount (21-36): `DirectionView({ direction, view })`
holds `useState<DirectionKit | null>`; a `useEffect` keyed on `direction` calls `installApiStub()`
(`@/artifact-directions/api-stub`, ref-counted, returns a restore function; `api-stub.ts:50-71`), then
`loadKit(direction)` (an `import.meta.glob` over `directions/*/index.tsx`, `kit.ts:157-163`), and
restores fetch in the cleanup. It renders `<KindsSheet kit>` or `<SurfaceView kit surface>`
(`frames/SurfaceView.tsx:9-31`; surfaces `thread | panel | gallery | stack`). Controls (60-73):
`direction` is a select over `DIRECTION_IDS` with `labels` from `KIT_META[id].name`
(`kit.ts:130,143-150`); `view` is a select over `[...SURFACE_IDS, "kinds"]`; default
`{ direction: "d4-hybrid", view: "gallery" }`. One export, `AnyDirection`, named "Any direction, any
surface" (79). The stub exists because the `today` kit mounts shipped components that fetch `/api/`;
it layers over Storybook's own fetch fixtures (`preview-base.tsx:95,785-788`). The generator's story
template (`assets/templates/stories/compare.stories.tsx.mjs`) is this file parameterised (section 4).

`artifact-directions-hybrid.stories.tsx`: id `design-artifact-directions-hybrid`, title
`Design proposals/Artifact directions/4.Hybrid` (27-29; the suite name is the `KIT_META` name).
Static `import { kit as hybrid }` (3); meta is `satisfies Meta` with no `component` (48). Four
`Surface · ...` exports render `<SurfaceView kit={hybrid} surface=... />` (56-74); `Kinds` renders
`<KindsSheet>` (76-79). Five `Slot · ...` exports wrap one kit slot in `Stage` (87-95):
`<div className="min-h-screen bg-background p-6 text-foreground">` around `<Slot kit={hybrid}>`
(`frames/Slot.tsx:8-14` emits `data-direction={kit.id}`, which scopes a kit's `tokens.css`) at
product widths 960, 1152 and `TASK_DETAIL_PANE_WIDTH - 32` (84-85, 139-140). A slot with its own
Controls is typed `StoryObj<SlotArgs>` with local `args` and `argTypes` (105-125). No stub: lab-only
kits do not fetch.

Classification rule: a lab is `implementation: "prototype"` even when one direction mounts production
primitives ("A prototype that imports production primitives remains a prototype of its outer subject",
`README.md:46-47`), and `boundary: "fixtures"` because frames are static mocks on fixture data. A kit's
`tokens.css` is tolerated as lab code: the token gate scans only `ui/src/components` and `ui/src/pages`
(`scripts/check-token-gates.mjs:79-80`), but `DESIGN.md:17` forbids a second token source, so adoption
converts kit tokens into `index.css` tokens.

## 4. The story file `new` writes

File: `ui/storybook/stories/design-proposals/<slug>-directions.stories.tsx`, rendered by
`node .agents/skills/directions-lab/scripts/scaffold.mjs new` from
`assets/templates/stories/compare.stories.tsx.mjs`; `<...>` marks what the flags fill. Every `paperclip`
value is emitted with `JSON.stringify`, so it stays a plain double-quoted string literal. The id is
`design-<slug>-directions` (`registry.storyId`), chosen once; it is permanent.

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { installApiStub } from "@/<slug>-directions/api-stub";
import "@/<slug>-directions/api-routes";
import { DIRECTION_IDS, KIT_META, SURFACE_IDS, loadKit, surfaceOf, type DirectionId, type DirectionKit, type SurfaceId } from "@/<slug>-directions/kit";
import { SurfaceView } from "@/<slug>-directions/frames/SurfaceView";

type Args = { direction: DirectionId; surface: SurfaceId; animation: boolean };

function DirectionView({ direction, surface, animation }: Args) {
  const [kit, setKit] = useState<DirectionKit | null>(null);
  useEffect(() => {
    const restoreFetch = installApiStub();
    let live = true;
    loadKit(direction).then((loaded) => {
      if (live) setKit(loaded);
    });
    return () => {
      live = false;
      restoreFetch();
    };
  }, [direction]);
  useEffect(() => {
    const previous = document.documentElement.dataset.labAnim;
    if (animation) document.documentElement.dataset.labAnim = "1";
    else delete document.documentElement.dataset.labAnim;
    return () => {
      if (previous === undefined) delete document.documentElement.dataset.labAnim;
      else document.documentElement.dataset.labAnim = previous;
    };
  }, [animation]);
  if (!kit) return null;
  return <SurfaceView kit={kit} surface={surface} />;
}

const meta = {
  id: "design-<slug>-directions",
  title: "Design proposals/<Group>/<Title> directions/Compare",
  component: DirectionView,
  argTypes: {
    direction: { control: { type: "select" }, options: DIRECTION_IDS, labels: Object.fromEntries(DIRECTION_IDS.map((id) => [id, KIT_META[id].name])), description: "Which direction's kit renders." },
    surface: { control: { type: "select" }, options: SURFACE_IDS, labels: Object.fromEntries(SURFACE_IDS.map((id) => [id, surfaceOf(id).label])), description: "Which product surface." },
    animation: { control: { type: "boolean" }, description: "The lab's hover-motion toggle (html[data-lab-anim])." },
  },
  args: { direction: "today", surface: "<first surface id>", animation: true },
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "Pick a direction and a surface. 0.Today mounts the shipped <Title> components on the lab's fixtures; 1–<n> are the explored directions. Page: https://paperclip-<slug>-directions.vercel.app." } },
    paperclip: {
      capabilities: ["<area>/<key>"],
      status: "proposed",
      home: "design-proposals",
      implementation: "prototype",
      boundary: "fixtures",
      exception: "Design directory entry for <Title>: the shipped baseline and <n> proposed directions compared on static mocks of <surface labels>.",
      notes: "Controls pick a direction kit and a surface. Today mounts the shipped <Title> components behind the lab's fetch stub with the <company> fixture world; the other kits are lab components. Frames are static mocks of the product chrome; nothing here establishes production behaviour or access checks.",
    },
  },
} satisfies Meta<typeof DirectionView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Compare: Story = { name: "Any direction, any surface" };
export const Today: Story = { name: "0.Today", args: { direction: "today" } };
export const D1: Story = { name: "1.<Name>", args: { direction: "d1-<name>" } };
export const TodayProductionPalette: Story = { name: "0.Today · production palette", args: { direction: "today" }, parameters: { designProposalTheme: false } };
```

One `D<N>` export per direction, named `1.Refine`, `2.Rework`, `3.Rethink` unless `--names` says otherwise
(two directions: Refine, Rethink). No light variants are emitted; the visual suite shoots both themes.

Rules the file encodes:

- `capabilities`: `--capabilities <area>/<key>,...`, validated against the `## Sub-features` of
  `maps/feature-map/<area>.md` through `scripts/feature-map.mjs` (`lib/capabilities.mjs:35-48`); the first
  entry is primary and decides the folder on retirement (section 5, item 7). Omit the flag for cross-cutting work: the story
  then carries `capabilities: []` and the exception sentence (the generator says so on stderr), the
  Foundations precedent being `colors.stories.tsx:14-17` ("Shared color foundation: production light
  palette and proposed Paper dark palette. This does not establish production feature coverage.").
  `developer-labs/design` (`maps/feature-map/developer-labs.md:17`) is what `buttons.stories.tsx` cites
  for a sandbox inventory.
- `exception` reads as a stand-alone sentence: it fills the Capabilities column of
  `maps/generated/storybook.md` when `capabilities` is empty (`storybook-catalog.mjs:152`). The generated
  one is "Design directory entry for <Title>: the shipped baseline and <n> proposed directions compared on
  static mocks of <surface labels>." (`lib/context.mjs:162`). Other house phrasings: "Staged design-system
  refresh awaiting visual review and app adoption; kept separate from production references."
  (`task-row-design.stories.tsx:224`); "Shared desktop app-shell layouts staged with the design refresh
  before adoption in production routes." (`app-shell.stories.tsx:21`); "Requested interactive
  bulk-settings design for review before production implementation." (`bulk-agent-settings.stories.tsx:16`).
- `notes` hold durable limits only, never a change history (`README.md:43`), and disclaim production
  behaviour. Story ids derive from export names (`Compare` -> `design-<slug>-directions--compare`, `D1` ->
  `--d-1`, `TodayProductionPalette` -> `--today-production-palette`): change display text with `name`,
  never by renaming an export. `scaffold.mjs check --slug <slug>` requires the meta id to equal
  `registry.storyId`, the exports `Compare`, `Today`, `TodayProductionPalette` and one `D<N>` per registry
  direction, `paperclip` last in `parameters`, and `status: "proposed"` while `storybook-catalog.mjs:99`
  stands (`lib/check.mjs:28,116-132`; `lib/modes.mjs`). `add-direction` inserts the next `D<N>` export
  before `TodayProductionPalette`.
- No comment lines: `lib/write.mjs:5-15,25-26` refuses any line starting `//`, `/*`, `{/*` or `<!--`, the
  one exception being `// @vitest-environment jsdom` on a test's first line; files of 600 lines or more
  and existing paths are refused too (27-29).
- Per-direction deep dives (surfaces plus slots) are written by hand, no subcommand emits them: a second
  file `<slug>-directions-<digit>.stories.tsx` mirroring the hybrid story, id
  `design-<slug>-directions-<digit>` (the digit key, never the name: a rename must never change an id;
  the precedent's `-hybrid` suffix predates this rule), title
  `Design proposals/<Group>/<Title> directions/<N>.<Name>`, same `paperclip` block with the exception
  narrowed to that direction (`artifact-directions-hybrid.stories.tsx:44`), meta `satisfies Meta` without
  `component`.
- Theme: the file is themed except `TodayProductionPalette`, which opts out with
  `parameters: { designProposalTheme: false }` so Today is judged on the production palette; kit tokens
  stay scoped by `data-direction` (section 3) and Today has no `tokens.css`. The lab page keeps its state
  in the URL; a proposal that persists UI state uses `paperclip:design-proposals:<slug>:...`
  (`ui/storybook/support/design-proposals/ToolbarsPreview.tsx:52`).
- Every new story adds two visual-regression screenshots (dark, light) generated from the built
  `index.json` (`tests/storybook-visual/storybook-visual.spec.ts:6-26`); baselines are external and
  Linux-only. Never publish baselines to pass a review (`README.md:119`).
- `new` itself runs `node scripts/storybook-catalog.mjs --check`, the lab's Vitest files and a Vite build
  (`lib/verify.mjs:18-33`), and on failure deletes what it wrote and restores `.claude/launch.json` and
  `.gitignore` (`scaffold.mjs:84-96`). Afterwards verify with `scaffold.mjs check --slug <slug>` (`--run`
  adds lab vitest, catalog check, token gates, lab build and `cd ui && pnpm typecheck`,
  `lib/check.mjs:148-154`), or by hand: `node scripts/storybook-catalog.mjs --check`, then
  `cd ui && pnpm typecheck`; run `pnpm run check:token-gates` if you touched `ui/src/components` or
  `ui/src/pages`.

## 5. Lifecycle: proposed, adopted, current, historical

1. Proposed. The lab enters, as `new` writes it, with `home: "design-proposals"`, `status: "proposed"` and
   the exception as staging reason (`DESIGN.md:297-304`; `README.md:34-35,60-69`). The section is "a separate top-level
   review section" (`README.md:60`), rendered first in the generated index as "Proposed design system"
   ("Staged design work for review. These examples retain capability references but do not count as
   current product coverage.", `storybook-catalog.mjs:133`) and listed under "Design proposals" in the
   Overview guide by `FeatureMapIndex` (`ui/storybook/support/feature-map/FeatureOverview.tsx:64,78-79,92-99`).
   Capability links remain so the lab is reachable from each feature's overview, marked "(proposed)" (159).
2. Never coverage. `renderVerification` counts only entries whose implementation is not `guide` and
   whose status is neither `historical` nor `proposed` (165-169: "Historical examples, proposals and
   guides do not remove gaps."); tested at `storybook-catalog.test.mjs:75-99`. Approval is human and
   visual: "It remains proposed until visual approval." (`DESIGN.md:150-151`).
3. Sandbox (a step between proposed and adopted, not a stage; `lifecycle.md` §8). `VITE_PAPERCLIP_DESIGN_SANDBOX=true` in the dev
   app adds the same `.design-proposal-theme` marker to `<body>` and a bottom-right "Design proposals:
   On/Off" toggle (`ui/src/context/DesignSandboxContext.tsx:14-37`; `DESIGN.md:724-739`). Use it to
   inspect real pages on real data for missing token mappings and component variants; it is "an
   integration experiment, not permission, scale or release acceptance" (`DESIGN.md:755`).
4. Adopted behind a flag. Product code for the chosen direction lands in `ui/src/components/...`
   behind an experimental setting and gets a story in its FEATURE home with `status: "proposed"`,
   `implementation: "production"`, no `home`, no `exception`:
   `ui/storybook/stories/documents-artifacts/artifact-v1-primitives.stories.tsx:43-62` (id
   `components-artifact-v1-primitives`, title under the feature prefix). `proposed` is legal anywhere;
   only `home: "design-proposals"` forces it; seven feature-folder stories use this interim state. The
   plan behind it: `doc/plans/2026-10-22-artifacts-mvp-v1.md:7-15` ("The lab stays the visual
   reference") and 28-32 ("Reuse the lab's code, not its types ... The lab keeps its own copies; it is
   a reference, not a dependency of product code"). Kit tokens became `--artifact-*` tokens in
   `index.css:495-531`, with dark overrides at 594-600.
5. Current. When the flag is removed, set that feature-home story to `status: "current"`; it now
   counts as coverage. The Compare entry stays in the directory as `proposed` while any direction is
   unshipped and remains the visual reference (`lifecycle.md` §5).
6. Moving a file, on retirement only. Shipping never moves a lab story; only a retirement (item 7:
   `historical` plus `replacement`) moves a file out of the proposals folder, by `README.md:73-75`: "move
   its story into the usual feature or Foundations
   home, update its classification and staging metadata, and preserve the explicit CSF ID and exports
   so review links remain valid." Drop `home` and `exception` first (a `design-proposals` story cannot
   change status, line 99); the first capability's area then dictates the folder
   `ui/storybook/stories/<area>/` and the title prefix `<Section>/<Feature>/...` (`storyHome` 70-72;
   106-108). Keep the meta `id` and every export name: Playwright specs address
   `/iframe.html?id=<meta id>--<export>` (`tests/storybook-visual/buttons-design.spec.ts:5`) and 15 of
   the 20 proposal ids are pinned that way (`grep -rqF -- "$id" tests/storybook-visual` for each `id:`
   meta id in the git-tracked `design-proposals/*.stories.tsx`; unpinned: `design-agent-workload-trial`, both `design-artifact-directions-*`,
   `design-bulk-agent-settings`, `design-project-health-trial`). Diff the built `ui/storybook-static/index.json` ids before
   and after (`.agents/skills/maintain-storybook/SKILL.md:60-61`).
7. Historical. Set `status: "historical"` and `replacement: "<repo-relative .stories.tsx>"`
   (must exist, line 110). Five files do this today, all outside the proposals folder, e.g.
   `ui/storybook/stories/agent-chat/chat-entry.stories.tsx:5-22` (id `design-explorations-chat-entry`,
   title `.../Design explorations/Chat entry`, description beginning "Historical"). `historical` is
   rejected under `home: "design-proposals"` (99), so retiring a direction means moving its story to
   its feature folder under a `Historical/` or `Design explorations/` subgroup with the id kept
   (`lifecycle.md` §6; a whole lab moves Compare with it), never deleting it. "Do not delete a story merely because it is old, mocked, or duplicated by name."
   (`maintain-storybook/SKILL.md:41-42`).

At every step run `node scripts/storybook-catalog.mjs --check`, `cd ui && pnpm typecheck` and
`node --test scripts/check-maps.test.mjs scripts/storybook-catalog.test.mjs scripts/storybook-feature-index.test.mjs`.
Record evidence in the PR, not in the annotation (`README.md:107-113`).

## 6. Source-of-truth note

Today `DESIGN.md:9` governs: "Agents and humans modifying `ui/` treat this file as the source of truth
for design decisions. Storybook is the verification surface - it documents the system; it does not
define it. If a change conflicts with this document, change this document first (with review) or
change the code." The section is framed as staging, not authority: stories are "review references"
(`DESIGN.md:304`), the exception explains "why it is staged separately from production references"
(`README.md:34-35`), and proposals never count "as current production examples" (`README.md:70-71`).

To make the design-proposals section the canonical directory of the design system:

- Reword `DESIGN.md:9` (with review) so the section defines design decisions and DESIGN.md records or
  points to them; drop the "review references" framing at `DESIGN.md:304` for directory entries.
- Reframe `maps/storybook-map/README.md:34-35` (exception = the entry's purpose, not a reason for
  separateness) and `60-75` (which entries stay in the directory, which move to a feature home).
  `doc/DEVELOPING.md:257-277` needs no change unless the commands change.

Nothing changes in `scripts/storybook-catalog.mjs` for this: the section already has its own home
(`specialHomes`, line 17), folder and title rule (106-108), sort slot (`storybook-feature-index.mjs:11`),
index section (133) and theme scope (`preview-base.tsx:853`). Keep the coverage exclusion (165):
directory entries are design decisions, not product coverage. The one constraint to decide on is line
99: an entry cannot be marked other than `proposed` while it lives in `design-proposals`. The skill
ships every lab under "canonical means staged until shipped" (mode A: `lib/modes.mjs` detects line 99's
sentence and `check` expects `proposed`); the alternative, a status or home for approved-but-unshipped
directions (script, `storybook-catalog.test.mjs:101-115`, README), is written as paste-ready diffs in
`canonical-directory.md`, offered once as its own PR and opened only when Tonio says yes (`SKILL.md`).
