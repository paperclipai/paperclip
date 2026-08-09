#!/usr/bin/env python3
"""Detect a Paperclip runtime checkout that has drifted from the approved target.

Stdlib-only and deliberately read-mostly.  ``live`` may post a bounded owner alert,
but never changes a service, checkout, agent status, or issue status.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path


SERVICE = os.environ.get("PAPERCLIP_RUNTIME_SERVICE", "paperclip-server.service")
STATE_ISSUE = os.environ.get(
    "PAPERCLIP_RUNTIME_ALERT_ISSUE",
    "f5c9151b-f233-4bcc-a9ff-853eb7b4470e",
)
OWNER_ID = os.environ.get(
    "PAPERCLIP_RUNTIME_ALERT_AGENT_ID",
    "f3c48afc-c339-4e43-b47b-a42a0891229d",
)
OWNER_NAME = os.environ.get("PAPERCLIP_RUNTIME_ALERT_AGENT_NAME", "CTO")
DEFAULT_DROPIN = (
    Path.home()
    / ".config/systemd/user/paperclip-server.service.d/paperclip-update.conf"
)
DEFAULT_TARGET = Path(__file__).resolve().parents[1] / "ops/runtime-target.json"
MODE = sys.argv[1] if len(sys.argv) > 1 else "live"


def run(args):
    return subprocess.run(args, text=True, capture_output=True, check=False)


def norm_path(value):
    if not value:
        return None
    value = value.strip()
    if value.startswith("-"):
        value = value[1:]
    return os.path.realpath(value)


def parse_working_directory(text):
    for line in text.splitlines():
        if line.strip().startswith("WorkingDirectory="):
            return norm_path(line.split("=", 1)[1].strip())
    return None


def systemd_property(name):
    result = run(["systemctl", "--user", "show", SERVICE, f"-p{name}", "--value"])
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def resolve_context():
    """Resolve drop-in, systemd, and PID data without requiring root privileges."""
    explicit_wd = os.environ.get("PAPERCLIP_RUNTIME_WORKDIR")
    dropin = Path(os.environ.get("PAPERCLIP_RUNTIME_DROPIN", DEFAULT_DROPIN))
    dropin_wd = None
    if dropin.is_file():
        dropin_wd = parse_working_directory(dropin.read_text(encoding="utf-8"))

    systemd_wd = norm_path(systemd_property("WorkingDirectory"))
    pid = os.environ.get("PAPERCLIP_RUNTIME_PID") or systemd_property("MainPID")
    pid_cwd = None
    if pid and pid != "0":
        try:
            pid_cwd = norm_path(os.readlink(f"/proc/{pid}/cwd"))
        except OSError:
            pid_cwd = None

    working_dir = norm_path(explicit_wd) or dropin_wd or systemd_wd or pid_cwd
    if not working_dir:
        raise RuntimeError(
            "unable to resolve WorkingDirectory; set PAPERCLIP_RUNTIME_WORKDIR "
            "or run on the host with paperclip-server.service"
        )
    return {
        "working_dir": working_dir,
        "dropin_working_dir": dropin_wd,
        "systemd_working_dir": systemd_wd,
        "pid": pid,
        "pid_cwd": pid_cwd,
        "dropin": str(dropin),
    }


def target_path():
    return Path(os.environ.get("PAPERCLIP_RUNTIME_TARGET", DEFAULT_TARGET))


def load_target(path=None):
    path = Path(path or target_path())
    payload = json.loads(path.read_text(encoding="utf-8"))
    required = payload.get("required_ancestors")
    if not isinstance(required, list) or not required or not all(
        isinstance(item, str) and item.strip() for item in required
    ):
        raise ValueError("runtime target must contain a non-empty required_ancestors list")
    target_sha = str(payload.get("target_sha") or required[0]).strip()
    return {"target_sha": target_sha, "required_ancestors": required, "note": payload.get("note", "")}


def git_head(working_dir):
    result = run(["git", "-C", working_dir, "rev-parse", "HEAD"])
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "git rev-parse HEAD failed")
    return result.stdout.strip()


def ancestor_ok(working_dir, ancestor, head):
    result = run(["git", "-C", working_dir, "merge-base", "--is-ancestor", ancestor, head])
    return result.returncode == 0


def evaluate_snapshot(
    live_sha,
    target_sha,
    required_ancestors,
    ancestor_results,
    dropin_working_dir=None,
    pid_cwd=None,
):
    staged = bool(dropin_working_dir and pid_cwd and norm_path(dropin_working_dir) != norm_path(pid_cwd))
    ancestors = {name: bool(ancestor_results.get(name, False)) for name in required_ancestors}
    state = "GREEN" if all(ancestors.values()) and not staged else "DRIFT"
    return {
        "state": state,
        "live_sha": live_sha,
        "target_sha": target_sha,
        "required_ancestors": ancestors,
        "staged_but_not_restarted": staged,
        "dropin_working_dir": norm_path(dropin_working_dir),
        "pid_cwd": norm_path(pid_cwd),
    }


def inspect_live():
    context = resolve_context()
    target = load_target()
    head = git_head(context["working_dir"])
    results = {
        ancestor: ancestor_ok(context["working_dir"], ancestor, head)
        for ancestor in target["required_ancestors"]
    }
    report = evaluate_snapshot(
        head,
        target["target_sha"],
        target["required_ancestors"],
        results,
        context["dropin_working_dir"],
        context["pid_cwd"],
    )
    report["working_dir"] = context["working_dir"]
    report["target_file"] = str(target_path())
    report["service"] = SERVICE
    return report


def alert_key(live_sha, target_sha):
    return f"{live_sha}:{target_sha}"


def ledger_path():
    explicit = os.environ.get("PAPERCLIP_RUNTIME_DRIFT_LEDGER")
    if explicit:
        return Path(explicit)
    scratch = os.environ.get("PAPERCLIP_SCRATCH_DIR") or os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR")
    if scratch:
        return Path(scratch) / "runtime-sha-drift-ledger.json"
    return Path(tempfile.gettempdir()) / "paperclip-runtime-sha-drift-ledger.json"


def read_ledger():
    try:
        payload = json.loads(ledger_path().read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {"alerts": []}
    except (OSError, ValueError):
        return {"alerts": []}


def write_ledger(payload):
    path = ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, path)


def request(method, path, body):
    api = os.environ.get("PAPERCLIP_API_URL", "").rstrip("/")
    if api.endswith("/api"):
        api = api[:-4]
    if not api or not os.environ.get("PAPERCLIP_API_KEY"):
        return 0, {"error": "PAPERCLIP_API_URL/API_KEY unavailable"}
    request = urllib.request.Request(
        api + path,
        data=json.dumps(body).encode("utf-8"),
        method=method,
        headers={
            "Authorization": "Bearer " + os.environ["PAPERCLIP_API_KEY"],
            "Content-Type": "application/json",
        },
    )
    run_id = os.environ.get("PAPERCLIP_RUN_ID")
    if run_id:
        request.add_header("X-Paperclip-Run-Id", run_id)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8")[:200]
    except OSError as error:
        return 0, str(error)


def alert(report, dry=False):
    if report["state"] != "DRIFT":
        return {"action": "none", "reason": "green"}
    key = alert_key(report["live_sha"], report["target_sha"])
    ledger = read_ledger()
    if key in ledger.get("alerts", []):
        return {"action": "deduped", "key": key}
    message = (
        f"**Runtime SHA drift detected** — [@{OWNER_NAME}](agent://{OWNER_ID}), "
        f"`{SERVICE}` is running `{report['live_sha']}` but target `{report['target_sha']}` "
        f"is not fully live. Required ancestor verdicts: "
        f"`{json.dumps(report['required_ancestors'], sort_keys=True)}`. "
        f"WorkingDirectory drop-in={report.get('dropin_working_dir')!r}, "
        f"PID cwd={report.get('pid_cwd')!r}. This is an alert only; no restart or status "
        "mutation was attempted."
    )
    if dry:
        return {"action": "would-alert", "key": key, "message": message}
    status, body = request("POST", f"/api/issues/{STATE_ISSUE}/comments", {"body": message})
    if not 200 <= status < 300:
        return {"action": "alert-failed", "key": key, "status": status, "body": body}
    ledger.setdefault("alerts", []).append(key)
    write_ledger(ledger)
    return {"action": "alerted", "key": key, "status": status}


def selftest():
    report = evaluate_snapshot(
        "2ebc236b",
        "e57450356",
        ["e57450356"],
        {"e57450356": False},
        "/staged",
        "/live",
    )
    assert report["state"] == "DRIFT"
    assert report["staged_but_not_restarted"]
    green = evaluate_snapshot(
        "e57450356",
        "e57450356",
        ["e57450356"],
        {"e57450356": True},
        "/live",
        "/live",
    )
    assert green["state"] == "GREEN"
    print(json.dumps({"selftest": "GREEN", "drift": report, "green": green}, sort_keys=True))


def main():
    if MODE == "selftest":
        selftest()
        return 0
    if MODE not in ("live", "dry"):
        print("usage: runtime_sha_drift_check.py [live|dry|selftest]", file=sys.stderr)
        return 2
    try:
        report = inspect_live()
    except (OSError, RuntimeError, ValueError) as error:
        print(json.dumps({"state": "UNKNOWN", "error": str(error)}))
        return 0 if MODE == "dry" else 1
    report["alert"] = alert(report, dry=MODE == "dry")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if MODE == "dry" or report["state"] == "GREEN" else 1


if __name__ == "__main__":
    raise SystemExit(main())
