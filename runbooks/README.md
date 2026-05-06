# Runbooks

Operator-facing procedures for recovering from production incidents that the
platform cannot resolve automatically. Each runbook should be:

- **Specific.** Names the precise symptom, error code, or alert that triggers
  it. If you cannot match a runbook to your incident, do not improvise — page
  the owning lane.
- **Reversible.** Steps that destroy state must include a snapshot step
  before the destructive action.
- **Sourced.** Cross-references to the engineering issue(s) that motivated
  the runbook so the why-does-this-exist context is one click away.

## Index

- [`clear-polluted-ssh-workspace.md`](clear-polluted-ssh-workspace.md) —
  recover a stranded SSH-driven run whose workspace import is failing on a
  sibling task's leftover scratch state. Trigger: blocked issue auto-comment
  cites `workspace_import_conflict` or tar `Cannot open: File exists`.
