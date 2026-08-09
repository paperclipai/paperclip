#!/usr/bin/env python3
"""Execute the THIA-900 detector and leave a terminal Paperclip disposition.

The detector itself is intentionally independent of Paperclip's issue
lifecycle: it evaluates routine health and delivers a portfolio alert.  A
shell-adapter run also needs a concrete issue update, otherwise the liveness
watchdog interprets the useful stdout as unfinished work and wakes it again.
This small wrapper supplies that lifecycle boundary without involving an LLM.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path


DEFAULT_DETECTOR = Path(
    "/Users/glad0s/Claude/Project_Rocky_Dev_Shared/scripts/halt_trigger_detector.py"
)
MAX_OUTPUT_CHARS = 3_500


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def compact_output(stdout: str, stderr: str) -> str:
    text = "\n".join(part.strip() for part in (stdout, stderr) if part.strip())
    if len(text) <= MAX_OUTPUT_CHARS:
        return text or "(detector produced no output)"
    return f"{text[:MAX_OUTPUT_CHARS]}\n… output truncated"


def patch_issue(*, status: str, comment: str) -> None:
    api_url = required_env("PAPERCLIP_API_URL").rstrip("/")
    api_key = required_env("PAPERCLIP_API_KEY")
    run_id = required_env("PAPERCLIP_RUN_ID")
    issue_id = required_env("PAPERCLIP_TASK_ID")
    body = json.dumps({"status": status, "comment": comment}).encode("utf-8")
    request = urllib.request.Request(
        f"{api_url}/api/issues/{issue_id}",
        data=body,
        method="PATCH",
        headers={
            "Authorization": f"Bearer {api_key}",
            "X-Paperclip-Run-Id": run_id,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        if response.status not in (200, 201):
            raise RuntimeError(f"Unexpected issue-update status {response.status}")


def main() -> int:
    detector = Path(os.environ.get("HALT_DETECTOR_SCRIPT", str(DEFAULT_DETECTOR)))
    if not detector.is_file():
        print(f"[halt-detector-wrapper] missing detector: {detector}", file=sys.stderr)
        return 2

    try:
        result = subprocess.run(
            [sys.executable, str(detector)],
            cwd=str(detector.parent.parent),
            capture_output=True,
            text=True,
            timeout=70,
            check=False,
        )
    except subprocess.TimeoutExpired:
        print("[halt-detector-wrapper] detector exceeded 70 seconds", file=sys.stderr)
        return 124

    output = compact_output(result.stdout, result.stderr)
    if result.returncode == 0:
        status = "done"
        summary = "Deterministic THIA-900 halt check completed; no LLM was used."
    else:
        # Deliberately leave failures non-terminal for Paperclip's bounded
        # recovery policy, but make the failed shell execution visible first.
        status = "in_progress"
        summary = f"Deterministic THIA-900 halt check failed (exit {result.returncode})."

    comment = f"{summary}\n\nDetector output:\n\n    {output.replace(chr(10), chr(10) + '    ')}"
    try:
        patch_issue(status=status, comment=comment)
    except (RuntimeError, urllib.error.URLError, urllib.error.HTTPError) as exc:
        print(f"[halt-detector-wrapper] could not record issue result: {exc}", file=sys.stderr)
        return 3

    print(output)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
