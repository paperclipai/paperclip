"""Ensure src/ is on sys.path before any impact_gate test module is imported."""

import sys
from pathlib import Path

_src = str(Path(__file__).resolve().parents[2] / "src")
_scripts = str(Path(__file__).resolve().parents[2] / "scripts")
sys.path.insert(0, _src)
sys.path.insert(0, _scripts)
