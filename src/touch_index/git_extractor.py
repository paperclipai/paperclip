"""Extract touched files from git history for a given Paperclip issue identifier.

Strategy: find all commits whose message references the issue identifier
(e.g. 'BTCAAAAA-1085'), then collect the file paths changed in those commits.
This gives reliable coverage because the project enforces conventional commits
with issue IDs in the scope token.
"""

from __future__ import annotations

import logging
import re
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).parents[2]  # BTC-Trade-Engine-PaperClip/

# Broad pattern to find any BTCAAAAA-NNN reference in commit messages.
_RE_ISSUE_ID = re.compile(r"BTCAAAAA-\d+")


def _run(args: list[str], cwd: Path) -> str:
    try:
        result = subprocess.run(
            args,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if result.returncode != 0:
            logger.warning(
                "git command failed (exit %d): %s | stderr: %s",
                result.returncode,
                " ".join(args),
                result.stderr.strip()[:500],
            )
        return result.stdout.strip()
    except FileNotFoundError:
        logger.error("git executable not found — cannot extract commit files")
        return ""
    except subprocess.TimeoutExpired:
        logger.error("git command timed out after 30s: %s", " ".join(args))
        return ""
    except OSError as exc:
        logger.error("git subprocess error: %s", exc)
        return ""


def get_commit_hashes(issue_identifier: str, repo: Path = _REPO_ROOT) -> list[str]:
    """Return all commit SHAs whose message contains the issue identifier."""
    out = _run(
        ["git", "log", "--all", "--format=%H", f"--grep={issue_identifier}"],
        repo,
    )
    return [line.strip() for line in out.splitlines() if line.strip()]


def get_all_referenced_issue_ids(repo: Path = _REPO_ROOT) -> set[str]:
    """Return all BTCAAAAA-NNN issue identifiers referenced in commit messages.

    Used by ``quality.compute_bug_coverage`` to determine which done issues
    are *eligible* for bug-file indexing (i.e. have at least one fix commit
    referencing the issue identifier).  Issues without any git reference
    cannot be indexed by the bug worker and should be excluded from the
    coverage denominator.
    """
    out = _run(["git", "log", "--all", "--format=%B"], repo)
    ids: set[str] = set()
    for line in out.splitlines():
        for match in _RE_ISSUE_ID.finditer(line):
            ids.add(match.group(0))
    return ids


def get_files_for_commit(sha: str, repo: Path = _REPO_ROOT) -> list[str]:
    """Return files changed in a single commit (relative paths, ACMRT only)."""
    out = _run(
        [
            "git",
            "show",
            "--name-only",
            "--format=",  # suppress commit header
            "--diff-filter=ACMRT",
            sha,
        ],
        repo,
    )
    # --name-only with --format= produces one file per line, blank lines possible
    files = [
        line.strip()
        for line in out.splitlines()
        if line.strip() and not line.strip().startswith("=>")
    ]
    # Filter to real source files (skip generated, migrations, etc.)
    return [f for f in files if _is_source_file(f)]


def get_files_for_issue(
    issue_identifier: str,
    repo: Path = _REPO_ROOT,
    *,
    max_commits: int = 50,
) -> list[str]:
    """Return deduplicated list of source files touched by all commits for an issue."""
    hashes = get_commit_hashes(issue_identifier, repo)[:max_commits]
    seen: set[str] = set()
    result: list[str] = []
    for sha in hashes:
        for f in get_files_for_commit(sha, repo):
            if f not in seen:
                seen.add(f)
                result.append(f)
    return result


def _is_source_file(path: str) -> bool:
    skip_prefixes = (
        "alembic/",
        "scripts/LakeAPI/",
        "scripts/archived/",
        "archived/",
        ".github/",
        "docs/",
    )
    skip_suffixes = (
        ".sql",
        ".json",
        ".lock",
        ".txt",
        ".md",
        ".ini",
        ".cfg",
        ".toml",
        ".yml",
        ".yaml",
        ".sh",
        ".csv",
        ".rst",
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".svg",
        ".ico",
        ".pdf",
        ".pyc",
        ".so",
        ".o",
        ".parquet",
        ".pkl",
    )
    if path.startswith("."):
        return False
    if any(path.startswith(p) for p in skip_prefixes):
        return False
    if any(path.endswith(s) for s in skip_suffixes):
        return False
    return True
