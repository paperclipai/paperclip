#!/usr/bin/env python3
"""Run a benchmark module (variants|skillbench) with Spark per-call token capture.
Installs the same adapters._exec monkeypatch as driver.py, then hands off to the
module's own main() via runpy. Appends spark usage to $SPARK_SIDECAR.

Usage: spark_capture_run.py <module> [module args...]
  e.g. spark_capture_run.py variants --config burn-config.json --models gpt-5.3-codex-spark
"""
import sys, os, json, threading, time, runpy
BENCH = "/Users/glad0s/paperclip/benchmark"
sys.path.insert(0, BENCH); os.chdir(BENCH)
import adapters, benchlib  # noqa

SIDECAR = os.environ["SPARK_SIDECAR"]
_orig = adapters._exec
_lock = threading.Lock()
_c = {"n": 0}

def _patched(cmd, timeout_sec, cwd, stdin=None, env=None):
    rc, out, err, wall, to = _orig(cmd, timeout_sec, cwd, stdin=stdin, env=env)
    try:
        if "gpt-5.3-codex-spark" in " ".join(str(x) for x in cmd):
            usage = None
            for line in (out or "").splitlines():
                if '"usage"' in line:
                    ev = benchlib._try_json(line.strip())
                    if isinstance(ev, dict) and isinstance(ev.get("usage"), dict):
                        usage = ev["usage"]
            with _lock:
                _c["n"] += 1
                with open(SIDECAR, "a") as f:
                    f.write(json.dumps({"usage": usage, "rc": rc, "ts": time.time(), "callIndex": _c["n"]}) + "\n")
    except Exception as e:
        with _lock:
            with open(SIDECAR, "a") as f:
                f.write(json.dumps({"captureError": str(e)}) + "\n")
    return rc, out, err, wall, to

adapters._exec = _patched
mod = sys.argv[1]
sys.argv = [mod] + sys.argv[2:]
runpy.run_module(mod, run_name="__main__")
