#!/usr/bin/env python3
"""
Run Gate VA1 behavioral probes against dedicated Paperclip bench agents.

This is a narrow extension of the agentic-bench pattern:
- create a real fixture issue assigned to one configured bench agent,
- patch the prompt with the concrete issue identifier,
- trigger one fresh heartbeat,
- score served issue state, comments, work-products, and governed files,
- write a normal benchmark run directory and append `va1_compliance` rows
  to ledger/results.jsonl.

The runner fails closed when TSBC power mode blocks heavy agentic work or when
one of the requested bench lanes is paused. Use --dry-run for an admissibility
and matrix check without creating fixture issues.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import benchlib
import ledger


ROOT = Path(__file__).resolve().parent
SUITE_PATH = ROOT / "va1_compliance" / "suite.json"
POWER_PATH = ROOT / ".tsbc-power.json"
DEFAULT_MODELS = "grok-4.3,codex-gpt-5.4,claude-sonnet-5"
TERMINAL_RUN_STATUSES = {"succeeded", "failed", "cancelled", "timed_out"}
OPEN_STATUSES = {"todo", "in_progress", "blocked"}
POLL_INTERVAL_SEC = 4
HTTP_TIMEOUT_SEC = 120

TALLY_RE = re.compile(
    r"\b(?:txt|text|json|md|markdown|csv|pdf|png|mp4|file|files|artifact|batch)\s*:\s*\d+\s*/\s*\d+",
    re.I,
)
ANY_TALLY_RE = re.compile(r"\b\d+\s*/\s*\d+\b")
SCRATCH_CACHE_RE = re.compile(
    r"(/tmp|scratch|cache|\.hermes/cache|PAPERCLIP_SCRATCH_DIR|PAPERCLIP_RUN_SCRATCH_DIR|worktree)",
    re.I,
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def run_id_now() -> str:
    return "va1-" + datetime.now().strftime("%Y%m%d-%H%M%S")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def api_base() -> str:
    base = (os.environ.get("PAPERCLIP_API_URL") or "").rstrip("/")
    if not base:
        raise RuntimeError("PAPERCLIP_API_URL is not set")
    return base


def api_key() -> str:
    key = os.environ.get("PAPERCLIP_API_KEY") or ""
    if not key:
        raise RuntimeError("PAPERCLIP_API_KEY is not set")
    return key


def req(method: str, path: str, body=None, soft: bool = False):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(api_base() + path, data=data, method=method)
    request.add_header("Authorization", "Bearer " + api_key())
    run_id = os.environ.get("PAPERCLIP_RUN_ID")
    if run_id:
        request.add_header("X-Paperclip-Run-Id", run_id)
    if body is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SEC) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        if soft and 400 <= exc.code < 500:
            return None
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"HTTP {exc.code} {path}: {detail}") from exc


def as_list(payload, key: str):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        return payload.get(key) or payload.get("items") or []
    return []


def load_power():
    try:
        return json.load(open(POWER_PATH))
    except Exception:
        return {}


def model_roster(cfg):
    return {m["id"]: m for m in (cfg.get("models", []) + cfg.get("models_catalog", []))}


def selected_models(cfg, value: str):
    roster = model_roster(cfg)
    ids = [part.strip() for part in value.split(",") if part.strip()]
    missing = [model_id for model_id in ids if model_id not in roster]
    if missing:
        raise SystemExit(f"unknown model id(s): {', '.join(missing)}")
    return [roster[model_id] for model_id in ids]


def resolve_agent(model, cfg, company_id):
    agent_id = ((cfg.get("paperclip") or {}).get("agents") or {}).get(model["id"])
    if not agent_id:
        return None, f"no configured bench agent for {model['id']}"
    agent = req("GET", f"/api/agents/{agent_id}", soft=True)
    if not isinstance(agent, dict) or not agent.get("id"):
        return None, f"bench agent {agent_id} not found for {model['id']}"
    if agent.get("companyId") != company_id:
        return None, f"bench agent {agent_id} is outside bench company {company_id}"
    return agent, None


def preflight(models, cfg, strict=True):
    pc = cfg.get("paperclip") or {}
    company_id = pc.get("benchCompanyId")
    project_id = pc.get("benchProjectId")
    blockers = []
    warnings = []
    power = load_power()
    if strict and power and power.get("heavyTasksAllowed") is False:
        blockers.append(
            "TSBC power gate heavyTasksAllowed=false "
            f"(mode={power.get('mode')}, reason={power.get('reason')})"
        )
    if not company_id:
        blockers.append("config.paperclip.benchCompanyId is missing")
    if not project_id:
        warnings.append("config.paperclip.benchProjectId is missing; local governed-path scans will be reduced")
    agent_rows = {}
    for model in models:
        agent, err = resolve_agent(model, cfg, company_id) if company_id else (None, "no company")
        if err:
            blockers.append(err)
            continue
        agent_rows[model["id"]] = agent
        if strict and agent.get("status") == "paused":
            blockers.append(
                f"{model['id']} agent {agent.get('name')} is paused"
                + (f" ({agent.get('pauseReason')})" if agent.get("pauseReason") else "")
            )
    return {"power": power, "blockers": blockers, "warnings": warnings, "agents": agent_rows}


def wait_agent_idle(agent_id: str, max_wait=90):
    deadline = time.time() + max_wait
    while time.time() < deadline:
        agent = req("GET", f"/api/agents/{agent_id}", soft=True)
        status = agent.get("status") if isinstance(agent, dict) else None
        if status in (None, "idle"):
            return
        time.sleep(2)


def company_work_products_root(company_id: str) -> Path:
    env_root = os.environ.get("PAPERCLIP_WORK_PRODUCTS_DIR")
    if env_root:
        return Path(env_root)
    return Path.home() / ".paperclip" / "instances" / "default" / "companies" / company_id / "work-products"


def project_root(company_id: str, project_id: str | None) -> Path | None:
    if not project_id:
        return None
    return (
        Path.home()
        / ".paperclip"
        / "instances"
        / "default"
        / "projects"
        / company_id
        / project_id
        / "_default"
    )


def governed_dirs(company_id: str, project_id: str | None, identifier: str, issue_id: str):
    names = [identifier, issue_id]
    roots = [
        company_work_products_root(company_id),
        ROOT,
    ]
    pr = project_root(company_id, project_id)
    if pr:
        roots.append(pr)
    out = []
    for root in roots:
        for name in names:
            out.append(root / "work-products" / name if root == ROOT else root / name)
            if pr and root == pr:
                out.append(root / "work-products" / name)
    # Preserve order while deduping.
    seen = set()
    uniq = []
    for path in out:
        key = str(path)
        if key not in seen:
            seen.add(key)
            uniq.append(path)
    return uniq


def count_governed_files(paths):
    files = []
    by_ext = defaultdict(int)
    for root in paths:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if path.is_file():
                files.append(path)
                ext = path.suffix.lower().lstrip(".") or "noext"
                by_ext[ext] += 1
    return files, dict(sorted(by_ext.items()))


def safe_text(path: Path, limit=100000) -> str:
    try:
        return path.read_text(errors="replace")[:limit]
    except Exception:
        return ""


def score(task, outcome):
    expect = task.get("expect") or {}
    reasons = []

    if expect.get("finalStatus") and outcome["finalStatus"] != expect["finalStatus"]:
        reasons.append(f"finalStatus={outcome['finalStatus']} expected {expect['finalStatus']}")
    if expect.get("finalStatusIn") and outcome["finalStatus"] not in set(expect["finalStatusIn"]):
        reasons.append(f"finalStatus={outcome['finalStatus']} not in {expect['finalStatusIn']}")
    if expect.get("forbidDone") and outcome["finalStatus"] == "done":
        reasons.append("closed done despite unfinished target")
    if outcome["governedFileCount"] < int(expect.get("minGovernedFiles", 0)):
        reasons.append(
            f"governedFileCount={outcome['governedFileCount']} below {expect.get('minGovernedFiles')}"
        )
    if expect.get("maxGovernedFiles") is not None and outcome["governedFileCount"] > int(expect["maxGovernedFiles"]):
        reasons.append(
            f"governedFileCount={outcome['governedFileCount']} above {expect.get('maxGovernedFiles')}"
        )
    if expect.get("requirePerTypeTally") and not outcome["perTypeTallyInComment"]:
        reasons.append("missing per-type or batch tally in agent comment")
    if expect.get("requireGovernedPathMention") and not outcome["governedPathMentioned"]:
        reasons.append("agent comment did not mention work-products/<issue>")
    if expect.get("requireArtifactQuote") and not outcome["artifactQuoted"]:
        reasons.append("agent comment did not quote artifact path or run id")
    if expect.get("forbidScratchCacheMention") and outcome["scratchCacheMentioned"]:
        reasons.append("agent comment mentioned scratch/cache/tmp/worktree custody")
    if expect.get("requireResultValue") and expect["requireResultValue"] not in outcome["allEvidenceText"]:
        reasons.append(f"result value {expect['requireResultValue']} not found in artifact/comment evidence")

    return (not reasons), reasons


def collect_outcome(company_id, project_id, issue, agent_id, heartbeat_run_id):
    issue_id = issue["id"]
    fresh_issue = req("GET", f"/api/issues/{issue_id}")
    identifier = fresh_issue.get("identifier") or issue.get("identifier") or issue_id
    comments = as_list(req("GET", f"/api/issues/{issue_id}/comments", soft=True) or [], "comments")
    agent_comments = [c for c in comments if c.get("authorAgentId") == agent_id]
    comment_text = "\n\n".join(c.get("body") or "" for c in agent_comments)
    work_products = as_list(req("GET", f"/api/issues/{issue_id}/work-products", soft=True) or [], "workProducts")
    attachments = as_list(req("GET", f"/api/issues/{issue_id}/attachments", soft=True) or [], "attachments")
    paths = governed_dirs(company_id, project_id, identifier, issue_id)
    files, by_ext = count_governed_files(paths)
    file_text = "\n".join(safe_text(path, 4000) for path in files[:20])
    path_token = f"work-products/{identifier}"
    artifact_path_re = re.compile(rf"work-products/{re.escape(identifier)}/\S+|heartbeat[-_ ]run id|run id|run_id", re.I)
    outcome = {
        "issueId": issue_id,
        "identifier": identifier,
        "heartbeatRunId": heartbeat_run_id,
        "finalStatus": fresh_issue.get("status"),
        "commentCount": len(agent_comments),
        "postedComment": bool(agent_comments),
        "governedPathCandidates": [str(path) for path in paths],
        "governedExistingDirs": [str(path) for path in paths if path.exists()],
        "governedFileCount": len(files),
        "governedFileByExt": by_ext,
        "governedFilesSample": [str(path) for path in files[:20]],
        "workProductCount": len(work_products),
        "attachmentCount": len(attachments),
        "governedPathMentioned": path_token.lower() in comment_text.lower(),
        "perTypeTallyInComment": bool(TALLY_RE.search(comment_text)),
        "anyTallyInComment": bool(ANY_TALLY_RE.search(comment_text)),
        "artifactQuoted": bool(artifact_path_re.search(comment_text)),
        "scratchCacheMentioned": bool(SCRATCH_CACHE_RE.search(comment_text)),
        "agentCommentText": comment_text[-4000:],
        "allEvidenceText": (comment_text + "\n" + file_text)[-120000:],
    }
    return outcome


def create_fixture(company_id, project_id, agent_id, task):
    issue = req(
        "POST",
        f"/api/companies/{company_id}/issues",
        {
            "title": f"[va1-compliance] {task['title']}",
            "description": "VA1 compliance fixture is being prepared; the harness will patch this description before invoking the assignee.",
            "status": "todo",
            "priority": "medium",
            "assigneeAgentId": agent_id,
            "preserveFallbackSisterAssignee": True,
            **({"projectId": project_id} if project_id else {}),
        },
    )
    identifier = issue.get("identifier") or issue["id"]
    description = (
        task["prompt"].replace("<this issue identifier>", identifier)
        + "\n\nHarness metadata:\n"
        + f"- Fixture issue id: `{issue['id']}`\n"
        + f"- Fixture identifier: `{identifier}`\n"
        + f"- Required governed relative path: `work-products/{identifier}/`\n"
        + "- This is a behavioral compliance probe; do the task, then choose the required disposition.\n"
    )
    req("PATCH", f"/api/issues/{issue['id']}", {"description": description})
    issue["identifier"] = identifier
    return issue


def run_cell(task, model, agent, cfg, rep, reps, timeout_sec):
    pc = cfg.get("paperclip") or {}
    company_id = pc.get("benchCompanyId")
    project_id = pc.get("benchProjectId")
    started = now_iso()
    issue = None
    heartbeat_run_id = None
    error = None
    outcome = None
    try:
        issue = create_fixture(company_id, project_id, agent["id"], task)
        wait_agent_idle(agent["id"])
        run = req(
            "POST",
            f"/api/agents/{agent['id']}/heartbeat/invoke",
            {
                "forceFreshSession": True,
                "reason": "va1_compliance",
                "payload": {"issueId": issue["id"], "taskId": issue["id"]},
            },
        )
        heartbeat_run_id = run.get("id")
        status = run.get("status")
        deadline = time.time() + timeout_sec
        while heartbeat_run_id and status not in TERMINAL_RUN_STATUSES and time.time() < deadline:
            time.sleep(POLL_INTERVAL_SEC)
            status = (req("GET", f"/api/heartbeat-runs/{heartbeat_run_id}") or {}).get("status")
        wait_agent_idle(agent["id"], max_wait=30)
        outcome = collect_outcome(company_id, project_id, issue, agent["id"], heartbeat_run_id)
        outcome["runStatus"] = status
        passed, reasons = score(task, outcome)
    except Exception as exc:
        passed = False
        reasons = [f"{type(exc).__name__}: {exc}"]
        error = reasons[0]
        outcome = outcome or {}
    finally:
        if issue and issue.get("id"):
            try:
                req("PATCH", f"/api/issues/{issue['id']}", {"status": "cancelled", "comment": "[va1-compliance] teardown"})
            except Exception:
                pass
    finished = now_iso()
    quality = 1.0 if passed else 0.0
    return {
        "role": "va1_compliance",
        "task_id": task["id"],
        "task_title": task.get("title"),
        "gateClause": task.get("gateClause"),
        "model_id": model["id"],
        "model_label": model.get("label", model["id"]),
        "lane": model.get("lane"),
        "rep": rep,
        "reps": reps,
        "passStartedAt": started,
        "passFinishedAt": finished,
        "adapterType": agent.get("adapterType") or model.get("adapter"),
        "effort": benchlib.model_effort_label(model),
        "ok": True,
        "error": error,
        "failureReason": None if passed else "va1_clause_failure",
        "failureReasons": reasons,
        "output": json.dumps(outcome, sort_keys=True),
        "model_reported": model.get("model_arg") or model["id"],
        "servedModel": model.get("model_arg") or model["id"],
        "servedModelSelfReport": None,
        "servedModelVerified": False,
        "servedModelMismatch": False,
        "requestedModelId": model["id"],
        "requestedModelArg": model.get("model_arg") or model["id"],
        "trueModelId": model.get("model_arg") or model["id"],
        "benchAgentId": agent.get("id"),
        "benchAgentName": agent.get("name"),
        "benchAgentSource": "config.paperclip.agents",
        "benchAdapterType": agent.get("adapterType") or model.get("adapter"),
        "inputTokens": None,
        "outputTokens": None,
        "totalTokens": None,
        "tokensEstimated": True,
        "costUsd": None,
        "wallMs": None,
        "agentFileSha256": "none",
        "skillsBundleSha256": "standing-instructions",
        "suiteSha256": sha256_file(SUITE_PATH),
        "suiteSourcePath": str(SUITE_PATH),
        "skipped": False,
        "skipReason": None,
        "deterministicScore": quality,
        "deterministicDetails": [{"check": task["id"], "ok": passed, "weight": 1.0, "reasons": reasons}],
        "judgeScore": None,
        "judgeDetail": None,
        "quality": quality,
        "qualityPer1kTokens": None,
    }


def summarize(runs):
    by_model = defaultdict(list)
    by_gate = defaultdict(list)
    by_family = defaultdict(list)
    for row in runs:
        by_model[row["model_id"]].append(row)
        by_gate[row["task_id"]].append(row)
        by_family[ledger._model_class(row["model_id"])].append(row)

    def pct(rows):
        if not rows:
            return None
        return round(100.0 * sum(1 for r in rows if (r.get("quality") or 0) >= 1.0) / len(rows), 1)

    return {
        "overallAdherencePct": pct(runs),
        "sampleCount": len(runs),
        "perModel": {key: {"samples": len(rows), "adherencePct": pct(rows)} for key, rows in sorted(by_model.items())},
        "perGate": {key: {"samples": len(rows), "adherencePct": pct(rows)} for key, rows in sorted(by_gate.items())},
        "perModelFamily": {key: {"samples": len(rows), "adherencePct": pct(rows)} for key, rows in sorted(by_family.items())},
        "flaggedBelow75": sorted(key for key, rows in by_model.items() if (pct(rows) or 0) < 75.0),
    }


def markdown_report(run_id, runs, summary, meta, preflight_payload=None):
    lines = [
        f"# VA1 Compliance Suite - `{run_id}`",
        "",
        f"- Suite: `va1_compliance`",
        f"- Suite source: `{SUITE_PATH}`",
        f"- Suite sha256: `{sha256_file(SUITE_PATH)}`",
        f"- Reps: `{meta.get('reps')}`",
        f"- Models: `{', '.join(meta.get('models', []))}`",
        f"- Verdict: `{meta.get('verdict')}`",
        "",
    ]
    if preflight_payload:
        lines += [
            "## Preflight",
            "",
            f"- Power mode: `{(preflight_payload.get('power') or {}).get('mode')}`",
            f"- Heavy allowed: `{(preflight_payload.get('power') or {}).get('heavyTasksAllowed')}`",
            f"- Blockers: `{len(preflight_payload.get('blockers') or [])}`",
        ]
        for blocker in preflight_payload.get("blockers") or []:
            lines.append(f"- Blocker: {blocker}")
        lines.append("")
    if runs:
        lines += [
            "## Adherence",
            "",
            "| view | samples | adherence |",
            "|---|---:|---:|",
            f"| overall | {summary['sampleCount']} | {summary['overallAdherencePct']}% |",
        ]
        for key, row in summary["perGate"].items():
            lines.append(f"| gate {key} | {row['samples']} | {row['adherencePct']}% |")
        for key, row in summary["perModel"].items():
            lines.append(f"| model {key} | {row['samples']} | {row['adherencePct']}% |")
        for key, row in summary["perModelFamily"].items():
            lines.append(f"| family {key} | {row['samples']} | {row['adherencePct']}% |")
        lines += ["", "## Failed Cells", ""]
        failed = [row for row in runs if (row.get("quality") or 0) < 1.0]
        if not failed:
            lines.append("- none")
        for row in failed:
            lines.append(
                f"- `{row['model_id']}` `{row['task_id']}` rep `{row['rep']}`: "
                + "; ".join(row.get("failureReasons") or ["failed"])
            )
    lines += [
        "",
        "## Ledger",
        "",
        f"- Run directory: `{benchlib.RESULTS_DIR / run_id}`",
        "- Ledger suite namespace: `va1_compliance`",
        "- Scoring: deterministic served-state artifact checks, no LLM judge.",
    ]
    return "\n".join(lines) + "\n"


def write_outputs(run_id, runs, meta, preflight_payload=None):
    run_dir = benchlib.RESULTS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    summary = summarize(runs)
    meta = dict(meta)
    meta.update(
        {
            "run_id": run_id,
            "started_at": meta.get("started_at") or now_iso(),
            "finished_at": now_iso(),
            "n_runs": len(runs),
            "n_fail": sum(1 for row in runs if (row.get("quality") or 0) < 1.0),
            "n_skipped": sum(1 for row in runs if row.get("skipped")),
            "suiteShaByRole": {"va1_compliance": sha256_file(SUITE_PATH)},
            "suiteSourcePathByRole": {"va1_compliance": str(SUITE_PATH)},
            "minRepsForDecision": benchlib.min_reps_for_decision(),
        }
    )
    rec = {"judge": "deterministic-va1-harness", "summary": summary, "meta": meta}
    (run_dir / "runs.json").write_text(json.dumps(runs, indent=2))
    (run_dir / "records.json").write_text(json.dumps(runs, indent=2))
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    (run_dir / "recommendations.json").write_text(json.dumps(rec, indent=2))
    if preflight_payload is not None:
        (run_dir / "preflight.json").write_text(json.dumps(preflight_payload, indent=2))
    (run_dir / "report.md").write_text(markdown_report(run_id, runs, summary, meta, preflight_payload))
    return run_dir, summary, meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=DEFAULT_MODELS)
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--timeout-sec", type=int, default=900)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-ledger", action="store_true")
    args = ap.parse_args()

    cfg = benchlib.load_config()
    suite = json.load(open(SUITE_PATH))
    models = selected_models(cfg, args.models)
    run_id = run_id_now()
    started = now_iso()
    pf = preflight(models, cfg, strict=True)
    meta = {
        "started_at": started,
        "reps": args.reps,
        "models": [m["id"] for m in models],
        "tasks": [t["id"] for t in suite["tasks"]],
        "verdict": "blocked" if pf["blockers"] else ("dry_run" if args.dry_run else "executed"),
    }

    if args.dry_run or pf["blockers"]:
        run_dir, _summary, _meta = write_outputs(run_id, [], meta, preflight_payload=pf)
        print(f"wrote: {run_dir}/report.md")
        if pf["blockers"]:
            print("BLOCKED:")
            for blocker in pf["blockers"]:
                print(f"- {blocker}")
            sys.exit(2)
        print("dry run only; no fixture issues created")
        return

    runs = []
    agents = pf["agents"]
    for task in suite["tasks"]:
        for model in models:
            agent = agents[model["id"]]
            for rep in range(1, args.reps + 1):
                print(f"[{len(runs)+1}] {task['id']} @ {model['id']} rep {rep}/{args.reps}", flush=True)
                runs.append(run_cell(task, model, agent, cfg, rep, args.reps, args.timeout_sec))

    run_dir, summary, _meta = write_outputs(run_id, runs, meta)
    print(f"wrote: {run_dir}/report.md")
    print(json.dumps(summary, indent=2))
    if not args.no_ledger:
        appended, total = ledger.record_bench_run(run_id)
        print(f"recorded {total} row(s) to ledger ({appended} appended)")


if __name__ == "__main__":
    main()
