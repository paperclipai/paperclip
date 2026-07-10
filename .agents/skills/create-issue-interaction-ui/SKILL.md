---
name: create-issue-interaction-ui
description: >
  Add a new Paperclip issue-thread interaction kind end-to-end. Use when repo
  work introduces or extends interaction cards like request_confirmation,
  checkbox confirmations, ask_user_questions, or suggest_tasks.
---

# Create a new issue-thread interaction UI (Developer/maintainer skill)

This skill walks a Paperclip contributor through introducing a new issue-thread
interaction kind from shared contract to issue-detail wiring, helpers, and
docs. It is intentionally a Developer/maintainer skill: the audience is a
human or coding agent making code changes inside `paperclipai/paperclip`, not
the operational agents that run inside a deployed Paperclip company.

Do NOT install this on production Paperclip agents. This guide is for repository contributors changing Paperclip itself.

## When to use

- A new interaction kind is being introduced (compact picker, structured
  rating, in-thread approval card, etc.).
- An existing interaction needs a parallel variant with a distinct payload
  shape, validation, or resolution outcome (and `ask_user_questions` is the
  wrong fit because option count, target binding, or result shape differs).
- A reviewer asks for "the same audit, staleness, supersede, and continuation
  semantics as the other interactions" on a new card.

## When NOT to use

- Adding fields to an existing interaction kind that does not need a new
  payload schema. Patch the existing validators/UI in place instead.
- Changing how Paperclip agents *call* interactions. Update `skills/paperclip`
  or `references/api-reference.md`; that is agent guidance, not card work.
- Building a non-thread UI (issue detail sidebar, project board widget, etc.).
  Those have their own component conventions.

## Mental model

Every issue-thread interaction has four moving parts:

| Layer        | Owns                                                                                              |
|--------------|---------------------------------------------------------------------------------------------------|
| Shared       | Kind constant, payload/result interfaces, Zod validators, exported types, shared-test coverage.    |
| Server       | Service create/accept/reject/respond, staleness, supersede, idempotency, activity log, wake send. |
| UI           | Card pending/resolved/stale states, fixtures, Storybook, issue-thread/IssueDetail wiring.         |
| Helpers/Docs | CLI command, MCP tool, plugin SDK type+host+testing path, `skills/paperclip` guidance.            |

The four existing kinds are the canonical prior art. Pick the closest one and
copy its plumbing rather than inventing parallel mechanics:

- `request_confirmation` — single yes/no bound to a `target` with stale/supersede.
- `request_checkbox_confirmation` — bounded multi-select against an immutable option set.
- `ask_user_questions` — small typed form, no target binding.
- `suggest_tasks` — proposes tasks the board can accept individually.

If your new card needs target binding and a yes/no-style resolution, model it
after the two `request_*` kinds. If it is a structured form, model it after
`ask_user_questions`. If it produces creatable child entities, model it after
`suggest_tasks`.

## The canonical worked example

The current best end-to-end reference is the checkbox confirmation rollout
(merged in `4d5322c82`, GitHub PR `#7649`). Read that diff before starting:

```sh
git show --stat 4d5322c82
```

