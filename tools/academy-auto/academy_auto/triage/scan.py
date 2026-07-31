from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

GITHUB_REPO = "whitestagai/ki-kompass"
SCAN_TIMEOUT = 180

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
            capture_output=True, text=True, check=False, timeout=SCAN_TIMEOUT,
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


# Der Scanner MUSS denselben Ausschnitt sehen wie das Gate, sonst bietet er
# Arbeit an, die das Gate gar nicht messen kann.
#
# `npm run lint` (= `expo lint`, der Gate-Schritt) ruft eslint mit genau einem
# Pfad auf: <root>/src — per EXPO_DEBUG verifiziert. Der Scanner lief dagegen
# auf "." und fand zusaetzlich tests/ und supabase/ (25 statt 6 Dateien).
# Folge am 31.07.: der Ranker waehlte import/first-Verstoesse in vier
# tests/-Dateien, das Gate lintet tests/ ueberhaupt nicht, Ergebnis 13->13.
LINT_SCAN_PATHS = ("src",)

# Nur ESLint-FEHLER (severity 2). `measure_gate` zaehlt ausschliesslich Fehler;
# eine behobene Warnung laesst die Gate-Zahl unveraendert, das Delta bleibt 0
# und der Lauf wird verworfen. 97 der 103 Kandidaten waren solche Warnungen.
LINT_ERROR_SEVERITY = 2


def scan_lint(root, runner=subprocess.run, repo_root=None) -> list[Candidate]:
    base = repo_root if repo_root is not None else (str(root) if root is not None else "")
    try:
        proc = runner(
            ["npx", "eslint", *LINT_SCAN_PATHS, "--format", "json"],
            cwd=str(root) if root is not None else None,
            capture_output=True, text=True, check=False, timeout=SCAN_TIMEOUT,
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
            if m.get("severity", 0) < LINT_ERROR_SEVERITY:
                continue  # Warnung: fuer das Gate unsichtbar, nicht anbieten
            ln = m.get("line", 0)
            rule = m.get("ruleId") or "unknown"
            cands.append(Candidate(
                source="lint", key=f"lint:{rel}:{ln}:{rule}", file=rel, line=ln,
                text=(m.get("message") or "").strip(), raw_priority=45,
            ))
    return cands


ISSUE_BODY_CHARS = 400


def _issue_text(issue) -> str:
    """Titel + Kurzfassung des Bodys.

    Der Body traegt die eigentliche Anweisung — nur der Titel waere zu duenn,
    damit der Ranker den Auftrag versteht.
    """
    title = (issue.get("title") or "").strip()
    body = " ".join((issue.get("body") or "").split())[:ISSUE_BODY_CHARS]
    return f"{title} — {body}" if body else title


def scan_issues(runner=subprocess.run, repo=None) -> list[Candidate]:
    try:
        proc = runner(
            ["gh", "issue", "list", "--repo", repo or GITHUB_REPO, "--state", "open",
             "--json", "number,title,labels,body"],
            capture_output=True, text=True, check=False, timeout=SCAN_TIMEOUT,
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
            text=_issue_text(issue), raw_priority=20,
        ))
    return cands


ALL_SOURCES = ("todo", "skip", "tsc", "lint", "issue")


def scan_all(root, runner=subprocess.run, sources=None, github_repo=None) -> list[Candidate]:
    """Kandidaten sammeln — nur aus den freigegebenen Quellen.

    `sources` MUSS zum Gate des jeweiligen Laufs passen. Ein Kandidat, den das
    Gate nicht messen kann, ist unerledigbar: der Lauf setzt ihn um, das Gate
    sieht keinen Fortschritt und verwirft ihn — jede Nacht aufs Neue. Genau das
    passierte am 31.07. mit lint-Verstoessen aus tests/, die `expo lint src`
    nie gesehen hat.
    """
    allowed = tuple(sources) if sources is not None else ALL_SOURCES
    by_source = {
        "todo": lambda: scan_todos(root),
        "skip": lambda: scan_skipped_tests(root),
        "tsc": lambda: scan_tsc(root, runner=runner),
        "lint": lambda: scan_lint(root, runner=runner),
        "issue": lambda: scan_issues(runner=runner, repo=github_repo),
    }
    collected: list[Candidate] = []
    for name in allowed:
        fn = by_source.get(name)
        if fn is None:
            continue
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
