#!/usr/bin/env python3
"""
tsbc_task_probe.py — bounded repeated probes for a specific role/task subset.

Use this when TSBC needs decision-grade evidence on a weak task cluster without
running a whole role sweep or mutating the benchmark suites.
"""

import argparse
import hashlib
import json
import shutil
import statistics
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import benchlib
import ledger
from adapters import run_antigravity_agentic, run_model
from scoring import score_run
from variants import PREFIX_INSTR, build_prompt, load_skill_bundle, resolve_role


def now_run_id():
    return "probe-" + datetime.now().strftime("%Y%m%d-%H%M%S")


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def resolve_models(cfg, only):
    roster = {m["id"]: m for m in (cfg.get("models", []) + cfg.get("models_catalog", []))}
    want = [x.strip() for x in only.split(",") if x.strip()]
    missing = [w for w in want if w not in roster]
    if missing:
        raise SystemExit(f"unknown model id(s): {', '.join(missing)}")
    models = [roster[w] for w in want]
    models, held = benchlib.filter_models_for_active_holds(models, cfg)
    if held:
        print(benchlib.format_model_hold_skip(held), flush=True)
    if not models:
        raise SystemExit("no probe models remain after active TSBC model holds")
    return models


def resolve_judge(cfg, judge_id):
    if not judge_id:
        return cfg["judge"]
    roster = {m["id"]: m for m in (cfg.get("models", []) + cfg.get("models_catalog", []))}
    row = roster.get(judge_id)
    if not row:
        raise SystemExit(f"unknown judge model id: {judge_id}")
    hold = benchlib.first_active_model_hold(row)
    if hold:
        raise SystemExit(
            "judge model is under active hold: "
            + benchlib.format_model_hold_skip([(row, hold)])
        )
    return {"id": row["id"], "adapter": row["adapter"], "model_arg": row.get("model_arg")}


def apply_effort_override(models, effort):
    if not effort:
        return models
    supported = {"claude", "codex", "hermes"}
    unsupported = sorted(m["id"] for m in models if m.get("adapter") not in supported)
    if unsupported:
        raise SystemExit(
            "--effort only supports claude/codex/hermes adapters; unsupported models: "
            + ", ".join(unsupported)
        )
    patched = []
    for model in models:
        row = dict(model)
        if row["adapter"] == "claude":
            row["effort"] = effort
        else:
            row["reasoning_effort"] = effort
        patched.append(row)
    return patched


def select_tasks(role, task_ids):
    suite = benchlib.load_suite(role)
    want = [x.strip() for x in task_ids.split(",") if x.strip()]
    tasks = {t["id"]: t for t in suite.get("tasks", [])}
    missing = [tid for tid in want if tid not in tasks]
    if missing:
        raise SystemExit(f"unknown task id(s) for {role}: {', '.join(missing)}")
    return [tasks[tid] for tid in want]


def power_workers(default=1):
    try:
        data = json.load(open(benchlib.ROOT / ".tsbc-power.json"))
    except Exception:
        return default
    if data.get("paused"):
        raise SystemExit("TSBC SLEEP (paused) — not running.")
    cap = data.get("maxWorkers")
    return min(default, cap) if cap is not None else default


