#!/usr/bin/env python3
import copy
import json
import tempfile
import unittest
from pathlib import Path

import benchlib
import adapters
import ledger
import report
import scoring


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
