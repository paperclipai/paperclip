# TSBC — ThinkStack BootCamp — Charter

*The internal org that owns ThinkStack's model / skill / agent quality system.*
(Workstream **B** of the [[tsbc-bootcamp-vision]] plan. Company: id `e212ce50-…`, prefix **AGE** retained — 706 existing issues make a prefix change destructive; identity is by name + mission.)

## Mission
Turn "which model / adapter / skill is best for which task" from guesswork into evidence. TSBC designs and runs the benchmark suites, puts every model + adapter + skill combination through its paces cleanly and repeatably, and converts the results into the lane and skill decisions the operating companies run on.

## Remit
- **Suites** — design + maintain benchmark suites per role, per task, and (newly) per single-lane sub-task.
- **Runs** — put models/adapters/skills through the suites; **3-run minimum for decision-grade** (n=1 = directional only); maintain the score ledger (`ledger/results.jsonl`).
- **Skills** — refine + refresh skills; **tag each skill per (model, adapter, task)** — "skill X lifts model Y on task Z by N". This is the core IP.
- **Adapters / MCPs** — test + integrate MCP servers; diagnose + fix adapter issues (the hermes/codex/antigravity lanes).
- **Self-correction** — pull REAL fleet data (live-run quality) back into the suites to refine them and catch drift.
- **Recommendations** — publish the lane/skill picks; MC routes them to the companies (autonomy within the menu).
- **(stretch E)** — productize role-specific skill packs via a basic website.

## Structure
- **Drillmaster (lead)** — designs suites, orchestrates runs, synthesizes results, owns the ledger + recommendations. codex-5.4. *Stood up as the first step of workstream A* (repurpose the paused `Bench-Manager`, grok→codex).
- **Proving ground (subjects)** — the `Bench-<model>` agents, one per model/adapter (claude-opus / claude-sonnet-5, codex-gpt-5.4 with the `gpt-5.4-mini` cheap profile, gpt-5.5, gemini-pro, grok-4.3 / 4.1-fast / 4-fast / 4.20). They run identical suites so comparisons are fair. Kept as-is.
- **Tooling** — `bench.py` (multi-model eval), `variants.py` (AF×skill grid), `cascade.py`, `costreport.py`, `per_task_compare.py`, `adapter_swap.py`, `make_fleet_agent.py`; registry in `config.json`; results in `ledger/`.

## Operating model
1. A suite is `suite.json` per task class. `bench.py` runs suite × models → ledger.
2. Decision-grade requires ≥3 runs; results below that are flagged directional.
   The harness now records `reps` separately from `n_tasks`; under-3-rep cells
   are capped at `candidate` even if their score is high. Ledger aggregates must
   be backed by `model_eval_pass` rows with pass/fail, failure reason, requested
   model, served model, and timestamps; unrecoverable historical fields are
   `unknown`, not inferred.
3. Skills are evaluated WITH and WITHOUT, per model/adapter, and tagged with the delta.
4. Recommendations that could move a live lane require a post-bench refinement pass:
   record the raw base score, rerun the contender and incumbent in the same batch
   with the production-facing instruction/skill context, then publish the raw vs
   refined delta before MC adoption.
   Missing deployed incumbent baselines void the verdict.
5. Era discipline is mandatory: verdicts are only directly comparable when the
   suite hash and effort match. If either changes, call the read
   `cross-era` / `directional` until a same-batch rerun closes the gap.
6. Live lock rows are keyed by `model + effort + bundle`, not by model name alone.
7. Recommendations → MC → companies adopt; off-menu deviations need a TSBC run to justify.
8. Concurrency is capped (shared Mac) — heavy runs scheduled off live-sprint windows.

## Roadmap
- **A** — Cheap-model × task × skill **decision matrix** (flagship first run; validates the drafter lanes).
- **C** — Per-single-lane-task benchmarks (chapter prose, hook, SEO copy, application, tag-gen…).
- **D** — Fast-agent **team decomposition** (do 2–3 fast agents split a task better than one drafter?).
- **E** — Skill-pack productization.

## Governance
TSBC is the source of truth for model/skill decisions and re-runs on every new model. Its company is isolated so its 700+ benchmark issues never touch live OpCo boards; all fleet exclusions key off the company **id**, so the rename is safe.

## Charter addendum — 2026-07-11 (operator session)
- **Sensing function added.** Daily **model-watch** routine (board routine `94bec39d`, Bench-Manager, 07:30 Europe/Dublin): CLI-version + probe checks, adapter-catalog diffs, provider docs online; Ollama/local catalog leg Mondays (catalog-only, never pull — 32GB shared Studio); removals/pricing = same severity as launches; EU availability is always part of the verdict; Sunday liveness line to the operator digest (a silent detector is indistinguishable from a dead one). Findings tagged `content-source` — raw feed for future model-report PDFs / newsletter / agency collateral (publication stays board-gated). State: `benchmark/model-watch/state.json`.
- **Validity gate added (2026-07-12).** Model-watch benches now follow `benchmark/model-watch/TSKB0056-model-watch-runbook.md`: every live-lane recommendation must record provenance class (`raw_base`, `benchmark_current`, `live_agentic`), re-bench challenger and incumbent in the same batch, and publish raw-vs-refined scores before a keep/reject/adopt call.
- **In-house media lane.** **Bench-Designer-Media** (`69c62fef`, hermes_local grok-4.3, `image_gen,video_gen`, reports to Bench-Manager) — benchmark media generation runs in-company; production Designer-Media lanes are no longer borrowed for bench work (operator decision, supersedes the 07-10 retarget disposition on TSBC-986).
- **Structure note:** the proving-ground list above predates 07-10/11 — grok "fast" rows retired (they were grok with NO effort settings), Bench-gemini-pro + claude-opus lanes paused (fleet Gemini pause / Claude scarcity), GPT-5.6 family added via codex CLI ≥0.144, and the active cheap-lane matrix now includes `claude-sonnet-5` plus the `gpt-5.4-mini` codex tier after the 07-11 platform upgrade.
- **Rollout gate (operator, 07-11):** the DEPLOYMENT MILESTONE lane rollout executes AFTER TSBC-1006 (GPT-5.6 Sol/Terra/Luna bench) closes identified gaps — priority: a non-Google cv-review primary (Gemini is a single point of failure there) and the judge-agreement study (move routine judging off Claude if agreement is high).
