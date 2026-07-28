#!/usr/bin/env python3
"""
ledger.py — the shared benchmark source of truth across all 7 companies.

Every company that runs a model or skill benchmark APPENDS its findings here, so
others can reference them instead of re-benchmarking. The decision rule (davin,
2026-06-14):

  TRUST RULE: for a given (test_class, model), if there are >= 3 results in the last
  30 days -> TRUST the pooled result (return the aggregate). If fewer -> BENCHMARK
  YOURSELF, trust your own output, and RECORD it so the next company can trust the pool.

Storage: ledger/results.jsonl — append-only JSON-lines, one record per (model x test_class)
outcome. Concurrent appends from multiple companies are serialized with an flock.
Skill results carry a link to the skill file so any company can run the same test.

Commands:
  python3 ledger.py record --run <run-id>          # ingest a bench OR skill run dir
  python3 ledger.py query <test_class> <model>     # the TRUST decision + aggregate
  python3 ledger.py summary [--days 30]            # coverage: who has what, trust status
  python3 ledger.py skills                         # skills referenced + links to run them

test_class is a role (engineer/designer/content/intake/ops) for model evals, or
"skill:<pair-id>" for skill evals.
"""

import argparse
import fcntl
import glob
import json
import os
import statistics
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import benchlib

LEDGER_DIR = benchlib.ROOT / "ledger"
LEDGER_PATH = LEDGER_DIR / "results.jsonl"
DEFAULT_DAYS = 30
DEFAULT_MIN_RESULTS = 3
_BENCH_METADATA_KINDS = {"model_eval", "config_variant", "agentic_config_variant", "task_probe"}
_BENCH_PASS_KINDS = {"model_eval_pass"}
_BENCH_RECORD_KINDS = _BENCH_METADATA_KINDS | _BENCH_PASS_KINDS
UNKNOWN = "unknown"


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _company():
    return os.environ.get("PAPERCLIP_COMPANY", "TSBC")


def _model_class(model_id):
    m = model_id.lower()
    for fam in ("claude", "codex", "gpt", "gemini", "grok"):
        if fam in m:
            return "gpt" if fam == "codex" else fam
    return model_id


def _mean(values):
    values = [value for value in values if value is not None]
    return statistics.mean(values) if values else None


def _record_reps(records):
    if not records:
        return 0
    by_task = Counter(record.get("task_id") or "__unknown__" for record in records)
    return min(by_task.values()) if by_task else 0


def _record_task_count(records):
    task_ids = {record.get("task_id") for record in records if record.get("task_id")}
    return len(task_ids) if task_ids else len(records)


def _row_reps(row):
    for value in (row.get("reps"), (row.get("metrics") or {}).get("reps")):
        try:
            return max(1, int(value))
        except (TypeError, ValueError):
            pass
    return 1


def _success_suppression_reason(success_rate, cfg=None):
    if benchlib.success_rate_meets_quality_floor(success_rate, cfg):
        return None
    if success_rate is None:
        return None
    floor = benchlib.min_success_rate_for_quality(cfg)
    return f"successRate {success_rate:.4f} below floor {floor:.4f}"


def _row_is_decision_grade(row, cfg=None):
    metrics = row.get("metrics") or {}
    if row.get("verified") is False or row.get("unverified"):
        return False
    if metrics.get("quality") is None:
        return False
    success_rate = metrics.get("successRate")
    try:
        success_rate = float(success_rate) if success_rate is not None else None
    except (TypeError, ValueError):
        success_rate = None
    if _success_suppression_reason(success_rate, cfg):
        return False
    return benchlib.reps_meet_decision_floor(_row_reps(row), cfg)


def _suite_path_for_role(role):
    return benchlib.ROOT / role / "suite.json"


def _suite_hash_for_role(role):
    return benchlib.file_sha256(_suite_path_for_role(role))


def _catalog_by_model_id():
    cfg = benchlib.load_config()
    return {m["id"]: m for m in (cfg.get("models", []) + cfg.get("models_catalog", []))}


_VARIANT_HASH_CACHE = {}


def _variant_hash_fallbacks(role, agent_file, skills):
    key = (role, agent_file, skills)
    cached = _VARIANT_HASH_CACHE.get(key)
    if cached is not None:
        return cached
    variants_cfg = json.load(open(benchlib.ROOT / "variants.json")).get("roles", {})
    rc = variants_cfg.get(role)
    if not rc:
        result = {"agent_file_sha256": "none", "skills_bundle_sha256": "none"}
        _VARIANT_HASH_CACHE[key] = result
        return result
    import variants

    af_bodies, skill_bodies = variants.resolve_role(role, rc)
    agent_body = af_bodies.get(agent_file, "")
    skills_body = skill_bodies.get(skills, "")
    result = {
        "agent_file_sha256": benchlib.sha256_text(agent_body) if agent_body else "none",
        "skills_bundle_sha256": benchlib.sha256_text(skills_body) if skills_body else "none",
    }
    _VARIANT_HASH_CACHE[key] = result
    return result


def _single_record_value(records, keys, label, fallback=None):
    values = sorted({
        str(record.get(key)).strip()
        for record in records
        for key in keys
        if str(record.get(key) or "").strip()
    })
    if len(values) > 1:
        raise ValueError(f"{label} mismatch across aggregated records: {values}")
    if values:
        return values[0]
    if fallback is not None:
        return fallback
    raise ValueError(f"missing {label}")


def _reported_model_fields(records, model_id):
    values = sorted({
        str(record.get("model_reported")).strip()
        for record in records
        if str(record.get("model_reported") or "").strip()
    })
    if not values:
        return {"model_reported": model_id, "reported_models": [model_id]}
    return {
        "model_reported": values[0] if len(values) == 1 else "multiple:" + ",".join(values),
        "reported_models": values,
    }


def _as_unknown(value):
    if value is None:
        return UNKNOWN
    if isinstance(value, str) and not value.strip():
        return UNKNOWN
    return value


def _field_values(records, keys, fallback=None):
    values = sorted({
        str(record.get(key)).strip()
        for record in records
        for key in keys
        if str(record.get(key) or "").strip()
    })
    if not values and fallback is not None and str(fallback or "").strip():
        values = [str(fallback).strip()]
    return values


def _one_or_multiple(values, unknown=UNKNOWN):
    values = sorted({str(value).strip() for value in values if str(value or "").strip()})
    if not values:
        return unknown
    if len(values) == 1:
        return values[0]
    return "multiple:" + ",".join(values)


def _requested_model_for_record(record, model_row=None):
    model_row = model_row or {}
    return _as_unknown(
        record.get("requestedModelArg")
        or record.get("requested_model")
        or model_row.get("model_arg")
        or record.get("model_id")
        or record.get("model")
    )


