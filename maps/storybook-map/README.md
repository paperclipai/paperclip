# Storybook map

Browse the [published feature guide](https://d1p6rlowie26tp.cloudfront.net/storybook/branches/master/?path=/story/overview-storybook-guide--coverage-guide),
or run `pnpm storybook` for the current checkout. The feature and capability IDs
come from the [feature recipes](../feature-map/README.md). Product behavior and
permissions remain governed by the implementation spec and access companions.

## Authored sources

Each story owns its small `parameters.paperclip` annotation. There is no authored
central catalog, review ledger, date stamp, source list or fingerprint to update.
Storybook's CSF parser supplies filenames, titles, explicit meta IDs, exports,
play-function counts and story IDs without executing story modules.

```ts
const meta = {
  id: "tasks-create",
  title: "Tasks and conversations/Task creation and lifecycle/Create",
  parameters: {
    paperclip: {
      capabilities: ["tasks/create"],
      implementation: "production",
      boundary: "fixtures",
      notes: "Uses the shipped composer; submission is simulated.",
    },
  },
};
```

`capabilities` is an array of stable `area/capability` IDs. Its first entry is the
primary home; others cross-list the same suite. An empty array requires an
`exception` explaining the intentional scope. Shared foundations may use
`home: "foundations"` with an exception to keep their existing location and links.
Staged design work may use `home: "design-proposals"`, with `status: "proposed"`
and an exception explaining why it is staged separately from production references.
The metadata must be literal; place it after any other parameter spreads.

| Field | Values and purpose |
| --- | --- |
| `status` | `current`, `proposed`, `historical`, `mixed`, `unreviewed` (default). Authored product alignment intent, not a live review certificate. |
| `implementation` | `production`, `prototype`, `mixed`, `guide`, `unreviewed` (default). What actually renders. |
| `boundary` | `fixtures`, `fixture-server`, `static`, `unreviewed` (default). What is simulated or requires an owned fixture. |
| `notes` | Optional durable scenario limits and rationale. Do not append a history of unrelated changes. |
| `replacement` | Optional repository-relative path of an existing replacement story. |

A production component can use fixtures. A prototype that imports production
primitives remains a prototype of its outer subject. Use `unreviewed` when intent
or parity is unclear. Preserve useful historical examples and their explanations.
Historical examples, proposals and guides do not remove missing-example gaps.
No annotation or story count proves permissions, persistence, provider behavior,
full recipe coverage or passing tests.

## Navigation and outputs

Stories live in `ui/storybook/stories/<primary-feature-area>/`. Sidebar titles use
the recipe's section and H1 title, followed by the suite name. `/` in feature
labels becomes `, ` in the sidebar. Preserve explicit CSF IDs across title/folder
changes. Compare the built `index.json` when changing navigation.

**Design proposals** is a separate top-level review section. Its stories live in
`ui/storybook/stories/design-proposals/`, with titles beginning `Design proposals/`.
Group these titles by **Foundations** (tokens), **Components** (reusable UI),
**Layouts** (page structures), **Pages** (complete screens), **Patterns** (shared
behavior) and **Guidelines** (usage and contribution rules), in that order.
Create a group when there are stories for it; do not add empty placeholders.
For example, color tokens belong in `Design proposals/Foundations/Colors (dark mode)`,
the task table in `Design proposals/Components/Task list`, and its complete page
in `Design proposals/Pages/Tasks`. Preserve explicit story IDs and exports when
reorganizing so links and browser tests remain valid.
Retain capability references so proposals remain discoverable from the feature
guide, but never count them as current production examples. Keep using shared
components and tokens rather than creating a parallel design implementation.
When a proposal is reviewed and adopted in the app, move its story into the usual
feature or Foundations home, update its classification and staging metadata, and
preserve the explicit CSF ID and exports so review links remain valid.

The generator discovers feature recipes and story annotations. It assembles:

- `ui/storybook/generated/catalog.json` and `feature-index.json`.
- A generated Overview story per feature, retaining `feature-map-<area>--overview`.
- `ui/storybook/.storybook/preview.tsx`, with the literal sidebar order required
  by Storybook and the authored decorators/fixtures from `preview-base.tsx`.
- Markdown feature, access, Storybook and verification indexes, plus the current
  page inventory, under `maps/generated/`.

All these outputs are ignored. Storybook start/build and UI typechecking generate
from a fresh checkout. The published Storybook includes the guide and each feature's
verification scope. After edits during a dev session, rerun the generator (restart
Storybook after navigation changes). Obsolete generated Overview files are removed.
Never edit generated outputs or commit them to resolve a merge conflict.

## Checks and review

```sh
node scripts/check-maps.mjs
node scripts/storybook-catalog.mjs
node scripts/storybook-catalog.mjs --check
node --test scripts/check-maps.test.mjs scripts/storybook-catalog.test.mjs scripts/storybook-feature-index.test.mjs
```

`--write` is a compatibility alias for the default generation command. `--check`
validates authored inputs without requiring existing outputs or writing files.
Checks reject malformed annotations, unknown capabilities, duplicate IDs, broken
map references, missing companions and invalid navigation. CI runs the map tests
through the UI Vitest suite and validates/generates inputs during UI typechecking.

Use Git diffs to select changed stories, rendered subjects, fixtures, and recipes
for review. A changed source is a review candidate, not an instruction to refresh
metadata on every dependent example. Inspect actual imports and contracts; shared
fixture changes can require broad review without broad acknowledgement edits.
Keep revision-specific findings and executed evidence in the PR, issue or CI
artifact. Move only durable limitations into the affected source annotation or
recipe. Past review history remains available through Git.

`maintain-storybook` owns stories and their annotations; `review-storybook` exercises
them. Product/access maintenance owns the recipes, including optional capability
verification scope. Use the [existing Storybook browser workflow](../../doc/DEVELOPING.md#storybook).
Report source inspection, rendering, play assertions, visual comparison and
production acceptance separately. Do not publish new baselines to pass a map cleanup.
