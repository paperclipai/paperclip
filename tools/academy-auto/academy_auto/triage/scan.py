from __future__ import annotations

import json
import re
import subprocess
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


def _is_excluded(rel: str) -> bool:
    segs = rel.split("/")
    for part in _EXCLUDE_PARTS:
        pseg = part.split("/")
        for i in range(len(segs) - len(pseg) + 1):
            if segs[i:i + len(pseg)] == pseg:
                return True
    return False


def iter_source_files(root: Path) -> list[str]:
    """Repo-relative Pfade aller Quelldateien, Vendor-/Build-Verzeichnisse ausgeschlossen."""
    out: list[str] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix not in _SOURCE_EXTS:
            continue
        rel = path.relative_to(root).as_posix()
        if _is_excluded(rel):
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


_TSC_RE = re.compile(r"^(.+?)\((\d+),\d+\):\s+error\s+(TS\d+):\s+(.+)$")


def scan_tsc(root, runner=subprocess.run) -> list[Candidate]:
    try:
        proc = runner(
            ["npx", "tsc", "--noEmit"],
            cwd=str(root) if root is not None else None,
            capture_output=True, text=True, check=False,
        )
    except Exception:
        return []
    out = (getattr(proc, "stdout", "") or "") + (getattr(proc, "stderr", "") or "")
    cands: list[Candidate] = []
    for line in out.splitlines():
        m = _TSC_RE.match(line.strip())
        if not m:
            continue
        file, ln, code, msg = m.group(1), int(m.group(2)), m.group(3), m.group(4)
        cands.append(Candidate(
            source="tsc", key=f"tsc:{file}:{ln}:{code}", file=file, line=ln,
            text=msg.strip(), raw_priority=50,
        ))
    return cands


def scan_lint(root, runner=subprocess.run, repo_root=None) -> list[Candidate]:
    base = repo_root if repo_root is not None else (str(root) if root is not None else "")
    try:
        proc = runner(
            ["npx", "eslint", ".", "--format", "json"],
            cwd=str(root) if root is not None else None,
            capture_output=True, text=True, check=False,
        )
    except Exception:
        return []
    try:
        data = json.loads(getattr(proc, "stdout", "") or "")
    except (ValueError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    cands: list[Candidate] = []
    for entry in data:
        abs_path = entry.get("filePath", "")
        rel = abs_path[len(base):].lstrip("/") if base and abs_path.startswith(base) else abs_path
        for m in entry.get("messages", []):
            ln = m.get("line", 0)
            rule = m.get("ruleId") or "unknown"
            cands.append(Candidate(
                source="lint", key=f"lint:{rel}:{ln}:{rule}", file=rel, line=ln,
                text=(m.get("message") or "").strip(), raw_priority=45,
            ))
    return cands


def scan_issues(runner=subprocess.run) -> list[Candidate]:
    try:
        proc = runner(
            ["gh", "issue", "list", "--repo", GITHUB_REPO, "--state", "open",
             "--json", "number,title,labels,body"],
            capture_output=True, text=True, check=False,
        )
    except Exception:
        return []
    try:
        data = json.loads(getattr(proc, "stdout", "") or "")
    except (ValueError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    cands: list[Candidate] = []
    for issue in data:
        number = issue.get("number")
        if number is None:
            continue
        cands.append(Candidate(
            source="issue", key=f"issue:{number}", file="", line=0,
            text=(issue.get("title") or "").strip(), raw_priority=20,
        ))
    return cands


def scan_all(root, runner=subprocess.run) -> list[Candidate]:
    collected: list[Candidate] = []
    for fn in (
        lambda: scan_todos(root),
        lambda: scan_skipped_tests(root),
        lambda: scan_tsc(root, runner=runner),
        lambda: scan_lint(root, runner=runner),
        lambda: scan_issues(runner=runner),
    ):
        try:
            collected += fn()
        except Exception:
            continue
    seen: set[str] = set()
    unique: list[Candidate] = []
    for c in collected:
        if c.key in seen:
            continue
        seen.add(c.key)
        unique.append(c)
    unique.sort(key=lambda c: (-c.raw_priority, c.key))
    return unique
