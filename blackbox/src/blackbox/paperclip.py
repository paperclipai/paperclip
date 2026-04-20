"""Paperclip integration — reads tasks, runs research, reports results."""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

import httpx
import yaml

logger = logging.getLogger(__name__)

# Default location for RFP intake folders
RFPS_DIR = Path(__file__).resolve().parents[2] / "rfps"


class PaperclipClient:
    """Minimal client for Paperclip control plane API."""

    def __init__(
        self,
        base_url: str = "http://localhost:3100",
        api_key: str | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        self._client = httpx.Client(base_url=self.base_url, headers=headers, timeout=30)

    def get_assigned_tasks(self, agent_id: str, company_id: str) -> list[dict]:
        """Get tasks assigned to this agent with status=todo."""
        resp = self._client.get(
            f"/api/companies/{company_id}/issues",
            params={"assigneeAgentId": agent_id, "status": "todo"},
        )
        resp.raise_for_status()
        data = resp.json()
        # API may return list directly or nested under 'issues'
        if isinstance(data, list):
            return data
        return data.get("issues", data.get("data", []))

    def checkout_task(self, issue_id: str, agent_id: str) -> dict | None:
        """Atomically claim a task. Returns issue on success, None on conflict."""
        try:
            resp = self._client.post(
                f"/api/issues/{issue_id}/checkout",
                json={"agentId": agent_id, "expectedStatuses": ["todo", "backlog"]},
            )
            if resp.status_code == 409:
                logger.info("Task %s already claimed", issue_id)
                return None
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as exc:
            logger.warning("Checkout failed for %s: %s", issue_id, exc)
            return None

    def complete_task(self, issue_id: str, comment: str | None = None) -> None:
        """Mark a task as done and optionally post a comment."""
        if comment:
            self._client.post(
                f"/api/issues/{issue_id}/comments",
                json={"body": comment},
            )
        self._client.patch(
            f"/api/issues/{issue_id}",
            json={"status": "done"},
        )

    def fail_task(self, issue_id: str, error: str) -> None:
        """Mark a task as blocked with an error comment."""
        self._client.post(
            f"/api/issues/{issue_id}/comments",
            json={"body": f"**Error:** {error}"},
        )
        self._client.patch(
            f"/api/issues/{issue_id}",
            json={"status": "blocked"},
        )

    def close(self) -> None:
        self._client.close()


def parse_task_for_research(task: dict) -> dict:
    """Extract agency name and scope from a Paperclip task.

    Supports these formats in title or description:
      - "Research {agency}" or "Research {agency}: {scope}"
      - "agency: {name}" in description
      - "scope: {text}" in description
    """
    title = task.get("title", "")
    description = task.get("description", "")
    combined = f"{title}\n{description}"

    agency = ""
    scope = ""
    rfp_path = None

    # Try title patterns
    m = re.match(r"(?:Research|Analyze|Score)\s+(.+?)(?:\s*[-:]\s*(.+))?$", title, re.IGNORECASE)
    if m:
        agency = m.group(1).strip()
        if m.group(2):
            scope = m.group(2).strip()

    # Try description field patterns
    for line in combined.splitlines():
        line = line.strip()
        if not agency:
            m = re.match(r"(?:agency|organisation|organization)\s*[:=]\s*(.+)", line, re.IGNORECASE)
            if m:
                agency = m.group(1).strip()
        if not scope:
            m = re.match(r"scope\s*[:=]\s*(.+)", line, re.IGNORECASE)
            if m:
                scope = m.group(1).strip()
        if not rfp_path:
            m = re.match(r"(?:rfp|file|path)\s*[:=]\s*(.+)", line, re.IGNORECASE)
            if m:
                rfp_path = m.group(1).strip()

    return {"agency": agency, "scope": scope, "rfp_path": rfp_path}


def find_rfp_folder(agency: str, scope: str, rfps_dir: Path | None = None) -> dict:
    """Find the matching rfps/ subfolder for an agency+scope.

    Returns dict with keys: rfp_path (Path|None), meta (dict), notes (str).
    Matches by scanning meta.yaml files for agency name overlap.
    """
    base = rfps_dir or RFPS_DIR
    if not base.is_dir():
        return {"rfp_path": None, "meta": {}, "notes": ""}

    agency_lower = agency.lower().strip()
    # Strip bracketed state codes like "[DC]" for matching
    agency_clean = re.sub(r"\s*\[.*?\]\s*", " ", agency_lower).strip()
    agency_words = set(agency_clean.split())

    best_match = None
    best_score = 0

    for folder in sorted(base.iterdir()):
        if not folder.is_dir() or folder.name.startswith("_"):
            continue
        meta_path = folder / "meta.yaml"
        if not meta_path.exists():
            continue

        try:
            with open(meta_path) as f:
                meta = yaml.safe_load(f) or {}
        except Exception:
            continue

        meta_agency = (meta.get("agency", "") or "").lower().strip()
        meta_agency_clean = re.sub(r"\s*\[.*?\]\s*", " ", meta_agency).strip()
        meta_words = set(meta_agency_clean.split())

        # Score by word overlap
        overlap = len(agency_words & meta_words)
        if overlap > best_score:
            best_score = overlap
            best_match = (folder, meta)

    if not best_match or best_score < 2:
        return {"rfp_path": None, "meta": {}, "notes": ""}

    folder, meta = best_match

    # Find PDF/DOCX in folder
    rfp_path = None
    for pattern in ["*.pdf", "*.docx", "*.doc"]:
        files = list(folder.glob(pattern))
        if files:
            rfp_path = files[0]
            break

    notes = meta.get("notes", "") or ""
    fit = meta.get("fit", "") or ""
    source = meta.get("source", "") or ""
    public_source = meta.get("public_source", "") or ""
    highergov_opp_key = meta.get("highergov_opp_key", "") or ""
    if fit:
        notes = f"{notes}\nFit areas: {fit}".strip()
    if source:
        notes = f"{notes}\nSource: {source}".strip()
    if public_source:
        notes = f"{notes}\nPublic portal: {public_source}".strip()

    return {
        "rfp_path": rfp_path,
        "meta": meta,
        "notes": notes,
        "highergov_opp_key": highergov_opp_key,
        "rfp_dir": folder,
    }


def get_paperclip_env() -> dict:
    """Read Paperclip context from environment variables."""
    return {
        "agent_id": os.environ.get("PAPERCLIP_AGENT_ID", ""),
        "company_id": os.environ.get("PAPERCLIP_COMPANY_ID", ""),
        "run_id": os.environ.get("PAPERCLIP_RUN_ID", ""),
        "issue_id": os.environ.get("PAPERCLIP_ISSUE_ID", ""),
        "api_url": os.environ.get("PAPERCLIP_API_URL", "http://localhost:3100"),
        "api_key": os.environ.get("PAPERCLIP_AGENT_API_KEY", ""),
    }
