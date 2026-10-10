# Boat acceptance evidence

These allowlisted summaries support the [validation matrix](../../../2026-10-10-boat-validation.md). They record observed results on named sources, not a blanket final-revision pass. Originals remain separately preserved; `provenance.json` records their filenames and SHA-256 hashes.

## Current boundary

Canonical combined source is `2ef177271ad703cef598b19b0d2219297c57ca6c`; core is `754a4e792e077999989b088a910ce9d846280fda`. Local controller32 qualification remains attributed to earlier `3673939bed` (identical tracked tree at `8b2a71c1e4`). Deployment11 verified serving `2df40da458` at 21:20:11 UTC, matching the earlier3673939 runtime. Both corrected legacy journeys subsequently passed on 2df40da without recovery, with persistent AGENTS reads, unchanged proof hashes, and helper disposition. Current canonical2ef1772/core754a4e contain a later scoped viewer-disconnect correction; compatible candidate1830beb/build38087300389 is in progress; no deployment12 is claimed. Earlier staging product receipts remain attributed to 73b2. The CI receipt records the exact current runtime heads; subsequent documentation commits need their own checks.


| Receipt | Source / narrow claim |
| --- | --- |
| [Staging11 corrected legacy runs](staging-11-legacy-regression.json) | Both runs succeeded 21:23:29, real Claude Skill launched, both persistent entries/proofs read, helper disposition passed without recovery. Includes the Claude activity-display inconsistency, Codex corrected arguments, and natural archive at 21:23:43.156. |
| [Deployment11 serving receipt](staging-deploy-11-verified.json) | Official verification of 2df40da serving; no product pass implied. |
| [Candidate provenance](final-candidate-provenance.json) | Exact canonical/candidate comparison and successful preview artifact build; not deployment proof. |
| [Exact runtime-head CI and review](current-head-ci-review.json) | At 21:32:06 UTC, combined `2ef177271a` and core `754a4e792e` each had 52 successful checks, fresh 5/5 review, and zero unresolved threads. Core had two policy skips. |
| [Scoped cleanup tests](latest-core-test-provenance.json) | Proof246c28c03a:16 route +44 module cases passed; server TypeScript passed. Earlier48-case adapter source and unchanged-file blobs are recorded. No live negative journey implied. |
| [Corrected legacy CLI runs](local-32-legacy-acceptance.json) | Local32: both actual runs succeeded and issues became done through helpers; hashes matched prior files. Codex read persistent instructions; Claude actually invoked `Skill(paperclip)`. Claude had no configured personal instructions, so that mapping is not a live claim. |
| [Staging product receipts](staging-73b2-acceptance.json) | Four fresh onboardings/first jobs, native Claude cold/warm/post-idle, native Codex Cua/desktop/keyboard. Earlier legacy disposition failures remain distinct; staging preview/HMR is unverified. |
| [Claude lifecycle](claude-cold-warm.json) | Local26/8f11a70b: cold/warm exact runner continuity, natural idle checkpoints/retirement/archive, replacement runner retaining durable session and hashes. Provider subprocess PIDs restart. |
| [Codex second idle](codex-second-idle.json) | Local25/c9c0a47b: ordinary continuation after exact retirement/archive, including computer tool receipts. |
| [Warm Vite and HMR](vite-warm-hmr.json) | Local23/85746677, UI76a499cc: same processes across warm turns and hot reload preserving draft/page state. No final-source or staging HMR claim. |
| [Keyboard input](local-31-human-keyboard-proof.json) | Local31/19d827a1 normal viewer keyboard input. Staging keyboard is separately recorded above. Neither proves independent mouse input. |
| [Desktop input lifetime](desktop-input-lifetime.json) | IBus observed outside the runner slice; cgroup sample, not a separate expiry test. |
| [Persistent editor](local-30-persistent-save-proof.json) | Local30/ac09d6ec save survived full reload; original content restored and reread. |
| [Local read/build checks](local-29-acceptance.json) | Source b375f465: live Instructions read, full build and recursive TypeScript passed. |
| [Legacy CLI selector](local-final-cli-ui-proof.json) | UI ce1a49bb/backend ac09d6ec read-only Codex CLI guard observation; no new task. |
| [Focused checks](focused-checks.json) | Earlier checks retain individual source attribution. |
| [Clean file-resource CI](file-resource-clean-ci-proof.json) | Core 5e5fe7a7: 44 passed, 0 skipped, including 7 regressions. |
| [Earlier core CI](core-5e5-final-ci-review.json) | Historical exact-head receipt; does not describe current core. |
| [Full-suite limits](full-suite-limits.json) | Frozen 2cbe65e9:34,914 passed,24 failed,338 skipped; original failures and separate retries preserved. |
| [Compatibility](staging-compat-final-proof.json), [manifest](staging-compat-manifest-proof.json), [schema](staging-compat-schema-proof.json) | Source-specific runtime/schema equality and strict migration-prefix evidence. Future staging deployments must retain the compatible prefix. |
| [Deployment9 preflight](staging-deploy-9-assessment.json) | Stopped before provider deployment mutation; no reset/history rewrite/guard bypass. |
| [Latest resource inventory](local-final-resource-inventory.json) | Local ledgers at 21:14:08: zero live owners/pending actions. Provider snapshots at 20:38/20:53: both local fixtures, builder and staging archived. Later qualification may resume a fixture. |

The older `local-final-state.json` is a historical snapshot, superseded for cleanup by the timestamped latest inventory. Resource receipts are not claims about state after future work.

## Limits

The feature remains experimental and unmerged. Final isolated viewer-fix staging qualification, staging HMR, independent mouse input, sibling cancellation isolation, detach retention, feature-off cleanup, company denial, and controller restart/no duplicate execution remain unverified product conditions. Shared personal folders use one Unix UID; they are not an OS security boundary. Shell writers can race editor writes. Cold startup can be expensive; retained private staging/snapshot files may need operator cleanup.

The frozen full-suite result is not green. Later fixes/retries do not erase it: the isolated Git streaming retry exceeded its unchanged 300-second timeout, and CLI/persona cases remained blocked by native PostgreSQL bootstrap/shared-memory exhaustion. Earlier local file-resource skips remain recorded despite subsequent clean-CI success.

This bundle excludes credentials, private hosting/viewer URLs, internal home paths, raw logs/DOM, environment/profile values, and private-cloud links. Run IDs and proof hashes are retained only where they make an acceptance claim inspectable.
