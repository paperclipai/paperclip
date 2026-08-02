#!/usr/bin/env python3
"""Resume probe-20260730-094016: finish 5 missing rep03 samples and write scored bundle."""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

BENCH = Path("/Users/glad0s/paperclip/benchmark")
sys.path.insert(0, str(BENCH))

import benchlib  # noqa: E402
from adapters import run_model  # noqa: E402
from scoring import score_run  # noqa: E402
from variants import build_prompt  # noqa: E402
import tsbc_task_probe as probe  # noqa: E402

SERVED = Path(
    "/Users/glad0s/.paperclip/instances/default/projects/"
    "e212ce50-b524-408c-b3d4-0c6108d8c2e2/f71e8665-3f38-4920-b777-348ec85b9071/_default"
)
COMPANY_WP = Path(
    "/Users/glad0s/.paperclip/instances/default/companies/"
    "e212ce50-b524-408c-b3d4-0c6108d8c2e2/work-products"
)
PAPERCLIP_WP = Path("/Users/glad0s/paperclip/work-products")

RUN_ID = "probe-20260730-094016"
OUT_DIR = benchlib.RESULTS_DIR / RUN_ID
RAW_DIR = OUT_DIR / "raw"
CONFIG = SERVED / "work-products/TSBC-1330/config-grok-4.5-hermes-clean.json"
CANDIDATE = SERVED / "work-products/TSBC-1171/candidates/r2-ambiguous-ownership-clarify.md"
EXPECTED_SHA = "fd189e4b279ac47e366984b2ab9f1b8c1b4782cc2433cd91d77ee3c19da0c7bf"
ROLE = "cv-review"
MODEL_ID = "grok-4.5-hermes-clean"
ALL_TASK_IDS = [
    "cv-title-inflation-gap",
    "cv-unsubstantiated-metrics",
    "cv-role-mismatch",
    "cv-clean-calibration",
    "cv-date-inconsistency",
    "cv-pii-overshare",
    "cv-benign-contract-overlap",
    "cv-explained-career-break",
    "cv-keyword-stuffed-role-mismatch",
    "cv-team-metric-attribution",
]
REPS = 3
LABEL = "TSBC-1527/1536 resume r2 ambiguous-ownership-clarify"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def mirror_tree(src: Path, dests: list[Path]) -> None:
    for dest in dests:
        dest.mkdir(parents=True, exist_ok=True)
        for item in src.iterdir():
            target = dest / item.name
            if item.is_dir():
                if target.exists():
                    shutil.rmtree(target)
                shutil.copytree(item, target)
            else:
                shutil.copy2(item, target)


