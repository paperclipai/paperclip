# Repo gates a lab must pass

Nothing in CI knows about labs: a lab PR merges through the same gates as any `ui/` change. Each gate
below names the rule it checks and the local command that proves it. Every rule is GENERIC unless marked
ARTIFACT-SPECIFIC; artifact-specific values come from the worked example (the artifact directions lab,
PR #17213) and must be redrawn per feature. Line numbers were confirmed on `claude/directions-lab-skill`
at `5e26b733b`.

## Contents

1. Storybook catalog rules for design-proposal stories
2. Validate the catalog; generated outputs are git-ignored
3. Token gates and the lab's `tokens.css`
4. PR rules from CONTRIBUTING and the template
5. commitperclip gates (blocking)
6. Greptile and the `rules/*.mdc` files
7. Vitest conventions and the lab-only test command
8. Hand-off checklist

## 1. Storybook catalog rules for design-proposal stories

`scripts/storybook-catalog.mjs` parses every story file without executing it (`loadCsf`, line 65) and
validates the result (lines 83-116). Line numbers in 1.1-1.5 refer to that script unless a path is given.

### 1.1 Location, title, meta id

- File under `ui/storybook/stories/design-proposals/` (`storyRoot` line 12; folder rule line 107).
  Storybook's glob `../stories/**/*.stories.@(ts|tsx|mdx)` (`ui/storybook/.storybook/main.ts:23`) finds it.
- Title starts with `Design proposals/` (`specialHomes` line 17; rule line 108). Convention:
  `Design proposals/<Lab display name>/<Suite>`.
- Explicit meta `id` (line 109). Convention: `design-<lab>-<suite>`. Taken ids:
  `grep -n "^  id:" ui/storybook/stories/design-proposals/*.stories.tsx` (20 files, 18 prefixed `design-`).
- ARTIFACT-SPECIFIC: `design-artifact-directions-compare`, `design-artifact-directions-hybrid`, group
  `Artifact directions` (`ui/storybook/stories/design-proposals/artifact-directions-compare.stories.tsx:39-40`,
  `artifact-directions-hybrid.stories.tsx:28-29`).
- The sub-order under Design proposals is hardcoded in `scripts/storybook-feature-index.mjs:11`
  (`Foundations, Components, Layouts, Pages, AI Generated Test Pages, Patterns, Guidelines`); a lab group
  outside the list sorts after them; the catalog does not enforce group names. Never edit the generated
  `preview.tsx` (`maps/storybook-map/README.md:90`).
- `ui/storybook/.storybook/preview-base.tsx:853` wraps a story whose `parameters.paperclip.home` is
  `"design-proposals"` in `<AvatarInitialProvider><div className="design-proposal-theme">` unless
  `parameters.designProposalTheme === false`; `html:has(.design-proposal-theme)` switches `--font-mono` to
  Paper Mono (`ui/src/index.css:3916-3918`). Theme toolbar defaults to dark (line 861); a11y is `test: "error"` (line 876).

### 1.2 The `parameters.paperclip` block: fields and allowed values

Allowed keys (line 16): `capabilities`, `status`, `implementation`, `boundary`, `notes`, `home`,
`exception`, `replacement`; any other key throws `unknown paperclip field` (line 57).

| Field | Allowed values | Lab value |
| --- | --- | --- |
| `home` | `foundations`, `design-proposals` (line 95) | `"design-proposals"` |
| `status` | `current`, `proposed`, `historical`, `mixed`, `unreviewed` (line 13) | `"proposed"`; forced by the home (line 99) |
| `exception` | nonempty string (line 96) | required by the home (line 100) and by empty `capabilities` (line 103) |
| `capabilities` | array of strings (line 94); each an existing `<area>/<key>` (line 102); no duplicates (line 104) | see 1.4, or `[]` with an `exception` |
| `implementation` | `production`, `prototype`, `mixed`, `guide`, `unreviewed` (line 14) | `"prototype"`; `"production"` when the story mounts shipped components |
| `boundary` | `fixtures`, `fixture-server`, `static`, `unreviewed` (line 15) | `"fixtures"` |
| `notes` | string (line 93) | what is simulated; say nothing proves production behaviour |
| `replacement` | repo-relative path of an existing story file (line 110) | omit |

Defaults when omitted: `status`, `implementation`, `boundary` are `"unreviewed"`; `notes` is `""` (line 77).

### 1.3 Placement and the literal-only rule

- `parameters` is an object literal with exactly one non-computed `paperclip` property (lines 47-51).
- Every value inside the block is a string, boolean, number, array or object literal; `as` and
  `satisfies` are unwrapped (lines 26-42). An identifier, call, spread or template string inside the block
  throws `metadata must be literal; expressions are not executed` (line 42). Expressions in `argTypes`,
  `args` and `component` are fine.
- No `...spread` or computed property may come after `paperclip` (lines 52-54). Literal properties may
  follow it; placing it last is convention, not rule.
- `annotation()` throws at scan time (one error per run); `validateCatalog` errors are joined (lines 189-190).

### 1.4 Capabilities

Ids come from `maps/feature-map/<area>.md`: the file stem is the area, each row `- \`key\`: ...` under
`## Sub-features` is a key, and the id is `<area>/<key>` matching `/^[a-z0-9-]+\/[a-z0-9-]+$/`
(`scripts/feature-map.mjs:24-37`).

- `ls maps/feature-map/` lists the areas; read the area's `## Sub-features`.
- No fitting area: `capabilities: []` plus an `exception` (`ui/storybook/stories/design-proposals/colors.stories.tsx:13-21`).
- Do not add a feature-map area without its agent-access companion: `checkMaps` validates both
  (`scripts/check-maps.mjs:31-34`, `maps/README.md:10-11`) and runs before the catalog (line 184).
- Proposals never count as coverage: `renderVerification` skips `proposed` and `historical` entries
  (line 165) and the index files them under "Proposed design system" (line 133).
- ARTIFACT-SPECIFIC: `documents-artifacts/library`, `documents-artifacts/work-products`,
  `documents-artifacts/attachments` (`maps/feature-map/documents-artifacts.md:17-21`).

### 1.5 Uniqueness

Meta ids are unique among meta ids (lines 112, 114). Story ids (per export) are unique and must not
collide with the generated `feature-map-<featureId>--overview` ids (line 113): never a meta id
`feature-map-<area>` with an export named `Overview`.

### 1.6 Worked example

`ui/storybook/stories/design-proposals/artifact-directions-compare.stories.tsx:38-59`. Reproduce the
shape; redraw every string.

```tsx
const meta = {
  id: "design-artifact-directions-compare",
  title: "Design proposals/Artifact directions/Compare",
  component: DirectionView,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Pick a direction and a surface. Today is the shipped components fed with the lab's fixtures; 1–5 are the explored directions.",
      },
    },
    paperclip: {
      capabilities: ["documents-artifacts/library", "documents-artifacts/work-products", "documents-artifacts/attachments"],
      status: "proposed",
      home: "design-proposals",
      implementation: "prototype",
      boundary: "fixtures",
      exception: "Design exploration staged in the artifact directions lab: the shipped baseline and five proposed directions compared on static mocks of the task thread, the side panel and the Artifacts page.",
      notes: "Controls pick a direction kit and a surface. Today mounts the shipped artifact components behind the lab's fetch stub with the acmehats fixture world; the other kits are lab components. Frames are static mocks of the product chrome; nothing here establishes production behaviour or access checks.",
    },
  },
```

Lines 60-74 add `argTypes` built from runtime constants (`DIRECTION_IDS`, `KIT_META`, `SURFACE_IDS`),
default `args`, and `} satisfies Meta<typeof DirectionView>;`. GENERIC: `layout: "fullscreen"`,
`docs.description.component`, the six `paperclip` fields, runtime constants in `argTypes`.
ARTIFACT-SPECIFIC: every string, the constants, the default args. The per-direction story
(`artifact-directions-hybrid.stories.tsx:27-48`) has the same block with no `component` and one `render`
export per surface and per slot (lines 56-155).

## 2. Validate the catalog; generated outputs are git-ignored

```sh
node scripts/storybook-catalog.mjs --check
```

- `--check` validates without writing; no flag or `--write` also writes the generated files (lines
  202-206); any other argument throws the usage error. Success prints
  `Storybook map: N files, M stories. Structure only; no runtime proof.` (316 files, 2973 stories here).
- `cd ui && pnpm typecheck` runs the catalog in write mode first:
  `"typecheck": "node ../scripts/storybook-catalog.mjs && tsc -b"` (`ui/package.json:23`).
  `ui/tsconfig.json:19` includes `src`, `storybook`, `vitest.setup.ts`, so lab code, tests and stories are typechecked.
- CI runs it on every PR: the Typecheck lane runs `pnpm run typecheck:build-gaps`
  (`.github/workflows/pr-trusted.yml:333`; `package.json:25`), and `scripts/run-typecheck-build-gaps.mjs:143-150,178-183`
  runs `pnpm --filter <name> typecheck` for each workspace whose `build` script has no `tsc`, which
  includes `ui` (`"build": "vite build"`, `ui/package.json:18`).
- `pnpm storybook` and `pnpm build-storybook` call `generateStorybook()` at config load
  (`ui/storybook/.storybook/main.ts:10`), so a bad annotation also stops Storybook. `pnpm build-storybook`
  is not on the default PR path, but `DESIGN.md:814` lists it as done-when: run it or report it as not run.
- The visual suite runs only with the `storybook-visual` label (`.github/workflows/storybook-visual.yml:42`)
  and screenshots every story in both themes with `maxDiffPixels: 0`
  (`tests/storybook-visual/playwright.config.ts:42`, `storybook-visual.spec.ts:108-118`); new stories have
  no baseline until a maintainer runs `pnpm test:storybook-visual:update`.
- `ui/storybook-static/`, `ui/storybook/generated/`, `ui/storybook/.storybook/preview.tsx` and
  `maps/generated/` are ignored (`.gitignore:11-14`). Never commit or hand-edit them (`maps/storybook-map/README.md:86-90`).

## 3. Token gates and the lab's `tokens.css`

`scripts/check-token-gates.mjs` scans only `ui/src/components/**` and `ui/src/pages/**` (`SCAN_DIRS`,
line 80), only `.ts/.tsx/.js/.jsx` files (line 111); Gate 4 reads `ui/src/index.css` alone (lines 81,
296-303). No other CSS file is read.

- GENERIC: a lab under `ui/src/<lab>/` is outside gates 1-3. Its per-direction `tokens.css` may hold raw
  hex, px, ms and `cubic-bezier` values and its components may use Tailwind bracket values; `DESIGN.md:30`
  permits this for demo/UX-lab surfaces (`doc/design/DECISION-SHEET.md:20`, ruling B1). Keep every raw
  value in a `tokens.css` scoped to `[data-direction="<id>"]`, light values in the base block and dark
  overrides under `.dark [data-direction="<id>"]`.
- Anything that graduates to product moves under `components/` or `pages/` and must become tokens in
  `ui/src/index.css` (`DESIGN.md:17,30`; a `tokens.css` is allowed there only when `index.css` imports it).
  The gates would fail the lab code as it stands.
- A lab page that must live under `ui/src/pages/` needs an `* allow ui/src/pages/<File>.tsx — <reason>`
  line in `index.css` (`check-token-gates.mjs:89-104`; precedent `ui/src/index.css:3195-3198`).
- ARTIFACT-SPECIFIC evidence: `ui/src/artifact-directions/directions/d5-v1-mvp/PanelRow.tsx:30,32,65`
  (`gap-[3px]`, `h-[2px]`, `rounded-[4px]`), `d5-v1-mvp/tokens.css:9-12,24-25,56-65` (hex, rgba, px),
  `d4-hybrid/tokens.css:97` (`--hy-stagger: 28ms`).

```sh
pnpm run check:token-gates
```

`package.json:47` chains `check-token-gates.mjs`, `sync-agent-palette-tokens.mjs --check` and
`sync-cliplab-character.mjs --check`. Use `pnpm run`; the bare shorthand has failed with
`Command not found` under pnpm 9.15.4 in a worktree. Expect four gates `CLEAN`.

## 4. PR rules from CONTRIBUTING and the template

- Fill every section of `.github/PULL_REQUEST_TEMPLATE.md`: `## Thinking Path` (line 3),
  `## Linked Issues or Issue Description` (19), `## What Changed` (52), `## Verification` (58), `## Risks`
  (67), `## Model Used` (78), `## Checklist` (93-108). Delete the template's HTML comments.
- `CONTRIBUTING.md:49`: no code file moves from under 1,000 lines to over. `CONTRIBUTING.md:50`: "Do not
  submit a PR that includes code comments." Neither is checked by commitperclip; Greptile enforces the
  1,000-line rule through `rules/pull-request-review.mdc:22-25`. PR #17213 merged with doc comments, which
  are still in the lab's stories, `tokens.css` files and Vite config; the Artifacts V1 feature (PR #17228)
  needed a follow-up commit (`e1433f508`) to strip its own: scaffold comment-free.
- Public references only: `#NNN`, `Fixes #NNN`, `github.com/paperclipai/paperclip` URLs; no `PAP-123`
  ids, instance or localhost links (`CONTRIBUTING.md:68-80`).
- Descriptive kebab-case branch name before pushing (`CONTRIBUTING.md:82-98`). No screenshots in the
  repo; put them in the PR (`CONTRIBUTING.md:100-106`).
- `Model Used`: provider, exact model id, context window, reasoning mode, tools (`CONTRIBUTING.md:108-110`).
  Simplified Technical English (`CONTRIBUTING.md:173`). Verification names what was not run and why
  (`AGENTS.md` section 7).

## 5. commitperclip gates (blocking)

`.github/workflows/commitperclip-review.yml` runs on `pull_request_target` (lines 4-5) from `master`
(lines 20-23) and fails when a blocking gate fails (lines 57-63). Blocking (`.github/scripts/run-quality-gates.mjs:139-145`;
the check scripts below sit in the same directory):
template, linked issue, dedup search, test coverage, lockfile. Dependencies, release bootstrap and
co-authors are informational.

### Template (`check-pr-template.mjs`)

Lines 9-15: `## Thinking Path` needs 3 or more items; `## What Changed`, `## Verification`, `## Risks`,
`## Model Used` need 1. Content runs to the next `\n## ` (lines 23-29); items split on terminal
punctuation, bullet or quote line starts, or blank lines, keeping items over 5 characters (line 35).
Empty content, `_No response_` or content starting with `<!--` fails (line 56). `Model Used` fails on
`provider, model id`, `your model`, `<model>` (lines 17-21).

### Linked issue (`check-pr-linked-issue.mjs`)

Skipped for `docs`, `chore`, `build`, `ci`, `style`, `test`, `revert` (line 21). A `feat:` PR passes by
path A or B:

- A: `(fixes|closes|resolves|refs) #N`, a `github.com/paperclipai/paperclip/issues/N` URL, or a bare `#N`
  (lines 14-18); HTML comments are stripped first (145-147, 178).
- B: at least 3 filled fields from ONE template's field set (line 25; loop 153-157); labels from different
  templates do not add up. A label stands alone on its line as `## Label`, `**Label**` or `Label:`; the
  content under it must be real: a lone `-` or `[...]` does not count (109-118, 122-132), and a label
  followed directly by another label is empty.
- Feature-request labels the gate counts (lines 39-44): `Problem or motivation` (`Problem`, `Motivation`),
  `Proposed solution` (`Solution`), `Alternatives considered` (`Alternatives`), `Roadmap alignment`
  (`Roadmap`). `.github/ISSUE_TEMPLATE/feature_request.yml` also has `Subsystem affected` (line 12) and
  `Additional context` (line 52); they do not count toward the 3.
- PR #17213 used path B with all six as `**Label**` lines. ARTIFACT-SPECIFIC: its roadmap line
  ("Artifacts & Work Products").

### Dedup search (`check-pr-dedup-search.mjs`)

A checked checkbox line matching
`/^\s*[-*]\s*\[\s*([ xX])\s*\][^\n]*search(?:ed)?[^\n]*(?:similar|duplicate|prior)[^\n]*\bprs?\b/im`
(lines 20-21). Check template line 98:
`- [x] I have searched GitHub for duplicate or related PRs and linked them above`. The other 13 checklist
items are not machine-checked.

### Test coverage (`check-pr-test-coverage.mjs`)

Skipped for `docs`, `chore`, `build`, `ci`, `style`, `refactor`, `revert` (line 21). Otherwise at least
one non-removed file matches `/\.test\.(ts|js|tsx|jsx|mjs|cjs)$/`, `/\.spec\....$/`, `/(?:^|\/)tests?\//`
or `/\/__tests__\//` (lines 11-16, 64-66). `.stories.tsx` files and fixture factories like
`test-artifact.ts` do not count. A `docs:`/`chore:`/`build:`/`ci:` title with source changes fails
(lines 25, 43-57). Title a lab PR `feat(ui): ...` and ship at least one `.test.ts(x)`.

### Lockfile (`check-pr-lockfile.mjs`)

A diff touching `pnpm-lock.yaml` fails unless the author is `github-actions[bot]` on
`chore/refresh-lockfile` (lines 9-14). A lab adds no dependencies and commits no lockfile change.

## 6. Greptile and the `rules/*.mdc` files

- Greptile must score 5/5 with no open P2+, recommendations or follow-ups (`CONTRIBUTING.md:126-134`);
  it reads rules through `.greptile/files.json` and `.greptile/rules.md` (`rules/README.md:15-19`).
- No rule's `globs` covers `ui/` or `ui/storybook/` (scoped rules cover `server/`, `packages/db`,
  adapters, adapter-utils, plugins, runner). Only the three `alwaysApply: true` rules apply to a lab PR:
  `rules/pull-request-review.mdc` (no screenshot requests, lines 17-21; 1,000-line crossing, lines 22-25),
  `rules/module-boundaries.mdc`, `rules/product-harness-responsibility.mdc`.