def _served_model_for_record(record):
    return _as_unknown(
        record.get("servedModelSelfReport")
        or record.get("servedModel")
        or record.get("served_model")
        or record.get("model_reported")
        or record.get("trueModelId")
    )


def _agent_id_for_record(record):
    return _as_unknown(
        record.get("benchAgentId")
        or record.get("agent_id")
        or record.get("agentId")
    )


def _failure_reason(record):
    if record.get("servedModelMismatch") or record.get("served_model_mismatch"):
        return "served_model_mismatch"
    raw_reason = record.get("failureReason") or record.get("failure_reason")
    if raw_reason:
        return str(raw_reason)
    if record.get("skipped"):
        return str(record.get("skipReason") or "skipped")
    text = " ".join(
        str(value or "")
        for value in (
            record.get("error"),
            record.get("stderrTail"),
            ((record.get("judgeDetail") or {}) if isinstance(record.get("judgeDetail"), dict) else {}).get("error"),
            ((record.get("judgeDetail") or {}) if isinstance(record.get("judgeDetail"), dict) else {}).get("judgeError"),
        )
    ).lower()
    if "timeout" in text or "timed out" in text:
        return "timeout"
    if any(s in text for s in ("unauth", "unauthorized", "401", "403", "permission denied", "auth")):
        return "auth"
    if any(s in text for s in ("quota", "rate limit", "rate-limit", "429", "resource exhausted")):
        return "quota"
    if any(s in text for s in ("unparseable", "parse", "json")):
        return "parse"
    if record.get("ok") and record.get("quality") is None:
        return "judge-refusal"
    if record.get("ok") is False or record.get("error"):
        return "tool-error"
    return None


def _pass_succeeded(record):
    return (
        not record.get("skipped")
        and bool(record.get("ok"))
        and record.get("quality") is not None
        and not record.get("servedModelMismatch")
        and not record.get("served_model_mismatch")
    )


def _suite_object(role, record=None):
    record = record or {}
    return {
        "role": role,
        "path": record.get("suiteSourcePath") or str(_suite_path_for_role(role)),
        "sha256": record.get("suiteSha256") or record.get("suite_sha256") or _suite_hash_for_role(role),
    }


def _pass_id(run_id, record):
    role = record.get("role") or record.get("test_class") or UNKNOWN
    task_id = record.get("task_id") or UNKNOWN
    model_id = record.get("model_id") or record.get("model") or UNKNOWN
    rep = record.get("rep") or UNKNOWN
    return f"{run_id}:{role}:{task_id}:{model_id}:rep-{rep}"


def _run_meta_for_dir(run_dir):
    rep_path = run_dir / "recommendations.json"
    if not rep_path.exists():
        return {}
    try:
        return json.load(open(rep_path)).get("meta") or {}
    except Exception:
        return {}


def _pass_ledger_row(record, run_id, company, judge, run_started_at, run_finished_at, model_row=None):
    model_row = model_row or {}
    role = record.get("role") or record.get("test_class")
    model_id = record.get("model_id") or record.get("model")
    passed = _pass_succeeded(record)
    failure_reason = None if passed else _failure_reason(record)
    served_model = _served_model_for_record(record)
    served_verified = bool(record.get("servedModelVerified") or record.get("served_model_verified"))
    if model_id == "gemini-pro":
        served_verified = False
    adapter = _as_unknown(
        record.get("benchAdapterType")
        or record.get("adapterType")
        or record.get("adapter")
        or model_row.get("adapter")
    )
    effort = _as_unknown(record.get("effort") or benchlib.model_effort_label(model_row))
    suite = _suite_object(role, record)
    pass_started_at = _as_unknown(record.get("passStartedAt") or record.get("pass_started_at"))
    pass_finished_at = _as_unknown(record.get("passFinishedAt") or record.get("pass_finished_at"))
    row = {
        "ts": pass_finished_at if pass_finished_at != UNKNOWN else run_finished_at,
        "company": company,
        "kind": "model_eval_pass",
        "record_schema_version": 2,
        "test_class": role,
        "model": model_id,
        "model_reported": served_model,
        "reported_models": [] if served_model == UNKNOWN else [served_model],
        "model_class": _model_class(model_id or ""),
        "adapter_type": adapter,
        "adapter": adapter,
        "effort": effort,
        "agent_file_sha256": _as_unknown(record.get("agentFileSha256") or record.get("agent_file_sha256") or "none"),
        "skills_bundle_sha256": _as_unknown(
            record.get("skillsBundleSha256") or record.get("skills_bundle_sha256") or "none"
        ),
        "suite_sha256": suite["sha256"],
        "suite": suite,
        "task_id": record.get("task_id") or UNKNOWN,
        "task_title": record.get("task_title"),
        "rep": record.get("rep") if record.get("rep") is not None else UNKNOWN,
        "reps": record.get("reps") if record.get("reps") is not None else UNKNOWN,
        "requested_model": _requested_model_for_record(record, model_row),
        "requested_model_id": _as_unknown(record.get("requestedModelId") or model_id),
        "served_model": served_model,
        "served_model_verified": served_verified,
        "served_model_mismatch": bool(record.get("servedModelMismatch") or record.get("served_model_mismatch")),
        "agent_id": _agent_id_for_record(record),
        "run_started_at": _as_unknown(record.get("runStartedAt") or run_started_at),
        "run_finished_at": _as_unknown(record.get("runFinishedAt") or run_finished_at),
        "pass_started_at": pass_started_at,
        "pass_finished_at": pass_finished_at,
        "passed": passed,
        "failure_reason": failure_reason,
        "failure_detail": record.get("error"),
        "skipped": bool(record.get("skipped")),
        "skip_reason": record.get("skipReason"),
        "metrics": {
            "quality": _r(record.get("quality")),
            "qPer1kOut": _r(
                (record.get("quality") / (record.get("outputTokens") / 1000.0))
                if record.get("quality") is not None and record.get("outputTokens")
                else None
            ),
            "inputTokens": _r(record.get("inputTokens"), 0),
            "outputTokens": _r(record.get("outputTokens"), 0),
            "totalTokens": _r(record.get("totalTokens"), 0),
            "durationMs": _r(record.get("wallMs"), 0),
            "taskDurationMs": _r(record.get("taskWallMs"), 0),
            "selfReportDurationMs": _r(record.get("selfReportWallMs"), 0),
            "selfReportInputTokens": _r(record.get("selfReportInputTokens"), 0),
            "selfReportOutputTokens": _r(record.get("selfReportOutputTokens"), 0),
            "costUsd": _r(record.get("costUsd")),
        },
        "run_id": run_id,
        "pass_id": _pass_id(run_id, record),
        "judge": _as_unknown(judge),
        "skill": None,
        "source": "bench.py",
    }
    if model_id == "gemini-pro":
        row["served_model_flag"] = "TSBC-1439: gemini-pro pin has historical AGY mislabel risk"
    return row


