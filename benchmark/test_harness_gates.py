#!/usr/bin/env python3
import copy
import json
import tempfile
import unittest
from pathlib import Path

import benchlib
import adapters
import judge_policy
import ledger
import model_watch_guardrails
import model_provenance
import report
import scoring
import variants


def cfg_for(role, models, baselines=None):
    return {
        "models": models,
        "models_catalog": [],
        "roles": [role],
        "agentic_roles": [],
        "judge": {"id": "unit-judge"},
        "scoring": {},
        "recommendation": {
            "quality_floor": 0.6,
            "min_success_rate_for_quality": 0.8,
            "min_reps_for_decision": 3,
            "quality_epsilon": 0.02,
            "cost_ratio_trigger": 1.5,
            "value_metric": "output",
        },
        "run": {"reps": 3},
        "incumbent_baselines": baselines or {},
    }


def run_row(role, task_id, model_id, *, ok=True, quality=0.9, rep=1, reps=1, **extra):
    row = {
        "role": role,
        "task_id": task_id,
        "model_id": model_id,
        "model_label": model_id,
        "lane": "unit",
        "rep": rep,
        "reps": reps,
        "ok": ok,
        "quality": quality if ok else None,
        "qualityPer1kTokens": quality if ok else None,
        "outputTokens": 100 if ok else None,
        "inputTokens": 10 if ok else None,
        "totalTokens": 110 if ok else None,
        "tokensEstimated": False,
    }
    row.update(extra)
    return row


