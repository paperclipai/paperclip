# Status cards and refreshed summaries

The status-card experiment turns a saved prompt/query into an inspectable summary of watched work, with refresh history, configuration, and archive/restore controls.

Implementation: [status page](../ui/src/pages/StatusCards/index.tsx), [card detail](../ui/src/pages/StatusCards/StatusCardDetailDrawer.tsx).

## Sub-features

- `authoring`: create a card and configure its prompt, refresh behavior, and summarizer.
- `generation`: observe compilation/refresh tasks and their successful or failed output.
- `inspection`: read the summary, watched work, history, and available query debugging.
- `archive`: archive and restore without confusing a stale summary with a current result.

## How to get to it (user POV)

### `status-board`

Open `/status`, choose New card, and follow a card at `/status/:cardId`.

### `card-settings`

Open the card detail’s settings/query-debug controls and archive/restore actions.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Enable status cards, use a configured summarizer and disposable tasks, and record whether summary generation is simulated or live.

### `status-board`

Automated: [status-card service/routes](../server/src/__tests__/status-cards.test.ts) covers gated lifecycle and generation contracts; [tile UI](../ui/src/pages/StatusCards/StatusCardTile.test.tsx) covers rendering.

Manual: Create a bounded card, inspect its generation task, and wait for a saved summary. Change a watched task, refresh, and verify both the summary and update history reflect the source change. Exercise a failed generation and confirm it is not presented as fresh.

### `card-settings`

Automated: [settings form](../ui/src/pages/StatusCards/StatusCardSettingsForm.test.tsx) and [update engine](../server/src/__tests__/status-card-update-engine.test.ts) cover separate UI/engine layers.

Manual: Change a disposable card’s prompt or summarizer, run the offered rebuild/refresh, and inspect the resulting query and summary. Archive and restore it, reload its direct link, and check the actual new generation outcome.

## Gotchas

- Summary quality needs comparison against source work, not just a successful task status.
- A saved old summary must not be counted as a successful new refresh.
- Experimental visibility, author permissions, and agent ownership constrain mutation.
