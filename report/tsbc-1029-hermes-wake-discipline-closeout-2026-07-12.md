# TSBC-1029 Hermes wake-discipline closeout

## Root cause

The board's sharper reproduction is correct: Hermes was not only vulnerable to
echoing the wake payload, it was vulnerable to echoing whichever priming block
appeared first in the composite prompt.

### `hermes_local`

The local adapter had two separate prompt-assembly problems:

1. Managed agent instructions from `instructionsFilePath` were prepended before
   the Paperclip runtime wrapper.
2. Inside the Paperclip runtime wrapper, the scoped wake payload used to appear
   before the Hermes/Paperclip operating instructions.

That meant Hermes could treat either the managed instruction bundle or
`## Paperclip Wake Payload` as answer text to quote back into the issue thread.
The Bench-Designer-Media exhibit from TSBC-1028 / TSBC-1032 matches this shape:
the lane dumped its own instruction header because that was the first priming
block in the composite query.

### `hermes_gateway`

The gateway input already started with runtime instructions, but the adapter
still had two holes:

1. The wake input did not explicitly say that wake payloads and related headers
   were internal runtime context rather than comment text.
2. Stable gateway `instructions` were passed through without an internal-only
   anti-echo wrapper, so a lane-specific system prompt could still become the
   first quotable priming block on the Hermes side.

The defect is therefore prompt assembly, not model incapacity: Hermes was being
handed internal prompt material in a shape that made it easy to parrot.

## Reproduction evidence

- Local reproduction is codified in
  `packages/adapters/hermes/src/server/prompt-rendering.test.ts`.
  The regressions now assert both:
  - Hermes runtime guidance appears before the actual scoped wake block.
  - Managed agent instructions for a Bench-Designer-Media style lane are placed
    behind the anti-echo runtime wrapper instead of at the top of the query.
- Gateway reproduction is codified in
  `packages/adapters/hermes/src/gateway/server/execute.test.ts`.
  The regressions inspect the actual POST body sent to Hermes and assert both:
  - comment wakes include explicit anti-echo guidance
  - custom stable `instructions` are prefixed with internal-only discipline
    before any lane-specific system prompt text

These tests lock the scratch/scoped-wake reproduction shape into the repo so
the defect cannot quietly return.

## Code changes

- Added shared `HERMES_PAPERCLIP_WAKE_DISCIPLINE_LINES` in
  `packages/adapters/hermes/src/shared/constants.ts`.
- Updated `packages/adapters/hermes/src/server/execute.ts` to:
  - inject the anti-echo wake-discipline rules
  - place the Hermes/Paperclip runtime wrapper before the scoped wake payload
  - move managed agent instructions behind that wrapper and mark them as
    internal runtime policy rather than user-visible answer text
- Updated `packages/adapters/hermes/src/gateway/server/execute.ts` to inject
  the same anti-echo wake-discipline rules and to prefix stable gateway
  `instructions` with an internal-only wrapper before any lane prompt text.
- Added regression coverage in:
  - `packages/adapters/hermes/src/server/prompt-rendering.test.ts`
  - `packages/adapters/hermes/src/gateway/server/execute.test.ts`

## Skillbench evidence

- Workspace skill source:
  `skills/hermes-scoped-wake-discipline/SKILL.md`
- Benchmark candidate:
  `/Users/glad0s/paperclip/benchmark/skillbench/candidate-skills/hermes-scoped-wake-discipline.md`
- Pair entry:
  `/Users/glad0s/paperclip/benchmark/skillbench/pairs.json`

Dry run:

```sh
python3 /Users/glad0s/paperclip/benchmark/skillbench.py \
  --pairs hermes-scoped-wake-discipline \
  --models grok-4-fast,grok-4.3 \
  --reps 2 \
  --dry-run
```

Measured run:

```sh
python3 /Users/glad0s/paperclip/benchmark/skillbench.py \
  --pairs hermes-scoped-wake-discipline \
  --models grok-4-fast,grok-4.3 \
  --reps 2
```

Measured result:

- Run ID: `skill-20260712-173703`
- Verdict: `KEEP`
- Mean lift: `+0.047`
- Report:
  `/Users/glad0s/paperclip/benchmark/results/skill-20260712-173703/report.md`

Per-model summary:

- `grok-4-fast`: baseline `0.773`, treatment `0.872`, lift `+0.099`, extra tokens `402`
- `grok-4.3`: baseline `0.948`, treatment `0.943`, lift `-0.006`, extra tokens `2,134`

## Verification

Passed:

```sh
pnpm --filter @paperclipai/hermes-paperclip-adapter exec vitest run \
  src/server/prompt-rendering.test.ts \
  src/gateway/server/execute.test.ts
```

Attempted but environment-blocked:

```sh
pnpm --filter @paperclipai/hermes-paperclip-adapter typecheck
```

`tsc` failed because the workspace does not currently have `@types/node`
installed under `node_modules`, so package typecheck could not complete in this
run.

## Registry note

The fixed template ships in the built-in Hermes adapter paths:

- `hermes_local`
- `hermes_gateway`

Any lane using those built-ins inherits the fix after deploy/restart. External
override packages that shadow Hermes built-ins do not inherit this change until
their override package is updated or disabled.

## Remaining rollout requirement

Live rollout and the 48h no-echo spot-check are still pending. Bench-Designer-
Media remains intentionally offline for scoped work until the built-in Hermes
paths are deployed/restarted and the board confirms the post-deploy sweep is
clean. This run proves the code path and benchmark delta, but not the
post-deploy cross-company behavior window yet.
