---
name: content-production-ops
description: ThinkStack Media pipeline for faceless YouTube content production with YMYL gating. Use for "10-video launch hitlist" work, channel video scripts ("Cashflow Compass video #N", "V1 script"), compound-primitive build/verification issues ("[CC CP]", "operational render-gate", "bake-off"), or YMYL linter/sign-off work. Encodes the package-approval→research→script→lint→sign-off→render state machine, and the hard rule of splitting runner-independent code slices from runner-gated render verification.
---

# Content Production Ops

ThinkStack Media runs three faceless channels (Stack Lab — AI tools; Cashflow Compass — personal finance, YMYL-gated; Vault Cases — history/cold cases, archive-license-gated). The production pipeline exists and is partially built; **the #1 historical failure is batching runner-dependent render verification into the same issue as buildable code** — nearly every "operational render-gate" issue sat blocked for days on the missing GHA self-hosted runner while the code work inside it was finishable. Structure work so that never happens again.

## Package-first law

The episode chain is `package approval -> research -> script lock -> storyboard -> assets -> production -> QA -> publish`.

Before any research packet or script draft starts, the package must be approved with:
- approved title
- approved thumbnail concept
- approved hook
- package-effort target `>=25%` of the approved effort

If a scripting task arrives without those inputs, stop and push it back to packaging instead of drafting around the gap.

## The split rule (THIAAAAA-53 vs THIAAAAA-54 precedent)

Any compound-primitive or pipeline task divides into:
- **In-repo code slice** — modules, adapters, unit tests, fixtures, sample scripts, typecheck. Needs no runner. Ship it `done` on its own issue.
- **Operational render verification** — actual captures, sample MP4s, TTS sync, acceptance renders. Runner-gated. Its own issue, `blocked` on the infra issue with the owner named.

If you're assigned a combined issue, split it as your first act and say so. The render spec of record is Mini-first: Mac Mini local render for production output, with GitHub Actions/self-hosted runner retained as fallback, reproducibility evidence, or CI smoke coverage. Do not rely on GitHub Actions as the primary render lane when the Mini route can execute the same governed source package.

## Hitlists ("10-video launch hitlist — <Channel>")

Per ContentStrategist's bar: each of the 10 videos needs working title, hook (first 8 seconds), structure outline, thumbnail concept, target keyword(s) or trend angle — and each title must be defensible on clickability, retention shape, search demand, and channel narrative arc. Never ship generic listicle titles with no hook differentiation. YouTube reused-content/policy rules are hard constraints. Deliverable = issue document linked from the task comment.

## YMYL gate (Cashflow Compass — mandatory before any finance render)

The chain is policy → linter → sign-off → render, all already built:

1. **Policy**: `ymyl-policy-cashflow-compass` doc (THIAAAAA-10). No finance video ships without passing it.
2. **Script contract**: YAML frontmatter + body with declarative beat/overlay/disclosure structure (`ymyl-wiring-design` §1, THIAAAAA-29). On-screen claims are declared metadata, not OCR'd after render.
3. **Linter**: `packages/ymyl-linter` (`@thiaaaa/ymyl-linter` v1.0.0, THIAAAAA-42) — 16 detectors mapped rule→policy section, hard-fail-only rule pack v1 pinned to policy revision `917f6883`. Output is lint-result JSON with a `scriptHash` idempotency key.
4. **Sign-off state machine**: `draft → linted → {release-to-render | return-to-strategist | pending-ceo-approval}` with a hard render-gate invariant. CEO sign-off goes through Paperclip `request_board_approval` carrying `metadata.ymylSignOff.{scriptId,scriptHash,linterVersion,policyVersion,findingIds}`. A script revision purges the prior pending approval (no ghost approvals).
5. **Audit log**: append-only JSONL.

Chart-and-narrate renders additionally go through `packages/chart-and-narrate`: `RechartsEngineAdapter` (primary) / `ChartJsEngineAdapter` (fallback) via `selectEngine(winner)`, `YmylLinterAdapter` port, `LintAttestation` render-attestation, plan-hash + live `policyRevisionId` compose cache, and the six composer render-stage gates.

## Channel-specific gates

- **Cashflow Compass**: YMYL gate above. Every numeric overlay carries a `data-cite` (`Publisher — Date`) value.
- **Vault Cases**: archive-licensing is a **hard-fail** gate — period reconstruction work without cleared archive licenses does not render.
- **Stack Lab**: UI walkthroughs are synthesized via the Playwright/Puppeteer bake-off primitive; OAuth/tenant wiring is a board handoff (THIAAAAA "Stack Lab OAuth token mint" pattern).
- TTS of record: **OpenVoice v2** (XTTS-v2 dropped per tech-stack v3 §2). Stack is sub-only / multi-account constrained (tech stack v2/v3 re-picks) — don't reach for paid APIs the budget guardrail rules out.