The plan it implemented is preserved as an issue document on
[PAP-10415](/PAP/issues/PAP-10415#document-plan). Use it as the template for
your own plan document if you are running this work through Paperclip itself.

## Order of operations

Do the shared contract first. It is the smallest correct change you can land
even before UI is final, and every later layer reads its types and validators.

### 1. Shared contract (smallest, lands first)

Touch:

- `packages/shared/src/constants.ts` — add the kind string to
  `ISSUE_THREAD_INTERACTION_KINDS` and any size constant (mirror
  `REQUEST_CHECKBOX_CONFIRMATION_OPTION_LIMIT = 200`).
- `packages/shared/src/types/issue.ts` — add `Option`, `Payload`, `Result`,
  and `Interaction` interfaces. Extend the `IssueThreadInteraction` and
  payload/result union types at the bottom of the file.
- `packages/shared/src/types/index.ts` — re-export the new types.
- `packages/shared/src/validators/issue.ts` — add Zod schemas for payload,
  result, and the create-input variant. Reuse the existing
  `requestConfirmationTargetSchema` when target binding applies.
- `packages/shared/src/validators/index.ts` — re-export the new schemas.
- `packages/shared/src/index.ts` — re-export at the package root.
- `packages/shared/src/issue-thread-interactions.test.ts` — extend the table
  tests for the new payload variant.

Validation invariants that have already been litigated and must hold:

- Option lists are bounded (the checkbox kind uses 200; pick a number the UX
  can render compactly).
- Option ids are unique within a payload and any default selection must
  reference known ids.
- Labels and descriptions are length-capped to match existing question
  options. Do not invent looser caps.
- Target binding uses the shared `RequestConfirmationTarget` schema so stale
  expiration runs through one code path.

### 2. Server service and routes

Touch:

- `server/src/services/issue-thread-interactions.ts` — add the kind to:
  - the supported-kinds list (`SUPPORTED_KINDS` near the top),
  - `mapInteractionRow` (the `switch (row.kind)` over payload/result parsers),
  - create-input validation (`switch (data.kind)`),
  - the accept/reject/respond/stale-expiration branches,
  - the activity-log payload and the continuation wake payload.
- `server/src/routes/issues.ts` — extend any kind-specific branches (notably
  the response-shape branch around line 6096 in the checkbox PR).
- `server/src/__tests__/issue-thread-interactions-service.test.ts` — cover
  create, accept-with-result, reject-with-reason, stale-target expiration,
  supersede-on-user-comment, idempotency conflict, and wake payload shape.
- `server/src/__tests__/issue-thread-interaction-routes.test.ts` — cover
  create + respond/accept/reject HTTP behavior, company scoping, and
  authorization.

Server invariants:

- Board-only resolution. Agent-authored accept/reject must be rejected with
  the existing 403 path; do not add a per-kind bypass.
- Company scoping. Reads, writes, expiration, and supersede must all filter
  by `companyId`. Never trust an `issueId` alone.
- Stale target. If `target` was specified at create time and a newer revision
  lands, the interaction expires with `outcome: "stale_target"`. Do not write
  bespoke staleness — call the same helper the other `request_*` kinds use.
- Supersede on user comment. Default `supersedeOnUserComment: true` unless
  the payload schema documents otherwise.
- Idempotency. The deterministic `idempotencyKey` shape from the existing
  kinds (`<kind>:<issueId>:<decisionKey>:<revisionId>`) must be honored;
  duplicate POSTs must return the existing card, not stack.
- Continuation policy. Support `none`, `wake_assignee`, and
  `wake_assignee_on_accept`. Pick a default that matches whether the
  asker is *blocked* waiting for the answer (`wake_assignee`) or only cares
  about acceptance (`wake_assignee_on_accept`).

### 3. UI card and issue-thread wiring

Touch:

- `ui/src/components/IssueThreadInteractionCard.tsx` — add a card component
  (e.g. `RequestCheckboxConfirmationCard`) and a resolution component
  (e.g. `RequestCheckboxConfirmationResolution`). Branch the existing
  switch by `interaction.kind`. Reuse the card shell — do not introduce a
  parallel card frame.
- `ui/src/lib/issue-thread-interactions.ts` — add typed helpers like
  `getCheckboxConfirmationSelectedLabels` so the card stays declarative.
- `ui/src/lib/issue-thread-interactions.test.ts` — test the helpers.
- `ui/src/components/IssueThreadInteractionCard.test.tsx` — pending,
  resolved, stale, disabled/submitting, and validation-error states.
- `ui/src/fixtures/issueThreadInteractionFixtures.ts` — seed at least one
  pending and one resolved fixture for the new kind.
- `ui/src/stories/issue-thread-interactions.stories.tsx` — Storybook entries
  for the key states.
- `ui/src/pages/IssueDetail.tsx` — extend the per-kind branches the card is
  rendered from (callback wiring, response submission).
- `ui/src/components/IssueChatThread.tsx` — if the kind affects thread-level
  rendering (badge, summary, count), update the per-kind switches here.
- `ui/src/api/issues.ts` — extend the typed accept/reject/respond bodies.

UI invariants:

- Compact rendering. The card must render comfortably with ~100 options
  (bounded scroll area, count-first resolved-state summaries — do not chip
  every selected option inline).
- Select all and clear selection live inside the card, not in a global menu.
- The accept payload uses kind-specific field names (e.g. `selectedOptionIds`,
  not the suggest-tasks `selectedClientKeys`). Do not reuse another kind's
  field name.
- Stale, superseded, and accepted states render distinct copy; reuse the
  existing resolution-component shell.

### 4. CLI, MCP, plugin SDK helpers

External callers must be able to create the new interaction without
hand-writing JSON. Touch:

- `cli/src/commands/client/issue.ts` — add a CLI sub-command or extend the
  generic interaction create path.
- `cli/src/__tests__/issue-subresources.test.ts` — cover the new flag set.
- `packages/mcp-server/src/tools.ts` — add an MCP tool that accepts the new
  payload shape; reuse the existing `createIssueThreadInteraction` codepath.
- `packages/mcp-server/src/tools.test.ts` — cover the tool's payload shape.
- `packages/plugins/sdk/src/types.ts` — add the typed
  `CreateIssueThreadInteraction` variant so plugin authors get autocomplete.
- `packages/plugins/sdk/src/worker-rpc-host.ts` — extend the kind switch in
  the create call.
- `packages/plugins/sdk/src/testing.ts` — extend the test harness so plugins
  can simulate the new kind end-to-end.
- `packages/plugins/sdk/tests/testing-actions.test.ts` — round-trip test for
  the new kind through the test harness.

### 5. Agent guidance

Touch:

- `skills/paperclip/SKILL.md` — add a row to the interaction-kinds table:
  *when to use*, *when not to use*, plus a copyable payload example.
- `skills/paperclip/references/api-reference.md` — full payload and result
  schemas, validation limits, create/respond bodies, error codes.

The skills text is read by the runtime agents. Keep it concise — differentiate
clearly from sibling kinds in one or two sentences each.

## Tests to run before requesting review

The checkbox PR ran exactly this focused set under `NODE_ENV=test`. Use the
same shape for any new kind, swapping in your new test files:

```sh
NODE_ENV=test pnpm run preflight:workspace-links
NODE_ENV=test pnpm exec vitest run \
  packages/shared/src/issue-thread-interactions.test.ts \
  server/src/__tests__/issue-thread-interaction-routes.test.ts \
  server/src/__tests__/issue-thread-interactions-service.test.ts \
  ui/src/components/IssueThreadInteractionCard.test.tsx \
  ui/src/lib/issue-thread-interactions.test.ts \
  cli/src/__tests__/issue-subresources.test.ts \
  packages/mcp-server/src/tools.test.ts \
  packages/plugins/sdk/tests/testing-actions.test.ts
```

If UI vitest fails with `act is not a function`, the shell is running with
`NODE_ENV=production` (it picks up React's prod build). Re-run with
`NODE_ENV=test` explicitly.

## Pre-merge checklist

- [ ] New kind appears in `ISSUE_THREAD_INTERACTION_KINDS` and is exported.
- [ ] Payload and result interfaces are versioned (start at `version: 1`).
- [ ] Zod validators enforce option/label/description limits and id uniqueness.
- [ ] Target binding (if any) uses the shared `RequestConfirmationTarget` path.
- [ ] Service handles create, accept, reject/respond, stale-target,
      supersede-on-user-comment, idempotency, activity log, and continuation
      wake.
- [ ] Routes honor board-only resolution and company scoping.
- [ ] UI renders pending, resolved, stale, disabled/submitting, and
      validation-error states; resolved-state large selections summarize by
      count first.
- [ ] Fixtures and Storybook entries exist for the new kind.
- [ ] CLI, MCP, and plugin SDK helpers all accept the new payload shape and
      have test coverage.
- [ ] `skills/paperclip/SKILL.md` and `references/api-reference.md` updated.
- [ ] Focused test set above is green; CI gates pass.

## Anti-patterns observed in review

These came out of the checkbox PR review thread and are worth avoiding next
time:

- Reusing another kind's accept-payload field name (e.g. piggybacking on
  `selectedClientKeys` instead of introducing `selectedOptionIds`). Each kind
  owns its own field names.
- Writing parallel staleness or supersede logic instead of routing through
  the existing `request_confirmation` helpers. This silently drifts behavior.
- Rendering hundreds of selected-option chips in the resolved state. Resolved
  large selections must summarize by count first.
- Skipping plugin SDK / MCP / CLI coverage on the theory that "the API is
  generic enough." External callers do not pick up new kinds without typed
  helpers, and the absence shows up later as broken agent flows.
- Adding the kind to skills guidance before the server route accepts it.
  Agents will try the new kind and 400 in production.
