from __future__ import annotations

from dataclasses import dataclass, field
from fnmatch import fnmatch

from .config import Config


@dataclass
class ScopeResult:
    ok: bool
    violations: list[str] = field(default_factory=list)


def check_scope(cfg: Config, changed_files: list[str]) -> ScopeResult:
    """Verwirft Läufe, die verbotene Dateien anfassen (Secrets, Signing, Migrationen)."""
    violations: list[str] = []
    for path in changed_files:
        base = path.rsplit("/", 1)[-1]
        for pattern in cfg.denied_globs:
            if fnmatch(path.lower(), pattern.lower()) or fnmatch(base.lower(), pattern.lower()):
                violations.append(path)
                break
    return ScopeResult(ok=(not violations), violations=violations)
