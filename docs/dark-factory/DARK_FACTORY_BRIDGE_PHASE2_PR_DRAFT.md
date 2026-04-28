PR Draft: Productize Dark Factory bridge plugin projection semantics

Status: product-branch draft only. This file is not a created PR.

Branch: dark-factory-product-main

Summary

This PR productizes the Paperclip Dark Factory bridge example plugin and strengthens its Phase 2 projection semantics.

The plugin remains projection-only:

- Dark Factory Journal remains the truth source.
- The Paperclip plugin namespace DB stores only projection/cache/cursor/receipt data.
- Rehydrate remains a request/receipt/intention flow, not terminal success.
- Provider/model semantics remain role-based and do not encode concrete model names as protocol MUSTs.

Changed files

- packages/plugins/examples/paperclip-dark-factory-bridge-plugin/src/manifest.ts
  - Registers the plugin manifest, routes, UI extension points, data/actions, and capabilities.
- packages/plugins/examples/paperclip-dark-factory-bridge-plugin/src/worker.ts
  - Implements mock/read-only projection, journal cursor, provider health, and rehydrate request handlers.
- packages/plugins/examples/paperclip-dark-factory-bridge-plugin/src/ui/index.tsx
  - Adds dashboard/detail UI for projection status, journal cursor, callback receipt, provider health, and degraded/stale/blocked states.
- packages/plugins/examples/paperclip-dark-factory-bridge-plugin/migrations/001_dark_factory_projection.sql
  - Creates plugin namespace projection/cache/cursor/receipt storage only.
- packages/plugins/examples/paperclip-dark-factory-bridge-plugin/tests/plugin.spec.ts
  - Covers manifest parsing, projection truth-source markers, cursor semantics, stale/degraded states, rehydrate receipt semantics, and provider/model role boundaries.
- packages/plugins/examples/paperclip-dark-factory-bridge-plugin/.gitignore
- packages/plugins/examples/paperclip-dark-factory-bridge-plugin/esbuild.config.mjs
- packages/plugins/examples/paperclip-dark-factory-bridge-plugin/package.json
- packages/plugins/examples/paperclip-dark-factory-bridge-plugin/rollup.config.mjs
- packages/plugins/examples/paperclip-dark-factory-bridge-plugin/tsconfig.json
- packages/plugins/examples/paperclip-dark-factory-bridge-plugin/vitest.config.ts
  - Add the plugin package to the workspace build/test flow.
- pnpm-lock.yaml
  - Locks workspace dependency metadata for the example plugin package.

Safety boundaries

- The plugin DB does not store authoritative Dark Factory Journal records.
- The plugin DB does not store secrets, tokens, provider credentials, API keys, passwords, or connection strings.
- Projection responses include:
  - authoritative: false
  - truthSource: "dark-factory-journal"
  - source: "dark-factory-projection"
- Rehydrate request returns a receipt/intention only.
- Provider/model selection remains role-based.
- Paperclip issue/task main model is not changed.
- Dark Factory Journal remains the truth source.

Validation

Run locally:

- git diff --check origin/master...HEAD
- pnpm --filter @paperclipai/plugin-sdk build
- pnpm --filter @paperclipai/plugin-dark-factory-bridge-example typecheck
- pnpm --filter @paperclipai/plugin-dark-factory-bridge-example test
- pnpm --filter @paperclipai/plugin-dark-factory-bridge-example build
- pnpm run typecheck

Latest local results after whitespace cleanup:

- git diff --check origin/master...HEAD: passed
- pnpm --filter @paperclipai/plugin-sdk build: passed
- pnpm --filter @paperclipai/plugin-dark-factory-bridge-example typecheck: passed
- pnpm --filter @paperclipai/plugin-dark-factory-bridge-example test: passed; 7 tests passed
- pnpm --filter @paperclipai/plugin-dark-factory-bridge-example build: passed
- pnpm run typecheck: passed

Secret / credential review

A redacted keyword classification scan was run over files changed versus origin/master...HEAD.

- hit_count: 58
- manual_review_required: 0
- Findings were classified as policy text about not storing credentials or lockfile package/metadata keyword hits.
- No token, secret, password, API key, connection string, private key, or bearer credential value was printed in the scan output.

CI status

- fork 当前 CI 不可见或未触发。
- The fork branch currently has no visible GitHub Actions run.
- gh run list for siyuah/paperclip on dark-factory-product-main returned an empty list.
- Do not state that CI succeeded.

Mock/dry-run limitations

- Current bridge implementation does not connect to real Dark Factory.
- Provider health is mock/read-only projection.
- Journal cursor and callback receipt are projection semantics, not production journal replay.
- Rehydrate request does not advance real execution state.

Risks

- Upstream plugin API may continue to change.
- Projection and authoritative journal consistency need Phase 3 reconciliation tests.
- Full runtime integration is not implemented yet.
- Existing mock/dry-run behavior should not be interpreted as production Dark Factory integration.

Next Phase 3 plan

- Add journal replay mock harness.
- Add idempotent callback handling tests.
- Add out-of-order and duplicate callback tests.
- Add cursor monotonicity and gap detection tests.
- Add reconciliation status API.
- Optionally add UI operator action for rehydrate request approval state.

Operational notes

- No PR has been created by this draft.
- No tag has been created.
- No GitHub Release has been modified.
- No GitHub repo settings have been modified.
- /home/siyuah/workspace/123 V3.0 binding artifacts were not touched.
