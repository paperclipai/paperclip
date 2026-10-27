# Generator: how `scaffold.mjs` renders a lab

For maintainers of the skill. The agent using the skill reads `SKILL.md`; this file explains the machinery
under `scripts/` and `assets/`, how it was derived from the artifact lab, and how to keep it in step. Every
rule the generator enforces is stated here and nowhere in code: the generator's own JavaScript carries no
comments, for the same repo rule it enforces on the files it writes (`CONTRIBUTING.md`: no code comments).

## Contents

1. Layout
2. Running it
3. The context object (`ctx`)
4. Templates
5. The generated lab, file by file, and the precedent each file came from
6. The motion asset and the drift test
7. Verification, rollback and the shared files
8. `check`, `add-direction`, `list`
9. Tests: `scaffold.test.mjs`
10. Adding or changing a template
11. Re-deriving after the precedent changes
12. Known limits of this version

## 1. Layout

```
.agents/skills/directions-lab/
  assets/
    motion/v1-mvp-motion.css        the V1 MVP hover block with <id> and <p> placeholders (section 6)
    templates/                      JS modules, `export default (ctx, ...) => string` (section 4)
  scripts/
    scaffold.mjs                    CLI: new, check, add-direction, list
    scaffold.test.mjs               node --test, runs in under a second
    lib/args.mjs                    flag grammar per subcommand (--k v, --k=v, booleans), UsageError
    lib/context.mjs                 flags -> ctx: casings, ids, surfaces, directions, landing, company, provenance
    lib/ports.mjs                   first free (dev, preview) pair from 5200/5210 in steps of 20
    lib/capabilities.mjs            validates --capabilities through <root>/scripts/feature-map.mjs
    lib/render.mjs                  loads the templates and produces Map<repo-relative path, content>
    lib/write.mjs                   refuses comments, 600-line files and existing paths; writes; rolls back
    lib/shared-files.mjs            idempotent .claude/launch.json and .gitignore edits with originals kept
    lib/registry-edit.mjs           reads and edits the generator-owned lines of registry.ts and the story
    lib/modes.mjs                   mode A/B detection from scripts/storybook-catalog.mjs
    lib/verify.mjs                  runs the verification commands and formats a failure
    lib/check.mjs                   the `check` rules
  references/generator.md           this file
```

The skill directory is git-ignored (`/.agents/` in `.gitignore`), so every file is added with `git add -f`.

## 2. Running it

From the repo root (`node .agents/skills/directions-lab/scripts/scaffold.mjs ...`):

| Subcommand | Flags | What it does |
| --- | --- | --- |
| `new` | `--slug`, `--title`, `--surfaces id:Label:width@nav,...`, `--directions 2\|3`, `--names a,b[,c]`, `--group`, `--capabilities a/k,...`, `--company name:PREFIX`, `--landing auto\|all\|today\|<id>`, `--ports dev,preview`, `--force-count`, `--dry-run`, `--json`, `--skip-verify`, `--no-build`, `--keep-on-failure`, `--root <dir>` | renders in memory, refuses existing paths, writes, edits the two shared files, verifies, rolls back on failure |
| `check` | `--slug`, `--strict`, `--run`, `--json`, `--skip-verify`, `--root` | the lab's structural rules plus the motion-contract test; `--run` executes the hand-off list |
| `add-direction` | `--slug`, `--name`, `--force-count`, `--json`, `--skip-verify`, `--root` | next digit; one directory from the direction templates; one registry line; one story export; re-runs `check` |
| `list` | `--json`, `--root` | every `ui/src/*-directions/registry.ts`, with launch.json ports |