def _is_missing_metadata_value(value):
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    return False


def _validate_bench_metadata(record):
    required = ("model_reported", "adapter_type", "effort", "skills_bundle_sha256", "suite_sha256")
    missing = [field for field in required if _is_missing_metadata_value(record.get(field))]
    if missing:
        raise ValueError(
            f"bench ledger row missing reproducibility metadata for {record.get('kind')} "
            f"{record.get('test_class')} {record.get('model')}: {', '.join(missing)}"
        )


def _validate_bench_record(record):
    _validate_bench_metadata(record)
    if record.get("kind") in _BENCH_PASS_KINDS:
        required = (
            "reps",
            "requested_model",
            "served_model",
            "served_model_verified",
            "agent_id",
            "adapter",
            "effort",
            "judge",
            "suite",
            "task_id",
            "run_started_at",
            "run_finished_at",
        )
        missing = [field for field in required if field not in record]
        if missing:
            raise ValueError(
                f"bench pass ledger row missing expanded schema field(s) for "
                f"{record.get('test_class')} {record.get('model')}: {', '.join(missing)}"
            )


# --------------------------------------------------------------------------
# append (flock-guarded so 7 companies can write concurrently)
# --------------------------------------------------------------------------

def append_records(records):
    LEDGER_DIR.mkdir(parents=True, exist_ok=True)
    with open(LEDGER_PATH, "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            for r in records:
                if r.get("kind") in _BENCH_RECORD_KINDS:
                    _validate_bench_record(r)
                f.write(json.dumps(r, separators=(",", ":")) + "\n")
            f.flush()
            os.fsync(f.fileno())
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)
    return len(records)


def read_all():
    if not LEDGER_PATH.exists():
        return []
    out = []
    with open(LEDGER_PATH) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


# --------------------------------------------------------------------------
# recording from run dirs
# --------------------------------------------------------------------------

def record_bench_run(run_id, company=None):
    """Ingest a #15 model-eval run's runs.json -> pass rows plus one aggregate per (role, model)."""
    company = company or _company()
    run_dir = benchlib.RESULTS_DIR / run_id
    runs_path = run_dir / "runs.json"
    if not runs_path.exists():
        raise FileNotFoundError(f"no runs.json for {run_id}")
    rep_path = run_dir / "recommendations.json"
    if rep_path.exists():
        with open(rep_path) as f:
            rep = json.load(f)
    else:
        rep = {}
    with open(runs_path) as f:
        runs = json.load(f)
    cfg = benchlib.load_config()
    judge = rep.get("judge")
    meta = rep.get("meta") or {}
    run_started_at = meta.get("started_at") or UNKNOWN
    run_finished_at = meta.get("finished_at") or _now_iso()
    ts = run_finished_at
    roster = _catalog_by_model_id()
    out = []

    pass_rows = [
        _pass_ledger_row(
            record,
            run_id,
            company,
            judge,
            run_started_at,
            run_finished_at,
            roster.get(record.get("model_id") or record.get("model"), {}),
        )
        for record in runs
    ]
    out.extend(pass_rows)

    grouped = {}
    for pass_row in pass_rows:
        grouped.setdefault((pass_row["test_class"], pass_row["model"]), []).append(pass_row)
    for (role, model_id), records in sorted(grouped.items()):
        considered = [record for record in records if not record.get("skipped")]
        ran = [record for record in considered if record.get("passed") and record.get("metrics", {}).get("quality") is not None]
        success_rate = (len(ran) / len(considered)) if considered else 0.0
        publish_quality = benchlib.success_rate_meets_quality_floor(success_rate, cfg)
        reps = _record_reps(considered)
        min_reps = benchlib.min_reps_for_decision(cfg)
        suppressed_reason = _success_suppression_reason(success_rate, cfg)
        decision_grade = publish_quality and benchlib.reps_meet_decision_floor(reps, cfg)
        if suppressed_reason:
            decision_band = "failed"
            unverified_reason = suppressed_reason
        elif not decision_grade:
            decision_band = "candidate"
            unverified_reason = f"reps {reps} below decision floor {min_reps}"
        else:
            decision_band = "possible_primary"
            unverified_reason = None
        model_row = roster.get(model_id, {"id": model_id})
        metadata_records = considered or records
        served_models = _field_values(metadata_records, ("served_model",), fallback=None)
        requested_models = _field_values(metadata_records, ("requested_model",), fallback=model_row.get("model_arg") or model_id)
        agent_ids = _field_values(metadata_records, ("agent_id",), fallback=UNKNOWN)
        adapters = _field_values(metadata_records, ("adapter", "adapter_type"), fallback=model_row.get("adapter"))
        efforts = _field_values(metadata_records, ("effort",), fallback=benchlib.model_effort_label(model_row))
        suite = _suite_object(role, metadata_records[0] if metadata_records else None)
        served_model_verified = bool(considered) and all(
            bool(record.get("served_model_verified")) and not record.get("served_model_mismatch")
            for record in considered
        )
        if model_id == "gemini-pro":
            served_model_verified = False
        reported_fields = {
            "model_reported": _one_or_multiple(served_models, unknown=UNKNOWN),
            "reported_models": served_models,
        }
        out.append({
            "ts": ts,
            "company": company,
            "kind": "model_eval",
            "record_schema_version": 2,
            "test_class": role,
            "model": model_id,
            **reported_fields,
            "model_class": _model_class(model_id),
            "adapter_type": _one_or_multiple(adapters),
            "adapter": _one_or_multiple(adapters),
            "effort": _one_or_multiple(efforts),
            "agent_file_sha256": _one_or_multiple(
                _field_values(metadata_records, ("agent_file_sha256",), fallback="none")
            ),
            "skills_bundle_sha256": _one_or_multiple(
                _field_values(metadata_records, ("skills_bundle_sha256",), fallback="none")
            ),
            "suite_sha256": suite["sha256"],
            "suite": suite,
            "task_id": "aggregate",
            "requested_model": _one_or_multiple(requested_models),
            "requested_model_id": model_id,
            "served_model": _one_or_multiple(served_models, unknown=UNKNOWN),
            "served_model_verified": served_model_verified,
            "agent_id": _one_or_multiple(agent_ids),
            "run_started_at": run_started_at,
            "run_finished_at": run_finished_at,
            "metrics": {
                "quality": _r(_mean([record.get("metrics", {}).get("quality") for record in ran])) if publish_quality else None,
                "qPer1kOut": _r(_mean([
                    record.get("metrics", {}).get("qPer1kOut")
                    for record in ran
                    if record.get("metrics", {}).get("qPer1kOut") is not None
                ])) if publish_quality else None,
                "meanOutputTokens": _r(_mean([record.get("metrics", {}).get("outputTokens") for record in ran]), 0),
                "meanInputTokens": _r(_mean([record.get("metrics", {}).get("inputTokens") for record in ran]), 0),
                "meanDurationMs": _r(_mean([record.get("metrics", {}).get("durationMs") for record in considered]), 0),
                "successRate": _r(success_rate),
                "suppressed_reason": suppressed_reason,
            },
            "n_tasks": _record_task_count(considered),
            "sample_count": len(considered),
            "reps": reps,
            "min_reps_for_decision": min_reps,
            "decision_band": decision_band,
            "verified": bool(decision_grade),
            "unverified_reason": unverified_reason,
            "run_id": run_id,
            "judge": judge,
            "skill": None,
            "source": "bench.py",
        })
        if model_id == "gemini-pro":
            out[-1]["served_model_flag"] = "TSBC-1439: gemini-pro pin has historical AGY mislabel risk"
    return append_records(out), len(out)