def sha256_text(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def suite_meta(role):
    suite_path = benchlib.ROOT / role / "suite.json"
    return {
        "suiteSourcePath": str(suite_path),
        "suiteSha256": benchlib.file_sha256(suite_path),
    }


AGY_PRINT_TIMEOUT = "4m0s"
AGENTIC_ROUTE_ROLES = {"book-chapter", "content", "cv-review"}


def generation_method(role, model_row, agent_file, skills):
    if (
        model_row.get("adapter") == "antigravity"
        and role in AGENTIC_ROUTE_ROLES
        and not (agent_file == "bare" and skills == "none")
    ):
        return "agentic_file_mount"
    return "single_shot_concat"


def planned_generation_methods(role, models, agent_file, skills):
    return {
        model["id"]: generation_method(role, model, agent_file, skills)
        for model in models
    }


def stage_skills(cwd, skills_dir):
    staged = []
    if not skills_dir:
        return staged
    root = Path(cwd) / ".paperclip" / "skills"
    root.mkdir(parents=True, exist_ok=True)
    for skill_dir in sorted(Path(skills_dir).iterdir()):
        if not (skill_dir / "SKILL.md").exists():
            continue
        shutil.copytree(skill_dir, root / skill_dir.name, dirs_exist_ok=True)
        staged.append(skill_dir.name)
    return staged


def build_agentic_prompt(agent_body, staged_names, task_prompt):
    blocks = []
    if agent_body.strip():
        blocks.append(
            f"--- BEGIN AGENT OPERATING FILE ---\n{agent_body.strip()}\n--- END AGENT OPERATING FILE ---"
        )
    if staged_names:
        blocks.append(
            "Paperclip runtime skills are available as files in "
            f"`./.paperclip/skills/` ({len(staged_names)} skills: {', '.join(staged_names)}). "
            "Read and apply only the skill instructions that match the task."
        )
    if not blocks:
        return task_prompt
    return "\n\n".join(blocks) + f"\n\n{PREFIX_INSTR}\n\n=== TASK ===\n{task_prompt}"


def prompt_parts(role, agent_file, skills, current_agent_file_path=None, skills_dir_path=None):
    rc = json.load(open(benchlib.ROOT / "variants.json"))["roles"].get(role)
    source_meta = {
        "agentFileSourcePath": None,
        "skillsSourcePath": None,
        "agentFileSourceKind": "none",
        "skillsSourceKind": "none",
    }
    af_bodies = {"bare": "", "minimal": "", "current": ""}
    skill_bodies = {"none": "", "all": ""}
    if rc:
        af_bodies, skill_bodies = resolve_role(role, rc)
        source_meta.update({
            "agentFileSourcePath": rc.get("currentAgentFile"),
            "skillsSourcePath": rc.get("skillsDir"),
            "agentFileSourceKind": "variants_json",
            "skillsSourceKind": "variants_json",
        })
    if current_agent_file_path:
        af_bodies["current"] = Path(current_agent_file_path).read_text()
        source_meta["agentFileSourcePath"] = current_agent_file_path
        source_meta["agentFileSourceKind"] = "override"
    if skills_dir_path:
        skill_bodies["all"] = load_skill_bundle(skills_dir_path)
        source_meta["skillsSourcePath"] = skills_dir_path
        source_meta["skillsSourceKind"] = "override"
    if not rc and agent_file in {"minimal", "current"} and not current_agent_file_path:
        raise SystemExit(f"role {role!r} has no variants.json entry; use --agent-file bare or pass --current-agent-file-path")
    if not rc and skills == "all" and not skills_dir_path:
        raise SystemExit(f"role {role!r} has no variants.json entry; use --skills none or pass --skills-dir-path")
    if agent_file not in af_bodies:
        raise SystemExit(f"unknown agent-file mode {agent_file!r}")
    if skills not in skill_bodies:
        raise SystemExit(f"unknown skills mode {skills!r}")
    agent_body = af_bodies[agent_file]
    skills_body = skill_bodies[skills]
    source_meta.update({
        "agentFileSha256": sha256_text(agent_body) if agent_body else "none",
        "skillsBundleSha256": sha256_text(skills_body) if skills_body else "none",
    })
    return agent_body, skills_body, source_meta


def qpk(quality, output_tokens):
    if quality is None or not output_tokens:
        return None
    return quality / (output_tokens / 1000.0)


def mean(xs):
    vals = [x for x in xs if x is not None]
    return statistics.mean(vals) if vals else None


def median(xs):
    vals = [x for x in xs if x is not None]
    return statistics.median(vals) if vals else None


def aggregate(records):
    by = {}
    for r in records:
        by.setdefault((r["model"], r.get("effort"), r["task_id"]), []).append(r)
    rows = []
    for (model, effort, task_id), rs in sorted(by.items()):
        qualities = [r.get("quality") for r in rs if r.get("quality") is not None]
        outputs = [r.get("outputTokens") for r in rs if r.get("outputTokens") is not None]
        inputs = [r.get("inputTokens") for r in rs if r.get("inputTokens") is not None]
        row = {
            "model": model,
            "effort": effort or "cli_default",
            "task_id": task_id,
            "adapterType": rs[0].get("adapterType"),
            "generationFrame": ",".join(sorted({r.get("generationFrame", "single_shot_concat") for r in rs})),
            "reportedModels": sorted({r.get("model_reported") for r in rs if r.get("model_reported")}),
            "samples": len(rs),
            "okCount": sum(1 for r in rs if r.get("ok")),
            "meanQuality": mean(qualities),
            "minQuality": min(qualities) if qualities else None,
            "medianOutputTokens": median(outputs),
            "meanOutputTokens": mean(outputs),
            "meanInputTokens": mean(inputs),
            "meanQPer1kOut": mean([qpk(r.get("quality"), r.get("outputTokens")) for r in rs]),
            "runIds": [r["sample_id"] for r in rs],
        }
        rows.append(row)
    return rows


def overall_summary(rows):
    by = {}
    for row in rows:
        by.setdefault((row["model"], row.get("effort")), []).append(row)
    out = []
    for (model, effort), rs in sorted(by.items()):
        out.append({
            "model": model,
            "effort": effort or "cli_default",
            "generationFrame": ",".join(sorted({r.get("generationFrame", "single_shot_concat") for r in rs})),
            "tasks": len(rs),
            "samples": sum(r["samples"] for r in rs),
            "okCount": sum(r["okCount"] for r in rs),
            "meanQuality": mean([r["meanQuality"] for r in rs]),
            "minQuality": min(r["minQuality"] for r in rs if r["minQuality"] is not None),
            "medianOutputTokens": median([r["medianOutputTokens"] for r in rs]),
            "meanOutputTokens": mean([r["meanOutputTokens"] for r in rs]),
            "meanInputTokens": mean([r["meanInputTokens"] for r in rs]),
            "meanQPer1kOut": mean([r["meanQPer1kOut"] for r in rs]),
        })
    return out


def write_report(out_dir, meta, per_task, overall):
    records_paths = (
        f"`{out_dir / 'report.md'}`, `{out_dir / 'records.json'}`, `{out_dir / 'summary.json'}`"
    )
    environment = (
        f"`TSBC task-probe harness; role={meta['role']}; cell={meta['agentFile']}+{meta['skills']}; "
        f"finished={meta.get('finishedAt', 'unknown')}`"
    )
    lines = [
        f"# TSBC Task Probe — `{meta['run_id']}`",
        "",
        f"- Role: `{meta['role']}`",
        f"- Cell: `{meta['agentFile']} + {meta['skills']}`",
        f"- Tasks: `{', '.join(meta['taskIds'])}`",
        f"- Models: `{', '.join(meta['models'])}`",
        f"- Reps: `{meta['reps']}`",
        f"- Judge: `{meta['judge']}`",
        f"- Effort override: `{meta['effortOverride']}`",
        f"- Probe frame policy: `{meta['probeFramePolicy']}`",
        "- Planned generation methods: "
        + ", ".join(
            f"`{model}={frame}`"
            for model, frame in sorted((meta.get("plannedGenerationMethods") or {}).items())
        ),
        f"- Agent-file source: `{meta['agentFileSourcePath'] or 'none'}` ({meta['agentFileSourceKind']})",
        f"- Skills source: `{meta['skillsSourcePath'] or 'none'}` ({meta['skillsSourceKind']})",
        f"- Suite source: `{meta['suiteSourcePath']}`",
        f"- Agent-file sha256: `{meta['agentFileSha256']}`",
        f"- Skills bundle sha256: `{meta['skillsBundleSha256']}`",
        f"- Suite sha256: `{meta['suiteSha256']}`",
        f"- Probe context sha256: `{meta['probeContextSha256']}`",
        f"- Prompt packet sha256: `{meta['promptPacketSha256']}`",
        "",
        "## Overall",
        "",
        "| model | frame | effort | tasks | samples | ok | meanQ | minQ | meanOut | meanIn | q/1k-out |",
        "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in overall:
        lines.append(
            "| {model} | {generationFrame} | {effort} | {tasks} | {samples} | {okCount} | {meanQuality:.3f} | {minQuality:.3f} | "
            "{meanOutputTokens:.1f} | {meanInputTokens:.1f} | {meanQPer1kOut:.3f} |".format(**row)
        )
    lines.extend([
        "",
        "## Per Task",
        "",
        "| model | frame | effort | task | samples | ok | meanQ | minQ | meanOut | meanIn | q/1k-out |",
        "|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ])
    for row in per_task:
        lines.append(
            "| {model} | {generationFrame} | {effort} | {task_id} | {samples} | {okCount} | {meanQuality:.3f} | {minQuality:.3f} | "
            "{meanOutputTokens:.1f} | {meanInputTokens:.1f} | {meanQPer1kOut:.3f} |".format(**row)
        )
    lines.extend([
        "",
        "## TSBC Fairness Closeout (required before recommendation)",
        "",
        f"- Run IDs: `{meta['run_id']}`",
        "- Issue-close PDF artifact: attach `TSBC-<issue>-report.pdf` before closing any TSBC test issue",
        "- PDF contents: hypothesis, method, data, verdict `CONFIRMED` / `REFUTED` / `INCONCLUSIVE`, dispatched follow-up key",
        f"- Repetitions per compared cell: `{meta['reps']}`",
        f"- Scorer lane: `{meta['judge']}`",
        "- Scorer calibration status: `pass` / `pass_with_caveat` / `needs_calibration` / `failed`",
        "- Calibration set: record the known-good / known-bad / borderline anchors, or `not_preserved:<why missing>`.",
        "- Tie-break owner: name the human or agent adjudicator, or `not_preserved:<why missing>`.",
        "- Fairness verdict: `pass` / `pass_with_caveat` / `fail`",
        "- Evidence depth: `directional` / `candidate` / `decision_grade` / `production_locked`",
        "- Low-tail / min-score note: cite the relevant `minQ` values from the tables above and explain any task-level collapse.",
        "- Token / cost / runtime note or caveat: summarize the token movement shown above and record runtime/cost or an explicit caveat if missing.",
        "- Scorer caveat: record scorer separation/calibration status and whether human review is still required.",
        "- Fingerprint: use `<opco-or-portfolio>:<task-surface>:<lane>:<suite-or-run-id>:<date>`, or `not_preserved:<why missing>`.",
        f"- Model version(s): `{', '.join(meta['models'])}`",
        "- Scorer/rubric version: record the exact rubric + judge version, or `not_preserved:<why missing>`.",
        f"- Environment: {environment}",
        f"- Records path: {records_paths}",
        f"- Suite hash: `{meta['suiteSha256']}` (`{meta['suiteSourcePath']}`)",
        f"- Prompt/system hash: `{meta['promptPacketSha256']}` (agent `{meta['agentFileSha256']}`, skills `{meta['skillsBundleSha256']}`)",
        "- Failure-library IDs: list created/referenced IDs, or `none` with why that absence is meaningful.",
        "- Any `not_preserved:*` field must explain why the artifact is missing; blank fields are not acceptable.",
        "- Next gate: `catalog_only` / `create_candidate_pack` / `run_opco_live_proof` / `adopt` / `reject` / `rerun` / `supersede`",
        "",
        "> This probe report is evidence, not a finished TSBC closeout. Fill the checklist above in the issue or polished report, render the branded PDF artifact, and attach `TSBC-<issue>-report.pdf` before updating catalog rows or adoption recommendations.",
    ])
    (out_dir / "report.md").write_text("\n".join(lines) + "\n")


def append_probe_rows(meta, per_task):
    ts = now_iso()
    records = []
    for row in per_task:
        reported_models = row.get("reportedModels") or []
        records.append({
            "ts": ts,
            "company": ledger._company(),
            "kind": "task_probe",
            "test_class": (
                f"probe:{meta['role']}:{row['task_id']}:{meta['agentFile']}-{meta['skills']}:"
                f"{row['effort']}:{meta['probeContextSha256'][:12]}"
            ),
            "model": row["model"],
            "model_reported": reported_models[0] if len(reported_models) == 1 else None,
            "reported_models": reported_models,
            "model_class": ledger._model_class(row["model"]),
            "adapter_type": row.get("adapterType"),
            "effort": row.get("effort"),
            "agent_file_sha256": meta["agentFileSha256"],
            "skills_bundle_sha256": meta["skillsBundleSha256"],
            "suite_sha256": meta["suiteSha256"],
            "metrics": {
                "quality": ledger._r(row["meanQuality"]),
                "qPer1kOut": ledger._r(row["meanQPer1kOut"]),
                "minQuality": ledger._r(row["minQuality"]),
                "meanOutputTokens": ledger._r(row["meanOutputTokens"], 0),
                "meanInputTokens": ledger._r(row["meanInputTokens"], 0),
                "okRate": ledger._r((row["okCount"] / row["samples"]) if row["samples"] else 0.0),
            },
            "n_tasks": row["samples"],
            "run_id": meta["run_id"],
            "judge": meta["judge"],
            "variant": {"role": meta["role"], "agentFile": meta["agentFile"], "skills": meta["skills"]},
            "probe": {
                "taskIds": meta["taskIds"],
                "reps": meta["reps"],
                "suiteSourcePath": meta["suiteSourcePath"],
                "probeContextSha256": meta["probeContextSha256"],
                "generationFrame": row.get("generationFrame"),
            },
            "skill": None,
            "source": "tsbc_task_probe.py",
        })
    ledger.append_records(records)
    return len(records)


def main():
    ap = argparse.ArgumentParser(description="TSBC bounded task-cluster probe")
    ap.add_argument("--config", default=None)
    ap.add_argument("--role", required=True)
    ap.add_argument("--task-ids", required=True, help="comma list")
    ap.add_argument("--models", required=True, help="comma list")
    ap.add_argument("--reps", type=int, default=5)
    ap.add_argument("--agent-file", choices=["bare", "minimal", "current"], default="minimal")
    ap.add_argument("--skills", choices=["none", "all"], default="none")
    ap.add_argument("--current-agent-file-path", default=None,
                    help="override variants.json currentAgentFile with an explicit path")
    ap.add_argument("--skills-dir-path", default=None,
                    help="override variants.json skillsDir with an explicit runtime skills directory")
    ap.add_argument("--effort", default=None,
                    help="override reasoning effort for every selected model (claude/codex/hermes)")
    ap.add_argument("--judge-model", default=None, help="override config judge by model id")
    ap.add_argument("--label", default=None, help="freeform report label")
    args = ap.parse_args()

    cfg = benchlib.load_config(args.config)
    cfg["judge"] = resolve_judge(cfg, args.judge_model)
    models = apply_effort_override(resolve_models(cfg, args.models), args.effort)
    tasks = select_tasks(args.role, args.task_ids)
    suite_info = suite_meta(args.role)
    af_body, skills_body, source_meta = prompt_parts(
        args.role,
        args.agent_file,
        args.skills,
        current_agent_file_path=args.current_agent_file_path,
        skills_dir_path=args.skills_dir_path,
    )

    workers = power_workers(default=1)
    run_id = now_run_id()
    out_dir = benchlib.RESULTS_DIR / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    raw_dir = out_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    meta = {
        "run_id": run_id,
        "label": args.label,
        "role": args.role,
        "taskIds": [t["id"] for t in tasks],
        "models": [m["id"] for m in models],
        "reps": args.reps,
        "agentFile": args.agent_file,
        "skills": args.skills,
        "judge": cfg["judge"].get("id"),
        "effortOverride": args.effort or "cli_default",
        "probeFramePolicy": "auto_agentic_antigravity_non_bare_for_book-content-cv",
        "plannedGenerationMethods": planned_generation_methods(args.role, models, args.agent_file, args.skills),
        "startedAt": now_iso(),
        "workers": workers,
        **source_meta,
        **suite_info,
    }
    meta["probeContextSha256"] = sha256_text(json.dumps({
        "role": args.role,
        "taskIds": meta["taskIds"],
        "agentFile": args.agent_file,
        "skills": args.skills,
        "agentFileSha256": meta["agentFileSha256"],
        "skillsBundleSha256": meta["skillsBundleSha256"],
        "suiteSha256": meta["suiteSha256"],
    }, sort_keys=True))
    meta["promptPacketSha256"] = sha256_text(json.dumps({
        "role": args.role,
        "taskIds": meta["taskIds"],
        "models": meta["models"],
        "modelEfforts": {m["id"]: benchlib.model_effort_label(m) for m in models},
        "plannedGenerationMethods": meta["plannedGenerationMethods"],
        "agentFile": args.agent_file,
        "skills": args.skills,
        "agentFileSha256": meta["agentFileSha256"],
        "skillsBundleSha256": meta["skillsBundleSha256"],
        "suiteSha256": meta["suiteSha256"],
    }, sort_keys=True))
    print(f"=== TSBC Task Probe · {run_id} ===", flush=True)
    print(f"role   : {args.role}", flush=True)
    print(f"tasks  : {', '.join(meta['taskIds'])}", flush=True)
    print(f"models : {', '.join(meta['models'])}", flush=True)
    print(f"cell   : {args.agent_file}+{args.skills}", flush=True)
    print(f"effort : {meta['effortOverride']}", flush=True)
    print(
        "frames : " + ", ".join(
            f"{model}={frame}" for model, frame in sorted(meta["plannedGenerationMethods"].items())
        ),
        flush=True,
    )
    print(f"agent  : {meta['agentFileSourcePath'] or 'none'}", flush=True)
    print(f"skills : {meta['skillsSourcePath'] or 'none'}", flush=True)
    print(f"suite  : {meta['suiteSourcePath']}", flush=True)
    print(f"judge  : {meta['judge']}", flush=True)
    print(f"reps   : {args.reps}", flush=True)
    print(f"power  : {workers} worker(s)", flush=True)
    print("", flush=True)

    adapters_cfg = cfg["adapters"]
    timeout = cfg["run"]["timeout_sec"]
    records = []
    total = args.reps * len(tasks) * len(models)
    idx = 0
    t0 = time.time()

    for rep in range(1, args.reps + 1):
        for task in tasks:
            for model in models:
                idx += 1
                sample_id = f"rep{rep:02d}"
                frame = generation_method(args.role, model, args.agent_file, args.skills)
                try:
                    if frame == "agentic_file_mount":
                        with tempfile.TemporaryDirectory(prefix=f"probe-agy-{args.role}-") as cwd:
                            staged_skills = stage_skills(
                                cwd,
                                meta["skillsSourcePath"] if args.skills == "all" else None,
                            )
                            prompt = build_agentic_prompt(af_body, staged_skills, task["prompt"])
                            raw = run_antigravity_agentic(
                                prompt,
                                model.get("model_arg"),
                                ["--print-timeout", AGY_PRINT_TIMEOUT],
                                timeout,
                                cwd,
                            )
                    else:
                        staged_skills = []
                        prompt = build_prompt(af_body, skills_body, task["prompt"])
                        raw = run_model(prompt, model, adapters_cfg, timeout)
                    scored = score_run(task, raw, cfg, adapters_cfg, timeout)
                except Exception as e:
                    raw = benchlib.empty_result()
                    raw["error"] = f"harness exception: {e}"
                    staged_skills = []
                    prompt = ""
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
                    "role": args.role,
                    "task_id": task["id"],
                    "task_title": task.get("title"),
                    "model": model["id"],
                    "lane": model["lane"],
                    "adapterType": model["adapter"],
                    "effort": benchlib.model_effort_label(model),
                    "agentFile": args.agent_file,
                    "skills": args.skills,
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
                    "agentFileSha256": meta["agentFileSha256"],
                    "skillsBundleSha256": meta["skillsBundleSha256"],
                    "suiteSha256": meta["suiteSha256"],
                    "wallMs": raw.get("wallMs"),
                    "stderrTail": raw.get("stderrTail"),
                    "promptChars": len(prompt),
                    "stagedSkills": len(staged_skills),
                }
                rec.update(scored)
                raw_path = raw_dir / f"{args.role}__{task['id']}__{model['id']}__{sample_id}.json"
                raw_path.write_text(json.dumps(rec, indent=2))
                records.append(rec)
                q = rec.get("quality")
                qtxt = f"{q:.3f}" if isinstance(q, (int, float)) else "—"
                print(
                    f"[{idx:>2}/{total}] {model['id']:<12} {task['id']:<26} {sample_id} "
                    f"frame={frame:<19} ok={str(bool(rec.get('ok'))):<5} "
                    f"q={qtxt:<5} out={rec.get('outputTokens') or '?':>4}",
                    flush=True,
                )

    per_task = aggregate(records)
    overall = overall_summary(per_task)
    meta["finishedAt"] = now_iso()
    meta["elapsedSec"] = round(time.time() - t0, 1)

    (out_dir / "records.json").write_text(json.dumps(records, indent=2))
    (out_dir / "per_task.json").write_text(json.dumps(per_task, indent=2))
    (out_dir / "summary.json").write_text(json.dumps({"meta": meta, "overall": overall}, indent=2))
    write_report(out_dir, meta, per_task, overall)
    n_ledger = append_probe_rows(meta, per_task)

    print("\n" + "=" * 60, flush=True)
    for row in overall:
        print(
            f"{row['model']} ({row['effort']}): meanQ={row['meanQuality']:.3f} minQ={row['minQuality']:.3f} "
            f"ok={row['okCount']}/{row['samples']} meanOut={row['meanOutputTokens']:.1f}",
            flush=True,
        )
    print(f"wrote {out_dir}/report.md", flush=True)
    print(f"recorded {n_ledger} probe rows to {ledger.LEDGER_PATH}", flush=True)


if __name__ == "__main__":
    main()
