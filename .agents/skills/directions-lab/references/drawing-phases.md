# Drawing phases

What to do after `node .agents/skills/directions-lab/scripts/scaffold.mjs new ...` has written the lab, its built-in verification passed and the scaffold is committed. Three phases, in this order: frames, then fixtures and Today, then directions. Phase 2 comes before Phase 3 because it retypes `SurfaceData` in `kit.ts`, and every kit body (Today and each direction) takes its props from that type; a direction drawn against the placeholder `LabRecord` is drawn twice.

Paths below are under `ui/src/<slug>-directions/` unless they start with `ui/`, `.agents/` or `/`. "Precedent" means the artifact lab, `ui/src/artifact-directions/`; its line numbers were opened on this checkout at `5e26b733b`. Read the precedent for shape, never import from it or copy it mechanically.

The other references already cover the ground below; link to them, do not repeat them:

- `lab-anatomy.md`: files, URL state, toolbar, Slot scoping, frames and the widths table (section 8), the parked optional-surface branch (section 9).
- `today-fixtures-and-build.md`: the Today kit (section 1), adapters (2), the API stub (3), the fixture world (4), capture (10), deploy (11).
- `motion-spec.md`: the hover motion, the hooks a component carries (7), gating (4), the `tokens.css` checklist (11).
- `repo-gates.md`: catalog rules, token gates, PR rules (4), the hand-off list (8).
- `lifecycle.md`: every move after the lab is drawn (adopted, current, historical). No subcommand does these in this version; do them by hand.

## 0. Commit discipline

1. Commit the scaffold before drawing anything: `feat(ui): scaffold the <title> directions lab`. Stage exactly what `new` printed: the lab directory, `ui/<slug>-directions.html`, `ui/vite.<slug>-directions.config.mjs`, the story file, `.claude/launch.json`, `.gitignore`. Why: the scaffold is plumbing that is the same from lab to lab; mixed with the redraw it hides the design decisions, and a reviewer reads the PR commit by commit to find them.
2. After that, one commit per phase (`feat(ui): draw the <title> lab frames`, `... Today`, `... <N>.<Name>`), or at least one commit for the whole redraw. Never amend the scaffold commit. A later `add-direction` is its own commit, before the drawing that follows it.
3. The PR is scaffold plus redraw; the redraw commits are the design diff. PR title: `feat(ui): add the <title> directions lab` (`repo-gates.md` section 8).

## 1. Phase 1: frames

Goal: each `frames/<Pascal>Frame.tsx` is a static, behaviour-free mock of the product chrome around the one place that surface stands for, with the kit's slot inside. The scaffold left a region marked `data-lab-stub="frame-<surface>"` around `<Slot kit={kit}><kit.<Pascal>Body ... /></Slot>` inside `<AppShell>`. Replace the region; keep the `Slot` and the `AppShell`.

Rules:

- Copy the product's class strings. Open the host component of that place and take its `className` strings as they are. Cite the file and lines in the PR body, never in a code comment: CONTRIBUTING forbids comments, and `check` refuses them. The precedent frames carry doc comments because they pre-date that gate; do not copy them.
- Freeze the registry width. The generated frame fixes its column or pane at the surface's `width` from `registry.ts` (960 for a thread column, 434 for the pane, 1152 for a page; sources in `lab-anatomy.md` section 8). When the product constant disagrees with the brief, change the number in `registry.ts` and let the frame follow; never hard-code a second width in the frame. The precedent freezes by value: `PanelFrame.tsx:19` `TASK_DETAIL_PANE_WIDTH = 434`, applied at `:32` as `style={{ width }}`; `ThreadFrame.tsx:86` `max-w-(--tc-shell-max-w)`; `GalleryFrame.tsx:102` `max-w-6xl`.
- Reuse presentational primitives; hand-draw anything stateful. The precedent mounts `SidePanelFrame`, `SidePanelWindowControls`, `SidePanelTabs` and `Button` (`PanelFrame.tsx:1-5, 33-60`, with `presentation="docked" contentMode="full-bleed" headerSize="task-detail" className="flex-1 border-l-0"` at `:33-37`), `Breadcrumb*` and `StatusIcon` (`ThreadFrame.tsx:3-4, 26-42`), `Breadcrumb*`, `Input`, `Button`, `cn` (`GalleryFrame.tsx:2-5`). Anything that reads a store, routes or fetches is mirrored as markup with `noop` handlers (`PanelFrame.tsx:28, 43-44, 60`).
- Nothing scrolls internally. `AppShell.tsx:173` uses `min-h-225` where the product shell is `h-dvh`; `PanelFrame.tsx:63` renders the pane body as a plain `p-4` div; `thread-parts.tsx:93-117` `ComposerShell` is not sticky. The page grows, so a full-page capture and the Board's height measurement see everything. No `overflow-auto`, `h-screen` or `sticky` in a frame.
- Never import from `ui/src/artifact-directions/`. `check` fails on `artifact-directions`, `LabArtifact`, `GalleryFrame`, `KindsSheet` and the other precedent identifiers. Read, then re-type what fits your feature.

