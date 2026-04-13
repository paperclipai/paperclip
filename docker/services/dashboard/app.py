"""
Paperclip Ops Dashboard — Flask backend (routes only, no embedded HTML).
Static files: static/css/, static/js/
Templates: templates/index.html
"""
import json
import os
import queue
import subprocess
import threading
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import docker
from flask import Flask, Response, jsonify, render_template, request, stream_with_context

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
EVENTS_LOG       = Path("/data/events.jsonl")
MAX_EVENTS       = 200
DOCKER_SOCKET    = "unix:///var/run/docker.sock"
SCRIPTS_DIR      = Path("/scripts")

PAPERCLIP_API_URL     = os.getenv("PAPERCLIP_API_URL", "http://server:3100")
PAPERCLIP_API_KEY     = os.getenv("PAPERCLIP_API_KEY", "")
PAPERCLIP_COMPANY_ID  = os.getenv("PAPERCLIP_COMPANY_ID", "")

CONTAINER_NAMES = [
    "paperclip-server-1",
    "paperclip-db-1",
    "paperclip-telegram-bot-1",
    "paperclip-watchdog-1",
    "paperclip-dashboard-1",
]

# ---------------------------------------------------------------------------
# Deploy state
# ---------------------------------------------------------------------------
DEPLOY_TOKEN = os.getenv("DEPLOY_TOKEN", os.getenv("PAPERCLIP_API_KEY", ""))

_deploy_job_id: "str | None" = None

# ---------------------------------------------------------------------------
# In-memory job store
# ---------------------------------------------------------------------------
_script_jobs: dict[str, dict] = {}   # job_id → job dict
_script_lock  = threading.Lock()
_job_counter  = 0

# Per-job SSE subscriber queues: job_id → list[queue.Queue]
_stream_queues: dict[str, list] = {}
_stream_lock   = threading.Lock()

# ---------------------------------------------------------------------------
# Data helpers
# ---------------------------------------------------------------------------

def _read_events() -> list[dict]:
    if not EVENTS_LOG.exists():
        return []
    try:
        lines = EVENTS_LOG.read_text(encoding="utf-8").splitlines()
    except Exception:
        return []
    events = []
    for line in lines[-MAX_EVENTS:]:
        try:
            events.append(json.loads(line))
        except Exception:
            pass
    return list(reversed(events))


def _get_containers() -> list[dict]:
    try:
        dc = docker.DockerClient(base_url=DOCKER_SOCKET)
        result = []
        for name in CONTAINER_NAMES:
            display = name.replace("paperclip-", "").replace("-1", "")
            try:
                c = dc.containers.get(name)
                result.append({
                    "name": display,
                    "status": c.status,
                    "started_at": c.attrs.get("State", {}).get("StartedAt", ""),
                })
            except Exception:
                result.append({"name": display, "status": "not found", "started_at": ""})
        return result
    except Exception as exc:
        return [{"name": "docker", "status": f"error: {exc}", "started_at": ""}]


def _fetch_routines() -> list[dict]:
    if not PAPERCLIP_API_KEY or not PAPERCLIP_COMPANY_ID:
        return []
    try:
        url = f"{PAPERCLIP_API_URL}/api/companies/{PAPERCLIP_COMPANY_ID}/routines"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {PAPERCLIP_API_KEY}"})
        raw = urllib.request.urlopen(req, timeout=5).read()
        result = []
        for r in json.loads(raw):
            triggers = r.get("triggers", [])
            schedule = next(
                (t.get("cron") or t.get("schedule") or t.get("type") for t in triggers if t),
                None,
            )
            last_run = r.get("lastRun") or {}
            active   = r.get("activeIssue")
            result.append({
                "id":                  r.get("id", ""),
                "title":               r.get("title", "untitled"),
                "status":              r.get("status", "unknown"),
                "last_triggered":      r.get("lastTriggeredAt", ""),
                "schedule":            schedule or "—",
                "last_run_status":     last_run.get("status") if last_run else None,
                "active_issue_id":     active.get("identifier") if active else None,
                "active_issue_status": active.get("status") if active else None,
            })
        return result
    except Exception as exc:
        return [{"title": f"Error: {exc}", "status": "error", "last_triggered": "",
                 "schedule": "—", "last_run_status": None,
                 "active_issue_id": None, "active_issue_status": None}]


