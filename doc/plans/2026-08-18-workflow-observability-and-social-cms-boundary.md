# Workflow Observability and Social CMS Boundary

Date: 2026-08-18
Status: Proposed; compatibility and safe-observability foundations implemented,
product scope undecided

## Objective

Improve workflow observability without changing the execution, handoff, review,
or terminal-state semantics of workflows that do not opt into a richer product
contract.

The immediate implementation keeps `bizbox.telemetry/v1` generic and treats the
Citro Social CMS conversation as a namespaced extension. We can later decide
whether the extension should remain Social CMS-only or become the reference
implementation for a generic review API.

## Source Contracts

This plan follows the division already documented in Citrobox:

- ADR-0100 keeps detailed social agent handoff capture local to the
  `social_media_platform` package rather than enabling deployment-wide prompt
  capture.
- ADR-0103 defines explicit social review gates after synthesis, planning, and
  asset rendering.
- `social-cms-review-chat.md` defines the CMS conversation, staged feedback,
  assets, revisions, ordering, and idempotency requirements.
- ADR-0084 says platform workflows own their deliverable declarations; the
  orchestrator does not impose media formats or deliverable counts.

Those contracts imply that Bizbox core should transport generic telemetry and
handoffs, while Social CMS owns its review vocabulary and presentation model.

## Compatibility Invariants

The following behavior must remain true for an existing workflow with no Social
CMS integration:

1. A runtime handoff parks the run in `awaiting_human`.
2. ClickUp and board resolution can find and resume that run.
3. Rejecting a handoff returns `rejected` to the runtime; it does not implicitly
   terminate the entire workflow run.
4. Existing polling, cancellation, filtering, and status consumers require no
   changes.
5. Telemetry is observational. Failure to emit telemetry must not change the
   workflow result.
6. No workflow-specific provider or brand name is inferred by Bizbox core.

## API Convention

### Generic core

These contracts are available to every workflow:

- `POST /api/workflow-runs/:runId/runtime/telemetry-events`
  - schema: `bizbox.telemetry/v1`
  - idempotency: `(runId, eventId)`
  - purpose: operation/span evidence only
- `POST /api/workflow-runs/:runId/runtime/phase-events`
  - purpose: coarse pipeline state
- `POST /api/workflow-runs/:runId/handoffs/runtime`
  - purpose: generic approval or response handoff
  - run status remains `awaiting_human`

### Social CMS extension

Social CMS-specific resources use an explicit extension namespace:

`/api/workflow-runs/:runId/extensions/citro-social-cms/v1`

Board/CMS-facing routes:

- `GET /events`
- `GET /assets`
- `GET /review`
- `POST /handoffs/:handoffId/feedback`

Runtime routes:

- `POST /runtime/extensions/citro-social-cms/v1/review`
- `POST /runtime/extensions/citro-social-cms/v1/assets`

The extension may use Social CMS terms such as content/final review, screen,
template, image, revision, and post type. Those terms must not be added to the
generic handoff or telemetry semantics.

### Opt-in declaration

Social CMS endpoints are available only when the workflow's `capabilities`
array contains the exact versioned value:

```json
{
  "capabilities": ["citro-social-cms/v1"]
}
```

Update the Social CMS workflow through the normal workflow create/update API or
the board before using the extension. Do not add this capability to generic
workflows; calls from workflows without it are rejected.

Citrobox runtime publications use the same reliable request envelope for review
snapshots and assets: `idempotencyKey`, `generationId`, and the current
`revision`. The generated runtime helper accepts these as optional keyword
arguments on `publish_review(...)` and `publish_assets(...)`; when omitted it
derives a stable retry key, uses the workflow run as the generation ID, and
tracks the current revision. Feedback supplies that envelope and targets the
specific handoff ID returned by the review checkpoint.

## Data Ownership

Generic core owns:

- immutable telemetry events and span correlation
- generic run/phase state
- generic handoffs
- generic deliverables

The Social CMS extension owns:

- review conversation event vocabulary
- content/final review stages
- scoped feedback targets
- social screen and template metadata
- revision presentation and CMS synchronization

Extension records must remain company- and run-scoped. Cross-system writes need
an idempotency key and external correlation identifier before production use.

## Implementation Phases

### Phase 1: compatibility foundation

- Keep generic handoffs on `awaiting_human` even when Social CMS metadata is
  present.
- Restore non-terminal generic rejection behavior.
- Namespace Social CMS review, asset, event, and feedback endpoints.
- Add regression coverage for generic rejection/resumption and route isolation.
- Keep generic telemetry ingestion and display unchanged.

### Phase 2: harden generic observability

- Completed: remove the hard-coded `shared.service.image_generator` / Citro
  Studio import hook from the global runtime helper.
- Let a workflow emit service spans through `telemetry_operation` or an explicit
  observer registered by the workflow package.
- Completed: make runtime telemetry and phase observations metadata-only by
  default and deliver them through a bounded, asynchronous queue with a short
  timeout and dropped-event accounting.
- Follow-up: add server-side payload byte limits and a configurable field-level
  redaction and retention policy for deployments that opt into content capture.
- Add conformance fixtures for factory-built agents, aliased imports, custom
  tools, parallel agents, and non-social ADK workflows.

### Phase 3: harden the Social CMS extension

- Completed: persist and enforce the versioned workflow capability declaration.
- Completed: make review snapshots, assets, handoffs, and feedback retry-safe.
- Completed: validate supported media bytes and MIME type.
- Completed: correlate extension requests with generation IDs and revisions.
- Completed: resolve the exact pending review handoff and revision.
- Add signed webhook or cursor-based polling support for CMS responses.

### Phase 4: product decision

Use production evidence from at least one social workflow and one non-social
review workflow to choose one of the following.

#### Option A: generic review framework

Promote only the reusable concepts: checkpoint, stage identifier, allowed
actions, scoped target, revision, event, and artifact. Workflow-defined schemas
provide labels and target types.

Choose this if multiple unrelated workflows need the same resumable review
protocol and UI.

#### Option B: generic review kernel plus Social CMS profile (recommended)

Core provides resumable checkpoints and namespaced extension storage. Social
CMS supplies its event vocabulary, screens, templates, media, and review UI.

Choose this if review mechanics repeat but the artifact and presentation models
remain domain-specific.

#### Option C: Social CMS-only extension

Keep all review conversation, feedback, revision, and asset APIs in the Citro
profile or a plugin. Core exposes only telemetry, handoffs, and deliverables.

Choose this if no second workflow demonstrates the same product needs.

## Decision Evidence

Before promoting Social CMS concepts into core, require:

- a second, non-social workflow using the same checkpoint/revision contract
- no Social CMS nouns in the proposed generic request/response schemas
- compatibility tests proving old handoff clients remain unchanged
- clear retention and privacy rules for prompts, skills, model outputs, and
  source queries
- an idempotent retry story for every mutating endpoint

## Acceptance Criteria for the Current Patch

- Generic runtime handoffs persist `awaiting_human`.
- Generic approval rejection resumes the run and returns the rejection to the
  workflow runtime.
- ClickUp can resolve a generic handoff using its existing status contract.
- Social CMS endpoints are visibly namespaced.
- Existing telemetry, workflow UI, and generic workflow APIs continue to pass
  their tests and typecheck.
