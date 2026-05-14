"""Extract file paths from Paperclip issue comments and descriptions.

Used primarily for FDR issues where the implementing agent posts a done-comment
that mentions the files they changed (e.g. ``src/optimizer_v3/database/...``).

Extraction priority:
  1. Backtick-wrapped paths: `src/foo/bar.py`
  2. Bare path strings starting with src/, tests/, or scripts/
  3. Paths following "Fix applied to ..." or "Commit ... touches ..." patterns

Normalisation: strip leading `BTC_Engine_v3/` or `projects/*/` repo prefixes
so all paths are repo-relative (e.g. `src/foo/bar.py`).
"""

from __future__ import annotations

import re
from typing import Sequence

_CODE_EXTS = r"(?:py|js|ts)"

# Backtick-wrapped paths (optional :line or :line-end suffix, e.g. file.py:229-332)
_RE_BACKTICK = re.compile(
    r"`([a-zA-Z0-9_/\-\.]+\.(?:" + _CODE_EXTS + r"))(?::\d+(?:-\d+)?)?`"
)

# Bare paths starting with a known root
_RE_PATH = re.compile(
    r"(?:^|[\s(\[])(?:BTC_Engine_v3/|BTC-Trade-Engine-PaperClip/|projects/[^/]+/)?"
    r"((?:src|tests|scripts|alembic)/[a-zA-Z0-9_/\-\.]+\.(?:" + _CODE_EXTS + r"))"
)

_STRIP_PREFIXES = (
    "BTC_Engine_v3/",
    "BTC-Trade-Engine-PaperClip/",
    "projects/",
)

# Comment/description extracted paths must start with a known source root
# to reject bare filenames like `backtest_config_panel.py` from agent comments.
# Git-extracted paths are NOT filtered by this (they come from actual commits).
_ALLOW_PREFIXES = (
    "src/",
    "tests/",
    "scripts/",
)


def _has_allowed_prefix(path: str) -> bool:
    return any(path.startswith(p) for p in _ALLOW_PREFIXES)


def _normalise(path: str) -> str:
    for prefix in _STRIP_PREFIXES:
        if path.startswith(prefix):
            rest = path[len(prefix) :]
            # "projects/X/..." — also strip the project directory
            if prefix == "projects/":
                parts = rest.split("/", 1)
                return parts[1] if len(parts) > 1 else parts[0]
            return rest
    return path


def extract_files_from_text(text: str) -> list[str]:
    """Return deduplicated, normalised source file paths found in `text`.

    Applies the same source-file filter as ``git_extractor._is_source_file``
    so extraction is consistent regardless of whether files come from
    comments, description text, or git history.
    """
    from .git_extractor import _is_source_file

    found: set[str] = set()

    for m in _RE_BACKTICK.finditer(text):
        path = _normalise(m.group(1))
        if _is_source_file(path) and _has_allowed_prefix(path):
            found.add(path)

    for m in _RE_PATH.finditer(text):
        path = _normalise(m.group(1))
        if _is_source_file(path) and _has_allowed_prefix(path):
            found.add(path)

    return sorted(found)


def extract_files_from_comments(comments: Sequence[dict]) -> list[str]:
    """Aggregate file paths across all comment bodies."""
    found: set[str] = set()
    for comment in comments:
        body = comment.get("body", "")
        found.update(extract_files_from_text(body))
    return sorted(found)


def fetch_and_extract(issue_id: str) -> list[str]:
    """Fetch comments for an issue via Paperclip API and extract file paths."""
    from .paperclip_client import fetch_issue_comments

    return extract_files_from_comments(fetch_issue_comments(issue_id))
