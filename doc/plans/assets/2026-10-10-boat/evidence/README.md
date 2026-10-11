# Boat acceptance evidence

These allowlisted summaries support the [validation matrix](../../../2026-10-10-boat-validation.md). They record observed results on named sources, not a blanket final-revision pass. Originals remain separately preserved; `provenance.json` records earlier originals; the consolidated retry summary carries its own original filenames and SHA-256 hashes.

## Current boundary (2026-10-11 03:23 UTC)

Runtime sources are combined `2f03982a47` and core `fd3ec56106`; UI correction `a761054e6a` and upstream CI compatibility `a84ff35344` follow. Deployment 16 verified `2e8859ab76` serving; deployment 17 for `ca8ab88c78` was cancelled during build before rollout. Later review found two admission lifecycle defects: Stop could leave a retry authorized, and premature terminalization could release the task lock. Both corrections passed 338 actual-entrypoint tests, server TypeScript and independent review; deployment18 is in progress. Both Boats subsequently recovered and archived with verified snapshots. Local normal Computer Connect resumed its desktop for cache diagnosis. No forced stop, resume, or state reset was used.

Recent source-specific passes: staging warm HMR preserving draft/page/process identity, corrected native computer use and persisted screenshot, local detach/reconnect retention, and local controller-restart saved-session continuation with unchanged one-line proof. Native Claude recovery on the latest package-authority fix, active sibling isolation, latest embedded input, and live pending-wait acceptance remain incomplete. Historical failures and earlier source boundaries remain in the validation matrix and receipts.

| Receipt | Source / narrow claim |
| --- | --- |
| [Latest retry qualification](retry-qualification-summary.json) | Deployments 12–16, exact failures and later HMR/computer-use/detach/restart successes; provider snapshot failure blocks latest staging sessions. Original hashes and narrower cancellation observations remain intact. |
| [Pending-stop correction tests](computer-admission-wait-tests.json) | 437 focused tests, 84 final affected tests and TypeScript initially passed, but later review found two integration defects, then the correction passed 338 actual-entrypoint tests and review; isolated disposable PostgreSQL databases, no product DB mutations. Live pending-wait remains unverified. |
| [Local restart retained proof](local-36-restart-retained.json) | Same saved session on a replacement machine, exactly one unchanged marker line; not active-crash recovery. |
| [CI on ea1272 / 44b1](ci-ea1272-44b1.json) | Historical exact heads: 52 successes each, 2 core skips, 5/5 reviews. New runtime-head review found the admission defects described above; those heads are not approved. |
| [Staging 11 corrected legacy runs](staging-11-legacy-regression.json) | Both runs succeeded 21:23:29, real Claude Skill launched, both persistent entries/proofs read, helper disposition passed without recovery. Includes the Claude activity-display inconsistency, Codex corrected arguments, and natural archive at 21:23:43.156. |
| [Deployment 11 serving receipt](staging-deploy-11-verified.json) | Official verification of 2df40da serving; no product pass implied. |
| [Candidate provenance](final-candidate-provenance.json) | Exact canonical/candidate comparison. Historical cutoff: 2df40da built while 1830beb was pending. Later deployment 12 verification is in the retry summary. |
| [Earlier runtime-head CI and review](current-head-ci-review.json) | At 21:32:06 UTC, combined `2ef177271a` and core `754a4e792e` each had 52 successful checks, fresh 5/5 review, and zero unresolved threads. Core had two policy skips. |
| [Scoped cleanup tests](latest-core-test-provenance.json) | Proof 246c28c03a: 16 route + 44 module cases passed; server TypeScript passed. Earlier 48-case adapter source and unchanged-file blobs are recorded. No live negative journey implied. |
| [Corrected legacy CLI runs](local-32-legacy-acceptance.json) | Local 32: both actual runs succeeded and issues became done through helpers; hashes matched prior files. Codex read persistent instructions; Claude actually invoked `Skill(paperclip)`. Claude had no configured personal instructions, so that mapping is not a live claim. |
| [Staging product receipts](staging-73b2-acceptance.json) | Four fresh onboardings/first jobs, native Claude cold/warm/post-idle, native Codex Cua/desktop/keyboard. Earlier legacy disposition failures remain distinct; staging preview/HMR is unverified. |
| [Claude lifecycle](claude-cold-warm.json) | Local 26/8f11a70b: cold/warm exact runner continuity, natural idle checkpoints/retirement/archive, replacement runner retaining durable session and hashes. Provider subprocess PIDs restart. |
| [Codex second idle](codex-second-idle.json) | Local 25/c9c0a47b: ordinary continuation after exact retirement/archive, including computer tool receipts. |
| [Warm Vite and HMR](vite-warm-hmr.json) | Local 23/85746677, UI 76a499cc: same processes across warm turns and hot reload preserving draft/page state. No final-source or staging HMR claim. |
| [Keyboard input](local-31-human-keyboard-proof.json) | Local 31/19d827a1 normal viewer keyboard input. Staging keyboard is separately recorded above. Neither proves independent mouse input. |
| [Desktop input lifetime](desktop-input-lifetime.json) | IBus observed outside the runner slice; cgroup sample, not a separate expiry test. |
| [Persistent editor](local-30-persistent-save-proof.json) | Local 30/ac09d6ec save survived full reload; original content restored and reread. |
| [Local read/build checks](local-29-acceptance.json) | Source b375f465: live Instructions read, full build and recursive TypeScript passed. |
| [Legacy CLI selector](local-final-cli-ui-proof.json) | UI ce1a49bb/backend ac09d6ec read-only Codex CLI guard observation; no new task. |
| [Focused checks](focused-checks.json) | Earlier checks retain individual source attribution. |
| [Clean file-resource CI](file-resource-clean-ci-proof.json) | Core 5e5fe7a7: 44 passed, 0 skipped, including 7 regressions. |
| [Earlier core CI](core-5e5-final-ci-review.json) | Historical exact-head receipt; does not describe current core. |
| [Full-suite limits](full-suite-limits.json) | Frozen 2cbe65e9:34,914 passed, 24 failed,  338 skipped; original failures and separate retries preserved. |
| [Compatibility](staging-compat-final-proof.json), [manifest](staging-compat-manifest-proof.json), [schema](staging-compat-schema-proof.json) | Source-specific runtime/schema equality and strict migration-prefix evidence. Future staging deployments must retain the compatible prefix. |
| [Deployment 9 preflight](staging-deploy-9-assessment.json) | Stopped before provider deployment mutation; no reset/history rewrite/guard bypass. |
| [Latest resource inventory](local-final-resource-inventory.json) | Local ledgers at 21:14:08: zero live owners/pending actions. Provider snapshots at 20:38/20:53: both local fixtures, builder and staging archived. Later qualification may resume a fixture. |

