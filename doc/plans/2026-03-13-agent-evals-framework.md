# Agent Evals Framework Plan

Date: 2026-03-13

## Context

We need evals for the thing Paperclip actually ships:

- agent behavior produced by adapter config
- prompt templates and bootstrap prompts
- skill sets and skill instructions
- model choice
- runtime policy choices that affect outcomes and cost

We do **not** primarily need a fine-tuning pipeline.
We need a regression framework that can answer:

- if we change prompts or skills, do agents still do the right thing?
- if we switch models, what got better, worse, or more expensive?
- if we optimize tokens, did we preserve task outcomes?
- can we grow the suite over time from real Paperclip usage?

This plan is based on:

- `doc/GOAL.md`
- `doc/PRODUCT.md`
- `doc/SPEC-implementation.md`
- `docs/agents-runtime.md`
- `doc/plans/2026-03-13-TOKEN-OPTIMIZATION-PLAN.md`
- Discussion #449: <https://github.com/paperclipai/paperclip/discussions/449>
- OpenAI eval best practices: <https://developers.openai.com/api/docs/guides/evaluation-best-practices>
- Promptfoo docs: <https://www.promptfoo.dev/docs/configuration/test-cases/> and <https://www.promptfoo.dev/docs/providers/custom-api/>
- LangSmith complex agent eval docs: <https://docs.langchain.com/langsmith/evaluate-complex-agent>
- Braintrust dataset/scorer docs: <https://www.braintrust.dev/docs/annotate/datasets> and <https://www.braintrust.dev/docs/evaluate/write-scorers>

## Recommendation

Paperclip should take a **two-stage approach**:

1. **Start with Promptfoo now** for narrow, prompt-and-skill behavior evals across models.
2. **Grow toward a first-party, repo-local eval harness in TypeScript** for full Paperclip scenario evals.

So the recommendation is no longer “skip Promptfoo.” It is:

- use Promptfoo as the fastest bootstrap layer
- keep eval cases and fixtures in this repo
- avoid making Promptfoo config the deepest long-term abstraction

More specifically:

1. The canonical eval definitions should live in this repo under a top-level `evals/` directory.
2. `v0` should use Promptfoo to run focused test cases across models and providers.
3. The longer-term harness should run **real Paperclip scenarios** against seeded companies/issues/agents, not just raw prompt completions.
4. The scoring model should combine:
   - deterministic checks
   - structured rubric scoring
   - pairwise candidate-vs-baseline judging
   - efficiency metrics from normalized usage/cost telemetry
5. The framework should compare **bundles**, not just models.

A bundle is:

- adapter type
- model id
- prompt template(s)
- bootstrap prompt template
- skill allowlist / skill content version
- relevant runtime flags

That is the right unit because that is what actually changes behavior in Paperclip.

## Why This Is The Right Shape

### 1. We need to evaluate system behavior, not only prompt output

Prompt-only tools are useful, but Paperclip’s real failure modes are often:

- wrong issue chosen
- wrong API call sequence
- bad delegation
- failure to respect approval boundaries
- stale session behavior
- over-reading context
- claiming completion without producing artifacts or comments

Those are control-plane behaviors. They require scenario setup, execution, and trace inspection.

### 2. The repo is already TypeScript-first

The existing monorepo already uses:

- `pnpm`
- `tsx`
- `vitest`
- TypeScript across server, UI, shared contracts, and adapters

A TypeScript-first harness will fit the repo and CI better than introducing a Python-first test subsystem as the default path.

Python can stay optional later for specialty scorers or research experiments.

### 3. We need provider/model comparison without vendor lock-in

OpenAI’s guidance is directionally right:

- eval early and often
- use task-specific evals
- log everything
- prefer pairwise/comparison-style judging over open-ended scoring

But OpenAI’s Evals API is not the right control plane for Paperclip as the primary system because our target is explicitly multi-model and multi-provider.

### 4. Hosted eval products are useful, and Promptfoo is the right bootstrap tool

The current tradeoff:

- Promptfoo is very good for local, repo-based prompt/provider matrices and CI integration.
- LangSmith is strong on trajectory-style agent evals.
- Braintrust has a clean dataset + scorer + experiment model and strong TypeScript support.

The community suggestion is directionally right:

- Promptfoo lets us start small
- it supports simple assertions like contains / not-contains / regex / custom JS
- it can run the same cases across multiple models
- it supports OpenRouter
- it can move into CI later

That makes it the best `v0` tool for “did this prompt/skill/model change obviously regress?”

But Paperclip should still avoid making a hosted platform or a third-party config format the core abstraction before we have our own stable eval model.

The right move is:

- start with Promptfoo for quick wins
- keep the data portable and repo-owned
- build a thin first-party harness around Paperclip concepts as the system grows
- optionally export to or integrate with other tools later if useful