def record_skill_run(run_id, company=None):
    """Ingest a #16 skill-eval run's summary.json/records.json -> one record per (pair, model)."""
    company = company or _company()
    run_dir = benchlib.RESULTS_DIR / run_id
    summ = json.load(open(run_dir / "summary.json"))
    recs = json.load(open(run_dir / "records.json")) if (run_dir / "records.json").exists() else []
    # map pair -> skill file from pairs.json
    pairs_meta = {}
    pj = benchlib.ROOT / "skillbench" / "pairs.json"
    if pj.exists():
        for p in json.load(open(pj)).get("pairs", []):
            pairs_meta[p["id"]] = p.get("skill")
    ts = _now_iso()
    out = []
    for key, s in summ.get("perPairModel", {}).items():
        pair, model_id = s["pair"], s["model"]
        out.append({
            "ts": ts, "company": company, "kind": "skill_eval",
            "test_class": f"skill:{pair}", "model": model_id, "model_class": _model_class(model_id),
            "metrics": {
                "lift": _r(s.get("meanLift")),
                "baselineQuality": _r(s.get("meanBaseline")),
                "treatmentQuality": _r(s.get("meanTreatment")),
                "skillExtraInputTokens": _r(s.get("meanExtraTokens"), 0),
            },
            "n_tasks": s.get("n"), "run_id": run_id, "judge": summ.get("judge") or "claude-opus",
            "skill": {"id": pair, "path": pairs_meta.get(pair),
                      "verdict": (summ.get("verdicts", {}).get(pair, {}) or {}).get("verdict")},
            "source": "skillbench.py",
        })
    return append_records(out), len(out)


def record_variants_run(run_id, company=None):
    """Ingest a #17 config-variant run's records.json -> one record per (role, model, agent_file, skills) cell.
    Namespaced test_class 'variant:<role>:<af>-<skills>' so these never pollute the bare base-model
    leaderboard (test_class=<role>). The base matrix already supplies bare:none (the floor); this layer
    captures the agent-file / skills configs on top, so the drill can fill the with-skills decision grid."""
    company = company or _company()
    run_dir = benchlib.RESULTS_DIR / run_id
    records_path = run_dir / "records.json"
    if not records_path.exists():
        raise FileNotFoundError(f"no records.json for {run_id}")
    records = json.load(open(records_path))
    ts = _now_iso()
    roster = _catalog_by_model_id()
    out = []
    grouped = {}
    for record in records:
        grouped.setdefault((record["role"], record["model"], record["agentFile"], record["skills"]), []).append(record)
    for (role, model_id, af, skills), cell_records in sorted(grouped.items()):
        valid = [record for record in cell_records if record.get("ok") and record.get("quality") is not None]
        if not valid:
            continue
        model_row = roster.get(model_id, {"id": model_id})
        hash_fallbacks = _variant_hash_fallbacks(role, af, skills)
        reported_fields = _reported_model_fields(cell_records, model_id)
        out.append({
            "ts": ts, "company": company, "kind": "config_variant",
            "test_class": f"variant:{role}:{af}-{skills}", "model": model_id,
            **reported_fields,
            "model_class": _model_class(model_id),
            "adapter_type": _single_record_value(
                cell_records,
                ("adapterType", "adapter_type"),
                "adapter_type",
                fallback=str(model_row.get("adapter") or "").strip() or None,
            ),
            "effort": _single_record_value(
                cell_records,
                ("effort",),
                "effort",
                fallback=benchlib.model_effort_label(model_row),
            ),
            "agent_file_sha256": _single_record_value(
                cell_records,
                ("agentFileSha256", "agent_file_sha256"),
                "agent_file_sha256",
                fallback=hash_fallbacks["agent_file_sha256"],
            ),
            "skills_bundle_sha256": _single_record_value(
                cell_records,
                ("skillsBundleSha256", "skills_bundle_sha256"),
                "skills_bundle_sha256",
                fallback=hash_fallbacks["skills_bundle_sha256"],
            ),
            "suite_sha256": _single_record_value(
                cell_records,
                ("suiteSha256", "suite_sha256"),
                "suite_sha256",
                fallback=_suite_hash_for_role(role),
            ),
            "metrics": {
                "quality": _r(_mean([record.get("quality") for record in valid])),
                "qPer1kOut": _r(_mean([record.get("qPer1kOut") for record in valid])),
                "meanOutputTokens": _r(_mean([record.get("outputTokens") for record in valid]), 0),
            },
            "n_tasks": len(valid), "run_id": run_id, "judge": None,
            "variant": {"role": role, "agentFile": af, "skills": skills},
            "skill": None, "source": "variants.py",
        })
    return append_records(out), len(out)


