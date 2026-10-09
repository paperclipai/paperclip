"""Entrypoint for the closed, relocatable Python distribution (python -I -B)."""
import os
import sys
from pathlib import Path

root = Path(__file__).resolve().parent
sys.path.insert(0, str(root / "app"))
sys.path.insert(0, str(root))
# A managed profile never consults another Hermes installation or installs tools.
os.environ["HERMES_ACP_SKIP_CONFIGURED_MCP"] = "1"
os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
os.environ["HERMES_SAFE_MODE"] = "1"
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
os.environ.pop("HERMES_LAZY_INSTALL_TARGET", None)
from bridge import main
main()
