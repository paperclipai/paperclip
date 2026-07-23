"""SKILL.md metadata helpers — single source of truth for parsing skill frontmatter.

Centralizes the version regex that previously lived in render.py and was
duplicated in tests/test_plugin_contract.py and tests/test_version_consistency.py.
"""

import re
from pathlib import Path

# Matches `version: "x.y.z"`, `version: 'x.y.z'`, or `version: x.y.z` in YAML
# frontmatter. Multiline so the pattern can be applied to a full SKILL.md text.
# Three alternation groups — exactly one captures per successful match.
_VERSION_RE = re.compile(
    r'''^version:\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s*$''',
    re.MULTILINE,
)


def read_skill_version(skill_md_path: Path) -> str | None:
    """Return the version string from a SKILL.md's frontmatter, or None.

    Returns None if the file can't be read (missing, permission, decode error)
    or if no `version:` line is found. Accepts double-quoted, single-quoted,
    or unquoted YAML version scalars.
    """
    try:
        text = skill_md_path.read_text()
    except (OSError, UnicodeDecodeError):
        return None
    match = _VERSION_RE.search(text)
    if not match:
        return None
    return match.group(1) or match.group(2) or match.group(3)
