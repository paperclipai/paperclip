---
name: diagnose-why-work-stopped
description: Compatibility entry point for failed, stalled, looping, or over-recovered Paperclip work. Use fix-failed-paperclip-run for the full diagnosis, regression, repair, real verification, and green-PR workflow; honor an explicitly requested diagnosis-only scope.
---

# Diagnose Why Work Stopped

Use [Fix Failed Paperclip Run](../fix-failed-paperclip-run/SKILL.md). It owns the current
workflow: find the first causal failure, reproduce it red, repair the shared
contract, test second-order effects, verify the real workflow, and deliver a PR
with passing checks. A normal request to fix stopped work continues through that
workflow without a separate plan-approval gate.

If the user or calling workflow explicitly asks for diagnosis only or requires
approval before implementation, perform the investigation and safety analysis
within that scope. For example, a Terminal-Bench diagnosis child does not override
the loop's board approval boundary. Keep the next action and its owner explicit.

For issue-tree diagnosis, read the current `doc/execution-semantics.md`, inspect the
relevant subtree and recent repairs, and classify non-progressing nodes:

- **Genuine wait:** a named human or external dependency must act.
- **Agent-actionable but unrouted:** authorized useful work lacks a live path.
- **Already covered:** existing work owns the next action; do not duplicate it.

Preserve these three invariants together:

1. Productive work has a real next action and owner.
2. Only genuine blockers stop work, including approval, credentials, and budget.
3. Recovery is bounded and cannot recursively recover itself.

Frame any repair as a general behavioral contract, check it against a productive
counterexample, and follow the new skill through the authorized finish line.
Historical task links and private incident access are not required.