The older `local-final-state.json` is a historical snapshot, superseded for cleanup by the timestamped latest inventory. Resource receipts are not claims about state after future work.

## Limits

The feature remains experimental and unmerged. Current-source Claude saved-session recovery, embedded desktop input, active sibling cancellation isolation, live pending-wait continuation, feature-off cleanup, staging company denial, and active-crash recovery remain incomplete. Local orderly controller restart, detach retention, staging HMR, and corrected native computer use subsequently passed on their recorded sources. Shared Unix UID is not an OS security boundary; shell writers can race editor writes. Cold startup and provider archival can be slow. Both snapshot stops subsequently completed; a normal local Computer Connect was opened for diagnosis; onboarding and builder were already archived.

The frozen full-suite result is not green. Later fixes/retries do not erase it: the isolated Git streaming retry exceeded its unchanged 300-second timeout, and CLI/persona cases remained blocked by native PostgreSQL bootstrap/shared-memory exhaustion. Earlier local file-resource skips remain recorded despite subsequent clean-CI success.

This bundle excludes credentials, private hosting/viewer URLs, internal home paths, raw logs/DOM, environment/profile values, and private-cloud links. Run IDs and proof hashes are retained only where they make an acceptance claim inspectable.

Direct Boat browser input proof: [Chromium with the typed marker](../staging-13-direct-desktop-input.png). This proves direct viewer input, not embedded input targeting.

- Deployment 14 follow-up is included in retry-qualification-summary.json: full warm HMR and local detach/reconnect retention passed; Claude saved resume failed and live child cancellation remains inconclusive. Historical failures are preserved.

Local38 pending admission and Pause work passed; later normal continuation remained behind a recovery gate. The retry summary preserves both outcomes. Claude verification reached its exact30-second deadline; classification now distinguishes unavailable verification from an explicit cache mismatch. Neither follow-up is a Claude continuation success.

[Local39 outcomes](local39-resume-outcomes.json): normal saved-message recovery after pause passed with the unchanged one-line marker, using the documented fresh-session repair contract. Saved Claude identity and files were retained, but ACPX session opening failed; the later same-run recovery was rejected by the authority guard. No live Claude success is claimed. Direct desktop mouse/keyboard passed; embedded input was blocked by automation targeting. Full build and recursive typecheck passed on local39 runtime source.

[Local40 saved Claude](local40-saved-claude-outcome.json) remains quarantined; [fresh Claude](local40-fresh-claude-outcome.json) reached the runner but timed out opening the provider session. Both cleaned up successfully. No current-source simple Claude or warm-follow-up success is claimed.

[Fresh Claude diagnosis](local40-fresh-claude-diagnosis.json) confirms settled checkpoints and present inputs without identifying the stalled startup step. [CI and review receipt](core9a31-ui-b68-ci-review.json) records both previous exact heads green; it excludes the later startup-stage diagnostic patch.

**Artifact-selection correction:** the requested local40/41 diagnostic paths were ignored by test-drive; see [corrected provenance](local-artifact-selection-correction.json). Those failures do not establish execution of the new diagnostics. [Staging19 live receipts](staging19-live-evidence.json) establish fresh/warm Claude, saved Codex, desktop and HMR passes on the verified deployed source.