- `.greptile/rules.md` last line: "Do not add package.json scripts for new utilities, checks, benchmarks,
  or specialized tests." Invoke the lab's Vite config directly and record the command in
  `.claude/launch.json` (ARTIFACT-SPECIFIC: `.claude/launch.json:27-44`, ports 5180 and 5190;
  `ui/vite.artifact-directions.config.mjs:10-26`).

## 7. Vitest conventions and the lab-only test command

The `ui` project (`vitest.config.ts:28`) uses `environment: "node"`, processes no CSS except
`motion-tokens.css`, and loads `./vitest.setup.ts` (`ui/vitest.config.ts:11-14`), which mocks
`localStorage` and stubs `Element.prototype.scrollIntoView` (`ui/vitest.setup.ts:3-40`). Kit
`import "./tokens.css"` lines are inert; assert on class names, attributes and inline styles, not
computed styles.

- Pure modules: no pragma, `import { describe, expect, it } from "vitest"`, relative import of the module
  (`ui/src/artifact-directions/lab-state.test.ts:1-7`, `directions/d5-v1-mvp/when.test.ts:1-4`,
  `kinds.test.ts`, `MediaPrint.test.ts`).
- DOM tests (`ui/src/artifact-directions/directions/d5-v1-mvp/Thread.test.tsx:1-27`; the hooks sit inside
  `describe` after `let container: HTMLDivElement; let root: Root;`):