def _summarise_events(events: list[dict]) -> dict:
    summary: dict = {
        "last_health_check": None,
        "health_status":     "unknown",
        "last_cred_sync":    {"claude": None, "github": None},
        "pending_approvals_seen": [],
        "claude_spawns":     [],
        "alerts":            [],
        "token_expirations": [],
        "claude_audit":      [],
    }
    seen_approvals: set[str] = set()
    for e in reversed(events):
        t  = e.get("type")
        d  = e.get("data", {})
        dt = datetime.fromtimestamp(e.get("ts", 0), tz=timezone.utc).strftime("%H:%M:%S")
        if t == "health_check":
            summary["last_health_check"] = dt
            summary["health_status"]     = d.get("status", "unknown")
        elif t in ("cred_synced", "cred_up_to_date"):
            summary["last_cred_sync"][d.get("target", "unknown")] = {"status": t, "time": dt}
        elif t == "approval_found":
            aid = d.get("approval_id", "")
            if aid not in seen_approvals:
                seen_approvals.add(aid)
                summary["pending_approvals_seen"].append(
                    {"id": aid[:8] + "…", "type": d.get("type"), "time": dt})
        elif t == "claude_spawned":
            summary["claude_spawns"].append(
                {"label": d.get("label"), "reason": d.get("reason"), "time": dt})
        elif t == "alert_sent":
            summary["alerts"].append({"subject": d.get("subject", ""), "time": dt})
        elif t == "token_expired":
            summary["token_expirations"].append({"target": d.get("target"), "time": dt})
        elif t == "claude_output":
            summary["claude_audit"].append({
                "label":   d.get("label"),
                "success": d.get("success"),
                "output":  d.get("output", ""),
                "stderr":  d.get("stderr", ""),
                "time":    dt,
                "ts":      e.get("ts", 0),
            })
    for key in ("pending_approvals_seen", "claude_spawns", "alerts", "token_expirations"):
        summary[key] = summary[key][-10:]
    summary["claude_audit"] = summary["claude_audit"][-20:]
    return summary


def _list_scripts() -> list[dict]:
    if not SCRIPTS_DIR.exists():
        return []
    return [
        {"name": f.stem.replace("-", " ").replace("_", " ").title(), "file": f.name}
        for f in sorted(SCRIPTS_DIR.iterdir())
        if f.suffix == ".sh" and f.is_file()
    ]


def _check_deploy_auth(req) -> bool:
    """Returns True if deploy request is authorized. Open if DEPLOY_TOKEN is not set."""
    if not DEPLOY_TOKEN:
        return True
    auth = req.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:] == DEPLOY_TOKEN
    return False

# ---------------------------------------------------------------------------
# SSE helpers
# ---------------------------------------------------------------------------

def _broadcast(job_id: str, payload: str):
    with _stream_lock:
        dead = []
        for q in _stream_queues.get(job_id, []):
            try:
                q.put_nowait(payload)
            except Exception:
                dead.append(q)
        for q in dead:
            _stream_queues[job_id].remove(q)


# ---------------------------------------------------------------------------
# Script runner
# ---------------------------------------------------------------------------

