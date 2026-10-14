---
name: review-storybook
description: Review Paperclip stories for a feature or change using the Storybook catalog, production source, and existing browser tests. Report component, mock, interaction, and visual evidence separately.
---

# Review Storybook

Read the [catalog contract](../../../maps/storybook-map/README.md) and find the
requested capability in its generated index. Check the relevant feature recipe,
production subject, and story before driving it. Catalog status is prior review
context, not proof of the current revision. This skill consumes the maps/catalog;
corrections belong to `maintain-storybook` or `maintain-verification-skill`.

Choose discriminating states for the requested change: the normal action and
result, relevant failure/retry, gate/permission presentation, and mobile/theme
variants where affected. Record chosen files/exports and omitted scope. For a
full source review, account for every file; do not describe sampling as full
render or interaction coverage.

When reviewing navigation/index changes, compare the guide and sidebar with the
full ordered index generated from feature recipes' navigation metadata. Open a feature without examples and a
feature whose related suite lives elsewhere; check capability order, gap messages,
classifications, recipe links, and actual suite navigation. Compare built entry IDs
before/after so existing links survive. Generated Overview pages do not establish
new example coverage.

Use [the existing Storybook commands](../../../doc/DEVELOPING.md#storybook):
`pnpm build-storybook`, or an owned Storybook dev server on an available local
port. Use the built `ui/storybook-static/index.json` for actual story IDs and
links. Do not trust an unrelated server on the default port. Keep the process
handle and stop only the server this review started, retaining useful evidence.

Inspect the real rendered subject, including errors and browser console output.
For interactive stories, wait for their `play` assertions to complete and inspect
the observable result. A screenshot alone does not prove `play` passed. Verify
fixture isolation by revisiting/resetting relevant stories when they mutate
fetch handlers, storage, query caches, time, or module state. Avoid real provider
actions; explicitly document any live dependency required by a story.

The existing visual suite is
`tests/storybook-visual/storybook-visual.spec.ts`. It uses external baselines and
a pinned Linux environment. Inspect `baseline-manifest.json` before claiming
visual regression proof. An unpublished manifest blocks comparisons; a macOS
capture is useful inspection, not the Linux baseline. Do not update/publish
baselines just to make a review pass. Use existing focused browser suites where
they cover the requested scenario, and the production verification skill when
the question requires backend persistence, real authorization, or provider proof.

Report each selected case as passed, failed, blocked, or not run, naming revision,
story ID, environment, production versus prototype subject, simulated boundaries,
action/assertion and observed result. Separate render, interaction, visual
comparison, and production acceptance evidence. Report proven drift with exact
source references and a proposed correction; do not lower expectations, remove
failing cases, or silently bless historical behavior as current.