```tsx
// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
```

Render with `act(() => root.render(<X />))`. A test that stubs `window.fetch` restores it in `afterEach`
(`ui/src/artifact-directions/api-stub.test.ts:7-14`). A fixture factory `test-<entity>.ts` takes
`Partial<T> & Pick<T, "kind">` (`d5-v1-mvp/test-artifact.ts`) and is not a test file for the coverage gate.

When a tested component renders the app's `Link`, mock `CompanyContext` and wrap in `MemoryRouter`:
`ui/src/lib/router.tsx:67` exports a `Link` that reads `useCompany()` (lines 5, 31). Pattern
(`ui/src/plugins/outlet-errors.test.tsx:4,13,35`):

```tsx
import { MemoryRouter } from "react-router-dom";
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: null }) }));
```

The artifact lab's own tests render no `Link` and do not use this mock.

Run only the lab's tests (`ui/package.json` has no `test` script):

```sh
cd ui && npx vitest run src/<lab>
```

ARTIFACT-SPECIFIC: `cd ui && npx vitest run src/artifact-directions` runs 6 files, 31 tests. Run one
full `ui` vitest at a time; concurrent full runs produce spurious failures.

## 8. Hand-off checklist

Run each from the repo root, in this order; paste results under `## Verification` with a `Not run:` line
for anything skipped and why. The first five are what
`node .agents/skills/directions-lab/scripts/scaffold.mjs check --slug <slug> --run` runs, stopping at the
first failure (`scripts/lib/check.mjs:148-154`); `pnpm build-storybook` stays a manual step that `--run`
reports as `Not run:`.

```sh
cd ui && npx vitest run src/<slug>-directions
node scripts/storybook-catalog.mjs --check
pnpm run check:token-gates
cd ui && <SLUG>_DIRECTIONS_OUT_DIR=node_modules/.<slug>-directions-dist npx vite build --config vite.<slug>-directions.config.mjs
cd ui && pnpm typecheck
pnpm build-storybook
```

- Fresh worktree: `pnpm install --frozen-lockfile` and build `@paperclipai/plugin-sdk` first, or `tsc`
  reports `Cannot find module '@paperclipai/plugin-sdk/ui'` in `PluginOrganizationSwitcher(.test).tsx`.
  Repo-wide `pnpm -r typecheck` needs the Rust toolchain for `paperclip-runner`; report it as not run when absent.
- PR title `feat(ui): ...`; one or more `.test.ts(x)` files in the diff; no `pnpm-lock.yaml` change; no new
  `package.json` script; no file crossing 1,000 lines; no code comments; no committed screenshots or
  generated files.
- Body: five `##` sections with content, path A link or path B with 3 filled feature-request labels,
  checked dedup checkbox, concrete `Model Used`. Then Greptile 5/5 and maintainer approval.
