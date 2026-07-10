# Pilot Research Pipeline Repair — Build Record and Playbook

**Date:** 2026-07-10  
**Scope:** Paperclip Pilot Research company

## Outcome

The Pilot Research chain is now constrained to a staged, project-scoped handoff:

`Research Lead → Source Gatherer → Fact-Checker → Reporting Agent → Research Lead closeout`

No raw Paperclip credential is stored in an agent prompt or in a report.

## Controls Implemented

1. **MCP lifecycle cleanup.** Hermes now skips cancellation/await of lifecycle tasks owned by a closed foreign event loop. This removes the `Event loop is closed` teardown failure path.
2. **Heartbeat containment.** Every Pilot Research agent uses `maxConcurrentRuns: 1`, a 60-second cooldown, a 15-minute timer, demand wakeups, and idle-work suppression. All four agents remain paused after repair.
3. **Controlled Paperclip writes.** Each role has a dedicated `task_bridge` key held in Paperclip secret storage and bounded to the `Pilot Research Pipeline` project. Each key can assign only the next role in the chain.
4. **Native handoffs.** Roles use `paperclip-task.mjs` with a child-task handoff. A stage completes, then creates its single successor with the complete artifact in the successor description. This preserves read boundaries: an assignee only needs its own task.
5. **Lead-only orchestration.** The Lead has `terminal,todo` only; no browser or web tools. It dispatches Source work, marks the root blocked during stage execution, then completes the root only from a `[Close]` task assigned back to it.
6. **Fallback availability.** Hermes global `fallback_providers` is present for every adapter-launched Hermes run. The configured order begins `z-ai/glm-5.2 → x-ai/grok-4.5 → openrouter/free` and continues through Nvidia free models and `deepseek/deepseek-v4-flash`.

## Verification Evidence

- `python -m pytest -q tests/tools/test_mcp_lifecycle_cleanup.py` — **2 passed**.
- `python scripts/validate_pilot_pipeline_e2e.py` — **passed**. The no-LLM test created and closed Lead, Source, Fact, Report, and Lead-close tasks; verified parent/project links and a forbidden cross-role assignment returned HTTP 403.
- The proof log is stored at `C:\Users\rcatl\.paperclip\pilot-research-pipeline-e2e-validation-2026-07-10.json` and contains identifiers/statuses only, never raw keys.
- Post-change API audit confirmed all four Pilot Research agents are paused, carry the one-run heartbeat policy, and have no active heartbeat runs.

## Operating Procedure

1. Keep all four agents paused until an operator intentionally starts a Pilot Research root task in the `Pilot Research Pipeline` project.
2. Assign the root to Research Lead.
3. Review the Lead closure task and root completion artifact after the chain finishes.
4. If a stage blocks, inspect its assigned Paperclip task and comments. Do not widen a task-bridge scope or put credentials into AGENTS.md.

## Rollback

1. Pause the four Pilot Research agents if they are not already paused.
2. Delete the four `Pilot Research task bridge` keys and their associated Paperclip secrets.
3. Restore the four prior AGENTS.md instruction files from the Paperclip instance backup or version control.
4. Reapply a known-good heartbeat policy only after verifying no active run remains.

## Related Files

- `scripts/repair_pilot_pipeline.py`
- `scripts/rotate_pilot_task_bridge_scopes.py`
- `scripts/validate_pilot_pipeline_e2e.py`
- `packages/adapters/hermes/skills/paperclip-task-bridge/paperclip-task.mjs`
- `packages/adapters/hermes/skills/paperclip-task-bridge/SKILL.md`