def _run_script_bg(job_id: str, script_path: Path):
    try:
        proc = subprocess.Popen(
            ["bash", str(script_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            cwd=str(script_path.parent),
        )
        for raw in iter(proc.stdout.readline, ""):
            line = raw.rstrip("\n")
            with _script_lock:
                _script_jobs[job_id]["output_lines"].append(line)
            _broadcast(job_id, json.dumps({"line": line}))

        proc.wait()
        rc     = proc.returncode
        status = "done" if rc == 0 else "failed"
    except Exception as exc:
        rc     = -1
        status = "error"
        with _script_lock:
            _script_jobs[job_id]["output_lines"].append(f"[error] {exc}")
        _broadcast(job_id, json.dumps({"line": f"[error] {exc}"}))

    with _script_lock:
        _script_jobs[job_id].update(
            status=status, exit_code=rc,
            finished=datetime.now(tz=timezone.utc).isoformat(),
        )
        # Release deploy lock if this was the active deploy job
        global _deploy_job_id
        if _deploy_job_id == job_id:
            _deploy_job_id = None
    _broadcast(job_id, json.dumps({"done": True, "status": status, "exit_code": rc}))

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    events = _read_events()
    return jsonify({
        "containers":   _get_containers(),
        "summary":      _summarise_events(events),
        "event_count":  len(events),
        "server_time":  datetime.now(tz=timezone.utc).isoformat(),
    })


@app.route("/api/routines")
def api_routines():
    return jsonify(_fetch_routines())


@app.route("/api/events")
def api_events():
    return jsonify(_read_events())


@app.route("/api/scripts")
def api_scripts():
    return jsonify(_list_scripts())


@app.route("/api/scripts/run", methods=["POST"])
def api_scripts_run():
    global _job_counter
    data     = request.get_json(force=True, silent=True) or {}
    filename = data.get("file", "")
    if not filename or "/" in filename or "\\" in filename or ".." in filename:
        return jsonify({"error": "Invalid filename"}), 400
    script_path = SCRIPTS_DIR / filename
    if not script_path.is_file():
        return jsonify({"error": f"Not found: {filename}"}), 404

    with _script_lock:
        _job_counter += 1
        job_id = f"job-{_job_counter}"
        _script_jobs[job_id] = {
            "id":           job_id,
            "file":         filename,
            "status":       "running",
            "output_lines": [],
            "exit_code":    None,
            "started":      datetime.now(tz=timezone.utc).isoformat(),
            "finished":     None,
        }
    with _stream_lock:
        _stream_queues[job_id] = []

    threading.Thread(target=_run_script_bg, args=(job_id, script_path), daemon=True).start()
    return jsonify({"job_id": job_id}), 202


@app.route("/api/scripts/jobs")
def api_scripts_jobs():
    with _script_lock:
        jobs = sorted(_script_jobs.values(), key=lambda j: j.get("started", ""), reverse=True)[:20]
        result = []
        for j in jobs:
            r = dict(j)
            r["output"] = "\n".join(r.pop("output_lines", []))
            result.append(r)
    return jsonify(result)


@app.route("/api/scripts/jobs/<job_id>")
def api_scripts_job(job_id: str):
    with _script_lock:
        job = _script_jobs.get(job_id)
    if not job:
        return jsonify({"error": "Not found"}), 404
    r = dict(job)
    r["output"] = "\n".join(r.pop("output_lines", []))
    return jsonify(r)


@app.route("/api/scripts/jobs/clear", methods=["POST"])
def api_scripts_jobs_clear():
    with _script_lock:
        done = [jid for jid, j in _script_jobs.items() if j.get("status") != "running"]
        for jid in done:
            del _script_jobs[jid]
    return jsonify({"cleared": len(done)})


@app.route("/api/scripts/stream/<job_id>")
def api_scripts_stream(job_id: str):
    """SSE: streams stdout lines for a job as they are produced."""
    with _script_lock:
        job = _script_jobs.get(job_id)
    if not job:
        return jsonify({"error": "Not found"}), 404

    with _script_lock:
        backlog  = list(job.get("output_lines", []))
        is_done  = job.get("status") != "running"
        fin_stat = job.get("status", "done")

    q: "queue.Queue[str]" = queue.Queue()
    if not is_done:
        with _stream_lock:
            _stream_queues.setdefault(job_id, []).append(q)

    def generate():
        for line in backlog:
            yield f"data: {json.dumps({'line': line})}\n\n"
        if is_done:
            yield f"data: {json.dumps({'done': True, 'status': fin_stat})}\n\n"
            return
        while True:
            try:
                msg = q.get(timeout=20)
            except queue.Empty:
                yield ": heartbeat\n\n"
                continue
            yield f"data: {msg}\n\n"
            try:
                parsed = json.loads(msg)
                if parsed.get("done"):
                    break
            except Exception:
                pass

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/deploy", methods=["POST"])
def api_deploy():
    """Trigger a safe deploy of the paperclip server (build → up → health check → rollback).
    Prevents concurrent deploys. Auth via Authorization: Bearer <DEPLOY_TOKEN> if configured."""
    global _deploy_job_id, _job_counter

    if not _check_deploy_auth(request):
        return jsonify({"error": "Unauthorized"}), 401

    script_path = SCRIPTS_DIR / "deploy.sh"
    if not script_path.is_file():
        return jsonify({"error": "deploy.sh not found in /scripts — check volume mount"}), 500

    with _script_lock:
        # Prevent concurrent deploys
        if _deploy_job_id:
            existing = _script_jobs.get(_deploy_job_id)
            if existing and existing.get("status") == "running":
                return jsonify({
                    "error": "Deploy already in progress",
                    "job_id": _deploy_job_id,
                }), 409

        _job_counter += 1
        job_id = f"deploy-{_job_counter}"
        _deploy_job_id = job_id
        _script_jobs[job_id] = {
            "id":           job_id,
            "file":         "deploy.sh",
            "status":       "running",
            "output_lines": [],
            "exit_code":    None,
            "started":      datetime.now(tz=timezone.utc).isoformat(),
            "finished":     None,
        }

    with _stream_lock:
        _stream_queues[job_id] = []

    threading.Thread(target=_run_script_bg, args=(job_id, script_path), daemon=True).start()
    return jsonify({"job_id": job_id, "message": "Deploy started"}), 202


@app.route("/api/deploy/status")
def api_deploy_status():
    """Status of the most recent deploy job."""
    with _script_lock:
        if not _deploy_job_id:
            return jsonify({"status": "idle"}), 200
        job = _script_jobs.get(_deploy_job_id)
    if not job:
        return jsonify({"status": "idle"}), 200
    r = dict(job)
    r["output"] = "\n".join(r.pop("output_lines", []))
    return jsonify(r)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "3200"))
    app.run(host="0.0.0.0", port=port, threaded=True)