Reading pointers (read, do not copy mechanically):

| Surface kind | Precedent | What to take from it |
|---|---|---|
| A task thread | `frames/ThreadFrame.tsx` + `frames/thread-parts.tsx` | `TaskTopBar` (:21-50); `GAP` and `Item` spacing (:53-57); `Bubble` (:60-62); a slot mounted per row (:64-70) and once as a block (:74-78); the 960 column (:86). In `thread-parts`: `AgentIdentity` (:13-22), `Prose` (:25-31), `MessageFooter` (:62-79), `WorkedRow` (:82-90), `ComposerShell` (:93-117). |
| The right pane | `frames/PanelFrame.tsx` | The `aside` (:32); the `SidePanelFrame` props (:33-37); the tab set (:22-26, 40-57); the body padding around the slot (:63-67). |
| A company page | `frames/GalleryFrame.tsx` | `TopBar` in its single-crumb and trail variants (:20-45); `Toolbar` (:48-78); the opened-item header (:81-93); the page-width wrapper (:102); the optional whole-region override (:103-113). |
| Every surface | `frames/AppShell.tsx` | Nav lists (:41-59); `NavItem` (:63-79); `Section` (:82-95); `Sidebar` with the 240px `w-60` and the 60px top row (:97-152); `SupportButton` (:159-168); the shell and its main column (:170-181). |

The scaffold's `AppShell` takes company and tasks from `registry.shell` and the active nav from each surface's `nav` (`@nav` in `--surfaces`); change those in `registry.ts`, not in the frame.

Finding the product source: the precedent's doc comments name the product file and lines they mirrored (`ThreadFrame.tsx:20, 52, 59, 80, 83, 85`; `PanelFrame.tsx:14-15, 18, 21, 62`; `GalleryFrame.tsx:16, 19, 47, 80, 99, 101`; `AppShell.tsx:25, 62, 81, 99, 101, 139, 172, 176`). Use them as entry points, then re-open the product file; three of those citations have already drifted (`lab-anatomy.md` section 8). For a place the precedent never drew: `rg -n "<a distinctive class string from the element>" ui/src/components ui/src/pages` finds the host, then `rg -n "max-w-|DEFAULT_.*WIDTH|_PANE_WIDTH" <host file>` finds the width to freeze.

Done when:

- `rg -n 'data-lab-stub="frame-' ui/src/<slug>-directions` prints nothing AND `rg -n "<the product class string you froze>" ui/src/<slug>-directions/frames` prints the frame. An absence grep alone passes on an empty file.
- `/?d=today&s=<surface>&theme=dark&chrome=0` at 1440 wide matches a product screenshot of that place chrome for chrome, in both themes. The slot content is still the Today placeholder box; that is expected here.
- The page has one scrollbar, on `<html>`.
- `node .agents/skills/directions-lab/scripts/scaffold.mjs check --slug <slug>` passes.

## 2. Phase 2: fixtures and Today

Goal: `0.Today` renders the shipped component for every surface on the lab's fixtures, so each direction is judged against what ships.

