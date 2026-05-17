"""Impact Gate — quality gate for done fix/bug issues.

Scans recently done fix and bug issues, verifies they have proper fix
commits touching source files, and reports pass/fail results.  Designed
to run as a GitHub Actions scheduled workflow (every 5 minutes).
"""

from __future__ import annotations