## Mac Mini render route

For TSM episode/content renders, especially Stack Lab, treat the local Mac Mini render node as the default production route. GitHub Actions is a fallback/CI evidence lane, not the first place to burn production retries.

- Deck/body render scripts already default to Mini offload through `~/scripts/deck/mini-offload-lib.sh`; use `~/scripts/deck/build-deck.sh` or `~/scripts/deck/build-episode.sh` without setting `MINI_RENDER=0`.
- One-off ffmpeg, headless-Chrome, Whisper, or content render jobs should create a self-contained job directory with executable `render.sh`, then run `~/scripts/mini-render.sh <jobdir>`.
- Only run heavy renders on the Studio with `MINI_RENDER=0` when `STUDIO_RENDER_OK=1` is set and the issue comment records why local Studio render was approved.
- Use GitHub Actions after Mini only when Mini is unavailable, when CI parity is required, or when a platform-specific runner defect is the thing being tested.
- If GitHub Actions fails from dependency drift, venv permissions, missing packages, or hosted/self-hosted runner state, do not burn retries first. Reuse the same governed source inputs on the Mini route and attach the returned MP4/SRT/cut map/metrics/frame checks.
- If the Mini route itself fails, record the job directory path and the relevant `~/scripts/logs/mini-render-queue.log` excerpt, then block on the concrete Mini access/runtime cause.

## Acceptance verdicts

Sample renders (e.g. the 3-chart CC sample) close with an explicit **ContentStrategist no-slop verdict** against the rubric — not just "renders fine". Bake-offs produce a `winner.yaml` and the loser stays as fallback adapter, not deleted.

## Shared visual QA gate (Stack Lab / Cashflow Compass / Vault Cases)

Slide-format and motion rules are shared TSM memory. Channel brand treatment may vary, but a format defect found in one channel applies to all TSM renders unless the board explicitly grants an exception.

- **Ken Burns over still text slides is banned**. Pan/zoom on a static slide does not count as motion, and it is a hard fail when the slide carries readable text.
- **Slide-only videos are not b-roll**. A beat needs real visual substance: live UI capture, product footage, sourced b-roll, chart/data animation, archive media with rights, or an authored motion graphic with meaningful internal change.
- **No seam jumps**. Consecutive frames that only change crop/scale/position on a repeated slide template fail visual QA, even if the audio alignment and duration gates pass.
- **Beat source packs must classify visual type** before render. Duration/headroom checks are necessary but not sufficient; the source package must label still slide, UI capture, b-roll, chart, archive, motion graphic, or mixed media so QA can reject banned combinations early.
- **Shared gates apply before channel-specific gates**. Stack Lab, Cashflow Compass and Vault Cases all inherit these rules; CC's stricter slide/motion treatment is the baseline, not a one-channel preference.
- **If a contact sheet suggests no b-roll**, stop and inspect the source pack before rendering again. Do not spend Mini/GitHub cycles lengthening or looping static slides.

## Storage retention is part of production closeout

Render and bench issues must preserve decision evidence, not every regenerated scaffold. Before marking media/bench output done or asking the board to review it:

- Keep final artifacts: MP4s, thumbnails, scripts, manifests, QA reports, cut maps, benchmark `record.json`/summary files, and ledger references.
- Prune regenerated TSM `work/` folders after promotion/QA.
- For TSBC sample benches, prune per-sample `.hermes` homes once the sibling `record.json` exists and the issue is no longer active.
- Use the standard retention path instead of manual one-off deletion:

```bash
~/scripts/paperclip-retention.sh
```

If raw bench homes are needed for an active investigation, say so in the issue closeout and keep the issue `in_progress` or explicitly exempt that path in the evidence note.

## Known failure points

- Render-gated issues left `in_progress` with no live continuation → watchdog churn. Block on the infra issue with owner, or split (rule above).
- Orphaned blockers with no assignee (THIAAAAA-42 was found blocking -43 with nobody assigned) — assign the blocker back to its creator immediately.
- Cancelled-duplicate churn: several CP issues were re-cut 3–4 times under different scopes before the slice/verification split stabilized them. Reuse the THIAAAAA-53 scope shape instead of inventing a new cut.

## References

- `references/pipeline-evidence.md` — issue trail for the YMYL chain, compound primitives, and the runner gate.
