---
navigation: {"section":"Automation and structured work","sectionOrder":60,"order":20}
---

# Pipelines, review queues, and learnings

With the pipeline experiment enabled, people move structured work through configured stages, inspect stage automation, review outputs, and retain learning records.

Implementation: [pipeline board and item hosts](../../ui/src/pages/Pipelines.tsx), [pipeline configuration](../../ui/src/pages/PipelineSettings.tsx).

Agent access: [companion](../agent-access-map/pipelines.md).

## Sub-features

- `stages`: configure stage order, behavior, and automation assignees.
- `items`: create or inspect items, grouping, stage state, and work references.
- `review`: act on the pipeline review queue and inspect the resulting transition.
- `learnings`: inspect the separate learning view and its source context.

## How to get to it (user POV)

### `pipeline-board`

Open `/pipelines`, `/pipelines/:pipelineId`, and its Settings route.

### `item-review-learning`

Open `/pipelines/:pipelineId/items/:caseId`, `/review-queue`, or `/learnings`.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Enable pipelines and prepare a disposable pipeline with at least two stages and a fixture agent. Record any associated case type.

### `pipeline-board`

Automated: [pipeline UI helpers](../../ui/src/pages/Pipelines.test.tsx) cover grouping and presentation helpers; [pipeline service](../../server/src/__tests__/pipelines-service.test.ts) covers service behavior.

Manual: Configure stages and a harmless automation, add an item, and inspect its stage. Follow its task/work references and observe the resulting transition. Reload grouping and settings; verify rejected or failed transitions leave the item in an intelligible state.

### `item-review-learning`

Automated: [pipeline tutorial browser suite](../../tests/e2e/pipelines-tutorial-flow.spec.ts) targets a fixture journey; it does not qualify arbitrary stage automation or learning quality.

Manual: Open a pending review, inspect its source output and revision, accept or reject, and verify the persisted stage outcome. Follow a learning record to its source context and confirm it belongs to the intended pipeline/company.

## Gotchas

- Learnings is filtered case-event history, such as review decisions and forced
  moves, not a separate authored learning-record system. The UI visibility flag
  is separate from API authorization.

- These routes are experimental and may redirect or deny access when disabled.
- ReviewQueue and Learnings are hosted from the pipeline module; a page-file inventory alone misses them.
- Pipeline items and free-standing [cases](./cases.md) share records but have different navigation contexts.

### Storybook verification

#### `stages`

Scope: ui
Storybook: Mount PipelineSettings ordered stages, automation assignees/env, invalid transitions, unsaved state, saving and failed save.
Production: POST/PATCH stages and PUT /pipelines/{id}/transitions must persist valid order/configuration, enforce ownership and reject invalid transitions; actual automation execution remains separate.
Sources: Source: [PipelineSettings.tsx](../../ui/src/pages/PipelineSettings.tsx), [pipelines.ts](../../server/src/routes/pipelines.ts). Tests: [PipelineSettings.test.ts](../../ui/src/pages/PipelineSettings.test.ts), [pipelines-service.test.ts](../../server/src/__tests__/pipelines-service.test.ts), [pipelines-routes.test.ts](../../server/src/__tests__/pipelines-routes.test.ts)

#### `items`

Scope: ui
Storybook: Mount Pipelines/PipelineItemDetailView board grouping, item creation/details, stage/health/work references, empty/loading and failed transition.
Production: GET/POST /pipelines/{id}/cases and POST /cases/{id}/transition must maintain company scope, valid stage changes and linked work; fixture stage state does not prove automation.
Sources: Source: [Pipelines.tsx](../../ui/src/pages/Pipelines.tsx), [PipelineWorkReferences.tsx](../../ui/src/components/PipelineWorkReferences.tsx), [pipelines.ts](../../server/src/routes/pipelines.ts). Tests: [Pipelines.test.tsx](../../ui/src/pages/Pipelines.test.tsx), [pipelines-service.test.ts](../../server/src/__tests__/pipelines-service.test.ts), [pipelines-routes.test.ts](../../server/src/__tests__/pipelines-routes.test.ts), [pipelines-tutorial-flow.spec.ts](../../tests/e2e/pipelines-tutorial-flow.spec.ts)

#### `review`

Scope: ui
Storybook: Mount ReviewQueue and item review pending output/revision, accept/reject/request-changes, bulk selection, stale/conflicting submission and errors.
Production: POST /cases/{id}/review and /companies/{id}/review-cases/bulk must authorize reviewer, persist correct outcome/transition and reject stale or invalid input.
Sources: Source: [Pipelines.tsx](../../ui/src/pages/Pipelines.tsx), [pipelines.ts](../../server/src/routes/pipelines.ts). Tests: [Pipelines.test.tsx](../../ui/src/pages/Pipelines.test.tsx), [pipelines-routes.test.ts](../../server/src/__tests__/pipelines-routes.test.ts), [pipelines-service.test.ts](../../server/src/__tests__/pipelines-service.test.ts), [pipelines-tutorial-flow.spec.ts](../../tests/e2e/pipelines-tutorial-flow.spec.ts)

#### `learnings`

Scope: ui
Storybook: Mount actual Learnings export with filtered case events, review/forced-move entries, source links, empty/loading/error. This is event history, not a separately authored learning-record system.
Production: GET /companies/{id}/case-events in pipelines routes needs existing company/access contract tests; a rendered event cannot establish learning quality.
Sources: Source: [Pipelines.tsx](../../ui/src/pages/Pipelines.tsx), [pipeline-learnings.ts](../../ui/src/lib/pipeline-learnings.ts), [pipelines.ts](../../server/src/routes/pipelines.ts). Tests: [Pipelines.test.tsx](../../ui/src/pages/Pipelines.test.tsx), [pipelines-routes.test.ts](../../server/src/__tests__/pipelines-routes.test.ts), [pipelines-service.test.ts](../../server/src/__tests__/pipelines-service.test.ts)
