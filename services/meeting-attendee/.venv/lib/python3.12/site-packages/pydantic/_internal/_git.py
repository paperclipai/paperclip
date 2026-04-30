"""Git utilities, adopted from mypy's git utilities (https://github.com/python/mypy/blob/master/mypy/git.py)."""

from __future__ import annotations

import subprocess
from pathlib import Path


def is_git_repo(dir: Path) -> bool:
    """Is the given directory version-controlled with git?"""
    return dir.joinpath('.git').exists()


def have_git() -> bool:  # pragma: no cover
    """Can we run the git executable?"""
    try:
        subprocess.check_output(['git', '--help'])
        return True
    except subprocess.CalledProcessError:
        return False
    except OSError:
        return False


def git_revision(dir: Path) -> str:
    """Get the SHA-1 of the HEAD of a git repository."""
    return subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD'], cwd=dir).decode('utf-8').strip()
