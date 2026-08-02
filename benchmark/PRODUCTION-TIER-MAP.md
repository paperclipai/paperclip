# Production-Task Tier Map (benchmark #18 + #17)

> **⚠ VOID-EVIDENCE WARNING (added 2026-08-01, TSKB0056 addendum + TSBC-1790):** every measurement below
> was run 2026-06-20, before xAI's 2026-05-15 retirement of `grok-4-fast`/`grok-4.1-fast` was locked into
> platform enforcement (TSBC-1571, 2026-07-30). Those aliases now serve as `grok-4.3` — so any head-to-head
> row or "Recommended: grok-4.1-fast" line below comparing it against `grok-4.3` may be comparing the same
> model against itself under two labels, and the gap is noise, not a finding (same class as TSMC-18559,
> caught 2026-08-01). **Do not cite `grok-4.1-fast` from this doc as a live recommendation.** The `grok-4.3`
> rows and the Gemini comparisons are unaffected (real, distinct models) and remain valid historical data.
> Anyone re-deriving content-lane guidance should re-run the grok leg against `grok-4.3`/`grok-4.20`/`grok-4.5`
> fresh rather than trust the old alias-labeled numbers.

Cheap-vs-strong on real workflow-start deliverables, to decide where to tier down and how much
scaffolding each task needs. cheap = **grok-4-fast**, strong = **grok-4.3**, judge = claude-opus (blind).
Quality = 0.5 deterministic / 0.5 judge blend. Bar for "handled" = 0.85.

## The map

| task | cheap | strong | cheap+skill | escalation | profile | recommended lane |
|---|---|---|---|---|---|---|
| CV-review | 0.729 | 0.876 | **0.938** (3-run) | 50%→0% w/skill | judgment; over-flags unaided | **cheap + 1.4KB skill** (no supervisor) |
| video-hook | 0.913 | 0.908 | — | 14% | at parity | **cheap, nothing added** |
| social-post | 0.919 | 0.914 | — | 0% | at parity + objective constraints | **cheap + free deterministic gate** |
| book-chapter | 0.914 | 0.941 | tbd | 14% | parity except editing/tightening | **cheap + small tightening skill** |

## UPDATE — full-roster, multi-model (3-run confirmed, 2026-06-20)

Brought the wider roster in (incl. Gemini via the new Antigravity adapter). Quality is a near-wash
across models (0.876–0.925); the differentiator is WHICH model owns WHICH task type.

**Suite winners (mean quality, 3 runs · gemini-flash-low / grok-4.1-fast / grok-4.3):**
- cv-review: **0.929** / 0.780 / 0.850 — Gemini wins big
- book-chapter: **0.951** / 0.947 / 0.926 — Gemini
- social-post: **0.932** / 0.930 / 0.911 — Gemini ≈ grok-4.1
- video-hook: **0.927** / 0.921 / 0.896 — Gemini

Head-to-head task wins (29 production tasks): **Gemini 16 · grok-4.1-fast 11 · grok-4.3 only 2.**

**Specialization:**
- **Gemini 3.5 Flash → judgment + creative craft + calibration.** Calibrated NATIVELY: handles the
  CV over-flagging trap at 0.852 where grok-4.1 collapses to 0.192 — i.e. Gemini ≈ "grok + our skill"
  WITHOUT the skill. Leads all four production suites.
- **grok-4.1-fast → hard-constraint / discipline** (char caps, hashtag limits, exact structure,
  POV/tense, tightening, continuity). Best token-MEASURED cost (74 tok, ~14× cheaper than grok-4.3).
- **grok-4.3 (premium) → NOT content.** Last of three on every production suite, verbose. Earns its
  cost ONLY on agentic/tool-use work (paperclip suite 0.657 vs grok-4.1 0.408, +0.25) and technical roles.

**Rollout implication:** content lanes → Gemini 3.5 Flash primary (grok-4.1-fast for constraint-heavy
tasks); KEEP premium grok-4.3 for the agentic/technical lanes only. The CV-review skill is a grok-lane
patch, not needed if the lane is Gemini.

**Caveats:** Gemini cost = quota (capacity), not tokens — `agy` emits no usage (prod adapter reports 0).

## UPDATE 2 — technical-judgment suites + the crystallized rule (2026-06-20)

Ran gemini-flash-low + grok-4.1-fast on the technical-judgment suites (auditor/cto/ledger/quant, full
12-task suites, 0 failures). Both cheap models hit the CEILING (0.94–0.99) — near dead-heat:
- auditor: gemini 0.970 / grok-4.1 0.944 (gemini)
- cto: gemini 0.954 / grok-4.1 0.948 (gemini)
- ledger: gemini 0.978 / grok-4.1 0.994 (grok-4.1)
- quant: gemini 0.980 / grok-4.1 0.984 (grok-4.1)

Neither needs premium — single-pass technical judgment tiers down just like content.

**THE DIVIDING LINE IS SINGLE-PASS vs AGENTIC, not content vs technical:**
- **Single-pass (content + technical judgment) → cheap models.** Gemini-flash primary; grok-4.1-fast
  for constraint/precision tasks and where it edges ahead (ledger/quant). Both ceiling on technical.
- **Agentic / multi-step tool-use → keep premium grok-4.3.** The ONLY place reasoning earns its cost
  (paperclip agentic suite: grok-4.3 0.657 vs grok-4.1 0.408, +0.25).

