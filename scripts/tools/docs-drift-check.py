#!/usr/bin/env python3
"""Behavior-to-doc drift gate.

Reads docs/standards/doc-gate-map.json and ensures behavior-changing edits include doc updates.
Default mode checks staged files first, then unstaged.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Dict, List

DEFAULT_MAP = {
    "documentation_patterns": [
        "CLAUDE.md",
        "AGENTS.md",
        "docs/**/*.md",
        "doc/**/*.md",
    ],
    "groups": [],
}


def run_git(args: List[str], repo_root: Path) -> str:
    result = subprocess.run(["git", *args], cwd=repo_root, capture_output=True, text=True)
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def path_matches(path: str, patterns: List[str]) -> bool:
    p = PurePosixPath(path)
    for pattern in patterns:
        if "/" not in pattern and pattern not in {"*", "**"}:
            if path == pattern:
                return True
            continue
        if p.match(pattern):
            return True
    return False


def read_gate_map(repo_root: Path) -> Dict:
    gate_path = repo_root / "docs" / "standards" / "doc-gate-map.json"
    if not gate_path.exists():
        return DEFAULT_MAP
    try:
        return json.loads(gate_path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"ERROR: could not parse {gate_path}: {exc}", file=sys.stderr)
        return DEFAULT_MAP


def changed_files(repo_root: Path) -> List[str]:
    staged = run_git(["diff", "--name-only", "--cached"], repo_root)
    if staged:
        files = staged.splitlines()
    else:
        unstaged = run_git(["diff", "--name-only"], repo_root)
        files = unstaged.splitlines() if unstaged else []
    return sorted(set(f for f in files if f))


def main() -> int:
    parser = argparse.ArgumentParser(description="Check behavior/doc drift")
    parser.add_argument("--files", nargs="*", default=None, help="explicit changed files")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    gate_map = read_gate_map(repo_root)

    files = args.files if args.files else changed_files(repo_root)
    if not files:
        print("docs-drift-check: no changed files")
        return 0

    doc_patterns = gate_map.get("documentation_patterns", DEFAULT_MAP["documentation_patterns"])
    groups = gate_map.get("groups", [])

    changed_docs = [f for f in files if path_matches(f, doc_patterns)]
    failures: List[str] = []

    for group in groups:
        name = group.get("name", "unnamed-group")
        code_patterns = group.get("code_patterns", [])
        required_doc_patterns = group.get("required_doc_patterns", doc_patterns)

        touched_code = [f for f in files if path_matches(f, code_patterns)]
        if not touched_code:
            continue

        has_required_doc = any(path_matches(doc_file, required_doc_patterns) for doc_file in changed_docs)
        if not has_required_doc:
            failures.append(
                f"{name}: behavior files changed ({len(touched_code)}), but no matching docs updated"
            )

    if failures:
        print("docs-drift-check failed:")
        for item in failures:
            print(f"- {item}")
        print("Hint: update docs/specs, docs/api, or CLAUDE/AGENTS in the same branch.")
        return 1

    print(f"docs-drift-check passed ({len(files)} changed file(s), {len(changed_docs)} doc file(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
