# Pipelines, review queues, and learnings

With the pipeline experiment enabled, people move structured work through configured stages, inspect stage automation, review outputs, and retain learning records.

Implementation: [pipeline board and item hosts](../ui/src/pages/Pipelines.tsx), [pipeline configuration](../ui/src/pages/PipelineSettings.tsx).

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

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Enable pipelines and prepare a disposable pipeline with at least two stages and a fixture agent. Record any associated case type.

### `pipeline-board`

Automated: [pipeline UI helpers](../ui/src/pages/Pipelines.test.tsx) cover grouping and presentation helpers; [pipeline service](../server/src/__tests__/pipelines-service.test.ts) covers service behavior.

Manual: Configure stages and a harmless automation, add an item, and inspect its stage. Follow its task/work references and observe the resulting transition. Reload grouping and settings; verify rejected or failed transitions leave the item in an intelligible state.

### `item-review-learning`

Automated: [pipeline tutorial browser suite](../tests/e2e/pipelines-tutorial-flow.spec.ts) targets a fixture journey; it does not qualify arbitrary stage automation or learning quality.

Manual: Open a pending review, inspect its source output and revision, accept or reject, and verify the persisted stage outcome. Follow a learning record to its source context and confirm it belongs to the intended pipeline/company.

## Gotchas

- These routes are experimental and may redirect or deny access when disabled.
- ReviewQueue and Learnings are hosted from the pipeline module; a page-file inventory alone misses them.
- Pipeline items and free-standing [cases](./cases.md) share records but have different navigation contexts.
