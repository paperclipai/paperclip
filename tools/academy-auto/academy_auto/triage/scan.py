from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

GITHUB_REPO = "whitestagai/ki-kompass"

_EXCLUDE_PARTS = ("node_modules", ".git", "ios/Pods", "android/build", "dist", ".expo")
_SOURCE_EXTS = (".ts", ".tsx", ".js", ".jsx")

_TODO_RE = re.compile(r"\b(?:TODO|FIXME)\b|@todo")
_SKIP_RE = re.compile(r"\b(?:test|it|describe)\.skip\b|\bxit\s*\(|\bit\.todo\b")


@dataclass(frozen=True)
class Candidate:
    source: str
    key: str
    file: str
    line: int
    text: str
    raw_priority: int


def iter_source_files(root: Path) -> list[str]:
    """Repo-relative Pfade aller Quelldateien, Vendor-/Build-Verzeichnisse ausgeschlossen."""
    out: list[str] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix not in _SOURCE_EXTS:
            continue
        rel = path.relative_to(root).as_posix()
        if any(part in rel for part in _EXCLUDE_PARTS):
            continue
        out.append(rel)
    return out


def _scan_lines(root: Path, pattern: re.Pattern, source: str, priority: int) -> list[Candidate]:
    cands: list[Candidate] = []
    for rel in iter_source_files(root):
        try:
            lines = (root / rel).read_text(errors="ignore").splitlines()
        except OSError:
            continue
        for i, line in enumerate(lines, start=1):
            if pattern.search(line):
                cands.append(Candidate(
                    source=source,
                    key=f"{source}:{rel}:{i}",
                    file=rel,
                    line=i,
                    text=line.strip(),
                    raw_priority=priority,
                ))
    return cands


def scan_todos(root: Path) -> list[Candidate]:
    return _scan_lines(root, _TODO_RE, "todo", 10)


def scan_skipped_tests(root: Path) -> list[Candidate]:
    cands = _scan_lines(root, _SKIP_RE, "skip", 30)
    return [c for c in cands if _is_test_file(c.file)]


def _is_test_file(rel: str) -> bool:
    return ".test." in rel or ".spec." in rel or "__tests__/" in rel