def record_agentic_variants_run(run_id, company=None):
    """Ingest a variants_agentic.py run's records.json -> one record per (role, model, af, skills) cell,
    namespaced test_class 'agentic-variant:<role>:<af>-<skills>'. This is the AGENTIC frame for lanes
    (gemini/antigravity) that cannot answer the single-shot ~65k concatenated-skills prompt: skills are
    mounted as files and the agent reads them on demand (mirrors the live antigravity_local adapter).
    Kept in its OWN namespace so it never mixes with the single-shot 'variant:' cells or the bare
    leaderboard — single-shot vs agentic are different methodologies and must be compared separately."""
    company = company or _company()
    run_dir = benchlib.RESULTS_DIR / run_id
    records_path = run_dir / "records.json"
    if not records_path.exists():
        raise FileNotFoundError(f"no records.json for {run_id}")
    records = json.load(open(records_path))
    ts = _now_iso()
    roster = _catalog_by_model_id()
    out = []
    grouped = {}
    for record in records:
        grouped.setdefault((record["role"], record["model"], record["agentFile"], record["skills"]), []).append(record)
    for (role, model_id, af, skills), cell_records in sorted(grouped.items()):
        valid = [record for record in cell_records if record.get("ok") and record.get("quality") is not None]
        if not valid:
            continue
        model_row = roster.get(model_id, {"id": model_id})
        hash_fallbacks = _variant_hash_fallbacks(role, af, skills)
        reported_fields = _reported_model_fields(cell_records, model_id)
        out.append({
            "ts": ts, "company": company, "kind": "agentic_config_variant",
            "test_class": f"agentic-variant:{role}:{af}-{skills}", "model": model_id,
            **reported_fields,
            "model_class": _model_class(model_id),
            "adapter_type": _single_record_value(
                cell_records,
                ("adapterType", "adapter_type"),
                "adapter_type",
                fallback=str(model_row.get("adapter") or "").strip() or None,
            ),
            "effort": _single_record_value(
                cell_records,
                ("effort",),
                "effort",
                fallback=benchlib.model_effort_label(model_row),
            ),
            "agent_file_sha256": _single_record_value(
                cell_records,
                ("agentFileSha256", "agent_file_sha256"),
                "agent_file_sha256",
                fallback=hash_fallbacks["agent_file_sha256"],
            ),
            "skills_bundle_sha256": _single_record_value(
                cell_records,
                ("skillsBundleSha256", "skills_bundle_sha256"),
                "skills_bundle_sha256",
                fallback=hash_fallbacks["skills_bundle_sha256"],
            ),
            "suite_sha256": _single_record_value(
                cell_records,
                ("suiteSha256", "suite_sha256"),
                "suite_sha256",
                fallback=_suite_hash_for_role(role),
            ),
            "metrics": {
                "quality": _r(_mean([record.get("quality") for record in valid])),
                "qPer1kOut": _r(_mean([record.get("qPer1kOut") for record in valid])),
                "meanOutputTokens": _r(_mean([record.get("outputTokens") for record in valid]), 0),
            },
            "n_tasks": len(valid), "run_id": run_id, "judge": None,
            "variant": {"role": role, "agentFile": af, "skills": skills},
            "frame": "agentic", "skill": None, "source": "variants_agentic.py",
        })
    return append_records(out), len(out)


def record_team_run(run_id, company=None):
    """Ingest a team_bench.py run's cells.json -> one record per (test_class) cell, namespaced
    'team:<domain>:<mode>' (single-<model> | team<N>-<workers>). This is workstream-D: does a TEAM
    of fast agents splitting a long-form draft beat ONE drafter? Kept in its OWN namespace so it
    never mixes with model/skill/variant/agentic-variant evals — different methodology."""
    company = company or _company()
    run_dir = benchlib.RESULTS_DIR / run_id
    cells_path = run_dir / "cells.json"
    if not cells_path.exists():
        raise FileNotFoundError(f"no cells.json for {run_id}")
    cells = json.load(open(cells_path))
    ts = _now_iso()
    out = []
    for test_class, c in cells.items():
        if c.get("quality") is None:
            continue
        out.append({
            "ts": ts, "company": company, "kind": "team_decomp",
            "test_class": test_class, "model": test_class.split(":")[-1],
            "model_class": "team" if ":team" in test_class else "single",
            "metrics": {
                "quality": _r(c.get("quality")),
                "qPer1kOut": _r(c.get("qPer1kOut")),
                "meanOutputTokens": _r(c.get("meanOutputTokens"), 0),
                "meanWallMs": _r(c.get("meanWallMs"), 0),
            },
            "n_tasks": c.get("n"), "run_id": run_id, "judge": None,
            "frame": "team", "skill": None, "source": "team_bench.py",
        })
    return append_records(out), len(out)


def _r(x, default=None):
    if x is None:
        return default
    return round(float(x), 4)


# --------------------------------------------------------------------------
# the TRUST decision
# --------------------------------------------------------------------------

def query(test_class, model, days=DEFAULT_DAYS, min_results=DEFAULT_MIN_RESULTS):
    cfg = benchlib.load_config()
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    hits = []
    pass_hits = []
    for r in read_all():
        if r.get("test_class") != test_class or r.get("model") != model:
            continue
        ts = _parse(r.get("ts"))
        if ts is None or ts < cutoff:
            continue
        if r.get("kind") in _BENCH_PASS_KINDS:
            pass_hits.append(r)
            continue
        hits.append(r)
    kind = hits[0].get("kind") if hits else None
    decision_hits = (
        [hit for hit in hits if _row_is_decision_grade(hit, cfg)]
        if kind in _BENCH_METADATA_KINDS
        else list(hits)
    )
    n = len(decision_hits)
    trust = n >= min_results
    result = {
        "test_class": test_class, "model": model, "windowDays": days,
        "nResults": len(hits), "nDecisionGradeResults": n, "minResults": min_results,
        "decision": "TRUST" if trust else "BENCHMARK_YOURSELF",
        "companies": sorted({h.get("company") for h in hits}),
        "suppressedResults": len(hits) - n,
        "passRows": len(pass_hits),
    }
    if hits:
        result["kind"] = kind
        aggregate_hits = decision_hits
        if kind in _BENCH_METADATA_KINDS:
            eras = []
            by_era = {}
            for hit in aggregate_hits:
                suite_sha = hit.get("suite_sha256")
                effort = hit.get("effort")
                if _is_missing_metadata_value(suite_sha) or _is_missing_metadata_value(effort):
                    continue
                by_era.setdefault((suite_sha, effort), []).append(hit)
            for (suite_sha, effort), era_hits in sorted(by_era.items()):
                eras.append({
                    "suite_sha256": suite_sha,
                    "effort": effort,
                    "n": len(era_hits),
                    "latest": max(hit["ts"] for hit in era_hits),
                })
            if eras:
                result["comparisonClass"] = "same_era" if len(eras) == 1 else "cross_era"
                result["comparisonEras"] = eras
                if len(eras) > 1:
                    result["comparisonNote"] = (
                        "Multiple suite/effort eras are pooled here. Treat the aggregate as "
                        "directional unless you isolate one era."
                    )
        if kind == "skill_eval":
            result["aggregate"] = _agg(aggregate_hits, "lift")
            result["aggregate"].update({"verdict_pool": _verdict_pool(aggregate_hits)})
        else:
            result["aggregate"] = _agg(aggregate_hits, "quality")
            qpks = [
                h["metrics"].get("qPer1kOut")
                for h in aggregate_hits
                if h["metrics"].get("qPer1kOut") is not None
            ]
            result["aggregate"]["medianQPer1kOut"] = round(statistics.median(qpks), 4) if qpks else None
        result["latest"] = max(h["ts"] for h in hits)
    if not trust:
        result["action"] = (f"Only {n} decision-grade result(s) in {days}d (need {min_results}). "
                            f"Run the benchmark yourself, trust your output, and record it: "
                            f"`ledger.py record --run <your-run>`.")
    return result