Exit codes: 0 on success, 1 on any failure (the failing command's output is printed); after a flag-grammar error
(unknown subcommand or flag, missing value) the help text is printed too, after any other usage error only the
message. `--root` points every path at another directory; it exists so the tests can
scaffold into a temporary tree. Verification needs the real repo (`ui/node_modules`), so a scaffold under a
temporary root uses `--skip-verify`.

Defaults: `--title` is the slug in sentence case (`agent-profile-card` -> `Agent profile card`); `--group Components`; `--names` are Refine, Rework, Rethink
(two directions: Refine, Rethink); `--company acmehats:ACM`; `--landing auto`; `--ports` from `ports.mjs`;
`--capabilities` empty, which makes the story carry `capabilities: []` and the exception sentence (the
generator says so on stderr). Four to nine directions need `--force-count` and explicit `--names`.

## 3. The context object (`ctx`)

`context.mjs` derives everything once; templates never compute names. Built by `buildContext(flags, { root,
ports, capabilities })` and, for `add-direction`, by `assembleContext` from a parsed registry.

| Field | Example (`--slug inbox-row`) | Used by |
| --- | --- | --- |
| `slug`, `SLUG` | `inbox-row`, `INBOX_ROW` | paths, env names, the vite define |
| `title`, `group` | `Inbox row`, `Components` | toolbar labels, the story title |
| `labDir`, `entry`, `configFile`, `storyFile` | `ui/src/inbox-row-directions`, `inbox-row-directions.html`, `vite.inbox-row-directions.config.mjs`, `ui/storybook/stories/design-proposals/inbox-row-directions.stories.tsx` | render targets |
| `storyId` | `design-inbox-row-directions` | story meta id, registry, toolbar tooltip |
| `envOutDir`, `envPort`, `buildDefine` | `INBOX_ROW_DIRECTIONS_OUT_DIR`, `INBOX_ROW_DIRECTIONS_PORT`, `__INBOX_ROW_DIRECTIONS_BUILD_COMMIT__` | vite config, launch entries, `lab-env.d.ts`, `build-info.ts` |
| `distDir`, `staticDir` | `ui/dist-inbox-row-directions/`, `node_modules/.inbox-row-directions-dist` | .gitignore line, the preview launch entry |
| `ports` | `{ dev: 5220, preview: 5230 }` | config default port, launch entries |
| `directions[]` | `{ id: "d1-refine", key: "1", digit: 1, name: "1.Refine", label: "Refine", tagline, prefix: "refine", stage: "proposed" }` | registry, kits, tokens, story exports |
| `today` | `{ id: "today", key: "0", name: "0.Today", tagline: "What ships now", baseline: true, stage: "shipped" }` | registry (last), Today kit |
| `kits` | `[...directions, today]` | registry order (Today last) |
| `surfaces[]` | `{ id: "inbox", label: "Inbox", width: 960, nav: "other", Pascal: "Inbox", UPPER: "INBOX", fixture: "INBOX_ITEMS", body: "InboxBody", frame: "InboxFrame" }` | kit contract, frames, fixtures, bodies |
| `multiSurface`, `cells` | `false`, `3` | toolbar row 2, landing rule |
| `landing` | `{ direction: "all", view: "board" }` | registry; `d=all&s=board` when `cells <= 8`, else `d=all&s=<first surface>` |
| `capabilities`, `exception`, `notes` | `[]`, the two house sentences | story paperclip block, registry |
| `company`, `tasks` | `{ id: "company-acmehats", name: "acmehats", issuePrefix: "ACM" }`, three tasks | registry shell, fixtures, stub session |
| `tag` | `[inbox-row-directions]` | the stub's `console.debug` line |
| `publicUrl`, `vercelProject` | `https://paperclip-inbox-row-directions.vercel.app` | registry, story description |
| `forceCount` | `false` | `allowMore: true` in the registry |
| `provenance` | `{ runtimeCommit: <git short sha or "unknown">, skillVersion: "1", createdAt: "YYYY-MM-DD" }` | registry |

`<p>` (the token prefix) is the direction's kebab-cased name, so `--names Bold` gives `d1-bold` and
`--bold-*`. The motion-contract test derives the prefix from the id (`id.replace(/^d\d+-/, "")`), so a
renamed directory keeps its tokens consistent only if the prefix is renamed with it.

## 4. Templates

Every file under `assets/templates/` is an ES module whose default export returns the file's text:

- lab-level: `(ctx) => string` (`main.tsx.mjs`, `kit.ts.mjs`, `registry.ts.mjs`, `stories/compare.stories.tsx.mjs`, ...)
- per surface: `(ctx, surface) => string` (`frames/SurfaceFrame.tsx.mjs`, `today/SlotBody.tsx.mjs`)
- per direction: `(ctx, direction) => string` (`direction/index.tsx.mjs`, `direction/tokens.css.mjs`, `direction/MotionSpecimen.tsx.mjs`)
- per direction and surface: `(ctx, direction, surface) => string` (`direction/SlotBody.tsx.mjs`)
- `launch-entries.json.mjs` returns the two launch objects and exports `launchNames(ctx)`
- `build-info.ts.mjs` also exports `envDts(ctx)` for `lab-env.d.ts`
- `direction/tokens.css.mjs` also exports `motionBlock(direction)`, the asset with placeholders substituted

`render.mjs` owns the mapping from template to target path (`LAB_FILES` for one-per-lab files, loops for
per-surface and per-direction files) and returns a `Map`. Templates are ordinary template literals, so a
backtick or `${` that must reach the output is written `\`` and `\${`; loops over surfaces and directions
are plain `.map().join("\n")`. A template never reads the repo: everything it needs is in `ctx`.

Conventions the templates follow, and `write.mjs` enforces on the result:

- no line starts with `//`, `/*`, `{/*` or `<!--`; the one exception is a `// @vitest-environment <env>` pragma
  on line 1 of a test (`jsdom` in `today.test.tsx` and `api-stub.test.ts`), which vitest requires because
  `ui/vitest.config.ts` sets `environment: "node"`
- no file reaches 600 lines (the repo's hard rule is 1,000; 600 is the house limit for a lab file)
- no `package.json` script or dependency; the lab is invoked through its own vite config
- strings that the catalog must read as literals (the story's `paperclip` block) are emitted with
  `JSON.stringify`, never as template interpolation inside the generated file

## 5. The generated lab, file by file

Precedent: `ui/src/artifact-directions` (`lab-anatomy.md`, `today-fixtures-and-build.md`). Each generic
file was read from the precedent and parameterised; comments were removed; the registry replaced the
hand-maintained literals (`DirectionId`, `DIRECTION_IDS`, `KIT_KEYS`, `KIT_META`, `SURFACE_IDS`,
`VIEW_OPTIONS`, the Board's columns, `shot.cjs`'s `KITS`/`SURFACES`/`KIT_NAMES`).

| Generated | From | What changed |
| --- | --- | --- |
| `ui/<slug>-directions.html` | `ui/artifact-directions.html` | title; script path; the unlayered html/body style block kept verbatim, comment removed |
| `ui/vite.<slug>-directions.config.mjs` | `ui/vite.artifact-directions.config.mjs` | slug in ENTRY, env names, plugin names, cacheDir, watch paths; `define` with the per-lab build commit (`git rev-parse --short HEAD` in try/catch, `"unknown"` fallback) |
| `.claude/launch.json` entries | entries 27-44 | names, config file, ports, env var, static dir |
| `main.tsx` | `main.tsx` | KindsSheet removed; providers moved to `providers.tsx`; `window.__LAB__`; `proposal=1` wraps the page in `AvatarInitialProvider` + `.design-proposal-theme`; `d=all` always renders the Board |
| `providers.tsx` | `main.tsx:182-198` | the provider stack as a component so `today.test.tsx` can reuse it |
| `lab.css` | `lab.css` | verbatim rule |
| `define-lab.ts` | new | registry types and `defineLab()` validation (ids, digit keys, one baseline last, 2-3 explorations unless `allowMore`, `d<N>-<name>` ids keyed `N`, 1-6 surfaces, landing valid) |
| `registry.ts` | `kit.ts:16,130-150` + `SurfaceView.tsx:9-11` | pure data, the single source |
| `kit.ts` | `kit.ts:99-163` | `LabRecord` placeholder, `SurfaceData` (one member per surface, extends `Record<SurfaceId, unknown>` so a missing member fails tsc), `DirectionKit` with one `<Pascal>Body` per surface, ids and maps derived from the registry, the literal `import.meta.glob` |
| `lab-state.ts` | `lab-state.ts` | landing from the registry; `proposal` param; `landingSearch()` |
| `api-stub.ts` | `api-stub.ts` | verbatim minus comments; the debug tag and the stub session's e-mail follow the company |
| `api-routes.ts` | `today/panel-api.ts` pattern | the experimental-settings route answering `registry.today.flags`; an empty `registerFeatureRoutes()` for Phase 2 |
| `fixtures.ts` | `fixtures.ts` | `COMPANY`/`TASKS` from the registry shell, `LAB_NOW`, one `<UPPER>_ITEMS` export per surface with three placeholder records pinned to one week |
| `build-info.ts`, `lab-env.d.ts` | new | `LAB_BUILD` from the vite define (`"dev"` when undefined, so vitest never sees a ReferenceError) |
| `frames/Slot.tsx` | `frames/Slot.tsx` | verbatim |
| `frames/LabToolbar.tsx` | `frames/LabToolbar.tsx` | options from the registry; the label is a link to the landing with the `story <id> · build <sha>` tooltip; row 2 rendered only when `surfaces.length > 1`, otherwise the legend joins row 1; the `0–N` legend (`LEGEND`, the largest digit in `KIT_KEYS`), the Overview hint and the surface options are derived at run time, so `add-direction` and a hand-added surface need no toolbar edit; stage hint for adopted/current |
| `frames/Board.tsx` | `frames/Board.tsx` | `Tile` with the `proposal` prop passed through to its iframe links and `view` narrowed to `SurfaceId`; `KitBoard` columns = surfaces; `AllBoard` rows = directions and columns = every surface (`s=board`) or one (`s=<surface>`) |
| `frames/AppShell.tsx` | `frames/AppShell.tsx` | company and recent tasks from the registry; `active: ShellNav` with `other` |
| `frames/SurfaceView.tsx` | `frames/SurfaceView.tsx` | a `FRAMES` record, one entry per surface |
| `frames/<Pascal>Frame.tsx` | `ThreadFrame.tsx`/`PanelFrame.tsx` shape | a stub: shell, top bar, a dashed region frozen at the registry width marked `data-lab-stub="frame-<id>"` around `<Slot><kit.<Pascal>Body items={<UPPER>_ITEMS} /></Slot>` |
| `directions/today/*` | `directions/today/` | `index.tsx` with literal id/name/tagline; `adapters.ts` with `guid`, `agentId`, `issueIdFor` verbatim plus `issueHref`; one `<Pascal>Body.tsx` stub rendering the items in a dashed box `data-lab-stub="today-<id>"`; no tokens.css |
| `directions/d<N>-<name>/*` | `d5-v1-mvp/` | `index.tsx` importing `./tokens.css`; `tokens.css` (section 6); `MotionSpecimen.tsx` (a `<button>` with two `data-rotate data-spread` backings at inline `-14deg`/`-5deg`, geometry-derived `transform-origin`, static shadow filter, one `[data-front]` sheet, `transition-colors` fills); one `<Pascal>Body.tsx` per surface rendering a specimen per item inside `data-lab-stub="<id>-<surface>"` |
| `shot.cjs` | `shot.cjs` | reads `window.__LAB__` on a first `chrome=0` load instead of mirrored constants (fails with "page did not expose window.__LAB__; main.tsx did not run, read the console"); `--hover` writes `<kit>__<surface>__<theme>__hover.png` from a context without reduced motion; the board sheet is `150px repeat(<surfaces>, minmax(0,1fr))`; no excuse list |
| tests | `lab-state.test.ts`, `api-stub.test.ts`, `Thread.test.tsx` | `registry.test.ts`, `lab-state.test.ts`, `motion-contract.test.ts`, `today.test.tsx`, `api-stub.test.ts` (section 7 of `repo-gates.md` for the conventions) |
| the story | `artifact-directions-compare.stories.tsx` | `installApiStub` in a story-scoped effect with restore; `loadKit`; `SurfaceView`; the `animation` arg sets and restores `data-lab-anim`; `argTypes` and `args` precede `parameters` so `paperclip` is the last parameter; exports `Compare`, `Today`, `D1..DN`, `TodayProductionPalette` |

## 6. The motion asset and the drift test

`assets/motion/v1-mvp-motion.css` is `ui/src/artifact-directions/directions/d5-v1-mvp/tokens.css` lines 68-97 (67 is the comment above the block)
with the comments removed and `d5-v1-mvp` -> `<id>`, `--v1-` -> `--<p>-`. It is the skill's only copy of the
block. `direction/tokens.css.mjs` appends it, substituted, after the direction's light tokens
(`[data-direction="<id>"]`) and dark overrides (`.dark [data-direction="<id>"]`, the `index.css` idiom; d5's
`html:not(.dark)` is the copy hazard named in `lab-anatomy.md`). `add-direction` uses the same template, so
every exploration carries the block; Today never does.

Two tests pin it:

- `scaffold.test.mjs` "motion asset": reads the d5 file, strips `/* */` comments, cuts from the
  `[data-rotate]` rest rule to the end of the `@media (prefers-reduced-motion: no-preference)` block,
  normalises whitespace, substitutes, and asserts equality with the normalised asset. A tune of d5 turns
  this red before any scaffold.
- the generated `motion-contract.test.ts` (node environment, `fs.readFileSync`, never `?raw`, which this
  repo's vitest css pipeline swallows): per exploration, the curve declared once under its scope and no
  other `cubic-bezier(` or `\d+ms`; exactly one `transition:` and it is `transform var(--<p>-hover-ease)` on
  `:is([data-rotate][data-spread], [data-front])`; four gated rules, each starting
  `html[data-lab-anim="1"] [data-direction="<id>"]`, no `data-lab-anim` outside the gate; hover targets
  `[data-front]` (`translateY(-6px)`), `[data-spread="left"]` (`+ 5deg`), `[data-spread="right"]`
  (`- 5deg`) keyed on `button:hover` or `.<p>-tile:hover`; the rest rule outside both gates; no transition
  on filter, box-shadow, opacity or scale; the direction's `.tsx` sources carry `data-front`, `data-rotate`,
  `data-spread` and `--<p>-base`. The hook assertion reads every `.tsx` in the direction directory together,
  so a drawing may keep the hooks in a component rather than in `<Pascal>Body.tsx` itself.

## 7. Verification, rollback and the shared files

`new` is transactional:

1. `validateCapabilities` resolves `--capabilities` through `featureIndex(root)`; `pickPorts` chooses the
   pair; `buildContext` validates every other flag.
2. `renderLab` renders everything in memory; `checkRendered` refuses comment lines, files of 600 lines or
   more, and any target path that exists (so a half-written lab never overwrites a drawn one).
3. `writeFiles` creates directories and files, journaling what it created; `addLaunchEntries` and
   `addGitignoreLine` edit the two shared files and keep their originals in memory. launch.json is parsed,
   appended by name (an entry with the same name is replaced) and written back with
   `JSON.stringify(..., null, 2)`, which reproduces the tracked file byte for byte; the gitignore line goes
   after `dist-flow-preview/` when that line exists, else at the end.
4. Unless `--skip-verify`: `node scripts/storybook-catalog.mjs --check` from the root, then
   `npx vitest run src/<slug>-directions` from `ui/`, then (unless `--no-build`)
   `<SLUG>_DIRECTIONS_OUT_DIR=node_modules/.<slug>-directions-dist npx vite build --config
   vite.<slug>-directions.config.mjs` from `ui/`. The first failure stops the sequence.
5. On failure the failing command's output is printed, then `rollback` unlinks every written file and
   removes every directory it created, `restoreShared` writes the originals back, the build output and the
   lab's vite cache directory are removed, and the exit code is 1. `--keep-on-failure` leaves everything in
   place and prints the removal command instead.

`tsc` is not part of `new`'s verification: `ui/tsconfig.json` includes all of `src` and `storybook`, so a
lab-only typecheck needs a temporary tsconfig (`extends ./tsconfig.json`, `include` the lab directory, its
story and `src/vite-env.d.ts`); `check --run` runs the ui package's `pnpm typecheck` (from `ui/`) instead.

## 8. `check`, `add-direction`, `list`

`check --slug <slug>` reads the registry (`registry-edit.mjs` recognises the generator-owned lines by exact
text and fails loudly when a hand edit changed their shape) and verifies: `directions/` holds exactly the
registry ids and each `index.tsx` carries the registry's id and name; keys are unique digits with one
baseline; every exploration has a tokens.css and Today has none; no comment lines and no file of 600 lines;
none of the artifact lab's names (`DENY_LIST` in `check.mjs`: `artifact-directions`, `LabArtifact`,
`GalleryFrame`, `d5-v1-mvp`, `--v1-`, ...) appear unless listed in `registry.allow`; `<slug>-directions`
appears in no code file under `ui/src`, `ui/storybook` or at the top of `ui/` outside the lab, its html, its
config, its story, launch.json and .gitignore;
no `.css` or `.html` file outside `directions/<id>/tokens.css` carries a `data-lab-anim` rule;
the story's meta id equals `registry.storyId`, the stable exports exist, the `paperclip` parameter comes
last and its status matches the detected mode and the lab's stage (`modes.mjs`: `labStage` is `proposed`
while any exploration is `proposed` or `adopted`, `historical` when every exploration is `historical`,
else `current`; `expectedStoryStatus` maps it to `proposed` in mode A and to itself in mode B; a
`historical` story must also carry `replacement: "<repo-relative .stories.tsx>"` naming an existing
file, and a `replacement:` line in another story never counts as naming `<slug>-directions` outside the
lab); the launch entries and the gitignore line exist. It then
runs `npx vitest run src/<slug>-directions/motion-contract.test.ts`. `--strict` fails on any
`data-lab-stub`; placeholder taglines are warned about on every run. `--run` adds the hand-off list in order (lab vitest,
catalog check, token gates, lab build, the ui `pnpm typecheck`) and prints a `## Verification` block with `Not run:`
lines for `pnpm build-storybook` and the repo-wide typecheck (`NOT_RUN` in `check.mjs`); `--json` carries the
same list as `notRun` beside `ok`, `errors`, `warnings` and `verification`.

`add-direction --slug <slug> --name <Name>` computes the next digit, refuses a fourth without
`--force-count` (and sets `allowMore: true` in the registry when forced), renders the direction templates
through `assembleContext` built from the parsed registry, inserts the registry line before the Today entry
and the story export before `TodayProductionPalette`, then runs `check`; a failing check rolls the
direction back.

`list` prints every lab found with its directions, surfaces, launch ports and story id.

## 9. Tests: `scaffold.test.mjs`

`node --test .agents/skills/directions-lab/scripts/scaffold.test.mjs` (about half a second). It covers flag
parsing, context derivation (casings, landing rule, refusals of every invalid input, `--force-count`),
ports, the write guards (the pragma exception, the 600-line limit, existing paths), the shared-file edits
(idempotence, the anchor), mode detection, the motion asset (drift test, substitution), and then scaffolds
the three eval shapes (`composer` with two surfaces and three directions, `inbox-row` with one surface and
two, `agent-profile-card` with one surface and three) into a temporary `--root` with `--skip-verify` to
assert the file set, the surfaces-row rule, the motion block at the end of every exploration tokens.css,
the specimen hooks and stub markers, no comments and no 600-line file, the story's literal block and
exports, the launch entries and gitignore line, the refusal to overwrite, `list`, `check`, `add-direction`
(including the forced fourth), `--strict`, the `data-lab-anim` placement rule and, after switching the
temporary root to mode B, the Compare status for every lab stage (proposed, current, historical with and
without `replacement`) with `notRun` in the JSON. Two cases run against the real repo without writing:
capability validation through the feature map (`--dry-run`) and an in-memory render of every template.

## 10. Adding or changing a template

1. Read the precedent file the template mirrors (section 5) and the reference that cites it.
2. Edit or add the module under `assets/templates/`; register a new one-per-lab file in `LAB_FILES` in
   `render.mjs`, or add the loop for a per-surface or per-direction file next to the existing ones.
3. Keep the output comment-free and under 600 lines; `checkRendered` refuses otherwise and the test
   "writes no comments and no file of 600 lines or more" fails first.
4. Run `node --test .agents/skills/directions-lab/scripts/scaffold.test.mjs`, then prove a real scaffold:
   `scaffold.mjs new --slug labproof --title Labproof --surfaces thread:Task-thread:960@tasks,panel:Right-panel:434@tasks --directions 3`
   without `--skip-verify`, read any failure, fix the template, repeat until it exits 0; typecheck the lab
   with a temporary tsconfig; then remove the proof lab (the lab directory, its html, its config, its story,
   the two launch entries, the gitignore line, `ui/node_modules/.labproof-directions-dist` and
   `ui/node_modules/.vite-labproof-directions-*`) and confirm with `git status --short`.
5. Update section 5 of this file when a template's relationship to the precedent changes.

## 11. Re-deriving after the precedent changes

The artifact lab stays on master as the frozen reference, so a change there is deliberate and rare. When one
lands: diff the precedent file against the template's output for a scaffolded lab (`git diff --no-index`),
carry the change into the template if it is generic (toolbar, Board, api-stub, main bootstrap, config
options, shot.cjs flags), leave it if it is artifact-specific, and update the line numbers cited in
`lab-anatomy.md` and `today-fixtures-and-build.md`. For the motion block, update `assets/motion/v1-mvp-motion.css`
only after the design decision is taken (the block is never tuned per lab), then run the drift test.

## 12. Known limits of this version

- No shared runtime under `ui/src/directions-lab`: every lab carries its own copy of the generic files, as
  the precedent does. A fix to a generic file reaches existing labs only by hand or by re-scaffolding.
- Subcommands are `new`, `check`, `add-direction`, `list`. `add-surface`, `rename-direction`,
  `direction-story`, `stage`, `diff`, `smoke`, `deploy.sh` and `--answers` are not implemented; a new surface,
  a rename or a stage change is a hand edit of `registry.ts`, the `directions/` tree and the story, confirmed
  with `check`.
- `add-direction` edits the registry and the story by exact-text recognition; a hand-reformatted registry
  (for example by Prettier changing the one-line entries) makes it refuse, quoting the line it could not read;
  only a missing baseline line or a missing `TodayProductionPalette` anchor prints the line to add by hand.
- `check` does not cross-check stage against story sentences beyond the status, and never reads `DESIGN.md`.
- The Board story (`InlineBoard`) is not emitted; the Storybook entry has `Compare`, `Today`, `D1..DN` and
  `TodayProductionPalette`; a board export is a hand-written story in the same file.
- Ports are chosen from launch.json, the reserved list and the vite cache directories, not by probing
  sockets.
