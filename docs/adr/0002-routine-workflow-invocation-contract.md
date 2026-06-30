# Routine→Workflow Invocation Contract

Bizbox now treats routine autonomous mode handing work into workflows as a first-class company-local bridge, not an ad hoc prompt convention. The bridge is a versioned invocation contract with a small target selector and a payload that can carry either markdown or structured JSON. The workflow runtime still receives markdown as the backward-compatible transport, while the structured payload is preserved in persistence and runtime context for workflow-aware consumers.

## Decision

Bizbox will support routine→workflow handoff through a versioned invocation contract and a durable invocation record.

The contract has three pieces:

- a workflow target selector
- a payload that is either markdown or JSON
- a version tag so future contract revisions can coexist cleanly

Workflow selection is hybrid:

- use an explicit workflow id when the caller has one
- otherwise resolve by company-local workflow key
- otherwise resolve by capability, with ambiguous matches rejected

The invocation bridge records:

- the source routine
- the source routine run
- the resolved workflow
- the contract version
- whether the payload was markdown or JSON
- the resulting workflow run id once linked

The workflow runtime continues to accept markdown input and existing scheduled/manual workflow runs remain unchanged.

## Scope

This contract applies to routine autonomous mode calling existing workflows inside the same company. It does not replace the routine system, the workflow system, or the manual run path. It also does not introduce fan-out semantics into a single invocation; one invocation resolves one workflow.

## Consequences

This decision gives Bizbox:

- one seam for routine→workflow handoff instead of workflow-specific special cases
- company-local portability because selectors do not depend on project names
- auditability because the invocation record survives even when the runtime is still executing
- compatibility because existing markdown-driven workflow runs and schedules still work unchanged

The main constraint is that capability-based selection must remain unambiguous. If more than one workflow advertises the same capability, callers must provide a workflow key or workflow id.

