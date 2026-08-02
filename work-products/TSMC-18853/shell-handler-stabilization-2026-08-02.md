# Shell-handler stabilization — 2026-08-02

## Root cause

Paperclip's blocked-state gate requires a prose-only blocked issue to carry
both `External owner:` and `External action:` in its description. Three
deterministic shell-handler paths attempted to set `status: blocked` with only
a comment. The API correctly returned HTTP 409, and the shell process then
reported `adapter_failed` even though its routing decision was otherwise
valid.

The reproduced failure was TSC Fallback-Compiler run
`429236be-6ab1-4658-bd63-2abf90ccca39` on TSC-7251.

## Containment and repair

- OpCo fallback dispatch now fetches and preserves the current issue
  description, retaining an existing valid external gate or appending a
  dateless TSMC runtime-operations gate.
- MC-Compiler applies the same contract when a routed handler fails.
- ThinkStack Media RoutineOps centralizes the contract at its issue PATCH
  boundary so every deterministic blocked branch is covered.
- Captured Hermes homes, mutable databases, credentials, caches, media, live
  pool telemetry, and absolute runtime symlinks are excluded from the served
  source tree; their redacted manifests and text evidence remain eligible for
  version control.

## Verification

- Five focused Python regression tests passed.
- All three handlers passed Python compilation.
- Production canary run `da686c65-1e2f-47ca-bc71-6e102372e1e8` replayed the
  exact TSC-7251 failure path and succeeded in about 1.2 seconds.
- The canary left TSC-7251 in a platform-valid blocked state without placing
  the shell agent in error.
- All nine `paperclip_shell_handler` agents were resumed and reported idle.
- A post-canary check found MC-Compiler had subsequently encountered a
  separate cross-owner recovery-action 403 in `priority_unassigned_sweep.py`.
  That protected target is now skipped and reported instead of aborting the
  shared executor. Two focused tests cover the exact 403 and the fatal
  non-403 path.
- Follow-up production canary `1e04f3f5-90f8-4382-90e9-1c91d685a17d`
  succeeded, handled ten protected candidates without retry churn, and left
  MC-Compiler idle with no error reason.

## Version and rollback anchors

- TSMC managed handlers: commit `e5d36fb`
- TSMC protected-candidate follow-up: commit `4d04b89`
- ThinkStack Media RoutineOps: commit `b759c5d`
- Pre-change copies:
  `/Users/glad0s/paperclip-maintenance-backups/20260802-1125IST/shell-handlers/`

No dirty source was reset or discarded. The retained Paperclip stashes were
not changed.