def _agg(hits, metric_key):
    vals = [h["metrics"].get(metric_key) for h in hits if h["metrics"].get(metric_key) is not None]
    if not vals:
        return {"n": len(hits)}
    return {
        "n": len(vals),
        f"median_{metric_key}": round(statistics.median(vals), 4),
        f"mean_{metric_key}": round(statistics.mean(vals), 4),
        f"stdev_{metric_key}": round(statistics.pstdev(vals), 4) if len(vals) > 1 else 0.0,
        f"min_{metric_key}": round(min(vals), 4), f"max_{metric_key}": round(max(vals), 4),
    }


def _verdict_pool(hits):
    v = [(h.get("skill") or {}).get("verdict") for h in hits]
    v = [x for x in v if x]
    if not v:
        return None
    return max(set(v), key=v.count)  # modal verdict


def _parse(ts):
    if not ts:
        return None
    try:
        d = datetime.fromisoformat(ts)
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


# --------------------------------------------------------------------------
# summary / skills
# --------------------------------------------------------------------------

def summary(days=DEFAULT_DAYS, min_results=DEFAULT_MIN_RESULTS):
    cfg = benchlib.load_config()
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    by = {}
    pass_counts = Counter()
    for r in read_all():
        ts = _parse(r.get("ts"))
        if ts is None or ts < cutoff:
            continue
        if r.get("kind") in _BENCH_PASS_KINDS:
            pass_counts[(r.get("test_class"), r.get("model"))] += 1
            continue
        by.setdefault((r.get("test_class"), r.get("model")), []).append(r)
    rows = []
    for (tc, model), hits in sorted(by.items()):
        kind = hits[0].get("kind")
        grade_hits = (
            [hit for hit in hits if _row_is_decision_grade(hit, cfg)]
            if kind in _BENCH_METADATA_KINDS
            else list(hits)
        )
        n = len(grade_hits)
        mkey = "lift" if kind == "skill_eval" else "quality"
        vals = [h["metrics"].get(mkey) for h in grade_hits if h["metrics"].get(mkey) is not None]
        med = round(statistics.median(vals), 3) if vals else None
        rows.append({"test_class": tc, "model": model, "n": n,
                     "raw_n": len(hits), "suppressed": len(hits) - n,
                     "pass_rows": pass_counts.get((tc, model), 0),
                     "decision": "TRUST" if n >= min_results else "self",
                     "metric": mkey, "median": med,
                     "companies": len({h.get("company") for h in hits})})
    return rows


def passes(test_class, model, run_id=None, days=DEFAULT_DAYS):
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    out = []
    for r in read_all():
        if r.get("kind") not in _BENCH_PASS_KINDS:
            continue
        if r.get("test_class") != test_class or r.get("model") != model:
            continue
        if run_id and r.get("run_id") != run_id:
            continue
        ts = _parse(r.get("ts"))
        if ts is None or ts < cutoff:
            continue
        out.append(r)
    return sorted(out, key=lambda r: (r.get("run_id") or "", r.get("task_id") or "", str(r.get("rep") or "")))


