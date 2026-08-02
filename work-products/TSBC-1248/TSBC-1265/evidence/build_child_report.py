#!/usr/bin/env python3
"""Build TSBC-1265 child report from bench run artifacts."""
from __future__ import annotations

import json
import shutil
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

RUN_ID = "run-20260725-215009"
RUN_DIR = Path(f"/Users/glad0s/paperclip/benchmark/results/{RUN_ID}")
CHILD = Path("/Users/glad0s/paperclip/work-products/TSBC-1248/TSBC-1265")
EV = CHILD / "evidence"
LEDGER = Path("/Users/glad0s/paperclip/benchmark/ledger/results.jsonl")


def mean(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return round(sum(xs) / len(xs), 4) if xs else None


def best_comp(entries):
    if not entries:
        return None
    return sorted(
        entries,
        key=lambda e: (e.get("n_tasks") or 0, e.get("ts") or ""),
        reverse=True,
    )[0]


def rel(a, b):
    if a is None or b is None:
        return "n/a"
    if a > b + 0.01:
        return "beats"
    if a < b - 0.01:
        return "loses"
    return "matches"


def main() -> None:
    EV.mkdir(parents=True, exist_ok=True)
    (CHILD / "runs").mkdir(parents=True, exist_ok=True)
    (EV / "raw").mkdir(parents=True, exist_ok=True)

    dest_run = CHILD / "runs" / RUN_ID
    if dest_run.exists():
        shutil.rmtree(dest_run)
    shutil.copytree(RUN_DIR, dest_run)
    for name in ("report.md", "recommendations.json", "runs.json"):
        shutil.copy2(RUN_DIR / name, EV / name)
    for p in (RUN_DIR / "raw").glob("*.json"):
        shutil.copy2(p, EV / "raw" / p.name)

    runs = json.loads((RUN_DIR / "runs.json").read_text())
    rep = json.loads((RUN_DIR / "recommendations.json").read_text())

    assert all(r.get("agentFileSha256") == "none" for r in runs)
    assert all(r.get("skillsBundleSha256") == "none" for r in runs)
    assert all(r.get("model_id") == "grok-4.5" for r in runs)
    assert all(r.get("adapterType") == "hermes" for r in runs)
    assert all(r.get("ok") for r in runs)

    by_role: dict[str, list] = defaultdict(list)
    for r in runs:
        by_role[r["role"]].append(r)

    role_summary = {}
    for role, rs in sorted(by_role.items()):
        qs = [r.get("quality") for r in rs]
        role_summary[role] = {
            "n_tasks": len(rs),
            "n_ok": sum(1 for r in rs if r.get("ok")),
            "mean_quality": mean(qs),
            "min_quality": round(min(qs), 4) if qs else None,
            "max_quality": round(max(qs), 4) if qs else None,
            "mean_wall_ms": mean([r.get("wallMs") for r in rs]),
            "mean_input_tokens": mean([r.get("inputTokens") for r in rs]),
            "mean_output_tokens": mean([r.get("outputTokens") for r in rs]),
            "suite_sha256": rs[0].get("suiteSha256"),
            "model_reported": sorted({r.get("model_reported") for r in rs}),
            "tasks": [
                {
                    "task_id": r["task_id"],
                    "ok": r["ok"],
                    "quality": r.get("quality"),
                    "judgeScore": r.get("judgeScore"),
                    "deterministicScore": r.get("deterministicScore"),
                    "wallMs": r.get("wallMs"),
                    "inputTokens": r.get("inputTokens"),
                    "outputTokens": r.get("outputTokens"),
                    "model_reported": r.get("model_reported"),
                    "error": r.get("error"),
                }
                for r in sorted(rs, key=lambda x: x["task_id"])
            ],
        }

    ledger_hits = []
    with LEDGER.open() as f:
        for line in f:
            if RUN_ID not in line:
                continue
            row = json.loads(line)
            if row.get("kind") == "model_eval" and row.get("model") == "grok-4.5":
                ledger_hits.append(row)

    comp: dict[tuple[str, str], list] = defaultdict(list)
    with LEDGER.open() as f:
        for line in f:
            try:
                row = json.loads(line)
            except Exception:
                continue
            if row.get("kind") != "model_eval":
                continue
            if row.get("test_class") not in ("ceo", "ops", "content"):
                continue
            if row.get("agent_file_sha256") not in (None, "none"):
                continue
            if row.get("judge") != "claude-opus":
                continue
            if row.get("model") in ("grok-4.3", "grok-4.20", "grok-4.5"):
                m = row.get("metrics") or {}
                comp[(row["test_class"], row["model"])].append(
                    {
                        "ts": row.get("ts"),
                        "quality": m.get("quality"),
                        "n_tasks": row.get("n_tasks"),
                        "run_id": row.get("run_id"),
                        "successRate": m.get("successRate"),
                    }
                )

    comparison = {}
    for role in ("ceo", "ops", "content"):
        comparison[role] = {
            "grok-4.5": role_summary[role]["mean_quality"],
            "grok-4.5_n": role_summary[role]["n_tasks"],
            "grok-4.3": (best_comp(comp[(role, "grok-4.3")]) or {}).get("quality"),
            "grok-4.3_meta": best_comp(comp[(role, "grok-4.3")]),
            "grok-4.20": (best_comp(comp[(role, "grok-4.20")]) or {}).get("quality"),
            "grok-4.20_meta": best_comp(comp[(role, "grok-4.20")]),
        }

    halt = {
        "claude_bench_halt": Path(
            "/Users/glad0s/paperclip/benchmark/.claude-bench-halt"
        ).exists(),
        "tsbc_power": json.loads(
            Path("/Users/glad0s/paperclip/benchmark/.tsbc-power.json").read_text()
        ),
    }
    launch = json.loads((EV / "bench-launch-meta.json").read_text())

    verdict_notes = []
    for role, c in comparison.items():
        g45, g43, g420 = c["grok-4.5"], c["grok-4.3"], c["grok-4.20"]
        verdict_notes.append(
            f"{role}: grok-4.5 q={g45} (n={c['grok-4.5_n']}) "
            f"vs 4.3 q={g43} ({rel(g45, g43)}), "
            f"vs 4.20 q={g420} ({rel(g45, g420)})"
        )

    report = {
        "issue": "TSBC-1265",
        "parent": "TSBC-1248",
        "title": "R1 bare ceo/ops/content — grok-4.5 hermes_local",
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "status": "complete",
        "controls": {
            "model_id": "grok-4.5",
            "model_arg": "grok-4.5",
            "adapter": "hermes",
            "adapterType_requested": "hermes_local",
            "provider_expected": "xai-oauth",
            "judge": "claude-opus",
            "rung": 1,
            "bare": True,
            "agent_file_sha256": "none",
            "skills_bundle_sha256": "none",
            "HERMES_HOME": launch["HERMES_HOME"],
            "HERMES_IGNORE_RULES": "1",
            "hermes_extra_args": ["--ignore-user-config", "--ignore-rules"],
            "samples_policy": "full immutable suite (>=10 tasks/cell)",
            "config_path": str(EV / "config-r1-hermes-grok-4.5.json"),
            "profile_manifest": str(CHILD / "hermes-clean-profile" / "manifest.json"),
        },
        "run": {
            "run_id": RUN_ID,
            "started_at": rep.get("meta", {}).get("started_at"),
            "finished_at": rep.get("meta", {}).get("finished_at"),
            "n_runs": rep.get("meta", {}).get("n_runs"),
            "n_fail": rep.get("meta", {}).get("n_fail"),
            "n_skipped": rep.get("meta", {}).get("n_skipped"),
            "results_dir": str(RUN_DIR),
            "child_copy": str(dest_run),
        },
        "suite_sha256": {role: role_summary[role]["suite_sha256"] for role in role_summary},
        "role_summary": {
            k: {kk: vv for kk, vv in v.items() if kk != "tasks"}
            for k, v in role_summary.items()
        },
        "tasks_by_role": {k: v["tasks"] for k, v in role_summary.items()},
        "ledger_rows": [
            {
                "test_class": r.get("test_class"),
                "model": r.get("model"),
                "model_reported": r.get("model_reported"),
                "adapter_type": r.get("adapter_type"),
                "judge": r.get("judge"),
                "n_tasks": r.get("n_tasks"),
                "metrics": r.get("metrics"),
                "agent_file_sha256": r.get("agent_file_sha256"),
                "skills_bundle_sha256": r.get("skills_bundle_sha256"),
                "suite_sha256": r.get("suite_sha256"),
                "run_id": r.get("run_id"),
                "ts": r.get("ts"),
            }
            for r in ledger_hits
        ],
        "comparison_vs_prior_grok_bare_claude_opus": comparison,
        "verdict_notes": verdict_notes,
        "halt_flags": halt,
        "auth_quota_failures": 0,
        "evidence_paths": {
            "report_md": str(EV / "report.md"),
            "runs_json": str(EV / "runs.json"),
            "recommendations_json": str(EV / "recommendations.json"),
            "raw_dir": str(EV / "raw"),
            "bench_log": str(EV / "bench-ceo-ops-content.log"),
            "child_report_json": str(CHILD / "TSBC-1265-child-report.json"),
            "child_report_md": str(CHILD / "TSBC-1265-child-report.md"),
        },
    }

    (CHILD / "TSBC-1265-child-report.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )

    lines = [
        "# TSBC-1265 child report — R1 bare ceo/ops/content (grok-4.5)",
        "",
        f"- Parent: TSBC-1248",
        f"- Run: `{RUN_ID}`",
        f"- Status: complete — {rep['meta']['n_fail']}/{rep['meta']['n_runs']} failed",
        "- Model: grok-4.5 via hermes_local / xAI OAuth",
        "- Judge: claude-opus",
        "- Bare: agent_file_sha256=none, skills_bundle_sha256=none",
        f"- HERMES_HOME: `{launch['HERMES_HOME']}`",
        "- Flags: HERMES_IGNORE_RULES=1, --ignore-user-config --ignore-rules",
        "",
        "## Role summary",
        "",
        "| role | n_tasks | mean_quality | min | max | mean_wall_ms | suite_sha256 |",
        "|------|---------|--------------|-----|-----|--------------|--------------|",
    ]
    for role, s in role_summary.items():
        lines.append(
            f"| {role} | {s['n_tasks']} | {s['mean_quality']} | {s['min_quality']} | "
            f"{s['max_quality']} | {s['mean_wall_ms']} | `{s['suite_sha256'][:16]}…` |"
        )
    lines += [
        "",
        "## Comparison vs prior bare grok (judge=claude-opus)",
        "",
        "| role | grok-4.5 | grok-4.3 | grok-4.20 | note |",
        "|------|----------|----------|-----------|------|",
    ]
    for role, c in comparison.items():
        note = next(n for n in verdict_notes if n.startswith(role + ":"))
        lines.append(
            f"| {role} | {c['grok-4.5']} | {c['grok-4.3']} | {c['grok-4.20']} | "
            f"{note.split(':', 1)[1].strip()} |"
        )
    lines += ["", "## Ledger rows written"]
    for r in ledger_hits:
        m = r.get("metrics") or {}
        lines.append(
            f"- `{r['test_class']}` n={r['n_tasks']} quality={m.get('quality')} "
            f"successRate={m.get('successRate')} run_id={r['run_id']}"
        )
    raw_n = len(list((EV / "raw").glob("*.json")))
    lines += [
        "",
        "## Evidence",
        f"- Machine report: `{CHILD / 'TSBC-1265-child-report.json'}`",
        f"- Bench report: `{EV / 'report.md'}`",
        f"- Raw cells: `{EV / 'raw'}` ({raw_n} files)",
        f"- Full run copy: `{dest_run}`",
        f"- Bench log: `{EV / 'bench-ceo-ops-content.log'}`",
        "",
        "## Notes",
        "- Full immutable suites used (ceo=11, ops=10, content=11); meets n>=10 samples/cell.",
        "- No Grok 403/quota/auth failures.",
        "- Clean profile seed required models_dev_cache.json in addition to credential plumbing "
        "(credential-only home fails provider init).",
        "- Parent pre-run run-20260725-214141 ops on non-clean proven home is superseded for "
        "decision use by this clean-control run.",
        "- No canonical TSKB delta; process note stays in this child report only.",
        "",
    ]
    (CHILD / "TSBC-1265-child-report.md").write_text("\n".join(lines) + "\n")
    print("ROLES", {k: v["mean_quality"] for k, v in role_summary.items()})
    print("LEDGER", len(ledger_hits), [r["test_class"] for r in ledger_hits])
    print("COMPARISON", json.dumps(comparison, indent=2))
    print("OK")


if __name__ == "__main__":
    main()