1. Retype the data. Edit `SurfaceData` in `kit.ts` so each member is the props that place receives in the product (`{ thread: { items: LabRecord[] } }` becomes, say, `{ thread: { workProducts: LabWorkProduct[]; attachments: LabAttachment[] } }`). Define the record types beside it, as the precedent keeps `LabArtifact`, `LabGroup` and `LabRun` in `kit.ts:18-97`, and state each slot's fixed constraints in the PR body in the words of the precedent's `DirectionKit` JSDoc at `kit.ts:103-112` ("the pane is 434px wide; the body has 16px of padding"); a JSDoc in the lab's `kit.ts` is a comment line and `check` refuses it. `DirectionKit` and every `<Pascal>Body` prop type derive from `SurfaceData`, so `cd ui && npx tsc -b 2>&1 | rg "<slug>-directions"` now lists every body and frame to update (minutes; needs `@paperclipai/plugin-sdk` built). Fix the frames first (they pass the fixtures), then Today, then the direction stubs: rename their props only, the specimen stays until Phase 3.
2. Fill `fixtures.ts`. Keep `COMPANY`, `TASKS`, one export per surface and the pinned clock `LAB_NOW`; derive every timestamp from it as zone-less local ISO strings inside one week and precompute labels with the product's en-US formats (precedent `fixtures.ts:22, 27-34, 54-59`). Conventions and factories: `today-fixtures-and-build.md` section 4. Long bodies go in a sibling `fixture-documents.ts`; media are URL imports from `assets/`.
3. Mount the shipped component in `directions/today/<Pascal>Body.tsx`. Mount it when it is a standalone export: the precedent's `PanelBody.tsx:14-20` mounts `IssuePropertiesArtifactsTab` with `{ id, companyId } as Issue`, and `Gallery.tsx:10-34` mounts `ArtifactGroupCard` and `ArtifactCard` on the product's grid string (`:7`). When the product markup is inline JSX inside a larger component, copy that JSX minus handlers and import the real primitives (`ThreadAttachments.tsx:24-96`); say which branch you copied in the PR body. Feed it through `adapters.ts`: pure `LabRecord -> product type` functions with the base object pinned by `satisfies Partial<T>` (`adapters.ts:64`) so field drift against `@paperclipai/shared` fails typecheck. `guid`, `agentId` and `issueIdFor` (`adapters.ts:14-25`) are already in the scaffold; keep them verbatim. Direction of reuse: product reuses the lab's code, never its types; the lab keeps its copies (`today-fixtures-and-build.md` section 2).
4. Register exactly the routes it fetches, in `api-routes.ts`. Find them: `rg -n "useQuery|queryFn|queryKey|use[A-Z]\w+\(" ui/src/components/<feature>/<Component>.tsx`, note each `<module>Api.<fn>` (the precedent tab's are at `IssuePropertiesArtifactsTab.tsx:420-442`: `issuesApi.listAttachments`, `activityApi.runsForIssue`, `agentsApi.list`, imported at `:19-21`), then open `ui/src/api/<module>.ts` for the path string. Hooks hide queries too: follow every `use<Thing>s(` into `ui/src/hooks/`. Register one `registerApiRoute((pathname, method) => body | undefined)` per path family. The precedent answers five paths with one regex (`panel-api.ts:75-90`), mints an id per fixture list so several panels share one page (`:17-25`, used from `PanelBody.tsx:16` inside `useMemo`), and spaces creation times a minute apart so the product's sort keeps the fixture order (`:32`). Matching is pathname-only (`api-stub.ts:58`): `/companies?scope=accessible` reaches a route as `/api/companies`; never put a query string in a route. Registration runs at import time, so a test that renders a body without importing `api-routes.ts` sees `{}`.
5. Read the console. A path no route answers gets `{}` and `console.debug("[<slug>-directions] unhandled", method, pathname)` (`api-stub.ts:36-37`), never a 4xx, so a frame looks empty rather than broken. Start `preview_start <slug>-directions-dev`, open `/?d=today&s=<surface>`, `read_console_messages` with pattern `unhandled`, register what you see, reload, repeat until the list is empty for every surface. Two fallbacks stay built in (`api-stub.ts:30-33`): `*/auth/get-session` and `*/companies`.
6. Flags. A flag-gated component calls a `use<Feature>Enabled()` hook that reads `GET /instance/settings/experimental` (`ui/src/hooks/useArtifactsV1Enabled.ts:26-33`; the path at `ui/src/api/instanceSettings.ts:21`) and tests one key (`settings?.enableArtifactsV1 === true`, `:7-9`). The scaffold's `api-routes.ts` already answers that path from `registry.today.flags`, so Today shows the flag-off presentation by default. When the brief asks for the flagged presentation, set `today: { flags: { <key>: true } }` in `registry.ts`; find the key with `rg -n "export function use\w+Enabled" ui/src/hooks` and read that hook's resolver. Do not fork a second Today for the other state in this version; name the choice in the PR body.

Done when:

- `rg -n 'data-lab-stub="today-' ui/src/<slug>-directions` prints nothing AND `rg -n 'from "@/components/' ui/src/<slug>-directions/directions/today` prints at least one shipped import per surface.
- `cd ui && npx vitest run src/<slug>-directions/today.test.tsx` passes with the shipped components mounted. The test renders each `kit.<Pascal>Body` on the fixtures through the lab providers with the stub installed and asserts `[data-direction="today"]` has an element child and text. It passed on the placeholder too, so it proves something only once the placeholder is gone.
- Today matches the product on the same data: compare `/?d=today&s=<surface>&chrome=0` at 1440 with a product screenshot of that place (the brief's, or the dev app with equivalent records), both themes.
- No `unhandled` line for a route the component needs; `check --slug <slug>` passes.

## 3. Phase 3: directions

Goal: each `directions/d<N>-<name>/` is a drawing. One direction at a time, finished before the next starts. Each starts as a kit whose bodies render a `MotionSpecimen` per item so the Animation toggle is verifiable before anything is drawn.

Per direction:

1. Replace `MotionSpecimen` in each `<Pascal>Body.tsx` with the drawing; delete `MotionSpecimen.tsx` once nothing imports it. Keep the hook names the specimen carried, because `motion-contract.test.ts` asserts them across the direction's `.tsx` files taken together and the toggle is a no-op without them (`motion-spec.md` section 7):
   - `data-front` on the element that rises, on every treatment branch. A branch that returns a bare print without it stands still while the backings turn; that is the bare-print lesson in `motion-spec.md` section 7.
   - `data-rotate data-spread="left"|"right"` on each fanning backing, with its resting angle as inline `"--<p>-base": "<deg>deg"` cast `as CSSProperties`, and a `transform-origin` derived from the visible shape's centre, not the padded asset's. Precedent: `d5-v1-mvp/Stack.tsx:40-52` (origin `:41-42, 48`, base `:50`, hooks `:52`); the rule is `motion-spec.md` section 3.4. A direction with nothing to fan may leave the backings out, as long as the names still appear in the body (the test checks presence, the toggle then only lifts).
2. Tokens. Every raw value (hex, rgba, px, radii, shadows, grid templates) goes in that direction's `tokens.css`, scoped `[data-direction="<id>"]`, light values in the base block and dark values in `.dark [data-direction="<id>"]` after it, the `index.css` idiom (`d1-solid/tokens.css:40, 90`). Copy hazard: `d5-v1-mvp/tokens.css` is the other way round, dark as the base (`:5`) and light under `html:not(.dark) [data-direction]` (`:56`), because its values were measured from a dark mock. Pasting a d5 block into the scaffold's file swaps every fill; flip the pairs when you borrow a value (`motion-spec.md` section 4.3). Tailwind resolves `h-(--<p>-tile-h)`, `rounded-(--<p>-tile-radius)`, `bg-(--<p>-tile-hover)` only under the `Slot` wrapper; a kit rendered outside `[data-direction]` collapses.
3. The motion block stays untouched. The last rules of the generated `tokens.css` are the V1 MVP block (precedent `d5-v1-mvp/tokens.css:68-97`, under the comment at 67: the ungated rest rule (68-70), the one curve `--<p>-hover-ease: 300ms cubic-bezier(0.3, 0, 0.1, 1)` (80-82), the double-gated transition and the three hover transforms (84-97)). Do not change the curve, `-6px`, `+ 5deg`, `- 5deg`, the gates or the selectors: `motion-contract.test.ts` and `check` fail on any of it, and a direction that wants a different rise or fan is a decision for Tonio, not a lab edit. The one permitted edit: when the direction's tiles are anchors rather than buttons, re-key the three hover transforms from `button:hover` to `.<p>-tile:hover` and put that class on the anchor; the test accepts either trigger. Run the checklist in `motion-spec.md` section 11 before committing the direction.
4. Fills fade through Tailwind, never through the block. A colour change rides `transition-colors` in the markup with `hover:bg-(--<p>-tile-hover) focus-visible:bg-(--<p>-tile-hover)` (precedent `d5-v1-mvp/Tile.tsx:53`); movement is `:hover` only, fills also fire on `:focus-visible`, shadows and strokes are static tokens. `tokens.css` may hold exactly one `transition:` and it is the block's.
5. Name it. Replace the placeholder tagline (`Tokens and spacing, same structure`, `New components, same layout`, `New layout`) in `registry.ts` and in the kit's `index.tsx`; `registry.test.ts` requires them equal and `check` warns on a placeholder, with or without `--strict`. To rename the direction (`d2-rework` to `d2-bold`) do it by hand, there is no subcommand yet: the directory, the registry `id` and `name`, `[data-direction="<id>"]` in `tokens.css`, `kit.id` and `kit.name` in `index.tsx`, the `--<p>-` prefix (`motion-contract.test.ts` derives it from the id, so it always follows), and the `name` and `args.direction` of the story's `D<N>` export. Story exports are digit-keyed, so the export itself keeps its name. If a later `add-direction` refuses because a registry line is no longer in the generator's form, restore that line's shape or apply the manual edit it prints.
6. Verify hover by hand, in a single-surface view, with the Animation toggle on. Neither the Board nor a `shot.cjs` still shows motion: Board tiles are `pointer-events-none` iframes, and the still's context asks for `reducedMotion: "reduce"` (precedent `shot.cjs:121-125`), which the block's `@media` gate honours; `--hover` (section 4) records one hovered frame, not the movement. So: `preview_start <slug>-directions-dev`, open `/?d=<id>&s=<surface>&theme=dark` (Animation defaults on), check `document.documentElement.dataset.labAnim === "1"` with `javascript_tool`, `zoom` on the first tile at rest, `hover` it, wait 0.4 s, `zoom` again and see the rise and fan; press `a`, hover again: the fill still steps, nothing moves. Repeat in light. Keep the browser pane displayed while you do this (`tabs_context` says whether it is); a hidden pane runs as a background page and transitions may not advance.

Done when, per direction:

- `rg -n 'data-lab-stub="<id>-' ui/src/<slug>-directions` prints nothing AND `rg -n "data-front" ui/src/<slug>-directions/directions/<id>` prints every body.
- `cd ui && npx vitest run src/<slug>-directions` passes (registry, lab-state, api-stub, motion-contract, today). One full `ui` vitest at a time; concurrent runs fail spuriously.
- Hover verified by hand in both themes; the tagline is the direction's own; `check --slug <slug>` passes.

Adding a direction later: `node .agents/skills/directions-lab/scripts/scaffold.mjs add-direction --slug <slug> --name <Name>` appends the next digit with its motion block and specimen, its registry line and the story export `D<N>`, then runs `check` and rolls all of it back on a failure (it refuses a fourth without `--force-count`); commit it, then repeat this phase for it. `list` prints the labs on this checkout. A surface that only some directions draw is not scaffolded in this version; the pattern lives on the parked branch (`lab-anatomy.md` section 9), read it before adding one by hand.

## 4. Capture

With the dev server running:

```sh
npx playwright install chromium
node ui/src/<slug>-directions/shot.cjs --port <dev> --d all --out <scratchpad>/<slug>-shots
node ui/src/<slug>-directions/shot.cjs --port <dev> --d <id> --s <surface> --theme dark,light --out <scratchpad>/<slug>-shots --hover
```

Flags: `--port` (required; it never starts the server), `--d <kit|all>` (default `today`), `--s` comma-separated surfaces plus `board`, `--theme dark,light`, `--out` (required), `--hover`. Stills load `chrome=0` at 1440x900, DPR 2, reduced motion, and write `<kit>__<surface>__<theme>.png`. `--hover` opens a second context without reduced motion, hovers the first `button` inside `[data-direction]`, waits 350 ms and writes `<kit>__<surface>__<theme>__hover.png` beside the still; if your tiles are anchors, change that selector in the lab's `shot.cjs`. `board` is a contact sheet composed from the PNGs already in `--out` (precedent `shot.cjs:162-200`), because the in-page Board is one live iframe per cell and never settles on a dev server. Any console error, page error, failed request or HTTP status of 400 or more fails the run after writing everything (precedent `shot.cjs:130-141`); the generated script has no excuse list, so a warning from a shipped component is yours to report, not to excuse (the precedent's `shot.cjs:210-213` shows the one it excused and why). "page did not expose window.__LAB__" means `main.tsx` did not run; read the console. PNGs (rest and hover pairs, both themes) go into the PR description, never into the repo.

## 5. Hand-off

```sh
node .agents/skills/directions-lab/scripts/scaffold.mjs check --slug <slug> --strict --run
```

`--strict` fails on any remaining `data-lab-stub` (the placeholder-tagline warning comes from `check` itself); `--run` executes the hand-off list of `repo-gates.md` section 8 in that order up to the ui typecheck, with a lab Vite build inserted before it, and prints a ready-to-paste `## Verification` block whose `Not run:` lines name `pnpm build-storybook` and the repo-wide typecheck, which it never runs (fresh worktree: `pnpm install --frozen-lockfile` and a built `@paperclipai/plugin-sdk` first; repo-wide typecheck needs cargo). Then the PR per `repo-gates.md` sections 4 and 5: scaffold commit first, redraw commits after; every template section filled; path B labels or a linked issue; the story ids, the two launch entries and, if deployed, the alias listed; the DESIGN.md directory row offered as text and never applied. Lifecycle moves (adopted behind a flag, current, historical) are later PRs, by hand, per `lifecycle.md`.
