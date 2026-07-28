# Paperclip Model Benchmark (#15) — active model evaluator

Answers one question per role: **which model should this kind of agent run on?** —
and settles the standing **grok-4.3 vs grok-4.20** guess. Output drives the
data-driven tiering work (#9).

```
role suites  ──►  multi-model runner  ──►  deterministic + LLM-judge scorer  ──►  quality-per-token  ──►  per-role recommendation
<role>/suite.json   claude/codex/gemini/      objective checks + blind judge      tokens = cost proxy      report.md + recommendations.json
                    grok-4.3/grok-4.20                                            (subscription billing)
```

## Quick start

```bash
cd ~/paperclip/benchmark
python3 bench.py list                     # show role suites + task counts
python3 bench.py all --dry-run            # plan + CLI-call estimate, runs nothing
python3 bench.py all                      # full sweep -> results/run-<ts>/
python3 bench.py all --max-tasks-per-role 1   # smoke (1 task/role, all models)
python3 bench.py all --roles intake,engineer
python3 bench.py all --roles ops --models grok-4.3,grok-4.20 --reps 3
python3 bench.py all --models grok-4.3,grok-4.20   # just the grok showdown
python3 bench.py report run-<ts>          # re-render report from a finished run
```

No pip deps — pure stdlib Python 3.

Active roster note (2026-07-11): the default `models` matrix now includes
`gpt-5.4-mini` and `claude-sonnet-5`. If `benchmark/.claude-bench-halt` exists,
the harness skips remaining Claude cells cleanly instead of scoring a budget stop
as a model failure.

## Verdict classes

TSBC now treats benchmark evidence as one of three provenance classes:

- `raw_base`: neutralized `bench.py` / `missing_chapter_bench.py` style runs.
- `benchmark_current`: prompt-packet runs that inject `current` agent files and
  skills from `variants.json` or explicit probe overrides.
- `live_agentic`: a real Paperclip agent run with a named instructions bundle
  and runtime skill materialization.

Do not flatten these together in a recommendation memo. A `raw_base` score is
valid for model capability, but not by itself for a production-lane claim.
Model-watch follow-ups that could move a live lane must run the refinement loop
in [`benchmark/model-watch/TSKB0056-model-watch-runbook.md`](./model-watch/TSKB0056-model-watch-runbook.md)
and record both raw and refined scores.

## What it measures

Each model is invoked through its own CLI in a **fresh, empty temp working
directory** with config/rules-ignore flags. That neutralizes the local
`CLAUDE.md`/`AGENTS.md`/rules so we measure **base-model capability**, not the
local agent harness. (Measuring the harness — skills/tools — is #16's job.)

| Lane | CLI invocation | token source |
|---|---|---|
| `claude-opus` | `claude -p … --output-format json` | `usage` block |
| `codex-gpt-5.4` | `codex exec … --json -o last.txt` | cumulative JSONL events |
| `gemini-pro` | `gemini -p … -o json` | `stats` block |
| `grok-4.3` / `grok-4.20` | `hermes -z … -m <model>` | `hermes sessions export` JSONL |
| `grok-4.5` | `grok --prompt-file … -m grok-4.5 --output-format streaming-json` | estimated (`~4 chars/token`) |

The normalized per-run record mirrors Paperclip's `usage_json`
(`inputTokens`/`outputTokens`/`model`/`costUsd`) so the agent-scorecard and
tiering tooling speak the same dialect.

The shared ledger stores two model-eval record shapes:

- `model_eval_pass` — one row per task repetition, including `rep`, `reps`,
  requested/served model, verification flag, pass/fail, failure reason, token
  counts, duration, and start/finish timestamps.
- `model_eval` — one aggregate row per role/model/run. Aggregates retain the
  historical query surface, but the current harness derives them from pass rows
  instead of replacing the pass evidence.

Historical rows that lack explicit run metadata use `unknown`, not guessed
values. Antigravity (`agy`) runs must capture a same-run model self-report
beside the requested pin; a self-report mismatch is recorded as
`failure_reason: served_model_mismatch` and is never scored.

## Publication gates

The harness enforces three publication gates before a recommendation can become
decision-grade:

- Success-rate floor: `config.json -> recommendation.min_success_rate_for_quality`
  defaults to `0.8`. Below that, quality and q/1k are emitted as `null` with a
  `suppressed_reason`; the cell is failed, not absent.
- Repetitions: `config.json -> run.reps` defaults to `3`, and
  `recommendation.min_reps_for_decision` defaults to `3`. Runs may be lower for
  smoke work, but under-repeated cells are capped at `candidate` and cannot
  produce a decision-grade pick.
- Incumbent baseline: roles listed in `incumbent_baselines` must include the
  deployed agent + adapter + served-model row in the same run. If that baseline
  is missing or only represented by an assumed model name, the verdict is `void`.

## Scoring

Per task, quality ∈ [0,1] blends two layers (`config.json → scoring`):

1. **Deterministic checks** — objective, no LLM. `contains`, `regex`,
   `json_path_equals`, `max_words`, `max_chars`, … (see `scoring.py`).
   Ground-truth tasks (intake routing, failure classification, escalation
   policy) are scored entirely here.
2. **LLM judge** — a single **blind** judge model scores subjective criteria
   (correctness, hook, design quality…) in [0,1]. Blind = never told which model
   produced the answer, applied uniformly → fair *relative* rankings.

**`q/1k-out`** = quality per 1,000 **output** tokens = the primary value metric.
NOT total tokens: total is ~95% fixed CLI system-prompt overhead (claude ~25k base
vs codex ~10k), a harness artifact that would just reward whichever CLI ships the
smallest base prompt rather than the better model. Output tokens are the marginal
generation cost and comparable across CLIs. Set `config.json → recommendation.value_metric`
to `"total"` to rank on total instead.

> ⚠️ Lesson from the first baseline: with easy tasks + a lenient judge, EVERY model
> scored quality ≈ 1.000 (ceiling effect) and the only separator was total-token
> overhead → "codex wins everything" was an artifact, not a result. Discrimination
> comes from (1) failable/trap tasks, (2) a strict judge, (3) the output-token metric.

### Judge choice

The judge defaults to **`claude-opus`** — the sharpest available grader, and it gives
real partial credit (0.8/0.92/0.97) where a lenient judge hands out flat 1.0s. It is a
contestant too, but the judge is blind to which model produced an output and applied
uniformly, so rankings are fair (mild self-preference is the one caveat). To conserve
claude quota, flip `config.json → judge` to `gemini-pro`. `python3 bench.py report
<run-id>` re-aggregates without re-judging; re-run `all` to re-judge.

## The suites (`<role>/suite.json`)

| role | tasks | grounded in |
|---|---|---|
| `intake` | 6 (deterministic) | `mc-compiler-dispatch.py` routing + traps (wrong-parent, false probe flag, strict schema) |
| `engineer` | 6 | failure classify, scorecard SQL bug, prefix router, concurrency-race spot, `staleThresholdMs=0` bug, null-safe normalizer |
| `ops` | 5 | recovery-loop + 3-defect restart-race diagnosis, escalate-after-3, failover routing, pseudo-stop classify |
| `content` | 5 | KDP blurb, launch tweet, forbidden-word trap, exact 3-line structure, tighten-to-40-words |
| `designer` | 5 | grok-imagine prompt, status pill, exact-geometry bar chart, hex palette, accessible badge |

Adding a task = appending one object to a suite's `tasks[]`. Task schema:

```jsonc
{
  "id": "unique-id",
  "title": "human label",
  "prompt": "self-contained task text given verbatim to every model",
  "rubric": {
    "deterministic": [ { "type": "json_path_equals", "path": "decision", "value": "cancel", "weight": 5 } ],
    "judge": { "criteria": [ { "name": "correctness", "weight": 3, "guidance": "..." } ] }
  }
}
```

## Output (`results/run-<ts>/`)

- `raw/<role>__<task>__<model>.json` — every run: output, tokens, scores, errors
- `runs.json` — all runs, flat
- `report.md` — human report: overall + per-role tables, recommendations, grok verdict
- `recommendations.json` — machine-readable per-role recommendation → **tiering #9**

`recommendations.json → roles.<role>.recommendation.pick` is the model to tier
that role onto; `roles.<role>.grokHeadToHead` carries the 4.3-vs-4.20 result.

## TSBC closeout gate

If a run will feed a TSBC issue, report, catalog row, or rollout decision, the
benchmark is not complete at `report.md` or `recommendations.json`.

If the run maps to a TSBC Paperclip test issue, the issue also stays open until a
branded PDF closing artifact named `TSBC-<issue>-report.pdf` is attached. That
PDF is mandatory on every TSBC test issue and must at minimum cover the
hypothesis, method, data, verdict (`CONFIRMED` / `REFUTED` / `INCONCLUSIVE`),
and dispatched follow-up key.

Close it with the TSBC fairness block:

- fairness verdict;
- evidence depth;
- run IDs;
- repetitions per compared cell;
- low-tail / min-score note;
- token / cost / runtime note or explicit caveat;
- scorer lane;
- scorer calibration status;
- calibration set;
- tie-break owner;
- scorer caveat;
- reproducibility fingerprint;
- model/scorer version;
- environment;
- records path;
- suite hash and prompt/system hash (or explicit `not_preserved:<reason>` / `none`);
- failure-library IDs;
- next gate.

The TSBC KB keeps the pasteable template, and TSBC-specific probe reports should
carry this closeout at the end so evaluators do not stop at mean score plus a
recommendation.
Use the TSBC report template plus the `brandsuite pdf` render path for the issue
artifact; markdown tables and issue comments are supporting evidence, not a
substitute for the PDF attachment.

## Consolidated token usage (`usage.py`)

One command, every lane's token usage in one place — input/output/total per model:

```bash
python3 usage.py all                # bench run + gemini + hermes + paperclip DB
python3 usage.py bench [run-id]      # per-model usage from a benchmark run
python3 usage.py gemini --days 7     # gemini CONSUMED usage (the blind lane, solved)
python3 usage.py hermes --days 7     # grok/hermes via `hermes insights`
python3 usage.py paperclip --days 7  # live fleet per-model from heartbeat_runs DB
```

`gemini_usage.py` is the standalone gemini extractor (also importable). Gemini has no
quota endpoint and Paperclip's quota board can't see it, but the CLI persists per-call
tokens to `~/.gemini/tmp/<slug>/chats/session-*.jsonl` (`type=="gemini"` lines,
`.tokens.{input,output,cached,thoughts,total}`). This rolls them up per day/model.
CONSUMED-only — there is no local record of remaining quota (that needs a live Google
Code Assist API call); `~/.gemini/tmp` is best-effort retention, so ingest incrementally.

Direct `grok` note (2026-07-17): the EU `grok.com` lane now exposes `grok-4.5`, and
the benchmark can run it via the native `grok` CLI. That stream does not emit usage
blocks today, so `inputTokens` / `outputTokens` on direct-Grok rows are estimated and
must be called out explicitly in any TSBC closeout.

## #16 Skill-refinement benchmark (`skillbench.py`)

Does a candidate skill actually earn its place? Runs an under-specified task WITH vs
WITHOUT a skill injected, scores both on the same rubric (reusing the #15 engine), and
reports the lift → KEEP / NEUTRAL / DROP.

```bash
python3 skillbench.py                         # all pairs, all models, 2 reps
python3 skillbench.py --pairs ops-restart-race --models claude-opus,gemini-pro
python3 skillbench.py --keep-threshold 0.03
```

- Pairs in `skillbench/pairs.json` pair a candidate skill (`skillbench/candidate-skills/*.md`)
  with a deliberately under-specified task (the methodology the skill teaches is NOT in the
  bare prompt, leaving room to help).
- The skill is injected into the GENERATION prompt only; SCORING uses the bare task so the
  blind judge sees the candidate's OUTPUT and the real objective, never the skill text — we
  measure whether the skill made the ANSWER better, not whether the model parrots the skill.
- Reports lift AND the extra tokens the skill costs (a small lift may not justify a big skill).
- This is the keep/kill gate for the skill-creator eval loop: iterate the SKILL.md, keep it
  only if it beats baseline.

## Post-bench refinement loop

When a raw model score is strong enough to matter, do not jump straight from the
base sweep to keep/reject. Run a bounded refinement pass on the exact decision
surface:

1. raw base score (`bench.py`)
2. production-facing probe with the current instruction file and no skills
3. production-facing probe with the current instruction file and the live
   runtime skills bundle
4. one focused tweak only if the lane is still weak

Use `tsbc_task_probe.py` for that pass. It now accepts explicit
`--current-agent-file-path`, `--skills-dir-path`, and `--effort` overrides and
records the source paths plus agent/skills/suite hashes in `summary.json`,
`report.md`, raw records, and the shared ledger rows, so the issue closeout can
prove what context and effort were actually measured. For antigravity roles that
are documented as agentic (`book-chapter`, `content`, `cv-review`),
non-`bare+none` probe cells now auto-route through the file-mounted
`agy --print` frame and record the per-model `generationFrame` in the
artifacts. Do not treat older single-shot Gemini probe rows on those roles as
live-lane evidence.

Do not publish a live-lane adoption verdict without:

- raw score
- refined score
- same-batch challenger and incumbent rows
- source paths and hashes for the refined context

## Era-comparison rule

Bench rows are only like-for-like when the suite hash and effort match.

- Same model name + different `suiteSha256` = different benchmark era.
- Same model name + same suite hash but different `effort` = different runtime posture.
- Same model name + same suite/effort but different skill bundle = different
  production packet.

When any of those differ, label the read `cross-era` / `directional` instead of
claiming a direct overwrite. The lock tables should pin the live row as
`model + effort + bundle`, not just a model label.

## Caveats

- **Subscription billing** → `costUsd` is ~0 for most lanes; **tokens are the
  cost proxy**. q/1k is the comparable efficiency metric.
- **Hermes tokens** come from the session store; if export parsing ever fails
  for a run, that run's tokens are **estimated** (`tokensEstimated: true`, flagged
  `(est)` in the report) so cross-lane efficiency stays populated.
- The benchmark measures the **base model**, neutralized of local skills/tools.
  Skill effectiveness is #16 (run a task with vs without a candidate skill on
  these same rubrics).
- Small task counts → treat single-run deltas as directional. Scale up with
  `--max-tasks-per-role` or by adding tasks before making a tiering call on a
  thin margin.