class HarnessGateTests(unittest.TestCase):
    def test_variants_config_override_resolves_paths_and_source_metadata(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            minimal = root / "minimal.md"
            current = root / "current.md"
            suite = root / "suite.json"
            skill = root / "skills" / "sample"
            skill.mkdir(parents=True)
            minimal.write_text("# Minimal\n")
            current.write_text("# Current\n")
            suite.write_text(json.dumps({"tasks": []}))
            (skill / "SKILL.md").write_text("# Skill\n")
            cfg_path = root / "local-variants.json"
            cfg_path.write_text(json.dumps({
                "roles": {
                    "paperclip": {
                        "representativeAgent": "Showrunner (Media)",
                        "currentAgentFile": str(current),
                        "minimalAgentFile": str(minimal),
                        "suiteFile": str(suite),
                        "skillsDir": str(root / "skills"),
                    }
                }
            }))

            cfg, resolved = variants.load_variants_config(str(cfg_path))
            rc = cfg["roles"]["paperclip"]
            af, skills = variants.resolve_role("paperclip", rc)
            meta = variants.role_source_meta(rc, resolved)

        self.assertEqual(resolved, cfg_path)
        self.assertEqual(variants.suite_path_for_role("paperclip", rc), suite)
        self.assertEqual(af["minimal"].strip(), "# Minimal")
        self.assertEqual(af["current"].strip(), "# Current")
        self.assertIn("# Skill", skills["all"])
        self.assertEqual(meta["representativeAgent"], "Showrunner (Media)")
        self.assertEqual(meta["variantsConfigPath"], str(cfg_path))

    def test_default_judge_policy_is_spark_medium_codex(self):
        cfg = benchlib.load_config(benchlib.CONFIG_PATH)

        self.assertEqual(cfg["judge"]["id"], judge_policy.DEFAULT_JUDGE_ID)
        self.assertEqual(cfg["judge"]["adapter"], "codex")
        self.assertEqual(cfg["judge"]["model_arg"], judge_policy.SPARK_MODEL_ARG)
        self.assertEqual(cfg["judge"]["reasoning_effort"], judge_policy.SPARK_REASONING_EFFORT)
        self.assertEqual(
            cfg["judge_policy"]["calibrationRunIds"]["spark-medium"],
            judge_policy.TSBC_1642_MEDIUM_CALIBRATION_RUN_ID,
        )
        self.assertEqual(
            cfg["judge_policy"]["monthlyDriftCheck"]["meanAbsDeltaAutoRevertThreshold"],
            judge_policy.DRIFT_MEAN_ABS_DELTA_REVERT_THRESHOLD,
        )

    def test_score_run_passes_codex_judge_reasoning_effort(self):
        captured = {}
        original_run_model = scoring.run_model

        def fake_run_model(_prompt, model_row, _adapters_cfg, _timeout):
            captured.update(model_row)
            return {
                "ok": True,
                "output": '{"scores":{"quality":0.8},"rationale":"specific enough"}',
                "model": judge_policy.SPARK_MODEL_ARG,
                "inputTokens": 10,
                "outputTokens": 5,
                "totalTokens": 15,
            }

        try:
            scoring.run_model = fake_run_model
            result = scoring.score_run(
                {
                    "prompt": "Assess this answer.",
                    "rubric": {
                        "judge": {
                            "criteria": [
                                {"name": "quality", "weight": 1, "guidance": "score quality"}
                            ]
                        }
                    },
                },
                {"ok": True, "output": "candidate answer", "totalTokens": 10},
                {"judge": judge_policy.default_judge(), "scoring": {}},
                {},
                1,
            )
        finally:
            scoring.run_model = original_run_model

        self.assertEqual(captured["adapter"], "codex")
        self.assertEqual(captured["model_arg"], judge_policy.SPARK_MODEL_ARG)
        self.assertEqual(captured["reasoning_effort"], judge_policy.SPARK_REASONING_EFFORT)
        self.assertEqual(result["judgeScore"], 0.8)

    def test_low_success_rate_suppresses_quality(self):
        models = [{"id": "agy-claude-opus-4.6", "label": "AGY Opus", "adapter": "antigravity", "lane": "agy"}]
        cfg = cfg_for("cto", models)
        runs = [run_row("cto", "t01", "agy-claude-opus-4.6", ok=True, quality=0.9825)]
        runs.extend(
            run_row("cto", f"t{i:02d}", "agy-claude-opus-4.6", ok=False)
            for i in range(2, 13)
        )

        agg = report.aggregate(runs, cfg)
        stats = agg["roles"]["cto"]["models"]["agy-claude-opus-4.6"]

        self.assertIsNone(stats["meanQuality"])
        self.assertTrue(stats["qualitySuppressed"])
        self.assertEqual(stats["decisionBand"], "failed")
        self.assertTrue(stats["suppressed_reason"].startswith("successRate 0.0833 below floor"))

    def test_under_repeated_run_caps_at_candidate(self):
        models = [{"id": "candidate-model", "label": "Candidate", "adapter": "unit", "lane": "unit"}]
        cfg = cfg_for("ops", models)
        runs = [
            run_row("ops", "same-task", "candidate-model", ok=True, quality=0.95, rep=1, reps=2),
            run_row("ops", "same-task", "candidate-model", ok=True, quality=0.93, rep=2, reps=2),
        ]

        agg = report.aggregate(runs, cfg)
        stats = agg["roles"]["ops"]["models"]["candidate-model"]
        rec = agg["roles"]["ops"]["recommendation"]

        self.assertEqual(stats["reps"], 2)
        self.assertEqual(stats["decisionBand"], "candidate")
        self.assertIsNone(rec["pick"])
        self.assertEqual(rec["verdict"], "candidate_only")

    def test_missing_incumbent_baseline_voids_verdict(self):
        models = [
            {"id": "spark", "label": "Spark", "adapter": "codex", "lane": "codex"},
            {"id": "gemini-flash", "label": "Gemini Flash", "adapter": "antigravity", "lane": "agy",
             "model_arg": "Gemini 3.5 Flash (Medium)"},
        ]
        baselines = {
            "cv-review": {
                "required": True,
                "model": "gemini-flash",
                "adapter_type": "antigravity_local",
                "served_model": "Gemini 3.5 Flash (Medium)",
                "agents": ["ApplicationWriter-Gemini"],
            }
        }
        cfg = cfg_for("cv-review", models, baselines)
        runs = [
            run_row("cv-review", "task-a", "spark", ok=True, quality=0.9, rep=1, reps=3),
            run_row("cv-review", "task-a", "spark", ok=True, quality=0.91, rep=2, reps=3),
            run_row("cv-review", "task-a", "spark", ok=True, quality=0.92, rep=3, reps=3),
        ]

        agg = report.aggregate(runs, cfg)
        gate = agg["roles"]["cv-review"]["baselineRequirement"]
        rec = agg["roles"]["cv-review"]["recommendation"]

        self.assertFalse(gate["satisfied"])
        self.assertEqual(rec["verdict"], "void")
        self.assertIsNone(rec["pick"])

    def test_codex_spark_usage_limit_catalog_missing_is_quota_gated_not_nonexistent(self):
        served_catalog = [
            {"id": "gpt-5.6"},
            {"id": "gpt-5.6-sol"},
            {"id": "gpt-5.4"},
        ]
        probe_text = (
            "You've hit your usage limit for GPT-5.3-Codex-Spark. "
            "Switch to another model now, or try again at Aug 5th, 2026 7:34 AM."
        )

        status = model_watch_guardrails.classify_catalog_reconciliation(
            "codex_local",
            "gpt-5.3-codex-spark",
            served_catalog,
            direct_probe_text=probe_text,
            active_pin=True,
        )

        self.assertEqual(
            status,
            model_watch_guardrails.MODEL_EXISTS_QUOTA_GATED_CATALOG_MISSING,
        )

    def test_scoring_marks_quota_no_output_as_infra_no_score(self):
        result = scoring.score_run(
            {"prompt": "Return ok", "rubric": {"deterministic": [{"type": "contains", "value": "ok"}]}},
            {
                "ok": False,
                "output": "",
                "quotaError": True,
                "error": "You've hit your usage limit for GPT-5.3-Codex-Spark.",
            },
            cfg_for("cto", [{"id": "spark", "label": "Spark", "adapter": "codex", "lane": "codex"}]),
            {},
            1,
        )

        self.assertIsNone(result["quality"])
        self.assertEqual(result["failureReason"], benchlib.INFRA_QUOTA_NO_SCORE)
        self.assertEqual(result["failureProvider"], benchlib.PROVIDER_QUOTA)
        self.assertTrue(result["qualityExcluded"])

    def test_report_excludes_infra_quota_from_quality_means(self):
        models = [{"id": "spark", "label": "Spark", "adapter": "codex", "lane": "codex"}]
        cfg = cfg_for("cv-review", models)
        runs = [
            run_row("cv-review", "task-a", "spark", ok=True, quality=0.9, rep=1, reps=3),
            run_row(
                "cv-review", "task-a", "spark", ok=False, rep=2, reps=3,
                skipped=True,
                skipReason=benchlib.INFRA_QUOTA_NO_SCORE,
                failureReason=benchlib.INFRA_QUOTA_NO_SCORE,
                failureProvider=benchlib.PROVIDER_QUOTA,
                quotaError=True,
                error="You've hit your usage limit for GPT-5.3-Codex-Spark.",
            ),
        ]

        agg = report.aggregate(runs, cfg)
        stats = agg["roles"]["cv-review"]["models"]["spark"]

        self.assertEqual(stats["attempts"], 1)
        self.assertEqual(stats["infraQuotaNoScore"], 1)
        self.assertEqual(stats["providerQuotaFailures"], 1)
        self.assertEqual(stats["meanQuality"], 0.9)
        self.assertEqual(stats["successRate"], 1.0)

    def test_ledger_records_quota_no_score_provider_failure(self):
        cfg_models = [{
            "id": "spark",
            "label": "Spark",
            "adapter": "codex_local",
            "lane": "codex",
            "model_arg": "gpt-5.3-codex-spark",
        }]
        rows = [
            run_row(
                "cv-review", "task-a", "spark", ok=False, rep=1, reps=3,
                requestedModelArg="gpt-5.3-codex-spark",
                skipped=True,
                skipReason=benchlib.INFRA_QUOTA_NO_SCORE,
                failureReason=benchlib.INFRA_QUOTA_NO_SCORE,
                failureProvider=benchlib.PROVIDER_QUOTA,
                quotaError=True,
                error="You've hit your usage limit for GPT-5.3-Codex-Spark.",
                passStartedAt="2026-07-31T10:00:00+00:00",
                passFinishedAt="2026-07-31T10:00:05+00:00",
            ),
        ]
        with tempfile.TemporaryDirectory() as td:
            old_results_dir = benchlib.RESULTS_DIR
            old_ledger_dir = ledger.LEDGER_DIR
            old_ledger_path = ledger.LEDGER_PATH
            old_catalog = ledger._catalog_by_model_id
            try:
                root = Path(td)
                benchlib.RESULTS_DIR = root / "results"
                ledger.LEDGER_DIR = root / "ledger"
                ledger.LEDGER_PATH = ledger.LEDGER_DIR / "results.jsonl"
                ledger._catalog_by_model_id = lambda: {m["id"]: m for m in cfg_models}
                run_dir = benchlib.RESULTS_DIR / "run-quota"
                run_dir.mkdir(parents=True)
                (run_dir / "runs.json").write_text(json.dumps(rows))
                (run_dir / "recommendations.json").write_text(json.dumps({
                    "judge": "unit-judge",
                    "meta": {
                        "started_at": "2026-07-31T09:59:00+00:00",
                        "finished_at": "2026-07-31T10:04:00+00:00",
                    },
                }))

                ledger.record_bench_run("run-quota", company="TSBC")
                written = [json.loads(line) for line in ledger.LEDGER_PATH.read_text().splitlines()]
            finally:
                benchlib.RESULTS_DIR = old_results_dir
                ledger.LEDGER_DIR = old_ledger_dir
                ledger.LEDGER_PATH = old_ledger_path
                ledger._catalog_by_model_id = old_catalog

        pass_row = [row for row in written if row["kind"] == "model_eval_pass"][0]
        aggregate = [row for row in written if row["kind"] == "model_eval"][0]

        self.assertEqual(pass_row["failure_reason"], benchlib.INFRA_QUOTA_NO_SCORE)
        self.assertEqual(pass_row["failure_provider"], benchlib.PROVIDER_QUOTA)
        self.assertEqual(pass_row["score_disposition"], benchlib.INFRA_QUOTA_NO_SCORE)
        self.assertTrue(pass_row["metrics"]["qualityExcluded"])
        self.assertEqual(aggregate["decision_band"], benchlib.INFRA_QUOTA_NO_SCORE)
        self.assertEqual(aggregate["failure_provider"], benchlib.PROVIDER_QUOTA)
        self.assertEqual(aggregate["metrics"]["infraQuotaNoScore"], 1)
        self.assertEqual(aggregate["sample_count"], 0)

    def test_ledger_backfill_flags_historical_low_success_quality(self):
        cfg = cfg_for("cto", [{"id": "bad-row", "label": "Bad", "adapter": "unit", "lane": "unit"}])
        rows = [
            {
                "kind": "model_eval",
                "test_class": "cto",
                "model": "bad-row",
                "run_id": "run-old",
                "metrics": {"quality": 0.9825, "qPer1kOut": 1.0, "successRate": 0.0833},
            },
            {
                "kind": "model_eval",
                "test_class": "cto",
                "model": "good-row",
                "run_id": "run-good",
                "metrics": {"quality": 0.9, "qPer1kOut": 1.0, "successRate": 1.0},
            },
        ]
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "results.jsonl"
            path.write_text("".join(json.dumps(copy.deepcopy(row)) + "\n" for row in rows))

            result = ledger.backfill_success_floor(path=path, cfg=cfg)
            rewritten = [json.loads(line) for line in path.read_text().splitlines()]

        self.assertEqual(result["changed"], 1)
        self.assertIsNone(rewritten[0]["metrics"]["quality"])
        self.assertFalse(rewritten[0]["verified"])
        self.assertEqual(rewritten[0]["decision_band"], "failed")
        self.assertEqual(rewritten[1]["metrics"]["quality"], 0.9)

    def test_ledger_record_bench_run_writes_pass_rows_with_failure_reasons(self):
        cfg_models = [{"id": "model-a", "label": "Model A", "adapter": "unit", "lane": "unit", "model_arg": "pin-a"}]
        rows = [
            run_row(
                "cto", "task-a", "model-a", ok=True, quality=0.9, rep=1, reps=3,
                requestedModelArg="pin-a", servedModel="Model A", servedModelVerified=True,
                passStartedAt="2026-07-28T10:00:00+00:00", passFinishedAt="2026-07-28T10:00:05+00:00",
            ),
            run_row(
                "cto", "task-a", "model-a", ok=False, rep=2, reps=3,
                requestedModelArg="pin-a", servedModel="Model A", servedModelVerified=True,
                error="timeout", passStartedAt="2026-07-28T10:01:00+00:00",
                passFinishedAt="2026-07-28T10:02:00+00:00",
            ),
            run_row(
                "cto", "task-a", "model-a", ok=False, rep=3, reps=3,
                requestedModelArg="pin-a", servedModel="Wrong Model", servedModelVerified=False,
                servedModelMismatch=True, failureReason="served_model_mismatch",
                error="served_model_mismatch: requested pin-a, self-reported Wrong Model",
                passStartedAt="2026-07-28T10:03:00+00:00",
                passFinishedAt="2026-07-28T10:03:02+00:00",
            ),
        ]
        with tempfile.TemporaryDirectory() as td:
            old_results_dir = benchlib.RESULTS_DIR
            old_ledger_dir = ledger.LEDGER_DIR
            old_ledger_path = ledger.LEDGER_PATH
            old_catalog = ledger._catalog_by_model_id
            try:
                root = Path(td)
                benchlib.RESULTS_DIR = root / "results"
                ledger.LEDGER_DIR = root / "ledger"
                ledger.LEDGER_PATH = ledger.LEDGER_DIR / "results.jsonl"
                ledger._catalog_by_model_id = lambda: {m["id"]: m for m in cfg_models}
                run_dir = benchlib.RESULTS_DIR / "run-unit"
                run_dir.mkdir(parents=True)
                (run_dir / "runs.json").write_text(json.dumps(rows))
                (run_dir / "recommendations.json").write_text(json.dumps({
                    "judge": "unit-judge",
                    "meta": {
                        "started_at": "2026-07-28T09:59:00+00:00",
                        "finished_at": "2026-07-28T10:04:00+00:00",
                    },
                }))

                ledger.record_bench_run("run-unit", company="TSBC")
                written = [json.loads(line) for line in ledger.LEDGER_PATH.read_text().splitlines()]
            finally:
                benchlib.RESULTS_DIR = old_results_dir
                ledger.LEDGER_DIR = old_ledger_dir
                ledger.LEDGER_PATH = old_ledger_path
                ledger._catalog_by_model_id = old_catalog

        pass_rows = [row for row in written if row["kind"] == "model_eval_pass"]
        aggregate = [row for row in written if row["kind"] == "model_eval"][0]

        self.assertEqual(len(pass_rows), 3)
        self.assertEqual(sorted(row["failure_reason"] for row in pass_rows if row["failure_reason"]), [
            "served_model_mismatch",
            "timeout",
        ])
        self.assertEqual(aggregate["requested_model"], "pin-a")
        self.assertEqual(aggregate["reps"], 3)
        self.assertEqual(aggregate["metrics"]["successRate"], 0.3333)
        self.assertIsNone(aggregate["metrics"]["quality"])
        self.assertEqual(aggregate["decision_band"], "failed")

    def test_expanded_backfill_marks_unknowns_and_gemini_pro_mislabel_risk(self):
        cfg = cfg_for("cto", [{"id": "gemini-pro", "label": "Gemini Pro", "adapter": "antigravity", "lane": "agy"}])
        rows = [{
            "ts": "2026-06-20T10:00:00+00:00",
            "company": "TSBC",
            "kind": "model_eval",
            "test_class": "cto",
            "model": "gemini-pro",
            "model_reported": "gemini-pro",
            "model_class": "gemini",
            "metrics": {"quality": 0.9158, "qPer1kOut": 17.3, "successRate": 1.0},
            "n_tasks": 10,
            "run_id": "run-missing",
            "judge": "unit-judge",
            "skill": None,
            "source": "bench.py",
        }]
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "results.jsonl"
            path.write_text("".join(json.dumps(copy.deepcopy(row)) + "\n" for row in rows))

            result = ledger.backfill_expanded_schema(path=path, cfg=cfg)
            rewritten = [json.loads(line) for line in path.read_text().splitlines()]

        self.assertEqual(result["changed"], 1)
        self.assertEqual(result["pass_rows_added"], 0)
        self.assertEqual(rewritten[0]["reps"], "unknown")
        self.assertEqual(rewritten[0]["served_model"], "unknown")
        self.assertFalse(rewritten[0]["served_model_verified"])
        self.assertIn("TSBC-1439", rewritten[0]["served_model_flag"])

    def test_antigravity_self_report_match_distinguishes_known_bad_pin(self):
        self.assertTrue(adapters._served_model_matches_pin(
            "gemini-3.5-flash-medium",
            "Gemini 3.5 Flash (Medium)",
        ))
        self.assertTrue(adapters._served_model_matches_pin(
            "claude-opus-4-6-thinking",
            "Claude Opus 4.6 (Thinking)",
        ))
        self.assertFalse(adapters._served_model_matches_pin(
            "gemini-3.1-pro-high",
            "Gemini 3.6 Flash",
        ))
        self.assertFalse(adapters._served_model_matches_pin(
            "grok-4-fast-non-reasoning",
            "grok-4.3",
        ))

    def test_retired_alias_pin_fails_loudly(self):
        raw = adapters.run_model(
            "Return OK",
            {
                "id": "grok-4-fast",
                "label": "Grok 4 Fast",
                "adapter": "hermes",
                "lane": "hermes",
                "model_arg": "grok-4-fast-non-reasoning",
            },
            {"hermes": {"extra_args": []}},
            30,
        )

        self.assertFalse(raw["ok"])
        self.assertEqual(raw["failureReason"], "retired_model_alias")
        self.assertTrue(raw["servedModelMismatch"])
        self.assertIn("2026-05-15", raw["error"])

    def test_ledger_retired_alias_rows_are_annotated_and_folded(self):
        rows = [
            {
                "ts": "2026-06-14T15:43:53+00:00",
                "kind": "model_eval",
                "test_class": "content",
                "model": "grok-4-fast",
                "requested_model": "grok-4-fast-non-reasoning",
                "metrics": {"quality": 0.9, "successRate": 1.0},
                "run_id": "run-old-alias",
            },
            {
                "ts": "2026-04-14T15:43:53+00:00",
                "kind": "model_eval",
                "test_class": "content",
                "model": "grok-4-fast",
                "requested_model": "grok-4-fast-non-reasoning",
                "metrics": {"quality": 0.8, "successRate": 1.0},
                "run_id": "run-pre-retirement",
            },
        ]
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "results.jsonl"
            path.write_text("".join(json.dumps(copy.deepcopy(row)) + "\n" for row in rows))

            result = ledger.annotate_retired_aliases(path=path)
            rewritten = [json.loads(line) for line in path.read_text().splitlines()]

        self.assertEqual(result["changed"], 1)
        self.assertEqual(rewritten[0]["served_model_corrected"], "grok-4.3")
        self.assertEqual(rewritten[0]["model_effective"], "grok-4.3")
        self.assertEqual(rewritten[0]["model_original"], "grok-4-fast")
        self.assertNotIn("served_model_corrected", rewritten[1])
        self.assertEqual(model_provenance.row_for_reporting(rewritten[0])["model"], "grok-4.3")

    def test_report_folds_post_retirement_alias_into_grok43(self):
        models = [
            {"id": "grok-4.3", "label": "Grok 4.3", "adapter": "hermes", "lane": "hermes"},
            {"id": "grok-4-fast", "label": "Grok 4 Fast", "adapter": "hermes", "lane": "hermes"},
        ]
        cfg = cfg_for("ops", models)
        runs = [
            run_row(
                "ops", "task-a", "grok-4-fast", ok=True, quality=0.9, rep=1, reps=3,
                requestedModelArg="grok-4-fast-non-reasoning",
                passFinishedAt="2026-06-14T15:43:53+00:00",
            ),
            run_row(
                "ops", "task-a", "grok-4.3", ok=True, quality=0.91, rep=1, reps=3,
                requestedModelArg="grok-4.3",
                passFinishedAt="2026-06-14T15:44:53+00:00",
            ),
        ]

        agg = report.aggregate(runs, cfg)

        self.assertIn("grok-4.3", agg["roles"]["ops"]["models"])
        self.assertNotIn("grok-4-fast", agg["overall"]["perModel"])
        self.assertEqual(agg["roles"]["ops"]["models"]["grok-4.3"]["tasks"], 2)

    def test_model_denylist_blocks_combined_and_split_effort_bad_pin(self):
        cfg = cfg_for("cto", [])
        cfg["model_denylist"] = [{
            "id": "agy-gemini-3.1-pro-high-20260728",
            "models": ["gemini-3.1-pro-high"],
        }]
        models = [
            {"id": "bad-combined", "adapter": "antigravity", "lane": "antigravity",
             "model_arg": "gemini-3.1-pro-high"},
            {"id": "bad-split", "adapter": "antigravity", "lane": "antigravity",
             "model_arg": "gemini-3.1-pro", "effort": "high"},
            {"id": "ok-low", "adapter": "antigravity", "lane": "antigravity",
             "model_arg": "gemini-3.1-pro-low"},
        ]

        kept, skipped = benchlib.filter_models_for_active_holds(models, cfg)

        self.assertEqual([m["id"] for m in kept], ["ok-low"])
        self.assertEqual([m["id"] for m, _guard in skipped], ["bad-combined", "bad-split"])
        self.assertIn(
            "agy-gemini-3.1-pro-high-20260728",
            benchlib.format_model_hold_skip(skipped),
        )

    def test_model_denylist_blocks_invalid_agy_raw_slugs(self):
        cfg = cfg_for("cto", [])
        cfg["model_denylist"] = [{
            "id": "agy-invalid-raw-gemini-slugs-20260731",
            "models": ["gemini-3.5-flash-lite", "gemini-2.0-flash"],
        }]
        models = [
            {"id": "bad-flash-lite", "adapter": "antigravity", "lane": "antigravity",
             "model_arg": "gemini-3.5-flash-lite"},
            {"id": "bad-retired-2-0", "adapter": "antigravity", "lane": "antigravity",
             "model_arg": "gemini-2.0-flash"},
            {"id": "ok-listed", "adapter": "antigravity", "lane": "antigravity",
             "model_arg": "gemini-3.5-flash-medium"},
        ]

        kept, skipped = benchlib.filter_models_for_active_holds(models, cfg)

        self.assertEqual([m["id"] for m in kept], ["ok-listed"])
        self.assertEqual(
            [m["id"] for m, _guard in skipped],
            ["bad-flash-lite", "bad-retired-2-0"],
        )
        self.assertIn(
            "agy-invalid-raw-gemini-slugs-20260731",
            benchlib.format_model_hold_skip(skipped),
        )

    def test_served_model_mismatch_is_never_scored(self):
        task = {
            "prompt": "Return ok",
            "rubric": {"deterministic": [{"type": "contains", "value": "ok", "weight": 1}]},
        }
        result = scoring.score_run(
            task,
            {
                "ok": False,
                "output": "ok",
                "servedModelMismatch": True,
                "error": "served_model_mismatch",
                "totalTokens": 100,
            },
            cfg_for("cto", [{"id": "bad", "label": "Bad", "adapter": "unit", "lane": "unit"}]),
            {},
            1,
        )

        self.assertIsNone(result["deterministicScore"])
        self.assertIsNone(result["quality"])


if __name__ == "__main__":
    unittest.main()