def main() -> int:
    actual = sha256_file(CANDIDATE)
    if actual != EXPECTED_SHA:
        print(f"Candidate sha mismatch: expected {EXPECTED_SHA} got {actual}", file=sys.stderr)
        return 2

    cfg = benchlib.load_config(str(CONFIG))
    models = probe.resolve_models(cfg, MODEL_ID)
    model = models[0]
    tasks = {t["id"]: t for t in probe.select_tasks(ROLE, ",".join(ALL_TASK_IDS))}
    suite_info = probe.suite_meta(ROLE)
    af_body, skills_body, source_meta = probe.prompt_parts(
        ROLE,
        "current",
        "none",
        current_agent_file_path=str(CANDIDATE),
        skills_dir_path=None,
    )
    adapters_cfg = cfg["adapters"]
    timeout = cfg["run"]["timeout_sec"]
    frame = probe.generation_method(ROLE, model, "current", "none")

    RAW_DIR.mkdir(parents=True, exist_ok=True)

    missing = []
    for rep in range(1, REPS + 1):
        sample_id = f"rep{rep:02d}"
        for tid in ALL_TASK_IDS:
            path = RAW_DIR / f"{ROLE}__{tid}__{MODEL_ID}__{sample_id}.json"
            if not path.exists():
                missing.append((rep, sample_id, tid))

    print(f"=== Resume {RUN_ID} ===", flush=True)
    print(f"candidate sha256={actual}", flush=True)
    print(f"existing raws={len(list(RAW_DIR.glob('*.json')))}", flush=True)
    print(f"missing={len(missing)}: {[m[2]+'/'+m[1] for m in missing]}", flush=True)
    print(f"HERMES_HOME={__import__('os').environ.get('HERMES_HOME')}", flush=True)
    print(f"TMPDIR={__import__('os').environ.get('TMPDIR')}", flush=True)

    t0 = time.time()
    for i, (rep, sample_id, tid) in enumerate(missing, 1):
        task = tasks[tid]
        print(f"[{i}/{len(missing)}] generating {tid} {sample_id} ...", flush=True)
        try:
            prompt = build_prompt(af_body, skills_body, task["prompt"])
            raw = run_model(prompt, model, adapters_cfg, timeout)
            scored = score_run(task, raw, cfg, adapters_cfg, timeout)
            staged_skills = []
        except Exception as e:
            raw = benchlib.empty_result()
            raw["error"] = f"harness exception: {e}"
            prompt = ""
            staged_skills = []
            scored = {
                "deterministicScore": None,
                "deterministicDetails": [],
                "judgeScore": None,
                "judgeDetail": None,
                "quality": None,
                "qualityPer1kTokens": None,
            }
        rec = {
            "sample_id": sample_id,
            "rep": rep,
            "role": ROLE,
            "task_id": task["id"],
            "task_title": task.get("title"),
            "model": model["id"],
            "lane": model["lane"],
            "adapterType": model["adapter"],
            "effort": benchlib.model_effort_label(model),
            "agentFile": "current",
            "skills": "none",
            "judge": cfg["judge"].get("id"),
            "generationFrame": frame,
            "ok": raw.get("ok"),
            "error": raw.get("error"),
            "output": raw.get("output"),
            "model_reported": raw.get("model"),
            "inputTokens": raw.get("inputTokens"),
            "outputTokens": raw.get("outputTokens"),
            "totalTokens": raw.get("totalTokens"),
            "tokensEstimated": raw.get("tokensEstimated"),
            "costUsd": raw.get("costUsd"),
            "agentFileSha256": source_meta["agentFileSha256"],
            "skillsBundleSha256": source_meta["skillsBundleSha256"],
            "suiteSha256": suite_info["suiteSha256"],
            "wallMs": raw.get("wallMs"),
            "stderrTail": raw.get("stderrTail"),
            "promptChars": len(prompt),
            "stagedSkills": len(staged_skills),
        }
        rec.update(scored)
        raw_path = RAW_DIR / f"{ROLE}__{task['id']}__{model['id']}__{sample_id}.json"
        raw_path.write_text(json.dumps(rec, indent=2))
        q = rec.get("quality")
        qtxt = f"{q:.3f}" if isinstance(q, (int, float)) else "—"
        print(
            f"  ok={bool(rec.get('ok'))} q={qtxt} out={rec.get('outputTokens')} path={raw_path.name}",
            flush=True,
        )

    # Load all raws in deterministic order
    records = []
    for rep in range(1, REPS + 1):
        sample_id = f"rep{rep:02d}"
        for tid in ALL_TASK_IDS:
            path = RAW_DIR / f"{ROLE}__{tid}__{MODEL_ID}__{sample_id}.json"
            if not path.exists():
                print(f"ERROR still missing {path}", file=sys.stderr)
                return 3
            records.append(json.loads(path.read_text()))

    if len(records) != REPS * len(ALL_TASK_IDS):
        print(f"ERROR expected {REPS * len(ALL_TASK_IDS)} records, got {len(records)}", file=sys.stderr)
        return 3

    per_task = probe.aggregate(records)
    overall = probe.overall_summary(per_task)

    meta = {
        "run_id": RUN_ID,
        "label": LABEL,
        "role": ROLE,
        "taskIds": ALL_TASK_IDS,
        "models": [MODEL_ID],
        "reps": REPS,
        "agentFile": "current",
        "skills": "none",
        "judge": cfg["judge"].get("id"),
        "effortOverride": "cli_default",
        "probeFramePolicy": "auto_agentic_antigravity_non_bare_for_book-content-cv",
        "plannedGenerationMethods": {MODEL_ID: frame},
        "startedAt": "2026-07-30T08:40:16+00:00",  # original probe start from log
        "workers": 1,
        **source_meta,
        **suite_info,
        "resumedAt": now_iso(),
        "resumeIssue": "TSBC-1536",
        "resumeNote": "Completed 5 missing rep03 samples after prior partial stop at 25/30",
        "finishedAt": now_iso(),
        "elapsedSec": round(time.time() - t0, 1),
        "elapsedSecNote": "elapsedSec is resume segment only; original partial wall ~9m before stop",
    }
    meta["probeContextSha256"] = probe.sha256_text(
        json.dumps(
            {
                "role": ROLE,
                "taskIds": ALL_TASK_IDS,
                "agentFile": "current",
                "skills": "none",
                "agentFileSha256": meta["agentFileSha256"],
                "skillsBundleSha256": meta["skillsBundleSha256"],
                "suiteSha256": meta["suiteSha256"],
            },
            sort_keys=True,
        )
    )
    meta["promptPacketSha256"] = probe.sha256_text(
        json.dumps(
            {
                "role": ROLE,
                "taskIds": ALL_TASK_IDS,
                "models": [MODEL_ID],
                "modelEfforts": {MODEL_ID: benchlib.model_effort_label(model)},
                "plannedGenerationMethods": meta["plannedGenerationMethods"],
                "agentFile": "current",
                "skills": "none",
                "agentFileSha256": meta["agentFileSha256"],
                "skillsBundleSha256": meta["skillsBundleSha256"],
                "suiteSha256": meta["suiteSha256"],
            },
            sort_keys=True,
        )
    )

    (OUT_DIR / "records.json").write_text(json.dumps(records, indent=2))
    (OUT_DIR / "per_task.json").write_text(json.dumps(per_task, indent=2))
    (OUT_DIR / "summary.json").write_text(json.dumps({"meta": meta, "overall": overall}, indent=2))
    probe.write_report(OUT_DIR, meta, per_task, overall)
    try:
        n_ledger = probe.append_probe_rows(meta, per_task)
        print(f"ledger rows appended: {n_ledger}", flush=True)
    except Exception as e:
        print(f"ledger append skipped/failed: {e}", flush=True)

    # Mirror scored bundle into evidence roots
    dests = [
        SERVED / "work-products/TSBC-1171/runs/r2-ambiguous-ownership-clarify" / RUN_ID,
        PAPERCLIP_WP / "TSBC-1171/runs/r2-ambiguous-ownership-clarify" / RUN_ID,
        COMPANY_WP / "TSBC-1171/runs/r2-ambiguous-ownership-clarify" / RUN_ID,
        SERVED / "work-products/TSBC-1536" / RUN_ID,
        PAPERCLIP_WP / "TSBC-1536" / RUN_ID,
        COMPANY_WP / "TSBC-1536" / RUN_ID,
    ]
    mirror_tree(OUT_DIR, dests)

    # Compact outcome
    outcome = {
        "issue": "TSBC-1536",
        "parentIssue": "TSBC-1527",
        "run_id": RUN_ID,
        "ok": overall[0]["okCount"] if overall else 0,
        "samples": overall[0]["samples"] if overall else 0,
        "meanQuality": overall[0]["meanQuality"] if overall else None,
        "minQuality": overall[0]["minQuality"] if overall else None,
        "meanOutputTokens": overall[0]["meanOutputTokens"] if overall else None,
        "meanInputTokens": overall[0]["meanInputTokens"] if overall else None,
        "candidateSha256": actual,
        "suiteSha256": meta["suiteSha256"],
        "agentFileSha256": meta["agentFileSha256"],
        "probePath": str(OUT_DIR),
        "evidencePaths": [str(d) for d in dests],
        "finishedAt": meta["finishedAt"],
        "overall": overall,
        "per_task": per_task,
    }
    for p in [
        SERVED / "work-products/TSBC-1536/outcome.json",
        PAPERCLIP_WP / "TSBC-1536/outcome.json",
        COMPANY_WP / "TSBC-1536/outcome.json",
        SERVED / "work-products/TSBC-1171/runs/r2-ambiguous-ownership-clarify/outcome.json",
        PAPERCLIP_WP / "TSBC-1171/runs/r2-ambiguous-ownership-clarify/outcome.json",
        COMPANY_WP / "TSBC-1171/runs/r2-ambiguous-ownership-clarify/outcome.json",
    ]:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(outcome, indent=2))

    print("=" * 60, flush=True)
    for row in overall:
        print(
            f"{row['model']} ({row['effort']}): meanQ={row['meanQuality']:.3f} "
            f"minQ={row['minQuality']:.3f} ok={row['okCount']}/{row['samples']} "
            f"meanOut={row['meanOutputTokens']:.1f}",
            flush=True,
        )
    print(f"wrote {OUT_DIR}/report.md", flush=True)
    print(f"mirrored to {len(dests)} evidence roots", flush=True)
    print("RESUME_OK", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
