"""Config sanity checks for federation command defaults."""
from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ["ENVIRONMENT"] = "development"
os.environ["JARVIS_API_KEY"] = "dev-change-me"

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.config import get_settings


def main() -> None:
    settings = get_settings()
    assert settings.hermes_command == "hermes -z"
    assert settings.pi_command == "pi -p --mode json --tools read,bash,edit,write,grep,find,ls"
    assert settings.opencode_command == "opencode run --format json"
    print("JARVIS federation config test passed.")


if __name__ == "__main__":
    main()