## What We Should Evaluate

We should split evals into four layers.

### Layer 1: Deterministic contract evals

These should require no judge model.

Examples:

- agent comments on the assigned issue
- no mutation outside the agent’s company
- approval-required actions do not bypass approval flow
- task transitions are legal
- output contains required structured fields
- artifact links exist when the task required an artifact
- no full-thread refetch on delta-only cases once the API supports it

These are cheap, reliable, and should be the first line of defense.

### Layer 2: Single-step behavior evals

These test narrow behaviors in isolation.

Examples:

- chooses the correct issue from inbox
- writes a reasonable first status comment
- decides to ask for approval instead of acting directly
- delegates to the correct report
- recognizes blocked state and reports it clearly

These are the closest thing to prompt evals, but still framed in Paperclip terms.

### Layer 3: End-to-end scenario evals

These run a full heartbeat or short sequence of heartbeats against a seeded scenario.

Examples:

- new assignment pickup
- long-thread continuation
- mention-triggered clarification
- approval-gated hire request
- manager escalation
- workspace coding task that must leave a meaningful issue update

These should evaluate both final state and trace quality.

### Layer 4: Efficiency and regression evals

These are not “did the answer look good?” evals. They are “did we preserve quality while improving cost/latency?” evals.

Examples:

- normalized input tokens per successful heartbeat
- normalized tokens per completed issue
- session reuse rate
- full-thread reload rate
- wall-clock duration
- cost per successful scenario

This layer is especially important for token optimization work.

## Core Design

## 1. Canonical object: `EvalCase`

Each eval case should define:

- scenario setup
- target bundle(s)
- execution mode
- expected invariants
- scoring rubric
- tags/metadata

Suggested shape:

```ts
type EvalCase = {
  id: string;
  description: string;
  tags: string[];
  setup: {
    fixture: string;
    agentId: string;
    trigger: "assignment" | "timer" | "on_demand" | "comment" | "approval";
  };
  inputs?: Record<string, unknown>;
  checks: {
    hard: HardCheck[];
    rubric?: RubricCheck[];
    pairwise?: PairwiseCheck[];
  };
  metrics: MetricSpec[];
};
```

The important part is that the case is about a Paperclip scenario, not a standalone prompt string.

## 2. Canonical object: `EvalBundle`

Suggested shape:

```ts
type EvalBundle = {
  id: string;
  adapter: string;
  model: string;
  promptTemplate: string;
  bootstrapPromptTemplate?: string;
  skills: string[];
  flags?: Record<string, string | number | boolean>;
};
```

Every comparison run should say which bundle was tested.

This avoids the common mistake of saying “model X is better” when the real change was model + prompt + skills + runtime behavior.

## 3. Canonical output: `EvalTrace`

We should capture a normalized trace for scoring:

- run ids
- prompts actually sent
- session reuse metadata
- issue mutations
- comments created
- approvals requested
- artifacts created
- token/cost telemetry
- timing
- raw outputs

The scorer layer should never need to scrape ad hoc logs.

## Scoring Framework

## 1. Hard checks first

Every eval should start with pass/fail checks that can invalidate the run immediately.

Examples:

- touched wrong company
- skipped required approval
- no issue update produced
- returned malformed structured output
- marked task done without required artifact

If a hard check fails, the scenario fails regardless of style or judge score.

## 2. Rubric scoring second

Rubric scoring should use narrow criteria, not vague “how good was this?” prompts.

Good rubric dimensions:

- task understanding
- governance compliance
- useful progress communication
- correct delegation
- evidence of completion
- concision / unnecessary verbosity

Each rubric should be a small 0-1 or 0-2 decision, not a mushy 1-10 scale.

## 3. Pairwise judging for candidate vs baseline

OpenAI’s eval guidance is right that LLMs are better at discrimination than open-ended generation.

So for non-deterministic quality checks, the default pattern should be:

- run baseline bundle on the case
- run candidate bundle on the same case
- ask a judge model which is better on explicit criteria
- allow `baseline`, `candidate`, or `tie`

This is better than asking a judge for an absolute quality score with no anchor.

## 4. Efficiency scoring is separate

Do not bury efficiency inside a single blended quality score.

Record it separately:

- quality score
- cost score
- latency score

Then compute a summary decision such as:

- candidate is acceptable only if quality is non-inferior and efficiency is improved

That is much easier to reason about than one magic number.

## Suggested Decision Rule

For PR gating:

1. No hard-check regressions.
2. No significant regression on required scenario pass rate.
3. No significant regression on key rubric dimensions.
4. If the change is token-optimization-oriented, require efficiency improvement on target scenarios.

For deeper comparison reports, show:

- pass rate
- pairwise wins/losses/ties
- median normalized tokens
- median wall-clock time
- cost deltas

## Dataset Strategy

We should explicitly build the dataset from three sources.

### 1. Hand-authored seed cases

Start here.

These should cover core product invariants:

- assignment pickup
- status update
- blocked reporting
- delegation
- approval request
- cross-company access denial
- issue comment follow-up

These are small, clear, and stable.

### 2. Production-derived cases

Per OpenAI’s guidance, we should log everything and mine real usage for eval cases.

Paperclip should grow eval coverage by promoting real runs into cases when we see:

- regressions
- interesting failures
- edge cases
- high-value success patterns worth preserving

The initial version can be manual:

- take a real run
- redact/normalize it
- convert it into an `EvalCase`

Later we can automate trace-to-case generation.

### 3. Adversarial and guardrail cases

These should intentionally probe failure modes:

- approval bypass attempts
- wrong-company references
- stale context traps
- irrelevant long threads
- misleading instructions in comments
- verbosity traps

This is where promptfoo-style red-team ideas can become useful later, but it is not the first slice.

## Repo Layout

Recommended initial layout:

```text
evals/
  README.md
  promptfoo/
    promptfooconfig.yaml
    prompts/
    cases/
  cases/
    core/
    approvals/
    delegation/
    efficiency/
  fixtures/
    companies/
    issues/
  bundles/
    baseline/
    experiments/
  runners/
    scenario-runner.ts
    compare-runner.ts
  scorers/
    hard/
    rubric/
    pairwise/
  judges/
    rubric-judge.ts
    pairwise-judge.ts
  lib/
    types.ts
    traces.ts
    metrics.ts
  reports/
    .gitignore
```

Why top-level `evals/`:

- it makes evals feel first-class
- it avoids hiding them inside `server/` even though they span adapters and runtime behavior
- it leaves room for both TS and optional Python helpers later
- it gives us a clean place for Promptfoo `v0` config plus the later first-party runner

## Execution Model

The harness should support three modes.

### Mode A: Cheap local smoke

Purpose:

- run on PRs
- keep cost low
- catch obvious regressions

Characteristics:

- 5 to 20 cases
- 1 or 2 bundles
- mostly hard checks and narrow rubrics

### Mode B: Candidate vs baseline compare

Purpose:

- evaluate a prompt/skill/model change before merge

Characteristics:

- paired runs
- pairwise judging enabled
- quality + efficiency diff report

### Mode C: Nightly broader matrix

Purpose:

- compare multiple models and bundles
- grow historical benchmark data

Characteristics:

- larger case set
- multiple models
- more expensive rubric/pairwise judging

## CI and Developer Workflow

Suggested commands:

```sh
pnpm evals:smoke
pnpm evals:compare --baseline baseline/codex-default --candidate experiments/codex-lean-skillset
pnpm evals:nightly
```

PR behavior:

- run `evals:smoke` on prompt/skill/adapter/runtime changes
- optionally trigger `evals:compare` for labeled PRs or manual runs

Nightly behavior:

- run larger matrix
- save report artifact
- surface trend lines on pass rate, pairwise wins, and efficiency

## Framework Comparison

## Promptfoo

Best use for Paperclip:

- prompt-level micro-evals
- provider/model comparison
- quick local CI integration
- custom JS assertions and custom providers
- bootstrap-layer evals for one skill or one agent workflow

What changed in this recommendation:

- Promptfoo is now the recommended **starting point**
- especially for “one skill, a handful of cases, compare across models”

Why it still should not be the only long-term system:

- its primary abstraction is still prompt/provider/test-case oriented
- Paperclip needs scenario setup, control-plane state inspection, and multi-step traces as first-class concepts

Recommendation:

- use Promptfoo first
- store Promptfoo config and cases in-repo under `evals/promptfoo/`
- use custom JS/TS assertions and, if needed later, a custom provider that calls Paperclip scenario runners
- do not make Promptfoo YAML the only canonical Paperclip eval format once we outgrow prompt-level evals

## LangSmith

What it gets right:

- final response evals
- trajectory evals
- single-step evals

Why not the primary system today:

- stronger fit for teams already centered on LangChain/LangGraph
- introduces hosted/external workflow gravity before our own eval model is stable

Recommendation:

- copy the trajectory/final/single-step taxonomy
- do not adopt the platform as the default requirement

## Braintrust

What it gets right:

- TypeScript support
- clean dataset/task/scorer model
- production logging to datasets
- experiment comparison over time

Why not the primary system today:

- still externalizes the canonical dataset and review workflow
- we are not yet at the maturity where hosted experiment management should define the shape of the system

Recommendation:

- borrow its dataset/scorer/experiment mental model
- revisit once we want hosted review and experiment history at scale

## OpenAI Evals / Evals API

