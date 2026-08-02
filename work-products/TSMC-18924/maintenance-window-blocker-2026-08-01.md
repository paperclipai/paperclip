# TSMC-18924 — Served-tree maintenance closeout

Completed: 2026-08-02 (Europe/Dublin)

## Outcome

The supervised Paperclip reinstall is complete. The served API is healthy on Node 22, the dependency layout is internally consistent, rollback artifacts verify, and the reopened Codex/shell cohort completed 25 post-resume runs with zero failures or process loss in the observation window.

Hermes itself is updated and its gateway is healthy, but one bounded xAI canary produced no model output for 180 seconds. It was cancelled without retry. The 38 Hermes lanes that were enabled before maintenance remain paused under follow-up TSMC-19096.

## Root-cause assessment

The 796 unrecovered failures on 2026-08-01 did not have one common cause:

- `adapter_failed` (547) was mainly lane/configuration-specific: 357 Codex managed-home TOML duplicate-key failures, 86 Hermes credential/provider failures, 56 Codex model/configuration failures (including CLI/model version skew), 35 shell-handler failures, and 13 other adapter failures.
- `process_lost` (210) clustered around service reload/restart and child-process EPIPE/finalization races. The dirty source files were not themselves proven to kill processes; the unsafe shared `node_modules` layout and repeated reloads made the served tree vulnerable to dependency relinking and process loss.
- The remaining 39 session-init, timeout, quota, and configuration failures require separate auth/quota/session remediation. They should not be retried as generic adapter failures.
- No evidence established database corruption or a fleet-wide OOM event as the common cause.

## Maintenance performed

- Quiesced all 211 agents and confirmed zero live runs before the reinstall.
- Preserved exact pre-window agent status, source state, configuration, database, work products, and Hermes state in `/Users/glad0s/paperclip-maintenance-backups/20260802-1125IST`.
- Created pre-maintenance Git refs for Paperclip and Hermes and verified both Git bundles as complete histories.
- Produced and gzip-verified the 3,578,051,028-byte logical database backup `paperclip-20260802-112324.sql.gz`.
- Reinstalled the served tree with pnpm 9.15.4 under Node 22.22.2, then confirmed a second frozen install was already up to date.
- Removed the obsolete generated `packages/adapters/acpx-local` tree from the served checkout by moving it into the backup directory; no tracked source was deleted.
- Updated Hermes to upstream `0a62610f1`, replayed the seven local fixes without conflict, reinstalled its environment, and restarted its gateway. Git reports 0 commits behind upstream.
- Updated the host Codex standalone CLI from 0.144.1 to stable 0.146.0 after `gpt-5.6-terra` explicitly rejected the older CLI. The retained 0.144.1 release and pre-update symlink provide rollback.
- Applied the focused unreleased Paperclip ACPX process-identity fix after its 90 adapter tests and typecheck passed. A full recovery test file still exposes one pre-existing standing-anchor policy assertion unrelated to that patch.

## Committed, verified maintenance changes

- `e66852cee` — block unsafe dependency writes from shared worktrees.
- `45a998bda` — pin the served launchd runtime to Node 22.
- `9350de0d6` — cover child-stdin EPIPE races.
- `76125ab2b` — validate Codex managed homes/config before launch.
- `1301fb3b4` — preserve Hermes custom providers and quiet adapter output.
- `b09a68a31` — persist ACPX process identity across hot restart.
- `a066b5d26` — refresh the ACPX patch hash for pnpm 9.

The broader dirty-tree recovery bundle was not committed: its focused suite passed 229 tests but failed 5 recovery-policy tests. It remains in place, is covered by the source patch/archive backup, and has an additional Git stash copy for the overlapping heartbeat test. Unrelated benchmark, skill, UI, work-product, and operational changes were preserved and not reset or bulk-committed.

## Final validation

- Paperclip health: `status=ok`, `authReady=true`, `bootstrapStatus=ready`, served commit `a066b5d26`.
- Fresh database backup: healthy, gzip integrity OK.
- Development gate: shared and database typechecks passed; migrated temporary database accepted an issue create and persisted `closeContract`.
- Dependency guard: internal `.pnpm` virtual store, no dangling workspace symlinks, last dev-watch verdict clean.
- Runtime resolution: `acpx@0.12.0`, `smol-toml@1.7.1`, and `@agentclientprotocol/codex-acp@1.1.0` resolve from their owning packages.
- ACPX tests: 90/90 passed; adapter-utils typecheck passed.
- Codex canary `82747ae4-772e-42ca-82e6-d15ad84122d3`: succeeded.
- Post-upgrade `gpt-5.6-terra` canary `e593be76-87a7-4808-be0f-1559b28c5f54`: succeeded in 4.4 seconds under Codex CLI 0.146.0.
- Post-resume observation: 25 succeeded, 0 failed, 0 `process_lost`, 0 live runs remaining.
- Hermes: v0.19.1 (2026.7.30), upstream `0a62610f`, local `70b4f067` with seven carried commits; update check says Up to date; launchd gateway running.

## Resume and containment state

- Resumed: 70 Codex and 9 deterministic shell-handler agents.
- Still paused: the original 93 paused agents, 38 Hermes agents pending TSMC-19096, and one agent whose adapter changed from Codex to Claude after the pre-window snapshot. The changed Claude lane was not silently reopened without quota/auth validation.
- Do not auto-retry quota, auth, session-init, or provider-timeout failures. Resume Hermes only in small cohorts after TSMC-19096 records a successful bounded canary with real output and clean finalization.

## Rollback

Rollback source, database, config, Hermes state, Codex 0.144.1 pointer/package metadata, and exact agent-status manifests are under `/Users/glad0s/paperclip-maintenance-backups/20260802-1125IST`. The database backup, Paperclip bundle, and Hermes bundle passed integrity verification. The old generated ACPX tree and stale Hermes update cache were moved into that directory rather than destroyed.
