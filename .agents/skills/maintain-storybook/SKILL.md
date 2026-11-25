---
name: maintain-storybook
description: Keep Paperclip stories and their downstream catalog aligned with the feature map and production UI. Use to reconcile story drift, classify prototypes, update fixtures, or maintain feature coverage.
---

# Maintain Storybook

Read the [Storybook catalog contract](../../../maps/storybook-map/README.md),
the relevant [feature recipes](../../../maps/feature-map/README.md), and
[DESIGN.md](../../../DESIGN.md). The feature map is an upstream input. This skill
owns stories, their fixtures/support, and `maps/storybook-map/`; it does not edit
the feature or agent-access maps. Report upstream drift to
`maintain-verification-skill` with source evidence.

## Reconcile the requested scope

For a feature/change, follow its capability IDs to catalog entries and shared
dependencies. For a full inventory, account for every configured story file,
including historical examples. Start with `node scripts/storybook-catalog.mjs`.
Record the source revision and whether the pass covers source, rendering,
interactions, or visual comparisons. Inventory completeness is not behavioral
coverage. Do not expand a targeted maintenance request into an all-product audit.

Compare each affected story's rendered subject, props, fixture responses, actions,
and assertions with the production implementation and recipe. Follow imported
wrappers: a production Button inside a locally recreated page does not make that
page a production-component story. A real production page using mocked APIs is
valid isolation; record component provenance and data simulation separately.
Inspect mock methods/paths, payload shapes, errors, identity, gates, and reset
behavior. An API method returning success without the relevant state transition
can hide drift. Do not replace errors with generic successful mocks to pass.

Prefer mounting the shipped subject and mocking its external boundary. Retain
local layout wrappers and fixture data when they serve that isolation. Replace a
duplicate product implementation only when the current component expresses the
same scenario without losing the original purpose. Production bugs and larger
redesigns are separate findings, not reasons to rewrite expected behavior.

Classify current examples, proposals, historical explorations, and unresolved
cases explicitly. Use `unreviewed` when evidence does not establish parity.
Retain useful superseded work with its rationale and replacement reference;
do not delete a story merely because it is old, mocked, or duplicated by name.
Record mixed suites honestly and split them only when that improves review.

## Preserve identity and keep the index useful

Assign existing stable `area/capability` references, with one primary reference
and optional related references. Foundations and unmapped proposals need explicit
reasons rather than invented capabilities. Cross-cutting stories have one source
and several references. Do not count historical/proposed stories as current
feature coverage.

For shared foundations that demonstrate a mapped capability, keep their existing
folder/sidebar with `home: "foundations"` and an exception reason, then add related
capability references. Inspect the named exports before linking them. Notes must
name the demonstrated states and remaining limits; an association does not certify
the whole capability. If a story reveals a shipped capability absent upstream,
reconcile its feature recipe and access companion through map maintenance first.

Preserve story exports and IDs. Before moves/title changes, capture the existing
built `index.json`; use explicit meta IDs when needed and compare IDs afterward.
Place stories under `ui/storybook/stories/<primary-feature-area>/`. Use the feature
map's section and feature names as their sidebar prefix; keep useful scenario
groupings beneath that prefix. Put shared fixture modules in `ui/storybook/support/`.
Keep the explicit CSF meta ID stable even when the title changes; the generated
catalog derives `stableId` from it. Unmapped component examples belong under Foundations; the catalog guide
belongs under Overview. The checker verifies these conventions.

Keep the main guide and every feature Overview congruent with the upstream index:
same section/feature names and order, all capabilities in recipe order, related
suite links across primary homes, and explicit missing examples. Run `node scripts/storybook-catalog.mjs` to regenerate ignored indexes, feature
pages, and preview ordering. Storybook startup/build also generates them. Never
hand-edit or commit generated output. Generated guides are not example coverage.
Preserve their `feature-map-<area>--overview` IDs. The generator removes obsolete
pages from its own ignored output directory when areas disappear.

Keep review links and snapshot names working. Prefer classification fixes before
bulk directory moves. Store capability associations, classification, and durable
limits in each story's literal `parameters.paperclip` object. Infer file paths,
exports and stable IDs from CSF; do not maintain a second inventory. Use Git diff
and history to choose changed production subjects, fixtures and shared sources
for review. Record source revision and executed evidence in the PR or CI report;
do not refresh hashes, dates, or a shared review journal.

Verification routes belong in each feature recipe's optional `Storybook
verification` section. Report needed corrections to `maintain-verification-skill`.
Distinguish missing shipped UI examples from CLI/operator operations and real
browser checks. Keep concrete production contracts and existing test starting
points; test presence is not passing evidence. The generated verification report
lists capabilities without current examples. Associating an example must not
discard its separate production verification obligations.

Run `node scripts/storybook-catalog.mjs --check` and
`node --test scripts/check-maps.test.mjs scripts/storybook-catalog.test.mjs scripts/storybook-feature-index.test.mjs`.
Checks validate local annotations, discovered inventory and references, not
semantic parity or runtime health.
Use `review-storybook` for affected rendering and interactions. Reuse the existing
Storybook/Playwright tools; add no separate launcher, runtime, or baseline system.
Do not accept new screenshot baselines as part of a catalog cleanup.

Report what was corrected, retained, and still needs review, naming exact files
and capabilities. Keep source-only results separate from executed results and
name blocked checks. A full pass must not hide unreviewed stories or claim that
fixture interactions establish production API, permission, or provider behavior.
