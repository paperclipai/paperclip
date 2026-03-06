#!/usr/bin/env python3
"""Frontmatter lint for canonical markdown docs.

Default mode checks changed files (staged first, then unstaged). Use --all for full scan.
Policy file: docs/standards/frontmatter-policy.json
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Dict, List, Tuple

DEFAULT_POLICY = {
    "require_frontmatter_for": [
        "CLAUDE.md",
        "AGENTS.md",
        "docs/specs/**/*.md",
        "docs/specs/*.md",
        "docs/api/**/*.md",
        "docs/api/*.md",
        "docs/standards/**/*.md",
        "docs/standards/*.md",
        "docs/workflows/documentation-handbook-system.md",
    ],
    "required_fields": [
        "id",
        "title",
        "doc_type",
        "owner",
        "status",
        "version",
        "updated",
        "applies_to",
        "depends_on",
        "related_docs",
        "toc",
    ],
}

KEY_RE = re.compile(r"^([A-Za-z0-9_]+)\s*:\s*(.*)$")


def run_git(args: List[str], repo_root: Path) -> str:
    result = subprocess.run(["git", *args], cwd=repo_root, capture_output=True, text=True)
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def read_policy(repo_root: Path) -> Dict[str, List[str]]:
    policy_path = repo_root / "docs" / "standards" / "frontmatter-policy.json"
    if not policy_path.exists():
        return DEFAULT_POLICY
    try:
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
    except Exception as exc:  # pragma: no cover - defensive
        print(f"ERROR: could not parse {policy_path}: {exc}", file=sys.stderr)
        return DEFAULT_POLICY

    merged = dict(DEFAULT_POLICY)
    merged.update(policy)
    return merged


def path_matches(path: str, patterns: List[str]) -> bool:
    candidate = PurePosixPath(path)
    for pattern in patterns:
        if "/" not in pattern and pattern not in {"*", "**"}:
            if path == pattern:
                return True
            continue
        if candidate.match(pattern):
            return True
    return False


def changed_files(repo_root: Path) -> List[str]:
    staged = run_git(["diff", "--name-only", "--cached"], repo_root)
    if staged:
        files = staged.splitlines()
    else:
        unstaged = run_git(["diff", "--name-only"], repo_root)
        files = unstaged.splitlines() if unstaged else []
    return sorted(set(f for f in files if f.endswith(".md")))


def all_tracked_md(repo_root: Path) -> List[str]:
    out = run_git(["ls-files", "*.md"], repo_root)
    files = out.splitlines() if out else []
    return sorted(set(files))


def parse_frontmatter(text: str) -> Tuple[bool, Dict[str, str], str]:
    if not text.startswith("---\n") and not text.startswith("---\r\n"):
        return False, {}, "missing opening --- on first line"

    lines = text.splitlines()
    end_idx = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end_idx = i
            break

    if end_idx is None:
        return False, {}, "missing closing ---"

    data: Dict[str, str] = {}
    for raw in lines[1:end_idx]:
        m = KEY_RE.match(raw)
        if m:
            key, value = m.group(1), m.group(2).strip()
            data[key] = value

    return True, data, ""


def main() -> int:
    parser = argparse.ArgumentParser(description="Lint markdown frontmatter for canonical docs")
    parser.add_argument("--all", action="store_true", help="scan all tracked markdown files")
    parser.add_argument("--files", nargs="*", default=None, help="explicit file list to check")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    policy = read_policy(repo_root)
    patterns = policy.get("require_frontmatter_for", [])
    required_fields = policy.get("required_fields", [])

    if args.files:
        candidates = [f for f in args.files if f.endswith(".md")]
    elif args.all:
        candidates = all_tracked_md(repo_root)
    else:
        candidates = changed_files(repo_root)

    target_files = [f for f in candidates if path_matches(f, patterns)]

    if not target_files:
        print("docs-lint: no matching files to validate")
        return 0

    failures: List[str] = []
    for rel in target_files:
        path = repo_root / rel
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        ok, data, err = parse_frontmatter(text)
        if not ok:
            failures.append(f"{rel}: {err}")
            continue

        missing = [field for field in required_fields if field not in data]
        if missing:
            failures.append(f"{rel}: missing required fields: {', '.join(missing)}")

    if failures:
        print("docs-lint failed:")
        for item in failures:
            print(f"- {item}")
        return 1

    print(f"docs-lint passed ({len(target_files)} file(s) checked)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