def backfill_success_floor(path=LEDGER_PATH, cfg=None):
    cfg = cfg or benchlib.load_config()
    path = Path(path)
    rows = []
    if path.exists():
        with open(path) as f:
            rows = [json.loads(line) for line in f if line.strip()]
    changed = []
    for idx, row in enumerate(rows, start=1):
        if row.get("kind") not in _BENCH_METADATA_KINDS:
            continue
        metrics = row.get("metrics") or {}
        quality = metrics.get("quality")
        success_rate = metrics.get("successRate")
        try:
            success_rate_value = float(success_rate) if success_rate is not None else None
        except (TypeError, ValueError):
            success_rate_value = None
        reason = _success_suppression_reason(success_rate_value, cfg)
        if quality is None or not reason:
            continue
        metrics.setdefault("quality_raw_before_suppression", quality)
        if metrics.get("qPer1kOut") is not None:
            metrics.setdefault("qPer1kOut_raw_before_suppression", metrics.get("qPer1kOut"))
        metrics["quality"] = None
        metrics["qPer1kOut"] = None
        metrics["suppressed_reason"] = reason
        row["metrics"] = metrics
        row["verified"] = False
        row["unverified_reason"] = reason
        row["decision_band"] = "failed"
        row["backfilled_by"] = "TSBC-1432 success-rate floor"
        row.setdefault("reps", 1)
        row.setdefault("reps_inferred", True)
        changed.append({
            "line": idx,
            "run_id": row.get("run_id"),
            "test_class": row.get("test_class"),
            "model": row.get("model"),
            "successRate": success_rate_value,
            "previousQuality": quality,
            "reason": reason,
        })
    backup = None
    if changed:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        backup = path.with_name(f"{path.name}.bak-tsbc-1432-success-floor-{stamp}")
        if path.exists():
            backup.write_bytes(path.read_bytes())
        tmp = path.with_suffix(path.suffix + ".tmp-tsbc-1432")
        with open(tmp, "w") as f:
            for row in rows:
                f.write(json.dumps(row, separators=(",", ":")) + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    return {"changed": len(changed), "rows": changed, "backup": str(backup) if backup else None}


def _load_run_records_for_backfill(run_id, cache):
    if not run_id:
        return [], {}
    if run_id in cache:
        return cache[run_id]
    run_dir = benchlib.RESULTS_DIR / run_id
    runs_path = run_dir / "runs.json"
    if not runs_path.exists():
        cache[run_id] = ([], {})
        return cache[run_id]
    try:
        with open(runs_path) as f:
            records = json.load(f)
    except Exception:
        records = []
    cache[run_id] = (records, _run_meta_for_dir(run_dir))
    return cache[run_id]


def _legacy_served_model_from_row(row):
    if row.get("served_model"):
        return row.get("served_model")
    reported = row.get("model_reported")
    if not reported:
        return UNKNOWN
    if row.get("served_model_verified"):
        return reported
    if reported != row.get("model"):
        return reported
    return UNKNOWN


def _append_unverified_reason(row, reason):
    current = str(row.get("unverified_reason") or "").strip()
    if not current:
        row["unverified_reason"] = reason
    elif reason not in current:
        row["unverified_reason"] = current + "; " + reason


def _backfill_model_eval_row(row, matching_records, run_meta, cfg, roster):
    before = json.dumps(row, sort_keys=True, separators=(",", ":"))
    role = row.get("test_class")
    model_id = row.get("model")
    model_row = roster.get(model_id, {"id": model_id})
    row["record_schema_version"] = 2
    row["requested_model_id"] = model_id or UNKNOWN
    row["task_id"] = row.get("task_id") or "aggregate"
    row["run_started_at"] = row.get("run_started_at") or run_meta.get("started_at") or UNKNOWN
    row["run_finished_at"] = row.get("run_finished_at") or run_meta.get("finished_at") or row.get("ts") or UNKNOWN
    row["suite"] = row.get("suite") or _suite_object(role, row)
    row["suite_sha256"] = row.get("suite_sha256") or row["suite"]["sha256"]

    if matching_records:
        pass_like = [
            _pass_ledger_row(
                record,
                row.get("run_id"),
                row.get("company") or _company(),
                row.get("judge"),
                row["run_started_at"],
                row["run_finished_at"],
                model_row,
            )
            for record in matching_records
        ]
        row["requested_model"] = _one_or_multiple(_field_values(pass_like, ("requested_model",)))
        row["served_model"] = _one_or_multiple(_field_values(pass_like, ("served_model",)), unknown=UNKNOWN)
        row["served_model_verified"] = bool(pass_like) and all(
            bool(record.get("served_model_verified")) and not record.get("served_model_mismatch")
            for record in pass_like
        )
        row["agent_id"] = _one_or_multiple(_field_values(pass_like, ("agent_id",)), unknown=UNKNOWN)
        row["adapter"] = _one_or_multiple(_field_values(pass_like, ("adapter", "adapter_type")), unknown=UNKNOWN)
        row["adapter_type"] = row.get("adapter_type") or row["adapter"]
        row["effort"] = _one_or_multiple(_field_values(pass_like, ("effort",)), unknown=UNKNOWN)
        observed_passes = _record_reps(pass_like) or UNKNOWN
        explicit_reps = [
            record.get("reps")
            for record in matching_records
            if record.get("reps") not in (None, "", UNKNOWN)
        ]
        if explicit_reps:
            row["reps"] = observed_passes
            row.pop("reps_unknown", None)
        else:
            row["reps"] = UNKNOWN
            row["reps_unknown"] = True
            row["observed_passes_per_task"] = observed_passes
        row["sample_count"] = row.get("sample_count") or len([r for r in pass_like if not r.get("skipped")])
        row["pass_records_recovered"] = len(pass_like)
    else:
        row["requested_model"] = row.get("requested_model") or model_row.get("model_arg") or model_id or UNKNOWN
        row["served_model"] = _legacy_served_model_from_row(row)
        row["served_model_verified"] = bool(row.get("served_model_verified"))
        row["agent_id"] = row.get("agent_id") or UNKNOWN
        row["adapter"] = row.get("adapter") or row.get("adapter_type") or model_row.get("adapter") or UNKNOWN
        row["adapter_type"] = row.get("adapter_type") or row["adapter"]
        row["effort"] = row.get("effort") or benchlib.model_effort_label(model_row)
        if row.get("reps_inferred") or row.get("reps") in (None, ""):
            row["reps"] = UNKNOWN
            row["reps_unknown"] = True
        else:
            row["reps"] = row.get("reps")
        row["pass_records_recovered"] = 0

    if model_id == "gemini-pro":
        row["served_model_verified"] = False
        row["served_model_flag"] = "TSBC-1439: gemini-pro pin has historical AGY mislabel risk"
        _append_unverified_reason(row, "served model unverified: gemini-pro pin flagged by TSBC-1439")

    metrics = row.get("metrics") or {}
    success_rate = metrics.get("successRate")
    try:
        success_rate_value = float(success_rate) if success_rate is not None else None
    except (TypeError, ValueError):
        success_rate_value = None
    reason = _success_suppression_reason(success_rate_value, cfg)
    if reason:
        metrics["suppressed_reason"] = reason
        if metrics.get("quality") is not None:
            metrics.setdefault("quality_raw_before_suppression", metrics.get("quality"))
            if metrics.get("qPer1kOut") is not None:
                metrics.setdefault("qPer1kOut_raw_before_suppression", metrics.get("qPer1kOut"))
            metrics["quality"] = None
            metrics["qPer1kOut"] = None
        row["metrics"] = metrics
        row["verified"] = False
        row["decision_band"] = "failed"
        _append_unverified_reason(row, reason)
        row["suppressed_flag"] = "TSBC-1432 success-rate floor"

    if row.get("served_model_verified") is False and not row.get("unverified_reason"):
        row["unverified_reason"] = "served model unverified"

    return json.dumps(row, sort_keys=True, separators=(",", ":")) != before


def backfill_expanded_schema(path=LEDGER_PATH, cfg=None):
    cfg = cfg or benchlib.load_config()
    path = Path(path)
    rows = []
    if path.exists():
        with open(path) as f:
            rows = [json.loads(line) for line in f if line.strip()]
    roster = _catalog_by_model_id()
    existing_pass_ids = {
        row.get("pass_id")
        for row in rows
        if row.get("kind") in _BENCH_PASS_KINDS and row.get("pass_id")
    }
    run_cache = {}
    changed_rows = []
    pass_rows_to_add = []
    for idx, row in enumerate(rows, start=1):
        if (
            row.get("model") == "gemini-pro"
            and row.get("kind") != "model_eval"
            and row.get("kind") not in _BENCH_PASS_KINDS
        ):
            before = json.dumps(row, sort_keys=True, separators=(",", ":"))
            row["record_schema_version"] = 2
            row.setdefault("requested_model", row.get("requested_model_arg") or "gemini-3.1-pro-high")
            served = row.get("served_model") or row.get("served_model_observed")
            row["served_model"] = UNKNOWN if served in (None, "", "unrecorded") else served
            row["served_model_verified"] = False
            row["served_model_flag"] = "TSBC-1439: gemini-pro pin has historical AGY mislabel risk"
            row.setdefault("reps", UNKNOWN)
            _append_unverified_reason(row, "served model unverified: gemini-pro pin flagged by TSBC-1439")
            if json.dumps(row, sort_keys=True, separators=(",", ":")) != before:
                changed_rows.append({
                    "line": idx,
                    "run_id": row.get("run_id"),
                    "test_class": row.get("test_class"),
                    "model": row.get("model"),
                    "kind": row.get("kind"),
                    "pass_records_recovered": 0,
                    "served_model_verified": row.get("served_model_verified"),
                    "reps": row.get("reps"),
                })
        if row.get("kind") != "model_eval":
            continue
        run_records, run_meta = _load_run_records_for_backfill(row.get("run_id"), run_cache)
        matching = [
            record for record in run_records
            if record.get("role") == row.get("test_class")
            and record.get("model_id") == row.get("model")
        ]
        if _backfill_model_eval_row(row, matching, run_meta, cfg, roster):
            changed_rows.append({
                "line": idx,
                "run_id": row.get("run_id"),
                "test_class": row.get("test_class"),
                "model": row.get("model"),
                "pass_records_recovered": row.get("pass_records_recovered", 0),
                "served_model_verified": row.get("served_model_verified"),
                "reps": row.get("reps"),
            })
        for record in matching:
            run_started_at = row.get("run_started_at") or run_meta.get("started_at") or UNKNOWN
            run_finished_at = row.get("run_finished_at") or run_meta.get("finished_at") or row.get("ts") or UNKNOWN
            pass_row = _pass_ledger_row(
                record,
                row.get("run_id"),
                row.get("company") or _company(),
                row.get("judge"),
                run_started_at,
                run_finished_at,
                roster.get(row.get("model"), {}),
            )
            if pass_row["pass_id"] in existing_pass_ids:
                continue
            pass_row["backfilled_by"] = "TSBC-1432 expanded ledger backfill"
            pass_rows_to_add.append(pass_row)
            existing_pass_ids.add(pass_row["pass_id"])
    backup = None
    if changed_rows or pass_rows_to_add:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        backup = path.with_name(f"{path.name}.bak-tsbc-1432-expanded-ledger-{stamp}")
        if path.exists():
            backup.write_bytes(path.read_bytes())
        tmp = path.with_suffix(path.suffix + ".tmp-tsbc-1432-expanded")
        with open(tmp, "w") as f:
            for row in rows + pass_rows_to_add:
                f.write(json.dumps(row, separators=(",", ":")) + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    return {
        "changed": len(changed_rows),
        "pass_rows_added": len(pass_rows_to_add),
        "rows": changed_rows,
        "backup": str(backup) if backup else None,
    }


def skills_index():
    seen = {}
    for r in read_all():
        sk = r.get("skill")
        if not sk:
            continue
        sid = sk.get("id")
        seen.setdefault(sid, {"id": sid, "path": sk.get("path"), "results": 0, "verdicts": []})
        seen[sid]["results"] += 1
        if sk.get("verdict"):
            seen[sid]["verdicts"].append(sk["verdict"])
    return list(seen.values())


# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="shared benchmark ledger (source of truth)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    pr = sub.add_parser("record"); pr.add_argument("--run", required=True)
    pr.add_argument("--company", default=None); pr.add_argument("--kind", choices=["bench", "skill", "variants", "auto"], default="auto")
    pq = sub.add_parser("query"); pq.add_argument("test_class"); pq.add_argument("model")
    pq.add_argument("--days", type=int, default=DEFAULT_DAYS); pq.add_argument("--min", type=int, default=DEFAULT_MIN_RESULTS, dest="min_results")
    pp = sub.add_parser("passes"); pp.add_argument("test_class"); pp.add_argument("model")
    pp.add_argument("--run", default=None, dest="run_id"); pp.add_argument("--days", type=int, default=DEFAULT_DAYS)
    ps = sub.add_parser("summary"); ps.add_argument("--days", type=int, default=DEFAULT_DAYS)
    sub.add_parser("backfill-success-floor")
    sub.add_parser("backfill-expanded-schema")
    sub.add_parser("skills")
    args = ap.parse_args()

    if args.cmd == "record":
        kind = args.kind
        if kind == "auto":
            rd = benchlib.RESULTS_DIR / args.run
            kind = "skill" if (rd / "summary.json").exists() and args.run.startswith("skill-") else "bench"
        if kind == "skill":
            n_appended, n = record_skill_run(args.run, args.company)
        elif kind == "variants":
            n_appended, n = record_variants_run(args.run, args.company)
        else:
            n_appended, n = record_bench_run(args.run, args.company)
        print(f"recorded {n} result(s) from {args.run} into the ledger ({_company() if not args.company else args.company})")

    elif args.cmd == "query":
        res = query(args.test_class, args.model, args.days, args.min_results)
        print(json.dumps(res, indent=2))
        grade_n = res.get("nDecisionGradeResults", res["nResults"])
        print(
            f"\n>>> {res['decision']}: {grade_n}/{res['minResults']} decision-grade results "
            f"in {res['windowDays']}d (raw rows: {res['nResults']})",
            end="",
        )
        if res["decision"] == "TRUST":
            agg = res.get("aggregate", {})
            print(f" — trust pooled result (median {list(agg.items())})")
        else:
            print("")
            print(f"    {res.get('action','')}")

    elif args.cmd == "summary":
        rows = summary(args.days)
        if not rows:
            print("(ledger empty)"); return
        print(f"{'test_class':<22} {'model':<16} {'n':>3} {'raw':>3} {'pass':>4} {'sup':>3} {'cos':>3} {'metric':<8} {'median':>7}  decision")
        print("-" * 94)
        for r in rows:
            print(f"{r['test_class']:<22} {r['model']:<16} {r['n']:>3} {r['raw_n']:>3} "
                  f"{r['pass_rows']:>4} {r['suppressed']:>3} {r['companies']:>3} {r['metric']:<8} "
                  f"{str(r['median']):>7}  {r['decision']}")

    elif args.cmd == "backfill-success-floor":
        res = backfill_success_floor()
        print(json.dumps(res, indent=2))

    elif args.cmd == "backfill-expanded-schema":
        res = backfill_expanded_schema()
        print(json.dumps(res, indent=2))

    elif args.cmd == "passes":
        rows = passes(args.test_class, args.model, run_id=args.run_id, days=args.days)
        print(json.dumps(rows, indent=2))
        print(f"\n>>> {len(rows)} pass row(s)")

    elif args.cmd == "skills":
        for s in skills_index():
            from collections import Counter
            v = Counter(s["verdicts"]).most_common(1)
            print(f"{s['id']:<22} results={s['results']:>3}  verdict={v[0][0] if v else '-':<8}  skill={s['path']}")


if __name__ == "__main__":
    main()