What it gets right:

- strong eval principles
- emphasis on task-specific evals
- continuous evaluation mindset

Why not the primary system:

- Paperclip must compare across models/providers
- we do not want our primary eval runner coupled to one model vendor

Recommendation:

- use the guidance
- do not use it as the core Paperclip eval runtime

## First Implementation Slice

The first version should be intentionally small.

## Phase 0: Promptfoo bootstrap

Build:

- `evals/promptfoo/promptfooconfig.yaml`
- 5 to 10 focused cases for one skill or one agent workflow
- model matrix using the providers we care about most
- mostly deterministic assertions:
  - contains
  - not-contains
  - regex
  - custom JS assertions

Target scope:

- one skill, or one narrow workflow such as assignment pickup / first status update
- compare a small set of bundles across several models

Success criteria:

- we can run one command and compare outputs across models
- prompt/skill regressions become visible quickly
- the team gets signal before building heavier infrastructure

## Phase 1: Skeleton and core cases

Build:

- `evals/` scaffold
- `EvalCase`, `EvalBundle`, `EvalTrace` types
- scenario runner for seeded local cases
- 10 hand-authored core cases
- hard checks only

Target cases:

- assigned issue pickup
- write progress comment
- ask for approval when required
- respect company boundary
- report blocked state
- avoid marking done without artifact/comment evidence

Success criteria:

- a developer can run a local smoke suite
- prompt/skill changes can fail the suite deterministically
- Promptfoo `v0` cases either migrate into or coexist with this layer cleanly

## Phase 2: Pairwise and rubric layer

Build:

- rubric scorer interface
- pairwise judge runner
- candidate vs baseline compare command
- markdown/html report output

Success criteria:

- model/prompt bundle changes produce a readable diff report
- we can tell “better”, “worse”, or “same” on curated scenarios

## Phase 3: Efficiency integration

Build:

- normalized token/cost metrics into eval traces
- cost and latency comparisons
- efficiency gates for token optimization work

Dependency:

- this should align with the telemetry normalization work in `2026-03-13-TOKEN-OPTIMIZATION-PLAN.md`

Success criteria:

- quality and efficiency can be judged together
- token-reduction work no longer relies on anecdotal improvements

## Phase 4: Production-case ingestion

Build:

- tooling to promote real runs into new eval cases
- metadata tagging
- failure corpus growth process

Success criteria:

- the eval suite grows from real product behavior instead of staying synthetic

## Initial Case Categories

We should start with these categories:

1. `core.assignment_pickup`
2. `core.progress_update`
3. `core.blocked_reporting`
4. `governance.approval_required`
5. `governance.company_boundary`
6. `delegation.correct_report`
7. `threads.long_context_followup`
8. `efficiency.no_unnecessary_reloads`

That is enough to start catching the classes of regressions we actually care about.

## Important Guardrails

### 1. Do not rely on judge models alone

Every important scenario needs deterministic checks first.

### 2. Do not gate PRs on a single noisy score

Use pass/fail invariants plus a small number of stable rubric or pairwise checks.

### 3. Do not confuse benchmark score with product quality

The suite must keep growing from real runs, otherwise it will become a toy benchmark.

### 4. Do not evaluate only final output

Trajectory matters for agents:

- did they call the right Paperclip APIs?
- did they ask for approval?
- did they communicate progress?
- did they choose the right issue?

### 5. Do not make the framework vendor-shaped

Our eval model should survive changes in:

- judge provider
- candidate provider
- adapter implementation
- hosted tooling choices

## Open Questions

1. Should the first scenario runner invoke the real server over HTTP, or call services directly in-process?
   My recommendation: start in-process for speed, then add HTTP-mode coverage once the model stabilizes.

2. Should we support Python scorers in v1?
   My recommendation: no. Keep v1 all-TypeScript.

3. Should we commit baseline outputs?
   My recommendation: commit case definitions and bundle definitions, but keep run artifacts out of git.

4. Should we add hosted experiment tracking immediately?
   My recommendation: no. Revisit after the local harness proves useful.

## Final Recommendation

Start with Promptfoo for immediate, narrow model-and-prompt comparisons, then grow into a first-party `evals/` framework in TypeScript that evaluates **Paperclip scenarios and bundles**, not just prompts.

Use this structure:

- Promptfoo for `v0` bootstrap
- deterministic hard checks as the foundation
- rubric and pairwise judging for non-deterministic quality
- normalized efficiency metrics as a separate axis
- repo-local datasets that grow from real runs

Use external tools selectively:

- Promptfoo as the initial path for narrow prompt/provider tests
- Braintrust or LangSmith later if we want hosted experiment management

But keep the canonical eval model inside the Paperclip repo and aligned to Paperclip’s actual control-plane behaviors.
