"""Common preflight and repair-issue support for served OpCo runtime scripts."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


RUNTIME_DIR = Path(__file__).resolve().parent
REQUIRED_ARTIFACTS = (
    "dispatch.py",
    "swap_back.py",
    "mc_inbound.py",
    "projection.py",
)
REPAIR_TITLE = "Repair shared OpCo runtime artifact projection"


def missing_artifacts(runtime_dir: Path = RUNTIME_DIR) -> list[str]:
    """Return the canonical artifact names absent from the served runtime."""
    return [name for name in REQUIRED_ARTIFACTS if not (runtime_dir / name).is_file()]


def create_repair_issue(missing: list[str]) -> None:
    """Create an idempotent platform repair issue without reading secret values."""
    api_url = os.environ.get("PAPERCLIP_API_URL", "").rstrip("/")
    api_key = os.environ.get("PAPERCLIP_API_KEY")
    company_id = os.environ.get("PAPERCLIP_COMPANY_ID")
    run_id = os.environ.get("PAPERCLIP_RUN_ID")
    if not all((api_url, api_key, company_id, run_id)):
        print("repair issue not created: Paperclip runtime metadata unavailable", file=sys.stderr)
        return

    body = {
        "title": REPAIR_TITLE,
        "description": (
            "The served shared OpCo runtime projection preflight failed before "
            "routine assignment. Missing canonical artifacts: " + ", ".join(missing)
        ),
        "priority": "high",
        "status": "todo",
        "idempotencyKey": "platform:opco-runtime-projection:repair:v1",
    }
    request = urllib.request.Request(
        f"{api_url}/api/companies/{company_id}/issues",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "X-Paperclip-Run-Id": run_id,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            result = json.load(response)
        print(f"repair issue recorded: {result.get('identifier', result.get('id', 'unknown'))}")
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError) as error:
        print(f"repair issue creation failed: {error}", file=sys.stderr)


def require_projection(*, create_issue: bool = True, runtime_dir: Path = RUNTIME_DIR) -> bool:
    """Fail before assignment when the served projection is incomplete."""
    missing = missing_artifacts(runtime_dir)
    if not missing:
        print(f"served OpCo runtime projection ready: {runtime_dir}")
        return True
    print("served OpCo runtime projection incomplete: " + ", ".join(missing), file=sys.stderr)
    if create_issue:
        create_repair_issue(missing)
    return False