Rollout rule in one line: **tier down everything single-pass; pay for reasoning only when the agent must
act over multiple tool-use steps.** (Technical result is single-run; the tier-DOWN conclusion is robust,
the exact gemini-vs-grok ordering per suite is noise-level.)

## Key findings

1. **3 of 4 tier down to the cheap model essentially for free.** Only CV-review genuinely
   needed help — and a small skill not only closed the gap but BEAT the strong baseline
   (0.938 > 0.876, 3-run averaged).
2. **The skill is the lever, not the agent-file.** On CV-review, skill-only (0.938) > AF+skill
   (0.897): a bespoke AGENTS.md actively hurt. Ship a small targeted skill; skip custom agent-files.
   The skill's job is calibration ("don't fabricate concerns") — it fixed a 0.192 → 1.000 disaster.
3. **No supervisor cost.** Because the cheap model clears the bar itself, escalation is 0–14%.
   You do NOT burn the savings on a strong review of everything (the tier-down trap).
4. **Scaffolding is per-task.** video-hook needs nothing; social-post leans on free deterministic
   gates (char caps, hashtag count, compliance regex); CV-review needs a skill; book-chapter needs
   a small editing skill for one sub-skill (tightening purple prose: cheap 0.750 vs strong 0.910).
5. **Single runs are noise-dominated.** CV-review's title task swung 0.285 between identical configs.
   Parity calls below were single cascade runs — confirm with 3 runs before betting the portfolio.

## Per-task gaps (where the cheap model actually trails)

- CV-review: calibration (over-flagging clean CVs) — FIXED by skill (1.000, zero variance).
- video-hook: only hook-no-cliche (0.775 vs 0.910), a subjective "thin" fail; strong barely better.
- social-post: none below bar; objective slips caught by free deterministic gates.
- book-chapter: only chapter-tighten-purple (0.750 vs 0.910); scene-not-summary trap handled fine (0.970).

## Status / next

- CV-review: LOCKED. skill = `variants/skills/cv-review/cv-review-playbook/SKILL.md` (v2). Drop custom AF.
- video-hook / social-post / book-chapter: single-run parity — 3-run confirm pending.
- book-chapter tightening skill: pending (optional; one-task gap, cheap already usable at 0.914).
- Suite bug fixed: video-hook `\p{Emoji}` regex (unsupported by Python re) → Python-safe emoji range.

Feeds THIAAAA-59 optimized-lane rollout: assign lanes per-task (cheap / cheap+skill / cheap+gate),
not a blanket policy.

## UPDATE 3 — cross-provider AGENTIC comparison (2026-06-20)

Full fleet on the paperclip agentic lane (12 stages, skills-OFF — desiredSkills configured but not
materialized; same condition for ALL agents incl. the original grok bench agents, so ranking is fair).
Bench agents created in the isolated Agentic Bench company (e212ce50).

| model | agentic | adapter |
|---|---|---|
| codex-gpt-5.4 | 0.917 | codex_local |
| gemini-pro (3.1 High) | 0.914 | antigravity_local |
| claude-opus-4.8 | 0.900 | claude_local |
| gpt-5.5 | 0.872 | codex_local |
| claude-opus-4.7 | 0.826 | claude_local |
| grok-4.20 | 0.817 | hermes_local |
| grok-4.3 | ~0.66-0.75 | hermes_local |
| grok-4-fast | 0.485 | hermes_local |
| grok-4.1-fast | 0.442 | hermes_local |

**Findings:**
- Top tier agentic = codex-gpt-5.4 ≈ gemini-pro ≈ claude-opus-4.8 (~0.90). All crush grok.
- Reasoning depth tracks agentic skill within families (grok 4.20>4.3>fast; opus 4.8>4.7; gpt-5.4 oddly > 5.5).
- grok-*-fast (deployed fast lanes) are WORST at agentic (0.44-0.49) — must never own an agentic lane.
- Universal blind spot: stage 12 idempotent-restraint — every model ~0.00 EXCEPT gemini-pro (0.50). Harness gap.
- Skills-off caveat: scores measure core agentic ability + execution-contract instructions, not domain skills.

## FINAL ROLLOUT RULE (all data in)
- **Single-pass content** → Gemini 3.5 Flash (leads, calibrated, cheap). grok-4.1-fast for constraint/precision.
- **Single-pass technical/reasoning** → cheap models ceiling (Gemini Flash / grok-4.1) — no premium needed.
- **Agentic / multi-step tool-use** → codex-gpt-5.4 OR gemini-pro OR claude-opus-4.8 (~0.90). NOT grok.
- Gemini wins BOTH ends (Flash single-pass, Pro agentic). The grok-heavy fleet is suboptimal for both.

## Live hermes pin posture (2026-07-31 — TSBC-1678)
Board intentionally pinned **19** production-like `*-Hermes` sisters `grok-4.3 → grok-4.5` on 2026-07-30 (local-board patch). Live mix: 23×`grok-4.5`, 16×`grok-4.3`, 3×`grok-4.20*`. Cost/context vs 4.3: **500k vs 1M** prompt ceiling; list price **~1.6× in / ~2.4× out**; default effort **high** (was low/none). Treat those sisters as **premium-xAI last-resort**, not cheap grok. Drafters + Designer-Media + Capital engineer/MIDAS/Polymarket hermes remain on 4.3. Sister-registry membership unchanged (IDs only). Full reconciliation: `work-products/TSBC-1678/TSBC-1678-reconciliation.md`.
